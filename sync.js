/* sync.js — split from pos-system.html 1.0.5 (mechanical split, no logic changes). Pull / push / schedule / status / wipe (current sync engine). */
'use strict';

let cloudReady = false;   /* false until the first pull finishes, so we never push stale local data over the cloud */

let pushPending = false;  /* a save() made before the first pull finished — flush it once cloudReady is true, never drop it */

let pendingWipe = false;  /* true when Restore demo data asked for a clean cloud before the next push */

let syncTimer = null;

let syncState = 'offline';

function pullCloud(){
  return Promise.all(SB_TABLES.map(sbGet)).then(function(results){
    const out = {};
    SB_TABLES.forEach(function(tb, i){ out[tb] = results[i] || []; });
    return out;
  });
}

/* Pushed-ids watermark: rows a role may INSERT but not UPDATE (a
   cashier's orders / expenses / movements) are sent only while they are
   new. Once a row is pushed, its id is recorded here (per shop) so a
   later push never re-sends it as an upsert — a re-send would be an
   UPDATE and RLS would reject it with 403, failing the whole chain.
   Cleared on shop switch, restore, and wipe. */
const PUSHED_KEY = 'posHtmlPushed.v1';
function loadPushed(){
  try{
    const d = JSON.parse(localStorage.getItem(PUSHED_KEY) || 'null');
    if(d && d.shopId === activeShopId && d.ids && typeof d.ids === 'object') return { orders: d.ids.orders || [], expenses: d.ids.expenses || [], movements: d.ids.movements || [] };
  }catch(e){}
  return { orders: [], expenses: [], movements: [] };
}
function savePushed(ids){
  try{ localStorage.setItem(PUSHED_KEY, JSON.stringify({ shopId: activeShopId, ids: ids })); }catch(e){}
}
function clearPushed(){ try{ localStorage.removeItem(PUSHED_KEY); }catch(e){} }

function pushCloud(){
  if(!DB || !authSession) return Promise.resolve(false);
  return ensureShop().then(function(shopId){
    if(!shopId) return false; /* fail closed: never push rows with no shop */
    if(pendingWipe){
      return wipeShopData().then(function(){ pendingWipe = false; return pushCloud(); })
        .catch(function(){ setSyncStatus('fail'); return false; });
    }
    /* Role-aware jobs: a role only pushes the tables it may write. Without
       this, the chain would fail at the first forbidden table
       (app_settings for a cashier) and no order would ever sync —
       breaking "everyone sells". Insert-only tables send new rows only
       (see the watermark above); the rest send everything, as before. */
    const pushed = loadPushed();
    const isNew = function(table, id){ return pushed[table].indexOf(id) < 0; };
    const jobs = [];
    if(can('settings_shop')) jobs.push({ table:'app_settings', rows:[toAppSettingsRow(DB)], conflict:'shop_id', mark:null });
    if(can('products_manage')) jobs.push({ table:'products', rows:DB.products.map(toProductRow), conflict:'id', mark:null });
    jobs.push({ table:'customers', rows:DB.customers.map(toCustomerRow), conflict:'id', mark:null });
    if(can('staff_manage')) jobs.push({ table:'staff', rows:DB.staff.map(toStaffRow), conflict:'id', mark:null });
    jobs.push({ table:'orders', rows:(can('orders_manage') ? DB.orders : DB.orders.filter(function(o){ return isNew('orders', o.id); })).map(toOrderRow), conflict:'id', mark:can('orders_manage') ? null : 'orders' });
    jobs.push({ table:'expenses', rows:(can('expenses_manage') ? DB.expenses : DB.expenses.filter(function(e){ return isNew('expenses', e.id); })).map(toExpenseRow), conflict:'id', mark:can('expenses_manage') ? null : 'expenses' });
    jobs.push({ table:'movements', rows:(can('stock_manage') ? DB.movements : DB.movements.filter(function(m){ return isNew('movements', m.id); })).map(toMovementRow), conflict:'id', mark:can('stock_manage') ? null : 'movements' });
    let chain = Promise.resolve();
    jobs.forEach(function(job){
      chain = chain.then(function(){
        const send = job.table === 'products' ? sbUpsertProducts(job.rows) : sbUpsert(job.table, job.rows, job.conflict);
        return send.then(function(){
          /* Record the pushed ids immediately: if a later job fails, the
             rows already sent are not re-sent as updates next time. */
          if(job.mark){
            job.rows.forEach(function(r){ if(pushed[job.mark].indexOf(r.id) < 0) pushed[job.mark].push(r.id); });
            savePushed(pushed);
          }
        });
      });
    });
    return chain.then(function(){ setSyncStatus('ok'); saveOwner(authUid()); return true; }).catch(function(){ setSyncStatus('fail'); return false; });
  });
}

function schedulePush(){
  if(!cloudReady){ pushPending = true; return; }
  clearTimeout(syncTimer);
  syncTimer = setTimeout(function(){ pushCloud(); }, 800);
}

function flushPendingPush(){
  if(pushPending){ pushPending = false; schedulePush(); }
}

function syncTime(){
  const d = new Date();
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

function setSyncStatus(state){
  syncState = state;
  const el = document.getElementById('syncStatus');
  if(!el) return;
  if(state === 'syncing') el.textContent = t('sync.syncing');
  else if(state === 'ok') el.textContent = t('sync.synced', {time: syncTime()});
  else if(state === 'offline') el.textContent = t('sync.offline');
  else el.textContent = t('sync.failed');
}

function initialSync(){
  if(!authSession) return;
  setSyncStatus('syncing');
  pullCloud().then(function(cloud){
    if(cloudHasRows(cloud)){
      DB = cloudToLocal(cloud);
      persistLocal();
      saveOwner(authUid());
      saveLocalShopId(activeShopId);
      cloudReady = true;
      flushPendingPush();
      setSyncStatus('ok');
      applyLang();
      retryPendingPhotos();
    } else {
      const foreign = discardForeignLocal();
      if(foreign || !loadOwner()) rekeyLocalDb();
      persistLocal();
      saveLocalShopId(activeShopId);
      cloudReady = true;
      pushPending = false; /* the direct push below uploads everything, pending included */
      pushCloud();
      retryPendingPhotos();
    }
  }).catch(function(){
    if(discardForeignLocal()){ rekeyLocalDb(); persistLocal(); }
    cloudReady = true;
    flushPendingPush();
    setSyncStatus('offline');
    retryPendingPhotos();
  });
}
/* Wipe this shop's cloud data through the audited wipe_shop_data() RPC
   (owner/admin only, keeps the shop shell + audit log) — the old
   client-side DELETE-every-table wipe is gone. The RPC does NOT delete
   Storage photos, so the app deletes this shop's photo objects first
   (best effort, never blocking the wipe). */
function wipeShopData(){
  if(!authSession || !activeShopId) return Promise.reject(new Error('no shop'));
  const deletes = (DB.products || []).filter(function(p){ return p.photo; }).map(function(p){ return sbStorageDelete(photoPathFromUrl(p.photo)); });
  return Promise.all(deletes.map(function(pr){ return pr.catch(function(){}); })).then(function(){
    return sbRpc('wipe_shop_data', { p_shop_id: activeShopId });
  });
}
