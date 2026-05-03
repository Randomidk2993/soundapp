/**
 * SOUNDVAULT — engine.js
 * Core systems: IDBCache, MemCache, FirestoreEngine, AudioEngine, SearchEngine
 */

"use strict";

// ── CONSTANTS ────────────────────────────────────────────────
const PAGE_SIZE       = 40;
const CACHE_TTL       = 5 * 60_000;    // 5 min memory
const IDB_TTL         = 30 * 60_000;   // 30 min IndexedDB
const DEBOUNCE_SEARCH = 300;
const MAX_AUDIO_POOL  = 6;
const AD_INTERVAL     = 12;            // insert ad every N cards

// ── DEMO DATA ─────────────────────────────────────────────────
// Used when Firebase is not configured.
// Real free CDN URLs — these actually play.
window.DEMO_SOUNDS = [
  // SFX
  { id:'s01', name:'Cinematic Boom',    url:'https://assets.mixkit.co/active_storage/sfx/212/212-preview.mp3',    category:'sfx',    tags:['boom','cinematic','impact'],  sizeKB:180, playCount:312, icon:'💥' },
];

// ── IDB CACHE ────────────────────────────────────────────────
class IDBCache {
  constructor() {
    this.db = null;
    const req = indexedDB.open('soundvault_cache', 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore('pages', { keyPath: 'key' });
    };
    req.onsuccess = e => { this.db = e.target.result; };
    req.onerror   = () => { /* IDB unavailable — silent */ };
  }

  async get(key) {
    if (!this.db) return null;
    return new Promise(res => {
      try {
        const req = this.db.transaction('pages','readonly').objectStore('pages').get(key);
        req.onsuccess = () => {
          const r = req.result;
          if (!r || Date.now() - r.ts > IDB_TTL) { this._del(key); return res(null); }
          res(r.data);
        };
        req.onerror = () => res(null);
      } catch { res(null); }
    });
  }

  async set(key, data) {
    if (!this.db) return;
    return new Promise(res => {
      try {
        const tx = this.db.transaction('pages','readwrite');
        tx.objectStore('pages').put({ key, data, ts: Date.now() });
        tx.oncomplete = () => res();
        tx.onerror    = () => res();
      } catch { res(); }
    });
  }

  _del(key) {
    if (!this.db) return;
    try {
      this.db.transaction('pages','readwrite').objectStore('pages').delete(key);
    } catch { /* ok */ }
  }
}

// ── MEM CACHE ────────────────────────────────────────────────
class MemCache {
  constructor() { this._m = new Map(); }
  get(k) {
    const r = this._m.get(k);
    if (!r) return null;
    if (Date.now() - r.ts > CACHE_TTL) { this._m.delete(k); return null; }
    return r.data;
  }
  set(k, v) { this._m.set(k, { data: v, ts: Date.now() }); }
  del(prefix) {
    for (const k of this._m.keys()) if (k.startsWith(prefix)) this._m.delete(k);
  }
}

// ── FIRESTORE ENGINE ─────────────────────────────────────────
class FirestoreEngine {
  constructor(db) {
    this.db  = db;
    this.mem = new MemCache();
    this.idb = new IDBCache();
    this._catCounts = null;
  }

  async fetchPage({ category='all', tags=[], sort='name', cursor=null, pageSize=PAGE_SIZE, search='' } = {}) {
    const ck = `p:${category}:${tags.join(',')}:${sort}:${cursor?.id ?? '0'}`;

    const mem = this.mem.get(ck);
    if (mem) return mem;

    const idb = await this.idb.get(ck);
    if (idb) { this.mem.set(ck, idb); return idb; }

    // Firestore path
    if (this.db) {
      try {
        let q = this.db.collection('sounds');
        if (category !== 'all') q = q.where('category', '==', category);
        if (tags.length)        q = q.where('tags', 'array-contains-any', tags);

        const dir = sort === 'playCount' || sort === 'createdAt' ? 'desc' : 'asc';
        q = q.orderBy(sort, dir);
        if (cursor?.snap) q = q.startAfter(cursor.snap);
        q = q.limit(pageSize);

        const snap   = await q.get();
        const sounds = snap.docs.map(d => ({ id: d.id, ...d.data(), _snap: d }));
        const result = {
          sounds,
          nextCursor: sounds.length === pageSize ? { id: sounds.at(-1).id, snap: snap.docs.at(-1) } : null,
          hasMore: sounds.length === pageSize,
          _total: null,
        };

        this.mem.set(ck, result);
        // Strip _snap before IDB (not serialisable)
        this.idb.set(ck, { ...result, sounds: sounds.map(s => { const {_snap,...r} = s; return r; }) });
        return result;
      } catch (e) {
        console.warn('[Firestore] query error, falling back:', e.message);
      }
    }

    return this._demoPage({ category, tags, sort, cursor, pageSize, search });
  }

