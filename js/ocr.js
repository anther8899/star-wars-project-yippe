// ============================================
// SWU Card Scanner — Image Hash Recognition (ocr.js)
// ============================================
// Uses perceptual image hashing (pHash/dHash) to match cards.
// No OCR. Compares camera frames against precomputed hashes of all known cards.

window.SWU = window.SWU || {};

SWU.OCR = {
  _hashDB: null,       // Array of { key, set, number, name, hash, variantType }
  _ready: false,
  _building: false,
  CDN_BASE: 'https://cdn.swu-db.com/images/cards',

  // ==========================================
  // Initialization — Build or load hash database
  // ==========================================

  /**
   * Initialize the recognition engine.
   * Loads precomputed hashes from IndexedDB, or builds them from the API.
   */
  async init(onProgress) {
    if (this._ready) return;
    if (this._building) return; // prevent double init
    this._building = true;

    try {
      // Check if we already have hashes cached
      const cachedCount = await SWU.DB.getHashCount();

      if (cachedCount > 100) {
        // Load from cache
        if (onProgress) onProgress('Loading card database...', 10);
        this._hashDB = await SWU.DB.getAllHashes();
        if (onProgress) onProgress('Card database ready', 100);
        this._ready = true;
        this._building = false;
        return;
      }

      // Need to build the hash database from the API
      if (onProgress) onProgress('Building card database (first time)...', 0);
      await this._buildHashDatabase(onProgress);

      this._ready = true;
      this._building = false;
    } catch (err) {
      this._building = false;
      console.error('Failed to init recognition:', err);
      throw new Error('Failed to load card database. Check your internet connection and refresh.');
    }
  },

  /**
   * Build the hash database by fetching all cards from the API,
   * then downloading and hashing each card's artwork.
   */
  async _buildHashDatabase(onProgress) {
    // Get all sets (use API's set list so it stays in sync)
    const sets = SWU.API.ALL_SETS || ['SOR', 'SHD', 'TWI', 'JTL', 'LOF', 'SEC', 'LAW', 'IBH'];
    const allCards = [];

    for (let s = 0; s < sets.length; s++) {
      const setCode = sets[s];
      if (onProgress) onProgress(`Fetching ${setCode} card list...`, Math.round((s / sets.length) * 20));

      try {
        const url = `${SWU.API.BASE_URL}/cards/${setCode}?format=json`;
        const response = await SWU.API._fetch(url);
        const data = await response.json();
        if (data.data) {
          for (const card of data.data) {
            allCards.push({
              set: card.Set,
              number: card.Number,
              name: card.Name,
              subtitle: card.Subtitle || '',
              frontArt: card.FrontArt || '',
              variantType: card.VariantType || 'Normal',
            });
          }
        }
      } catch (err) {
        console.warn(`Failed to fetch set ${setCode}:`, err);
      }
    }

    if (onProgress) onProgress(`Hashing ${allCards.length} cards...`, 20);

    // Hash all card images in batches
    const batchSize = 10;
    const entries = [];
    let processed = 0;

    for (let i = 0; i < allCards.length; i += batchSize) {
      const batch = allCards.slice(i, i + batchSize);

      const results = await Promise.allSettled(
        batch.map(async (card) => {
          if (!card.frontArt) return null;
          try {
            const hash = await this._hashImageUrl(card.frontArt);
            return {
              key: `${card.set}-${card.number}`,
              set: card.set,
              number: card.number,
              name: card.name,
              subtitle: card.subtitle,
              hash: hash,
              variantType: card.variantType,
            };
          } catch {
            return null;
          }
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          entries.push(r.value);
        }
      }

      processed += batch.length;
      if (onProgress) {
        const pct = 20 + Math.round((processed / allCards.length) * 75);
        onProgress(`Hashing cards... ${processed}/${allCards.length}`, pct);
      }
    }

    // Save to IndexedDB
    if (onProgress) onProgress('Saving card database...', 96);
    await SWU.DB.putHashesBulk(entries);
    this._hashDB = entries;

    if (onProgress) onProgress(`Ready! ${entries.length} cards indexed.`, 100);
  },

  // ==========================================
  // Perceptual Hashing
  // ==========================================

  /**
   * Compute a difference hash (dHash) for a canvas.
   * dHash is more robust than aHash for different lighting/camera angles.
   * Returns a 72-bit binary string (9x8 grid).
   */
  computeHash(sourceCanvas) {
    // Resize to 9x8 (we need 9 wide to compute 8 horizontal differences)
    const canvas = document.createElement('canvas');
    canvas.width = 9;
    canvas.height = 8;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0, 9, 8);

    const imageData = ctx.getImageData(0, 0, 9, 8);
    const data = imageData.data;

    // Convert to grayscale row values
    const grays = [];
    for (let i = 0; i < data.length; i += 4) {
      grays.push(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    }

    // dHash: compare each pixel to its right neighbor
    let hash = '';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const left = grays[y * 9 + x];
        const right = grays[y * 9 + x + 1];
        hash += left < right ? '1' : '0';
      }
    }

    return hash; // 64-bit binary string
  },

  /**
   * Compute hash from a URL (loads image, draws to canvas, hashes).
   */
  async _hashImageUrl(url) {
    const canvas = await this._urlToCanvas(url);
    return this.computeHash(canvas);
  },

  /**
   * Compute hash from a video frame or captured image.
   * If fullCard=true, assumes the entire canvas IS the card (e.g. binder crop).
   * Otherwise, extracts the card region from the center of the camera frame.
   */
  computeHashFromCapture(sourceCanvas, fullCard) {
    if (fullCard) {
      // The source IS the card — hash directly
      return this.computeHash(sourceCanvas);
    }

    const srcW = sourceCanvas.width;
    const srcH = sourceCanvas.height;

    // Extract the card region from the center of the frame
    // The overlay guide puts the card in the center ~50% of width
    const cardW = srcW * 0.5;
    const cardH = cardW * (88 / 63); // SWU card aspect ratio
    const cardX = (srcW - cardW) / 2;
    const cardY = (srcH - cardH) / 2;

    // Crop to just the card area
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = Math.round(cardW);
    cropCanvas.height = Math.round(cardH);
    const ctx = cropCanvas.getContext('2d');
    ctx.drawImage(
      sourceCanvas,
      Math.round(cardX), Math.round(cardY),
      Math.round(cardW), Math.round(cardH),
      0, 0,
      cropCanvas.width, cropCanvas.height
    );

    return this.computeHash(cropCanvas);
  },

  /**
   * Hamming distance between two binary hash strings.
   */
  hashDistance(a, b) {
    if (a.length !== b.length) return 64;
    let dist = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) dist++;
    }
    return dist;
  },

  // ==========================================
  // Card Matching
  // ==========================================

  /**
   * Match a captured frame against the hash database.
   * Returns the best match or null.
   */
  matchCard(sourceCanvas, fullCard) {
    if (!this._hashDB || this._hashDB.length === 0) return null;

    const captureHash = this.computeHashFromCapture(sourceCanvas, fullCard);
    let bestMatch = null;
    let bestDist = Infinity;

    for (const entry of this._hashDB) {
      const dist = this.hashDistance(captureHash, entry.hash);
      if (dist < bestDist) {
        bestDist = dist;
        bestMatch = entry;
      }
    }

    // Threshold: allow up to 15 bits different out of 64
    // (accounts for camera angle, lighting, glare, slight framing differences)
    if (bestDist <= 15) {
      return {
        set: bestMatch.set,
        number: bestMatch.number,
        name: bestMatch.name,
        subtitle: bestMatch.subtitle || '',
        variantType: bestMatch.variantType,
        distance: bestDist,
        confidence: Math.round((1 - bestDist / 64) * 100),
      };
    }

    return null;
  },

  /**
   * Main entry point: process a captured image.
   * @param {string|HTMLCanvasElement} imageSource - data URL or canvas
   * @param {object} [options] - { fullCard: true } if the image is already a cropped card
   * Returns { method, set, number, name, confidence } or null-ish result.
   */
  async processCardImage(imageSource, options) {
    let canvas;
    if (typeof imageSource === 'string') {
      canvas = await this._dataUrlToCanvas(imageSource);
    } else {
      canvas = imageSource;
    }

    const fullCard = options && options.fullCard;
    const match = this.matchCard(canvas, fullCard);

    if (match) {
      return {
        method: 'imagehash',
        set: match.set,
        number: match.number,
        ocrText: match.name,
        name: match.name,
        subtitle: match.subtitle,
        variantType: match.variantType,
        confidence: match.confidence,
        distance: match.distance,
        candidates: [],
      };
    }

    return {
      method: 'none',
      set: null,
      number: null,
      ocrText: '',
      name: '',
      confidence: 0,
      candidates: [],
    };
  },

  // ==========================================
  // Utilities
  // ==========================================

  _dataUrlToCanvas(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(canvas);
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = dataUrl;
    });
  },

  _urlToCanvas(url) {
    // Try direct load with CORS first
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(canvas);
      };
      img.onerror = () => {
        // Direct load failed — try via CORS proxy
        this._urlToCanvasViaProxy(url).then(resolve).catch(reject);
      };
      img.src = url;
    });
  },

  /**
   * Fallback: load image via CORS proxy (blob fetch → Object URL → Image).
   */
  async _urlToCanvasViaProxy(url) {
    const proxies = SWU.API.CORS_PROXIES;
    for (let i = 0; i < proxies.length; i++) {
      try {
        const proxiedUrl = proxies[i](url);
        const response = await fetch(proxiedUrl);
        if (!response.ok) continue;
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        try {
          const canvas = await this._blobUrlToCanvas(objectUrl);
          return canvas;
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      } catch { continue; }
    }
    throw new Error('Failed to load image from ' + url);
  },

  _blobUrlToCanvas(blobUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(canvas);
      };
      img.onerror = () => reject(new Error('Failed to decode blob image'));
      img.src = blobUrl;
    });
  },

  async terminate() {
    // No worker to terminate — just clear memory
    this._hashDB = null;
    this._ready = false;
  },

  /**
   * Force rebuild the hash database (e.g. when new sets release).
   */
  async rebuild(onProgress) {
    this._ready = false;
    await SWU.DB.clearHashes();
    this._hashDB = null;
    await this.init(onProgress);
  },
};
