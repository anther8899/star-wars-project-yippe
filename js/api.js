// ============================================
// SWU Card Scanner — SWU-DB API Client (api.js)
// ============================================
// Downloads all card data locally on first launch for instant search.
// ~5 MB for all sets including every variant (Foil, Hyperspace, Showcase, etc.)

window.SWU = window.SWU || {};

SWU.API = {
  BASE_URL: 'https://api.swu-db.com',
  CORS_PROXIES: [
    (url) => 'https://corsproxy.io/?' + encodeURIComponent(url),
    (url) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
  ],
  _proxyIndex: 0,
  _cardNamesCache: null,

  // All known sets (main + promo/event/OP) — from swu-db.com/sets
  ALL_SETS: [
    // Main expansions
    'SOR', 'SHD', 'TWI', 'JTL', 'LOF', 'SEC', 'LAW', 'IBH',
    // Upcoming
    'TS26',
    // Prerelease promos
    'PSOR', 'PSHD', 'PTWI',
    // Event exclusives
    'ESOR',
    // Tokens
    'TSOR',
    // OP (Organized Play) promos + LAW OP
    'SOROP', 'SHDOP', 'TWIOP', 'JTLOP', 'LOFOP', 'SECOP', 'LAWP',
    // Convention & yearly promos
    'C24', 'P25', 'P26',
    // Judge promos
    'J24',
    // Store Showdown promos
    'SS1', 'SS1J', 'SS2',
  ],

  // ==========================================
  // Local catalog (all cards cached in IndexedDB)
  // ==========================================

  _catalog: null,        // Array of all card objects
  _catalogReady: false,
  _catalogLoading: false,
  _nameIndex: null,      // Map<lowercase name, card[]> for fast search

  /**
   * Initialize the local card catalog.
   * On first run, downloads all sets from the API (~5 MB).
   * On subsequent runs, loads from IndexedDB cache instantly.
   */
  async initCatalog(onProgress) {
    if (this._catalogReady) return;
    if (this._catalogLoading) return;
    this._catalogLoading = true;

    try {
      const count = await SWU.DB.getCatalogCount();
      const meta = await SWU.DB.getCatalogMeta();
      const storedSets = (meta && meta.sets) ? meta.sets.length : 0;
      const needsUpdate = storedSets < this.ALL_SETS.length;

      if (count > 100 && !needsUpdate) {
        // Load from local cache
        if (onProgress) onProgress('Loading card catalog...', 10);
        this._catalog = (await SWU.DB.getAllCatalog()).filter(c => c.Name); // filter out meta
        this._buildIndex();
        if (onProgress) onProgress('Card catalog ready', 100);
        this._catalogReady = true;
        this._catalogLoading = false;
        return;
      }

      // First time or update — clear stale data and download all sets
      if (needsUpdate && count > 100) {
        if (onProgress) onProgress('New sets available, updating catalog...', 0);
      } else {
        if (onProgress) onProgress('Downloading card database (first time)...', 0);
      }
      await SWU.DB.clearCatalog();
      await this._downloadAllSets(onProgress);

      this._catalogReady = true;
      this._catalogLoading = false;
    } catch (err) {
      this._catalogLoading = false;
      console.error('Failed to init catalog:', err);
      throw err;
    }
  },

  /**
   * Download all sets from the API and store in IndexedDB.
   */
  async _downloadAllSets(onProgress) {
    const allCards = [];

    for (let i = 0; i < this.ALL_SETS.length; i++) {
      const setCode = this.ALL_SETS[i];
      const pct = Math.round((i / this.ALL_SETS.length) * 90);
      if (onProgress) onProgress(`Downloading ${setCode}...`, pct);

      try {
        const url = `${this.BASE_URL}/cards/${encodeURIComponent(setCode)}?format=json`;
        const response = await this._fetch(url);
        const data = await response.json();
        if (data.data) {
          allCards.push(...data.data);
        }
      } catch (err) {
        console.warn(`Failed to fetch set ${setCode}:`, err);
      }
    }

    if (onProgress) onProgress('Saving to local storage...', 92);
    await SWU.DB.putCatalogBulk(allCards);

    // Save metadata
    await SWU.DB.putCatalogMeta({
      lastUpdated: Date.now(),
      totalCards: allCards.length,
      sets: this.ALL_SETS,
    });

    this._catalog = allCards;
    this._buildIndex();
    if (onProgress) onProgress(`Ready! ${allCards.length} cards cached locally.`, 100);
  },

  /**
   * Strip punctuation/special chars for fuzzy matching.
   * "Palpatine's Return" → "palpatines return"
   */
  _strip(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  },

  /**
   * Build in-memory search index for instant lookups.
   * Pre-computes stripped name+subtitle for each card for fast fuzzy search.
   */
  _buildIndex() {
    this._nameIndex = new Map();
    for (const card of this._catalog) {
      const name = (card.Name || '').toLowerCase();
      if (!this._nameIndex.has(name)) {
        this._nameIndex.set(name, []);
      }
      this._nameIndex.get(name).push(card);

      // Pre-compute stripped search text for fuzzy matching
      card._searchName = this._strip(card.Name);
      card._searchSub = this._strip(card.Subtitle);
    }
  },

  /**
   * Force re-download the entire catalog.
   */
  async rebuildCatalog(onProgress) {
    this._catalogReady = false;
    this._catalog = null;
    this._nameIndex = null;
    await SWU.DB.clearCatalog();
    await this.initCatalog(onProgress);
  },

  // ==========================================
  // Search (local — instant, no network)
  // ==========================================

  /**
   * Search cards locally. Returns all variants (Normal, Foil, Hyperspace, etc.)
   * Fuzzy: strips punctuation, splits into words, each word must appear in
   * either the name or subtitle. "palpatine return" matches "Palpatine's Return".
   * Also ranks results: exact substring > all-words-match > partial.
   */
  searchCardsLocal(query) {
    if (!this._catalog || !query || query.trim().length < 2) {
      return { total_cards: 0, data: [] };
    }

    const raw = query.trim().toLowerCase();
    const stripped = this._strip(query);
    const words = stripped.split(' ').filter(w => w.length > 0);
    if (words.length === 0) return { total_cards: 0, data: [] };

    const scored = [];

    for (const card of this._catalog) {
      const sName = card._searchName || this._strip(card.Name);
      const sSub = card._searchSub || this._strip(card.Subtitle);
      const combined = sName + ' ' + sSub;

      // Check if every search word appears somewhere in name+subtitle
      let allMatch = true;
      for (const w of words) {
        if (!combined.includes(w)) { allMatch = false; break; }
      }
      if (!allMatch) continue;

      // Score: higher is better
      // 3 = exact substring match on raw name (best)
      // 2 = exact substring on stripped name
      // 1 = all words match (fuzzy)
      let score = 1;
      const rawName = (card.Name || '').toLowerCase();
      const rawSub = (card.Subtitle || '').toLowerCase();
      if (rawName.includes(raw) || rawSub.includes(raw)) {
        score = 3;
      } else if (sName.includes(stripped) || sSub.includes(stripped)) {
        score = 2;
      }

      scored.push({ card, score });
    }

    // Sort: best score first, then alphabetical by name
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.card.Name || '').localeCompare(b.card.Name || '');
    });

    const results = scored.map(s => s.card);
    return { total_cards: results.length, data: results };
  },

  /**
   * Get all variants of a specific card from local catalog.
   */
  getAllVariantsLocal(name, subtitle) {
    if (!this._catalog) return [];

    return this._catalog.filter(c => {
      if (c.Name !== name) return false;
      if (subtitle && c.Subtitle !== subtitle) return false;
      if (!subtitle && c.Subtitle) return false;
      return true;
    });
  },

  /**
   * Get a specific card from local catalog by set + number.
   */
  getCardLocal(set, number) {
    if (!this._catalog) return null;
    return this._catalog.find(c => c.Set === set && c.Number === number) || null;
  },

  // ==========================================
  // Network API (fallback + price refresh)
  // ==========================================

  async _fetch(url) {
    // Try direct first
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch { /* CORS blocked, try proxy */ }

    // Try CORS proxies
    for (let i = 0; i < this.CORS_PROXIES.length; i++) {
      const idx = (this._proxyIndex + i) % this.CORS_PROXIES.length;
      const proxiedUrl = this.CORS_PROXIES[idx](url);
      try {
        const response = await fetch(proxiedUrl);
        if (response.ok) {
          this._proxyIndex = idx;
          return response;
        }
      } catch { continue; }
    }

    throw new Error('All API requests failed. Check your internet connection.');
  },

  /**
   * Network search (used as fallback if catalog not ready).
   */
  async searchCards(query) {
    // If catalog is ready, use local search
    if (this._catalogReady) {
      return this.searchCardsLocal(query);
    }

    // Fallback: network search
    if (!query || query.trim().length < 2) {
      return { total_cards: 0, data: [] };
    }

    const url = `${this.BASE_URL}/cards/search?q=${encodeURIComponent(query.trim())}&format=json`;

    try {
      const response = await this._fetch(url);
      const data = await response.json();
      return {
        total_cards: data.total_cards || 0,
        data: data.data || [],
      };
    } catch (err) {
      console.error('SWU API search error:', err);
      throw new Error('Failed to search cards. Check your internet connection.');
    }
  },

  async getCard(set, number) {
    // Try local first
    if (this._catalogReady) {
      const local = this.getCardLocal(set, number);
      if (local) return local;
    }

    // Fallback: network
    const url = `${this.BASE_URL}/cards/${encodeURIComponent(set)}/${encodeURIComponent(number)}?format=json`;

    try {
      const response = await this._fetch(url);
      return await response.json();
    } catch (err) {
      console.error('SWU API getCard error:', err);
      throw new Error('Failed to fetch card data.');
    }
  },

  async getAllVariants(name, subtitle) {
    // Try local first
    if (this._catalogReady) {
      return this.getAllVariantsLocal(name, subtitle);
    }

    // Fallback: network search (only returns Normal variants)
    try {
      const result = await this.searchCards(name);
      if (!result.data) return [];
      return result.data.filter(c => {
        if (c.Name !== name) return false;
        if (subtitle && c.Subtitle !== subtitle) return false;
        if (!subtitle && c.Subtitle) return false;
        return true;
      });
    } catch {
      return [];
    }
  },

  // Keep for backward compat — now just delegates
  async searchCardsWithVariants(query) {
    return this.searchCards(query);
  },

  // ==========================================
  // Utility
  // ==========================================

  async loadCardNames() {
    // If catalog is loaded, extract names from it
    if (this._catalogReady && this._catalog) {
      if (!this._cardNamesCache) {
        const names = new Set();
        for (const c of this._catalog) {
          if (c.Name) names.add(c.Name);
        }
        this._cardNamesCache = [...names];
      }
      return this._cardNamesCache;
    }

    if (this._cardNamesCache) return this._cardNamesCache;

    try {
      const url = `${this.BASE_URL}/catalog/card-names`;
      const response = await this._fetch(url);
      const data = await response.json();
      this._cardNamesCache = data || [];
      return this._cardNamesCache;
    } catch (err) {
      console.warn('Failed to load card names catalog:', err);
      this._cardNamesCache = [];
      return [];
    }
  },

  fuzzyMatch(ocrText, topN = 5) {
    if (!this._cardNamesCache || !ocrText) return [];

    const normalized = this._normalize(ocrText);
    if (normalized.length < 2) return [];

    const results = [];

    for (const name of this._cardNamesCache) {
      const normalizedName = this._normalize(name);
      const score = this._similarity(normalized, normalizedName);
      results.push({ name, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topN);
  },

  _normalize(str) {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  },

  _similarity(a, b) {
    if (a === b) return 1;

    if (a.includes(b) || b.includes(a)) {
      const shorter = a.length < b.length ? a : b;
      const longer = a.length < b.length ? b : a;
      return 0.6 + (0.4 * shorter.length / longer.length);
    }

    const dist = this._levenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - (dist / maxLen);
  },

  _levenshtein(a, b) {
    const m = a.length;
    const n = b.length;

    if (m === 0) return n;
    if (n === 0) return m;

    let prev = new Array(n + 1);
    let curr = new Array(n + 1);

    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,
          curr[j - 1] + 1,
          prev[j - 1] + cost
        );
      }
      [prev, curr] = [curr, prev];
    }

    return prev[n];
  },

  mapCardData(apiCard) {
    return {
      name: apiCard.Name || '',
      subtitle: apiCard.Subtitle || '',
      set: apiCard.Set || '',
      number: apiCard.Number || '',
      type: apiCard.Type || '',
      rarity: apiCard.Rarity || '',
      aspects: apiCard.Aspects || [],
      traits: apiCard.Traits || [],
      cost: apiCard.Cost || '',
      power: apiCard.Power || '',
      hp: apiCard.HP || '',
      frontArt: apiCard.FrontArt || '',
      variantType: apiCard.VariantType || 'Normal',
      marketPrice: apiCard.MarketPrice || '0.00',
      lowPrice: apiCard.LowPrice || '0.00',
      foilPrice: apiCard.FoilPrice || '0.00',
    };
  },
};
