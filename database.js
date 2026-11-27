/* database.js — split from pos-system.html 1.0.5 (mechanical split, no logic changes). Local data (seed/load/save) + Supabase transport + row mapping + photos. */
'use strict';

let DB = null;

function seedData(){
  const products = [
    {id:'p1', name:'Nova X1 128GB', sku:'PH-NX1-128', barcode:'885001000001', category:'Phones', brand:'Nova', costPrice:12900, sellingPrice:15900, discountPrice:14900, stock:8, minStock:3, unit:'pc', description:'OLED smartphone, 128GB, dual SIM', supplier:'Bangkok Mobile Supply', active:true},
    {id:'p2', name:'GaN Fast Charger 30W', sku:'CH-GAN-30', barcode:'885001000002', category:'Chargers', brand:'Volt', costPrice:380, sellingPrice:690, discountPrice:null, stock:24, minStock:8, unit:'pc', description:'Compact 30W USB-C fast charger', supplier:'Volt Distribution', active:true},
    {id:'p3', name:'AirBeat TWS Earbuds', sku:'EP-AB-TWS', barcode:'885001000003', category:'Earphones', brand:'AirBeat', costPrice:720, sellingPrice:1290, discountPrice:1090, stock:6, minStock:5, unit:'pc', description:'Wireless earbuds with charging case', supplier:'Audio Lane', active:true},
    {id:'p4', name:'PowerGo 10K', sku:'PB-PG-10K', barcode:'885001000004', category:'Power Banks', brand:'PowerGo', costPrice:590, sellingPrice:990, discountPrice:null, stock:4, minStock:5, unit:'pc', description:'10,000mAh fast-charge power bank', supplier:'PowerGo Thailand', active:true},
    {id:'p5', name:'Braided USB-C Cable 1m', sku:'CB-USBC-1M', barcode:'885001000005', category:'Cables', brand:'Loop', costPrice:95, sellingPrice:249, discountPrice:null, stock:38, minStock:10, unit:'pc', description:'Durable USB-C to USB-C cable', supplier:'Loop Accessories', active:true},
    {id:'p6', name:'Shield Case — White', sku:'CS-SH-WHT', barcode:'885001000006', category:'Cases', brand:'Shield', costPrice:180, sellingPrice:490, discountPrice:390, stock:12, minStock:5, unit:'pc', description:'Shock-resistant protective phone case', supplier:'Shield Works', active:true},
    {id:'p7', name:'Clear Glass Protector', sku:'SP-GL-CLR', barcode:'885001000007', category:'Screen Protectors', brand:'ClearGuard', costPrice:80, sellingPrice:290, discountPrice:null, stock:0, minStock:8, unit:'pc', description:'Clear hybrid glass screen protector', supplier:'ClearGuard', active:true},
    {id:'p8', name:'Fold Phone Stand', sku:'AC-ST-FLD', barcode:'885001000008', category:'Accessories', brand:'DeskMate', costPrice:140, sellingPrice:390, discountPrice:null, stock:17, minStock:5, unit:'pc', description:'Compact folding phone stand', supplier:'DeskMate', active:true}
  ];
  const customers = [
    {id:'c1', name:'Mali K.', phone:'081-234-6789', email:'mali@example.com', address:'Bangkok', notes:'Prefers digital receipt'},
    {id:'c2', name:'Narin P.', phone:'089-144-2380', email:'narin@example.com', address:'Nonthaburi', notes:''},
    {id:'c3', name:'Suda T.', phone:'086-552-0103', email:'suda@example.com', address:'Bangkok', notes:'Business customer'},
    {id:'c4', name:'Walk-in customer', phone:'', email:'', address:'', notes:'Default counter sale'}
  ];
  const staff = [
    {id:'s1', name:'Araya S.', role:'Admin', email:'araya@northstar.demo', active:true},
    {id:'s2', name:'Kiet W.', role:'Manager', email:'kiet@northstar.demo', active:true},
    {id:'s3', name:'Mina R.', role:'Cashier', email:'mina@northstar.demo', active:true}
  ];
  const orders = [
    {id:'o1', orderNumber:'NS-2601001', customerId:'c1', cashier:'Mina R.', subtotal:1788, discount:0, tax:125.16, total:1913.16, paymentMethod:'QR Payment', amountReceived:1913.16, changeAmount:0, status:'Completed', createdAt:atDay(0,10,30),
     items:[{productId:'p2', productName:'GaN Fast Charger 30W', sku:'CH-GAN-30', quantity:1, unitPrice:690, discount:0, lineTotal:690},
            {productId:'p3', productName:'AirBeat TWS Earbuds', sku:'EP-AB-TWS', quantity:1, unitPrice:1098, discount:0, lineTotal:1098}]},
    {id:'o2', orderNumber:'NS-2601002', customerId:'c4', cashier:'Mina R.', subtotal:1249, discount:100, tax:80.43, total:1229.43, paymentMethod:'Cash', amountReceived:1500, changeAmount:270.57, status:'Completed', createdAt:atDay(0,11,45),
     items:[{productId:'p5', productName:'Braided USB-C Cable 1m', sku:'CB-USBC-1M', quantity:2, unitPrice:249, discount:0, lineTotal:498},
            {productId:'p8', productName:'Fold Phone Stand', sku:'AC-ST-FLD', quantity:1, unitPrice:390, discount:0, lineTotal:390},
            {productId:'p6', productName:'Shield Case — White', sku:'CS-SH-WHT', quantity:1, unitPrice:361, discount:0, lineTotal:361}]},
    {id:'o3', orderNumber:'NS-2601003', customerId:'c2', cashier:'Kiet W.', subtotal:15880, discount:500, tax:1076.60, total:16456.60, paymentMethod:'Card', amountReceived:16456.60, changeAmount:0, status:'Completed', createdAt:atDay(1,15,20),
     items:[{productId:'p1', productName:'Nova X1 128GB', sku:'PH-NX1-128', quantity:1, unitPrice:14900, discount:0, lineTotal:14900},
            {productId:'p4', productName:'PowerGo 10K', sku:'PB-PG-10K', quantity:1, unitPrice:980, discount:0, lineTotal:980}]},
    {id:'o4', orderNumber:'NS-2601004', customerId:'c3', cashier:'Mina R.', subtotal:1280, discount:0, tax:89.60, total:1369.60, paymentMethod:'Bank Transfer', amountReceived:1369.60, changeAmount:0, status:'Completed', createdAt:atDay(2,13,10),
     items:[{productId:'p3', productName:'AirBeat TWS Earbuds', sku:'EP-AB-TWS', quantity:1, unitPrice:1090, discount:100, lineTotal:990},
            {productId:'p7', productName:'Clear Glass Protector', sku:'SP-GL-CLR', quantity:1, unitPrice:290, discount:0, lineTotal:290}]}
  ];
  const expenses = [
    {id:'e1', name:'Store supplies', category:'Supplies', amount:840, paymentMethod:'Cash', note:'Packaging and receipt rolls', date:atDay(1,9,0)},
    {id:'e2', name:'Electricity', category:'Electricity', amount:3200, paymentMethod:'Bank Transfer', note:'Monthly utility bill', date:atDay(3,9,0)},
    {id:'e3', name:'Local delivery', category:'Transportation', amount:460, paymentMethod:'Cash', note:'Same-day stock pickup', date:atDay(0,9,0)},
    {id:'e4', name:'Social ads', category:'Marketing', amount:1500, paymentMethod:'Card', note:'Weekend campaign', date:atDay(4,9,0)}
  ];
  const movements = [
    {id:'m1', productId:'p1', type:'sale', quantity:-1, previousStock:9, newStock:8, reference:'NS-2601003', note:'Sale completed', createdAt:atDay(1,15,20)},
    {id:'m2', productId:'p4', type:'sale', quantity:-1, previousStock:5, newStock:4, reference:'NS-2601003', note:'Sale completed', createdAt:atDay(1,15,20)},
    {id:'m3', productId:'p7', type:'sale', quantity:-1, previousStock:1, newStock:0, reference:'NS-2601004', note:'Sale completed', createdAt:atDay(2,13,10)},
    {id:'m4', productId:'p5', type:'stock_in', quantity:20, previousStock:18, newStock:38, reference:'STK-26041', note:'Supplier delivery', createdAt:atDay(5,10,0)},
    {id:'m5', productId:'p3', type:'adjustment', quantity:1, previousStock:5, newStock:6, reference:'ADJ-26009', note:'Count correction', createdAt:atDay(4,10,0)}
  ];
  return {
    settings: { storeName:'Mercury Mobile Accessories', address:'Central Bangkok', phone:'02-555-0188', currency:'THB', lang:'my', taxRate:7, receiptSize:'80mm' },
    products: products, customers: customers, staff: staff, orders: orders, expenses: expenses, movements: movements,
    nextOrderSeq: 5
  };
}

