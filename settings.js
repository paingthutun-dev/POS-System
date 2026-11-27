/* settings.js — split from pos-system.html 1.0.5 (mechanical split, no logic changes). Customers, settings, staff form, backup / restore, hardware. */
'use strict';

const DRAWER_HW_KEY = 'posHtmlHardware.v1';

const DRAWER_KICK = new Uint8Array([0x1B, 0x70, 0x00, 0x19, 0xFA]);

let hw = loadHardware();

let drawerDevice = null, drawerOutEndpoint = 0, drawerKickedOrders = {};

function loadHardware(){
  try{
    const d = JSON.parse(localStorage.getItem(DRAWER_HW_KEY) || 'null');
    if(d && typeof d === 'object') return { autoDrawer: !!d.autoDrawer, printer: (d.printer && typeof d.printer === 'object') ? d.printer : null };
  }catch(e){}
  return { autoDrawer: false, printer: null };
}

function saveHardware(){
  try{ localStorage.setItem(DRAWER_HW_KEY, JSON.stringify(hw)); }catch(e){}
}

function drawerSupported(){ return !!(navigator.usb && window.isSecureContext); }

function drawerFindOut(device){
  if(!device.configuration) return null;
  const ifaces = device.configuration.interfaces || [];
  function scan(wantBulk){
    for(let i = 0; i < ifaces.length; i++){
      const alts = ifaces[i].alternates || [];
      for(let a = 0; a < alts.length; a++){
        const eps = alts[a].endpoints || [];
        for(let e = 0; e < eps.length; e++){
          if(eps[e].direction === 'out' && (!wantBulk || eps[e].type === 'bulk')) return { interfaceNumber: ifaces[i].interfaceNumber, endpointNumber: eps[e].endpointNumber };
        }
      }
    }
    return null;
  }
  return scan(true) || scan(false);
}

function drawerOpenDevice(device){
  return Promise.resolve().then(function(){
    if(!device.opened) return device.open();
  }).then(function(){
    if(!device.configuration) return device.selectConfiguration(1);
  }).then(function(){
    const found = drawerFindOut(device);
    if(!found) throw new Error('no out endpoint');
    return device.claimInterface(found.interfaceNumber).then(function(){ return found.endpointNumber; });
  }).then(function(ep){
    drawerDevice = device; drawerOutEndpoint = ep; return true;
  }).catch(function(){ return false; });
}

function drawerConnect(){
  if(!drawerSupported()){ toast(t('drawer.unsupported')); return Promise.resolve(false); }
  return navigator.usb.requestDevice({ filters: [] }).then(function(device){
    return drawerOpenDevice(device).then(function(ok){
      if(!ok){ toast(t('drawer.connectFailed')); return false; }
      hw.printer = { vendorId: device.vendorId, productId: device.productId, productName: device.productName || '', serialNumber: device.serialNumber || '' };
      saveHardware(); renderHardware(); toast(t('drawer.connected')); return true;
    });
  }).catch(function(e){
    if(e && e.name === 'NotFoundError') return false; /* user cancelled the picker */
    toast(t('drawer.connectFailed')); return false;
  });
}

function drawerReconnect(){
  if(!drawerSupported() || !hw.printer || drawerDevice) return Promise.resolve(!!drawerDevice);
  return navigator.usb.getDevices().then(function(devices){
    const dev = devices.find(function(d){
      return d.vendorId === hw.printer.vendorId && d.productId === hw.printer.productId &&
        (!hw.printer.serialNumber || d.serialNumber === hw.printer.serialNumber);
    });
    if(!dev) return false;
    return drawerOpenDevice(dev);
  }).catch(function(){ return false; });
}

function drawerDisconnect(){
  const close = drawerDevice ? drawerDevice.close().catch(function(){}) : Promise.resolve();
  return close.then(function(){
    drawerDevice = null; drawerOutEndpoint = 0; hw.printer = null; saveHardware(); renderHardware(); toast(t('drawer.disconnected'));
  });
}

function kickDrawer(){
  /* Returns 'ok' | 'no-device' | 'failed'. Never throws. */
  function attempt(){
    if(!drawerDevice) return Promise.resolve('no-device');
    return drawerDevice.transferOut(drawerOutEndpoint, DRAWER_KICK).then(function(res){
      return (res && res.status === 'ok') ? 'ok' : 'failed';
    }).catch(function(){ drawerDevice = null; drawerOutEndpoint = 0; return 'failed'; });
  }
  if(drawerDevice) return attempt();
  return drawerReconnect().then(function(ok){ return ok ? attempt() : 'no-device'; });
}

