/* auth.js — split from pos-system.html 1.0.5 (mechanical split, no logic changes). Owner guard, session, login / sign-up, password, backfill. */
'use strict';

const OWNER_KEY = 'posHtmlOwner.v1'; /* uid of the shop whose data lives in this device's localStorage */

function loadOwner(){ try{ return localStorage.getItem(OWNER_KEY) || null; }catch(e){ return null; } }

function saveOwner(u){ try{ if(u) localStorage.setItem(OWNER_KEY, u); }catch(e){} }

/* ================= membership state (STEP 3) ================= */
/* {uid, shopId, shopName, role, branchId, branchName, staffId, staffName,
   shops: [{id, name, role, branchId}]} — the active membership plus every
   shop this user belongs to (for the picker / switcher). Resolved on
   every sign-in, never trusted across logins; cleared by signOut(). */
const MEMBERSHIP_KEY = 'posHtmlMembership.v1';
function loadMembership(){ try{ const m = JSON.parse(localStorage.getItem(MEMBERSHIP_KEY) || 'null'); return (m && typeof m === 'object') ? m : null; }catch(e){ return null; } }
function saveMembership(m){ try{ localStorage.setItem(MEMBERSHIP_KEY, JSON.stringify(m)); }catch(e){} }
function clearMembership(){ try{ localStorage.removeItem(MEMBERSHIP_KEY); }catch(e){} }

/* The shop id whose rows live in this device's localStorage — the
   shared-device guard is per shop now, not per owner uid: one user can
   belong to several shops. */
const LOCAL_SHOP_KEY = 'posHtmlShop.v1';
function loadLocalShopId(){ try{ return localStorage.getItem(LOCAL_SHOP_KEY) || null; }catch(e){ return null; } }
function saveLocalShopId(id){ try{ if(id) localStorage.setItem(LOCAL_SHOP_KEY, id); }catch(e){} }

/* The shop directory (members + branches) for the Staff UI. Loaded after
   login when the role may manage staff; empty when it may not (or when
   offline) — the Staff section hides the buttons that need it. */
let shopMembersCache = [];
let shopBranchesCache = [];
let shopDirectoryLoading = false;
function refreshShopDirectory(){
  if(!authSession || !activeShopId || !can('staff_manage') || shopDirectoryLoading) return Promise.resolve();
  shopDirectoryLoading = true;
  const h = sbHeaders(false);
  return Promise.all([
    fetch(SB_URL + '/rest/v1/shop_members?select=user_id,role,branch_id,active&shop_id=eq.' + encodeURIComponent(activeShopId), { headers: h })
      .then(function(r){ if(!r.ok) throw new Error('shop_members ' + r.status); return r.json(); }),
    fetch(SB_URL + '/rest/v1/branches?select=id,name,code&shop_id=eq.' + encodeURIComponent(activeShopId) + '&order=name', { headers: h })
      .then(function(r){ if(!r.ok) throw new Error('branches ' + r.status); return r.json(); })
  ]).then(function(res){
    shopMembersCache = res[0] || [];
    shopBranchesCache = res[1] || [];
  }).catch(function(e){
    /* Best effort: the Staff UI still renders from local staff rows; the
       link / suspend buttons need the directory and will fail visibly if
       it never loads. The warning is the record, not a silent swallow. */
    console.warn('shop directory refresh failed', e);
  }).then(function(){ shopDirectoryLoading = false; });
}
/* Shared device guard: if this device's local data belongs to a DIFFERENT
   shop than the one now signed in, discard it and start from the demo seed —
   never push another shop's data up as this shop's, and never show it. Same
   shop (or a never-synced device) keeps its local data. */
/* New shops start from the demo seed, whose row ids (p1, o1, …) are the same
   on every device. If two shops pushed those ids, the second shop's upsert
   would overwrite the first shop's rows (same id) before the RLS flip, or
   fail outright after it. So when this shop's cloud is empty and the local
   data is not already this shop's own synced data, give every local row a
   fresh unique id first, remapping the references (order items, movements,
   order customers) to match. Settings and order numbers are untouched. */

function rekeyLocalDb(){
  const map = {};
  function fresh(prefix, oldId){ const id = uid(prefix); map[oldId] = id; return id; }
  DB.products.forEach(function(p){ p.id = fresh('p', p.id); });
  DB.customers.forEach(function(c){ c.id = fresh('c', c.id); });
  DB.staff.forEach(function(m){ m.id = fresh('s', m.id); });
  DB.orders.forEach(function(o){
    o.id = fresh('o', o.id);
    if(o.customerId && map[o.customerId]) o.customerId = map[o.customerId];
    (o.items || []).forEach(function(it){ if(it.productId && map[it.productId]) it.productId = map[it.productId]; });
  });
  DB.expenses.forEach(function(e){ e.id = fresh('e', e.id); });
  DB.movements.forEach(function(m){
    m.id = fresh('m', m.id);
    if(m.productId && map[m.productId]) m.productId = map[m.productId];
  });
}