function persistLocal(){
  try{ localStorage.setItem(KEY, JSON.stringify(DB)); }catch(e){}
}

function save(){
  persistLocal();
  schedulePush();
  retryPendingPhotos(); /* a pending photo upload is retried on the next save when online */
}

function load(){
  try{
    const raw = localStorage.getItem(KEY);
    if(raw){ const d = JSON.parse(raw); if(d && d.products && d.settings) return d; }
  }catch(e){}
  return null;
}

/* ================= Supabase cloud sync (plain fetch, no libraries) ================= */
/* Offline-first: localStorage is the source of truth on this device; the cloud is
   a shared copy. If Supabase is unreachable, everything keeps working locally
   and the next save retries the push. */

const SB_URL = 'https://lvvulqjawnowqhiulmow.supabase.co';

const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx2dnVscWphd25vd3FoaXVsbW93Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU1MzU2MDksImV4cCI6MjExMTExMTYwOX0.nB-3sc9m938ZC6tex0xUsOB69hQyj3dwmb9v2deavFA';

const SB_TABLES = ['products','customers','staff','orders','expenses','movements','app_settings'];

function sbHeaders(json){
  const h = { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + (authSession ? authSession.access_token : SB_KEY) };
  if(json) h['Content-Type'] = 'application/json';
  return h;
}

