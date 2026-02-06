// ============================================
// SWU Card Scanner — IndexedDB Wrapper (db.js)
// ============================================

window.SWU = window.SWU || {};

SWU.DB = {
  _db: null,
  DB_NAME: 'swu-scanner',
  DB_VERSION: 4,
  STORE_NAME: 'collection',
  HASH_STORE: 'cardHashes',
  CATALOG_STORE: 'cardCatalog',
  ORDERS_STORE: 'orders',

  async init() {
    if (this._db) return this._db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'id' });
          store.createIndex('name', 'name', { unique: false });
          store.createIndex('set', 'set', { unique: false });
          store.createIndex('dateAdded', 'dateAdded', { unique: false });
          store.createIndex('rarity', 'rarity', { unique: false });
        }
        if (!db.objectStoreNames.contains(this.HASH_STORE)) {
          db.createObjectStore(this.HASH_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(this.CATALOG_STORE)) {
          const catStore = db.createObjectStore(this.CATALOG_STORE, { keyPath: 'key' });
          catStore.createIndex('name', 'Name', { unique: false });
          catStore.createIndex('set', 'Set', { unique: false });
        }
        if (!db.objectStoreNames.contains(this.ORDERS_STORE)) {
          const orderStore = db.createObjectStore(this.ORDERS_STORE, { keyPath: 'id' });
          orderStore.createIndex('buyerName', 'buyerName', { unique: false });
          orderStore.createIndex('date', 'date', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this._db = event.target.result;
        resolve(this._db);
      };

      request.onerror = (event) => {
        reject(new Error('Failed to open IndexedDB: ' + event.target.error));
      };
    });
  },

  _getStore(mode, storeName) {
    const name = storeName || this.STORE_NAME;
    const tx = this._db.transaction(name, mode);
    return tx.objectStore(name);
  },

  _request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  // ==========================================
  // Collection CRUD
  // ==========================================

  async addCard(cardData) {
    const store = this._getStore('readwrite');
    const record = {
      ...cardData,
      id: crypto.randomUUID(),
      quantity: cardData.quantity || 1,
      customPrice: cardData.customPrice ?? null,
      notes: cardData.notes || '',
      scannedImage: cardData.scannedImage || null,
      dateAdded: Date.now(),
      dateModified: Date.now(),
    };
    await this._request(store.add(record));
    return record.id;
  },

  async updateCard(id, updates) {
    const card = await this.getCard(id);
    if (!card) throw new Error('Card not found: ' + id);
    const updated = { ...card, ...updates, dateModified: Date.now() };
    const store = this._getStore('readwrite');
    await this._request(store.put(updated));
  },

  async deleteCard(id) {
    const store = this._getStore('readwrite');
    await this._request(store.delete(id));
  },

  async getCard(id) {
    const store = this._getStore('readonly');
    return this._request(store.get(id));
  },

  async getAllCards() {
    const store = this._getStore('readonly');
    const cards = await this._request(store.getAll());
    cards.sort((a, b) => b.dateAdded - a.dateAdded);
    return cards;
  },

  async findByName(name) {
    const store = this._getStore('readonly');
    const index = store.index('name');
    return this._request(index.getAll(name));
  },

  async findDuplicate(set, number, variantType) {
    const cards = await this.getAllCards();
    return cards.find(c =>
      c.set === set &&
      c.number === number &&
      c.variantType === (variantType || 'Normal')
    ) || null;
  },

  async getCount() {
    const store = this._getStore('readonly');
    return this._request(store.count());
  },

  async clearAll() {
    const store = this._getStore('readwrite');
    await this._request(store.clear());
  },

  async bulkImport(cards) {
    let added = 0;
    let skipped = 0;

    const existingCards = await this.getAllCards();

    const tx = this._db.transaction(this.STORE_NAME, 'readwrite');
    const store = tx.objectStore(this.STORE_NAME);

    for (const card of cards) {
      const isDupe = existingCards.some(c =>
        c.set === card.set &&
        c.number === card.number &&
        c.variantType === (card.variantType || 'Normal')
      );

      if (isDupe) {
        skipped++;
        continue;
      }

      const record = {
        ...card,
        id: crypto.randomUUID(),
        dateAdded: card.dateAdded || Date.now(),
        dateModified: Date.now(),
      };
      store.add(record);
      added++;
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve({ added, skipped });
      tx.onerror = () => reject(tx.error);
    });
  },

  // ==========================================
  // Card Hash Cache (for image recognition)
  // ==========================================

  async getHashCount() {
    const store = this._getStore('readonly', this.HASH_STORE);
    return this._request(store.count());
  },

  async getAllHashes() {
    const store = this._getStore('readonly', this.HASH_STORE);
    return this._request(store.getAll());
  },

  async putHash(key, data) {
    const store = this._getStore('readwrite', this.HASH_STORE);
    await this._request(store.put({ key, ...data }));
  },

  async putHashesBulk(entries) {
    const tx = this._db.transaction(this.HASH_STORE, 'readwrite');
    const store = tx.objectStore(this.HASH_STORE);

    for (const entry of entries) {
      store.put(entry);
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async clearHashes() {
    const store = this._getStore('readwrite', this.HASH_STORE);
    await this._request(store.clear());
  },

  // ==========================================
  // Card Catalog Cache (full card data for local search)
  // ==========================================

  async getCatalogCount() {
    const store = this._getStore('readonly', this.CATALOG_STORE);
    return this._request(store.count());
  },

  async getAllCatalog() {
    const store = this._getStore('readonly', this.CATALOG_STORE);
    return this._request(store.getAll());
  },

  async putCatalogBulk(cards) {
    const tx = this._db.transaction(this.CATALOG_STORE, 'readwrite');
    const store = tx.objectStore(this.CATALOG_STORE);

    for (const card of cards) {
      // key = SET-NUMBER for uniqueness
      store.put({ ...card, key: `${card.Set}-${card.Number}` });
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async clearCatalog() {
    const store = this._getStore('readwrite', this.CATALOG_STORE);
    await this._request(store.clear());
  },

  async getCatalogMeta() {
    // Store a simple metadata record to track when the catalog was last updated
    try {
      const store = this._getStore('readonly', this.CATALOG_STORE);
      return this._request(store.get('__meta__'));
    } catch { return null; }
  },

  async putCatalogMeta(meta) {
    const store = this._getStore('readwrite', this.CATALOG_STORE);
    await this._request(store.put({ ...meta, key: '__meta__' }));
  },

  // ==========================================
  // Orders CRUD
  // ==========================================

  async addOrder(orderData) {
    const store = this._getStore('readwrite', this.ORDERS_STORE);
    const record = {
      ...orderData,
      id: crypto.randomUUID(),
      date: orderData.date || Date.now(),
    };
    await this._request(store.add(record));
    return record.id;
  },

  async getOrder(id) {
    const store = this._getStore('readonly', this.ORDERS_STORE);
    return this._request(store.get(id));
  },

  async getAllOrders() {
    const store = this._getStore('readonly', this.ORDERS_STORE);
    const orders = await this._request(store.getAll());
    orders.sort((a, b) => b.date - a.date);
    return orders;
  },

  async deleteOrder(id) {
    const store = this._getStore('readwrite', this.ORDERS_STORE);
    await this._request(store.delete(id));
  },

  async clearOrders() {
    const store = this._getStore('readwrite', this.ORDERS_STORE);
    await this._request(store.clear());
  },
};
