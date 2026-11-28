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
  /* Cashiers read the catalog but never manage it: the add / import /
     template buttons go away here (the handlers are guarded too). */
  const canManage = can('products_manage');
  ['addProductBtn','templateCsvBtn','importCsvBtn'].forEach(function(id){
    const el = document.getElementById(id);
    if(el) el.style.display = canManage ? '' : 'none';
  });
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
      '<div class="c-actions">' + (canManage ?
        '<button class="btn icon-btn" type="button" data-edit-product="' + p.id + '" aria-label="Edit">✎</button>' +
        '<button class="btn icon-btn del" type="button" data-delete-product="' + p.id + '" aria-label="Delete">' + TRASH_SVG + '</button>' : '') + '</div></div>';
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
      if(deny('products_manage')) return;
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
  if(deny('products_manage')) return;
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
    /* Supplier picker (STEP 5 §9.1): the product keeps the supplier's name
       in `supplier` and the link in `supplierId`. A supplier typed by hand
       in an older build shows as no selection until it is picked. */
    fieldHtml(t('inventory.suppliers'), '<select id="pfSupplier"><option value="">—</option>' + (DB.suppliers || []).map(function(s){
      return '<option value="' + esc(s.id) + '"' + (p && (p.supplierId === s.id || (!p.supplierId && p.supplier === s.name)) ? ' selected' : '') + '>' + esc(s.name) + '</option>';
    }).join('') + '</select>') +
    /* The cost field is hidden for roles that may not see cost prices
       (cashiers never reach this form at all — the add/edit buttons are
       hidden and the handler is guarded — this is defence in depth). */
    (can('cost_prices') ? fieldHtml(t('products.costPrice'), '<input type="number" id="pfCost" min="0" step="any" value="' + (p ? p.costPrice : '') + '">') : '') +
    fieldHtml(t('products.sellingPrice'), '<input type="number" id="pfPrice" min="0" step="any" value="' + (p ? p.sellingPrice : '') + '">') +
    fieldHtml(t('products.discountPrice'), '<input type="number" id="pfDisc" min="0" step="any" value="' + (p && p.discountPrice != null ? p.discountPrice : '') + '">') +
    /* Stock (STEP 5 §9.3): the number here is display only — a new product
       starts at 0 and an existing product keeps its stock. Stock only ever
       changes through a movement (Inventory → tap a product), a sale, or a
       purchase-order receive, so the ledger can never disagree with the
       number on the card. */
    fieldHtml(t('products.stockQty'), '<input type="number" id="pfStock" min="0" step="1" value="' + (p ? p.stock : 0) + '">') +
    fieldHtml(t('products.minStock'), '<input type="number" id="pfMin" min="0" step="1" value="' + (p ? p.minStock : 5) + '">') +
    '</div>' +
    '<div class="form-actions">' +
    (p ? '<button class="btn danger" type="button" id="pfDelete" style="margin-right:auto">' + esc(t('common.delete')) + '</button>' : '') +
    '<button class="btn" type="button" data-close>' + esc(t('common.cancel')) + '</button>' +
    '<button class="btn primary" type="button" id="pfSave">' + esc(t('common.save')) + '</button></div>'
  );
  document.getElementById('pfSave').addEventListener('click', function(){
    if(deny('products_manage')) return;
    const name = document.getElementById('pfName').value.trim();
    const price = parseFloat(document.getElementById('pfPrice').value);
    if(!name || !(price >= 0)){ toast(t('common.required')); return; }
    const disc = parseFloat(document.getElementById('pfDisc').value);
    const costEl = document.getElementById('pfCost');
    const supEl = document.getElementById('pfSupplier');
    const sup = supEl ? (DB.suppliers || []).find(function(s){ return s.id === supEl.value; }) : null;
    const minStock = Math.max(0, parseInt(document.getElementById('pfMin').value, 10) || 0);
    const data = {
      name: name,
      sku: document.getElementById('pfSku').value.trim() || ('SKU-' + Date.now().toString(36).toUpperCase()),
      barcode: document.getElementById('pfBarcode').value.trim(),
      category: document.getElementById('pfCat').value,
      brand: document.getElementById('pfBrand').value.trim(),
      costPrice: costEl ? (parseFloat(costEl.value) || 0) : (p ? p.costPrice : 0),
      sellingPrice: price,
      discountPrice: (isFinite(disc) && disc > 0) ? disc : null,
      /* stock: ignored on save (STEP 5 §9.3) — a new product starts at 0,
         an existing product keeps the stock the ledger says it has. */
      stock: p ? p.stock : 0,
      minStock: minStock,
      supplier: sup ? sup.name : (p ? p.supplier : ''),
      supplierId: sup ? sup.id : '',
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
    const oldMin = p ? p.minStock : null;
    if(p) Object.assign(p, data);
    else DB.products.push(Object.assign({ id: uid('p'), barcode: '', unit: 'pc', description: '', supplier: '', active: true }, data));
    const savedProduct = p || DB.products[DB.products.length - 1];
    save(); closeModal(); renderProducts(); toast(t('products.saved'));
    /* Min stock lives on the server (set_min_stock RPC) as well as in the
       local row: send it when it changed, and create the zero balance for
       a new product so it shows in the branch ledger. Both are best
       effort — the product itself is already saved. */
    if(savedProduct){
      if(!p || minStock !== oldMin){
        sbRpc('set_min_stock', { p_shop_id: activeShopId, p_branch_id: activeBranchId, p_product_id: savedProduct.id, p_min_stock: minStock })
          .catch(function(err){ if(!isNetworkError(err)) toast(mapRpcError(err)); });
      }
      if(!p) ensureZeroBalance(savedProduct.id);
    }
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
    if(deny('products_manage')) return;
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
  if(deny('products_manage')) return;
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
  if(deny('products_manage')) return;
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

let invTab = 'stock';
let invTabsBound = false;
let invValuationCache = null;
let invValuationAt = 0;

function staffById(id){ return DB.staff.find(function(s){ return s.id === id; }); }

function renderInventory(){
  /* Sub-tabs (Stock / Suppliers / Purchase Orders) — bound once; the
     buttons live in the static Inventory view, not in this render. */
  if(!invTabsBound){
    invTabsBound = true;
    document.querySelectorAll('[data-invtab]').forEach(function(b){
      b.addEventListener('click', function(){
        invTab = b.dataset.invtab;
        document.querySelectorAll('[data-invtab]').forEach(function(x){ x.classList.toggle('active', x === b); });
        document.getElementById('invStockPanel').classList.toggle('hidden', invTab !== 'stock');
        document.getElementById('invSuppliersPanel').classList.toggle('hidden', invTab !== 'suppliers');
        document.getElementById('invPosPanel').classList.toggle('hidden', invTab !== 'pos');
        if(invTab === 'suppliers') renderSuppliers();
        if(invTab === 'pos') renderPurchaseOrders();
      });
    });
    const tsBtn = document.getElementById('transferStockBtn');
    if(tsBtn) tsBtn.addEventListener('click', openTransferModal);
    const asBtn = document.getElementById('addSupplierBtn');
    if(asBtn) asBtn.addEventListener('click', function(){ openSupplierForm(null); });
    const apBtn = document.getElementById('addPoBtn');
    if(apBtn) apBtn.addEventListener('click', function(){ openPoForm(null); });
  }
  /* Branch transfer needs a second branch to go to. */
  const tsBtn = document.getElementById('transferStockBtn');
  if(tsBtn) tsBtn.classList.toggle('hidden', !(can('stock_manage') && shopBranchesCache.length > 1));
  document.getElementById('invCount').textContent = DB.products.filter(function(p){ return p.active; }).length;
  document.getElementById('invValue').textContent = money(DB.products.reduce(function(s,p){ return s + p.costPrice * p.stock; }, 0));
  /* The stock-value metric is a cost total: roles that may not see cost
     prices never see it (their pulled costs are 0 anyway — this keeps the
     UI from showing a meaningless 0). */
  const invValueMetric = document.getElementById('invValue').closest('.metric');
  if(invValueMetric) invValueMetric.style.display = can('cost_prices') ? '' : 'none';
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
      /* Cashiers see the list read-only: tapping a row opens nothing. */
      if(!can('stock_manage')) return;
      moveProductId = b.dataset.stock;
      const p = prodById(moveProductId);
      document.getElementById('moveForm').classList.remove('hidden');
      document.getElementById('moveProductName').textContent = p.name;
      document.getElementById('moveProductStock').textContent = t('inventory.current', {count: p.stock});
      document.getElementById('moveQty').value = '1';
      document.getElementById('moveNote').value = '';
      const uc = document.getElementById('moveUnitCost'); if(uc) uc.value = '';
    });
  });
  const typeLabel = { sale: t('inventory.sale'), stock_in: t('inventory.stockIn'), stock_out: t('inventory.stockOut'), adjust_in: t('inventory.adjustIncrease'), adjust_out: t('inventory.adjustDecrease'), transfer_in: t('inventory.transferIn'), transfer_out: t('inventory.transferOut'), reversal: t('inventory.reversal'), refund: t('orders.refund') };
  /* A movement is already reversed when another movement points at it
     (the reversal row carries related_movement_id = the original id). */
  const reversedIds = {};
  DB.movements.forEach(function(m){ if(m.relatedMovementId) reversedIds[m.relatedMovementId] = true; });
  const hist = DB.movements.slice(0, 30);
  document.getElementById('moveHistory').innerHTML = hist.length ? hist.map(function(m){
    const p = prodById(m.productId);
    const sign = m.quantity > 0 ? '+' : '';
    const staff = m.staffId ? staffById(m.staffId) : null;
    const reversible = can('stock_manage') && ['stock_in','stock_out','adjust_in','adjust_out'].indexOf(m.type) >= 0 && !reversedIds[m.id] && m.type !== 'reversal';
    return '<div class="list-row"><div class="avatar" style="border-radius:8px">' + prodTile(p) + '</div>' +
      '<div class="grow"><strong>' + esc(p ? p.name : '—') + '</strong><small>' + esc(typeLabel[m.type] || m.type) + ' · ' + esc(m.reference || '') + (m.note ? ' · ' + esc(m.note) : '') + (staff ? ' · ' + esc(t('inventory.byStaff', {name: staff.name})) : '') + (reversedIds[m.id] ? ' · ' + esc(t('inventory.reversed')) : '') + '<br>' + fmtDate(m.createdAt) + '</small></div>' +
      '<div class="amt" style="color:' + (m.quantity > 0 ? 'var(--good)' : 'var(--danger)') + '">' + sign + m.quantity + '<small style="display:block;color:var(--dim);font-weight:400">' + m.previousStock + ' → ' + m.newStock + '</small></div>' +
      (reversible ? '<button type="button" class="btn" data-reverse="' + m.id + '">' + esc(t('inventory.reverse')) + '</button>' : '') + '</div>';
  }).join('') : '<div class="empty"><p>' + esc(t('inventory.noHistory')) + '</p></div>';
  document.querySelectorAll('[data-reverse]').forEach(function(b){
    b.addEventListener('click', function(){
      const reason = prompt(t('inventory.reverseReason'));
      if(reason === null) return;
      if(!reason.trim()){ toast(t('inventory.reasonRequired')); return; }
      reverseMovement(b.dataset.reverse, reason.trim());
    });
  });
  refreshValuation();
}