/* Call a Supabase RPC (POST /rest/v1/rpc/<fn>). The function returns its
   value as JSON (a text return comes back as a JSON string). */
function sbRpc(fn, params){
  if(!authSession) return Promise.reject(new Error('no session'));
  return fetch(SB_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: sbHeaders(true),
    body: JSON.stringify(params || {})
  }).then(function(r){
    if(r.status === 401) handleAuthError(401);
    else if(r.status === 403) handleAuthError(403);
    if(!r.ok) return r.text().then(function(t){ throw new Error('rpc ' + fn + ' ' + r.status + ' ' + (t || '')); });
    return r.json();
  });
}

/* Pull one table, ALWAYS scoped to this shop. There is no unfiltered
   fallback: if the shop is not resolved (offline, or resolution failed),
   the pull fails closed — the app keeps its local data and never fetches
   rows it has no right to see. */
function sbGet(table){
  if(!authSession) return Promise.reject(new Error('no session'));
  return ensureShop().then(function(shopId){
    if(!shopId) throw new Error('no shop resolved');
    /* Cashiers read the products_public view, never the products table:
       the view has no cost_price column, so nothing downstream can leak
       it. The view carries shop_id, so the same shop filter applies. */
    const source = (table === 'products' && !can('cost_prices')) ? 'products_public' : table;
    return fetch(SB_URL + '/rest/v1/' + source + '?select=*&order=id&limit=1000&shop_id=eq.' + encodeURIComponent(shopId), { headers: sbHeaders(false) })
      .then(function(r){
        if(r.status === 401){ handleAuthError(401); throw new Error('sb 401'); }
        if(r.status === 403){ handleAuthError(403); throw new Error('sb 403'); }
        if(!r.ok) throw new Error('sb ' + r.status);
        return r.json();
      });
  });
}