function discardForeignLocal(){
  const lastOwner = loadOwner();
  const u = authUid();
  if(lastOwner && u && lastOwner !== u){ DB = seedData(); persistLocal(); return true; }
  /* Same user, different shop: the local rows belong to another shop. */
  const lastShop = loadLocalShopId();
  if(lastShop && activeShopId && lastShop !== activeShopId){ DB = seedData(); persistLocal(); return true; }
  return false;
}

/* ================= Supabase Auth (plain fetch, no libraries) ================= */
/* Sign-in + sign-up in the app (GoTrue). The session (user access token) is
   stored in localStorage; data calls use the user token, never the anon key,
   for Authorization. Every shop's rows carry owner_id = the user's auth id,
   and pulls are filtered to that id, so shops never see each other's data. */

const AUTH_KEY = 'posHtmlAuth.v1';

let authSession = null;   /* {access_token, refresh_token, expires_at (epoch seconds), email, uid} */

/* The signed-in user's ACTIVE shop + branch (see resolveMembership).
   Session state only; the saved membership in posHtmlMembership.v1 is
   the durable copy. A user may belong to several shops — the picker /
   switcher chooses the active one. */
let activeShopId = null;
let activeBranchId = null;
let membershipResolvePromise = null; /* in-flight resolveMembership(), so concurrent callers share one attempt */

function jwtSub(token){
  try{
    const parts = (token || '').split('.');
    if(parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while(b64.length % 4) b64 += '=';
    const j = JSON.parse(atob(b64));
    return j.sub || null;
  }catch(e){ return null; }
}
/* The signed-in shop's id: stored on the session when available, otherwise
   decoded from the JWT (covers sessions saved before sign-up was added). */

function authUid(){
  if(!authSession) return null;
  if(!authSession.uid) authSession.uid = jwtSub(authSession.access_token);
  return authSession.uid || null;
}

/* ================= roles & permissions (STEP 3) ================= */
/* Permission keys — MUST match has_permission() in STEP 3 file 01 and the
   matrix in auth-roles-design.md §2. One key, one meaning, in both layers.
   `orders_manage` is an app-only key for the sync watermark (orders UPDATE
   is manager+); it has no UI gate of its own. */
const PERMS = {
  sell: ['owner','admin','manager','cashier'],
  view_own_orders: ['owner','admin','manager','cashier'],
  view_orders_all: ['owner','admin','manager'],
  refund_void: ['owner','admin','manager'],
  delete_order: ['owner','admin'],
  products_read: ['owner','admin','manager','cashier'],
  products_manage: ['owner','admin','manager'],
  cost_prices: ['owner','admin','manager'],
  stock_manage: ['owner','admin','manager'],
  inventory_read: ['owner','admin','manager','cashier'],
  customers_add: ['owner','admin','manager','cashier'],
  customers_delete: ['owner','admin','manager'],
  expenses_add: ['owner','admin','manager','cashier'],
  expenses_manage: ['owner','admin','manager'],
  reports: ['owner','admin','manager'],
  settings_shop: ['owner','admin'],
  settings_device: ['owner','admin','manager','cashier'],
  staff_manage: ['owner','admin'],
  members_manage: ['owner','admin'],
  branches_manage: ['owner','admin'],
  backup_restore: ['owner','admin'],
  change_own_password: ['owner','admin','manager','cashier'],
  print_receipt: ['owner','admin','manager','cashier'],
  shop_switch: ['owner','admin','manager','cashier'],
  orders_manage: ['owner','admin','manager']
};
function activeRole(){ const m = loadMembership(); return (m && m.role) || null; }
/* No resolved role (offline, or the first run before the membership fetch
   returns) fails OPEN for local use: the user is working with this
   device's own data, and every cloud write is still gated by RLS. The
   server — not this helper — is the real enforcement. Once a membership
   is resolved, the role gates the UI strictly. */
function can(perm){ const r = activeRole(); if(!r) return true; return (PERMS[perm] || []).indexOf(r) >= 0; }
function deny(perm){ if(!can(perm)){ toast(t('auth.notAllowed')); return true; } return false; }
/* Pull the readable message out of an sbRpc failure ('rpc <fn> <status>
   {"message":"..."}') so the UI shows the server's words, not the raw
   status line. */
function rpcErrorMessage(e){
  const msg = (e && e.message) || '';
  const i = msg.indexOf('{');
  if(i >= 0){
    try{ const j = JSON.parse(msg.slice(i)); if(j && j.message) return j.message; }catch(err){}
  }
  return msg;
}
/* 401 → the session is dead: clear it and send the user back to sign-in
   with the expiry message (never silently stay in the app). 403 → the
   role may not do that: a toast, never a re-login. Shown once per
   sign-in so a 7-table pull cannot toast seven times. */
let authErrorShown = false;
function handleAuthError(status){
  if(authErrorShown) return;
  if(status === 401){
    authErrorShown = true;
    clearAuth();
    activeShopId = null; activeBranchId = null; membershipResolvePromise = null;
    clearMembership();
    showLoginScreen();
    showLoginExpired();
  } else if(status === 403){
    authErrorShown = true;
    toast(t('auth.notAllowed'));
  }
}
function loadAuth(){
  try{ const s = JSON.parse(localStorage.getItem(AUTH_KEY)); return (s && s.access_token) ? s : null; }catch(e){ return null; }
}

function saveAuth(s){ try{ localStorage.setItem(AUTH_KEY, JSON.stringify(s)); }catch(e){} }

function clearAuth(){ try{ localStorage.removeItem(AUTH_KEY); }catch(e){} authSession = null; }

function authValid(s){ return !!(s && s.access_token && s.expires_at && (s.expires_at - 60) * 1000 > Date.now()); }

function authLogin(email, password){
  return fetch(SB_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password })
  }).then(function(r){
    return r.json().then(function(j){
      if(!r.ok){ const e = new Error((j && (j.error_description || j.msg || j.error)) || 'login failed'); e.status = r.status; throw e; }
      return j;
    });
  }).then(function(j){
    authSession = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), email: (j.user && j.user.email) || email, uid: (j.user && j.user.id) || null, displayName: (j.user && j.user.user_metadata && j.user.user_metadata.display_name) || null };
    saveAuth(authSession);
    return authSession;
  });
}