/* Stock value from the server's stock_valuation view (quantity on hand ×
   weighted-average cost, this branch) — cached 60s, local rollup while it
   loads or when it fails. Cost roles only; the metric is hidden otherwise. */
function refreshValuation(){
  const el = document.getElementById('invValue');
  if(!el) return;
  if(!can('cost_prices') || !authSession || !activeShopId || !activeBranchId) return;
  const now = Date.now();
  if(invValuationCache !== null && now - invValuationAt < 60000){
    el.textContent = money(invValuationCache);
    return;
  }
  fetch(SB_URL + '/rest/v1/stock_valuation?select=stock_value&shop_id=eq.' + encodeURIComponent(activeShopId) + '&branch_id=eq.' + encodeURIComponent(activeBranchId), { headers: sbHeaders(false) })
    .then(function(r){ if(!r.ok) throw new Error('sb ' + r.status); return r.json(); })
    .then(function(rows){
      const total = rows.reduce(function(s, row){ return s + (Number(row.stock_value) || 0); }, 0);
      invValuationCache = total; invValuationAt = Date.now();
      el.textContent = money(total);
    })
    .catch(function(){ /* keep the local rollup */ });
}

/* Create the zero balance for a new product in the active branch, so it
   shows in the branch ledger before its first movement. Best effort: the
   stock_balances INSERT-zero policy allows it for manager+; a failure
   (e.g. offline) is silent — the balance appears with the first stock
   movement instead. */
