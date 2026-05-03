/**
 * SOUNDVAULT — app.js
 * UI controller, Google Ads integration, IntersectionObserver lazy loading
 */

"use strict";

// ── GOOGLE ADSENSE CONFIG ────────────────────────────────────
// Replace with your actual AdSense publisher ID
const ADSENSE_PUBLISHER_ID = "ca-pub-XXXXXXXXXXXXXXXX";

// Ad unit IDs — create these in your AdSense dashboard
const AD_UNITS = {
  leaderboard: "XXXXXXXXXX",   // 728×90 or responsive leaderboard
  sidebar:     "XXXXXXXXXX",   // 300×250 medium rectangle
  infeed:      "XXXXXXXXXX",   // Native in-feed / responsive
  sticky:      "XXXXXXXXXX",   // 300×250 sticky sidebar
};

// ── UTILITY ──────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

function animNum(el, target) {
  const cur  = parseInt(el.textContent) || 0;
  if (cur === target) return;
  const step = Math.max(1, Math.ceil(Math.abs(target - cur) / 10));
  let v      = cur;
  const tick = setInterval(() => {
    v = cur < target ? Math.min(v + step, target) : Math.max(v - step, target);
    el.textContent = v;
    if (v === target) clearInterval(tick);
  }, 30);
}

window.showToast = function(msg, type = 'info') {
  const wrap  = document.getElementById('toastWrap');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  wrap.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
};

// ── ADS HELPER ───────────────────────────────────────────────
/**
 * Creates an AdSense ad element.
 * adsbygoogle.push({}) signals the ad to render.
 *
 * In development / demo mode these will show "ad not loaded" placeholders,
 * which is expected — real ads appear only on approved, live domains.
 */
function makeAdSlot(unitId, format = 'auto', fullWidthResponsive = false) {
  const ins = document.createElement('ins');
  ins.className                = 'adsbygoogle';
  ins.style.display            = 'block';
  ins.dataset.adClient         = ADSENSE_PUBLISHER_ID;
  ins.dataset.adSlot           = unitId;
  ins.dataset.adFormat         = format;
  if (fullWidthResponsive) ins.dataset.fullWidthResponsive = 'true';

  // Defer push until the element is in the DOM
  requestAnimationFrame(() => {
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); }
    catch (e) { /* AdSense not loaded yet */ }
  });
  return ins;
}

function injectLeaderboardAd() {
  const slot = document.getElementById('adLeaderboard');
  if (!slot) return;
  slot.appendChild(makeAdSlot(AD_UNITS.leaderboard, 'auto', true));
}

function injectSidebarAds() {
  const top    = document.getElementById('adSidebarTop');
  const sticky = document.getElementById('adSidebarSticky');
  if (top)    top.appendChild(makeAdSlot(AD_UNITS.sidebar, 'rectangle'));
  if (sticky) sticky.appendChild(makeAdSlot(AD_UNITS.sticky, 'rectangle'));
}

// In-feed ad card — same grid cell size as sound cards
function makeInFeedAdCard() {
  const cell = document.createElement('div');
  cell.className = 'ad-in-feed';
  cell.appendChild(makeAdSlot(AD_UNITS.infeed, 'fluid'));
  return cell;
}

// ── APP CONTROLLER ───────────────────────────────────────────
class SoundVaultApp {
  constructor() {
    const { FirestoreEngine, AudioEngine } = window.SV;
    this.fs    = new FirestoreEngine(window._firestoreDB ?? null);
    this.audio = new AudioEngine();

    this.state = {
      category:  'all',
      tags:      [],
      sort:      'name',
      search:    '',
      cursor:    null,
      hasMore:   true,
      loading:   false,
      viewMode:  'grid',
      playsToday: 0,
      loaded:    0,       // cards rendered so far in current query
    };

    this._searchTimer = null;
    this._observer    = null;
  }

  // ── INIT ───────────────────────────────────────────────────
  async init() {
    this._setupAudio();
    this._bindUI();
    this._setupObserver();

    injectLeaderboardAd();
    injectSidebarAds();

    await this._loadMeta();
    await this._fetchPage();
  }

  // ── META ───────────────────────────────────────────────────
  async _loadMeta() {
    const [counts, tags] = await Promise.all([
      this.fs.getCounts(),
      this.fs.getTags(),
    ]);
    this._renderCats(counts);
    this._renderTags(tags);
    animNum(document.getElementById('statTotal'), counts.all ?? 0);
    animNum(document.getElementById('statCats'),
      Object.keys(counts).filter(k => k !== 'all').length);
  }