function authSignup(email, password, displayName){
  return fetch(SB_URL + '/auth/v1/signup', {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password, data: displayName ? { display_name: displayName } : {} })
  }).then(function(r){
    return r.json().then(function(j){
      if(!r.ok){ const e = new Error((j && (j.error_description || j.msg || j.error)) || 'signup failed'); e.status = r.status; e.msg = (j && (j.msg || j.error_description || j.error)) || ''; throw e; }
      return j;
    });
  }).then(function(j){
    /* Email confirmation ON: no session comes back — the user must confirm
       first, so do NOT sign in. Confirmation OFF: a session comes back and
       the new shop signs straight in, exactly like a login. */
    if(j.access_token){
      authSession = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), email: (j.user && j.user.email) || email, uid: (j.user && j.user.id) || null, displayName: (j.user && j.user.user_metadata && j.user.user_metadata.display_name) || displayName || null };
      saveAuth(authSession);
      return { signedIn: true };
    }
    return { signedIn: false };
  });
}

function authRefresh(){
  if(!authSession || !authSession.refresh_token) return Promise.resolve(null);
  return fetch(SB_URL + '/auth/v1/token?grant_type=refresh_token', {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: authSession.refresh_token })
  }).then(function(r){
    if(!r.ok) throw new Error('refresh ' + r.status);
    return r.json();
  }).then(function(j){
    authSession = { access_token: j.access_token, refresh_token: j.refresh_token || authSession.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), email: authSession.email, uid: (j.user && j.user.id) || authSession.uid || null, displayName: (j.user && j.user.user_metadata && j.user.user_metadata.display_name) || authSession.displayName || null };
    saveAuth(authSession);
    return authSession;
  }).catch(function(){ clearAuth(); return null; });
}

function updateAuthUI(){
  const el = document.getElementById('signedInAs');
  if(el) el.textContent = (authSession && authSession.email) ? t('login.signedInAs', {email: authSession.email}) : '';
}

function showLoginScreen(){
  setLoginMode('signin');
  showLoginBox('form');
  document.body.classList.add('logged-out');
  document.getElementById('loginScreen').classList.remove('hidden');
  updateAuthUI();
  applyLang();
}

/* Which login-card box is showing: 'form' (sign-in / sign-up / forgot),
   'noaccess' (no shop membership), 'picker' (choose a shop), 'reset'
   (password reset from a recovery link). */
function showLoginBox(which){
  const form = document.getElementById('loginFormFields');
  const noAccess = document.getElementById('noAccessBox');
  const picker = document.getElementById('shopPickerBox');
  const reset = document.getElementById('resetPwBox');
  if(form) form.classList.toggle('hidden', which !== 'form');
  if(noAccess) noAccess.classList.toggle('hidden', which !== 'noaccess');
  if(picker) picker.classList.toggle('hidden', which !== 'picker');
  if(reset) reset.classList.toggle('hidden', which !== 'reset');
}

function showLoginExpired(){
  const err = document.getElementById('loginError');
  if(err){ err.textContent = t('login.pwSessionExpired'); err.classList.remove('hidden'); }
}

/* Zero memberships, confirmed by the server: this account belongs to no
   shop. Never enter the app, never show shop data — the box offers the
   two honest ways forward: create a shop, or ask an owner to add you. */
function showNoAccess(){
  showLoginScreen();
  const nameInput = document.getElementById('newShopName');
  if(nameInput) nameInput.value = (DB && DB.settings && DB.settings.storeName) || '';
  showLoginBox('noaccess');
}

function showDeactivated(){
  showLoginScreen();
  const err = document.getElementById('loginError');
  if(err){ err.textContent = t('auth.accountDeactivated'); err.classList.remove('hidden'); }
}

function enterApp(){
  authErrorShown = false;
  document.body.classList.remove('logged-out');
  document.getElementById('loginScreen').classList.add('hidden');
  updateAuthUI();
  applyLang();
  showView(landingView());
  /* Resolve this user's memberships first (a staff account links itself
     via claim_staff_link, best effort), then pull — so the first pull is
     already scoped to the right shop and role. Resolution never rejects:
     on failure the app keeps working locally (offline) and the pull fails
     closed; on zero memberships the no-access screen is shown instead. */
  resolveMembership().then(function(res){
    if(res.status === 'deactivated'){ showDeactivated(); return; }
    if(res.status === 'ok' && res.memberships.length === 0){ showNoAccess(); return; }
    if(res.status === 'ok' && res.needsPick){ showShopPicker(); return; }
    applyRoleUI();
    initialSync();
    upsertProfile();
    if(can('staff_manage')) refreshShopDirectory();
  });
  drawerReconnect().then(function(){ renderHardware(); });
}

