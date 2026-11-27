/* inventory.js — split from pos-system.html 1.0.5 (mechanical split, no logic changes). Products CRUD, CSV import, inventory movements. */
'use strict';

function compressPhoto(file){
  return new Promise(function(resolve, reject){
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = function(){
      URL.revokeObjectURL(url);
      try{
        const max = 400;
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const uri = cv.toDataURL('image/jpeg', 0.75);
        cv.toBlob(function(blob){
          if(blob) resolve({ uri: uri, blob: blob });
          else reject(new Error('compress failed'));
        }, 'image/jpeg', 0.75);
      }catch(e){ reject(e); }
    };
    img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

let moveProductId = null;

const PROD_PAGE_SIZE = 8;

let prodPage = 1;

let prodDragged = false; // set while a swipe/drag moved, so the tap does not open edit/delete

function prodTotalPages(){
  const sw = document.getElementById('prodSwipe');
  return (sw ? sw.querySelectorAll('.prod-page').length : 1) || 1;
}

function updateProdDots(){
  const dots = document.getElementById('prodPagerDots');
  if(!dots) return;
  dots.querySelectorAll('.dot').forEach(function(d, i){
    d.classList.toggle('on', i + 1 === prodPage);
  });
}

function gotoProdPage(p){
  const sw = document.getElementById('prodSwipe');
  if(!sw) return;
  p = Math.max(1, Math.min(prodTotalPages(), p));
  prodPage = p;
  sw.scrollTo({left: (p - 1) * sw.clientWidth, behavior: 'smooth'});
  updateProdDots();
}

function snapProdPage(){
  const sw = document.getElementById('prodSwipe');
  if(!sw || !sw.clientWidth) return;
  gotoProdPage(Math.round(sw.scrollLeft / sw.clientWidth) + 1);
}

function bindProdSwipe(){
  const sw = document.getElementById('prodSwipe');
  if(!sw) return;
  let dragX = null, dragLeft = 0, dragMoved = 0;
  sw.addEventListener('scroll', function(){
    const w = sw.clientWidth;
    if(!w) return;
    const p = Math.round(sw.scrollLeft / w) + 1;
    if(p !== prodPage && p >= 1 && p <= prodTotalPages()){ prodPage = p; updateProdDots(); }
  }, {passive: true});
  sw.addEventListener('pointerdown', function(e){
    if(e.pointerType !== 'mouse') return;
    dragX = e.clientX; dragLeft = sw.scrollLeft; dragMoved = 0;
  });
  sw.addEventListener('pointermove', function(e){
    if(dragX === null) return;
    const dx = e.clientX - dragX;
    if(Math.abs(dx) > 4){ dragMoved = Math.abs(dx); sw.scrollLeft = dragLeft - dx; }
  });
  const endDrag = function(){
    if(dragX === null) return;
    dragX = null;
    if(dragMoved > 8){
      prodDragged = true;
      setTimeout(function(){ prodDragged = false; }, 0);
      snapProdPage();
    }
  };
  sw.addEventListener('pointerup', endDrag);
  sw.addEventListener('pointercancel', function(){ dragX = null; });
}

function renderProducts(){
  const q = (document.getElementById('productSearch').value || '').trim().toLowerCase();
  const f = document.getElementById('productFilter').value;
  const sort = document.getElementById('productSort').value;
  let list = DB.products.filter(function(p){
    if(q && (p.name + ' ' + p.sku + ' ' + (p.barcode || '')).toLowerCase().indexOf(q) < 0) return false;
    if(f === 'low' && !(p.stock <= p.minStock)) return false;
    return true;
  });
  if(sort === 'name') list.sort(function(a,b){ return a.name.localeCompare(b.name); });
  else if(sort === 'stock') list.sort(function(a,b){ return a.stock - b.stock; });
  else if(sort === 'price') list.sort(function(a,b){ return effPrice(b) - effPrice(a); });
  const cats = new Set(DB.products.filter(function(p){ return p.active; }).map(function(p){ return p.category; }));
  document.getElementById('productsDetail').textContent = t('products.detail', {count: DB.products.filter(function(p){ return p.active; }).length, categories: cats.size});
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / PROD_PAGE_SIZE));
  if(prodPage > totalPages) prodPage = totalPages;
  if(prodPage < 1) prodPage = 1;
  if(!total){
    document.getElementById('productList').innerHTML = '<div class="empty"><h3>' + esc(t('pos.noProduct')) + '</h3></div>';
    return;
  }
  const headHtml = '<div class="prod-thead">' +
    '<span class="c-img">' + esc(t('products.colImage')) + '</span>' +
    '<span class="c-name">' + esc(t('common.name')) + '</span>' +
    '<span class="c-cat">' + esc(t('common.category')) + '</span>' +
    '<span class="c-price">' + esc(t('common.price')) + '</span>' +
    '<span class="c-stock">' + esc(t('common.stock')) + '</span>' +
    '<span class="c-status">' + esc(t('products.colStatus')) + '</span>' +
    '<span class="c-actions"></span></div>';
  const rowHtml = function(p){
    const stockCls = p.stock === 0 ? ' bad' : (p.stock <= p.minStock ? ' warn' : '');
    const status = p.active
      ? '<span class="badge good">' + esc(t('products.active')) + '</span>'
      : '<span class="badge">' + esc(t('products.inactive')) + '</span>';
    return '<div class="prod-trow"><div class="c-img"><div class="prod-thumb">' + prodTile(p) + '</div></div>' +
      '<div class="c-name"><strong>' + esc(p.name) + '</strong><small><span class="m-sku">' + esc(p.sku) + '</span><span class="m-cat"> · ' + esc(tCat(p.category)) + '</span></small></div>' +
      '<div class="c-cat">' + esc(tCat(p.category)) + '</div>' +
      '<div class="c-price">' + money(effPrice(p)) + '</div>' +
      '<div class="c-stock"><span class="stock-num' + stockCls + '">' + p.stock + '</span></div>' +
      '<div class="c-status">' + status + '</div>' +
      '<div class="c-actions"><button class="btn icon-btn" type="button" data-edit-product="' + p.id + '" aria-label="Edit">✎</button>' +
      '<button class="btn icon-btn del" type="button" data-delete-product="' + p.id + '" aria-label="Delete">' + TRASH_SVG + '</button></div></div>';
  };
  let pagesHtml = '';
  for(let pi = 0; pi < totalPages; pi++){
    pagesHtml += '<div class="prod-page" data-page="' + (pi + 1) + '">' + headHtml +
      '<div class="prod-tbody">' + list.slice(pi * PROD_PAGE_SIZE, (pi + 1) * PROD_PAGE_SIZE).map(rowHtml).join('') + '</div></div>';
  }
  let dotsHtml = '';
  for(let di = 1; di <= totalPages; di++) dotsHtml += '<span class="dot' + (di === prodPage ? ' on' : '') + '"></span>';
  document.getElementById('productList').innerHTML =
    '<div class="prod-swipe" id="prodSwipe">' + pagesHtml + '</div>' +
    '<div class="prod-total">' + esc(t('products.totalItems', {count: total})) + '</div>' +
    '<div class="pager-dots' + (totalPages <= 1 ? ' hidden' : '') + '" id="prodPagerDots">' + dotsHtml + '</div>';
  const sw = document.getElementById('prodSwipe');
  sw.scrollTo({left: (prodPage - 1) * sw.clientWidth, behavior: 'instant'});
  bindProdSwipe();
  document.querySelectorAll('[data-edit-product]').forEach(function(b){
    b.addEventListener('click', function(){ if(prodDragged) return; openProductForm(b.dataset.editProduct); });
  });
  document.querySelectorAll('[data-delete-product]').forEach(function(b){
    b.addEventListener('click', function(){
      if(prodDragged) return;
      const p = prodById(b.dataset.deleteProduct);
      if(!p) return;
      if(!confirm(t('common.confirmDelete'))) return;
      if(p.photo) sbStorageDelete(photoPathFromUrl(p.photo));
      DB.products = DB.products.filter(function(x){ return x.id !== p.id; });
      sbDelete('products', p.id);
      save(); renderProducts(); toast(t('products.deleted'));
    });
  });
}

function openProductForm(id){
  const p = id ? prodById(id) : null;
  let photoData = (p && (p.photoPending || p.photo)) ? (p.photoPending || p.photo) : ''; /* staged photo; saved only on Save */
  let photoBlob = null; /* compressed Blob of a newly picked photo; null when the photo is unchanged */
  const catOpts = CATEGORIES.map(function(c){
    return '<option value="' + esc(c) + '"' + (p && p.category === c ? ' selected' : '') + '>' + esc(tCat(c)) + '</option>';
  }).join('');
  openModal(
    '<header><h2>' + esc(p ? t('products.edit') : t('products.add')) + '</h2><button class="btn icon-btn" type="button" data-close>✕</button></header>' +
    '<div class="pf-photo">' +
      '<div class="pf-photo-preview" id="pfPhotoPreview">' + (photoData ? '<img src="' + esc(photoData) + '" alt="">' : '📷') + '</div>' +
      '<div class="pf-photo-btns">' +
        '<button class="btn" type="button" id="pfPhotoBtn">' + esc(t(photoData ? 'products.changePhoto' : 'products.addPhoto')) + '</button>' +
        '<button class="btn' + (photoData ? '' : ' hidden') + '" type="button" id="pfPhotoRemove">' + esc(t('products.removePhoto')) + '</button>' +
      '</div>' +
      '<input type="file" id="pfPhotoInput" accept="image/*" hidden>' +
    '</div>' +
    fieldHtml(t('products.productName'), '<input type="text" id="pfName" value="' + esc(p ? p.name : '') + '">') +
    '<div class="form-grid">' +
    fieldHtml(t('products.sku'), '<input type="text" id="pfSku" value="' + esc(p ? p.sku : '') + '">') +
    fieldHtml(t('products.barcode'), '<div class="row" style="gap:8px"><input type="text" id="pfBarcode" value="' + esc(p ? (p.barcode || '') : '') + '" style="flex:1;min-width:0"><button class="btn icon-btn" type="button" id="pfScanBtn" aria-label="Scan">📷</button></div>') +
    fieldHtml(t('products.category'), '<select id="pfCat">' + catOpts + '</select>') +
    fieldHtml(t('products.brand'), '<input type="text" id="pfBrand" value="' + esc(p ? p.brand : '') + '">') +
    fieldHtml(t('products.costPrice'), '<input type="number" id="pfCost" min="0" step="any" value="' + (p ? p.costPrice : '') + '">') +
    fieldHtml(t('products.sellingPrice'), '<input type="number" id="pfPrice" min="0" step="any" value="' + (p ? p.sellingPrice : '') + '">') +
    fieldHtml(t('products.discountPrice'), '<input type="number" id="pfDisc" min="0" step="any" value="' + (p && p.discountPrice != null ? p.discountPrice : '') + '">') +
    fieldHtml(t('products.stockQty'), '<input type="number" id="pfStock" min="0" step="1" value="' + (p ? p.stock : 0) + '">') +
    fieldHtml(t('products.minStock'), '<input type="number" id="pfMin" min="0" step="1" value="' + (p ? p.minStock : 5) + '">') +
    '</div>' +
    '<div class="form-actions">' +
    (p ? '<button class="btn danger" type="button" id="pfDelete" style="margin-right:auto">' + esc(t('common.delete')) + '</button>' : '') +
    '<button class="btn" type="button" data-close>' + esc(t('common.cancel')) + '</button>' +
    '<button class="btn primary" type="button" id="pfSave">' + esc(t('common.save')) + '</button></div>'
  );
  document.getElementById('pfSave').addEventListener('click', function(){
    const name = document.getElementById('pfName').value.trim();
    const price = parseFloat(document.getElementById('pfPrice').value);
    if(!name || !(price >= 0)){ toast(t('common.required')); return; }
    const disc = parseFloat(document.getElementById('pfDisc').value);
    const data = {
      name: name,
      sku: document.getElementById('pfSku').value.trim() || ('SKU-' + Date.now().toString(36).toUpperCase()),
      barcode: document.getElementById('pfBarcode').value.trim(),
      category: document.getElementById('pfCat').value,
      brand: document.getElementById('pfBrand').value.trim(),
      costPrice: parseFloat(document.getElementById('pfCost').value) || 0,
      sellingPrice: price,
      discountPrice: (isFinite(disc) && disc > 0) ? disc : null,
      stock: Math.max(0, parseInt(document.getElementById('pfStock').value, 10) || 0),
      minStock: Math.max(0, parseInt(document.getElementById('pfMin').value, 10) || 0),
      /* Photo (Storage): a newly picked photo is staged as a pending data URI
         and uploaded by retryPendingPhotos() (triggered by save()); the old
         URL stays until the upload succeeds. Removing clears both and
         deletes the old storage object (best effort). Unchanged leaves the
         photo fields alone. */
      photo: p ? p.photo : '',
      photoPending: p ? (p.photoPending || '') : ''
    };
    if(photoBlob){ data.photoPending = photoData; }
    else if(!photoData){
      if(p && p.photo) sbStorageDelete(photoPathFromUrl(p.photo));
      data.photo = ''; data.photoPending = '';
    }
    if(p) Object.assign(p, data);
    else DB.products.push(Object.assign({ id: uid('p'), barcode: '', unit: 'pc', description: '', supplier: '', active: true }, data));
    save(); closeModal(); renderProducts(); toast(t('products.saved'));
  });
  document.getElementById('pfScanBtn').addEventListener('click', function(){ openScanner('product'); });
  /* Photo: file input with accept="image/*" and NO capture attribute, so
     Android Chrome / the TWA app offer Camera + Gallery. The picked file is
     compressed (max 400px, JPEG ~0.75) and staged in photoData + photoBlob
     until Save; on Save the Blob is uploaded to Supabase Storage and the
     product keeps the public URL, with the data URI as the pending local
     copy until the upload succeeds. */
  function updatePhotoPreview(){
    const prev = document.getElementById('pfPhotoPreview');
    if(prev) prev.innerHTML = photoData ? '<img src="' + esc(photoData) + '" alt="">' : '📷';
    const btn = document.getElementById('pfPhotoBtn');
    if(btn) btn.textContent = t(photoData ? 'products.changePhoto' : 'products.addPhoto');
    const rm = document.getElementById('pfPhotoRemove');
    if(rm) rm.classList.toggle('hidden', !photoData);
  }
  document.getElementById('pfPhotoBtn').addEventListener('click', function(){ document.getElementById('pfPhotoInput').click(); });
  document.getElementById('pfPhotoInput').addEventListener('change', function(ev){
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = ''; /* allow picking the same file again */
    if(!f) return;
    compressPhoto(f).then(function(res){ photoData = res.uri; photoBlob = res.blob; updatePhotoPreview(); })
      .catch(function(){ toast(t('products.photoError')); });
  });
  document.getElementById('pfPhotoRemove').addEventListener('click', function(){ photoData = ''; photoBlob = null; updatePhotoPreview(); });
  const del = document.getElementById('pfDelete');
  if(del) del.addEventListener('click', function(){
    if(!confirm(t('common.confirmDelete'))) return;
    if(p.photo) sbStorageDelete(photoPathFromUrl(p.photo));
    DB.products = DB.products.filter(function(x){ return x.id !== p.id; });
    sbDelete('products', p.id);
    save(); closeModal(); renderProducts(); toast(t('products.deleted'));
  });
}

/* ================= CSV product import ================= */
/* Header row: name,sku,barcode,category,brand,costPrice,sellingPrice,discountPrice,stock,minStock
   Columns may be in any order; headers are case-insensitive. Required: name + sellingPrice.
   Upsert by SKU (case-insensitive): matching SKU updates the product, new SKU adds one,
   rows without a SKU are always added as new. Nothing is ever deleted. */

const CSV_TEMPLATE =
  'name,sku,barcode,category,brand,costPrice,sellingPrice,discountPrice,stock,minStock\n' +
  'GaN Fast Charger 30W,CH-GAN-30,885001000002,Chargers,Volt,380,690,,24,8\n' +
  'Braided USB-C Cable 1m,CB-USBC-1M,885001000005,Cables,Loop,95,249,,38,10\n';

const CSV_COLUMNS = ['name','sku','barcode','category','brand','costprice','sellingprice','discountprice','stock','minstock'];

function parseCsv(text){
  const rows = [];
  let row = [], cur = '', inQ = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(inQ){
      if(c === '"'){
        if(text[i+1] === '"'){ cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if(c === '"'){ inQ = true; }
    else if(c === ','){ row.push(cur); cur = ''; }
    else if(c === '\n' || c === '\r'){
      if(c === '\r' && text[i+1] === '\n') i++;
      row.push(cur); cur = '';
      rows.push(row); row = [];
    } else cur += c;
  }
  if(cur !== '' || row.length){ row.push(cur); rows.push(row); }
  return rows;
}

function parseCsvProducts(text){
  if(text.charCodeAt(0) === 0xFEFF) text = text.slice(1); /* strip UTF-8 BOM (Excel CSVs) */
  const rows = parseCsv(text).filter(function(r){ return r.some(function(c){ return String(c).trim() !== ''; }); });
  if(!rows.length) return null;
  const header = rows[0].map(function(h){ return String(h).trim().toLowerCase(); });
  if(header.indexOf('name') < 0 || header.indexOf('sellingprice') < 0) return null;
  const col = {};
  CSV_COLUMNS.forEach(function(name){ const i = header.indexOf(name); if(i >= 0) col[name] = i; });
  const get = function(r, name){ const i = col[name]; return (i == null) ? '' : String(r[i] == null ? '' : r[i]).trim(); };
  const num = function(s, dflt){ const n = parseFloat(s); return isFinite(n) ? n : dflt; };
  const int = function(s, dflt){ const n = parseInt(s, 10); return isFinite(n) ? n : dflt; };
  const seen = {};
  let dup = 0;
  const adds = [], updates = [], skipped = [];
  for(let r = 1; r < rows.length; r++){
    const rowNo = r + 1;
    const name = get(rows[r], 'name');
    const priceRaw = get(rows[r], 'sellingprice');
    const price = parseFloat(priceRaw);
    if(!name){ skipped.push({row: rowNo, reason: t('products.importReasonNoName')}); continue; }
    if(priceRaw === '' || !isFinite(price) || price < 0){ skipped.push({row: rowNo, reason: t('products.importReasonBadPrice')}); continue; }
    const disc = parseFloat(get(rows[r], 'discountprice'));
    const data = {
      name: name,
      sku: get(rows[r], 'sku'),
      barcode: get(rows[r], 'barcode'),
      category: get(rows[r], 'category') || 'Accessories',
      brand: get(rows[r], 'brand'),
      costPrice: Math.max(0, num(get(rows[r], 'costprice'), 0)),
      sellingPrice: price,
      discountPrice: (isFinite(disc) && disc > 0) ? disc : null,
      stock: Math.max(0, int(get(rows[r], 'stock'), 0)),
      minStock: Math.max(0, int(get(rows[r], 'minstock'), 5))
    };
    const skuKey = data.sku ? data.sku.toLowerCase() : '';
    if(skuKey){
      if(seen[skuKey]) dup++; /* duplicate SKU in the file: last row wins */
      seen[skuKey] = data;
    } else {
      adds.push(data); /* no SKU: always a new product */
    }
  }
  Object.keys(seen).forEach(function(k){
    const data = seen[k];
    const existing = DB.products.find(function(p){ return (p.sku || '').toLowerCase() === k; });
    if(existing) updates.push({existing: existing, data: data});
    else adds.push(data);
  });
  return { adds: adds, updates: updates, skipped: skipped, dup: dup };
}

function showImportSummary(plan){
  const skippedList = plan.skipped.slice(0, 20).map(function(s){
    return '<div class="row between" style="margin:4px 0"><span>' + esc(t('products.importSkippedRow', {row: s.row, reason: s.reason})) + '</span></div>';
  }).join('') + (plan.skipped.length > 20 ? '<p class="muted">' + esc(t('products.importAndMore', {count: plan.skipped.length - 20})) + '</p>' : '');
  openModal(
    '<header><h2>' + esc(t('products.importSummaryTitle')) + '</h2><button class="btn icon-btn" type="button" data-close>✕</button></header>' +
    '<div class="row between" style="margin:5px 0"><span>' + esc(t('products.importAdd')) + '</span><strong>' + plan.adds.length + '</strong></div>' +
    '<div class="row between" style="margin:5px 0"><span>' + esc(t('products.importUpdate')) + '</span><strong>' + plan.updates.length + '</strong></div>' +
    '<div class="row between" style="margin:5px 0"><span>' + esc(t('products.importSkip')) + '</span><strong>' + plan.skipped.length + '</strong></div>' +
    (plan.dup ? '<p class="muted">' + esc(t('products.importDup', {count: plan.dup})) + '</p>' : '') +
    '<p class="muted">' + esc(t('products.importUpdateNote')) + '</p>' +
    skippedList +
    '<div class="form-actions"><button class="btn" type="button" data-close>' + esc(t('common.cancel')) + '</button>' +
    '<button class="btn primary" type="button" id="confirmImportBtn">' + esc(t('products.importBtn')) + '</button></div>'
  );
  document.getElementById('confirmImportBtn').addEventListener('click', function(){
    closeModal();
    doImportProducts(plan);
  });
}

function doImportProducts(plan){
  plan.adds.forEach(function(d){
    if(!d.sku) d.sku = 'SKU-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random()*1296).toString(36).toUpperCase();
    DB.products.push(Object.assign({ id: uid('p'), unit: 'pc', description: '', supplier: '', active: true }, d));
  });
  plan.updates.forEach(function(u){
    const sku = u.existing.sku; /* keep the stored SKU spelling; it is the match key */
    Object.assign(u.existing, u.data);
    u.existing.sku = sku;
  });
  save();
  renderProducts();
  toast(t('products.imported', {added: plan.adds.length, updated: plan.updates.length, skipped: plan.skipped.length}));
}

function onImportCsvPicked(e){
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if(!file) return;
  const reader = new FileReader();
  reader.onload = function(){
    const plan = parseCsvProducts(String(reader.result || ''));
    if(!plan){ toast(t('products.importInvalid')); return; }
    if(!plan.adds.length && !plan.updates.length && !plan.skipped.length){ toast(t('products.importNoRows')); return; }
    showImportSummary(plan);
  };
  reader.onerror = function(){ toast(t('products.importInvalid')); };
  reader.readAsText(file);
}

/* ================= inventory ================= */

function renderInventory(){
  document.getElementById('invCount').textContent = DB.products.filter(function(p){ return p.active; }).length;
  document.getElementById('invValue').textContent = money(DB.products.reduce(function(s,p){ return s + p.costPrice * p.stock; }, 0));
  const low = DB.products.filter(function(p){ return p.active && p.stock <= p.minStock; });
  document.getElementById('invLow').textContent = low.length;
  document.getElementById('stockList').innerHTML = DB.products.map(function(p){
    const cls = p.stock === 0 ? 'low' : p.stock <= p.minStock ? 'low' : '';
    const tag = p.stock === 0 ? t('inventory.out') : p.stock <= p.minStock ? t('inventory.low') : '';
    return '<button type="button" data-stock="' + p.id + '" style="display:grid;grid-template-columns:42px 1fr auto;align-items:center;gap:10px;width:100%;border:0;border-bottom:1px solid var(--border);background:transparent;text-align:left;padding:9px 2px">' +
      '<span class="avatar" style="border-radius:8px">' + prodTile(p) + '</span>' +
      '<span><strong style="font-size:12px;display:block">' + esc(p.name) + '</strong><small style="font-size:10px;color:var(--dim)">' + esc(p.sku) + (tag ? ' · ' + esc(tag) : '') + '</small></span>' +
      '<b style="font-size:16px" class="' + cls + '"' + (cls ? ' style="color:var(--danger)"' : '') + '>' + p.stock + '</b></button>';
  }).join('');
  document.querySelectorAll('[data-stock]').forEach(function(b){
    b.addEventListener('click', function(){
      moveProductId = b.dataset.stock;
      const p = prodById(moveProductId);
      document.getElementById('moveForm').classList.remove('hidden');
      document.getElementById('moveProductName').textContent = p.name;
      document.getElementById('moveProductStock').textContent = t('inventory.current', {count: p.stock});
      document.getElementById('moveQty').value = '1';
      document.getElementById('moveNote').value = '';
    });
  });
  const typeLabel = { sale: t('inventory.sale'), stock_in: t('inventory.stockIn'), stock_out: t('inventory.stockOut'), adjustment: t('inventory.adjustment'), refund: t('orders.refund') };
  const hist = DB.movements.slice(0, 30);
  document.getElementById('moveHistory').innerHTML = hist.length ? hist.map(function(m){
    const p = prodById(m.productId);
    const sign = m.quantity > 0 ? '+' : '';
    return '<div class="list-row"><div class="avatar" style="border-radius:8px">' + prodTile(p) + '</div>' +
      '<div class="grow"><strong>' + esc(p ? p.name : '—') + '</strong><small>' + esc(typeLabel[m.type] || m.type) + ' · ' + esc(m.reference || '') + (m.note ? ' · ' + esc(m.note) : '') + '<br>' + fmtDate(m.createdAt) + '</small></div>' +
      '<div class="amt" style="color:' + (m.quantity > 0 ? 'var(--good)' : 'var(--danger)') + '">' + sign + m.quantity + '<small style="display:block;color:var(--dim);font-weight:400">' + m.previousStock + ' → ' + m.newStock + '</small></div></div>';
  }).join('') : '<div class="empty"><p>' + esc(t('inventory.noHistory')) + '</p></div>';
}

function saveMovement(){
  const p = prodById(moveProductId); if(!p) return;
  const type = document.getElementById('moveType').value;
  const qty = Math.max(1, parseInt(document.getElementById('moveQty').value, 10) || 1);
  const note = document.getElementById('moveNote').value.trim();
  const prev = p.stock;
  let delta = 0, newStock = prev;
  if(type === 'stock_in'){ delta = qty; newStock = prev + qty; }
  else if(type === 'stock_out'){ delta = -qty; newStock = Math.max(0, prev - qty); }
  else { delta = qty; newStock = Math.max(0, prev + qty); }
  if(type === 'stock_out' && prev - qty < 0){ delta = -prev; newStock = 0; }
  p.stock = newStock;
  DB.movements.unshift({ id: uid('m'), productId: p.id, type: type, quantity: delta, previousStock: prev, newStock: newStock, reference: 'ADJ-' + Date.now().toString(36).toUpperCase(), note: note, createdAt: Date.now() });
  save();
  document.getElementById('moveForm').classList.add('hidden');
  moveProductId = null;
  renderInventory(); toast(t('inventory.updated'));
}

/* ================= orders ================= */