function ensureZeroBalance(productId){
  if(!authSession || !activeShopId || !activeBranchId) return;
  sbUpsert('stock_balances', [{ shop_id: activeShopId, branch_id: activeBranchId, product_id: productId, quantity: 0, min_stock: 0 }], 'branch_id,product_id').catch(function(){});
}

/* Stock movement through the server (STEP 5 §5): record_stock_movement()
   is the only writer of stock now. The server locks the balance, rejects
   a stock-out that would go negative (no silent clamp to zero — the old
   bug), recalculates the weighted-average cost and writes the movement
   row. The local mirror is updated from the reply (previous/new stock);
   the next cloud pull replaces it with the server's own row. */
function saveMovement(){
  if(deny('stock_manage')) return;
  const p = prodById(moveProductId); if(!p) return;
  const type = document.getElementById('moveType').value;
  const qty = Math.max(1, parseInt(document.getElementById('moveQty').value, 10) || 1);
  const note = document.getElementById('moveNote').value.trim();
  const unitCostEl = document.getElementById('moveUnitCost');
  const unitCost = unitCostEl ? (parseFloat(unitCostEl.value) || null) : null;
  if((type === 'adjust_in' || type === 'adjust_out') && !note){ toast(t('inventory.reasonRequired')); return; }
  const btn = document.getElementById('moveSaveBtn');
  if(btn) btn.disabled = true;
  sbRpc('record_stock_movement', { p_shop_id: activeShopId, p_branch_id: activeBranchId, p_product_id: p.id, p_type: type, p_qty: qty, p_unit_cost: unitCost, p_reference: null, p_note: (note || null) })
    .then(function(res){
      p.stock = Number(res.new_stock);
      DB.movements.unshift({ id: res.movement_id, productId: p.id, type: res.type, quantity: Number(res.quantity), previousStock: Number(res.previous_stock), newStock: Number(res.new_stock), reference: res.reference || '', note: note, staffId: (loadMembership() && loadMembership().staffId) || null, unitCost: (res.avg_cost != null ? Number(res.avg_cost) : null), createdAt: Date.now() });
      save();
      document.getElementById('moveForm').classList.add('hidden');
      moveProductId = null;
      renderInventory(); toast(t('inventory.updated'));
    })
    .catch(function(err){
      console.warn('[inventory] record_stock_movement failed', err);
      toast(mapRpcError(err));
    })
    .finally(function(){ if(btn) btn.disabled = false; });
}

