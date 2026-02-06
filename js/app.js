// ============================================
// SWU Card Scanner — Main App Controller (app.js)
// ============================================

window.SWU = window.SWU || {};

SWU.App = {
  currentTab: 'scan',
  scanMode: 'single',
  collectionViewMode: 'grid',
  _allCards: [],
  _selectedApiCard: null,
  _capturedImageUrl: null,
  _editingCardId: null,
  _searchDebounce: null,
  _binderCancelled: false,
  _sessionAddCount: 0,
  _quickAddEnabled: true,
  _autoScanEnabled: false,
  _autoScanProcessing: false,
  _lastAutoScanResult: null,

  // ==========================================
  // Initialization
  // ==========================================

  async init() {
    try {
      await SWU.DB.init();
    } catch (err) {
      this.showToast('Storage unavailable. Cards cannot be saved between sessions.', 'error');
      console.error('DB init failed:', err);
    }

    this.setupTabs();
    this.setupScanTab();
    this.setupCollectionTab();
    this.setupExportTab();
    this.setupOrdersTab();
    this.setupDialogs();
    this.switchTab('scan');

    // Load card catalog in background (downloads ~5 MB on first run, instant after)
    this._initCatalog();
  },

  async _initCatalog() {
    const statusEl = document.getElementById('catalog-status');
    const textEl = document.getElementById('catalog-status-text');

    try {
      const count = await SWU.DB.getCatalogCount();
      if (count < 100) {
        // First time — show loading UI
        if (statusEl) statusEl.hidden = false;
      }

      await SWU.API.initCatalog((status, pct) => {
        if (textEl) textEl.textContent = `${status} ${pct}%`;
      });

      if (statusEl) statusEl.hidden = true;
    } catch (err) {
      if (statusEl) statusEl.hidden = true;
      console.error('Catalog init failed:', err);
      // Search will fall back to network API
    }
  },

  // ==========================================
  // Tab Navigation
  // ==========================================

  setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.switchTab(btn.dataset.tab);
      });
    });
  },

  switchTab(tabName) {
    this.currentTab = tabName;

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === 'tab-' + tabName);
    });

    if (tabName === 'collection') {
      this.refreshCollection();
    }

    if (tabName === 'orders') {
      SWU.Orders.refreshHistory();
    }
  },

  // ==========================================
  // Scan Tab Setup
  // ==========================================

  setupScanTab() {
    // Mode toggle
    document.getElementById('mode-single').addEventListener('click', () => this.setScanMode('single'));
    document.getElementById('mode-binder').addEventListener('click', () => this.setScanMode('binder'));

    // Camera buttons
    document.getElementById('btn-start-camera').addEventListener('click', () => this.startCamera());
    document.getElementById('btn-stop-camera').addEventListener('click', () => this.stopCamera());
    document.getElementById('btn-capture').addEventListener('click', () => this.captureAndProcess());
    document.getElementById('btn-flip-camera').addEventListener('click', () => this.flipCamera());
    document.getElementById('btn-auto-scan').addEventListener('click', () => this.toggleAutoScan());

    // Manual search — instant as-you-type
    const searchInput = document.getElementById('search-input');
    document.getElementById('btn-search').addEventListener('click', () => {
      this.handleManualSearch(searchInput.value);
    });

    searchInput.addEventListener('input', () => {
      clearTimeout(this._searchDebounce);
      const query = searchInput.value.trim();
      if (query.length < 2) {
        document.getElementById('search-results').innerHTML = '';
        return;
      }
      // Debounce: wait 250ms after typing stops
      this._searchDebounce = setTimeout(() => {
        this.handleManualSearch(query);
      }, 250);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(this._searchDebounce);
        this.handleManualSearch(searchInput.value);
      }
    });

    // Quick-add toggle
    const quickAddChk = document.getElementById('chk-quick-add');
    quickAddChk.checked = true;
    this._quickAddEnabled = true;
    document.getElementById('quick-add-banner').hidden = false;

    quickAddChk.addEventListener('change', () => {
      this._quickAddEnabled = quickAddChk.checked;
      document.getElementById('quick-add-banner').hidden = !quickAddChk.checked;
    });

    document.getElementById('btn-reset-session').addEventListener('click', () => {
      this._sessionAddCount = 0;
      document.getElementById('session-add-count').textContent = '0';
    });

    // Check camera availability
    if (!SWU.Camera.isAvailable()) {
      document.getElementById('btn-start-camera').disabled = true;
      this.showCameraError('Camera is not available. Use a local web server (localhost) or HTTPS for camera access. Manual search works on any connection.');
    }

    // Set initial overlay mode
    this.setScanMode('single');
  },

  setScanMode(mode) {
    this.scanMode = mode;
    document.getElementById('mode-single').classList.toggle('active', mode === 'single');
    document.getElementById('mode-binder').classList.toggle('active', mode === 'binder');

    const overlay = document.getElementById('camera-overlay');
    overlay.className = '';
    overlay.innerHTML = '';

    if (mode === 'single') {
      overlay.classList.add('single-mode');
    } else {
      overlay.classList.add('binder-mode');
      for (let i = 0; i < 9; i++) {
        const cell = document.createElement('div');
        cell.className = 'binder-cell';
        overlay.appendChild(cell);
      }
    }
  },

  async startCamera() {
    const videoEl = document.getElementById('camera-preview');
    const canvasEl = document.getElementById('capture-canvas');

    try {
      this.hideCameraError();
      await SWU.Camera.start(videoEl, canvasEl);
      document.getElementById('camera-container').hidden = false;
      document.getElementById('capture-controls').hidden = false;
      document.getElementById('btn-start-camera').hidden = true;
      document.getElementById('btn-stop-camera').hidden = false;
    } catch (err) {
      this.showCameraError(err.message);
    }
  },

  stopCamera() {
    this.stopAutoScan();
    SWU.Camera.stop();
    document.getElementById('camera-container').hidden = true;
    document.getElementById('capture-controls').hidden = true;
    document.getElementById('btn-start-camera').hidden = false;
    document.getElementById('btn-stop-camera').hidden = true;
  },

  toggleAutoScan() {
    if (this._autoScanEnabled) {
      this.stopAutoScan();
    } else {
      this.startAutoScan();
    }
  },

  async startAutoScan() {
    // Load hash database before starting
    try {
      this.showScanStatus('Loading card database...');
      await SWU.OCR.init((status, pct) => {
        this.showScanStatus(`${status} ${pct}%`);
      });
      this.hideScanStatus();
    } catch (err) {
      this.hideScanStatus();
      this.showToast('Failed to load card database: ' + err.message, 'error');
      return;
    }

    this._autoScanEnabled = true;
    this._lastAutoScanResult = null;

    const btn = document.getElementById('btn-auto-scan');
    btn.textContent = 'Stop Auto-Scan';
    btn.classList.add('active');
    document.getElementById('auto-scan-indicator').hidden = false;

    this._autoScanHandler = async (imageDataUrl) => {
      if (this._autoScanProcessing) return;
      this._autoScanProcessing = true;

      try {
        document.getElementById('auto-scan-indicator-text').textContent = 'Scanning...';
        const result = await SWU.OCR.processCardImage(imageDataUrl);

        if (result.method === 'none') {
          document.getElementById('auto-scan-indicator-text').textContent = 'Watching for card...';
          return;
        }

        const resultKey = `${result.set}-${result.number}`;

        if (resultKey === this._lastAutoScanResult) {
          document.getElementById('auto-scan-indicator-text').textContent = 'Watching for new card...';
          return;
        }

        // Pause auto-scan and look up full card data
        SWU.Camera.stopAutoScan();
        document.getElementById('auto-scan-indicator-text').textContent = `Matched! (${result.confidence}%)`;

        let matchedCard = null;
        try {
          const card = await SWU.API.getCard(result.set, result.number);
          if (card && card.Name) matchedCard = card;
          else if (card && card.data) matchedCard = Array.isArray(card.data) ? card.data[0] : card;
        } catch { /* fall through */ }

        if (matchedCard) {
          this._lastAutoScanResult = resultKey;
          document.getElementById('auto-scan-indicator-text').textContent = 'Card found!';
          await this.showCardConfirmation(result, matchedCard, [], imageDataUrl);
        } else {
          document.getElementById('auto-scan-indicator-text').textContent = 'API lookup failed — retrying...';
        }

        // Resume auto-scan
        if (this._autoScanEnabled) {
          SWU.Camera.startAutoScan(this._autoScanHandler, 1500);
        }
      } catch (err) {
        console.warn('Auto-scan error:', err);
        document.getElementById('auto-scan-indicator-text').textContent = 'Watching for card...';
        if (this._autoScanEnabled) {
          SWU.Camera.startAutoScan(this._autoScanHandler, 1500);
        }
      } finally {
        this._autoScanProcessing = false;
      }
    };

    SWU.Camera.startAutoScan(this._autoScanHandler, 1500);
  },

  stopAutoScan() {
    this._autoScanEnabled = false;
    this._autoScanProcessing = false;
    SWU.Camera.stopAutoScan();

    const btn = document.getElementById('btn-auto-scan');
    btn.textContent = 'Auto-Scan';
    btn.classList.remove('active');
    document.getElementById('auto-scan-indicator').hidden = true;
  },

  async flipCamera() {
    try {
      await SWU.Camera.flipCamera();
    } catch (err) {
      this.showToast('Failed to flip camera: ' + err.message, 'error');
    }
  },

  showCameraError(message) {
    const el = document.getElementById('camera-error');
    document.getElementById('camera-error-text').textContent = message;
    el.hidden = false;
  },

  hideCameraError() {
    document.getElementById('camera-error').hidden = true;
  },

  // ==========================================
  // Capture & Process
  // ==========================================

  async captureAndProcess() {
    // Pause auto-scan while doing manual capture
    const wasAutoScanning = this._autoScanEnabled;
    if (wasAutoScanning) {
      SWU.Camera.stopAutoScan();
    }

    try {
      const imageDataUrl = SWU.Camera.captureFrame();
      this._capturedImageUrl = imageDataUrl;

      if (this.scanMode === 'single') {
        await this.processSingleCard(imageDataUrl);
      } else {
        await this.processBinderPage(imageDataUrl);
      }
    } catch (err) {
      this.showToast('Capture failed: ' + err.message, 'error');
    }

    // Resume auto-scan if it was active
    if (wasAutoScanning && this._autoScanEnabled && this._autoScanHandler) {
      SWU.Camera.startAutoScan(this._autoScanHandler, 3000);
    }
  },

  async processSingleCard(imageDataUrl) {
    this.showScanStatus('Loading card database...');

    try {
      await SWU.OCR.init((status, pct) => {
        this.showScanStatus(`${status} ${pct}%`);
      });
    } catch (err) {
      this.hideScanStatus();
      this.showToast('Failed to load card database. Use Manual Search.', 'error');
      this.prefillManualSearch('');
      return;
    }

    this.showScanStatus('Matching card...');

    let result;
    try {
      result = await SWU.OCR.processCardImage(imageDataUrl);
    } catch (err) {
      this.hideScanStatus();
      this.showToast('Recognition failed. Try adjusting position or use Manual Search.', 'error');
      this.prefillManualSearch('');
      return;
    }

    if (result.method === 'none') {
      this.hideScanStatus();
      this.showToast('Could not match card. Center the card in the guide and try again, or use Manual Search.', 'info');
      this.prefillManualSearch('');
      return;
    }

    // Look up full card data from API
    this.showScanStatus(`Matched! (${result.confidence}%) Looking up details...`);

    let matchedCard = null;
    try {
      const card = await SWU.API.getCard(result.set, result.number);
      if (card && card.Name) {
        matchedCard = card;
      } else if (card && card.data) {
        matchedCard = Array.isArray(card.data) ? card.data[0] : card;
      }
    } catch { /* fall through */ }

    this.hideScanStatus();

    if (!matchedCard) {
      this.showToast('Card matched but API lookup failed. Try Manual Search.', 'info');
      this.prefillManualSearch(result.name || '');
      return;
    }

    await this.showCardConfirmation(result, matchedCard, [], imageDataUrl);
  },

  async processBinderPage(imageDataUrl) {
    const dialog = document.getElementById('binder-progress-dialog');
    const resultsEl = document.getElementById('binder-results');
    const progressFill = document.getElementById('binder-progress-fill');
    const currentEl = document.getElementById('binder-current');
    const doneBtn = document.getElementById('btn-binder-done');
    const cancelBtn = document.getElementById('btn-binder-cancel');

    resultsEl.innerHTML = '';
    progressFill.style.width = '0%';
    doneBtn.hidden = true;
    cancelBtn.hidden = false;
    this._binderCancelled = false;

    dialog.showModal();

    // Initialize hash database
    try {
      await SWU.OCR.init((status, pct) => {
        resultsEl.innerHTML = `<p style="text-align:center;color:var(--text-secondary)">${status} ${pct}%</p>`;
      });
      resultsEl.innerHTML = '';
    } catch {
      this.showToast('Card database failed to load.', 'error');
      dialog.close();
      return;
    }

    // Split binder page into 9 cards
    let cardImages;
    try {
      cardImages = await SWU.Camera.splitBinderPage(imageDataUrl);
    } catch (err) {
      this.showToast('Failed to split binder page: ' + err.message, 'error');
      dialog.close();
      return;
    }

    const total = cardImages.length;
    document.getElementById('binder-total').textContent = total;

    const foundCards = [];

    for (let i = 0; i < total; i++) {
      if (this._binderCancelled) break;

      currentEl.textContent = i + 1;
      progressFill.style.width = ((i + 1) / total * 100) + '%';

      let statusClass = 'empty';
      let statusText = 'Empty';
      let cardName = '(empty slot)';

      try {
        const hashResult = await SWU.OCR.processCardImage(cardImages[i], { fullCard: true });

        if (hashResult.method !== 'none' && hashResult.set && hashResult.number) {
          // Got a hash match — look up full card data from API
          let apiCard = null;
          try {
            const cardData = await SWU.API.getCard(hashResult.set, hashResult.number);
            if (cardData && cardData.Name) apiCard = cardData;
            else if (cardData && cardData.data) apiCard = Array.isArray(cardData.data) ? cardData.data[0] : cardData;
          } catch { /* API lookup failed */ }

          if (apiCard) {
            cardName = apiCard.Name + (apiCard.Subtitle ? ' - ' + apiCard.Subtitle : '');
            statusClass = 'found';
            statusText = `$${apiCard.MarketPrice || '0.00'} (${hashResult.confidence}%)`;

            const mapped = SWU.API.mapCardData(apiCard);
            const thumbnail = await SWU.Camera.resizeImage(cardImages[i], 400);
            foundCards.push({ ...mapped, scannedImage: thumbnail, _apiCard: apiCard });
          } else {
            // Hash matched but API failed
            cardName = hashResult.name || '(unknown)';
            statusClass = 'error';
            statusText = 'API error';
          }
        }
      } catch {
        statusClass = 'error';
        statusText = 'Error';
      }

      // Add result row
      const row = document.createElement('div');
      row.className = 'binder-result-item';
      row.innerHTML = `
        <span class="slot-num">${i + 1}</span>
        <span class="slot-name">${this._escapeHtml(cardName)}</span>
        <span class="slot-status ${statusClass}">${statusText}</span>
      `;
      resultsEl.appendChild(row);
    }

    cancelBtn.hidden = true;
    doneBtn.hidden = false;

    // Add all found cards on done
    doneBtn.onclick = async () => {
      let added = 0;
      for (const card of foundCards) {
        const { _apiCard, ...cardData } = card;
        try {
          const existing = await SWU.DB.findDuplicate(cardData.set, cardData.number, cardData.variantType);
          if (existing) {
            await SWU.DB.updateCard(existing.id, { quantity: (existing.quantity || 1) + 1 });
          } else {
            await SWU.DB.addCard(cardData);
          }
          added++;
        } catch (err) {
          console.error('Failed to add card:', err);
        }
      }
      dialog.close();
      this.showToast(`Added ${added} card(s) from binder page!`, 'success');
    };

    cancelBtn.onclick = () => {
      this._binderCancelled = true;
    };
  },

  showScanStatus(text) {
    const el = document.getElementById('scan-status');
    document.getElementById('scan-status-text').textContent = text;
    el.hidden = false;
  },

  hideScanStatus() {
    document.getElementById('scan-status').hidden = true;
  },

  prefillManualSearch(text) {
    const input = document.getElementById('search-input');
    input.value = text;
    input.focus();
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  // ==========================================
  // Manual Search
  // ==========================================

  async handleManualSearch(query) {
    if (!query || query.trim().length < 2) {
      return;
    }

    const trimmed = query.trim();
    const resultsEl = document.getElementById('search-results');

    // Show spinner only if catalog isn't ready (local search is instant)
    if (!SWU.API._catalogReady) {
      resultsEl.innerHTML = '<div class="spinner" style="margin:20px auto"></div>';
    }

    try {
      // searchCards now uses local catalog if available (instant), falls back to network
      const result = await SWU.API.searchCards(trimmed);

      // If input changed while we were fetching, discard stale results
      if (document.getElementById('search-input').value.trim() !== trimmed) return;

      if (result.total_cards === 0) {
        resultsEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px">No cards found. Try a different search term.</p>';
        return;
      }

      this.renderSearchResults(result.data);
    } catch (err) {
      resultsEl.innerHTML = '';
      this.showToast(err.message, 'error');
    }
  },

  renderSearchResults(cards) {
    const resultsEl = document.getElementById('search-results');
    resultsEl.innerHTML = '';

    // Group cards by Name+Subtitle so all variants appear together
    const groups = new Map();
    for (const card of cards) {
      const key = (card.Name || '') + '||' + (card.Subtitle || '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(card);
    }

    // Sort variants within each group: Normal first, then by type
    const variantOrder = {
      'Normal': 0, 'Foil': 1, 'Hyperspace': 2, 'Hyperspace Foil': 3,
      'Showcase': 4, 'Showcase Foil': 5, 'Prerelease Promo': 6,
      'Event Exclusive': 7, 'Convention Exclusive': 8, 'OP Promo': 9,
      'OP Promo Foil': 10, 'SQ Prize Wall': 11, 'SQ Event Pack': 12,
      'RQ Prize Wall': 13, 'Judge': 14, 'Championship': 15,
    };
    for (const [, versions] of groups) {
      versions.sort((a, b) => {
        const oa = variantOrder[a.VariantType] ?? 20;
        const ob = variantOrder[b.VariantType] ?? 20;
        if (oa !== ob) return oa - ob;
        return (a.Set + a.Number).localeCompare(b.Set + b.Number);
      });
    }

    for (const [, versions] of groups) {
      const primary = versions[0];

      // Find the best fallback image (Normal variant's art) for cards with missing images
      const fallbackArt = (versions.find(v => v.FrontArt && v.VariantType === 'Normal') || versions.find(v => v.FrontArt) || {}).FrontArt || '';

      // Card group header
      const groupDiv = document.createElement('div');
      groupDiv.className = 'search-result-group';

      const headerDiv = document.createElement('div');
      headerDiv.className = 'search-group-header';
      headerDiv.innerHTML = `
        <div class="card-name">${this._escapeHtml(primary.Name)}</div>
        ${primary.Subtitle ? `<div class="card-subtitle">${this._escapeHtml(primary.Subtitle)}</div>` : ''}
        <div class="card-versions-count">${versions.length} version${versions.length !== 1 ? 's' : ''}</div>
      `;
      groupDiv.appendChild(headerDiv);

      // All versions in a row
      const versionsDiv = document.createElement('div');
      versionsDiv.className = 'search-versions-row';

      for (const card of versions) {
        const div = document.createElement('div');
        div.className = 'search-result-card';
        const variant = card.VariantType && card.VariantType !== 'Normal' ? card.VariantType : '';
        const artUrl = card.FrontArt || fallbackArt;
        const price = parseFloat(card.MarketPrice) || 0;
        const isPromo = variant && variant !== 'Foil';
        const priceUnreliable = isPromo && (price <= 1.00);
        const tcgUrl = this._tcgPlayerUrl(card);
        const priceDisplay = priceUnreliable
          ? `<a href="${tcgUrl}" target="_blank" class="price-tcg-link" title="Check real price on TCGPlayer" onclick="event.stopPropagation()">Check Price ↗</a>`
          : `$${card.MarketPrice || '0.00'}`;
        div.innerHTML = `
          <img src="${artUrl}" alt="${this._escapeHtml(card.Name)}" loading="lazy" onerror="this.style.display='none'">
          <div class="card-set">${card.Set} #${card.Number}</div>
          <div class="card-variant">${variant || 'Normal'} | ${card.Rarity || ''}</div>
          <div class="card-price">${priceDisplay}</div>
        `;

        div.addEventListener('click', () => {
          if (this._quickAddEnabled) {
            this.quickAddCard(card, div);
          } else {
            this.showCardConfirmation({ ocrText: '(manual search)', candidates: [] }, card, [], null);
          }
        });

        versionsDiv.appendChild(div);
      }

      groupDiv.appendChild(versionsDiv);
      resultsEl.appendChild(groupDiv);
    }
  },

  /**
   * Quick-add: instantly add a card to collection with one click.
   * Shows brief flash feedback, increments counter, refocuses search.
   */
  async quickAddCard(apiCard, clickedEl) {
    const mapped = SWU.API.mapCardData(apiCard);

    try {
      // Check for duplicate — increment quantity
      const existing = await SWU.DB.findDuplicate(mapped.set, mapped.number, mapped.variantType);

      if (existing) {
        await SWU.DB.updateCard(existing.id, { quantity: (existing.quantity || 1) + 1 });
      } else {
        await SWU.DB.addCard({ ...mapped, quantity: 1 });
      }

      // Visual feedback on the clicked card
      clickedEl.classList.add('quick-added');
      setTimeout(() => clickedEl.classList.remove('quick-added'), 600);

      // Update session counter
      this._sessionAddCount++;
      document.getElementById('session-add-count').textContent = this._sessionAddCount;

      // Brief toast
      const qty = existing ? (existing.quantity || 1) + 1 : 1;
      const label = existing ? `${mapped.name} (x${qty})` : mapped.name;
      this.showToast(`+ ${label}`, 'success');

      // Refocus search, select all text for quick next entry
      const input = document.getElementById('search-input');
      input.focus();
      input.select();

    } catch (err) {
      this.showToast('Failed to add: ' + err.message, 'error');
    }
  },

  // ==========================================
  // Card Confirmation Dialog
  // ==========================================

  setupDialogs() {
    // Confirmation dialog
    document.getElementById('btn-confirm-add').addEventListener('click', () => this.confirmAddCard());
    document.getElementById('btn-confirm-skip').addEventListener('click', () => {
      document.getElementById('card-confirm-dialog').close();
    });
    document.getElementById('btn-confirm-retry').addEventListener('click', () => {
      document.getElementById('card-confirm-dialog').close();
      const ocrText = document.getElementById('dialog-ocr-text').textContent;
      this.prefillManualSearch(ocrText);
    });

    // Edit dialog
    document.getElementById('btn-edit-save').addEventListener('click', () => this.saveEditCard());
    document.getElementById('btn-edit-delete').addEventListener('click', () => this.deleteEditCard());
    document.getElementById('btn-edit-cancel').addEventListener('click', () => {
      document.getElementById('card-edit-dialog').close();
    });

    // Binder cancel
    document.getElementById('btn-binder-cancel').addEventListener('click', () => {
      this._binderCancelled = true;
      document.getElementById('binder-progress-dialog').close();
    });

    // Close dialogs on backdrop click
    for (const dialog of document.querySelectorAll('dialog')) {
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) dialog.close();
      });
    }
  },

  async showCardConfirmation(ocrResult, apiCard, alternatives, imageDataUrl) {
    this._selectedApiCard = apiCard;
    this._capturedImageUrl = imageDataUrl;

    const dialog = document.getElementById('card-confirm-dialog');

    // Fill dialog fields
    document.getElementById('dialog-card-image').src = apiCard.FrontArt || '';
    document.getElementById('dialog-ocr-text').textContent = ocrResult.ocrText || '';
    document.getElementById('dialog-matched-name').textContent = apiCard.Name || '';
    document.getElementById('dialog-subtitle').textContent = apiCard.Subtitle || '';
    document.getElementById('dialog-set').textContent = apiCard.Set || '';
    document.getElementById('dialog-number').textContent = apiCard.Number || '';
    document.getElementById('dialog-rarity').textContent = apiCard.Rarity || '';
    document.getElementById('dialog-type').textContent = apiCard.Type || '';
    document.getElementById('dialog-variant').textContent = apiCard.VariantType || 'Normal';
    document.getElementById('dialog-price').textContent = apiCard.MarketPrice || '0.00';

    // Reset variants section — show loading right away
    const sectionEl = document.getElementById('dialog-variants-section');
    const loadingEl = document.getElementById('dialog-variants-loading');
    const listEl = document.getElementById('dialog-variants-list');
    sectionEl.hidden = true;
    loadingEl.hidden = false;
    listEl.innerHTML = '';

    // Reset inputs
    document.getElementById('dialog-quantity').value = 1;
    document.getElementById('dialog-custom-price').value = '';
    document.getElementById('dialog-notes').value = '';

    // Check for duplicate
    const dupe = await SWU.DB.findDuplicate(apiCard.Set, apiCard.Number, apiCard.VariantType || 'Normal');
    const dupeNotice = document.getElementById('dialog-duplicate-notice');
    if (dupe) {
      dupeNotice.textContent = `Already in collection (qty: ${dupe.quantity || 1}). Adding will increase quantity.`;
      dupeNotice.hidden = false;
    } else {
      dupeNotice.hidden = true;
    }

    // Alternatives (from search results with different names)
    const altSection = document.getElementById('dialog-alternatives');
    const altList = document.getElementById('dialog-alt-list');
    altList.innerHTML = '';

    if (alternatives && alternatives.length > 0) {
      altSection.hidden = false;
      for (const alt of alternatives) {
        const altDiv = document.createElement('div');
        altDiv.className = 'alt-card';
        altDiv.innerHTML = `
          <img src="${alt.FrontArt || ''}" alt="${this._escapeHtml(alt.Name)}" loading="lazy">
          <div class="alt-name">${this._escapeHtml(alt.Name)}<br><small>${alt.Set} #${alt.Number}</small></div>
        `;
        altDiv.addEventListener('click', () => {
          this._selectedApiCard = alt;
          this.showCardConfirmation(ocrResult, alt, alternatives.filter(a => a !== alt), imageDataUrl);
        });
        altList.appendChild(altDiv);
      }
    } else {
      altSection.hidden = true;
    }

    dialog.showModal();

    // Auto-load all variants in background (single API call)
    this._loadVariantsForCard(apiCard);
  },

  async _loadVariantsForCard(apiCard) {
    const sectionEl = document.getElementById('dialog-variants-section');
    const loadingEl = document.getElementById('dialog-variants-loading');
    const listEl = document.getElementById('dialog-variants-list');

    try {
      const variants = await SWU.API.getAllVariants(apiCard.Name, apiCard.Subtitle);
      loadingEl.hidden = true;

      if (variants.length <= 1) {
        sectionEl.hidden = true;
        return;
      }

      document.getElementById('dialog-variants-count').textContent = `(${variants.length} versions)`;
      listEl.innerHTML = '';

      // Find best fallback art for variants with no image
      const fallbackArt = (variants.find(v => v.FrontArt && v.VariantType === 'Normal') || variants.find(v => v.FrontArt) || {}).FrontArt || '';

      for (const v of variants) {
        const vDiv = document.createElement('div');
        const isSelected = v.Set === apiCard.Set && v.Number === apiCard.Number;
        const artUrl = v.FrontArt || fallbackArt;
        vDiv.className = `variant-card${isSelected ? ' selected' : ''}`;
        vDiv.innerHTML = `
          <img src="${artUrl}" alt="${this._escapeHtml(v.Name)}" loading="lazy" onerror="this.style.display='none'">
          <div class="variant-type">${this._escapeHtml(v.VariantType || 'Normal')}</div>
          <div class="variant-set">${v.Set} #${v.Number}</div>
          <div class="variant-price">$${v.MarketPrice || '0.00'}</div>
        `;
        vDiv.addEventListener('click', () => {
          // Switch to this variant
          this._selectedApiCard = v;
          document.getElementById('dialog-card-image').src = v.FrontArt || fallbackArt;
          document.getElementById('dialog-matched-name').textContent = v.Name || '';
          document.getElementById('dialog-subtitle').textContent = v.Subtitle || '';
          document.getElementById('dialog-set').textContent = v.Set || '';
          document.getElementById('dialog-number').textContent = v.Number || '';
          document.getElementById('dialog-variant').textContent = v.VariantType || 'Normal';
          document.getElementById('dialog-rarity').textContent = v.Rarity || '';
          document.getElementById('dialog-price').textContent = v.MarketPrice || '0.00';

          // Update selected state
          listEl.querySelectorAll('.variant-card').forEach(c => c.classList.remove('selected'));
          vDiv.classList.add('selected');
        });
        listEl.appendChild(vDiv);
      }

      sectionEl.hidden = false;
    } catch {
      loadingEl.hidden = true;
      sectionEl.hidden = true;
    }
  },

  async confirmAddCard() {
    const card = this._selectedApiCard;
    if (!card) return;

    const quantity = parseInt(document.getElementById('dialog-quantity').value) || 1;
    const customPriceVal = document.getElementById('dialog-custom-price').value;
    const customPrice = customPriceVal !== '' ? parseFloat(customPriceVal) : null;
    const notes = document.getElementById('dialog-notes').value.trim();

    const mapped = SWU.API.mapCardData(card);

    // Resize scanned image for storage
    let thumbnail = null;
    if (this._capturedImageUrl) {
      try {
        thumbnail = await SWU.Camera.resizeImage(this._capturedImageUrl, 400);
      } catch {
        thumbnail = null;
      }
    }

    // Check for duplicate — increment quantity if exists
    const existing = await SWU.DB.findDuplicate(mapped.set, mapped.number, mapped.variantType);

    try {
      if (existing) {
        await SWU.DB.updateCard(existing.id, {
          quantity: (existing.quantity || 1) + quantity,
          customPrice: customPrice ?? existing.customPrice,
          notes: notes || existing.notes,
        });
        this.showToast(`${mapped.name} quantity updated!`, 'success');
      } else {
        await SWU.DB.addCard({
          ...mapped,
          quantity,
          customPrice,
          notes,
          scannedImage: thumbnail,
        });
        this.showToast(`${mapped.name} added to collection!`, 'success');
      }
    } catch (err) {
      this.showToast('Failed to save card: ' + err.message, 'error');
    }

    document.getElementById('card-confirm-dialog').close();
  },

  // ==========================================
  // Collection Tab
  // ==========================================

  _priceCheckFilter: false,

  setupCollectionTab() {
    document.getElementById('view-grid').addEventListener('click', () => {
      this.collectionViewMode = 'grid';
      document.getElementById('view-grid').classList.add('active');
      document.getElementById('view-list').classList.remove('active');
      this.refreshCollection();
    });

    document.getElementById('view-list').addEventListener('click', () => {
      this.collectionViewMode = 'list';
      document.getElementById('view-list').classList.add('active');
      document.getElementById('view-grid').classList.remove('active');
      this.refreshCollection();
    });

    document.getElementById('collection-filter').addEventListener('input', () => {
      this.refreshCollection();
    });

    document.getElementById('collection-sort').addEventListener('change', () => {
      this.refreshCollection();
    });

    document.getElementById('btn-needs-price').addEventListener('click', () => {
      this._priceCheckFilter = !this._priceCheckFilter;
      document.getElementById('btn-needs-price').classList.toggle('active', this._priceCheckFilter);
      this.refreshCollection();
    });
  },

  /**
   * Check if a card has an unreliable promo price.
   */
  _needsPriceCheck(card) {
    const variant = card.variantType && card.variantType !== 'Normal' ? card.variantType : '';
    const isPromo = variant && variant !== 'Foil';
    const price = card.customPrice != null ? card.customPrice : parseFloat(card.marketPrice) || 0;
    return isPromo && price <= 1.00 && card.customPrice == null;
  },

  async refreshCollection() {
    let cards = await SWU.DB.getAllCards();
    this._allCards = cards;

    // Filter
    // Update "Needs Price Check" badge count
    const priceCheckCards = cards.filter(c => this._needsPriceCheck(c));
    document.getElementById('price-check-count').textContent = priceCheckCards.length;

    // Apply price check filter
    if (this._priceCheckFilter) {
      cards = priceCheckCards;
    }

    // Text filter
    const filterText = document.getElementById('collection-filter').value.trim().toLowerCase();
    if (filterText) {
      cards = cards.filter(c =>
        c.name.toLowerCase().includes(filterText) ||
        (c.subtitle && c.subtitle.toLowerCase().includes(filterText)) ||
        c.set.toLowerCase().includes(filterText) ||
        c.rarity.toLowerCase().includes(filterText) ||
        c.type.toLowerCase().includes(filterText)
      );
    }

    // Sort
    const sortVal = document.getElementById('collection-sort').value;
    const [sortKey, sortDir] = sortVal.split('-');
    cards = this.sortCards(cards, sortKey, sortDir);

    // Show/hide empty state
    document.getElementById('collection-empty').hidden = cards.length > 0 || filterText.length > 0 || this._priceCheckFilter;

    // Update stats
    this.updateCollectionStats(this._allCards);

    // Render appropriate view
    if (this.collectionViewMode === 'grid') {
      document.getElementById('collection-grid').classList.add('active');
      document.getElementById('collection-table-wrap').classList.remove('active');
      document.getElementById('collection-table-wrap').hidden = true;
      this.renderCollectionGrid(cards);
    } else {
      document.getElementById('collection-grid').classList.remove('active');
      document.getElementById('collection-table-wrap').classList.add('active');
      document.getElementById('collection-table-wrap').hidden = false;
      this.renderCollectionTable(cards);
    }
  },

  sortCards(cards, key, dir) {
    const sorted = [...cards];
    const mult = dir === 'asc' ? 1 : -1;

    sorted.sort((a, b) => {
      let av, bv;

      switch (key) {
        case 'name':
          av = a.name.toLowerCase();
          bv = b.name.toLowerCase();
          return av.localeCompare(bv) * mult;
        case 'price':
          av = a.customPrice != null ? a.customPrice : parseFloat(a.marketPrice) || 0;
          bv = b.customPrice != null ? b.customPrice : parseFloat(b.marketPrice) || 0;
          return (av - bv) * mult;
        case 'dateAdded':
          return (a.dateAdded - b.dateAdded) * mult;
        case 'set':
          av = a.set + a.number;
          bv = b.set + b.number;
          return av.localeCompare(bv) * mult;
        case 'rarity':
          av = this._rarityRank(a.rarity);
          bv = this._rarityRank(b.rarity);
          return (av - bv) * mult;
        default:
          return 0;
      }
    });

    return sorted;
  },

  _rarityRank(rarity) {
    const ranks = { 'Common': 1, 'Uncommon': 2, 'Rare': 3, 'Legendary': 4, 'Special': 5 };
    return ranks[rarity] || 0;
  },

  updateCollectionStats(cards) {
    const totalCount = cards.reduce((sum, c) => sum + (c.quantity || 1), 0);
    const totalValue = cards.reduce((sum, c) => {
      const price = c.customPrice != null ? c.customPrice : parseFloat(c.marketPrice) || 0;
      // Skip unreliable promo prices from collection total
      const variant = c.variantType && c.variantType !== 'Normal' ? c.variantType : '';
      const isPromo = variant && variant !== 'Foil';
      if (isPromo && price <= 1.00 && c.customPrice == null) return sum;
      return sum + price * (c.quantity || 1);
    }, 0);

    document.getElementById('total-cards-count').textContent = `${totalCount} card${totalCount !== 1 ? 's' : ''}`;
    document.getElementById('total-value').textContent = `$${totalValue.toFixed(2)}`;
  },

  renderCollectionGrid(cards) {
    const grid = document.getElementById('collection-grid');
    grid.innerHTML = '';

    for (const card of cards) {
      const tile = document.createElement('div');
      const rarityClass = 'rarity-' + (card.rarity || 'common').toLowerCase();
      tile.className = `card-tile ${rarityClass}`;

      const price = card.customPrice != null ? card.customPrice : parseFloat(card.marketPrice) || 0;

      const variantLabel = card.variantType && card.variantType !== 'Normal' ? card.variantType : '';
      const isPromo = variantLabel && variantLabel !== 'Foil';
      const priceUnreliable = isPromo && price <= 1.00;
      const tcgUrl = this._tcgPlayerUrl({ Name: card.name, VariantType: card.variantType });
      const priceHtml = priceUnreliable
        ? `<a href="${tcgUrl}" target="_blank" class="price-tcg-link" onclick="event.stopPropagation()">Check Price ↗</a>`
        : `$${price.toFixed(2)}`;
      tile.innerHTML = `
        <img class="card-tile-image" src="${card.frontArt || ''}" alt="${this._escapeHtml(card.name)}" loading="lazy">
        ${card.quantity > 1 ? `<div class="card-tile-qty">x${card.quantity}</div>` : ''}
        ${variantLabel ? `<div class="card-tile-variant">${this._escapeHtml(variantLabel)}</div>` : ''}
        <div class="card-tile-info">
          <div class="card-tile-name">${this._escapeHtml(card.name)}</div>
          <div class="card-tile-meta">
            <span>${card.set} #${card.number}</span>
            <span class="card-tile-price">${priceHtml}</span>
          </div>
        </div>
      `;

      tile.addEventListener('click', () => this.showEditDialog(card.id));
      grid.appendChild(tile);
    }
  },

  renderCollectionTable(cards) {
    const tbody = document.getElementById('collection-table-body');
    tbody.innerHTML = '';

    for (const card of cards) {
      const price = card.customPrice != null ? card.customPrice : parseFloat(card.marketPrice) || 0;
      const total = price * (card.quantity || 1);
      const rarityColor = this.getRarityColor(card.rarity);
      const variantLabel = card.variantType && card.variantType !== 'Normal' ? card.variantType : '';
      const isPromo = variantLabel && variantLabel !== 'Foil';
      const promoPriceBad = isPromo && price <= 1.00 && card.customPrice == null;
      const tcgUrl = this._tcgPlayerUrl({ Name: card.name, VariantType: card.variantType });
      const marketPriceHtml = promoPriceBad
        ? `<a href="${tcgUrl}" target="_blank" class="price-tcg-link" onclick="event.stopPropagation()">Check ↗</a>`
        : `$${parseFloat(card.marketPrice || 0).toFixed(2)}`;
      const totalHtml = promoPriceBad ? '-' : `$${total.toFixed(2)}`;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><img class="table-card-img" src="${card.frontArt || ''}" alt="" loading="lazy"></td>
        <td>
          <strong>${this._escapeHtml(card.name)}</strong>
          ${card.subtitle ? `<br><small style="color:var(--text-secondary)">${this._escapeHtml(card.subtitle)}</small>` : ''}
          ${variantLabel ? `<br><small style="color:var(--rarity-special)">${this._escapeHtml(variantLabel)}</small>` : ''}
        </td>
        <td>${card.set}</td>
        <td>${card.number}</td>
        <td><span class="table-rarity" style="background:${rarityColor}"></span>${card.rarity}</td>
        <td>${card.type}</td>
        <td>${card.quantity || 1}</td>
        <td>${marketPriceHtml}</td>
        <td>${card.customPrice != null ? '$' + card.customPrice.toFixed(2) : '-'}</td>
        <td>${totalHtml}</td>
        <td><button class="btn-secondary" style="padding:4px 8px;font-size:0.75rem">Edit</button></td>
      `;

      tr.addEventListener('click', () => this.showEditDialog(card.id));
      tbody.appendChild(tr);
    }
  },

  getRarityColor(rarity) {
    const colors = {
      'Common': 'var(--rarity-common)',
      'Uncommon': 'var(--rarity-uncommon)',
      'Rare': 'var(--rarity-rare)',
      'Legendary': 'var(--rarity-legendary)',
      'Special': 'var(--rarity-special)',
    };
    return colors[rarity] || 'var(--rarity-common)';
  },

  // ==========================================
  // Edit Dialog
  // ==========================================

  async showEditDialog(cardId) {
    const card = await SWU.DB.getCard(cardId);
    if (!card) return;

    this._editingCardId = cardId;

    document.getElementById('edit-card-image').src = card.frontArt || '';
    document.getElementById('edit-card-name').textContent =
      card.name + (card.subtitle ? ' - ' + card.subtitle : '') +
      ` (${card.set} #${card.number})`;
    document.getElementById('edit-quantity').value = card.quantity || 1;
    document.getElementById('edit-custom-price').value = card.customPrice != null ? card.customPrice : '';
    document.getElementById('edit-notes').value = card.notes || '';

    document.getElementById('card-edit-dialog').showModal();
  },

  async saveEditCard() {
    if (!this._editingCardId) return;

    const quantity = parseInt(document.getElementById('edit-quantity').value) || 1;
    const customPriceVal = document.getElementById('edit-custom-price').value;
    const customPrice = customPriceVal !== '' ? parseFloat(customPriceVal) : null;
    const notes = document.getElementById('edit-notes').value.trim();

    try {
      await SWU.DB.updateCard(this._editingCardId, { quantity, customPrice, notes });
      this.showToast('Card updated!', 'success');
      document.getElementById('card-edit-dialog').close();
      this.refreshCollection();
    } catch (err) {
      this.showToast('Failed to update: ' + err.message, 'error');
    }
  },

  async deleteEditCard() {
    if (!this._editingCardId) return;

    if (!confirm('Remove this card from your collection?')) return;

    try {
      await SWU.DB.deleteCard(this._editingCardId);
      this.showToast('Card removed.', 'success');
      document.getElementById('card-edit-dialog').close();
      this.refreshCollection();
    } catch (err) {
      this.showToast('Failed to remove: ' + err.message, 'error');
    }
  },

  // ==========================================
  // Export Tab
  // ==========================================

  _getExportSort() {
    return document.getElementById('export-sort').value;
  },

  setupExportTab() {
    document.getElementById('btn-export-excel').addEventListener('click', async () => {
      try {
        if (window.XLSX) {
          await SWU.Export.exportExcel(this._getExportSort());
          this.showToast('Excel file exported!', 'success');
        } else {
          // Fallback to CSV if SheetJS failed to load
          await SWU.Export.exportCSV(this._getExportSort());
          this.showToast('CSV exported (Excel library unavailable).', 'success');
        }
      } catch (err) {
        this.showToast(err.message, 'error');
      }
    });

    document.getElementById('btn-export-ff').addEventListener('click', async () => {
      try {
        await SWU.Export.exportFriendsFamily(0.75, this._getExportSort());
        this.showToast('Friends & Family Excel exported (75% of market)!', 'success');
      } catch (err) {
        this.showToast(err.message, 'error');
      }
    });

    document.getElementById('btn-export-json').addEventListener('click', async () => {
      try {
        await SWU.Export.exportJSON();
        this.showToast('JSON backup exported!', 'success');
      } catch (err) {
        this.showToast(err.message, 'error');
      }
    });

    document.getElementById('btn-import-json').addEventListener('click', async () => {
      const fileInput = document.getElementById('import-file');
      if (!fileInput.files || fileInput.files.length === 0) {
        this.showToast('Please select a JSON file first.', 'info');
        return;
      }

      try {
        const result = await SWU.Export.importJSON(fileInput.files[0]);
        this.showToast(
          `Import complete! Added: ${result.added}, Skipped: ${result.skipped}` +
          (result.invalid ? `, Invalid: ${result.invalid}` : ''),
          'success'
        );
        fileInput.value = '';
      } catch (err) {
        this.showToast(err.message, 'error');
      }
    });

    // Sync collection to Google Sheet
    document.getElementById('btn-sync-collection-sheet').addEventListener('click', async () => {
      const statusEl = document.getElementById('sync-collection-status');
      const btn = document.getElementById('btn-sync-collection-sheet');

      const discount = parseInt(document.getElementById('sync-discount').value) || 75;
      const sortKey = document.getElementById('sync-sort').value;

      btn.disabled = true;
      statusEl.textContent = 'Syncing...';
      statusEl.style.color = 'var(--text-secondary)';

      try {
        const result = await SWU.Orders.syncCollectionToSheet(discount, sortKey);
        statusEl.textContent = `Synced ${result.synced} cards!`;
        statusEl.style.color = 'var(--accent-green)';
        this.showToast(`Collection synced to Google Sheet! (${result.synced} cards)`, 'success');
      } catch (err) {
        statusEl.textContent = err.message;
        statusEl.style.color = 'var(--accent-red)';
        this.showToast(err.message, 'error');
      }

      btn.disabled = false;
      setTimeout(() => { statusEl.textContent = ''; }, 5000);
    });

    // Toggle sync Apps Script help
    const syncHelpToggle = document.getElementById('btn-toggle-sync-help');
    if (syncHelpToggle) {
      syncHelpToggle.addEventListener('click', () => {
        const helpBlock = document.getElementById('sync-help-block');
        helpBlock.hidden = !helpBlock.hidden;
        syncHelpToggle.textContent = helpBlock.hidden ? 'Show Apps Script Code' : 'Hide Apps Script Code';
      });
    }

    document.getElementById('btn-refresh-prices').addEventListener('click', () => this.refreshPrices());
    document.getElementById('btn-rebuild-hashes').addEventListener('click', () => this.rebuildHashDatabase());

    document.getElementById('btn-clear-collection').addEventListener('click', async () => {
      if (!confirm('Are you sure you want to delete ALL cards from your collection? This cannot be undone.')) return;
      if (!confirm('Really? This will permanently delete everything.')) return;

      try {
        await SWU.DB.clearAll();
        this.showToast('Collection cleared.', 'info');
      } catch (err) {
        this.showToast('Failed to clear: ' + err.message, 'error');
      }
    });
  },

  // ==========================================
  // Orders Tab
  // ==========================================

  setupOrdersTab() {
    if (typeof SWU.Orders !== 'undefined' && SWU.Orders.setup) {
      SWU.Orders.setup();
    }
  },

  async refreshPrices() {
    const statusEl = document.getElementById('price-refresh-status');
    const textEl = document.getElementById('price-refresh-text');
    statusEl.hidden = false;

    const cards = await SWU.DB.getAllCards();
    if (cards.length === 0) {
      statusEl.hidden = true;
      this.showToast('No cards to refresh.', 'info');
      return;
    }

    let updated = 0;
    let errors = 0;

    for (let i = 0; i < cards.length; i++) {
      textEl.textContent = `Refreshing ${i + 1} of ${cards.length}...`;

      try {
        const result = await SWU.API.searchCards(cards[i].name);
        if (result.total_cards > 0) {
          // Find the exact match by set+number
          const match = result.data.find(c =>
            c.Set === cards[i].set && c.Number === cards[i].number
          ) || result.data[0];

          await SWU.DB.updateCard(cards[i].id, {
            marketPrice: match.MarketPrice || cards[i].marketPrice,
            lowPrice: match.LowPrice || cards[i].lowPrice,
            foilPrice: match.FoilPrice || cards[i].foilPrice,
          });
          updated++;
        }
      } catch {
        errors++;
      }

      // Rate limit: small delay between requests
      if (i < cards.length - 1) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    statusEl.hidden = true;
    this.showToast(`Prices refreshed! Updated: ${updated}${errors ? ', Errors: ' + errors : ''}`, 'success');
  },

  async rebuildHashDatabase() {
    if (!confirm('This will re-download all card data and re-hash card images. It may take a few minutes. Continue?')) return;

    const statusEl = document.getElementById('hash-rebuild-status');
    const textEl = document.getElementById('hash-rebuild-text');
    statusEl.hidden = false;
    document.getElementById('btn-rebuild-hashes').disabled = true;

    try {
      // Rebuild card catalog (search data)
      if (typeof SWU.API.rebuildCatalog !== 'function') {
        throw new Error('Please hard-refresh (Ctrl+Shift+R) to load updated scripts.');
      }
      textEl.textContent = 'Rebuilding card catalog...';
      await SWU.API.rebuildCatalog((status, pct) => {
        textEl.textContent = `Catalog: ${status} ${pct}%`;
      });

      // Rebuild image hash database (scanner data)
      await SWU.OCR.rebuild((status, pct) => {
        textEl.textContent = `Hashes: ${status} ${pct}%`;
      });

      this.showToast('Card database rebuilt successfully!', 'success');
    } catch (err) {
      this.showToast('Failed to rebuild: ' + err.message, 'error');
    }

    statusEl.hidden = true;
    document.getElementById('btn-rebuild-hashes').disabled = false;
  },

  // ==========================================
  // Toast Notifications
  // ==========================================

  showToast(message, type, duration) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type || 'info'}`;
    toast.textContent = message;
    container.appendChild(toast);

    // Shorter duration for quick-add mode, default 3s otherwise
    const ms = duration || (this._quickAddEnabled ? 1200 : 3000);
    toast.style.animationDuration = `0.3s, 0.3s`;
    toast.style.animationDelay = `0s, ${ms - 300}ms`;

    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, ms);
  },

  // ==========================================
  // Utility
  // ==========================================

  _escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  /**
   * Build a TCGPlayer search URL for a card.
   */
  _tcgPlayerUrl(card) {
    const name = card.Name || '';
    const variant = card.VariantType || '';
    const q = encodeURIComponent(`${name} ${variant}`.trim());
    return `https://www.tcgplayer.com/search/star-wars-unlimited/product?q=${q}&productLineName=star-wars-unlimited`;
  },
};

// ==========================================
// Boot
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  SWU.App.init();
});