  _renderCats(counts) {
    const defs = [
      { key:'all',     label:'All Sounds',     icon:'🎵' },
      { key:'sfx',     label:'Sound Effects',  icon:'💥' },
      { key:'music',   label:'Music & Beats',  icon:'🎸' },
      { key:'voice',   label:'Voice & Speech', icon:'🎙️' },
      { key:'nature',  label:'Nature & Field', icon:'🌿' },
      { key:'ui',      label:'UI Sounds',      icon:'🖱️' },
      { key:'ambient', label:'Ambient',        icon:'🌌' },
    ];

    const list = document.getElementById('catList');
    list.innerHTML = '';

    for (const d of defs) {
      const n = counts[d.key] ?? 0;
      if (d.key !== 'all' && n === 0) continue;
      const li = document.createElement('li');
      li.className  = 'cat-item' + (d.key === this.state.category ? ' active' : '');
      li.dataset.cat = d.key;
      li.innerHTML  = `
        <span class="cat-icon">${d.icon}</span>
        ${esc(d.label)}
        <span class="cat-count">${n}</span>`;
      li.addEventListener('click', () => this._setCat(d.key));
      list.appendChild(li);
    }
  }

  _renderTags(tags) {
    const cloud = document.getElementById('tagsCloud');
    cloud.innerHTML = '';
    for (const tag of tags.slice(0, 28)) {
      const p = document.createElement('span');
      p.className   = 'tag-pill';
      p.textContent = `#${tag}`;
      p.addEventListener('click', () => this._toggleTag(tag));
      cloud.appendChild(p);
    }
  }

  // ── FETCH ──────────────────────────────────────────────────
  async _fetchPage() {
    if (this.state.loading || !this.state.hasMore) return;
    this.state.loading = true;
    this._spinner(true);

    try {
      const res = await this.fs.fetchPage({
        category: this.state.category,
        tags:     this.state.tags,
        sort:     this.state.sort,
        cursor:   this.state.cursor,
        search:   this.state.search,
      });

      this.state.cursor  = res.nextCursor;
      this.state.hasMore = res.hasMore;

      this._renderCards(res.sounds);
      this._updateMeta(res._total);

      if (!res.hasMore) document.getElementById('endLabel').classList.add('on');
    } catch (e) {
      console.error('[App] fetch error:', e);
      showToast('⚠ Failed to load sounds', 'error');
    } finally {
      this.state.loading = false;
      this._spinner(false);
    }
  }

  // ── RENDER CARDS ──────────────────────────────────────────
  _renderCards(sounds) {
    const grid  = document.getElementById('soundGrid');
    const empty = document.getElementById('emptyState');

    if (sounds.length === 0 && this.state.loaded === 0) {
      empty.classList.add('on'); return;
    }
    empty.classList.remove('on');

    const { AD_INTERVAL } = window.SV;
    const frag = document.createDocumentFragment();

    sounds.forEach((sound, i) => {
      const globalIdx = this.state.loaded + i;

      // Insert in-feed ad every AD_INTERVAL cards (except at position 0)
      if (globalIdx > 0 && globalIdx % AD_INTERVAL === 0) {
        frag.appendChild(makeInFeedAdCard());
      }

      frag.appendChild(this._makeCard(sound));
    });

    grid.appendChild(frag);
    this.state.loaded += sounds.length;
  }

  _makeCard(sound) {
    const card       = document.createElement('div');
    card.className   = 'sound-card';
    card.dataset.id  = sound.id;
    card.dataset.cat = sound.category;

    const icons = { sfx:'💥', music:'🎸', voice:'🎙️', nature:'🌿', ui:'🖱️', ambient:'🌌' };
    const icon  = sound.icon || icons[sound.category] || '🎵';

    card.innerHTML = `
      <div class="card-icon">${icon}</div>
      <div class="card-name">${esc(sound.name)}</div>
      <div class="card-foot">
        <span class="card-cat">${esc(sound.category.toUpperCase())}</span>
        <span class="card-size">${sound.sizeKB}KB</span>
      </div>`;

    // Mouse-follow radial glow
    card.addEventListener('mousemove', e => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
      card.style.setProperty('--my', ((e.clientY - r.top)  / r.height * 100).toFixed(1) + '%');
    });

    card.addEventListener('click', e => {
      this._ripple(card, e);
      this.audio.play(sound);
      this.fs.incPlay(sound.id);
    });