/* Reverse one movement (STEP 5 §6): the server writes a compensating
   movement and never touches the original row — history stays immutable. */
function reverseMovement(movementId, reason){
  if(deny('stock_manage')) return;
  sbRpc('reverse_movement', { p_shop_id: activeShopId, p_movement_id: movementId, p_reason: reason })
    .then(function(res){
      /* The server's reply names the reversal rows; the local mirror
         refreshes from the next pull, but show the reversal at once. Each
         reversed[] entry carries the reversal's own movement id and the
         signed quantity (-original). */
      const orig = DB.movements.find(function(m){ return m.id === movementId; });
      if(orig){
        (res.reversed || []).forEach(function(rv){
          DB.movements.unshift({ id: rv.reversal_movement_id || uid('m'), productId: orig.productId, type: 'reversal', quantity: Number(rv.quantity) || 0, previousStock: null, newStock: (rv.new_stock != null ? Number(rv.new_stock) : null), reference: res.reference || '', note: reason, staffId: (loadMembership() && loadMembership().staffId) || null, relatedMovementId: movementId, createdAt: Date.now() });
        });
        /* One leg (the usual case): the server's new_stock is authoritative
           for this product in this branch. A transfer reversal has two
           legs in two branches — leave the local stock to the next pull. */
        if(res.reversed && res.reversed.length === 1 && res.reversed[0].new_stock != null){
          const p = prodById(orig.productId);
          if(p) p.stock = Number(res.reversed[0].new_stock);
        }
        save(); renderInventory();
      }
      toast(t('inventory.reversedDone'));
    })
    .catch(function(err){
      console.warn('[inventory] reverse_movement failed', err);
      toast(mapRpcError(err));
    });
}