function openDrawerManual(){
  if(!drawerSupported()){ toast(t('drawer.unsupported')); return; }
  kickDrawer().then(function(res){
    if(res === 'ok') toast(t('drawer.opened'));
    else if(res === 'no-device') toast(t('drawer.notConnected'));
    else toast(t('drawer.kickFailed'));
  });
}

function maybeAutoKick(order){
  if(!hw.autoDrawer || drawerKickedOrders[order.id]) return;
  drawerKickedOrders[order.id] = true;
  kickDrawer().then(function(res){ if(res !== 'ok') toast(t('drawer.kickFailed')); });
}

function renderHardware(){
  const supported = drawerSupported();
  const unsupported = document.getElementById('drawerUnsupported');
  if(unsupported) unsupported.classList.toggle('hidden', supported);
  const st = document.getElementById('drawerStatus');
  if(st){
    if(!supported) st.textContent = t('drawer.unsupported');
    else if(drawerDevice) st.textContent = t('drawer.statusConnected', {name: drawerDevice.productName || (hw.printer && hw.printer.productName) || 'USB printer'});
    else if(hw.printer) st.textContent = t('drawer.statusSaved', {name: hw.printer.productName || 'USB printer'});
    else st.textContent = t('drawer.statusNotConnected');
  }
  const cb = document.getElementById('drawerConnectBtn');
  if(cb) cb.classList.toggle('hidden', !!drawerDevice);
  const db = document.getElementById('drawerDisconnectBtn');
  if(db) db.classList.toggle('hidden', !drawerDevice);
  const auto = document.getElementById('setAutoDrawer');
  if(auto) auto.checked = !!hw.autoDrawer;
}

/* ================= backup & restore (JSON file) ================= */
/* Backup envelope: {app:'pos-html', version:1, exportedAt:<ISO>, data:{...DB}}.
   The old Backup button exported the raw DB object; restore still accepts
   that legacy shape so earlier backup files keep working. */

const BACKUP_ARRAYS = ['products','customers','staff','orders','expenses','movements'];

function backupFilename(prefix){
  const d = new Date();
  const pad = function(n){ return String(n).padStart(2,'0'); };
  return prefix + '-' + d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';
}

function backupEnvelope(){
  return { app:'pos-html', version:1, exportedAt:new Date().toISOString(),
    data:{ settings:DB.settings, products:DB.products, customers:DB.customers, staff:DB.staff, orders:DB.orders, expenses:DB.expenses, movements:DB.movements, nextOrderSeq:DB.nextOrderSeq } };
}

function downloadBlob(filename, blob){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
}

function downloadJson(filename, obj){
  downloadBlob(filename, new Blob([JSON.stringify(obj, null, 2)], {type:'application/json'}));
}

/* ================= XLSX export (hand-rolled, no libraries) ================= */
/* Minimal .xlsx writer: STORED (uncompressed) ZIP entries + CRC32, UTF-8 XML.
   Excel and Google Sheets accept stored entries. Dates are Excel serials. */