function isUuid(v){ return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v); }

/* Resolve this user's memberships. NOT create_shop(): a brand-new account
   has no membership yet, and creating a shop for whoever logs in first
   would hand a shop to a staff member. Shop creation is explicit — the
   "Create a new shop" button on the no-access screen (doCreateShop).
   Returns {status, memberships, needsPick}: 'ok' (memberships found,
   active shop resolved — or needsPick when several shops and no saved
   choice), 'deactivated' (profiles.deactivated_at is set), 'failed'
   (network / server error — keep working locally, fail closed),
   'none' (no session). Never rejects. */
function resolveMembership(){
  if(activeShopId) return Promise.resolve({ status:'ok', memberships: (loadMembership() && loadMembership().shops) || [], needsPick: false });
  if(!authSession) return Promise.resolve({ status:'none', memberships: [] });
  if(!membershipResolvePromise) membershipResolvePromise = doResolveMembership().then(function(res){ membershipResolvePromise = null; return res; });
  return membershipResolvePromise;
}

function resolveMembershipFresh(){
  activeShopId = null; activeBranchId = null; membershipResolvePromise = null;
  return resolveMembership();
}

function doResolveMembership(){
  const u = authUid();
  if(!u) return Promise.resolve({ status:'none', memberships: [] });
  /* Best effort: link any staff row for this email before reading
     memberships, so a staff member signing in for the first time is
     already a member when the list is read. A failure never blocks login. */
  const claimP = sbRpc('claim_staff_link', {}).catch(function(){ return null; });
  const membersP = claimP.then(function(){
    return fetch(SB_URL + '/rest/v1/shop_members?select=shop_id,role,branch_id&user_id=eq.' + encodeURIComponent(u) + '&active=eq.true&order=joined_at', { headers: sbHeaders(false) })
      .then(function(r){
        if(r.status === 401){ handleAuthError(401); throw new Error('shop_members 401'); }
        if(!r.ok) throw new Error('shop_members ' + r.status);
        return r.json();
      });
  });
  /* Deactivation is a marker the app reads at login (STEP 3 file 01 §2).
     An unreadable profile never blocks login — RLS still enforces. */
  const profP = fetch(SB_URL + '/rest/v1/profiles?select=deactivated_at&id=eq.' + encodeURIComponent(u) + '&limit=1', { headers: sbHeaders(false) })
    .then(function(r){ if(!r.ok) throw new Error('profiles ' + r.status); return r.json(); })
    .then(function(rows){ return (rows && rows[0] && rows[0].deactivated_at) || null; })
    .catch(function(){ return null; });
  return Promise.all([membersP, profP]).then(function(res){
    const rows = res[0] || [];
    if(res[1]) return { status:'deactivated', memberships: [] };
    if(!rows.length){
      clearMembership(); /* a removed member must not keep a stale role */
      return { status:'ok', memberships: [] };
    }
    const ids = rows.map(function(x){ return x.shop_id; });
    return fetch(SB_URL + '/rest/v1/shops?select=id,name&id=in.(' + ids.join(',') + ')', { headers: sbHeaders(false) })
      .then(function(r){ if(!r.ok) throw new Error('shops ' + r.status); return r.json(); })
      .then(function(shops){
        const byId = {};
        (shops || []).forEach(function(s){ byId[s.id] = s.name; });
        const memberships = rows.map(function(x){ return { shopId: x.shop_id, shopName: byId[x.shop_id] || '', role: x.role, branchId: x.branch_id || null }; });
        const cached = loadMembership();
        let pick = null;
        if(cached && cached.uid === u) pick = memberships.find(function(x){ return x.shopId === cached.shopId; }) || null;
        if(!pick && memberships.length === 1) pick = memberships[0];
        if(!pick){
          /* Several shops, no saved choice: remember the list, pick nothing. */
          saveMembership({ uid: u, shopId: null, shopName: '', role: null, branchId: null, branchName: '', staffId: null, staffName: '', shops: memberships });
          return { status:'ok', memberships: memberships, needsPick: true };
        }
        return resolveStaffAndBranch(pick, memberships).then(function(){ return { status:'ok', memberships: memberships, needsPick: false }; });
      });
  }).catch(function(){
    return { status:'failed', memberships: [] };
  });
}

/* Set the active shop/branch for one membership: the linked staff row
   (staffId/staffName — the order's cashier and the RLS staff_id) and the
   branch (cashiers are locked to their membership branch_id; owner/admin/
   manager with a NULL branch start on the shop's MAIN branch — the
   app_settings.default_branch_id fallback is not consulted because
   create_shop() does not set it — and may switch afterwards, §5). */