/* ================= branch transfer ================= */

function openTransferModal(){
  if(deny('stock_manage')) return;
  if(shopBranchesCache.length < 2){ toast(t('sale.invalidBranch')); return; }
  const prodOpts = DB.products.filter(function(p){ return p.active; }).map(function(p){
    return '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + p.stock + ')</option>';
  }).join('');
  const branchOpts = function(selectedId){
    return shopBranchesCache.map(function(b){
      return '<option value="' + esc(b.id) + '"' + (b.id === selectedId ? ' selected' : '') + '>' + esc(b.name) + '</option>';
    }).join('');
  };
  openModal(
    '<header><h2>' + esc(t('inventory.transfer')) + '</h2><button class="btn icon-btn" type="button" data-close>✕</button></header>' +
    fieldHtml(t('products.productName'), '<select id="trProduct">' + prodOpts + '</select>') +
    '<div class="form-grid">' +
    fieldHtml(t('inventory.transferFrom'), '<select id="trFrom">' + branchOpts(activeBranchId) + '</select>') +
    fieldHtml(t('inventory.transferTo'), '<select id="trTo">' + branchOpts(shopBranchesCache.find(function(b){ return b.id !== activeBranchId; }).id) + '</select>') +
    '</div>' +
    fieldHtml(t('inventory.quantity'), '<input type="number" id="trQty" min="1" step="1" value="1">') +
    fieldHtml(t('inventory.reason'), '<input type="text" id="trNote">') +
    '<div class="form-actions"><button class="btn" type="button" data-close>' + esc(t('common.cancel')) + '</button>' +
    '<button class="btn primary" type="button" id="trSave">' + esc(t('common.save')) + '</button></div>'
  );
  document.getElementById('trSave').addEventListener('click', function(){
    if(deny('stock_manage')) return;
    const pid = document.getElementById('trProduct').value;
    const from = document.getElementById('trFrom').value;
    const to = document.getElementById('trTo').value;
    const qty = Math.max(1, parseInt(document.getElementById('trQty').value, 10) || 1);
    const note = document.getElementById('trNote').value.trim();
    if(from === to){ toast(t('sale.invalidBranch')); return; }
    const btn = document.getElementById('trSave');
    btn.disabled = true;
    sbRpc('transfer_stock', { p_shop_id: activeShopId, p_from_branch_id: from, p_to_branch_id: to, p_product_id: pid, p_qty: qty, p_note: (note || null) })
      .then(function(res){
        const p = prodById(pid);
        if(p && from === activeBranchId) p.stock = Number(res.source_stock_after);
        save(); closeModal(); renderInventory(); toast(t('inventory.transferDone'));
      })
      .catch(function(err){
        console.warn('[inventory] transfer_stock failed', err);
        toast(mapRpcError(err));
      })
      .finally(function(){ btn.disabled = false; });
  });
}

/* ================= suppliers ================= */

function renderSuppliers(){
  const list = document.getElementById('supplierList');
  if(!list) return;
  const sups = DB.suppliers || [];
  list.innerHTML = sups.length ? sups.map(function(s){
    return '<div class="list-row"><div class="avatar">' + esc((s.name || '?').slice(0, 1).toUpperCase()) + '</div>' +
      '<div class="grow"><strong>' + esc(s.name) + '</strong><small>' + esc([s.phone, s.email].filter(Boolean).join(' · ') || s.address || '') + '</small></div>' +
      '<button type="button" class="btn" data-supplier="' + s.id + '">' + esc(t('common.edit')) + '</button></div>';
  }).join('') : '<div class="empty"><p>' + esc(t('inventory.noHistory')) + '</p></div>';
  list.querySelectorAll('[data-supplier]').forEach(function(b){
    b.addEventListener('click', function(){ openSupplierForm(b.dataset.supplier); });
  });
}

