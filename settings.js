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

/* Client-owned tables only (products, customers, staff, expenses,
   suppliers, purchase orders). Orders and stock movements are
   SERVER-OWNED since Stage 4 — they live on the server and are never
   written from a file, so they are not in a backup at all. */
const BACKUP_ARRAYS = ['products','customers','staff','expenses','suppliers','purchaseOrders','purchaseOrderItems'];

function backupFilename(prefix){
  const d = new Date();
  const pad = function(n){ return String(n).padStart(2,'0'); };
  return prefix + '-' + d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';
}

function backupEnvelope(){
  return { app:'pos-html', version:1, exportedAt:new Date().toISOString(),
    data:{ settings:DB.settings, products:DB.products, customers:DB.customers, staff:DB.staff, expenses:DB.expenses, suppliers:(DB.suppliers || []), purchaseOrders:(DB.purchaseOrders || []), purchaseOrderItems:(DB.purchaseOrderItems || []), nextOrderSeq:DB.nextOrderSeq } };
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
  /* Required arrays: the client-owned tables. Orders / movements in an
     old backup are ignored — server-owned tables are never restored from
     a file. The newer arrays default to empty so old backups still load. */
  const required = ['products','customers','staff','expenses'];
  for(let i = 0; i < required.length; i++){
    if(!Array.isArray(data[required[i]])) return null;
  }
  ['suppliers','purchaseOrders','purchaseOrderItems'].forEach(function(k){ if(!Array.isArray(data[k])) data[k] = []; });
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
    '<p class="muted">' + esc(t('backup.serverDataKept')) + '</p>' +
    '<p style="color:var(--danger);font-weight:650">' + esc(t('backup.replaceWarning')) + '</p>' +
    '<p class="muted">' + esc(t('backup.safetyNote')) + '</p>' +
    '<div class="form-actions"><button class="btn" type="button" data-close>' + esc(t('common.cancel')) + '</button>' +
    '<button class="btn primary" type="button" id="confirmRestoreBtn">' + esc(t('backup.confirm')) + '</button></div>'
  );
  document.getElementById('confirmRestoreBtn').addEventListener('click', function(){ closeModal(); doRestore(v.data); });
}

function doRestore(data){
  if(deny('backup_restore')) return;
  /* Safety copy of the CURRENT data first, then replace. */
  downloadJson(backupFilename('pos-backup-before-restore'), backupEnvelope());
  const restored = JSON.parse(JSON.stringify(data));
  if(typeof restored.nextOrderSeq !== 'number') restored.nextOrderSeq = 5;
  /* Server-owned tables are NEVER restored from a file and NEVER wiped:
     orders and stock history stay exactly as they are on the server. The
     current local mirror is kept and the next cloud pull refreshes it.
     (Before Stage 4 this restore wiped the cloud first — that would now
     delete server orders pushCloud can no longer re-push: data loss.) */
  restored.orders = DB.orders;
  restored.movements = DB.movements;
  restored.suppliers = Array.isArray(restored.suppliers) ? restored.suppliers : [];
  restored.purchaseOrders = Array.isArray(restored.purchaseOrders) ? restored.purchaseOrders : [];
  restored.purchaseOrderItems = Array.isArray(restored.purchaseOrderItems) ? restored.purchaseOrderItems : [];
  DB = ensureCollections(restored);
  cart = [];
  clearPushed(); /* every row is new again after a restore */
  persistLocal(); /* no schedulePush here: pushCloud below pushes the restored rows */
  applyLang();
  showView(landingView());
  toast(t('backup.restored'));
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
  if(deny('backup_restore')) return;
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
    (c && c.id !== 'c4' && can('customers_delete') ? '<button class="btn danger" type="button" id="cfDelete" style="margin-right:auto">' + esc(t('common.delete')) + '</button>' : '') +
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
    if(deny('customers_delete')) return;
    if(!confirm(t('common.confirmDelete'))) return;
    DB.customers = DB.customers.filter(function(x){ return x.id !== c.id; });
    sbDelete('customers', c.id);
    save(); closeModal(); renderCustomers(); toast(t('customers.deleted'));
  });
}

/* ================= expenses ================= */