function resolveStaffAndBranch(pick, memberships){
  const u = authUid();
  const staffP = fetch(SB_URL + '/rest/v1/staff?select=id,name&auth_uid=eq.' + encodeURIComponent(u) + '&shop_id=eq.' + encodeURIComponent(pick.shopId) + '&limit=1', { headers: sbHeaders(false) })
    .then(function(r){ if(!r.ok) throw new Error('staff ' + r.status); return r.json(); })
    .then(function(rows){ return (rows && rows[0]) || null; })
    .catch(function(){ return null; });
  const branchP = (function(){
    let q;
    if(pick.branchId) q = 'id=eq.' + encodeURIComponent(pick.branchId);
    else {
      let saved = null;
      try{ saved = localStorage.getItem('posHtmlBranch.v1'); }catch(e){}
      q = (saved && isUuid(saved)) ? 'id=eq.' + encodeURIComponent(saved) : 'code=eq.MAIN';
    }
    return fetch(SB_URL + '/rest/v1/branches?select=id,name&shop_id=eq.' + encodeURIComponent(pick.shopId) + '&' + q + '&limit=1', { headers: sbHeaders(false) })
      .then(function(r){ if(!r.ok) throw new Error('branches ' + r.status); return r.json(); })
      .then(function(rows){ return (rows && rows[0]) || null; })
      .catch(function(){ return null; });
  })();
  return Promise.all([staffP, branchP]).then(function(res){
    const staff = res[0], branch = res[1];
    activeShopId = pick.shopId;
    activeBranchId = pick.branchId || (branch && branch.id) || null;
    saveMembership({ uid: u, shopId: pick.shopId, shopName: pick.shopName, role: pick.role, branchId: pick.branchId || null, branchName: (branch && branch.name) || '', staffId: (staff && staff.id) || null, staffName: (staff && staff.name) || '', shops: memberships });
    /* The role may have resolved while the app was already open (a
       background ensureShop): re-gate the UI now. */
    if(!document.body.classList.contains('logged-out')) applyRoleUI();
  });
}

/* The shop id for a Supabase call, resolving it first if needed. A shared
   in-flight attempt, so a pull of 7 tables does not fire 7 resolutions. */
function ensureShop(){
  if(activeShopId) return Promise.resolve(activeShopId);
  if(!authSession) return Promise.resolve(null);
  if(!membershipResolvePromise) membershipResolvePromise = resolveMembership().then(function(res){ membershipResolvePromise = null; return activeShopId; });
  return membershipResolvePromise;
}

/* Upsert the caller's profile row (id, display_name, email) so
   resolve_staff_uid() can find a user by email. The handle_new_user()
   trigger already creates the row at sign-up; this covers users created
   before STEP 3 and keeps the email current. Best effort: a failure is
   warned, never blocks the login. */
function upsertProfile(){
  const u = authUid();
  if(!u || !authSession) return;
  const name = (authSession.displayName || (authSession.email || '').split('@')[0] || 'Shop');
  fetch(SB_URL + '/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    headers: Object.assign(sbHeaders(true), { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ id: u, display_name: name, email: authSession.email || null })
  }).catch(function(e){ console.warn('profile upsert failed', e); });
}

/* Shop picker (login screen): one row per membership. Tapping one
   resolves its staff row + branch and enters the app. */
function showShopPicker(){
  showLoginScreen();
  const m = loadMembership();
  const shops = (m && m.shops) || [];
  const list = document.getElementById('shopPickerList');
  if(list){
    list.innerHTML = shops.map(function(s){
      return '<button type="button" class="list-row" data-pick-shop="' + esc(s.shopId) + '" style="width:100%;background:transparent;border:0;border-bottom:1px solid var(--border);text-align:left;cursor:pointer">' +
        '<div class="grow"><strong>' + esc(s.shopName || s.shopId) + '</strong><small>' + esc(tRole(s.role)) + '</small></div></button>';
    }).join('');
    list.querySelectorAll('[data-pick-shop]').forEach(function(b){
      b.addEventListener('click', function(){ pickShop(b.dataset.pickShop); });
    });
  }
  showLoginBox('picker');
}

function pickShop(shopId){
  const m = loadMembership();
  if(!m) return;
  const pick = (m.shops || []).find(function(s){ return s.shopId === shopId; });
  if(!pick) return;
  activeShopId = null; activeBranchId = null; membershipResolvePromise = null;
  resolveStaffAndBranch(pick, m.shops).then(function(){
    showLoginBox('form');
    enterApp();
  });
}

/* Explicit shop creation from the no-access screen. The shop name comes
   from the box (prefilled with the local store name); the new shop's
   owner membership is created by the create_shop() RPC, then the fresh
   membership is resolved and the app entered. */
function doCreateShop(){
  const input = document.getElementById('newShopName');
  const btn = document.getElementById('createShopBtn');
  const err = document.getElementById('loginError');
  const name = (input && input.value.trim()) || (DB && DB.settings && DB.settings.storeName) || 'Shop';
  if(err) err.classList.add('hidden');
  if(btn){ btn.disabled = true; btn.textContent = t('auth.creatingShop'); }
  sbRpc('create_shop', { p_name: name }).then(function(id){
    if(!isUuid(id)) throw new Error('create_shop returned no shop id');
    return resolveMembershipFresh().then(function(){
      showLoginBox('form');
      enterApp();
      toast(t('auth.shopCreated'));
    });
  }).catch(function(e){
    if(err){ err.textContent = rpcErrorMessage(e) || t('login.failed'); err.classList.remove('hidden'); }
  }).then(function(){
    if(btn){ btn.disabled = false; btn.textContent = t('auth.createShop'); }
  });
}