function openSupplierForm(id){
  if(deny('stock_manage')) return;
  const s = id ? (DB.suppliers || []).find(function(x){ return x.id === id; }) : null;
  openModal(
    '<header><h2>' + esc(s ? s.name : t('inventory.suppliers')) + '</h2><button class="btn icon-btn" type="button" data-close>✕</button></header>' +
    fieldHtml(t('products.productName'), '<input type="text" id="supName" value="' + esc(s ? s.name : '') + '">') +
    '<div class="form-grid">' +
    fieldHtml(t('common.phone'), '<input type="tel" id="supPhone" value="' + esc(s ? s.phone : '') + '">') +
    fieldHtml('Email', '<input type="email" id="supEmail" value="' + esc(s ? s.email : '') + '">') +
    '</div>' +
    fieldHtml(t('common.address'), '<input type="text" id="supAddress" value="' + esc(s ? s.address : '') + '">') +
    fieldHtml(t('common.note'), '<input type="text" id="supNotes" value="' + esc(s ? s.notes : '') + '">') +
    '<div class="form-actions">' +
    (s ? '<button class="btn danger" type="button" id="supDelete" style="margin-right:auto">' + esc(t('common.delete')) + '</button>' : '') +
    '<button class="btn" type="button" data-close>' + esc(t('common.cancel')) + '</button>' +
    '<button class="btn primary" type="button" id="supSave">' + esc(t('common.save')) + '</button></div>'
  );
  document.getElementById('supSave').addEventListener('click', function(){
    if(deny('stock_manage')) return;
    const name = document.getElementById('supName').value.trim();
    if(!name){ toast(t('common.required')); return; }
    const data = { name: name, phone: document.getElementById('supPhone').value.trim(), email: document.getElementById('supEmail').value.trim(), address: document.getElementById('supAddress').value.trim(), notes: document.getElementById('supNotes').value.trim(), active: true };
    if(s) Object.assign(s, data);
    else (DB.suppliers = DB.suppliers || []).push(Object.assign({ id: uuidv4() }, data)); /* suppliers.id is uuid — uid('sup') text is rejected on push */
    save(); closeModal(); renderSuppliers(); toast(t('inventory.updated'));
  });
  const del = document.getElementById('supDelete');
  if(del) del.addEventListener('click', function(){
    if(deny('stock_manage')) return;
    if(!confirm(t('common.confirmDelete'))) return;
    DB.suppliers = DB.suppliers.filter(function(x){ return x.id !== s.id; });
    sbDelete('suppliers', s.id);
    save(); closeModal(); renderSuppliers(); toast(t('products.deleted'));
  });
}

/* ================= purchase orders ================= */

const PO_STATUS_LABEL = { draft: 'inventory.poDraft', ordered: 'inventory.poOrdered', partially_received: 'inventory.poPartial', received: 'inventory.poReceived', cancelled: 'inventory.poCancelled' };

function renderPurchaseOrders(){
  const list = document.getElementById('poList');
  if(!list) return;
  const pos = DB.purchaseOrders || [];
  list.innerHTML = pos.length ? pos.map(function(po){
    const sup = (DB.suppliers || []).find(function(s){ return s.id === po.supplierId; });
    const canReceive = can('stock_manage') && ['ordered','partially_received'].indexOf(po.status) >= 0;
    return '<div class="list-row"><div class="avatar">📦</div>' +
      '<div class="grow"><strong>' + esc(po.poNumber) + '</strong><small>' + esc(sup ? sup.name : '') + ' · ' + esc(t(PO_STATUS_LABEL[po.status] || 'inventory.poStatus')) + ' · ' + money(po.total) + '<br>' + fmtDate(po.orderDate) + '</small></div>' +
      (canReceive ? '<button type="button" class="btn primary" data-po-receive="' + po.id + '">' + esc(t('inventory.receive')) + '</button>' : '') +
      '<button type="button" class="btn" data-po="' + po.id + '">' + esc(t('common.edit')) + '</button></div>';
  }).join('') : '<div class="empty"><p>' + esc(t('inventory.noHistory')) + '</p></div>';
  list.querySelectorAll('[data-po]').forEach(function(b){
    b.addEventListener('click', function(){ openPoForm(b.dataset.po); });
  });
  list.querySelectorAll('[data-po-receive]').forEach(function(b){
    b.addEventListener('click', function(){ receivePo(b.dataset.poReceive); });
  });
}

