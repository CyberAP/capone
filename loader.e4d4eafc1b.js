// Release page boot (scripts/release-build.py injects it into the built capone.html).
//
// GitHub Pages compresses with gzip on the fly and cannot send precompressed brotli, so the
// game's two big files ship as brotli streams (capone.<hash>.wasm.br, capone.<hash>.data.br:
// ~2.2x smaller than Pages' gzip) that this script downloads with a progress bar and decodes
// with a small wasm brotli decoder (brotli-dec.<hash>.js, ~0.15 s for both). The decoded
// bytes go to Emscripten through its own hooks: Module.instantiateWasm and
// Module.getPreloadedPackage. capone.js is added only then.
//
// The game's main() waits behind a run dependency ('capone-start') until the player clicks
// «Играть»: the click is the user gesture that audio, fullscreen and pointer lock need, and
// everything else (wasm compile, sound decode, saves restore) is done by then.
//
// Other files the page fetches (sfx/*) get ?v=<content hash> appended through a fetch
// wrapper, so a new release never mixes with stale cached copies; the lookup is
// case-insensitive (Pages is case-sensitive, the game's paths are not).
(function () {
  'use strict';
  const R = window.CAPONE_RELEASE;
  const $ = (id) => document.getElementById(id);
  const landing = $('landing');
  const t0 = performance.now();
  const timing = (window.capone = window.capone || {}).release = { build: R.build };

  // ------------------------------------------------------------------ cache-busting fetch
  const baseDir = new URL('.', location.href).pathname;
  const realFetch = window.fetch.bind(window);
  function versioned(u) {
    try {
      const url = new URL(u, location.href);
      if (url.origin !== location.origin || url.search || !url.pathname.startsWith(baseDir)) return u;
      const a = R.assets[decodeURIComponent(url.pathname.slice(baseDir.length)).toLowerCase()];
      return a ? baseDir + a[0].split('/').map(encodeURIComponent).join('/') + '?v=' + a[1] : u;
    } catch (e) { return u; }
  }
  window.fetch = (input, init) => realFetch(typeof input === 'string' || input instanceof URL ? versioned(String(input)) : input, init);

  const bg = R.bg; // the menus' bill (the game's own copy is inside the data package)
  landing.style.setProperty('--bg-image', `url("${bg}")`);

  // ------------------------------------------------------------------ UI helpers
  const statusEl = $('landing-status'), bar = $('landing-bar-fill'), barBox = $('landing-bar');
  const playBtn = $('landing-play'), fsBtn = $('landing-fs');
  const setStatus = (t) => { statusEl.textContent = t; };
  const MB = (n) => (n / 1048576).toFixed(1).replace('.', ',');
  function fail(msg) {
    landing.classList.add('failed');
    setStatus(msg);
    console.log('[release] ' + msg);
  }

  // ------------------------------------------------------------------ fullscreen
  // (WebKit: the prefixed names too.) wantFs: the player chose fullscreen (the button, Alt+Enter);
  // the browser leaving it by itself during the game (iOS's swipe down) offers it back (fsAgain).
  // iPhone (any iOS browser is WebKit): no fullscreen at all (user, 2026-10-19: «Полноэкранный режим
  // вообще убираем из айфона»; WebKit's swipe down out of it is by design, bugs.webkit.org 264215).
  // The game fills the browser's viewport there; the whole screen is the home screen app's (below).
  const iPhone = /iPhone|iPod/.test(navigator.userAgent);
  const standalone = !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches));
  window.capone.iPhone = iPhone;
  const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const fsEvents = ['fullscreenchange', 'webkitfullscreenchange'];
  const onFsChange = (f) => fsEvents.forEach((n) => document.addEventListener(n, f));
  let wantFs = false;
  function enterFullscreen() {
    const el = document.documentElement;
    const request = el.requestFullscreen ? (o) => el.requestFullscreen(o) : el.webkitRequestFullscreen ? () => el.webkitRequestFullscreen() : null;
    if (iPhone) return Promise.resolve();
    wantFs = true;
    if (isFs() || !request) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const once = () => { fsEvents.forEach((n) => document.removeEventListener(n, once)); setTimeout(finish, 100); };
      onFsChange(once);
      try { Promise.resolve(request({ navigationUI: 'hide' })).catch(finish); } catch (e) { finish(); }
      setTimeout(finish, 1500);
    });
  }
  function exitFullscreen() {
    wantFs = false;
    const exit = document.exitFullscreen ? () => document.exitFullscreen() : document.webkitExitFullscreen ? () => document.webkitExitFullscreen() : null;
    try { if (exit) Promise.resolve(exit()).catch(() => {}); } catch (e) {}
  }
  const toggleFullscreen = () => (isFs() ? exitFullscreen() : enterFullscreen());
  // «На весь экран»: small, top centre, when the browser took the game out of fullscreen by itself
  // (the player did not ask: the corner button and Alt+Enter clear wantFs). Nothing pauses.
  const fsAgain = document.createElement('button');
  fsAgain.id = 'fs-again';
  fsAgain.type = 'button';
  fsAgain.textContent = 'На весь экран';
  fsAgain.hidden = true;
  document.body.appendChild(fsAgain);
  fsAgain.addEventListener('click', () => { fsAgain.hidden = true; enterFullscreen(); });
  // Touch devices only: on a desktop, leaving fullscreen (Esc) is the player's own choice.
  const touchDevice = navigator.maxTouchPoints > 0 && !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  onFsChange(() => { fsAgain.hidden = !touchDevice || isFs() || !wantFs || !landing.hidden; });
  // ...and the next touch in the game brings it back by itself: a touchend / click is a user
  // gesture, which the request needs (iOS's swipe down leaves fullscreen however the page guards
  // its touches); the game's state is untouched (the same page, the canvas refits). The button
  // stays as the visible way back.
  const restore = () => {
    if (iPhone || !touchDevice || isFs() || !wantFs || !landing.hidden) return;
    enterFullscreen().then(() => { fsAgain.hidden = isFs() || !wantFs; });
  };
  document.addEventListener('touchend', restore, { capture: true, passive: true });
  // «Во весь экран» on the landing: the page goes fullscreen at once (the click is the gesture);
  // «Играть» then starts the game at that size. Hidden while the page is fullscreen.
  const syncFs = () => landing.classList.toggle('fullscreen', isFs());
  onFsChange(syncFs);
  if (iPhone || (!document.documentElement.requestFullscreen && !document.documentElement.webkitRequestFullscreen)) fsBtn.hidden = true;
  fsBtn.addEventListener('click', () => { enterFullscreen().then(syncFs); });
  // The game takes the page's size as its screen once, when it starts (capone_host.c: the
  // display mode); a later resize only refits that picture into the page. So the start waits
  // until the size has settled: a fullscreen switch (the button, Alt+Enter) still under way grows
  // the page a moment later. Settled = the same innerWidth x innerHeight x devicePixelRatio for
  // 250 ms and 4 animation frames, at most 2 s.
  let fsChangedAt = 0;
  onFsChange(() => { fsChangedAt = performance.now(); });
  function settledSize() {
    return new Promise((resolve) => {
      const tEnd = performance.now() + 2000;
      let last = '', since = performance.now(), frames = 0;
      const step = () => {
        const t = performance.now(), now = `${innerWidth}x${innerHeight}@${devicePixelRatio}`;
        if (now !== last) last = now, since = t, frames = 0; else frames++;
        const quiet = Math.min(t - since, t - fsChangedAt);
        if ((quiet >= 250 && frames >= 4) || t > tEnd) resolve(now); else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  window.addEventListener('keydown', (e) => {                       // Alt+Enter, as in old Windows games
    if (e.altKey && (e.key === 'Enter' || e.code === 'Enter') && !iPhone) { e.preventDefault(); e.stopImmediatePropagation(); toggleFullscreen(); }
  }, true);

  // ------------------------------------------------------------------ iPhone: the home screen
  // In Safari (not the installed app) a «На экран Домой» button where the fullscreen one is; it
  // shows how to add the game (iOS lets no page do it): the app from the icon is the whole screen.
  (function homeScreen() {
    if (!iPhone || standalone) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'landing-home';
    btn.className = 'landing-small';
    btn.textContent = 'На экран «Домой»';
    fsBtn.after(btn);
    const share = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3v12M7.5 7.5L12 3l4.5 4.5" fill="none" stroke="#e9f3d2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10H5.5v10.5h13V10H16" fill="none" stroke="#e9f3d2" stroke-width="2" stroke-linejoin="round"/></svg>';
    const add = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="none" stroke="#e9f3d2" stroke-width="2"/><path d="M12 8v8M8 12h8" stroke="#e9f3d2" stroke-width="2" stroke-linecap="round"/></svg>';
    const box = document.createElement('div');
    box.id = 'home-help';
    box.hidden = true;
    box.setAttribute('role', 'dialog');
    box.innerHTML =
      '<div class="home-card"><p class="home-title">Игра на весь экран</p><ol>' +
      '<li><span class="home-icon">' + share + '</span>Нажмите «Поделиться» в панели Safari</li>' +
      '<li><span class="home-icon">' + add + '</span>Выберите «На экран „Домой“»</li>' +
      '<li><span class="home-icon home-app"></span>Откройте игру с её значка: она займёт весь экран, без панелей браузера</li></ol>' +
      '<p class="home-note">У приложения на экране «Домой» свои сохранения. Чтобы перенести их из Safari: в игре ☰ → «Скачать сохранения», затем в приложении ☰ → «Загрузить сохранения».</p>' +
      '<button type="button" class="landing-small" id="home-close">Понятно</button></div>';
    landing.appendChild(box);
    const icon = document.querySelector('link[rel=apple-touch-icon]');
    if (icon) box.querySelector('.home-app').style.backgroundImage = 'url("' + icon.href + '")';
    btn.addEventListener('click', () => { box.hidden = false; });
    box.querySelector('#home-close').addEventListener('click', () => { box.hidden = true; });
    box.addEventListener('click', (e) => { if (e.target === box) box.hidden = true; });
  })();

  // ------------------------------------------------------------------ browser check
  const jspi = typeof WebAssembly === 'object' && typeof WebAssembly.Suspending === 'function';
  let webgl2 = false;
  try { webgl2 = !!document.createElement('canvas').getContext('webgl2'); } catch (e) {}
  if (!jspi || !webgl2) {
    landing.classList.add('unsupported');
    $('landing-unsupported').hidden = false;
    $('landing-unsupported-why').textContent = !jspi
      ? 'Игре нужна поддержка WebAssembly JSPI: Chrome или Edge 137 и новее (в Firefox пока только за флагом, в Safari её нет).'
      : 'Игре нужен WebGL 2.';
    $('landing-try').addEventListener('click', () => { $('landing-unsupported').hidden = true; boot(); });
    return;
  }
  boot();

  // ------------------------------------------------------------------ download + decode
  async function download(url, expected, progress) {
    const r = await realFetch(url);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    const reader = r.body.getReader(), chunks = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.length;
      progress(value.length);
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    if (n !== expected) console.log(`[release] ${url}: ${n} bytes, expected ${expected} (the server decoded it?)`);
    return out;
  }
  // a few at a time, so the big downloads keep most of the bandwidth; failures are left to the page
  async function prefetch(list, progress) {
    const queue = list.slice();
    const worker = async () => {
      for (let a; (a = queue.shift());) {
        try { const r = await window.fetch(a[0]); await r.arrayBuffer(); } catch (e) {}
        progress(a[2] || 0);
      }
    };
    await Promise.all([1, 2, 3, 4, 5, 6].map(worker));
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('cannot load ' + src));
      document.body.appendChild(s);
    });
  }
  // brotli -> exact-size ArrayBuffer (or the bytes as they are, if the server already decoded them)
  function decode(dec, bytes, raw) {
    if (bytes.length === raw && raw !== 0) return bytes.slice().buffer;
    const ip = dec._malloc(bytes.length), op = dec._malloc(raw), sp = dec._malloc(4);
    try {
      dec.HEAPU8.set(bytes, ip);
      dec.HEAPU32[sp >> 2] = raw;
      if (dec._BrotliDecoderDecompress(bytes.length, ip, sp, op) !== 1 || dec.HEAPU32[sp >> 2] !== raw) throw new Error('brotli: corrupt download');
      return dec.HEAPU8.slice(op, op + raw).buffer;
    } finally { dec._free(ip); dec._free(op); dec._free(sp); }
  }

  async function boot() {
    const F = R.files;
    // The sound effects (sfx/*.opus, ~2.5 MB) are fetched by the page before main(); getting
    // them into the HTTP cache now, alongside the big files, saves a second wait after.
    const sfx = Object.values(R.assets).filter((a) => a[0].startsWith('sfx/'));
    const total = F.wasm.size + F.data.size + F.js.raw + F.brotli.raw + sfx.reduce((n, a) => n + (a[2] || 0), 0);
    let got = 0, shown = 0;
    const progress = (n) => {
      got += n;
      const now = performance.now();
      if (now - shown < 50 && got < total) return;
      shown = now;
      const f = Math.min(1, got / total);
      bar.style.width = (100 * f).toFixed(1) + '%';
      barBox.setAttribute('aria-valuenow', Math.round(100 * f));
      setStatus(`Загрузка… ${MB(got)} из ${MB(total)} МБ`);
    };
    setStatus('Загрузка…');
    try {
      const [, wasmBr, dataBr] = await Promise.all([
        loadScript(F.brotli.url).then(() => progress(F.brotli.raw)),
        download(F.wasm.url, F.wasm.size, progress),
        download(F.data.url, F.data.size, progress),
        realFetch(F.js.url).then((r) => r.arrayBuffer()).then(() => progress(F.js.raw)),   // warms the cache for the <script>
        prefetch(sfx, progress),
      ]);
      timing.downloadMs = performance.now() - t0;
      setStatus('Распаковка…');
      await new Promise((r) => setTimeout(r, 0));
      const t1 = performance.now();
      const dec = await window.BrotliDecModule();
      let wasm = decode(dec, wasmBr, F.wasm.raw);
      let data = decode(dec, dataBr, F.data.raw);
      timing.decodeMs = performance.now() - t1;
      window.BrotliDecModule = undefined;   // a global var: not deletable
      // (Module.wasmBinary is not in this build's INCOMING_MODULE_JS_API; instantiateWasm is.)
      Module.instantiateWasm = (imports, receive) => {
        const t2 = performance.now();
        WebAssembly.instantiate(wasm, imports).then((r) => {
          timing.compileMs = performance.now() - t2;
          wasm = null;
          receive(r.instance);
        }, (e) => fail('Не удалось запустить игру: ' + e.message));
        return {};
      };
      Module.getPreloadedPackage = () => { const d = data; data = null; return d; };
      start();
    } catch (e) {
      fail('Не удалось загрузить игру: ' + e.message + '. Обновите страницу.');
    }
  }

  // ------------------------------------------------------------------ start gate
  function start() {
    setStatus('Подготовка…');
    let left = -1, gated = false, ready = false;
    const prevMonitor = Module.monitorRunDependencies;
    Module.monitorRunDependencies = (n) => {
      if (prevMonitor) prevMonitor(n);
      left = n;
      if (gated && !ready && n === 1) setTimeout(() => { if (!ready && left === 1) showPlay(); }, 30);
    };
    Module.preRun = Module.preRun ? [].concat(Module.preRun) : [];
    Module.preRun.push(() => { gated = true; addRunDependency('capone-start'); });
    const prevAbort = Module.onAbort;
    Module.onAbort = (what) => { fail('Ошибка игры: ' + what); if (prevAbort) prevAbort(what); };

    function showPlay() {
      ready = true;
      timing.readyMs = performance.now() - t0;
      bar.style.width = '100%';
      landing.classList.add('ready');
      setStatus('');
      playBtn.disabled = false;
      playBtn.focus();
      if (new URLSearchParams(location.search).has('autostart')) play();   // tests
    }
    async function play() {
      if (!ready || landing.classList.contains('started')) return;
      landing.classList.add('started');
      timing.startSize = await settledSize();
      landing.hidden = true;
      timing.startMs = performance.now() - t0;
      const canvas = document.getElementById('canvas');
      if (canvas) canvas.focus();
      removeRunDependency('capone-start');
      cornerMenu();
    }
    playBtn.addEventListener('click', play);
    loadScript(R.files.js.url).catch((e) => fail('Не удалось загрузить игру: ' + e.message));
  }

  // ------------------------------------------------------------------ in-game corner button
  // (user, 2026-10-19: «Бургер меню на айфоне вообще убери… На десктопе бургер меню заменяем кнопкой
  // полного экрана».) Desktop only, top right, faint; hidden while the mouse is locked.
  function cornerMenu() {
    if (iPhone) return;
    const btn = $('corner');
    btn.hidden = false;
    btn.addEventListener('click', () => { toggleFullscreen(); btn.blur(); });
    const sync = () => { btn.classList.toggle('locked', !!document.pointerLockElement); btn.classList.toggle('fs', isFs()); };
    document.addEventListener('pointerlockchange', sync);
    for (const e of fsEvents) document.addEventListener(e, sync);
    sync();
  }
})();
