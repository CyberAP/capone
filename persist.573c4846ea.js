// Saves and settings that survive a reload (web build).
//
// The game writes its files (Capone.config: the player, the campaign progress and the
// settings; anything else it creates) into its folder, /game, which is Emscripten's in-memory
// FS. This script keeps every file the game writes there in IndexedDB and puts them back
// before main() on the next visit.
//
//   restore: a preRun step reads the database (a run dependency, so main waits for it); the
//            files are written into /game in onRuntimeInitialized, after the data package
//            (which holds the stock Capone.config) is in place and right before main().
//   save:    FS.close of a file opened for writing, FS.rename and FS.unlink under /game mark
//            the path; marked paths are written to the database 300 ms later. A scan of /game
//            every 15 s and on page hide catches anything the hooks missed.
//
// The page's own files (Sound/: the decoded effects; HD/, Portraits/: the art placeholders)
// are never saved. window.caponePersist exports and imports the saves as a .zip (stored or
// deflated entries; paths relative to the game folder) and works before the game is loaded,
// so a landing page can offer it. Plain IndexedDB, no IDBFS: no link flags needed.
//
// Loaded either as a <script> before capone.js or as --pre-js; the second copy does nothing.
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.caponePersist) return;

  const ROOT = '/game';
  const DB_NAME = 'capone-saves', STORE = 'files';
  const SKIP = /^\/game\/(Sound|HD|Portraits)(\/|$)/i;
  const SCAN_MS = 15000, FLUSH_MS = 300;
  const log = (t) => console.log('[persist] ' + t);

  // ------------------------------------------------------------------ IndexedDB
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error('no IndexedDB'));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'path' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB blocked'));
      });
      dbPromise.catch((e) => log('IndexedDB unavailable: ' + e + ' (saves last only until reload)'));
    }
    return dbPromise;
  }
  function tx(mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('aborted'));
    }));
  }
  const allRecords = () => tx('readonly', (s) => s.getAll()).then((r) => r || []);
  const putRecords = (recs) => tx('readwrite', (s) => { for (const r of recs) s.put(r); });
  const deletePaths = (paths) => tx('readwrite', (s) => { for (const p of paths) s.delete(p); });
  const clearAll = () => tx('readwrite', (s) => { s.clear(); });

  // ------------------------------------------------------------------ the game folder (FS)
  let restored = null;          // records read before main
  let armed = false;            // true once main is about to run: from then on writes are the game's
  const known = new Map();      // path -> mtime of what /game held at the last scan or save
  const dirty = new Set();
  let flushTimer = 0, flushing = Promise.resolve();
  const stats = { restored: 0, saved: 0, deleted: 0, lastSave: 0 };

  const fsReady = () => typeof FS !== 'undefined' && FS && typeof FS.stat === 'function';
  const inScope = (p) => typeof p === 'string' && p.startsWith(ROOT + '/') && !SKIP.test(p);
  function normalize(p) {
    if (typeof p !== 'string') return null;
    try { if (fsReady() && FS.cwd && !p.startsWith('/')) p = FS.cwd().replace(/\/$/, '') + '/' + p; } catch (e) {}
    const parts = [];
    for (const s of p.split('/')) { if (!s || s === '.') continue; if (s === '..') parts.pop(); else parts.push(s); }
    return '/' + parts.join('/');
  }
  function statFile(p) {
    try { const st = FS.stat(p); return FS.isFile(st.mode) ? st : null; } catch (e) { return null; }
  }
  const mtimeOf = (st) => (st.mtime instanceof Date ? st.mtime.getTime() : +st.mtime || 0);

  function writeIntoFs(path, data, mtime) {
    const dir = path.slice(0, path.lastIndexOf('/'));
    try { FS.mkdirTree(dir); } catch (e) {}
    FS.writeFile(path, data);
    if (mtime) try { FS.utime(path, mtime, mtime); } catch (e) {}
  }

  function walk(dir, out) {
    let names;
    try { names = FS.readdir(dir); } catch (e) { return out; }
    for (const n of names) {
      if (n === '.' || n === '..') continue;
      const p = (dir === '/' ? '' : dir) + '/' + n;
      if (SKIP.test(p + '/')) continue;
      let st;
      try { st = FS.stat(p); } catch (e) { continue; }
      if (FS.isDir(st.mode)) walk(p, out);
      else if (FS.isFile(st.mode)) out.set(p, mtimeOf(st));
    }
    return out;
  }

  function mark(path) {
    path = normalize(path);
    if (!armed || !inScope(path)) return;
    dirty.add(path);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    clearTimeout(flushTimer);
    if (!dirty.size || !fsReady()) return flushing;
    const paths = [...dirty];
    dirty.clear();
    const puts = [], dels = [];
    for (const p of paths) {
      const st = statFile(p);
      if (st) {
        try {
          puts.push({ path: p, data: FS.readFile(p), mtime: mtimeOf(st) });
          known.set(p, mtimeOf(st));
        } catch (e) { log('read ' + p + ': ' + e); }
      } else {
        dels.push(p);
        known.delete(p);
      }
    }
    flushing = flushing.then(async () => {
      try {
        if (puts.length) await putRecords(puts);
        if (dels.length) await deletePaths(dels);
        stats.saved += puts.length, stats.deleted += dels.length, stats.lastSave = Date.now();
        if (puts.length || dels.length) log(`saved ${puts.map((r) => r.path.slice(ROOT.length + 1)).join(', ') || '-'}` +
                                            (dels.length ? `; removed ${dels.join(', ')}` : ''));
      } catch (e) { log('save failed: ' + e); }
    });
    return flushing;
  }

  // The safety net: any file under /game whose mtime changed, appeared or vanished.
  function scan() {
    if (!armed || !fsReady()) return flushing;
    const now = walk(ROOT, new Map());
    for (const [p, m] of now) if (known.get(p) !== m) dirty.add(p);
    for (const p of known.keys()) if (!now.has(p)) dirty.add(p);
    return flush();
  }

  function hookFs() {
    if (FS.__caponePersist) return;
    FS.__caponePersist = true;
    const close = FS.close, rename = FS.rename, unlink = FS.unlink;
    FS.close = function (stream) {
      let path = null;
      try { if (stream && (stream.flags & 3) !== 0) path = stream.path; } catch (e) {}   // O_WRONLY | O_RDWR
      const r = close.apply(this, arguments);
      if (path) mark(path);
      return r;
    };
    FS.rename = function (from, to) {
      const r = rename.apply(this, arguments);
      mark(from), mark(to);
      return r;
    };
    FS.unlink = function (path) {
      const r = unlink.apply(this, arguments);
      mark(path);
      return r;
    };
  }

  // Right before main(): the saved files go over the package's stock ones.
  function restoreAndArm() {
    if (armed || !fsReady()) return;
    const t0 = performance.now();
    for (const r of restored || []) {
      if (!inScope(r.path)) continue;
      try { writeIntoFs(r.path, r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data), r.mtime); stats.restored++; }
      catch (e) { log('restore ' + r.path + ': ' + e); }
    }
    restored = null;
    walk(ROOT, known);
    hookFs();
    armed = true;
    if (stats.restored) log(`restored ${stats.restored} file(s) in ${(performance.now() - t0).toFixed(0)} ms`);
    setInterval(scan, SCAN_MS);
    const onHide = () => { scan(); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onHide(); });
    window.addEventListener('pagehide', onHide);
  }

  function install(M) {
    if (!M || M.__caponePersist) return;
    M.__caponePersist = true;
    M.preRun = M.preRun ? [].concat(M.preRun) : [];
    M.preRun.push(() => {
      addRunDependency('persist');
      allRecords().then((r) => { restored = r; }, (e) => { log('restore skipped: ' + e); restored = []; })
        .finally(() => removeRunDependency('persist'));
    });
    const prev = M.onRuntimeInitialized;
    M.onRuntimeInitialized = function () {
      restoreAndArm();
      if (prev) return prev.apply(this, arguments);
    };
  }

  // ------------------------------------------------------------------ zip (export / import)
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

  function zip(entries) {   // [{name, data: Uint8Array, mtime}] -> Blob (stored, UTF-8 names)
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name), d = new Date(e.mtime || Date.now());
      const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      const crc = crc32(e.data), size = e.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true);
      parts.push(lh, name, e.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch, name);
      offset += 30 + name.length + size;
    }
    const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  async function unzip(buf) {   // ArrayBuffer -> [{name, data}]
    const u8 = new Uint8Array(buf), v = new DataView(buf), out = [];
    let e = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('not a zip file');
    const count = v.getUint16(e + 10, true);
    let p = v.getUint32(e + 16, true);
    const utf8 = new TextDecoder(), cp437 = new TextDecoder('latin1');
    for (let k = 0; k < count; k++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error('broken zip directory');
      const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true);
      const csize = v.getUint32(p + 20, true), nlen = v.getUint16(p + 28, true);
      const xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), lho = v.getUint32(p + 42, true);
      const name = (flags & 0x800 ? utf8 : cp437).decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (name.endsWith('/')) continue;
      const start = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
      const raw = u8.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else throw new Error(`${name}: unsupported zip method ${method}`);
      out.push({ name, data });
    }
    return out;
  }

  // ------------------------------------------------------------------ public API
  async function list() {
    await flush();
    return (await allRecords()).map((r) => ({ name: r.path.slice(ROOT.length + 1), size: r.data.byteLength, mtime: r.mtime }));
  }
  async function exportZip() {
    if (armed) scan();
    await flush();
    const recs = await allRecords();
    return { count: recs.length, blob: zip(recs.map((r) => ({ name: r.path.slice(ROOT.length + 1), data: new Uint8Array(r.data), mtime: r.mtime }))) };
  }
  async function download() {
    const { count, blob } = await exportZip();
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `capone-saves-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return count;
  }
  // Replaces the saves with the zip's files. While the game runs they are written into its
  // folder too, but the game only reads them at start: the caller should offer a reload.
  async function importZip(file) {
    const entries = await unzip(await (file.arrayBuffer ? file.arrayBuffer() : new Response(file).arrayBuffer()));
    const recs = [];
    let total = 0;
    for (const e of entries) {
      const path = normalize(ROOT + '/' + e.name.replace(/\\/g, '/'));
      if (!inScope(path) || /\.(exe|dll)$/i.test(path)) continue;
      if ((total += e.data.length) > 64 << 20) throw new Error('the zip is too large for saves');
      recs.push({ path, data: e.data, mtime: Date.now() });
    }
    if (!recs.length) throw new Error('no save files in the zip');
    await putRecords(recs);
    if (armed) for (const r of recs) { writeIntoFs(r.path, r.data, r.mtime); known.set(r.path, mtimeOf(statFile(r.path) || { mtime: 0 })); }
    log(`imported ${recs.map((r) => r.path.slice(ROOT.length + 1)).join(', ')}`);
    return { count: recs.length, running: armed };
  }
  // A file picker -> importZip; resolves to its result, or null when nothing was chosen.
  function pickAndImport() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,application/zip';
      input.onchange = () => { const f = input.files && input.files[0]; f ? importZip(f).then(resolve, reject) : resolve(null); };
      input.click();
    });
  }

  window.caponePersist = {
    list, exportZip, download, importZip, pickAndImport, flush: () => (armed ? scan() : flush()),
    clear: () => { known.clear(); return clearAll(); }, stats, get armed() { return armed; },
  };
  if (typeof Module !== 'undefined') install(Module);
  else log('no Module object: persistence API only');
})();