function renderSettingsForm(){
  const s = DB.settings;
  /* Shop profile: visible to all roles, but only owner/admin may change
     it — the fields go read-only and Save hides for manager/cashier. */
  const canShop = can('settings_shop');
  ['setStoreName','setAddress','setPhone','setCurrency','setTaxRate','setReceiptSize','setInvoicePrefix'].forEach(function(id){
    const el = document.getElementById(id);
    if(el) el.disabled = !canShop;
  });
  const saveBtn = document.getElementById('saveSettingsBtn');
  if(saveBtn) saveBtn.classList.toggle('hidden', !canShop);
  /* Whole sections, hidden unless the role may use them. */
  const staffPanel = document.getElementById('settingsStaffPanel');
  if(staffPanel) staffPanel.classList.toggle('hidden', !can('staff_manage'));
  const dataPanel = document.getElementById('settingsDataPanel');
  if(dataPanel) dataPanel.classList.toggle('hidden', !can('backup_restore'));
  document.getElementById('setStoreName').value = s.storeName;
  document.getElementById('setAddress').value = s.address;
  document.getElementById('setPhone').value = s.phone;
  document.getElementById('setCurrency').value = s.currency;
  document.getElementById('setTaxRate').value = s.taxRate;
  document.getElementById('setReceiptSize').value = s.receiptSize;
  /* Invoice prefix (STEP 4 §10): the server mints PREFIX-YEAR-000001 for
     every sale. Empty = the shop code, then 'NS'. The preview shows the
     format of the next number (the sequence itself lives on the server). */
  const prefixEl = document.getElementById('setInvoicePrefix');
  if(prefixEl){
    prefixEl.value = s.invoicePrefix || '';
    const preview = document.getElementById('invoicePrefixPreview');
    if(preview) preview.textContent = t('settings.invoicePrefixPreview', {preview: ((s.invoicePrefix || 'NS').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'NS') + '-' + new Date().getFullYear() + '-000001'});
  }
  document.getElementById('setVersion').textContent = APP_VERSION;
  document.querySelectorAll('#setLangToggle button').forEach(function(b){ b.classList.toggle('active', b.dataset.lang === s.lang); });
  document.querySelectorAll('#setThemeToggle button').forEach(function(b){ b.classList.toggle('active', b.dataset.theme === currentTheme()); });
  document.getElementById('staffList').innerHTML = DB.staff.map(function(m){
    const linked = !!m.authUid;
    const member = linked ? memberForStaff(m) : null;
    const suspended = member ? member.active === false : !m.active;
    const isSelf = linked && authUid() && m.authUid === authUid();
    const branchName = branchNameForStaff(m);
    /* The role select shows the MEMBERSHIP role (lowercase, the RPC's
       vocabulary); it is not offered for owners — their role is never
       changed from this app. */
    const shownRole = (member && member.role) ? String(member.role).toLowerCase() : String(m.role || '').toLowerCase();
    const roleOpts = ['admin','manager','cashier'].map(function(r){
      return '<option value="' + r + '"' + (shownRole === r ? ' selected' : '') + '>' + esc(tRole(r)) + '</option>';
    }).join('');
    return '<div class="list-row"><div class="avatar">' + esc(m.name.trim().charAt(0).toUpperCase()) + '</div>' +
      '<div class="grow"><strong>' + esc(m.name) + '</strong><small>' + esc(tRole(m.role)) + (m.email ? ' · ' + esc(m.email) : '') + (branchName ? ' · ' + esc(branchName) : '') + (suspended ? ' · ' + esc(t('staff.suspended')) : '') + '</small></div>' +
      (linked
        ? (shownRole === 'owner' ? '' : '<select data-role-staff="' + m.id + '" style="width:auto;min-width:0" aria-label="' + esc(t('staff.role')) + '">' + roleOpts + '</select>') +
          (isSelf ? '' : '<button class="btn" type="button" data-suspend-staff="' + m.id + '">' + esc(t(suspended ? 'staff.reactivate' : 'staff.suspend')) + '</button>')
        : '<button class="btn" type="button" data-link-staff="' + m.id + '">' + esc(t('staff.linkAccount')) + '</button>') +
      '<button class="btn icon-btn" type="button" data-del-staff="' + m.id + '" aria-label="Delete">✕</button></div>';
  }).join('');
  document.querySelectorAll('[data-link-staff]').forEach(function(b){
    b.addEventListener('click', function(){ openLinkStaffForm(b.dataset.linkStaff); });
  });
  document.querySelectorAll('[data-role-staff]').forEach(function(sel){
    sel.addEventListener('change', function(){ changeStaffRole(sel.dataset.roleStaff, sel.value, sel); });
  });
  document.querySelectorAll('[data-suspend-staff]').forEach(function(b){
    b.addEventListener('click', function(){
      const m = DB.staff.find(function(x){ return x.id === b.dataset.suspendStaff; });
      if(!m) return;
      const member = memberForStaff(m);
      if(member && member.active === false) reactivateStaff(m);
      else suspendStaff(m);
    });
  });
  document.querySelectorAll('[data-del-staff]').forEach(function(b){
    b.addEventListener('click', function(){
      if(deny('staff_manage')) return;
      if(!confirm(t('common.confirmDelete'))) return;
      DB.staff = DB.staff.filter(function(x){ return x.id !== b.dataset.delStaff; });
      sbDelete('staff', b.dataset.delStaff);
      save(); renderSettingsForm(); toast(t('staff.deleted'));
    });
  });
  renderHardware();
}

