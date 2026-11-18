(function () {
  'use strict';

  var ART = window.ARTWORKS;
  var byId = {};
  ART.forEach(function (a, i) { a.plate = i + 1; byId[a.id] = a; });

  var reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
  var skipMotion = reduceMQ.matches;
  try { if (localStorage.getItem('linework-skip') === '1') skipMotion = true; } catch (e) {}

  var ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------- Loading screen ---------- */
  var loaderDone = (function () {
    var root = document.documentElement;
    var el = document.getElementById('loader');
    if (!el) { root.classList.remove('is-loading'); return Promise.resolve(); }
    var fill = document.getElementById('loader-fill');
    var pctEl = document.getElementById('loader-pct');
    var msgEl = document.getElementById('loader-msg');
    var MESSAGES = ['Sharpening the pencil', 'Pinning the paper', 'Mixing the ink', 'Finding the first line'];
    // Hold until the loader's own sketch finishes drawing (last stroke ends ~3.8s)
    var MIN_MS = skipMotion ? 300 : 4000;
    var MAX_MS = 10000;
    var t0 = performance.now();
    var shown = 0, target = 8, finished = false, msgIndex = 0;
    var resolveDone;
    var done = new Promise(function (r) { resolveDone = r; });

    var msgTimer = setInterval(function () {
      msgIndex = (msgIndex + 1) % MESSAGES.length;
      msgEl.parentNode.classList.add('swap');
      setTimeout(function () { msgEl.textContent = MESSAGES[msgIndex]; msgEl.parentNode.classList.remove('swap'); }, 300);
    }, 1500);

    function frame() {
      // Creep toward 90% while waiting; jump to the real target as tasks finish
      if (!finished && target < 90) target += (90 - target) * 0.006;
      // Never run ahead of the intro sketch, so 100% lands as the last stroke does
      var cap = Math.min(100, 10 + 90 * (performance.now() - t0) / MIN_MS);
      var goal = Math.min(target, cap);
      shown += (goal - shown) * (skipMotion ? 1 : 0.08);
      if (goal - shown < 0.3) shown = goal;
      fill.style.strokeDashoffset = (100 - shown).toFixed(2);
      pctEl.textContent = Math.round(shown);
      if (finished && shown >= 100) return lift();
      requestAnimationFrame(frame);
    }

    function lift() {
      clearInterval(msgTimer);
      msgEl.textContent = 'Ready';
      var wait = Math.max(0, MIN_MS - (performance.now() - t0));
      setTimeout(function () {
        el.classList.add('out');
        root.classList.remove('is-loading');
        resolveDone();
        setTimeout(function () { el.remove(); }, 1000);
      }, wait + 250);
    }

    function bump(n) { target = Math.max(target, n); }
    var fonts = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    var tasks = [fonts.then(function () { bump(45); })];

    var timeout = setTimeout(function () { finish(); }, MAX_MS);
    function finish() {
      if (finished) return;
      finished = true; target = 100; clearTimeout(timeout);
    }

    requestAnimationFrame(frame);
    return {
      promise: done,
      add: function (p) {
        tasks.push(p.then(function () { bump(target + 25); }, function () {}));
        Promise.all(tasks).then(finish, finish);
      }
    };
  })();

  /* ---------- Hero ---------- */
  var heroPhase = document.getElementById('hero-phase');
  var hero = new SketchEngine(document.getElementById('hero-stage'), {
    id: 'castle',
    onProgress: function (p, label) { heroPhase.textContent = p >= 1 ? 'Finished. Scroll on for more.' : label + '…'; },
    onDone: function () { document.querySelector('.hero').classList.add('done'); }
  });
  var loaderPromise = loaderDone.promise || loaderDone;
  if (loaderDone.add) loaderDone.add(hero.ready);
  Promise.all([hero.ready, loaderPromise]).then(function () {
    if (skipMotion) return hero.showFinal();
    setTimeout(function () { hero.start(); }, 500);
  }).catch(showLoadError);

  /* ---------- Plates ---------- */
  var platesEl = document.getElementById('plates');
  var engines = {};

  ART.slice(1).forEach(function (a, i) {
    var el = document.createElement('article');
    el.className = 'plate' + (i % 2 ? ' flip' : '');
    el.id = 'plate-' + a.id;
    el.innerHTML =
      '<div class="plate-art">' +
        '<div class="frame" style="--tilt:' + (i % 2 ? '0.7deg' : '-0.6deg') + '">' +
          '<div class="tape tape-l"></div><div class="tape tape-r"></div>' +
          '<button class="stage-btn" type="button" aria-label="Open ' + esc(a.title) + ' in the viewer">' +
            '<div class="sk-stage placeholder" data-id="' + a.id + '" role="img" aria-label="' + esc(a.title) + ' being drawn"></div>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="plate-text ruled">' +
        '<p class="plate-no hand">Plate ' + ROMAN[a.plate - 1] + '.</p>' +
        '<h3>' + esc(a.title) + '</h3>' +
        '<p class="medium">' + esc(a.medium) + '</p>' +
        '<p class="note">' + esc(a.note) + '</p>' +
        '<ul class="tags">' + a.tags.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' +
        '<div class="plate-actions">' +
          '<button class="btn small" type="button" data-replay="' + a.id + '">↺ Draw again</button>' +
          '<button class="link-btn" type="button" data-open="' + a.id + '">look closer</button>' +
        '</div>' +
      '</div>';
    platesEl.appendChild(el);
    var stage = el.querySelector('.sk-stage');
    stage.style.aspectRatio = '3 / 4';
    el.querySelector('.stage-btn').addEventListener('click', function () { openLightbox(a.id); });
  });

  function engineFor(id) {
    if (!engines[id]) {
      var stage = document.querySelector('#plate-' + id + ' .sk-stage');
      engines[id] = new SketchEngine(stage, { id: id });
      engines[id].ready.then(function () { stage.classList.remove('placeholder'); }).catch(showLoadError);
    }
    return engines[id];
  }

  if ('IntersectionObserver' in window) {
    // Load a little before the plate arrives
    var pre = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { engineFor(en.target.dataset.id); pre.unobserve(en.target); }
      });
    }, { rootMargin: '900px 0px' });

    // Draw while visible, pause while not
    var vis = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var eng = engineFor(en.target.dataset.id);
        if (en.isIntersecting) {
          if (skipMotion) { eng.showFinal(); return; }
          if (eng.state === 'paused') eng.resume(); else if (eng.state === 'idle') eng.start();
        } else if (eng.state === 'running') {
          eng.pause();
        }
      });
    }, { threshold: 0.35 });

    document.querySelectorAll('.plate .sk-stage').forEach(function (s) { pre.observe(s); vis.observe(s); });

    var proc = document.getElementById('process');
    new IntersectionObserver(function (entries, ob) {
      if (entries[0].isIntersecting) { proc.classList.add('in'); ob.disconnect(); }
    }, { threshold: 0.3 }).observe(proc);

    // Pause the hero when scrolled away
    new IntersectionObserver(function (entries) {
      var en = entries[0];
      if (!en.isIntersecting && hero.state === 'running') hero.pause();
      else if (en.isIntersecting && hero.state === 'paused') hero.resume();
    }, { threshold: 0.15 }).observe(document.getElementById('hero-stage'));
  } else {
    ART.slice(1).forEach(function (a) { engineFor(a.id).showFinal(); });
  }

  document.addEventListener('click', function (e) {
    var r = e.target.closest('[data-replay]');
    if (r) { engineFor(r.dataset.replay).replay(); return; }
    var o = e.target.closest('[data-open]');
    if (o) openLightbox(o.dataset.open);
  });

  /* ---------- Credits ---------- */
  var credits = document.getElementById('credit-list');
  ART.forEach(function (a) {
    var li = document.createElement('li');
    li.innerHTML =
      '<img src="assets/art/' + a.id + '.jpg" alt="" loading="lazy" width="56" height="72">' +
      '<div><strong>' + esc(a.title) + '</strong>' +
      '<span>' + (a.signed ? 'Signed “' + esc(a.signed) + '”' : 'Artist unsigned') + ' · via Pinterest</span></div>' +
      '<a href="' + a.src + '" target="_blank" rel="noopener noreferrer">original ↗</a>';
    credits.appendChild(li);
  });

  /* ---------- Lightbox ---------- */
  var dlg = document.getElementById('lightbox');
  var lbStage = document.getElementById('lb-stage');
  var lbBar = document.getElementById('lb-bar');
  var lbPhase = document.getElementById('lb-phase');
  var lbEngine = null, lbIndex = 0, lbSpeed = 1;

  function openLightbox(id) {
    var a = byId[id];
    if (!a) return;
    lbIndex = ART.indexOf(a);
    document.getElementById('lb-plate').textContent = 'Plate ' + ROMAN[lbIndex];
    document.getElementById('lb-title').textContent = a.title;
    document.getElementById('lb-medium').textContent = a.medium;
    document.getElementById('lb-note').textContent = a.note;
    if (!dlg.open) {
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
      document.body.classList.add('lb-open');
      if (hero.state === 'running') { hero.pause(); hero._lbPaused = true; }
    }
    if (lbEngine) lbEngine.destroy();
    var fresh = lbStage.cloneNode(false);
    lbStage.replaceWith(fresh);
    lbStage = fresh;
    lbBar.style.width = '0%';
    lbPhase.textContent = 'Loading…';
    var eng = lbEngine = new SketchEngine(lbStage, {
      id: id, speed: lbSpeed,
      onProgress: function (p, label) {
        if (eng !== lbEngine) return;
        lbBar.style.width = (p * 100).toFixed(1) + '%';
        lbPhase.textContent = p >= 1 ? 'Finished' : label;
      }
    });
    eng.ready.then(function () {
      if (eng !== lbEngine) return;
      fitStage();
      if (skipMotion) eng.showFinal(); else eng.start();
    }).catch(showLoadError);
  }

  /* Keep the lightbox drawing inside the viewport whatever its shape */
  function fitStage() {
    if (!lbEngine || !lbEngine.data) return;
    var wrap = lbStage.parentElement;
    var maxW = wrap.clientWidth, maxH = wrap.clientHeight;
    var ar = lbEngine.data.w / lbEngine.data.h;
    var w = Math.min(maxW, maxH * ar);
    lbStage.style.width = Math.floor(w) + 'px';
  }
  window.addEventListener('resize', fitStage);

  function closeLightbox() {
    if (lbEngine) { lbEngine.destroy(); lbEngine = null; }
    if (dlg.open) { if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); }
    document.body.classList.remove('lb-open');
    if (hero._lbPaused) { hero._lbPaused = false; hero.resume(); }
  }

  function step(dir) { openLightbox(ART[(lbIndex + dir + ART.length) % ART.length].id); }

  dlg.addEventListener('close', function () { if (lbEngine) closeLightbox(); });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) closeLightbox(); });
  dlg.querySelector('.lb-close').addEventListener('click', closeLightbox);
  dlg.querySelector('.lb-prev').addEventListener('click', function () { step(-1); });
  dlg.querySelector('.lb-next').addEventListener('click', function () { step(1); });
  document.getElementById('lb-replay').addEventListener('click', function () { if (lbEngine) lbEngine.replay(); });
  document.getElementById('lb-final').addEventListener('click', function () { if (lbEngine) lbEngine.showFinal(); });
  dlg.querySelectorAll('[data-speed]').forEach(function (b) {
    b.addEventListener('click', function () {
      lbSpeed = parseFloat(b.dataset.speed);
      dlg.querySelectorAll('[data-speed]').forEach(function (x) { x.classList.toggle('on', x === b); });
      if (lbEngine) lbEngine.setSpeed(lbSpeed);
    });
  });
  document.addEventListener('keydown', function (e) {
    if (!dlg.open) return;
    if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === ' ' && e.target.tagName !== 'BUTTON') { e.preventDefault(); if (lbEngine) lbEngine.replay(); }
  });

  /* ---------- Motion toggle ---------- */
  var toggle = document.getElementById('motion-toggle');
  function syncToggle() { toggle.textContent = skipMotion ? 'Turn animations back on' : 'Skip animations'; }
  syncToggle();
  toggle.addEventListener('click', function () {
    skipMotion = !skipMotion;
    try { localStorage.setItem('linework-skip', skipMotion ? '1' : '0'); } catch (e) {}
    syncToggle();
    if (skipMotion) {
      hero.showFinal();
      Object.keys(engines).forEach(function (k) { engines[k].showFinal(); });
    }
  });

  function showLoadError(err) {
    console.error(err);
    var n = document.createElement('p');
    n.className = 'load-error';
    n.textContent = 'Some drawings could not load. Check that the assets folder sits next to index.html.';
    if (!document.querySelector('.load-error')) document.body.appendChild(n);
  }
})();