function showBackupMsg(msg){
  const el = document.getElementById('backupMsg');
  if(!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

function validateBackup(parsed){
  if(!parsed || typeof parsed !== 'object') return null;
  let data = null, exportedAt = null;
  if(parsed.app === 'pos-html' && parsed.data && typeof parsed.data === 'object'){
    data = parsed.data; exportedAt = parsed.exportedAt || null;
  } else if(parsed.settings && typeof parsed.settings === 'object' && Array.isArray(parsed.products)){
    data = parsed; exportedAt = null; /* legacy raw-DB export */
  } else return null;
  if(!data.settings || typeof data.settings !== 'object') return null;
  for(let i = 0; i < BACKUP_ARRAYS.length; i++){
    if(!Array.isArray(data[BACKUP_ARRAYS[i]])) return null;
  }
  if(data.nextOrderSeq != null && typeof data.nextOrderSeq !== 'number') return null;
  return { data: data, exportedAt: exportedAt };
}

function showRestoreSummary(v){
  const d = v.data;
  const rows = BACKUP_ARRAYS.map(function(k){
    return '<div class="row between" style="margin:5px 0"><span>' + esc(t('backup.count.' + k)) + '</span><strong>' + d[k].length + '</strong></div>';
  }).join('');
  const dateLine = v.exportedAt
    ? esc(t('backup.exportedAt', {date: fmtDate(new Date(v.exportedAt).getTime())}))
    : esc(t('backup.exportedUnknown'));
  openModal(
    '<header><h2>' + esc(t('backup.summaryTitle')) + '</h2><button class="btn icon-btn" type="button" data-close>✕</button></header>' +
    '<p class="muted">' + dateLine + '</p>' +
    rows +
    '<p class="muted">' + esc(t('backup.settingsIncluded')) + '</p>' +
    '<p style="color:var(--danger);font-weight:650">' + esc(t('backup.replaceWarning')) + '</p>' +
    '<p class="muted">' + esc(t('backup.safetyNote')) + '</p>' +
    '<div class="form-actions"><button class="btn" type="button" data-close>' + esc(t('common.cancel')) + '</button>' +
    '<button class="btn primary" type="button" id="confirmRestoreBtn">' + esc(t('backup.confirm')) + '</button></div>'
  );
  document.getElementById('confirmRestoreBtn').addEventListener('click', function(){ closeModal(); doRestore(v.data); });
}

function doRestore(data){
  /* Safety copy of the CURRENT data first, then replace. */
  downloadJson(backupFilename('pos-backup-before-restore'), backupEnvelope());
  const restored = JSON.parse(JSON.stringify(data));
  if(typeof restored.nextOrderSeq !== 'number') restored.nextOrderSeq = 5;
  DB = restored;
  cart = [];
  persistLocal(); /* no schedulePush here: pushCloud below handles the wipe+push */
  applyLang();
  showView('dashboard');
  toast(t('backup.restored'));
  /* Full replace in the cloud too: wipe stale rows first, then push all rows. */
  pendingWipe = true;
  pushCloud().then(function(ok){
    if(ok){ showBackupMsg(''); }
    else { showBackupMsg(t('backup.restoredSyncFailed')); toast(t('backup.restoredSyncFailed')); }
  });
  retryPendingPhotos(); /* a photo restored from backup but not yet uploaded gets its turn now */
}

function onRestoreFilePicked(e){
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if(!file) return;
  const reader = new FileReader();
  reader.onload = function(){
    let parsed = null;
    try{ parsed = JSON.parse(reader.result); }catch(err){ parsed = null; }
    const v = parsed ? validateBackup(parsed) : null;
    if(!v){ showBackupMsg(t('backup.invalid')); return; }
    showBackupMsg('');
    showRestoreSummary(v);
  };
  reader.onerror = function(){ showBackupMsg(t('backup.invalid')); };
  reader.readAsText(file);
}

/* ================= navigation & language ================= */
/* Side-rail icons are inline SVG (no font dependency): emoji do not render on
   some Android tablets (e.g. Xiaomi Pad), leaving the rail blank. The phone
   bottom nav keeps its emoji icons, which render fine there. */

function renderCustomers(){
  const list = DB.customers.slice().sort(function(a,b){ return a.name.localeCompare(b.name); });
  document.getElementById('customerList').innerHTML = list.map(function(c){
    const orders = DB.orders.filter(function(o){ return o.customerId === c.id && o.status === 'Completed'; });
    const total = orders.reduce(function(s,o){ return s + o.total; }, 0);
    return '<div class="list-row"><div class="avatar">' + esc(c.name.trim().charAt(0).toUpperCase()) + '</div>' +
      '<div class="grow"><strong>' + esc(c.name) + '</strong><small>' + esc(c.phone || t('common.noPhone')) + (c.address ? ' · ' + esc(c.address) : '') + '</small></div>' +
      '<div class="amt">' + money(total) + '<small style="display:block;color:var(--dim);font-weight:400">' + t('customers.orders') + ': ' + orders.length + '</small></div>' +
      '<button class="btn icon-btn" type="button" data-edit-customer="' + c.id + '" aria-label="Edit">✎</button></div>';
  }).join('');
  document.querySelectorAll('[data-edit-customer]').forEach(function(b){
    b.addEventListener('click', function(){ openCustomerForm(b.dataset.editCustomer); });
  });
}

function openCustomerForm(id){
  const c = id ? custById(id) : null;
  openModal(
    '<header><h2>' + esc(c ? c.name : t('customers.add')) + '</h2><button class="btn icon-btn" type="button" data-close>✕</button></header>' +
    fieldHtml(t('customers.name'), '<input type="text" id="cfName" value="' + esc(c ? c.name : '') + '">') +
    fieldHtml(t('customers.phone'), '<input type="tel" id="cfPhone" value="' + esc(c ? c.phone : '') + '">') +
    fieldHtml(t('common.address'), '<input type="text" id="cfAddress" value="' + esc(c ? c.address : '') + '">') +
    fieldHtml(t('common.note'), '<input type="text" id="cfNotes" value="' + esc(c ? c.notes : '') + '">') +
    '<div class="form-actions">' +
    (c && c.id !== 'c4' ? '<button class="btn danger" type="button" id="cfDelete" style="margin-right:auto">' + esc(t('common.delete')) + '</button>' : '') +
    '<button class="btn" type="button" data-close>' + esc(t('common.cancel')) + '</button>' +
    '<button class="btn primary" type="button" id="cfSave">' + esc(t('common.save')) + '</button></div>'
  );
  document.getElementById('cfSave').addEventListener('click', function(){
    const name = document.getElementById('cfName').value.trim();
    if(!name){ toast(t('common.required')); return; }
    const data = { name: name, phone: document.getElementById('cfPhone').value.trim(), address: document.getElementById('cfAddress').value.trim(), notes: document.getElementById('cfNotes').value.trim() };
    if(c) Object.assign(c, data);
    else DB.customers.push(Object.assign({ id: uid('c'), email: '' }, data));
    save(); closeModal(); renderCustomers(); toast(t('customers.saved'));
  });
  const del = document.getElementById('cfDelete');
  if(del) del.addEventListener('click', function(){
    if(!confirm(t('common.confirmDelete'))) return;
    DB.customers = DB.customers.filter(function(x){ return x.id !== c.id; });
    sbDelete('customers', c.id);
    save(); closeModal(); renderCustomers(); toast(t('customers.deleted'));
  });
}

/* ================= expenses ================= */

function renderSettingsForm(){
  const s = DB.settings;
  document.getElementById('setStoreName').value = s.storeName;
  document.getElementById('setAddress').value = s.address;
  document.getElementById('setPhone').value = s.phone;
  document.getElementById('setCurrency').value = s.currency;
  document.getElementById('setTaxRate').value = s.taxRate;
  document.getElementById('setReceiptSize').value = s.receiptSize;
  document.getElementById('setVersion').textContent = APP_VERSION;
  document.querySelectorAll('#setLangToggle button').forEach(function(b){ b.classList.toggle('active', b.dataset.lang === s.lang); });
  document.querySelectorAll('#setThemeToggle button').forEach(function(b){ b.classList.toggle('active', b.dataset.theme === currentTheme()); });
  document.getElementById('staffList').innerHTML = DB.staff.map(function(m){
    return '<div class="list-row"><div class="avatar">' + esc(m.name.trim().charAt(0).toUpperCase()) + '</div>' +
      '<div class="grow"><strong>' + esc(m.name) + '</strong><small>' + esc(tRole(m.role)) + (m.email ? ' · ' + esc(m.email) : '') + '</small></div>' +
      '<span class="badge ' + (m.active ? 'good' : '') + '">' + esc(m.active ? 'Active' : 'Inactive') + '</span>' +
      '<button class="btn icon-btn" type="button" data-del-staff="' + m.id + '" aria-label="Delete">✕</button></div>';
  }).join('');
  document.querySelectorAll('[data-del-staff]').forEach(function(b){
    b.addEventListener('click', function(){
      if(!confirm(t('common.confirmDelete'))) return;
      DB.staff = DB.staff.filter(function(x){ return x.id !== b.dataset.delStaff; });
      sbDelete('staff', b.dataset.delStaff);
      save(); renderSettingsForm(); toast(t('staff.deleted'));
    });
  });
  renderHardware();
}

function openStaffForm(){
  openModal(
    '<header><h2>' + esc(t('staff.add')) + '</h2><button class="btn icon-btn" type="button" data-close>✕</button></header>' +
    fieldHtml(t('common.name'), '<input type="text" id="sfName">') +
    fieldHtml(t('staff.role'), '<select id="sfRole"><option value="Admin">' + esc(t('staff.admin')) + '</option><option value="Manager">' + esc(t('staff.manager')) + '</option><option value="Cashier" selected>' + esc(t('staff.cashier')) + '</option></select>') +
    fieldHtml('Email', '<input type="email" id="sfEmail">') +
    '<div class="form-actions"><button class="btn" type="button" data-close>' + esc(t('common.cancel')) + '</button>' +
    '<button class="btn primary" type="button" id="sfSave">' + esc(t('common.save')) + '</button></div>'
  );
  document.getElementById('sfSave').addEventListener('click', function(){
    const name = document.getElementById('sfName').value.trim();
    if(!name){ toast(t('common.required')); return; }
    DB.staff.push({ id: uid('s'), name: name, role: document.getElementById('sfRole').value, email: document.getElementById('sfEmail').value.trim(), active: true });
    save(); closeModal(); renderSettingsForm(); toast(t('staff.saved'));
  });
}

function saveSettings(){
  DB.settings.storeName = document.getElementById('setStoreName').value.trim() || DB.settings.storeName;
  DB.settings.address = document.getElementById('setAddress').value.trim();
  DB.settings.phone = document.getElementById('setPhone').value.trim();
  DB.settings.currency = document.getElementById('setCurrency').value;
  DB.settings.taxRate = Math.max(0, parseFloat(document.getElementById('setTaxRate').value) || 0);
  DB.settings.receiptSize = document.getElementById('setReceiptSize').value;
  save(); applyLang(); toast(t('settings.saved'));
}

/* ================= init ================= */