/* Switch to another of the user's shops (POS ⋯ menu): the old shop's
   local data is discarded (same shared-device guard, now per shop id),
   the cart is cleared, and the new shop is pulled fresh. The app never
   holds two shops' data at once. */
function switchShop(shopId){
  const m = loadMembership();
  if(!m || !m.shops) return;
  const pick = m.shops.find(function(s){ return s.shopId === shopId; });
  if(!pick || pick.shopId === activeShopId) return;
  closeModal();
  cart = [];
  activeShopId = null; activeBranchId = null; membershipResolvePromise = null;
  resolveStaffAndBranch(pick, m.shops).then(function(){
    discardForeignLocal();
    clearPushed();
    saveLocalShopId(activeShopId);
    applyRoleUI();
    showView(landingView());
    initialSync();
    if(can('staff_manage')) refreshShopDirectory();
  });
}

/* Switch the active branch (owner/admin/manager with a NULL membership
   branch only; cashiers are locked to theirs). Re-pulls the branch-scoped
   views so the register shows the new branch's orders and movements. */
function switchBranch(branchId){
  const b = shopBranchesCache.find(function(x){ return x.id === branchId; });
  if(!b) return;
  activeBranchId = b.id;
  try{ localStorage.setItem('posHtmlBranch.v1', b.id); }catch(e){}
  const m = loadMembership();
  if(m){ m.branchId = b.id; m.branchName = b.name; saveMembership(m); }
  closeModal();
  cart = [];
  applyRoleUI();
  pullCloud().then(function(cloud){
    DB = cloudToLocal(cloud);
    persistLocal();
    applyLang();
  }).catch(function(){ setSyncStatus('offline'); });
}

function openShopSwitcher(){
  if(deny('shop_switch')) return;
  const m = loadMembership();
  const shops = (m && m.shops) || [];
  openModal(
    '<header><h2>' + esc(t('auth.chooseShop')) + '</h2><button class="btn icon-btn" type="button" data-close>✕</button></header>' +
    shops.map(function(s){
      return '<button type="button" class="list-row" data-switch-shop="' + esc(s.shopId) + '" style="width:100%;background:transparent;border:0;border-bottom:1px solid var(--border);text-align:left;cursor:pointer">' +
        '<div class="grow"><strong>' + esc(s.shopName || s.shopId) + '</strong><small>' + esc(tRole(s.role)) + (s.shopId === activeShopId ? ' · ✓' : '') + '</small></div></button>';
    }).join('')
  );
  document.querySelectorAll('[data-switch-shop]').forEach(function(b){
    b.addEventListener('click', function(){ switchShop(b.dataset.switchShop); });
  });
}

function openBranchSwitcher(){
  if(!shopBranchesCache.length) return;
  openModal(
    '<header><h2>' + esc(t('staff.branch')) + '</h2><button class="btn icon-btn" type="button" data-close>✕</button></header>' +
    shopBranchesCache.map(function(b){
      return '<button type="button" class="list-row" data-switch-branch="' + esc(b.id) + '" style="width:100%;background:transparent;border:0;border-bottom:1px solid var(--border);text-align:left;cursor:pointer">' +
        '<div class="grow"><strong>' + esc(b.name) + '</strong><small>' + esc(b.code || '') + (b.id === activeBranchId ? ' · ✓' : '') + '</small></div></button>';
    }).join('')
  );
  document.querySelectorAll('[data-switch-branch]').forEach(function(b){
    b.addEventListener('click', function(){ switchBranch(b.dataset.switchBranch); });
  });
}

function signOut(){
  clearAuth();
  clearMembership();
  activeShopId = null; activeBranchId = null; membershipResolvePromise = null;
  shopMembersCache = []; shopBranchesCache = [];
  recoveryToken = null;
  cloudReady = false;
  pendingWipe = false;
  const pw = document.getElementById('loginPassword');
  if(pw) pw.value = '';
  const cf = document.getElementById('loginConfirmPassword');
  if(cf) cf.value = '';
  const cn = document.getElementById('loginConfirmNote');
  if(cn) cn.classList.add('hidden');
  const np = document.getElementById('newPassword');
  if(np) np.value = '';
  const cp = document.getElementById('confirmPassword');
  if(cp) cp.value = '';
  const pm = document.getElementById('pwMsg');
  if(pm) pm.classList.add('hidden');
  showLoginScreen();
}

function doLogin(){
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const err = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');
  err.classList.add('hidden');
  if(!email || !password){ err.textContent = t('common.required'); err.classList.remove('hidden'); return; }
  btn.disabled = true;
  btn.textContent = t('login.signingIn');
  authLogin(email, password).then(function(){
    document.getElementById('loginPassword').value = '';
    enterApp();
  }).catch(function(e){
    err.textContent = (e && e.status === 400) ? t('login.invalid') : t('login.failed');
    err.classList.remove('hidden');
  }).then(function(){
    btn.disabled = false;
    btn.textContent = t('login.button');
  });
}

