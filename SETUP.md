# SWU Card Scanner & Collection Viewer — Quick Start Guide

Get your own card scanner + public collection page running in ~15 minutes.

---

## What You Get

- **Card Scanner** — Scan SWU cards with your camera, auto-identify them, track your collection
- **Collection Manager** — Browse, search, filter your cards with market prices
- **Orders / Shopping Cart** — Create discounted orders for buyers
- **Public Collection Page** — A shareable link where buyers can see your cards for sale
- **Google Sheet Sync** — Your collection syncs to a Google Sheet as the data source

---

## Step 1: Get the Project Files

You should have received a zip file or folder with these files:

```
star-wars-project/
  css/styles.css
  js/api.js
  js/app.js
  js/camera.js
  js/db.js
  js/export.js
  js/ocr.js
  js/orders.js
  scanner.html        <-- Your private scanner app
  index.html           <-- Public collection viewer (for buyers)
```

Put this folder somewhere on your computer (e.g., `C:\Users\YourName\swu-scanner\`).

---

## Step 2: Run the Scanner Locally

You need a local web server to run the scanner (camera/IndexedDB won't work from a file:// URL).

**Option A — Node.js (easiest):**
```bash
# If you have Node.js installed:
cd "C:\Users\YourName\swu-scanner"
npx serve .
```
Then open `http://localhost:3000/scanner.html` in Chrome.

**Option B — Python:**
```bash
cd "C:\Users\YourName\swu-scanner"
python -m http.server 8080
```
Then open `http://localhost:8080/scanner.html` in Chrome.

**Option C — VS Code Live Server:**
1. Install the "Live Server" extension in VS Code
2. Right-click `scanner.html` → "Open with Live Server"

---

## Step 3: Create Your Google Sheet

This is where your collection data lives so the public viewer can read it.

1. Go to [Google Sheets](https://sheets.google.com) and create a **new blank spreadsheet**
2. Name it whatever you want (e.g., "My SWU Collection")
3. Copy the **Sheet ID** from the URL:
   ```
   https://docs.google.com/spreadsheets/d/THIS_PART_IS_YOUR_SHEET_ID/edit
   ```
4. Click **Share** (top right):
   - Click "Anyone with the link"
   - Set permission to **Viewer**
   - Copy the link

---

## Step 4: Set Up Google Apps Script (Sync Endpoint)

This lets the scanner push your collection to the Google Sheet.

1. In your Google Sheet, go to **Extensions → Apps Script**
2. Delete any code in the editor and paste this entire script:

```javascript
function doPost(e) {
  var data = JSON.parse(e.postData.contents);

  // === TEST ===
  if (data.action === 'test') {
    var s = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    s.appendRow(['TEST', new Date().toISOString(), 'Connection OK']);
    return ContentService.createTextOutput('OK');
  }

  // === SYNC COLLECTION (full replace) ===
  if (data.action === 'syncCollection') {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

    // Always write/overwrite header row
    var header = ['Name','Subtitle','Set','Number','Rarity',
      'Type','Aspects','Variant Type','Quantity',
      'Market Price','Discounted Price','','Notes','Front Art'];
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(header);
    } else {
      sheet.getRange(1, 1, 1, header.length).setValues([header]);
    }

    // Clear all data rows (keep header row 1)
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
    }

    // Write collection rows
    var rows = data.rows || [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      sheet.appendRow([
        r.name, r.subtitle, r.set, r.number, r.rarity, r.type,
        r.aspects, r.variantType, r.quantity,
        '$' + r.marketPrice, '$' + r.discountedPrice, '', r.notes, r.frontArt || ''
      ]);
    }
    return ContentService.createTextOutput('OK');
  }

  // === ADD ORDER (append to Orders sheet) ===
  if (data.action === 'addOrder') {
    var orderSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders');
    if (!orderSheet) {
      orderSheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet('Orders');
      orderSheet.appendRow(['Date','Buyer','Card','Subtitle','Set',
        'Number','Variant','Qty','Market $','Discounted $','Line Total']);
    }
    var items = data.items || [];
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      orderSheet.appendRow([
        data.date, data.buyerName, item.name, item.subtitle,
        item.set, item.number, item.variantType, item.quantity,
        '$' + item.marketPrice, '$' + item.discountedPrice,
        '$' + item.lineTotal
      ]);
    }
    return ContentService.createTextOutput('OK');
  }

  return ContentService.createTextOutput('Unknown action');
}
```

3. Click **Save** (Ctrl+S)
4. Click **Deploy → New deployment**
5. Click the gear icon → select **Web app**
6. Set:
   - **Execute as:** Me
   - **Who has access:** Anyone
7. Click **Deploy**
8. **Authorize** when prompted (click "Advanced" → "Go to [project name]" if you see a warning)
9. **Copy the Web App URL** — you'll need this in the next step

---

## Step 5: Connect the Scanner to Your Google Sheet

1. Open your scanner at `http://localhost:xxxx/scanner.html`
2. Go to the **Orders** tab
3. Under "Google Sheets Sync", paste your **Web App URL** from Step 4
4. Click **Test** to verify the connection
5. Go to the **Export** tab
6. Click **"Sync to Google Sheet"** to push your collection

---

## Step 6: Set Up Your Public Collection Page

The `index.html` file is a standalone public viewer. You need to update it with YOUR Google Sheet ID.

1. Open `index.html` in a text editor
2. Find this line near the top of the `<script>` section:
   ```javascript
   SHEET_ID: '1obPzdu07q19l3psMZaCSSCIWGf07Kun8OVM7I2TFQaA',
   ```
3. Replace the Sheet ID with **your own** (from Step 3)
4. Save the file

---

## Step 7: Deploy to GitHub Pages (Free Hosting)

This makes your public collection viewer available at a URL you can share with buyers.

1. Create a [GitHub](https://github.com) account if you don't have one
2. Create a **new public repository** (e.g., "my-swu-collection")
   - ONLY add `index.html` to this repo (not the scanner files!)
3. Push `index.html`:
   ```bash
   cd "C:\Users\YourName\swu-scanner"

   # Create a separate folder for the public repo
   mkdir ..\my-swu-public
   copy index.html ..\my-swu-public\
   cd ..\my-swu-public

   git init
   git add index.html
   git commit -m "Initial collection viewer"
   git remote add origin https://github.com/YOUR_USERNAME/my-swu-collection.git
   git branch -M main
   git push -u origin main
   ```
4. Go to your repo on GitHub → **Settings → Pages**
5. Under "Source", select **main** branch → click **Save**
6. Wait 1-2 minutes, then visit: `https://YOUR_USERNAME.github.io/my-swu-collection/`

That's your public collection link! Share it with buyers.

---

## Day-to-Day Usage

| Task | How |
|------|-----|
| **Scan cards** | Open `scanner.html` locally → Scan tab |
| **Browse collection** | Scanner → Collection tab |
| **Create an order** | Scanner → Orders tab → search cards, add to cart |
| **Update public page** | Scanner → Export → "Sync to Google Sheet" (pushes latest data) |
| **Share with buyers** | Send them your GitHub Pages link |

---

## Troubleshooting

**"Failed to load collection"** on the public page
- Make sure your Google Sheet is shared as "Anyone with the link → Viewer"
- Check that the Sheet ID in `index.html` matches your sheet

**Camera not working**
- Make sure you're using HTTPS or localhost (camera requires secure context)
- Try Chrome — it has the best camera support
- Check browser permissions for camera access

**Sync not working**
- Re-check your Apps Script Web App URL
- Make sure the script is deployed as "Anyone" with access
- Try the "Test" button first to verify the connection

**Cards show no images**
- Sync your collection again (Export → Sync to Google Sheet)
- The sync pushes card image URLs to the sheet. First-time users need at least one sync.

---

## Quick Reference

| Item | Where |
|------|-------|
| Scanner app | `http://localhost:xxxx/scanner.html` (local only) |
| Public viewer | `https://YOUR_USERNAME.github.io/REPO_NAME/` |
| Google Sheet | Your personal sheet (for data storage) |
| Apps Script | Extensions → Apps Script in your Google Sheet |

---

That's it! Happy scanning.