    return card;
  }

  _ripple(card, e) {
    const r    = card.getBoundingClientRect();
    const size = Math.max(card.offsetWidth, card.offsetHeight) * 2;
    const el   = document.createElement('div');
    el.className  = 'ripple';
    el.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX-r.left-size/2}px;top:${e.clientY-r.top-size/2}px`;
    card.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  // ── AUDIO CALLBACKS ────────────────────────────────────────
  _setupAudio() {
    this.audio.onStart = (sound) => {
      this.state.playsToday++;
      animNum(document.getElementById('statPlays'), this.state.playsToday);

      document.getElementById('npName').textContent     = sound.name;
      document.getElementById('npCat').textContent      = `[${sound.category}]`;
      document.getElementById('npBar').classList.add('visible');

      document.querySelector('.sound-card.playing')?.classList.remove('playing');
      document.querySelector(`.sound-card[data-id="${sound.id}"]`)?.classList.add('playing');
    };

    this.audio.onEnd = (sound) => {
      document.getElementById('npBar').classList.remove('visible');
      document.querySelector(`.sound-card[data-id="${sound.id}"]`)?.classList.remove('playing');
    };
  }

  // ── INTERSECTION OBSERVER ──────────────────────────────────
  _setupObserver() {
    this._observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && !this.state.loading && this.state.hasMore) {
          this._fetchPage();
        }
      },
      { rootMargin: '220px' }
    );
    this._observer.observe(document.getElementById('sentinel'));
  }

  // ── FILTER STATE ──────────────────────────────────────────
  _setCat(cat) {
    if (this.state.category === cat) return;
    this.state.category = cat;
    this._reset();
    document.querySelectorAll('.cat-item').forEach(el =>
      el.classList.toggle('active', el.dataset.cat === cat));

    const labels = { all:'ALL SOUNDS', sfx:'SOUND EFFECTS', music:'MUSIC & BEATS',
                     voice:'VOICE & SPEECH', nature:'NATURE & FIELD',
                     ui:'UI SOUNDS', ambient:'AMBIENT' };
    document.getElementById('gridTitle').innerHTML =
      `${labels[cat] || cat.toUpperCase()} <span></span>`;
  }

  _toggleTag(tag) {
    const idx = this.state.tags.indexOf(tag);
    idx >= 0 ? this.state.tags.splice(idx, 1) : this.state.tags.push(tag);
    document.querySelectorAll('.tag-pill').forEach(el =>
      el.classList.toggle('active', this.state.tags.includes(el.textContent.slice(1))));
    this._reset();
  }

  _reset() {
    this.state.cursor  = null;
    this.state.hasMore = true;
    this.state.loaded  = 0;
    document.getElementById('soundGrid').innerHTML = '';
    document.getElementById('emptyState').classList.remove('on');
    document.getElementById('endLabel').classList.remove('on');
    this._fetchPage();
  }

  // ── BINDINGS ──────────────────────────────────────────────
  _bindUI() {
    // Search (debounced)
    document.getElementById('searchInput').addEventListener('input', e => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        this.state.search = e.target.value.trim();
        this._reset();
      }, window.SV.DEBOUNCE_SEARCH);
    });

    // Sort
    document.getElementById('sortSelect').addEventListener('change', e => {
      this.state.sort = e.target.value;
      this._reset();
    });

    // View toggle
    document.getElementById('viewGrid').addEventListener('click', () => this._setView('grid'));
    document.getElementById('viewList').addEventListener('click', () => this._setView('list'));

    // Stop
    document.getElementById('npStop').addEventListener('click', () => this.audio.stop());

    // Volume
    const volSlider = document.getElementById('volSlider');
    volSlider.addEventListener('input', e => {
      const v = +e.target.value;
      this.audio.setVol(v);
      document.getElementById('volIcon').textContent = v === 0 ? '🔇' : v < 0.4 ? '🔉' : '🔊';
    });
    document.getElementById('volIcon').addEventListener('click', () => {
      const muted = +volSlider.value > 0;
      const nv    = muted ? 0 : 0.8;
      volSlider.value = nv;
      this.audio.setVol(nv);
      document.getElementById('volIcon').textContent = nv === 0 ? '🔇' : '🔊';
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.audio.stop();
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        document.getElementById('searchInput').focus();
      }
    });
  }

  _setView(mode) {
    this.state.viewMode = mode;
    document.getElementById('soundGrid').classList.toggle('list-view', mode === 'list');
    document.getElementById('viewGrid').classList.toggle('active', mode === 'grid');
    document.getElementById('viewList').classList.toggle('active', mode === 'list');
  }

  _spinner(on)  { document.getElementById('spinner').classList.toggle('on', on); }
  _updateMeta(total) {
    document.getElementById('gridMeta').textContent =
      `Showing ${this.state.loaded}${this.state.hasMore ? '+' : ''} of ${total ?? '?'} sounds`;
  }
}

// ── BOOT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const app = new SoundVaultApp();
  await app.init();
  showToast('🔥 Demo mode — wire up Firebase to go live!', 'success');
});