/* The shop_members row for a staff row (by its linked login account), or
   null while unlinked / the directory has not loaded. */
function memberForStaff(m){
  if(!m.authUid) return null;
  return shopMembersCache.find(function(x){ return x.user_id === m.authUid; }) || null;
}

function branchNameForStaff(m){
  if(!m.branchId) return '';
  const b = shopBranchesCache.find(function(x){ return x.id === m.branchId; });
  return b ? b.name : '';
}

/* Link a login account to a staff row: resolve the email to an Auth uid,
   PATCH the staff row, then INSERT the membership (role + branch from the
   staff row). Both calls are owner/admin-gated by RLS; the RPC's error
   message is shown, not a generic failure. */
function openLinkStaffForm(staffId){
  if(deny('staff_manage')) return;
  const m = DB.staff.find(function(x){ return x.id === staffId; });
  if(!m) return;
  openModal(
    '<header><h2>' + esc(t('staff.linkAccount')) + '</h2><button class="btn icon-btn" type="button" data-close>✕</button></header>' +
    '<p class="muted">' + esc(m.name) + '</p>' +
    fieldHtml(t('staff.linkEmail'), '<input type="email" id="linkEmail" value="' + esc(m.email || '') + '">') +
    '<div class="form-actions"><button class="btn" type="button" data-close>' + esc(t('common.cancel')) + '</button>' +
    '<button class="btn primary" type="button" id="linkSave">' + esc(t('staff.linkAccount')) + '</button></div>'
  );
  document.getElementById('linkSave').addEventListener('click', function(){
    const email = document.getElementById('linkEmail').value.trim();
    if(!email || email.indexOf('@') < 1){ toast(t('login.invalidEmail')); return; }
    closeModal();
    linkStaffAccount(m, email);
  });
}

function linkStaffAccount(m, email){
  if(deny('staff_manage')) return;
  sbRpc('resolve_staff_uid', { p_shop_id: activeShopId, p_email: email }).then(function(uid){
    if(!uid){ toast(t('staff.notSignedUp')); return; }
    const branchId = m.branchId || null;
    return fetch(SB_URL + '/rest/v1/staff?id=eq.' + encodeURIComponent(m.id) + '&shop_id=eq.' + encodeURIComponent(activeShopId), {
      method: 'PATCH',
      headers: sbHeaders(true),
      body: JSON.stringify({ auth_uid: uid })
    }).then(function(r){
      if(r.status === 401){ handleAuthError(401); throw new Error('staff link 401'); }
      if(r.status === 403){ handleAuthError(403); throw new Error('staff link 403'); }
      if(!r.ok) throw new Error('staff link ' + r.status);
      return fetch(SB_URL + '/rest/v1/shop_members', {
        method: 'POST',
        headers: Object.assign(sbHeaders(true), { 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ shop_id: activeShopId, user_id: uid, role: String(m.role || 'Cashier').toLowerCase(), branch_id: branchId })
      });
    }).then(function(r){
      if(!r.ok) return r.text().then(function(txt){ throw new Error('shop_members ' + r.status + ' ' + (txt || '')); });
      m.authUid = uid;
      shopMembersCache.push({ user_id: uid, role: String(m.role || 'Cashier').toLowerCase(), branch_id: branchId, active: true });
      save(); renderSettingsForm(); toast(t('staff.linked'));
    });
  }).catch(function(e){ toast(rpcErrorMessage(e) || t('login.failed')); });
}

/* Role change goes through set_member_role() — never a direct PATCH on
   shop_members (file 02 forbids it). The RPC keeps the staff row in sync
   and writes the audit row; its error (self-change, last-owner demotion,
   admin granting owner, branch-less cashier) is shown as-is. */
function changeStaffRole(staffId, newRole, sel){
  if(deny('staff_manage')){ if(sel) renderSettingsForm(); return; }
  const m = DB.staff.find(function(x){ return x.id === staffId; });
  if(!m || !m.authUid) return;
  const member = memberForStaff(m);
  const branchId = (member && member.branch_id) || m.branchId || null;
  sbRpc('set_member_role', { p_shop_id: activeShopId, p_user_id: m.authUid, p_role: newRole, p_branch_id: branchId }).then(function(){
    if(member){ member.role = newRole; if(branchId) member.branch_id = branchId; }
    m.role = newRole === 'manager' ? 'Manager' : newRole === 'cashier' ? 'Cashier' : 'Admin';
    if(branchId) m.branchId = branchId;
    save(); renderSettingsForm(); toast(t('staff.roleChanged'));
  }).catch(function(e){
    toast(rpcErrorMessage(e) || t('login.failed'));
    renderSettingsForm(); /* put the select back to the true role */
  });
}