let loginMode = 'signin'; /* 'signin' | 'signup' | 'forgot' — sign-in is the default view */

function setLoginMode(mode){
  loginMode = mode;
  const signup = mode === 'signup';
  const forgot = mode === 'forgot';
  document.getElementById('loginConfirmWrap').classList.toggle('hidden', !signup);
  document.getElementById('loginNameWrap').classList.toggle('hidden', !signup);
  document.getElementById('loginPwWrap').classList.toggle('hidden', forgot);
  document.getElementById('forgotLink').classList.toggle('hidden', mode !== 'signin');
  /* Swap the data-t keys so applyLang renders the right strings for the mode. */
  document.getElementById('loginSub').setAttribute('data-t', signup ? 'login.signupSubtitle' : 'login.subtitle');
  document.getElementById('loginBtn').setAttribute('data-t', signup ? 'login.signupButton' : forgot ? 'auth.sendResetLink' : 'login.button');
  document.getElementById('loginSwitchBtn').setAttribute('data-t', (signup || forgot) ? 'login.toSignin' : 'login.toSignup');
  document.getElementById('loginError').classList.add('hidden');
  applyLang();
}

function loginBtnLabel(){
  return t(loginMode === 'signup' ? 'login.signupButton' : loginMode === 'forgot' ? 'auth.sendResetLink' : 'login.button');
}

/* Forgot password: email only. GoTrue sends the reset link to the
   redirect_to URL (the live POS link — see the Site URL note in the
   runbook); the link lands back here with #type=recovery. */
function doForgotPassword(){
  const email = document.getElementById('loginEmail').value.trim();
  const err = document.getElementById('loginError');
  const note = document.getElementById('forgotNote');
  const btn = document.getElementById('loginBtn');
  err.classList.add('hidden');
  if(note) note.classList.add('hidden');
  if(!email || email.indexOf('@') < 1 || email.indexOf('.') < 0){ err.textContent = t('login.invalidEmail'); err.classList.remove('hidden'); return; }
  btn.disabled = true;
  btn.textContent = t('login.sendingLink');
  fetch(SB_URL + '/auth/v1/recover', {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, redirect_to: 'https://paingthutun-dev.github.io/POS-System/' })
  }).then(function(r){
    if(!r.ok) throw new Error('recover ' + r.status);
    if(note){ note.textContent = t('auth.resetLinkSent'); note.classList.remove('hidden'); }
    setLoginMode('signin');
  }).catch(function(){
    err.textContent = t('login.failed');
    err.classList.remove('hidden');
  }).then(function(){
    btn.disabled = false;
    btn.textContent = loginBtnLabel();
  });
}

/* The recovery token from the email link, stored by handleRecoveryHash()
   at boot. The reset form is shown only while it is set. */
let recoveryToken = null;

function handleRecoveryHash(){
  try{
    const hash = window.location.hash || '';
    if(hash.indexOf('type=recovery') < 0) return false;
    const params = new URLSearchParams(hash.slice(1));
    const tok = params.get('access_token');
    if(!tok) return false;
    recoveryToken = tok;
    /* Clear the token from the URL so a shared screenshot / history entry
       never leaks it. */
    if(window.history && window.history.replaceState) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return true;
  }catch(e){ return false; }
}

function doResetPassword(){
  const np = document.getElementById('resetNewPw');
  const cp = document.getElementById('resetConfirmPw');
  const err = document.getElementById('resetPwError');
  const btn = document.getElementById('resetPwBtn');
  const note = document.getElementById('loginConfirmNote');
  const newPw = np.value, conf = cp.value;
  err.classList.add('hidden');
  if(newPw.length < 6){ err.textContent = t('login.pwTooShort'); err.classList.remove('hidden'); return; }
  if(newPw !== conf){ err.textContent = t('login.pwMismatch'); err.classList.remove('hidden'); return; }
  if(!recoveryToken){ err.textContent = t('auth.resetExpired'); err.classList.remove('hidden'); return; }
  btn.disabled = true;
  btn.textContent = t('login.resettingPw');
  fetch(SB_URL + '/auth/v1/user', {
    method: 'PUT',
    headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + recoveryToken },
    body: JSON.stringify({ password: newPw })
  }).then(function(r){
    return r.json().then(function(j){
      if(!r.ok){ const e = new Error((j && (j.error_description || j.msg || j.error)) || 'reset failed'); e.status = r.status; throw e; }
      return j;
    });
  }).then(function(){
    recoveryToken = null;
    np.value = ''; cp.value = '';
    setLoginMode('signin');
    showLoginBox('form');
    if(note){ note.textContent = t('auth.resetDone'); note.classList.remove('hidden'); }
  }).catch(function(e){
    err.textContent = (e && (e.status === 401 || e.status === 403)) ? t('auth.resetExpired') : t('login.pwChangeFailed');
    err.classList.remove('hidden');
  }).then(function(){
    btn.disabled = false;
    btn.textContent = t('auth.resetPassword');
  });
}

