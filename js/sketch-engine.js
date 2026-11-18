/* SketchEngine: redraws a picture the way an artist would.
   1. a light graphite lay-in   (data.sketch)
   2. ink contours, then detail  (data.strokes, split at data.firstPass)
   3. the real tones washed in through a soft brush-shaped mask
   4. the ink settles back so the finished artwork shows through
   Stroke data comes from tools/build_assets.py. */
(function () {
  'use strict';

  var dataCache = {};
  var imgCache = {};

  /* Stroke files are plain <script>s so the site also works from file:// */
  function loadData(id) {
    if (dataCache[id]) return dataCache[id];
    dataCache[id] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'assets/strokes/' + id + '.js';
      s.async = true;
      s.onload = function () {
        var raw = window.SKETCH_DATA && window.SKETCH_DATA[id];
        if (!raw) return reject(new Error('No stroke data for ' + id));
        resolve(decode(raw));
      };
      s.onerror = function () { reject(new Error('Could not load strokes for ' + id)); };
      document.head.appendChild(s);
    });
    return dataCache[id];
  }

  function loadImage(id) {
    if (imgCache[id]) return imgCache[id];
    imgCache[id] = new Promise(function (resolve, reject) {
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Could not load image for ' + id)); };
      img.src = 'assets/art/' + id + '.jpg';
    });
    return imgCache[id];
  }

  /* [x0,y0,dx,dy,...] delta lists -> absolute Float32Arrays + lengths */
  function decodeList(list) {
    var out = [], total = 0;
    for (var i = 0; i < list.length; i++) {
      var d = list[i], n = d.length, a = new Float32Array(n);
      var x = d[0], y = d[1], len = 0;
      a[0] = x; a[1] = y;
      for (var k = 2; k < n; k += 2) {
        var nx = x + d[k], ny = y + d[k + 1];
        len += Math.hypot(nx - x, ny - y);
        a[k] = nx; a[k + 1] = ny; x = nx; y = ny;
      }
      out.push(a); total += len;
    }
    return { paths: out, length: total };
  }

  function decode(raw) {
    var first = decodeList(raw.strokes.slice(0, raw.firstPass));
    var detail = decodeList(raw.strokes.slice(raw.firstPass));
    return { w: raw.w, h: raw.h, sketch: decodeList(raw.sketch), contour: first, detail: detail };
  }

  /* Walks along a list of paths, drawing exactly `budget` units of line. */
  function PathRunner(set) {
    this.paths = set.paths; this.total = set.length;
    this.si = 0; this.pi = 0; this.t = 0; this.x = 0; this.y = 0;
  }
  PathRunner.prototype.done = function () { return this.si >= this.paths.length; };
  PathRunner.prototype.advance = function (ctx, budget) {
    if (this.done()) return;
    ctx.beginPath();
    while (budget > 0 && this.si < this.paths.length) {
      var p = this.paths[this.si], n = p.length >> 1;
      if (n < 2 || this.pi >= n - 1) { this.si++; this.pi = 0; this.t = 0; continue; }
      var i = this.pi * 2;
      var x0 = p[i], y0 = p[i + 1], x1 = p[i + 2], y1 = p[i + 3];
      var seg = Math.hypot(x1 - x0, y1 - y0);
      var sx = x0 + (x1 - x0) * this.t, sy = y0 + (y1 - y0) * this.t;
      ctx.moveTo(sx, sy);
      var rest = seg * (1 - this.t);
      if (rest <= budget) {
        ctx.lineTo(x1, y1);
        budget -= rest; this.pi++; this.t = 0;
        this.x = x1; this.y = y1;
      } else {
        var nt = this.t + budget / seg;
        this.x = x0 + (x1 - x0) * nt; this.y = y0 + (y1 - y0) * nt;
        ctx.lineTo(this.x, this.y);
        this.t = nt; budget = 0;
      }
    }
    ctx.stroke();
  };
  PathRunner.prototype.finish = function (ctx) { this.advance(ctx, Infinity); };

  /* Durations in ms at 1x speed */
  var PHASES = [
    { key: 'sketch', label: 'Laying in the shapes', ms: 3800 },
    { key: 'contour', label: 'Inking the contours', ms: 7600 },
    { key: 'detail', label: 'Hatching the detail', ms: 9600 },
    { key: 'tone', label: 'Washing in the tones', ms: 5200 },
    { key: 'settle', label: 'Letting the ink dry', ms: 1400 }
  ];
  var TOTAL_MS = PHASES.reduce(function (s, p) { return s + p.ms; }, 0);

  var NIB_SVG =
    '<svg viewBox="0 0 40 120" aria-hidden="true">' +
    '<path d="M20 0 L34 52 Q36 70 28 86 L24 120 L16 120 L12 86 Q4 70 6 52 Z" fill="#1d1b19"/>' +
    '<path d="M20 2 L31 50 Q32 62 26 72 L20 76 L14 72 Q8 62 9 50 Z" fill="#b8925a"/>' +
    '<circle cx="20" cy="44" r="3.2" fill="#1d1b19"/>' +
    '<path d="M20 47 L20 2" stroke="#1d1b19" stroke-width="1.4"/>' +
    '</svg>';

  function SketchEngine(stage, opts) {
    opts = opts || {};
    this.stage = stage;
    this.id = opts.id;
    this.speed = opts.speed || 1;
    this.onProgress = opts.onProgress || null;
    this.onPhase = opts.onPhase || null;
    this.onDone = opts.onDone || null;
    this.state = 'idle';
    this.ready = Promise.all([loadData(this.id), loadImage(this.id)]).then(function (r) {
      this.data = r[0]; this.img = r[1];
      this._build();
      return this;
    }.bind(this));
  }

  SketchEngine.prototype._build = function () {
    var st = this.stage, d = this.data;
    st.classList.add('sk-stage');
    st.style.aspectRatio = d.w + ' / ' + d.h;
    st.innerHTML = '';
    var mk = function (cls) {
      var c = document.createElement('canvas'); c.className = 'sk-layer ' + cls; st.appendChild(c); return c;
    };
    this.cSketch = mk('sk-graphite');
    this.cTone = mk('sk-tone');
    this.cInk = mk('sk-ink');
    this.nib = document.createElement('div');
    this.nib.className = 'sk-nib';
    this.nib.innerHTML = NIB_SVG;
    st.appendChild(this.nib);
    this.mask = document.createElement('canvas');
    this.mask.width = Math.max(2, Math.round(d.w / 4));
    this.mask.height = Math.max(2, Math.round(d.h / 4));
    this._size();
    this.reset();
  };

  /* Pick a canvas resolution from the on-screen size. Called on start, so a
     lightbox that was hidden at construction still gets sharp lines. */
  SketchEngine.prototype._size = function () {
    var d = this.data;
    var cssW = this.stage.clientWidth || 600;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var resW = Math.round(Math.min(cssW * dpr, d.w * 1.5));
    if (this.resW === resW) return false;
    this.resW = resW;
    var resH = Math.round(resW * d.h / d.w);
    this.scale = resW / d.w;
    this.pxUnit = dpr / this.scale; // one CSS pixel in data units
    [this.cSketch, this.cTone, this.cInk].forEach(function (c) { c.width = resW; c.height = resH; });
    return true;
  };

  SketchEngine.prototype._ctx = function (c) {
    var g = c.getContext('2d');
    g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    g.lineCap = 'round'; g.lineJoin = 'round';
    return g;
  };

  SketchEngine.prototype.reset = function () {
    if (!this.data) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.state = 'idle';
    this.phase = 0;
    this.phaseT = 0;
    this.elapsed = 0;
    this.runners = {
      sketch: new PathRunner(this.data.sketch),
      contour: new PathRunner(this.data.contour),
      detail: new PathRunner(this.data.detail)
    };
    this.brushDist = 0;
    var gS = this._ctx(this.cSketch), gI = this._ctx(this.cInk), gT = this.cTone.getContext('2d');
    gS.clearRect(0, 0, this.data.w, this.data.h);
    gI.clearRect(0, 0, this.data.w, this.data.h);
    gT.setTransform(1, 0, 0, 1, 0, 0);
    gT.clearRect(0, 0, this.cTone.width, this.cTone.height);
    this.mask.getContext('2d').clearRect(0, 0, this.mask.width, this.mask.height);
    this._styleLayers(false);
    this.nib.classList.remove('on');
    this.stage.classList.remove('sk-done');
    this._emitProgress();
  };

  SketchEngine.prototype._styleLayers = function (finished, animate) {
    var set = function (el, op) {
      el.style.transition = animate ? 'opacity 1.6s ease' : 'none';
      el.style.opacity = op;
    };
    set(this.cSketch, finished ? 0 : 1);
    set(this.cInk, finished ? 0.22 : 1);
    set(this.cTone, 1);
  };

  SketchEngine.prototype.start = function () {
    var self = this;
    return this.ready.then(function () {
      if (self.state === 'running') return;
      if (self.state === 'done') self.reset();
      if (self._size()) self._redrawAll();
      self.state = 'running';
      self.last = performance.now();
      self.raf = requestAnimationFrame(self._tick.bind(self));
    });
  };

  SketchEngine.prototype.pause = function () {
    if (this.state !== 'running') return;
    this.state = 'paused';
    cancelAnimationFrame(this.raf);
    this.nib.classList.remove('on');
  };

  SketchEngine.prototype.resume = function () {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.last = performance.now();
    this.raf = requestAnimationFrame(this._tick.bind(this));
  };

  SketchEngine.prototype.replay = function () {
    var self = this;
    return this.ready.then(function () { self.reset(); self._size(); return self.start(); });
  };

  SketchEngine.prototype.setSpeed = function (s) { this.speed = s; };

  /* Rebuilds the drawing after a canvas resize by replaying finished work */
  SketchEngine.prototype._redrawAll = function () {
    var keep = this.phase, keepT = this.phaseT, keepE = this.elapsed;
    var r = this.runners;
    var marks = ['sketch', 'contour', 'detail'].map(function (k) { return [r[k].si, r[k].pi, r[k].t]; });
    this.reset();
    var g = { sketch: this._pen('sketch'), contour: this._pen('contour'), detail: this._pen('detail') };
    ['sketch', 'contour', 'detail'].forEach(function (k, i) {
      var run = this.runners[k], m = marks[i], gc = g[k];
      while (!run.done() && (run.si < m[0] || (run.si === m[0] && run.pi < m[1]))) run.advance(gc, 50);
    }, this);
    this.phase = keep; this.phaseT = keepT; this.elapsed = keepE;
    if (keep >= 3) this._paintTone(keep > 3 ? 1 : keepT / PHASES[3].ms, keep > 3 ? 1 : 0);
  };

  SketchEngine.prototype._pen = function (kind) {
    var g;
    if (kind === 'sketch') {
      g = this._ctx(this.cSketch);
      g.strokeStyle = 'rgba(92, 88, 96, 0.42)';
      g.lineWidth = 0.9 * this.pxUnit;
    } else {
      g = this._ctx(this.cInk);
      g.strokeStyle = kind === 'contour' ? 'rgba(24, 20, 18, 0.92)' : 'rgba(30, 26, 24, 0.78)';
      g.lineWidth = (kind === 'contour' ? 1.15 : 0.8) * this.pxUnit;
    }
    return g;
  };

  /* A wide soft brush zig-zags down the page, like laying in a wash */
  SketchEngine.prototype._brushPos = function (p) {
    var rows = 5;
    var rp = Math.min(p, 0.9999) * rows;
    var row = Math.floor(rp), u = rp - row;
    var e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    var xs = row % 2 === 0 ? e : 1 - e;
    return {
      x: -0.12 + xs * 1.24,
      y: (row + 0.5) / rows + Math.sin(u * Math.PI * 3 + row) * 0.03,
      r: 0.62 / rows
    };
  };

  SketchEngine.prototype._paintMask = function (p0, p1) {
    var m = this.mask, g = m.getContext('2d');
    var W = m.width, H = m.height;
    var steps = Math.max(1, Math.ceil((p1 - p0) * 400));
    for (var i = 1; i <= steps; i++) {
      var b = this._brushPos(p0 + (p1 - p0) * (i / steps));
      var x = b.x * W, y = b.y * H, r = b.r * Math.max(W, H * 0.8);
      var grad = g.createRadialGradient(x, y, r * 0.15, x, y, r);
      grad.addColorStop(0, 'rgba(0,0,0,0.55)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  };

  SketchEngine.prototype._paintTone = function (maskP, fullAlpha) {
    var c = this.cTone, g = c.getContext('2d');
    if (maskP >= 1) {
      var mg = this.mask.getContext('2d');
      mg.fillStyle = '#000'; mg.fillRect(0, 0, this.mask.width, this.mask.height);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(this.img, 0, 0, c.width, c.height);
    g.globalCompositeOperation = 'destination-in';
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.mask, 0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-over';
    if (fullAlpha > 0) {
      g.globalAlpha = fullAlpha;
      g.drawImage(this.img, 0, 0, c.width, c.height);
      g.globalAlpha = 1;
    }
  };

  SketchEngine.prototype._moveNib = function (x, y) {
    var px = x / this.data.w * 100, py = y / this.data.h * 100;
    this.nib.style.left = px + '%';
    this.nib.style.top = py + '%';
    this.nib.classList.add('on');
  };

  SketchEngine.prototype._emitProgress = function () {
    if (this.onProgress) this.onProgress(Math.min(1, this.elapsed / TOTAL_MS), PHASES[Math.min(this.phase, PHASES.length - 1)].label);
  };

  SketchEngine.prototype._tick = function (now) {
    if (this.state !== 'running') return;
    var dt = Math.min(now - this.last, 64) * this.speed;
    this.last = now;
    this._step(dt);
    if (this.state === 'running') this.raf = requestAnimationFrame(this._tick.bind(this));
  };

  SketchEngine.prototype._step = function (dt) {
    while (dt > 0 && this.phase < PHASES.length) {
      var ph = PHASES[this.phase];
      var take = Math.min(dt, ph.ms - this.phaseT);
      var t0 = this.phaseT / ph.ms;
      this.phaseT += take; this.elapsed += take; dt -= take;
      var t1 = this.phaseT / ph.ms;

      if (ph.key === 'sketch' || ph.key === 'contour' || ph.key === 'detail') {
        var run = this.runners[ph.key];
        // ease-in-out: slow start, quick middle, careful finish
        var ease = function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; };
        var want = ph.key === 'detail' ? t1 : ease(t1);
        var have = ph.key === 'detail' ? t0 : ease(t0);
        run.advance(this._pen(ph.key), (want - have) * run.total + (this.phaseT >= ph.ms ? 1e9 : 0));
        if (!run.done()) this._moveNib(run.x, run.y);
      } else if (ph.key === 'tone') {
        if (t0 === 0) {
          this.cSketch.style.transition = 'opacity 2.4s ease';
          this.cSketch.style.opacity = 0;
          if (this.onPhase) this.onPhase('tone');
        }
        this._paintMask(t0, t1);
        this._paintTone(t1, 0);
        var b = this._brushPos(t1);
        this._moveNib(Math.max(0, Math.min(1, b.x)) * this.data.w, b.y * this.data.h);
      } else if (ph.key === 'settle') {
        if (t0 === 0) {
          this.nib.classList.remove('on');
          this.cInk.style.transition = 'opacity 1.6s ease';
          this.cInk.style.opacity = 0.22;
        }
        this._paintTone(1, t1);
      }

      if (this.phaseT >= ph.ms) {
        this.phase++; this.phaseT = 0;
        if (this.onPhase && this.phase < PHASES.length) this.onPhase(PHASES[this.phase].key);
      }
    }
    this._emitProgress();
    if (this.phase >= PHASES.length) this._finishUp(true);
  };

  SketchEngine.prototype._finishUp = function (animate) {
    cancelAnimationFrame(this.raf);
    this.state = 'done';
    this.nib.classList.remove('on');
    this._styleLayers(true, animate);
    this.stage.classList.add('sk-done');
    this.elapsed = TOTAL_MS;
    this._emitProgress();
    if (this.onDone) this.onDone();
  };

  /* Jump straight to the finished artwork */
  SketchEngine.prototype.showFinal = function () {
    var self = this;
    return this.ready.then(function () {
      cancelAnimationFrame(self.raf);
      self._size();
      if (self.state !== 'idle') self.reset();
      ['sketch', 'contour', 'detail'].forEach(function (k) { self.runners[k].finish(self._pen(k)); });
      self._paintTone(1, 1);
      self.phase = PHASES.length;
      self._finishUp(false);
    });
  };

  SketchEngine.prototype.destroy = function () {
    cancelAnimationFrame(this.raf);
    this.state = 'destroyed';
  };

  SketchEngine.preload = function (id) { return Promise.all([loadData(id), loadImage(id)]); };
  SketchEngine.TOTAL_MS = TOTAL_MS;
  window.SketchEngine = SketchEngine;
})();