function suspendStaff(m){
  if(deny('staff_manage')) return;
  if(!m.authUid) return;
  sbRpc('suspend_member', { p_shop_id: activeShopId, p_user_id: m.authUid }).then(function(){
    const member = memberForStaff(m);
    if(member) member.active = false;
    m.active = false; /* the RPC deactivates the linked staff row too */
    save(); renderSettingsForm(); toast(t('staff.suspended'));
  }).catch(function(e){ toast(rpcErrorMessage(e) || t('login.failed')); });
}

function reactivateStaff(m){
  if(deny('staff_manage')) return;
  if(!m.authUid) return;
  sbRpc('reactivate_member', { p_shop_id: activeShopId, p_user_id: m.authUid }).then(function(){
    const member = memberForStaff(m);
    if(member) member.active = true;
    m.active = true;
    save(); renderSettingsForm(); toast(t('staff.reactivated'));
  }).catch(function(e){ toast(rpcErrorMessage(e) || t('login.failed')); });
}

function openStaffForm(){
  if(deny('staff_manage')) return;
  const branchOpts = function(){
    return '<option value="">—</option>' + shopBranchesCache.map(function(b){
      return '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>';
    }).join('');
  };
  openModal(
    '<header><h2>' + esc(t('staff.add')) + '</h2><button class="btn icon-btn" type="button" data-close>✕</button></header>' +
    fieldHtml(t('common.name'), '<input type="text" id="sfName">') +
    fieldHtml(t('staff.role'), '<select id="sfRole"><option value="Admin">' + esc(t('staff.admin')) + '</option><option value="Manager">' + esc(t('staff.manager')) + '</option><option value="Cashier" selected>' + esc(t('staff.cashier')) + '</option></select>') +
    fieldHtml(t('staff.branch'), '<select id="sfBranch">' + branchOpts() + '</select>') +
    fieldHtml('Email', '<input type="email" id="sfEmail">') +
    '<div class="form-actions"><button class="btn" type="button" data-close>' + esc(t('common.cancel')) + '</button>' +
    '<button class="btn primary" type="button" id="sfSave">' + esc(t('common.save')) + '</button></div>'
  );
  /* The branch list loads after login; if it never arrived (offline),
     try once more now so a cashier can still be given a branch. */
  if(!shopBranchesCache.length){
    refreshShopDirectory().then(function(){
      const sel = document.getElementById('sfBranch');
      if(sel) sel.innerHTML = branchOpts();
    });
  }
  document.getElementById('sfSave').addEventListener('click', function(){
    if(deny('staff_manage')) return;
    const name = document.getElementById('sfName').value.trim();
    const role = document.getElementById('sfRole').value;
    const branchId = document.getElementById('sfBranch').value || null;
    const email = document.getElementById('sfEmail').value.trim();
    if(!name){ toast(t('common.required')); return; }
    /* A cashier must have a branch (the server CHECK enforces it too);
       the form must not let an owner create one and fail mysteriously. */
    if(role === 'Cashier' && !branchId){ toast(t('common.required')); return; }
    DB.staff.push({ id: uid('s'), name: name, role: role, email: email, active: true, branchId: branchId, authUid: '' });
    save(); closeModal(); renderSettingsForm();
    if(email) toast(t('staff.linkHint', {email: email}));
    else toast(t('staff.saved'));
  });
}

function saveSettings(){
  if(deny('settings_shop')) return;
  DB.settings.storeName = document.getElementById('setStoreName').value.trim() || DB.settings.storeName;
  DB.settings.address = document.getElementById('setAddress').value.trim();
  DB.settings.phone = document.getElementById('setPhone').value.trim();
  DB.settings.currency = document.getElementById('setCurrency').value;
  DB.settings.taxRate = Math.max(0, parseFloat(document.getElementById('setTaxRate').value) || 0);
  DB.settings.receiptSize = document.getElementById('setReceiptSize').value;
  /* Same sanitising as the server (upper-case, alphanumerics only, max 6);
     empty means "use the shop code". Changing it affects the NEXT invoice
     only — the sequence number never resets. */
  DB.settings.invoicePrefix = (document.getElementById('setInvoicePrefix').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  save(); applyLang(); toast(t('settings.saved'));
}

/* ================= init ================= */
