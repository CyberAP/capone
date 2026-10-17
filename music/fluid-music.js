// The game music's synth for the browser: FluidSynth (LGPL-2.1, its own module: music/fluidsynth.js +
// music/fluidsynth.wasm, built from the official 2.6.1 source) and the trimmed GeneralUser GS bank
// (music/capone-gm.sf2). Nothing of it is in the start-up download: caponeMusicStart() fetches the
// three files in the background once the game runs, keeps them in the Cache API for the next visit,
// and instantiates FluidSynth. The game (remaster/recomp/music_recomp.cpp) polls caponeMusic.state:
//   0 loading, 1 FluidSynth and the bank ready, 2 the bank only (TinySoundFont plays it), 3 nothing.
(function () {
  const CACHE = 'capone-music-v1';
  async function cached(url) {
    try {
      const cache = await caches.open(CACHE);
      let response = await cache.match(url);
      if (!response) {
        response = await fetch(url);
        if (!response.ok) throw new Error(url + ': HTTP ' + response.status);
        await cache.put(url, response.clone());
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (e) { // no Cache API (insecure context, private mode): plain fetch
      const response = await fetch(url);
      if (!response.ok) throw e;
      return new Uint8Array(await response.arrayBuffer());
    }
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('cannot load ' + src));
      document.head.appendChild(s);
    });
  }
  globalThis.caponeMusic = { state: 0, bank: null, fluid: null };
  globalThis.caponeMusicStart = async function (base) {
    base = base || 'music/';
    const m = globalThis.caponeMusic;
    if (m.started) return;
    m.started = true;
    const t0 = performance.now();
    const bank = cached(base + 'capone-gm.sf2').then((b) => { m.bank = b; }, (e) => console.log('[music] bank: ' + e));
    const fluid = Promise.all([loadScript(base + 'fluidsynth.js'), cached(base + 'fluidsynth.wasm')])
      .then(([, wasm]) => CaponeFluidSynth({ wasmBinary: wasm, locateFile: (f) => base + f, print: () => {}, printErr: () => {} }))
      .then((module) => { m.fluid = module; }, (e) => console.log('[music] FluidSynth: ' + e));
    await Promise.all([bank, fluid]);
    m.state = m.bank ? (m.fluid ? 1 : 2) : 3;
    console.log(`[music] ${m.state === 1 ? 'FluidSynth and the bank' : m.state === 2 ? 'the bank only' : 'nothing'} ready in ${(performance.now() - t0).toFixed(0)} ms`);
  };
})();