  _demoPage({ category, tags, sort, cursor, pageSize, search }) {
    let data = [...window.DEMO_SOUNDS];

    if (category !== 'all')   data = data.filter(s => s.category === category);
    if (tags.length)          data = data.filter(s => tags.some(t => s.tags.includes(t)));
    if (search.trim())        data = SearchEngine.filter(data, search);

    const sortFn = {
      name:      (a,b) => a.name.localeCompare(b.name),
      playCount: (a,b) => b.playCount - a.playCount,
      createdAt: (a,b) => (b.createdAt||0) - (a.createdAt||0),
      sizeKB:    (a,b) => a.sizeKB - b.sizeKB,
    };
    data.sort(sortFn[sort] || sortFn.name);

    const start = cursor ? data.findIndex(s => s.id === cursor.id) + 1 : 0;
    const page  = data.slice(start, start + pageSize);

    return {
      sounds: page,
      nextCursor: page.length === pageSize ? { id: page.at(-1).id } : null,
      hasMore: page.length === pageSize,
      _total: data.length,
    };
  }

  async getCounts() {
    if (this._catCounts) return this._catCounts;
    if (!this.db) {
      const c = {};
      for (const s of window.DEMO_SOUNDS) c[s.category] = (c[s.category]||0) + 1;
      c.all = window.DEMO_SOUNDS.length;
      this._catCounts = c;
      return c;
    }
    try {
      const doc = await this.db.collection('meta').doc('counts').get();
      const c   = doc.exists ? doc.data() : {};
      c.all = Object.entries(c).filter(([k]) => k !== 'all').reduce((s,[,v]) => s+v, 0);
      this._catCounts = c;
      return c;
    } catch { return { all: 0 }; }
  }

  async getTags() {
    const k = 'meta:tags', hit = this.mem.get(k);
    if (hit) return hit;
    if (!this.db) {
      const t = [...new Set(window.DEMO_SOUNDS.flatMap(s => s.tags))].sort();
      this.mem.set(k, t); return t;
    }
    try {
      const doc = await this.db.collection('meta').doc('tags').get();
      const t   = doc.exists ? (doc.data().list||[]) : [];
      this.mem.set(k, t); return t;
    } catch { return []; }
  }

  incPlay(id) {
    if (!this.db) return;
    this.db.collection('sounds').doc(id).update({
      playCount: firebase.firestore.FieldValue.increment(1)
    }).catch(() => {});
  }
}

// ── SEARCH ENGINE ────────────────────────────────────────────
class SearchEngine {
  static filter(sounds, query) {
    if (!query) return sounds;
    const q = query.toLowerCase().trim();
    return sounds.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q) ||
      s.tags.some(t => t.toLowerCase().includes(q))
    );
  }
}

// ── AUDIO ENGINE ─────────────────────────────────────────────
class AudioEngine {
  constructor() {
    this._pool       = new Map();
    this._current    = null;
    this._volume     = 0.8;
    this._debounce   = new Map();
    this.playCount   = 0;
    this.onStart     = null;
    this.onEnd       = null;
  }

  setVol(v) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this._current?.audio) this._current.audio.volume = this._volume;
  }

  play(sound) {
    if (this._debounce.has(sound.id)) clearTimeout(this._debounce.get(sound.id));
    this._debounce.set(sound.id, setTimeout(() => {
      this._debounce.delete(sound.id);
      this._exec(sound);
    }, 50));
  }

  _exec(sound) {
    // Toggle off if same sound
    if (this._current?.id === sound.id) { this.stop(); return; }
    if (this._current) this.stop(false);

    let entry = this._pool.get(sound.url);
    if (!entry) {
      const audio    = new Audio();
      audio.preload  = 'none';
      audio.volume   = this._volume;
      entry          = { audio };
      this._pool.set(sound.url, entry);

      // Evict oldest from pool
      if (this._pool.size > MAX_AUDIO_POOL) {
        const first = this._pool.keys().next().value;
        this._pool.get(first).audio.src = '';
        this._pool.delete(first);
      }
    }

    const { audio } = entry;
    audio.volume       = this._volume;
    audio.currentTime  = 0;
    audio.src          = sound.url;

    const onEnd = () => {
      audio.removeEventListener('ended', onEnd);
      if (this._current?.id === sound.id) {
        this.onEnd?.(sound);
        this._current = null;
      }
    };
    audio.addEventListener('ended', onEnd);

    audio.play().catch(err => {
      console.warn('[Audio]', err.message);
      this.onEnd?.(sound);
      this._current = null;
      window.showToast('⚠ Audio blocked — click again', 'error');
    });

    this._current = { audio, id: sound.id };
    this.playCount++;
    this.onStart?.(sound, audio);
  }

  stop(notify = true) {
    if (!this._current) return;
    const { audio, id } = this._current;
    audio.pause();
    audio.currentTime = 0;
    if (notify) this.onEnd?.({ id });
    this._current = null;
  }

  get currentId()  { return this._current?.id ?? null; }
  get isPlaying()  { return !!this._current; }
}

// ── EXPORTS (global, no module bundler required) ─────────────
window.SV = {
  IDBCache, MemCache, FirestoreEngine,
  AudioEngine, SearchEngine,
  PAGE_SIZE, AD_INTERVAL, DEBOUNCE_SEARCH,
};
