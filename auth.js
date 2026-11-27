/* auth.js — split from pos-system.html 1.0.5 (mechanical split, no logic changes). Owner guard, session, login / sign-up, password, backfill. */
'use strict';

const OWNER_KEY = 'posHtmlOwner.v1'; /* uid of the shop whose data lives in this device's localStorage */

function loadOwner(){ try{ return localStorage.getItem(OWNER_KEY) || null; }catch(e){ return null; } }

function saveOwner(u){ try{ if(u) localStorage.setItem(OWNER_KEY, u); }catch(e){} }
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
  return false;
}

/* ================= Supabase Auth (plain fetch, no libraries) ================= */
/* Sign-in + sign-up in the app (GoTrue). The session (user access token) is
   stored in localStorage; data calls use the user token, never the anon key,
   for Authorization. Every shop's rows carry owner_id = the user's auth id,
   and pulls are filtered to that id, so shops never see each other's data. */

const AUTH_KEY = 'posHtmlAuth.v1';

let authSession = null;   /* {access_token, refresh_token, expires_at (epoch seconds), email, uid} */

/* The signed-in user's shop + active branch, resolved once after login
   (see resolveShop). Single shop per owner — no shop picker. Session
   state only; nothing here is shown in the UI. */
let activeShopId = null;
let activeBranchId = null;
let shopResolvePromise = null; /* in-flight resolveShop(), so concurrent callers share one attempt */

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
    authSession = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), email: (j.user && j.user.email) || email, uid: (j.user && j.user.id) || null };
    saveAuth(authSession);
    return authSession;
  });
}

function authSignup(email, password){
  return fetch(SB_URL + '/auth/v1/signup', {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password })
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
      authSession = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), email: (j.user && j.user.email) || email, uid: (j.user && j.user.id) || null };
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
    authSession = { access_token: j.access_token, refresh_token: j.refresh_token || authSession.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600), email: authSession.email, uid: (j.user && j.user.id) || authSession.uid || null };
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
  document.body.classList.add('logged-out');
  document.getElementById('loginScreen').classList.remove('hidden');
  updateAuthUI();
  applyLang();
}

function enterApp(){
  document.body.classList.remove('logged-out');
  document.getElementById('loginScreen').classList.add('hidden');
  updateAuthUI();
  applyLang();
  showView('dashboard');
  /* Resolve this user's shop + MAIN branch first (a brand-new account gets
     its shop created by create_shop()), then pull — so the first pull is
     already scoped to the right shop. Resolution never rejects: on failure
     the shop stays unresolved and the pull fails closed (local data kept). */
  resolveShop().then(function(){ initialSync(); });
  drawerReconnect().then(function(){ renderHardware(); });
}

function isUuid(v){ return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v); }

/* Resolve this user's shop (role owner) and its MAIN branch. A brand-new
   account has no membership yet, so create_shop() creates the shop
   (atomically: shop + owner membership + Main Branch + app_settings +
   order sequence). Never rejects: on any failure the shop stays
   unresolved (nulls) and callers fail closed — the app keeps working
   locally and retries resolution on the next Supabase call. */
function resolveShop(){
  const u = authUid();
  if(!u){ activeShopId = null; activeBranchId = null; return Promise.resolve(null); }
  return fetch(SB_URL + '/rest/v1/shop_members?select=shop_id,role&user_id=eq.' + encodeURIComponent(u) + '&role=eq.owner&active=eq.true&order=joined_at&limit=1', { headers: sbHeaders(false) })
    .then(function(r){ if(!r.ok) throw new Error('shop_members ' + r.status); return r.json(); })
    .then(function(rows){
      if(rows && rows.length && rows[0].shop_id) return rows[0].shop_id;
      /* No shop yet: create one for this new account. */
      const name = (DB && DB.settings && DB.settings.storeName) || 'Shop';
      return sbRpc('create_shop', { p_name: name }).then(function(id){
        if(!isUuid(id)) throw new Error('create_shop returned no shop id');
        return id;
      });
    })
    .then(function(shopId){
      if(!authSession){ activeShopId = null; activeBranchId = null; return null; }
      activeShopId = shopId;
      return fetch(SB_URL + '/rest/v1/branches?select=id&shop_id=eq.' + encodeURIComponent(shopId) + '&code=eq.MAIN&limit=1', { headers: sbHeaders(false) })
        .then(function(r){ if(!r.ok) throw new Error('branches ' + r.status); return r.json(); })
        .then(function(rows){ activeBranchId = (rows && rows.length && rows[0].id) || null; })
        .catch(function(){ activeBranchId = null; })
        .then(function(){ return activeShopId; });
    })
    .catch(function(){
      activeShopId = null; activeBranchId = null;
      return null;
    });
}

/* The shop id for a Supabase call, resolving it first if needed. A shared
   in-flight attempt, so a pull of 7 tables does not fire 7 resolutions. */
function ensureShop(){
  if(activeShopId) return Promise.resolve(activeShopId);
  if(!authSession) return Promise.resolve(null);
  if(!shopResolvePromise) shopResolvePromise = resolveShop().then(function(id){ shopResolvePromise = null; return id; });
  return shopResolvePromise;
}

function signOut(){
  clearAuth();
  activeShopId = null; activeBranchId = null; shopResolvePromise = null;
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

let loginMode = 'signin'; /* 'signin' | 'signup' — sign-in is the default view */

function setLoginMode(mode){
  loginMode = mode;
  const signup = mode === 'signup';
  document.getElementById('loginConfirmWrap').classList.toggle('hidden', !signup);
  /* Swap the data-t keys so applyLang renders the right strings for the mode. */
  document.getElementById('loginSub').setAttribute('data-t', signup ? 'login.signupSubtitle' : 'login.subtitle');
  document.getElementById('loginBtn').setAttribute('data-t', signup ? 'login.signupButton' : 'login.button');
  document.getElementById('loginSwitchBtn').setAttribute('data-t', signup ? 'login.toSignin' : 'login.toSignup');
  document.getElementById('loginError').classList.add('hidden');
  applyLang();
}

function doSignup(){
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const conf = document.getElementById('loginConfirmPassword').value;
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
  authSignup(email, password).then(function(res){
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
    btn.textContent = t(loginMode === 'signup' ? 'login.signupButton' : 'login.button');
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
  document.getElementById('loginBtn').addEventListener('click', function(){ if(loginMode === 'signup') doSignup(); else doLogin(); });
  document.getElementById('loginPassword').addEventListener('keydown', function(e){ if(e.key === 'Enter'){ if(loginMode === 'signup') doSignup(); else doLogin(); } });
  document.getElementById('loginEmail').addEventListener('keydown', function(e){ if(e.key === 'Enter'){ if(loginMode === 'signup') doSignup(); else doLogin(); } });
  document.getElementById('loginConfirmPassword').addEventListener('keydown', function(e){ if(e.key === 'Enter') doSignup(); });
  document.getElementById('loginSwitchBtn').addEventListener('click', function(){ setLoginMode(loginMode === 'signup' ? 'signin' : 'signup'); });
  document.getElementById('signOutBtn').addEventListener('click', signOut);
  document.getElementById('posSignOutBtn').addEventListener('click', signOut);
  document.getElementById('changePwBtn').addEventListener('click', doChangePassword);
}