function openPoForm(id){
  if(deny('stock_manage')) return;
  const po = id ? (DB.purchaseOrders || []).find(function(x){ return x.id === id; }) : null;
  const supOpts = (DB.suppliers || []).map(function(s){
    return '<option value="' + esc(s.id) + '"' + (po && po.supplierId === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>';
  }).join('');
  const prodOpts = DB.products.filter(function(p){ return p.active; }).map(function(p){
    return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>';
  }).join('');
  const lines = po ? (DB.purchaseOrderItems || []).filter(function(it){ return it.purchaseOrderId === po.id; }) : [];
  openModal(
    '<header><h2>' + esc(po ? po.poNumber : t('inventory.purchaseOrders')) + '</h2><button class="btn icon-btn" type="button" data-close>✕</button></header>' +
    fieldHtml(t('inventory.suppliers'), '<select id="poSupplier">' + supOpts + '</select>') +
    /* Status is server-driven (receive_po moves it to partially_received /
       received); the form only ever creates a draft or marks it ordered.
       An existing PO shows its status read-only so editing can never
       reset it to draft. */
    (po
      ? fieldHtml(t('inventory.poStatus'), '<input type="text" value="' + esc(t(PO_STATUS_LABEL[po.status] || 'inventory.poStatus')) + '" disabled>')
      : fieldHtml(t('inventory.poStatus'), '<select id="poStatus">' +
          ['draft','ordered'].map(function(st){ return '<option value="' + st + '">' + esc(t(PO_STATUS_LABEL[st])) + '</option>'; }).join('') + '</select>')) +
    '<div class="panel-head" style="margin-top:8px"><div><h2>' + esc(t('products.title')) + '</h2></div></div>' +
    '<div id="poLines">' + lines.map(function(it, i){
      return '<div class="form-grid" data-po-line="' + i + '">' +
        fieldHtml(t('products.productName'), '<select data-po-product>' + DB.products.filter(function(p){ return p.active; }).map(function(p){ return '<option value="' + esc(p.id) + '"' + (it.productId === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select>') +
        fieldHtml(t('inventory.quantity'), '<input type="number" data-po-qty min="1" step="1" value="' + it.quantity + '">') +
        fieldHtml(t('products.costPrice'), '<input type="number" data-po-cost min="0" step="any" value="' + it.unitCost + '">') +
        '</div>';
    }).join('') + '</div>' +
    '<button class="btn" type="button" id="poAddLine">＋ ' + esc(t('products.title')) + '</button>' +
    '<div class="form-actions" style="margin-top:12px">' +
    (po && po.status === 'draft' ? '<button class="btn danger" type="button" id="poDelete" style="margin-right:auto">' + esc(t('common.delete')) + '</button>' : '') +
    '<button class="btn" type="button" data-close>' + esc(t('common.cancel')) + '</button>' +
    '<button class="btn primary" type="button" id="poSave">' + esc(t('common.save')) + '</button></div>'
  );
  document.getElementById('poAddLine').addEventListener('click', function(){
    const wrap = document.getElementById('poLines');
    const div = document.createElement('div');
    div.className = 'form-grid'; div.setAttribute('data-po-line', String(wrap.children.length));
    div.innerHTML = fieldHtml(t('products.productName'), '<select data-po-product>' + prodOpts + '</select>') +
      fieldHtml(t('inventory.quantity'), '<input type="number" data-po-qty min="1" step="1" value="1">') +
      fieldHtml(t('products.costPrice'), '<input type="number" data-po-cost min="0" step="any" value="0">');
    wrap.appendChild(div);
  });
  document.getElementById('poSave').addEventListener('click', function(){
    if(deny('stock_manage')) return;
    const supId = document.getElementById('poSupplier').value || null;
    const statusEl = document.getElementById('poStatus');
    const status = po ? po.status : (statusEl ? statusEl.value : 'draft');
    const newLines = [];
    document.querySelectorAll('#poLines [data-po-line]').forEach(function(row){
      const pid = row.querySelector('[data-po-product]').value;
      const qty = Math.max(1, parseInt(row.querySelector('[data-po-qty]').value, 10) || 1);
      const cost = parseFloat(row.querySelector('[data-po-cost]').value) || 0;
      const p = prodById(pid);
      newLines.push({ id: uuidv4(), purchaseOrderId: po ? po.id : null, productId: pid, productName: p ? p.name : '', quantity: qty, unitCost: cost, receivedQty: 0, lineTotal: round2(qty * cost) }); /* purchase_order_items.id is uuid */
    });
    if(!newLines.length){ toast(t('common.required')); return; }
    const total = round2(newLines.reduce(function(s, l){ return s + l.lineTotal; }, 0));
    const saveLocal = function(poNumber){
      let savedPo = po;
      if(!savedPo){
        savedPo = { id: uuidv4(), poNumber: poNumber, supplierId: supId, status: status, orderDate: Date.now(), expectedDate: '', receivedDate: null, total: total, notes: '', createdBy: (loadMembership() && loadMembership().staffId) || null }; /* purchase_orders.id is uuid — uid('po') text is rejected on push and on receive_purchase_order */
        (DB.purchaseOrders = DB.purchaseOrders || []).push(savedPo);
      } else {
        savedPo.supplierId = supId; savedPo.status = status; savedPo.total = total;
      }
      newLines.forEach(function(l){ l.purchaseOrderId = savedPo.id; });
      DB.purchaseOrderItems = (DB.purchaseOrderItems || []).filter(function(it){ return it.purchaseOrderId !== savedPo.id; }).concat(newLines);
      save(); closeModal(); renderPurchaseOrders(); toast(t('inventory.updated'));
    };
    if(po) saveLocal(po.poNumber);
    else if(authSession && activeShopId){
      /* A draft PO gets its number from the server (next_doc_number) so
         two devices can never mint the same PO number. Offline, a local
         number is used and the server re-numbers it on the next sync. */
      sbRpc('next_doc_number', { p_shop_id: activeShopId, p_kind: 'po', p_prefix: (DB.settings.invoicePrefix || null) })
        .then(function(num){ saveLocal(num); })
        .catch(function(){ saveLocal('PO-' + new Date().getFullYear() + '-' + String(1000 + (DB.purchaseOrders || []).length + 1).slice(1)); });
    } else saveLocal('PO-' + new Date().getFullYear() + '-' + String(1000 + (DB.purchaseOrders || []).length + 1).slice(1));
  });
  const del = document.getElementById('poDelete');
  if(del) del.addEventListener('click', function(){
    if(deny('stock_manage')) return;
    if(!confirm(t('common.confirmDelete'))) return;
    DB.purchaseOrders = DB.purchaseOrders.filter(function(x){ return x.id !== po.id; });
    DB.purchaseOrderItems = (DB.purchaseOrderItems || []).filter(function(it){ return it.purchaseOrderId !== po.id; });
    sbDelete('purchase_orders', po.id);
    save(); closeModal(); renderPurchaseOrders(); toast(t('products.deleted'));
  });
}

/* Receive a PO (STEP 5 §8): the server adds the stock (weighted-average
   cost), marks lines received and moves the PO to received /
   partially_received. The local rows refresh from the next pull; the
   received quantities are shown at once from the reply. */
function receivePo(poId){
  if(deny('stock_manage')) return;
  const po = (DB.purchaseOrders || []).find(function(x){ return x.id === poId; });
  if(!po) return;
  const lines = (DB.purchaseOrderItems || []).filter(function(it){ return it.purchaseOrderId === poId; });
  const open = lines.filter(function(it){ return it.receivedQty < it.quantity; });
  if(!open.length){ toast(t('inventory.receiveDone')); return; }
  const payload = open.map(function(it){ return { purchase_order_item_id: it.id, qty: it.quantity - it.receivedQty }; });
  sbRpc('receive_purchase_order', { p_shop_id: activeShopId, p_po_id: poId, p_branch_id: activeBranchId, p_lines: payload, p_note: null })
    .then(function(res){
      po.status = res.status;
      if(res.status === 'received') po.receivedDate = Date.now();
      (res.lines || []).forEach(function(rl){
        const it = lines.find(function(x){ return x.id === rl.purchase_order_item_id; });
        /* The reply's received_qty is THIS receive only — add it to the
           running total, do not replace it. */
        if(it) it.receivedQty = (it.receivedQty || 0) + (Number(rl.received_qty) || 0);
      });
      save(); renderPurchaseOrders(); renderInventory(); toast(t('inventory.receiveDone'));
    })
    .catch(function(err){
      console.warn('[inventory] receive_purchase_order failed', err);
      toast(mapRpcError(err));
    });
}

/* ================= orders ================= */
