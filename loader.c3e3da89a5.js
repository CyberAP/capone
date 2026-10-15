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
// Other files the page fetches (sfx/*, hd/*) get ?v=<content hash> appended through a fetch
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

  const bg = versioned('hd/HD/Menus/mainmenu_bg_16x9.webp');
  landing.style.setProperty('--bg-image', `url("${bg}")`);

  // ------------------------------------------------------------------ UI helpers
  const statusEl = $('landing-status'), bar = $('landing-bar-fill'), barBox = $('landing-bar');
  const playBtn = $('landing-play'), fsBox = $('landing-fullscreen');
  const setStatus = (t) => { statusEl.textContent = t; };
  const MB = (n) => (n / 1048576).toFixed(1).replace('.', ',');
  function fail(msg) {
    landing.classList.add('failed');
    setStatus(msg);
    console.log('[release] ' + msg);
  }
  try { fsBox.checked = localStorage.getItem('capone.fullscreen') !== '0'; } catch (e) {}
  fsBox.addEventListener('change', () => { try { localStorage.setItem('capone.fullscreen', fsBox.checked ? '1' : '0'); } catch (e) {} });

  // Saves on the landing page: work before the game is loaded (IndexedDB only).
  function savesUi(exportBtn, importBtn, note) {
    const P = window.caponePersist;
    if (!P) { exportBtn.disabled = importBtn.disabled = true; return; }
    const say = (t) => { note.textContent = t; };
    exportBtn.addEventListener('click', async () => {
      try { const n = await P.download(); say(n ? `Сохранено файлов: ${n}` : 'Сохранений пока нет'); }
      catch (e) { say('Не удалось: ' + e.message); }
    });
    importBtn.addEventListener('click', async () => {
      try {
        const r = await P.pickAndImport();
        if (!r) return;
        say(`Загружено файлов: ${r.count}`);
        if (r.running && confirm('Сохранения загружены. Игра прочитает их после перезапуска. Перезапустить сейчас?')) location.reload();
      } catch (e) { say('Не удалось: ' + e.message); }
    });
  }
  savesUi($('landing-export'), $('landing-import'), $('landing-saves-note'));

  // ------------------------------------------------------------------ fullscreen
  const isFs = () => !!document.fullscreenElement;
  function enterFullscreen() {
    const el = document.documentElement;
    if (isFs() || !el.requestFullscreen) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      document.addEventListener('fullscreenchange', () => setTimeout(finish, 100), { once: true });
      el.requestFullscreen({ navigationUI: 'hide' }).catch(finish);
      setTimeout(finish, 1500);
    });
  }
  const toggleFullscreen = () => (isFs() ? document.exitFullscreen().catch(() => {}) : enterFullscreen());
  window.addEventListener('keydown', (e) => {                       // Alt+Enter, as in old Windows games
    if (e.altKey && (e.key === 'Enter' || e.code === 'Enter')) { e.preventDefault(); e.stopImmediatePropagation(); toggleFullscreen(); }
  }, true);

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
      if (fsBox.checked) await enterFullscreen();
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

  // ------------------------------------------------------------------ in-game corner menu
  // Shown only while the mouse is free (pointer lock off: Esc), top right, faint.
  function cornerMenu() {
    const box = $('corner');
    box.hidden = false;
    const panel = $('corner-panel');
    $('corner-toggle').addEventListener('click', () => { panel.hidden = !panel.hidden; });
    $('corner-fullscreen').addEventListener('click', () => { panel.hidden = true; toggleFullscreen(); });
    savesUi($('corner-export'), $('corner-import'), $('corner-note'));
    const sync = () => box.classList.toggle('locked', !!document.pointerLockElement);
    document.addEventListener('pointerlockchange', () => { sync(); if (document.pointerLockElement) panel.hidden = true; });
    sync();
  }
})();