function sbUpsert(table, rows, conflict){
  if(!authSession) return Promise.resolve();
  if(!rows.length) return Promise.resolve();
  return fetch(SB_URL + '/rest/v1/' + table + '?on_conflict=' + encodeURIComponent(conflict || 'id'), {
    method: 'POST',
    headers: Object.assign(sbHeaders(true), { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows)
  }).then(function(r){
    if(r.status === 401){ handleAuthError(401); throw new Error('sb 401'); }
    if(r.status === 403){ handleAuthError(403); throw new Error('sb 403'); }
    if(!r.ok) throw new Error('sb ' + r.status);
  });
}
/* The `photo` column on products holds the public Storage URL of the photo
   (SQL: alter table products add column if not exists photo text;). Until
   that runs, PostgREST rejects the upsert with 400 PGRST204 "Could not find
   the 'photo' column". Retry once WITHOUT photo and remember unsupported
   for this session, so a missing column can never break the products sync.
   Re-detected on the next app start, so photo URLs start syncing once the
   SQL is run. */

let PHOTO_SUPPORTED = true;

function sbUpsertProducts(rows){
  if(!authSession) return Promise.resolve();
  if(!rows.length) return Promise.resolve();
  const send = function(list){
    return fetch(SB_URL + '/rest/v1/products?on_conflict=id', {
      method: 'POST',
      headers: Object.assign(sbHeaders(true), { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(list)
    });
  };
  const stripPhoto = function(list){ return list.map(function(r){ const c = Object.assign({}, r); delete c.photo; return c; }); };
  if(!PHOTO_SUPPORTED) return send(stripPhoto(rows)).then(function(r){
    if(r.status === 401){ handleAuthError(401); throw new Error('sb 401'); }
    if(r.status === 403){ handleAuthError(403); throw new Error('sb 403'); }
    if(!r.ok) throw new Error('sb ' + r.status);
  });
  return send(rows).then(function(r){
    if(r.ok) return;
    if(r.status === 401){ handleAuthError(401); throw new Error('sb 401'); }
    if(r.status === 403){ handleAuthError(403); throw new Error('sb 403'); }
    return r.text().then(function(txt){
      if(r.status === 400 && txt && txt.indexOf('photo') >= 0){
        PHOTO_SUPPORTED = false;
        return send(stripPhoto(rows)).then(function(r2){ if(!r2.ok) throw new Error('sb ' + r2.status); });
      }
      throw new Error('sb ' + r.status);
    });
  });
}

function sbDelete(table, id){
  if(!authSession || !activeShopId) return;
  fetch(SB_URL + '/rest/v1/' + table + '?id=eq.' + encodeURIComponent(id) + '&shop_id=eq.' + encodeURIComponent(activeShopId), {
    method: 'DELETE',
    headers: Object.assign(sbHeaders(false), { 'Prefer': 'return=minimal' })
  }).catch(function(){});
}
/* Product photos in Supabase Storage (bucket `product-photos`, public).
   Setup the user runs once (dashboard + SQL):
     1. Dashboard → Storage → New bucket `product-photos`, Public.
     2. Storage policies on storage.objects for authenticated users
        (insert / update / delete where bucket_id = 'product-photos'),
        plus a public read policy.
     3. alter table products add column if not exists photo text;
   Until the bucket/policies exist, uploads fail and the photo stays local
   as a pending data URI (p.photoPending) — retried on the next app start
   and on the next save. The DB column only ever receives a public URL
   (or null), never a data URI. */

const PHOTO_BUCKET = 'product-photos';

function storagePhotoUrl(path){ return SB_URL + '/storage/v1/object/public/' + PHOTO_BUCKET + '/' + path; }

function photoPathFromUrl(url){
  const pre = SB_URL + '/storage/v1/object/public/' + PHOTO_BUCKET + '/';
  return (url && url.indexOf(pre) === 0) ? url.slice(pre.length) : '';
}

function sbStorageDelete(path){
  if(!authSession || !path) return Promise.resolve();
  return fetch(SB_URL + '/storage/v1/object/' + PHOTO_BUCKET + '/' + path, {
    method: 'DELETE', headers: sbHeaders(false)
  }).catch(function(){});
}

function dataUriToBlob(uri){
  return fetch(uri).then(function(r){ return r.blob(); });
}
/* Upload one product's pending photo. On success the old object is deleted,
   p.photo becomes the public URL and the pending data URI is cleared, then
   the URL is pushed to the cloud. On failure the pending photo stays local
   for a later retry. Never throws. */

let photoRetryRunning = false;

const photoUploading = {}; /* product id -> true while its upload is in flight */

function uploadProductPhoto(p){
  if(!p || !p.photoPending || !authSession || photoUploading[p.id]) return Promise.resolve(false);
  photoUploading[p.id] = true;
  const oldUrl = p.photo || '';
  const path = p.id + '-' + Date.now().toString(36) + Math.floor(Math.random()*1296).toString(36) + '.jpg';
  return dataUriToBlob(p.photoPending).then(function(blob){
    return fetch(SB_URL + '/storage/v1/object/' + PHOTO_BUCKET + '/' + path, {
      method: 'POST',
      headers: Object.assign(sbHeaders(false), { 'Content-Type': 'image/jpeg' }),
      body: blob
    }).then(function(r){ if(!r.ok) throw new Error('upload ' + r.status); });
  }).then(function(){
    const oldPath = photoPathFromUrl(oldUrl);
    if(oldPath && oldPath !== path) sbStorageDelete(oldPath);
    p.photo = storagePhotoUrl(path);
    p.photoPending = '';
    persistLocal();
    if(curView === 'pos' || curView === 'products' || curView === 'inventory') renderCurrent();
    schedulePush();
    return true;
  }).catch(function(){ return false; })
  .then(function(ok){ delete photoUploading[p.id]; return ok; });
}
/* Retry every pending photo upload (next app start, next save). Sequential,
   one at a time; a no-op when offline, signed out, or nothing is pending. */

function retryPendingPhotos(){
  if(photoRetryRunning || !authSession || !DB) return;
  const pending = DB.products.filter(function(p){ return p.photoPending && !photoUploading[p.id]; });
  if(!pending.length) return;
  photoRetryRunning = true;
  let chain = Promise.resolve();
  pending.forEach(function(p){
    chain = chain.then(function(){ return uploadProductPhoto(p); });
  });
  chain.then(function(){ photoRetryRunning = false; });
}

function toISO(ms){ return new Date(ms || Date.now()).toISOString(); }

function fromTS(s){ return s ? new Date(s).getTime() : 0; }

/* local (camelCase) -> Supabase row (snake_case) */

/* Stamp the shop (and, on branch-scoped rows, the active branch) on a row
   before it goes to the cloud. owner_id is still stamped too: the column
   exists on the legacy tables and the pre-Stage-2 policy still reads it.
   updated_at is set on every upsert so delta sync can tell what changed. */
function withShop(row, branchScoped){
  const u = authUid();
  if(u) row.owner_id = u;
  if(activeShopId) row.shop_id = activeShopId;
  if(branchScoped && activeBranchId) row.branch_id = activeBranchId;
  row.updated_at = new Date().toISOString();
  return row;
}

function toProductRow(p){
  const row = withShop({ id:p.id, name:p.name, sku:p.sku || null, barcode:p.barcode || null, category:p.category, brand:p.brand || null, selling_price:p.sellingPrice || 0, discount_price:(p.discountPrice == null ? null : p.discountPrice), stock:p.stock || 0, min_stock:p.minStock || 0, unit:p.unit || 'pc', description:p.description || null, supplier:p.supplier || null, active:(p.active !== false), photo:((p.photo && p.photo.indexOf('data:') === 0) ? null : (p.photo || null)) }, false);
  /* Defence in depth: a cashier never sends a cost price (they cannot save
     a product at all — §3 — and the push skips products for them; this
     makes sure a stale local cost can never overwrite the cloud value). */
  if(can('cost_prices')) row.cost_price = p.costPrice || 0;
  return row;
}

function toCustomerRow(c){ return withShop({ id:c.id, name:c.name, phone:c.phone || null, email:c.email || null, address:c.address || null, notes:c.notes || null }, false); }

function toStaffRow(m){ return withShop({ id:m.id, name:m.name, role:m.role, email:m.email || null, active:(m.active !== false), auth_uid:m.authUid || null, branch_id:m.branchId || null }, false); }

function toOrderRow(o){ return withShop({ id:o.id, order_number:o.orderNumber, customer_id:o.customerId || null, cashier:o.cashier || null, staff_id:o.staffId || null, subtotal:o.subtotal || 0, discount:o.discount || 0, tax:o.tax || 0, total:o.total || 0, payment_method:o.paymentMethod || null, amount_received:o.amountReceived || 0, change_amount:o.changeAmount || 0, status:o.status || 'Completed', items:o.items || [], created_at:toISO(o.createdAt) }, true); }

function toExpenseRow(e){ return withShop({ id:e.id, name:e.name, category:e.category, amount:e.amount || 0, payment_method:e.paymentMethod || null, note:e.note || null, date:toISO(e.date) }, true); }

function toMovementRow(m){ return withShop({ id:m.id, product_id:m.productId, type:m.type, quantity:m.quantity || 0, previous_stock:(m.previousStock == null ? null : m.previousStock), new_stock:(m.newStock == null ? null : m.newStock), reference:m.reference || null, note:m.note || null, created_at:toISO(m.createdAt) }, true); }
/* The shop's settings live in app_settings now (one row per shop, keyed by
   shop_id — upserted on shop_id, so no id is needed). The legacy `settings`
   table is frozen: the app never writes it again. No next_order_seq here —
   app_settings has no such column, and order numbers come from the server. */

function toAppSettingsRow(db){ const s = db.settings; return { shop_id: activeShopId, store_name:s.storeName, address:s.address || null, phone:s.phone || null, currency:s.currency || 'THB', lang:s.lang || 'my', tax_rate:(s.taxRate == null ? 0 : s.taxRate), receipt_size:s.receiptSize || '80mm', updated_at:new Date().toISOString() }; }

/* Supabase row (snake_case) -> local (camelCase) */

function fromProductRow(r){ return { id:r.id, name:r.name, sku:r.sku || '', barcode:r.barcode || '', category:r.category, brand:r.brand || '', costPrice:Number(r.cost_price) || 0, sellingPrice:Number(r.selling_price) || 0, discountPrice:(r.discount_price == null ? null : Number(r.discount_price)), stock:Number(r.stock) || 0, minStock:Number(r.min_stock) || 0, unit:r.unit || 'pc', description:r.description || '', supplier:r.supplier || '', active:(r.active !== false), photo:((r.photo && r.photo.indexOf('data:') === 0) ? '' : (r.photo || '')) }; }

function fromCustomerRow(r){ return { id:r.id, name:r.name, phone:r.phone || '', email:r.email || '', address:r.address || '', notes:r.notes || '' }; }

function fromStaffRow(r){ return { id:r.id, name:r.name, role:r.role, email:r.email || '', active:(r.active !== false), authUid:r.auth_uid || '', branchId:r.branch_id || null }; }

function fromOrderRow(r){ return { id:r.id, orderNumber:r.order_number, customerId:r.customer_id || '', cashier:r.cashier || '', staffId:r.staff_id || null, subtotal:Number(r.subtotal) || 0, discount:Number(r.discount) || 0, tax:Number(r.tax) || 0, total:Number(r.total) || 0, paymentMethod:r.payment_method || '', amountReceived:Number(r.amount_received) || 0, changeAmount:Number(r.change_amount) || 0, status:r.status || 'Completed', items:r.items || [], createdAt:fromTS(r.created_at) }; }

function fromExpenseRow(r){ return { id:r.id, name:r.name, category:r.category, amount:Number(r.amount) || 0, paymentMethod:r.payment_method || '', note:r.note || '', date:fromTS(r.date) }; }

function fromMovementRow(r){ return { id:r.id, productId:r.product_id, type:r.type, quantity:Number(r.quantity) || 0, previousStock:(r.previous_stock == null ? null : Number(r.previous_stock)), newStock:(r.new_stock == null ? null : Number(r.new_stock)), reference:r.reference || '', note:r.note || '', createdAt:fromTS(r.created_at) }; }

function cloudHasRows(cloud){
  /* app_settings does not count: it is a singleton config row (created by
     create_shop / the migration), not shop data. A new shop's cloud holds
     only app_settings — that is still "empty", and the local demo seed is
     pushed up. */
  return SB_TABLES.some(function(tb){ return tb !== 'app_settings' && cloud[tb] && cloud[tb].length > 0; });
}

function cloudToLocal(cloud){
  /* The shop's settings row in app_settings (keyed by shop_id); fall back
     to the first row, then to the local settings. */
  const s = (cloud.app_settings && (cloud.app_settings.find(function(r){ return r.shop_id === activeShopId; }) || cloud.app_settings[0])) || null;
  return {
    settings: s ? { storeName:s.store_name || '', address:s.address || '', phone:s.phone || '', currency:s.currency || 'THB', lang:s.lang || 'my', taxRate:Number(s.tax_rate) || 0, receiptSize:s.receipt_size || '80mm' }
                : { storeName:DB.settings.storeName, address:DB.settings.address, phone:DB.settings.phone, currency:DB.settings.currency, lang:DB.settings.lang, taxRate:DB.settings.taxRate, receiptSize:DB.settings.receiptSize },
    products: cloud.products.map(function(r){
      const pr = fromProductRow(r);
      /* A photo still waiting to upload (offline, or bucket not set up yet)
         lives only on this device — carry it over the pull so the retry on
         app start can still upload it. The cloud URL (if any) stays in
         pr.photo and is replaced once the pending upload succeeds. */
      const local = DB && DB.products ? DB.products.find(function(x){ return x.id === pr.id; }) : null;
      if(local && local.photoPending) pr.photoPending = local.photoPending;
      return pr;
    }),
    customers: cloud.customers.map(fromCustomerRow),
    staff: cloud.staff.map(fromStaffRow),
    orders: cloud.orders.map(fromOrderRow),
    expenses: cloud.expenses.map(fromExpenseRow),
    movements: cloud.movements.map(fromMovementRow),
    nextOrderSeq: (typeof DB.nextOrderSeq === 'number' ? DB.nextOrderSeq : 5)
  };
}
