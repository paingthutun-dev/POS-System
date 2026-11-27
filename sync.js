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

function pushCloud(){
  if(!DB || !authSession) return Promise.resolve(false);
  return ensureShop().then(function(shopId){
    if(!shopId) return false; /* fail closed: never push rows with no shop */
    if(pendingWipe){
      return wipeCloud().then(function(){ pendingWipe = false; return pushCloud(); })
        .catch(function(){ setSyncStatus('fail'); return false; });
    }
    const jobs = [
      ['app_settings', [toAppSettingsRow(DB)], 'shop_id'],
      ['products', DB.products.map(toProductRow)],
      ['customers', DB.customers.map(toCustomerRow)],
      ['staff', DB.staff.map(toStaffRow)],
      ['orders', DB.orders.map(toOrderRow)],
      ['expenses', DB.expenses.map(toExpenseRow)],
      ['movements', DB.movements.map(toMovementRow)]
    ];
    let chain = Promise.resolve();
    jobs.forEach(function(job){
      chain = chain.then(function(){ return job[0] === 'products' ? sbUpsertProducts(job[1]) : sbUpsert(job[0], job[1], job[2]); });
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
      cloudReady = true;
      flushPendingPush();
      setSyncStatus('ok');
      applyLang();
      retryPendingPhotos();
    } else {
      const foreign = discardForeignLocal();
      if(foreign || !loadOwner()) rekeyLocalDb();
      persistLocal();
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
/* Wipe the cloud tables (used by Restore demo data) so stale rows cannot come back on the next load.
   Every table is attempted even if one fails; the failure is reported only at the end,
   so a single bad table cannot silently stop the rest of the wipe. */

function wipeCloud(){
  if(!authSession || !activeShopId) return Promise.resolve();
  let failed = false;
  let chain = Promise.resolve();
  SB_TABLES.forEach(function(tb){
    chain = chain.then(function(){
      /* shop_id alone scopes the wipe to this shop. The old
         id=neq.__none__ trick cannot be used here — app_settings has a
         uuid id, and comparing it to '__none__' is a 400. */
      return fetch(SB_URL + '/rest/v1/' + tb + '?shop_id=eq.' + encodeURIComponent(activeShopId), {
        method: 'DELETE',
        headers: Object.assign(sbHeaders(false), { 'Prefer': 'return=minimal' })
      }).then(function(r){ if(!r.ok) failed = true; }).catch(function(){ failed = true; });
    });
  });
  return chain.then(function(){ if(failed) throw new Error('wipe failed'); });
}
