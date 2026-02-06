// ============================================
// SWU Card Scanner — Orders / Shopping Cart (orders.js)
// ============================================

window.SWU = window.SWU || {};

SWU.Orders = {
  _cart: [],               // Array of { card, quantity } — card is a collection record
  _buyerName: '',
  _discountPercent: 75,
  _searchDebounce: null,
  _allCollectionCards: [],  // Cached for searching

  // ==========================================
  // Setup
  // ==========================================

  setup() {
    // Buyer name
    document.getElementById('order-buyer-name').addEventListener('input', (e) => {
      this._buyerName = e.target.value.trim();
    });

    // Discount selector
    const discountSelect = document.getElementById('order-discount');
    const customLabel = document.getElementById('order-custom-discount-label');
    const customInput = document.getElementById('order-custom-discount');

    discountSelect.addEventListener('change', () => {
      if (discountSelect.value === 'custom') {
        customLabel.hidden = false;
        this._discountPercent = parseInt(customInput.value) || 75;
      } else {
        customLabel.hidden = true;
        this._discountPercent = parseInt(discountSelect.value);
      }
      this.renderCart();
    });

    customInput.addEventListener('input', () => {
      this._discountPercent = Math.min(100, Math.max(1, parseInt(customInput.value) || 75));
      this.renderCart();
    });

    // Collection search
    const searchInput = document.getElementById('order-search-input');
    document.getElementById('btn-order-search').addEventListener('click', () => {
      this.handleSearch(searchInput.value);
    });

    searchInput.addEventListener('input', () => {
      clearTimeout(this._searchDebounce);
      const query = searchInput.value.trim();
      if (query.length < 2) {
        document.getElementById('order-search-results').innerHTML = '';
        return;
      }
      this._searchDebounce = setTimeout(() => this.handleSearch(query), 250);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(this._searchDebounce);
        this.handleSearch(searchInput.value);
      }
    });

    // Cart buttons
    document.getElementById('btn-complete-order').addEventListener('click', () => this.completeOrder());
    document.getElementById('btn-clear-cart').addEventListener('click', () => this.clearCart());
    document.getElementById('btn-copy-cart').addEventListener('click', () => this.copyCartToClipboard());

    // History export buttons
    document.getElementById('btn-export-all-orders').addEventListener('click', async () => {
      try {
        await SWU.Export.exportAllOrders();
        SWU.App.showToast('Sales history exported!', 'success');
      } catch (err) {
        SWU.App.showToast(err.message, 'error');
      }
    });

    document.getElementById('btn-export-orders-json').addEventListener('click', async () => {
      try {
        await SWU.Export.exportOrdersJSON();
        SWU.App.showToast('Orders JSON exported!', 'success');
      } catch (err) {
        SWU.App.showToast(err.message, 'error');
      }
    });

    // Google Sheets config
    const savedUrl = localStorage.getItem('swu-gsheet-url') || '';
    document.getElementById('gsheet-url').value = savedUrl;

    document.getElementById('btn-save-gsheet-url').addEventListener('click', () => {
      const url = document.getElementById('gsheet-url').value.trim();
      localStorage.setItem('swu-gsheet-url', url);
      document.getElementById('gsheet-status').textContent = url ? 'Saved!' : 'Cleared.';
      document.getElementById('gsheet-status').style.color = 'var(--accent-green)';
      setTimeout(() => { document.getElementById('gsheet-status').textContent = ''; }, 2000);
    });

    document.getElementById('btn-test-gsheet').addEventListener('click', async () => {
      const url = document.getElementById('gsheet-url').value.trim();
      if (!url) {
        document.getElementById('gsheet-status').textContent = 'Enter a URL first.';
        document.getElementById('gsheet-status').style.color = 'var(--accent-red)';
        return;
      }
      document.getElementById('gsheet-status').textContent = 'Testing...';
      document.getElementById('gsheet-status').style.color = 'var(--text-secondary)';
      try {
        await fetch(url, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'test', timestamp: Date.now() }),
        });
        document.getElementById('gsheet-status').textContent = 'Request sent! Check your sheet.';
        document.getElementById('gsheet-status').style.color = 'var(--accent-green)';
      } catch (err) {
        document.getElementById('gsheet-status').textContent = 'Failed: ' + err.message;
        document.getElementById('gsheet-status').style.color = 'var(--accent-red)';
      }
    });

    // Toggle Apps Script help
    const helpToggle = document.getElementById('btn-toggle-gsheet-help');
    if (helpToggle) {
      helpToggle.addEventListener('click', () => {
        const helpBlock = document.getElementById('gsheet-help-block');
        helpBlock.hidden = !helpBlock.hidden;
        helpToggle.textContent = helpBlock.hidden ? 'Show Setup Guide' : 'Hide Setup Guide';
      });
    }

    // Import wishlist
    const importBtn = document.getElementById('btn-import-wishlist');
    if (importBtn) {
      importBtn.addEventListener('click', () => this.importBuyerWishlist());
    }
  },

  // ==========================================
  // Collection Search
  // ==========================================

  async handleSearch(query) {
    if (!query || query.trim().length < 2) return;

    const trimmed = query.trim();
    const resultsEl = document.getElementById('order-search-results');

    // Load collection cards
    this._allCollectionCards = await SWU.DB.getAllCards();

    const q = trimmed.toLowerCase();
    const matches = this._allCollectionCards.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.subtitle && c.subtitle.toLowerCase().includes(q)) ||
      c.set.toLowerCase().includes(q) ||
      (c.variantType && c.variantType.toLowerCase().includes(q))
    );

    if (matches.length === 0) {
      resultsEl.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:16px">No cards in your collection match that search.</p>';
      return;
    }

    this.renderSearchResults(matches);
  },

  renderSearchResults(cards) {
    const resultsEl = document.getElementById('order-search-results');
    resultsEl.innerHTML = '';

    for (const card of cards) {
      const availQty = this._getAvailableQty(card);
      if (availQty <= 0) continue; // Already fully in cart

      const price = card.customPrice != null ? card.customPrice : parseFloat(card.marketPrice) || 0;
      const discounted = price * (this._discountPercent / 100);
      const variantLabel = card.variantType && card.variantType !== 'Normal' ? card.variantType : '';

      const div = document.createElement('div');
      div.className = 'order-search-card';
      div.innerHTML = `
        <img src="${card.frontArt || ''}" alt="" loading="lazy" onerror="this.style.display='none'">
        <div class="order-search-card-info">
          <div class="card-name">${this._esc(card.name)}${card.subtitle ? ' — ' + this._esc(card.subtitle) : ''}</div>
          <div class="card-meta">${card.set} #${card.number}${variantLabel ? ' | ' + variantLabel : ''} | ${card.rarity}</div>
          <div class="card-meta">$${price.toFixed(2)} → <span style="color:var(--accent-green)">$${discounted.toFixed(2)}</span> | Avail: <strong>${availQty}</strong></div>
        </div>
        <div class="order-search-card-actions">
          <input type="number" min="1" max="${availQty}" value="1" class="order-add-qty">
          <button class="btn-primary btn-add-to-cart" style="padding:4px 10px;font-size:0.75rem">+ Add</button>
        </div>
      `;

      const qtyInput = div.querySelector('.order-add-qty');
      const addBtn = div.querySelector('.btn-add-to-cart');

      addBtn.addEventListener('click', () => {
        const qty = Math.min(parseInt(qtyInput.value) || 1, availQty);
        this.addToCart(card, qty);
        // Update available qty display
        const newAvail = this._getAvailableQty(card);
        if (newAvail <= 0) {
          div.style.opacity = '0.4';
          addBtn.disabled = true;
          addBtn.textContent = 'Added';
        } else {
          qtyInput.max = newAvail;
          qtyInput.value = 1;
          div.querySelector('.card-meta:last-of-type strong').textContent = newAvail;
        }
      });

      resultsEl.appendChild(div);
    }
  },

  // ==========================================
  // Cart Management
  // ==========================================

  _getAvailableQty(card) {
    const inCart = this._cart.find(item => item.card.id === card.id);
    const cartQty = inCart ? inCart.quantity : 0;
    return (card.quantity || 1) - cartQty;
  },

  addToCart(card, qty) {
    const existing = this._cart.find(item => item.card.id === card.id);
    const maxAvail = (card.quantity || 1);

    if (existing) {
      const newQty = Math.min(existing.quantity + qty, maxAvail);
      existing.quantity = newQty;
    } else {
      this._cart.push({ card, quantity: Math.min(qty, maxAvail) });
    }

    this.renderCart();
    SWU.App.showToast(`+ ${card.name}${card.variantType !== 'Normal' ? ' (' + card.variantType + ')' : ''}`, 'success');
  },

  removeFromCart(index) {
    this._cart.splice(index, 1);
    this.renderCart();
    // Refresh search results to update availability
    const query = document.getElementById('order-search-input').value.trim();
    if (query.length >= 2) this.handleSearch(query);
  },

  updateCartQty(index, delta) {
    const item = this._cart[index];
    if (!item) return;

    const maxAvail = item.card.quantity || 1;
    const newQty = item.quantity + delta;

    if (newQty <= 0) {
      this.removeFromCart(index);
      return;
    }

    item.quantity = Math.min(newQty, maxAvail);
    this.renderCart();
  },

  clearCart() {
    this._cart = [];
    this.renderCart();
    // Refresh search results
    const query = document.getElementById('order-search-input').value.trim();
    if (query.length >= 2) this.handleSearch(query);
    SWU.App.showToast('Cart cleared.', 'info');
  },

  getCartTotals() {
    let subtotal = 0;
    let totalDiscounted = 0;
    let totalItems = 0;

    for (const item of this._cart) {
      const price = item.card.customPrice != null ? item.card.customPrice : parseFloat(item.card.marketPrice) || 0;
      const discounted = price * (this._discountPercent / 100);
      subtotal += price * item.quantity;
      totalDiscounted += discounted * item.quantity;
      totalItems += item.quantity;
    }

    return { subtotal, totalDiscounted, totalItems };
  },

  renderCart() {
    const emptyEl = document.getElementById('order-cart-empty');
    const tableWrap = document.getElementById('order-cart-table-wrap');
    const actionsEl = document.getElementById('order-actions');
    const tbody = document.getElementById('order-cart-body');
    const totalEl = document.getElementById('order-cart-total-amount');
    const countEl = document.getElementById('cart-item-count');

    if (this._cart.length === 0) {
      emptyEl.hidden = false;
      tableWrap.hidden = true;
      actionsEl.hidden = true;
      countEl.textContent = '(0 items)';
      return;
    }

    emptyEl.hidden = true;
    tableWrap.hidden = false;
    actionsEl.hidden = false;
    tbody.innerHTML = '';

    const discount = this._discountPercent / 100;

    for (let i = 0; i < this._cart.length; i++) {
      const item = this._cart[i];
      const card = item.card;
      const price = card.customPrice != null ? card.customPrice : parseFloat(card.marketPrice) || 0;
      const discounted = price * discount;
      const lineTotal = discounted * item.quantity;
      const variantLabel = card.variantType && card.variantType !== 'Normal' ? card.variantType : 'Normal';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <strong>${this._esc(card.name)}</strong>
          ${card.subtitle ? '<br><small style="color:var(--text-secondary)">' + this._esc(card.subtitle) + '</small>' : ''}
        </td>
        <td><small>${variantLabel}</small></td>
        <td>${card.set} #${card.number}</td>
        <td style="color:var(--text-muted)">${card.quantity || 1}</td>
        <td>
          <div class="cart-qty-control">
            <button class="btn-cart-minus" data-idx="${i}">−</button>
            <span>${item.quantity}</span>
            <button class="btn-cart-plus" data-idx="${i}">+</button>
          </div>
        </td>
        <td>$${price.toFixed(2)}</td>
        <td style="color:var(--accent-green)">$${discounted.toFixed(2)}</td>
        <td style="font-weight:600">$${lineTotal.toFixed(2)}</td>
        <td><button class="btn-remove-cart-item" data-idx="${i}" title="Remove">&#10005;</button></td>
      `;
      tbody.appendChild(tr);
    }

    // Wire up buttons
    tbody.querySelectorAll('.btn-cart-minus').forEach(btn => {
      btn.addEventListener('click', () => this.updateCartQty(parseInt(btn.dataset.idx), -1));
    });
    tbody.querySelectorAll('.btn-cart-plus').forEach(btn => {
      btn.addEventListener('click', () => this.updateCartQty(parseInt(btn.dataset.idx), 1));
    });
    tbody.querySelectorAll('.btn-remove-cart-item').forEach(btn => {
      btn.addEventListener('click', () => this.removeFromCart(parseInt(btn.dataset.idx)));
    });

    const totals = this.getCartTotals();
    totalEl.textContent = `$${totals.totalDiscounted.toFixed(2)}`;
    countEl.textContent = `(${totals.totalItems} item${totals.totalItems !== 1 ? 's' : ''})`;
  },

  // ==========================================
  // Complete Order
  // ==========================================

  async completeOrder() {
    if (!this._buyerName) {
      SWU.App.showToast('Please enter a buyer name.', 'error');
      document.getElementById('order-buyer-name').focus();
      return;
    }

    if (this._cart.length === 0) {
      SWU.App.showToast('Cart is empty.', 'error');
      return;
    }

    // Validate stock — re-check each card in DB
    for (const item of this._cart) {
      const freshCard = await SWU.DB.getCard(item.card.id);
      if (!freshCard) {
        SWU.App.showToast(`"${item.card.name}" no longer exists in your collection. Remove it from cart and try again.`, 'error');
        return;
      }
      if ((freshCard.quantity || 1) < item.quantity) {
        SWU.App.showToast(`Not enough "${item.card.name}" — you have ${freshCard.quantity || 1} but cart has ${item.quantity}. Adjust and retry.`, 'error');
        return;
      }
    }

    const discount = this._discountPercent / 100;
    const items = [];
    let subtotal = 0;
    let totalDiscounted = 0;
    let totalItems = 0;

    for (const item of this._cart) {
      const card = item.card;
      const effectivePrice = card.customPrice != null ? card.customPrice : parseFloat(card.marketPrice) || 0;
      const discountedPrice = effectivePrice * discount;
      const lineTotal = discountedPrice * item.quantity;

      items.push({
        cardId: card.id,
        name: card.name,
        subtitle: card.subtitle || '',
        set: card.set,
        number: card.number,
        variantType: card.variantType || 'Normal',
        rarity: card.rarity || '',
        frontArt: card.frontArt || '',
        marketPrice: card.marketPrice || '0.00',
        customPrice: card.customPrice,
        effectivePrice,
        discountedPrice,
        quantity: item.quantity,
        lineTotal,
      });

      subtotal += effectivePrice * item.quantity;
      totalDiscounted += lineTotal;
      totalItems += item.quantity;
    }

    const orderRecord = {
      buyerName: this._buyerName,
      discountPercent: this._discountPercent,
      items,
      subtotal,
      totalDiscounted,
      totalItems,
      notes: '',
    };

    // 1. Deduct from collection
    for (const item of this._cart) {
      const freshCard = await SWU.DB.getCard(item.card.id);
      const newQty = (freshCard.quantity || 1) - item.quantity;

      if (newQty <= 0) {
        await SWU.DB.deleteCard(item.card.id);
      } else {
        await SWU.DB.updateCard(item.card.id, { quantity: newQty });
      }
    }

    // 2. Save order
    const orderId = await SWU.DB.addOrder(orderRecord);

    // 3. Get the saved order (with generated id + date)
    const savedOrder = await SWU.DB.getOrder(orderId);

    // 4. Export as Excel
    try {
      SWU.Export.exportOrderExcel(savedOrder);
    } catch (err) {
      console.warn('Order Excel export failed:', err);
    }

    // 5. Copy to clipboard
    try {
      await this.copyOrderToClipboard(savedOrder);
    } catch (err) {
      console.warn('Clipboard copy failed:', err);
    }

    // 6. Google Sheets sync
    this.syncToGoogleSheet(savedOrder);

    // 7. Clear cart + show success
    this._cart = [];
    document.getElementById('order-search-results').innerHTML = '';
    this.renderCart();
    this.refreshHistory();

    SWU.App.showToast(`Order completed for ${this._buyerName}! Excel downloaded & copied to clipboard.`, 'success', 4000);
  },

  // ==========================================
  // Import Buyer Wishlist
  // ==========================================

  async importBuyerWishlist() {
    const textarea = document.getElementById('order-import-text');
    const statusEl = document.getElementById('import-wishlist-status');
    const raw = textarea.value.trim();

    if (!raw) {
      statusEl.textContent = 'Paste a wishlist first.';
      statusEl.style.color = 'var(--accent-red)';
      return;
    }

    statusEl.textContent = 'Importing...';
    statusEl.style.color = 'var(--text-secondary)';

    // Parse the wishlist text
    const wishlistItems = this._parseWishlist(raw);

    if (wishlistItems.length === 0) {
      statusEl.textContent = 'Could not parse any items from the text.';
      statusEl.style.color = 'var(--accent-red)';
      return;
    }

    // Extract buyer name if present
    const buyerMatch = raw.match(/From:\s*(.+)/i);
    if (buyerMatch && buyerMatch[1].trim()) {
      const buyerInput = document.getElementById('order-buyer-name');
      buyerInput.value = buyerMatch[1].trim();
      this._buyerName = buyerMatch[1].trim();
    }

    // Load all collection cards for matching
    this._allCollectionCards = await SWU.DB.getAllCards();

    let matched = 0;
    let notFound = [];
    let insufficientStock = [];

    for (const wish of wishlistItems) {
      // Find matching card in collection
      const card = this._findMatchingCard(wish);

      if (!card) {
        notFound.push(wish.name + (wish.variant && wish.variant !== 'Normal' ? ` (${wish.variant})` : ''));
        continue;
      }

      const availQty = this._getAvailableQty(card);
      const wantQty = Math.min(wish.quantity, availQty);

      if (availQty <= 0) {
        insufficientStock.push(`${wish.name} (need ${wish.quantity}, have 0 available)`);
        continue;
      }

      if (wantQty < wish.quantity) {
        insufficientStock.push(`${wish.name} (need ${wish.quantity}, only ${availQty} available — added ${wantQty})`);
      }

      this.addToCart(card, wantQty);
      matched++;
    }

    // Build status message
    const parts = [`${matched} of ${wishlistItems.length} items added to cart.`];
    if (notFound.length > 0) {
      parts.push(`\nNot found: ${notFound.join(', ')}`);
    }
    if (insufficientStock.length > 0) {
      parts.push(`\nStock issues: ${insufficientStock.join(', ')}`);
    }

    statusEl.innerHTML = parts.join('<br>');
    statusEl.style.color = matched === wishlistItems.length ? 'var(--accent-green)' : 'var(--accent-gold)';

    // Clear textarea on full success
    if (matched === wishlistItems.length && notFound.length === 0) {
      textarea.value = '';
    }

    SWU.App.showToast(`Imported ${matched} items from wishlist.`, matched > 0 ? 'success' : 'error');
  },

  _parseWishlist(text) {
    const items = [];
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip header lines, empty lines, separators, and metadata
      if (!trimmed) continue;
      if (trimmed.startsWith('---')) continue;
      if (trimmed.startsWith('From:')) continue;
      if (trimmed.startsWith('Date:')) continue;
      if (trimmed.startsWith('TOTAL:')) continue;
      if (trimmed.match(/^Name\s*\|/i)) continue;
      if (trimmed.match(/^-+\|/)) continue;

      // Parse pipe-delimited format: Name | Subtitle | Set | # | Variant | Qty | Price
      const parts = trimmed.split('|').map(p => p.trim());
      if (parts.length >= 5) {
        const name = parts[0];
        const subtitle = parts[1] || '';
        const set = parts[2] || '';
        const number = parts[3] || '';
        const variant = parts[4] || 'Normal';
        const qty = parseInt(parts[5]) || 1;

        if (name && name !== 'Name') {
          items.push({ name, subtitle, set, number, variant, quantity: qty });
        }
      }
    }

    return items;
  },

  _findMatchingCard(wish) {
    // Try exact match first: name + set + number + variant
    let match = this._allCollectionCards.find(c =>
      c.name.toLowerCase() === wish.name.toLowerCase() &&
      c.set.toLowerCase() === wish.set.toLowerCase() &&
      String(c.number) === String(wish.number) &&
      (c.variantType || 'Normal').toLowerCase() === (wish.variant || 'Normal').toLowerCase()
    );
    if (match) return match;

    // Try without variant (in case variant labels differ)
    match = this._allCollectionCards.find(c =>
      c.name.toLowerCase() === wish.name.toLowerCase() &&
      c.set.toLowerCase() === wish.set.toLowerCase() &&
      String(c.number) === String(wish.number)
    );
    if (match) return match;

    // Try name + set only
    match = this._allCollectionCards.find(c =>
      c.name.toLowerCase() === wish.name.toLowerCase() &&
      c.set.toLowerCase() === wish.set.toLowerCase()
    );
    if (match) return match;

    // Last resort: name only
    match = this._allCollectionCards.find(c =>
      c.name.toLowerCase() === wish.name.toLowerCase()
    );
    return match || null;
  },

  // ==========================================
  // Clipboard Export
  // ==========================================

  buildOrderText(order) {
    const lines = [];
    lines.push(['Name', 'Subtitle', 'Set', 'Number', 'Variant', 'Qty', 'Market $', 'Discounted $', 'Line Total'].join('\t'));

    for (const item of order.items) {
      lines.push([
        item.name,
        item.subtitle || '',
        item.set,
        item.number,
        item.variantType || 'Normal',
        item.quantity,
        item.effectivePrice.toFixed(2),
        item.discountedPrice.toFixed(2),
        item.lineTotal.toFixed(2),
      ].join('\t'));
    }

    lines.push('');
    lines.push(['', '', '', '', '', 'TOTAL', '', '', order.totalDiscounted.toFixed(2)].join('\t'));
    lines.push(`Buyer: ${order.buyerName} | Discount: ${order.discountPercent}% | Date: ${new Date(order.date).toLocaleDateString()}`);

    return lines.join('\n');
  },

  async copyOrderToClipboard(order) {
    const text = this.buildOrderText(order);
    await navigator.clipboard.writeText(text);
  },

  async copyCartToClipboard() {
    if (this._cart.length === 0) {
      SWU.App.showToast('Cart is empty.', 'info');
      return;
    }

    const discount = this._discountPercent / 100;
    const lines = [];
    lines.push(['Name', 'Subtitle', 'Set', 'Number', 'Variant', 'Qty', 'Market $', 'Discounted $', 'Line Total'].join('\t'));

    let total = 0;
    for (const item of this._cart) {
      const card = item.card;
      const price = card.customPrice != null ? card.customPrice : parseFloat(card.marketPrice) || 0;
      const discounted = price * discount;
      const lineTotal = discounted * item.quantity;
      total += lineTotal;

      lines.push([
        card.name,
        card.subtitle || '',
        card.set,
        card.number,
        card.variantType || 'Normal',
        item.quantity,
        price.toFixed(2),
        discounted.toFixed(2),
        lineTotal.toFixed(2),
      ].join('\t'));
    }

    lines.push('');
    lines.push(['', '', '', '', '', 'TOTAL', '', '', total.toFixed(2)].join('\t'));
    lines.push(`Buyer: ${this._buyerName || '(unnamed)'} | Discount: ${this._discountPercent}%`);

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      SWU.App.showToast('Cart copied to clipboard! Paste into Google Sheets.', 'success');
    } catch (err) {
      SWU.App.showToast('Clipboard copy failed: ' + err.message, 'error');
    }
  },

  // ==========================================
  // Google Sheets Sync
  // ==========================================

  async syncToGoogleSheet(order) {
    const scriptUrl = localStorage.getItem('swu-gsheet-url');
    if (!scriptUrl) return;

    try {
      await fetch(scriptUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'addOrder',
          buyerName: order.buyerName,
          date: new Date(order.date).toISOString(),
          discount: order.discountPercent,
          total: order.totalDiscounted,
          items: order.items.map(i => ({
            name: i.name,
            subtitle: i.subtitle,
            set: i.set,
            number: i.number,
            variant: i.variantType,
            qty: i.quantity,
            price: i.effectivePrice,
            discounted: i.discountedPrice,
            lineTotal: i.lineTotal,
          })),
        }),
      });
      // no-cors means we can't read the response, but the request was sent
    } catch (err) {
      console.warn('Google Sheet sync failed:', err);
    }
  },

  // ==========================================
  // Order History
  // ==========================================

  async refreshHistory() {
    const orders = await SWU.DB.getAllOrders();
    const listEl = document.getElementById('order-history-list');
    const emptyEl = document.getElementById('order-history-empty');
    const actionsEl = document.getElementById('order-history-actions');
    const countEl = document.getElementById('total-orders-count');
    const amountEl = document.getElementById('total-sales-amount');

    // Stats
    const totalRevenue = orders.reduce((sum, o) => sum + (o.totalDiscounted || 0), 0);
    countEl.textContent = `${orders.length} order${orders.length !== 1 ? 's' : ''}`;
    amountEl.textContent = `$${totalRevenue.toFixed(2)}`;

    if (orders.length === 0) {
      listEl.innerHTML = '';
      emptyEl.hidden = false;
      actionsEl.hidden = true;
      return;
    }

    emptyEl.hidden = true;
    actionsEl.hidden = false;
    listEl.innerHTML = '';

    for (const order of orders) {
      const card = document.createElement('div');
      card.className = 'order-history-card';

      const dateStr = new Date(order.date).toLocaleDateString();
      const timeStr = new Date(order.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      card.innerHTML = `
        <div class="order-history-header">
          <div>
            <span class="order-buyer">${this._esc(order.buyerName)}</span>
            <span class="order-date">${dateStr} ${timeStr}</span>
          </div>
          <div>
            <span class="order-summary">${order.totalItems} card${order.totalItems !== 1 ? 's' : ''} @ ${order.discountPercent}%</span>
            <span class="order-total">$${(order.totalDiscounted || 0).toFixed(2)}</span>
            <span class="expand-icon">&#9660;</span>
          </div>
        </div>
        <div class="order-history-details">
          <table class="order-detail-table">
            <thead>
              <tr>
                <th>Card</th>
                <th>Variant</th>
                <th>Set</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Disc.</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              ${order.items.map(item => `
                <tr>
                  <td><strong>${this._esc(item.name)}</strong>${item.subtitle ? '<br><small>' + this._esc(item.subtitle) + '</small>' : ''}</td>
                  <td>${item.variantType || 'Normal'}</td>
                  <td>${item.set} #${item.number}</td>
                  <td>${item.quantity}</td>
                  <td>$${(item.effectivePrice || 0).toFixed(2)}</td>
                  <td>$${(item.discountedPrice || 0).toFixed(2)}</td>
                  <td><strong>$${(item.lineTotal || 0).toFixed(2)}</strong></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <div class="order-history-actions">
            <button class="btn-secondary btn-reexport-order" data-order-id="${order.id}">Re-export Excel</button>
            <button class="btn-secondary btn-recopy-order" data-order-id="${order.id}">Copy to Clipboard</button>
            <button class="btn-danger btn-delete-order" data-order-id="${order.id}" style="padding:4px 10px;font-size:0.75rem">Delete</button>
          </div>
        </div>
      `;

      // Toggle expand
      const header = card.querySelector('.order-history-header');
      header.addEventListener('click', () => {
        card.classList.toggle('expanded');
      });

      listEl.appendChild(card);
    }

    // Wire up re-export / re-copy / delete buttons
    listEl.querySelectorAll('.btn-reexport-order').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const order = await SWU.DB.getOrder(btn.dataset.orderId);
        if (order) {
          try {
            SWU.Export.exportOrderExcel(order);
            SWU.App.showToast('Order re-exported!', 'success');
          } catch (err) {
            SWU.App.showToast(err.message, 'error');
          }
        }
      });
    });

    listEl.querySelectorAll('.btn-recopy-order').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const order = await SWU.DB.getOrder(btn.dataset.orderId);
        if (order) {
          try {
            await this.copyOrderToClipboard(order);
            SWU.App.showToast('Order copied to clipboard!', 'success');
          } catch (err) {
            SWU.App.showToast('Copy failed: ' + err.message, 'error');
          }
        }
      });
    });

    listEl.querySelectorAll('.btn-delete-order').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this order from history? This cannot be undone.')) return;
        await SWU.DB.deleteOrder(btn.dataset.orderId);
        this.refreshHistory();
        SWU.App.showToast('Order deleted.', 'info');
      });
    });
  },

  // ==========================================
  // Collection → Google Sheet Sync
  // ==========================================

  async syncCollectionToSheet(discount, sortKey) {
    const scriptUrl = localStorage.getItem('swu-gsheet-url');
    if (!scriptUrl) {
      throw new Error('No Google Apps Script URL configured. Set it up in the Orders tab → Google Sheets Sync.');
    }

    let cards = await SWU.DB.getAllCards();
    if (cards.length === 0) {
      throw new Error('No cards to sync.');
    }

    // Sort using Export's sort method
    cards = SWU.Export.sortCards(cards, sortKey);

    const discountRate = discount / 100;

    const rows = cards.map(card => {
      const effectivePrice = card.customPrice != null ? card.customPrice : parseFloat(card.marketPrice) || 0;
      const discountedPrice = effectivePrice * discountRate;
      return {
        name: card.name || '',
        subtitle: card.subtitle || '',
        set: card.set || '',
        number: card.number || '',
        rarity: card.rarity || '',
        type: card.type || '',
        aspects: (card.aspects || []).join(' / '),
        variantType: card.variantType || 'Normal',
        quantity: card.quantity || 1,
        marketPrice: effectivePrice.toFixed(2),
        discountedPrice: discountedPrice.toFixed(2),
        notes: card.notes || '',
        frontArt: card.frontArt || '',
      };
    });

    // POST to Apps Script — replaces entire sheet
    await fetch(scriptUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'syncCollection',
        rows: rows,
        discount: discount,
        timestamp: new Date().toISOString(),
      }),
    });

    return { synced: rows.length };
  },

  // ==========================================
  // Utility
  // ==========================================

  _esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};