function doSignup(){
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const conf = document.getElementById('loginConfirmPassword').value;
  const displayName = (document.getElementById('loginDisplayName').value || '').trim();
  const err = document.getElementById('loginError');
  const note = document.getElementById('loginConfirmNote');
  const btn = document.getElementById('loginBtn');
  err.classList.add('hidden');
  note.classList.add('hidden');
  if(!email || email.indexOf('@') < 1 || email.indexOf('.') < 0){ err.textContent = t('login.invalidEmail'); err.classList.remove('hidden'); return; }
  if(password.length < 6){ err.textContent = t('login.pwTooShort'); err.classList.remove('hidden'); return; }
  if(password !== conf){ err.textContent = t('login.pwMismatch'); err.classList.remove('hidden'); return; }
  btn.disabled = true;
  btn.textContent = t('login.signingUp');
  authSignup(email, password, displayName).then(function(res){
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginConfirmPassword').value = '';
    if(res.signedIn){ enterApp(); return; }
    /* Confirmation email sent: show it plainly and go back to sign-in —
       the new shop signs in after tapping the link in the email. */
    note.textContent = t('login.confirmEmailSent');
    note.classList.remove('hidden');
    setLoginMode('signin');
  }).catch(function(e){
    const m = (e && e.msg) || '';
    err.textContent = (/already registered/i.test(m)) ? t('login.alreadyRegistered') : t('login.signupFailed');
    err.classList.remove('hidden');
  }).then(function(){
    btn.disabled = false;
    btn.textContent = loginBtnLabel();
  });
}

function authChangePassword(newPw){
  if(!authSession || !authSession.access_token){ const e = new Error('no session'); e.status = 401; return Promise.reject(e); }
  return fetch(SB_URL + '/auth/v1/user', {
    method: 'PUT',
    headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authSession.access_token },
    body: JSON.stringify({ password: newPw })
  }).then(function(r){
    return r.json().then(function(j){
      if(!r.ok){ const e = new Error((j && (j.error_description || j.msg || j.error)) || 'change password failed'); e.status = r.status; throw e; }
      return j;
    });
  });
}

function doChangePassword(){
  const np = document.getElementById('newPassword');
  const cp = document.getElementById('confirmPassword');
  const msg = document.getElementById('pwMsg');
  const btn = document.getElementById('changePwBtn');
  const newPw = np.value;
  const conf = cp.value;
  msg.classList.remove('hidden');
  if(newPw.length < 6){ msg.style.color = 'var(--danger)'; msg.textContent = t('login.pwTooShort'); return; }
  if(newPw !== conf){ msg.style.color = 'var(--danger)'; msg.textContent = t('login.pwMismatch'); return; }
  btn.disabled = true;
  btn.textContent = t('login.changingPw');
  let ready;
  if(!authSession) ready = Promise.reject({ status: 401 });
  else if(authValid(authSession)) ready = Promise.resolve();
  else ready = authRefresh().then(function(s){ if(!s) throw { status: 401 }; });
  ready.then(function(){ return authChangePassword(newPw); }).then(function(){
    np.value = ''; cp.value = '';
    msg.style.color = 'var(--accent-strong)';
    msg.textContent = t('login.pwChanged');
  }).catch(function(e){
    msg.style.color = 'var(--danger)';
    msg.textContent = (e && (e.status === 401 || e.status === 403)) ? t('login.pwSessionExpired') : t('login.pwChangeFailed');
  }).then(function(){
    btn.disabled = false;
    btn.textContent = t('login.changePwBtn');
  });
}

function bindAuthUI(){
  document.getElementById('loginBtn').addEventListener('click', function(){ if(loginMode === 'signup') doSignup(); else if(loginMode === 'forgot') doForgotPassword(); else doLogin(); });
  document.getElementById('loginPassword').addEventListener('keydown', function(e){ if(e.key === 'Enter'){ if(loginMode === 'signup') doSignup(); else doLogin(); } });
  document.getElementById('loginEmail').addEventListener('keydown', function(e){ if(e.key === 'Enter'){ if(loginMode === 'signup') doSignup(); else if(loginMode === 'forgot') doForgotPassword(); else doLogin(); } });
  document.getElementById('loginConfirmPassword').addEventListener('keydown', function(e){ if(e.key === 'Enter') doSignup(); });
  document.getElementById('loginDisplayName').addEventListener('keydown', function(e){ if(e.key === 'Enter') doSignup(); });
  document.getElementById('loginSwitchBtn').addEventListener('click', function(){ setLoginMode(loginMode === 'signin' ? 'signup' : 'signin'); });
  document.getElementById('forgotLink').addEventListener('click', function(){ setLoginMode('forgot'); });
  document.getElementById('resetPwBtn').addEventListener('click', doResetPassword);
  document.getElementById('resetConfirmPw').addEventListener('keydown', function(e){ if(e.key === 'Enter') doResetPassword(); });
  document.getElementById('createShopBtn').addEventListener('click', doCreateShop);
  document.getElementById('noAccessSignOutBtn').addEventListener('click', signOut);
  document.getElementById('pickerSignOutBtn').addEventListener('click', signOut);
  document.getElementById('signOutBtn').addEventListener('click', signOut);
  document.getElementById('posSignOutBtn').addEventListener('click', signOut);
  document.getElementById('changePwBtn').addEventListener('click', doChangePassword);
}
