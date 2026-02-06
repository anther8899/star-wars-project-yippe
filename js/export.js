// ============================================
// SWU Card Scanner — Export/Import (export.js)
// ============================================

window.SWU = window.SWU || {};

SWU.Export = {

  // ==========================================
  // Sorting
  // ==========================================

  _rarityRank(rarity) {
    const ranks = { 'Common': 1, 'Uncommon': 2, 'Rare': 3, 'Legendary': 4, 'Special': 5 };
    return ranks[rarity] || 0;
  },

  _getPrice(card) {
    return card.customPrice != null ? card.customPrice : parseFloat(card.marketPrice) || 0;
  },

  /**
   * Sort cards by the given sort key.
   * sortKey format: "field-direction" e.g. "name-asc", "price-desc"
   */
  sortCards(cards, sortKey) {
    if (!sortKey) return cards;

    const [key, dir] = sortKey.split('-');
    const mult = dir === 'desc' ? -1 : 1;
    const sorted = [...cards];

    sorted.sort((a, b) => {
      let av, bv;
      switch (key) {
        case 'name':
          av = (a.name || '').toLowerCase();
          bv = (b.name || '').toLowerCase();
          return av.localeCompare(bv) * mult;
        case 'price':
          av = this._getPrice(a);
          bv = this._getPrice(b);
          return (av - bv) * mult;
        case 'set':
          av = (a.set || '') + (a.number || '');
          bv = (b.set || '') + (b.number || '');
          return av.localeCompare(bv) * mult;
        case 'rarity':
          av = this._rarityRank(a.rarity);
          bv = this._rarityRank(b.rarity);
          if (av !== bv) return (av - bv) * mult;
          return (a.name || '').localeCompare(b.name || '');
        case 'aspect':
          av = (a.aspects && a.aspects.length > 0) ? a.aspects[0] : 'zzz';
          bv = (b.aspects && b.aspects.length > 0) ? b.aspects[0] : 'zzz';
          if (av !== bv) return av.localeCompare(bv) * mult;
          return (a.name || '').localeCompare(b.name || '');
        case 'type':
          av = (a.type || 'zzz').toLowerCase();
          bv = (b.type || 'zzz').toLowerCase();
          if (av !== bv) return av.localeCompare(bv) * mult;
          return (a.name || '').localeCompare(b.name || '');
        case 'dateAdded':
          return ((a.dateAdded || 0) - (b.dateAdded || 0)) * mult;
        default:
          return 0;
      }
    });

    return sorted;
  },

  // ==========================================
  // Excel Export (with auto-filters, frozen header, auto-width)
  // ==========================================

  async exportExcel(sortKey) {
    let cards = await SWU.DB.getAllCards();
    if (cards.length === 0) {
      throw new Error('No cards to export.');
    }

    cards = this.sortCards(cards, sortKey);

    const headers = [
      'Name', 'Subtitle', 'Set', 'Number', 'Rarity', 'Type', 'Aspects',
      'Variant Type', 'Quantity', 'Market Price', 'Low Price',
      'Custom Price', 'Total Value', 'Date Added', 'Notes'
    ];

    const rows = cards.map(card => {
      const price = this._getPrice(card);
      const totalValue = price * (card.quantity || 1);
      const dateStr = new Date(card.dateAdded).toISOString().split('T')[0];

      return [
        card.name || '',
        card.subtitle || '',
        card.set || '',
        card.number || '',
        card.rarity || '',
        card.type || '',
        (card.aspects || []).join(' / '),
        card.variantType || 'Normal',
        card.quantity || 1,
        parseFloat(card.marketPrice) || 0,
        parseFloat(card.lowPrice) || 0,
        card.customPrice != null ? card.customPrice : '',
        totalValue,
        dateStr,
        card.notes || '',
      ];
    });

    const ws = this._buildWorksheet(headers, rows, {
      priceCols: [9, 10, 11, 12],  // Market, Low, Custom, Total (0-indexed)
      numCols: [8],                  // Quantity
    });

    this._downloadExcel(ws, 'Collection', 'swu-collection');
  },

  // ==========================================
  // Friends & Family Export (discounted, Excel)
  // ==========================================

  async exportFriendsFamily(discount = 0.75, sortKey) {
    let cards = await SWU.DB.getAllCards();
    if (cards.length === 0) {
      throw new Error('No cards to export.');
    }

    cards = this.sortCards(cards, sortKey);

    const headers = [
      'Name', 'Subtitle', 'Set', 'Number', 'Rarity', 'Type', 'Aspects',
      'Variant Type', 'Quantity', 'Market Price', 'Discounted Price',
      'Total Value', 'Notes'
    ];

    const rows = cards.map(card => {
      const market = this._getPrice(card);
      const discounted = market * discount;
      const totalValue = discounted * (card.quantity || 1);

      return [
        card.name || '',
        card.subtitle || '',
        card.set || '',
        card.number || '',
        card.rarity || '',
        card.type || '',
        (card.aspects || []).join(' / '),
        card.variantType || 'Normal',
        card.quantity || 1,
        market,
        discounted,
        totalValue,
        card.notes || '',
      ];
    });

    // Summary rows
    const totalMarket = cards.reduce((sum, c) => sum + this._getPrice(c) * (c.quantity || 1), 0);
    const totalDiscounted = totalMarket * discount;

    rows.push([]);  // blank row
    rows.push([
      '', '', '', '', '', '', '', '',
      'TOTAL', totalMarket, totalDiscounted, totalDiscounted, ''
    ]);
    rows.push([
      '', '', '', '', '', '', '', '',
      `Discount: ${Math.round(discount * 100)}% of market`, '', '', '', ''
    ]);

    const ws = this._buildWorksheet(headers, rows, {
      priceCols: [9, 10, 11],  // Market, Discounted, Total
      numCols: [8],             // Quantity
      summaryStartRow: cards.length + 2, // row index (0-based data, +1 header, +1 blank)
    });

    this._downloadExcel(ws, 'Friends & Family', 'swu-friends-family');
  },

  // ==========================================
  // CSV Export (fallback if SheetJS not loaded)
  // ==========================================

  async exportCSV(sortKey) {
    let cards = await SWU.DB.getAllCards();
    if (cards.length === 0) {
      throw new Error('No cards to export.');
    }

    cards = this.sortCards(cards, sortKey);

    const headers = [
      'Name', 'Subtitle', 'Set', 'Number', 'Rarity', 'Type', 'Aspects',
      'VariantType', 'Quantity', 'MarketPrice', 'LowPrice',
      'CustomPrice', 'TotalValue', 'DateAdded', 'Notes'
    ];

    const rows = cards.map(card => {
      const price = this._getPrice(card);
      const totalValue = (price * (card.quantity || 1)).toFixed(2);
      const dateStr = new Date(card.dateAdded).toISOString().split('T')[0];

      return [
        this._csvEscape(card.name),
        this._csvEscape(card.subtitle || ''),
        card.set,
        card.number,
        card.rarity,
        card.type,
        this._csvEscape((card.aspects || []).join(' / ')),
        card.variantType || 'Normal',
        card.quantity || 1,
        card.marketPrice || '0.00',
        card.lowPrice || '0.00',
        card.customPrice != null ? card.customPrice.toFixed(2) : '',
        totalValue,
        dateStr,
        this._csvEscape(card.notes || ''),
      ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    const date = new Date().toISOString().split('T')[0];
    this._downloadFile(csv, `swu-collection-${date}.csv`, 'text/csv');
  },

  // ==========================================
  // JSON Export/Import
  // ==========================================

  async exportJSON() {
    const cards = await SWU.DB.getAllCards();
    if (cards.length === 0) {
      throw new Error('No cards to export.');
    }

    // Exclude scannedImage to keep file sizes manageable
    const cleanCards = cards.map(card => {
      const { scannedImage, ...rest } = card;
      return rest;
    });

    const exportData = {
      exportVersion: 1,
      exportDate: new Date().toISOString(),
      appName: 'SWU Card Scanner',
      totalCards: cleanCards.length,
      cards: cleanCards,
    };

    const json = JSON.stringify(exportData, null, 2);
    const date = new Date().toISOString().split('T')[0];
    this._downloadFile(json, `swu-collection-${date}.json`, 'application/json');
  },

  async importJSON(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target.result);

          // Validate structure
          if (!data.cards || !Array.isArray(data.cards)) {
            reject(new Error('Invalid backup file: missing cards array.'));
            return;
          }

          if (data.exportVersion && data.exportVersion > 1) {
            reject(new Error('This backup was created by a newer version of the app.'));
            return;
          }

          // Validate each card has minimum required fields
          const validCards = data.cards.filter(card =>
            card.name && card.set && card.number
          );

          if (validCards.length === 0) {
            reject(new Error('No valid cards found in the backup file.'));
            return;
          }

          const result = await SWU.DB.bulkImport(validCards);
          resolve({
            ...result,
            total: data.cards.length,
            invalid: data.cards.length - validCards.length,
          });
        } catch (err) {
          if (err instanceof SyntaxError) {
            reject(new Error('Invalid JSON file. Please select a valid backup file.'));
          } else {
            reject(err);
          }
        }
      };

      reader.onerror = () => reject(new Error('Failed to read the file.'));
      reader.readAsText(file);
    });
  },

  // ==========================================
  // Excel Helpers (SheetJS)
  // ==========================================

  /**
   * Build a SheetJS worksheet from headers and data rows.
   * Options:
   *   priceCols: array of column indices that should be formatted as currency
   *   numCols: array of column indices that should be formatted as numbers
   *   summaryStartRow: row index where summary data starts (for bold formatting)
   */
  _buildWorksheet(headers, rows, opts = {}) {
    const XLSX = window.XLSX;
    if (!XLSX) {
      throw new Error('Excel library not loaded. Please refresh the page and try again.');
    }

    const allData = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(allData);

    // 1. Auto-filter on the header row
    const lastCol = headers.length - 1;
    const lastRow = allData.length - 1;
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: lastCol } }) };

    // 2. Freeze the first row (header)
    ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', state: 'frozen' };
    // SheetJS uses !views for pane freezing
    if (!ws['!views']) ws['!views'] = [];
    ws['!views'].push({ state: 'frozen', ySplit: 1 });

    // 3. Auto-size columns based on content width
    const colWidths = headers.map((h, i) => {
      let maxLen = h.length;
      for (const row of rows) {
        if (row && row[i] != null) {
          const val = String(row[i]);
          if (val.length > maxLen) maxLen = val.length;
        }
      }
      // Cap at 40 chars, minimum 8
      return { wch: Math.min(Math.max(maxLen + 2, 8), 40) };
    });
    ws['!cols'] = colWidths;

    // 4. Format price columns as numbers (so Excel sorts them correctly)
    const priceCols = opts.priceCols || [];
    const numCols = opts.numCols || [];

    for (let r = 1; r < allData.length; r++) {
      for (const c of priceCols) {
        const cellRef = XLSX.utils.encode_cell({ r, c });
        if (ws[cellRef] && typeof ws[cellRef].v === 'number') {
          ws[cellRef].t = 'n';
          ws[cellRef].z = '$#,##0.00';
        }
      }
      for (const c of numCols) {
        const cellRef = XLSX.utils.encode_cell({ r, c });
        if (ws[cellRef]) {
          ws[cellRef].t = 'n';
          ws[cellRef].z = '0';
        }
      }
    }

    return ws;
  },

  /**
   * Create a workbook from a worksheet and trigger download as .xlsx
   */
  _downloadExcel(ws, sheetName, filenameBase) {
    const XLSX = window.XLSX;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);

    const date = new Date().toISOString().split('T')[0];
    const filename = `${filenameBase}-${date}.xlsx`;

    // Generate and download
    XLSX.writeFile(wb, filename);
  },

  // ==========================================
  // Utility
  // ==========================================

  _csvEscape(str) {
    if (!str) return '""';
    const escaped = String(str).replace(/"/g, '""');
    if (escaped.includes(',') || escaped.includes('"') || escaped.includes('\n')) {
      return `"${escaped}"`;
    }
    return escaped;
  },

  _downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  // ==========================================
  // Order Excel Export (single order invoice)
  // ==========================================

  exportOrderExcel(order) {
    const headers = [
      'Name', 'Subtitle', 'Set', 'Number', 'Rarity', 'Variant Type',
      'Quantity', 'Market Price', 'Discounted Price', 'Line Total'
    ];

    const rows = order.items.map(item => [
      item.name || '',
      item.subtitle || '',
      item.set || '',
      item.number || '',
      item.rarity || '',
      item.variantType || 'Normal',
      item.quantity,
      item.effectivePrice,
      item.discountedPrice,
      item.lineTotal,
    ]);

    // Summary rows
    rows.push([]);
    rows.push([
      '', '', '', '', '', '',
      'TOTAL', '', '', order.totalDiscounted
    ]);
    rows.push([
      `Buyer: ${order.buyerName}`,
      '', '', '', '', '',
      `Discount: ${order.discountPercent}% of market`,
      '', '', ''
    ]);
    rows.push([
      `Date: ${new Date(order.date).toLocaleDateString()}`,
      '', '', '', '', '', '', '', '', ''
    ]);

    const ws = this._buildWorksheet(headers, rows, {
      priceCols: [7, 8, 9],
      numCols: [6],
      summaryStartRow: order.items.length + 2,
    });

    const safeName = order.buyerName.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 20);
    const date = new Date(order.date).toISOString().split('T')[0];
    this._downloadExcel(ws, 'Order', `swu-order-${safeName}-${date}`);
  },

  // ==========================================
  // All Orders History Export
  // ==========================================

  async exportAllOrders() {
    const orders = await SWU.DB.getAllOrders();
    if (orders.length === 0) throw new Error('No orders to export.');

    const headers = [
      'Date', 'Buyer', 'Items', 'Discount %', 'Subtotal', 'Total', 'Card Details'
    ];

    const rows = orders.map(order => {
      const dateStr = new Date(order.date).toLocaleDateString();
      const itemSummary = order.items.map(i =>
        `${i.name}${i.variantType !== 'Normal' ? ' (' + i.variantType + ')' : ''} x${i.quantity}`
      ).join('; ');

      return [
        dateStr,
        order.buyerName,
        order.totalItems,
        order.discountPercent,
        order.subtotal,
        order.totalDiscounted,
        itemSummary,
      ];
    });

    const grandTotal = orders.reduce((s, o) => s + (o.totalDiscounted || 0), 0);
    rows.push([]);
    rows.push(['', 'GRAND TOTAL', '', '', '', grandTotal, '']);

    const ws = this._buildWorksheet(headers, rows, {
      priceCols: [4, 5],
      numCols: [2, 3],
    });

    this._downloadExcel(ws, 'Sales History', 'swu-sales-history');
  },

  async exportOrdersJSON() {
    const orders = await SWU.DB.getAllOrders();
    if (orders.length === 0) throw new Error('No orders to export.');

    const data = {
      exportVersion: 1,
      exportDate: new Date().toISOString(),
      appName: 'SWU Card Scanner',
      totalOrders: orders.length,
      orders: orders,
    };

    const json = JSON.stringify(data, null, 2);
    const date = new Date().toISOString().split('T')[0];
    this._downloadFile(json, `swu-orders-${date}.json`, 'application/json');
  },
};
