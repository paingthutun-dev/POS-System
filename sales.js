/* sales.js — split from pos-system.html 1.0.5 (mechanical split, no logic changes). POS grid, cart, checkout / Payment, receipt, barcode scan. */
'use strict';

let cart = [];            // {productId, qty}

let posCat = 'all';

let posQuery = '';

let posPage = 1;

let lastPosCols = 0;

let lastOrderId = null;

function cartQty(pid){
  const line = cart.find(function(l){ return l.productId === pid; });
  return line ? line.qty : 0;
}

/* The one totals rule for the whole app (STEP 4 §2): tax is charged on
   the DISCOUNTED subtotal — subtotal − discount, then tax, then total.
   The cart view, the checkout sheet and the sale RPC call all read from
   here, so the number on the screen is always the number sent to the
   server. The server recomputes the same rule and rejects the sale when
   the totals differ by more than 0.01 (TOTAL_MISMATCH). */
function cartTotals(discount){
  let sub = 0;
  cart.forEach(function(l){
    const p = prodById(l.productId); if(p) sub += effPrice(p) * l.qty;
  });
  sub = round2(sub);
  const disc = round2(Math.max(0, Math.min(sub, discount || 0)));
  const taxable = round2(sub - disc);
  const tax = round2(taxable * DB.settings.taxRate / 100);
  return { subtotal: sub, discount: disc, taxable: taxable, tax: tax, total: round2(taxable + tax) };
}

function addToCart(pid){
  const p = prodById(pid);
  if(!p || !p.active) return;
  if(p.stock <= 0){ toast(t('pos.outOfStock')); return; }
  const line = cart.find(function(l){ return l.productId === pid; });
  const cur = line ? line.qty : 0;
  if(cur + 1 > p.stock){ toast(t('pos.inStock', {count: p.stock})); return; }
  if(line) line.qty++;
  else cart.push({productId: pid, qty: 1});
  renderCart();
}

function setQty(pid, qty){
  const p = prodById(pid); if(!p) return;
  qty = Math.max(0, Math.min(p.stock, Math.floor(qty) || 0));
  const line = cart.find(function(l){ return l.productId === pid; });
  if(!line) return;
  if(qty === 0) cart = cart.filter(function(l){ return l.productId !== pid; });
  else line.qty = qty;
  renderCart();
}
/* POS swipe pages: 2 rows per page, swiped sideways like a phone app drawer
   (touch swipe on phone/tablet, mouse drag or arrow keys on desktop).
   Page size follows the page grid's column count (phone 3 cols -> 6/page),
   so a page always fits one screen without scrolling. The dots below the
   grid are indicators only — there are no page buttons. */

let posDragged = false; // set while a swipe/drag moved, so the tap does not add to cart

function posPageSize(){
  const grid = document.getElementById('productGrid');
  if(!grid) return 6;
  grid.innerHTML = '<div class="pos-page-grid"></div>';
  const cols = getComputedStyle(grid.firstChild).gridTemplateColumns.split(' ').filter(function(s){ return s; }).length || 3;
  return Math.max(2, cols) * 2;
}

function posTotalPages(){
  const grid = document.getElementById('productGrid');
  return (grid ? grid.querySelectorAll('.pos-page-grid').length : 1) || 1;
}

function updatePosDots(){
  const dots = document.getElementById('posPagerDots');
  if(!dots) return;
  dots.querySelectorAll('.dot').forEach(function(d, i){
    d.classList.toggle('on', i + 1 === posPage);
  });
}

function gotoPosPage(p){
  const grid = document.getElementById('productGrid');
  if(!grid) return;
  p = Math.max(1, Math.min(posTotalPages(), p));
  posPage = p;
  grid.scrollTo({left: (p - 1) * grid.clientWidth, behavior: 'smooth'});
  updatePosDots();
}

function snapPosPage(){
  const grid = document.getElementById('productGrid');
  if(!grid || !grid.clientWidth) return;
  gotoPosPage(Math.round(grid.scrollLeft / grid.clientWidth) + 1);
}

function posCardHtml(p){
  const price = effPrice(p), onSale = price < p.sellingPrice;
  const inCart = cartQty(p.id);
  const stockTxt = p.stock === 0 ? '<em class="low">' + esc(t('pos.outOfStock')) + '</em>'
    : p.stock <= p.minStock ? '<em class="low">' + esc(t('pos.inStock', {count: p.stock})) + '</em>'
    : '<em>' + esc(t('pos.inStock', {count: p.stock})) + '</em>';
  return '<button type="button" class="product-card' + (p.stock === 0 ? ' sold-out' : '') + '" data-pid="' + p.id + '"' + (p.stock === 0 ? ' disabled' : '') + '>' +
    (onSale ? '<span class="sale-badge">' + esc(t('products.sale')) + '</span>' : '') +
    (inCart > 0 ? '<span class="cart-count">' + inCart + '</span>' : '') +
    '<div class="product-photo">' + prodTile(p) + '</div>' +
    '<div class="product-copy"><small>' + esc(p.sku) + '</small><strong>' + esc(p.name) + '</strong>' +
    '<div class="p-price">' + money(price) + (onSale ? '<del>' + money(p.sellingPrice) + '</del>' : '') + '</div>' +
    stockTxt + '</div></button>';
}

function renderPos(){
  // categories
  const cats = ['all'].concat(CATEGORIES.filter(function(c){ return DB.products.some(function(p){ return p.active && p.category === c; }); }));
  document.getElementById('posCategories').innerHTML = cats.map(function(c){
    const label = c === 'all' ? t('common.all') : tCat(c);
    return '<button type="button" class="btn' + (posCat === c ? ' active' : '') + '" data-cat="' + esc(c) + '">' + esc(label) + '</button>';
  }).join('');
  document.querySelectorAll('#posCategories button').forEach(function(b){
    b.addEventListener('click', function(){ posCat = b.dataset.cat; posPage = 1; renderPos(); });
  });
  // grid
  const q = posQuery.trim().toLowerCase();
  const list = DB.products.filter(function(p){
    if(!p.active) return false;
    if(posCat !== 'all' && p.category !== posCat) return false;
    if(q && (p.name + ' ' + p.sku + ' ' + (p.barcode || '') + ' ' + p.category).toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  const grid = document.getElementById('productGrid');
  document.getElementById('posEmpty').classList.toggle('hidden', list.length > 0);
  const pageSize = posPageSize();
  lastPosCols = pageSize / 2;
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  if(posPage > totalPages) posPage = totalPages;
  if(posPage < 1) posPage = 1;
  let pagesHtml = '';
  for(let pi = 0; pi < totalPages; pi++){
    pagesHtml += '<div class="pos-page-grid" data-page="' + (pi + 1) + '">' +
      list.slice(pi * pageSize, (pi + 1) * pageSize).map(posCardHtml).join('') + '</div>';
  }
  grid.innerHTML = pagesHtml;
  const dots = document.getElementById('posPagerDots');
  if(totalPages <= 1){ dots.innerHTML = ''; dots.classList.add('hidden'); }
  else {
    dots.classList.remove('hidden');
    let dotsHtml = '';
    for(let di = 1; di <= totalPages; di++) dotsHtml += '<span class="dot' + (di === posPage ? ' on' : '') + '"></span>';
    dots.innerHTML = dotsHtml;
  }
  grid.scrollTo({left: (posPage - 1) * grid.clientWidth, behavior: 'instant'});
  grid.querySelectorAll('.product-card').forEach(function(card){
    card.addEventListener('click', function(){ if(posDragged) return; addToCart(card.dataset.pid); });
  });
  renderCart();
}

const TRASH_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

const BACK_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>';

const CART_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>';

const CHECK_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m8.5 12.5 2.5 2.5 5-5.5"/></svg>';

const PAY_ICON = {
  'Cash': '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2" ry="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01"/><path d="M18 12h.01"/></svg>',
  'Bank Transfer': '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/></svg>',
  'QR Payment': '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M21 14v.01"/><path d="M14 21v.01"/><path d="M21 21v.01"/></svg>',
  'Card': '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2" ry="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
  'Other': '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>'
};

function renderCart(){
  const panel = document.getElementById('cartPanel');
  const count = cart.reduce(function(s,l){ return s + l.qty; }, 0);
  const tot = cartTotals();
  if(panel){
  let itemsHtml = '';
  if(cart.length === 0){
    itemsHtml = '<div class="empty"><div class="empty-mark">🧾</div><h3>' + esc(t('cart.ready')) + '</h3><p>' + esc(t('cart.readyDetail')) + '</p></div>';
  } else {
    itemsHtml = cart.map(function(l){
      const p = prodById(l.productId); if(!p) return '';
      const price = effPrice(p);
      return '<div class="cart-item"><div class="cart-thumb">' + prodTile(p) + '</div><div class="cart-info"><strong>' + esc(p.name) + '</strong><small>' + esc(t('cart.each', {price: money(price)})) + '</small>' +
        '<span class="stepper"><button type="button" data-dec="' + p.id + '" aria-label="−">−</button>' +
        '<input type="number" value="' + l.qty + '" min="0" max="' + p.stock + '" data-qty="' + p.id + '" aria-label="Qty">' +
        '<button type="button" data-inc="' + p.id + '" aria-label="+">＋</button></span></div>' +
        '<div class="line-total"><strong>' + money(price * l.qty) + '</strong><button type="button" data-rm="' + p.id + '" aria-label="Remove">✕</button></div></div>';
    }).join('');
  }
  panel.innerHTML =
    '<div class="cart-head"><h2>' + esc(t('cart.title')) + '</h2>' +
    (cart.length ? '<button class="btn icon-btn cart-clear-btn" type="button" aria-label="' + esc(t('cart.clear')) + '">' + TRASH_SVG + '</button>' : '') + '</div>' +
    '<div class="cart-items">' + itemsHtml + '</div>' +
    '<div class="totals"><div><span>' + esc(t('cart.subtotal')) + '</span><strong>' + money(tot.subtotal) + '</strong></div>' +
    '<div><span>' + esc(t('cart.tax', {rate: DB.settings.taxRate})) + '</span><strong>' + money(tot.tax) + '</strong></div>' +
    '<div class="grand"><span>' + esc(t('cart.total')) + '</span><strong>' + money(tot.total) + '</strong></div></div>' +
    '<div class="cart-actions">' +
    (cart.length ? '<button class="cart-clear-btn" type="button">' + TRASH_SVG + '<span>' + esc(t('cart.clear')) + '</span></button>' : '') +
    '<button class="charge-btn" type="button" id="chargeBtn"' + (cart.length === 0 ? ' disabled' : '') + '><span>' + esc(t('cart.charge')) + '</span><span>' + money(tot.total) + '</span></button></div>';
  panel.querySelectorAll('.cart-clear-btn').forEach(function(b){ b.addEventListener('click', function(){ cart = []; renderCart(); }); });
  const chargeBtn = document.getElementById('chargeBtn');
  if(chargeBtn) chargeBtn.addEventListener('click', openCheckout);
  panel.querySelectorAll('[data-inc]').forEach(function(b){ b.addEventListener('click', function(){ addToCart(b.dataset.inc); }); });
  panel.querySelectorAll('[data-dec]').forEach(function(b){ b.addEventListener('click', function(){ setQty(b.dataset.dec, cartQty(b.dataset.dec) - 1); }); });
  panel.querySelectorAll('[data-rm]').forEach(function(b){ b.addEventListener('click', function(){ setQty(b.dataset.rm, 0); }); });
  panel.querySelectorAll('[data-qty]').forEach(function(inp){
    inp.addEventListener('change', function(){ setQty(inp.dataset.qty, parseInt(inp.value, 10)); });
  });
  }
  // mobile cart FAB (icon + count badge)
  const fab = document.getElementById('mobileCartFab');
  if(count > 0){
    fab.classList.remove('hidden');
    document.getElementById('mobileCartCount').textContent = count;
  } else fab.classList.add('hidden');
}

/* ================= checkout & receipt ================= */

function openCheckout(){
  if(deny('sell')) return;
  if(cart.length === 0) return;
  const tot = cartTotals();
  const custOpts = DB.customers.map(function(c){
    return '<option value="' + c.id + '">' + esc(c.name) + (c.phone ? ' · ' + esc(c.phone) : '') + '</option>';
  }).join('');
  const payBtns = PAY_METHODS.map(function(m, i){
    return '<button type="button" data-pay="' + esc(m) + '"' + (i === 0 ? ' class="active"' : '') + '><span class="pay-ico">' + (PAY_ICON[m] || '') + '</span><span>' + esc(tPay(m)) + '</span></button>';
  }).join('');
  openModal(
    '<header class="co-head"><button class="btn icon-btn" type="button" data-close aria-label="Back">' + BACK_SVG + '</button><h2>' + esc(t('checkout.title')) + '</h2></header>' +
    '<div class="total-banner"><span class="total-banner-ico">' + CART_SVG + '</span><div class="total-banner-text"><span>' + esc(t('checkout.totalAmount')) + '</span><strong id="coTotalBanner">' + money(tot.total) + '</strong></div></div>' +
    '<div class="co-grid"><div class="co-col">' +
    '<div class="field"><span>' + esc(t('checkout.customer')) + '</span><select id="coCustomer">' + custOpts + '</select></div>' +
    '<div class="field"><span>' + esc(t('checkout.orderDiscount')) + '</span><input type="number" id="coDiscount" min="0" step="any" value="0"></div>' +
    '<div class="summary-box"><div><span>' + esc(t('cart.subtotal')) + '</span><strong id="coSub">' + money(tot.subtotal) + '</strong></div>' +
    '<div><span>' + esc(t('checkout.orderDiscount')) + '</span><strong id="coDiscVal">' + money(0) + '</strong></div>' +
    '<div><span>' + esc(t('cart.tax', {rate: DB.settings.taxRate})) + '</span><strong id="coTax">' + money(tot.tax) + '</strong></div>' +
    '<div><span>' + esc(t('checkout.change')) + '</span><strong id="coChange">' + money(0) + '</strong></div></div>' +
    '</div><div class="co-col">' +
    '<div class="field"><span>' + esc(t('checkout.paymentMethod')) + '</span><div class="payment-methods">' + payBtns + '</div></div>' +
    '<div id="coCashBox"><div class="cash-readout"><span>' + esc(t('checkout.amountReceived')) + '</span>' +
    '<div class="cash-entry"><b>' + esc(CUR[DB.settings.currency].sym) + '</b><input type="number" id="coReceived" min="0" step="any" inputmode="decimal" placeholder="0"></div></div>' +
    '<div class="keypad">' +
    ['1','2','3','4','5','6','7','8','9','00','0','.'].map(function(k){ return '<button type="button" data-key="' + k + '">' + k + '</button>'; }).join('') +
    '<button type="button" class="quick-cash" data-key="exact">' + esc(t('checkout.next100')) + '</button>' +
    '<button type="button" data-key="clear">C</button></div></div>' +
    '</div></div>' +
    '<div class="form-actions split" style="margin-top:12px"><button class="btn" type="button" data-close>' + esc(t('common.cancel')) + '</button>' +
    '<button class="btn primary" type="button" id="coComplete">' + CHECK_SVG + esc(t('checkout.complete')) + '</button></div>'
  );
  document.getElementById('modalBox').classList.add('wide');
  let payMethod = 'Cash';
  let discount = 0;
  function recalc(){
    discount = Math.max(0, Math.min(tot.subtotal, parseFloat(document.getElementById('coDiscount').value) || 0));
    const t = cartTotals(discount);
    document.getElementById('coDiscVal').textContent = money(t.discount);
    document.getElementById('coTax').textContent = money(t.tax);
    document.getElementById('coTotalBanner').textContent = money(t.total);
    const recv = payMethod === 'Cash' ? (parseFloat(document.getElementById('coReceived').value) || 0) : t.total;
    document.getElementById('coChange').textContent = money(Math.max(0, round2(recv - t.total)));
    return { taxable: t.taxable, tax: t.tax, total: t.total, received: recv };
  }
  document.getElementById('coDiscount').addEventListener('input', recalc);
  document.getElementById('coReceived').addEventListener('input', recalc);
  document.querySelectorAll('[data-pay]').forEach(function(b){
    b.addEventListener('click', function(){
      payMethod = b.dataset.pay;
      document.querySelectorAll('[data-pay]').forEach(function(x){ x.classList.toggle('active', x === b); });
      document.getElementById('coCashBox').classList.toggle('hidden', payMethod !== 'Cash');
      recalc();
    });
  });
  document.querySelectorAll('[data-key]').forEach(function(b){
    b.addEventListener('click', function(){
      const inp = document.getElementById('coReceived');
      const k = b.dataset.key;
      if(k === 'clear') inp.value = '';
      else if(k === 'exact'){
        const r = recalc();
        const step = DB.settings.currency === 'MMK' ? 1000 : 100;
        inp.value = String(Math.ceil(r.total / step) * step);
      }
      else inp.value = (inp.value || '') + k;
      recalc();
    });
  });
  document.getElementById('coComplete').addEventListener('click', function(){
    if(deny('sell')) return;
    const btn = document.getElementById('coComplete');
    if(btn.disabled) return; /* double-tap guard (STEP 10): one Confirm = one sale — the server also dedupes by idempotency key, but the button must never send twice */
    const r = recalc();
    if(payMethod === 'Cash' && r.received < r.total){ toast(t('checkout.notEnough')); return; }
    btn.disabled = true;
    completeSaleRpc(payMethod, document.getElementById('coCustomer').value, discount, r)
      .finally(function(){ if(btn.isConnected) btn.disabled = false; });
  });
  document.getElementById('coReceived').addEventListener('keydown', function(e){
    if(e.key === 'Enter') document.getElementById('coComplete').click();
  });
  if(window.innerWidth >= 768) document.getElementById('coReceived').focus();
  recalc();
}

/* Local order numbers (NS-2601…) are the OFFLINE FALLBACK only: when the
   sale RPC cannot be reached at all, the sale is recorded locally as
   Pending with one of these numbers and queued in the outbox (Stage 5b
   flushes it — the server then replaces it with the real number). The
   server mints the real number (PREFIX-YEAR-000001) for every online
   sale; nothing here calls next_order_number() any more. */
function localOrderNumber(){
  if(typeof DB.nextOrderSeq !== 'number') DB.nextOrderSeq = 5;
  const n = 'NS-2601' + String(1000 + DB.nextOrderSeq).slice(1);
  DB.nextOrderSeq++;
  return n;
}

/* One sale = one complete_sale() RPC call (STEP 4 §3). The server checks
   the branch, locks the stock, computes the totals and writes the order,
   order_items, payments and inventory_movements in one transaction, and
   mints the invoice number (PREFIX-YEAR-000001). The idempotency key is
   one per checkout attempt: a retry after a lost reply returns the
   original order instead of a second one. The walk-in customer ('c4') is
   sent as null — the server fills the name from the order row. */
function completeSaleRpc(payMethod, customerId, discount, r){
  const mem = loadMembership();
  const cashier = (mem && mem.staffName) || (authSession && authSession.displayName) || 'Admin';
  const items = cart.map(function(l){
    const p = prodById(l.productId);
    return { product_id: p.id, quantity: l.qty, unit_price: effPrice(p) };
  });
  const checkoutKey = uuidv4(); /* MUST be a real UUID: complete_sale()
    declares p_idempotency_key uuid — uid('ck-...') text is rejected by
    PostgREST before the function runs (every 1.0.9 online sale failed). */
  const payload = {
    p_shop_id: activeShopId, p_branch_id: activeBranchId,
    p_items: items, p_customer_id: (customerId && customerId !== 'c4' ? customerId : null),
    p_order_discount: discount, p_payment_method: payMethod,
    p_amount_received: r.received, p_idempotency_key: checkoutKey,
    p_expected_total: r.total
  };
  return sbRpc('complete_sale', payload).then(function(summary){
    applyServerOrder(summary, cashier, payMethod);
  }).catch(function(err){
    if(isNetworkError(err)){
      /* Offline: hold the sale as Pending (see holdSaleOffline). */
      holdSaleOffline(payMethod, customerId, discount, r, cashier, checkoutKey, payload);
      return;
    }
    console.warn('[sale] complete_sale failed', err);
    toast(mapRpcError(err));
  });
}

/* The server's sale_summary() reply becomes the local order. The server
   is the truth for numbers, totals and the invoice number; the till keeps
   the local stock view in step from the items it just sold (the next
   cloud pull replaces these rows with the server's own). */
function applyServerOrder(summary, cashier, payMethod){
  const mem = loadMembership();
  const items = (summary.items || []).map(function(it){
    return { productId: it.product_id, productName: it.product_name, sku: it.sku || '', quantity: it.quantity, unitPrice: Number(it.unit_price) || 0, discount: Number(it.discount) || 0, lineTotal: Number(it.line_total) || 0 };
  });
  const order = {
    id: summary.order_id, orderNumber: summary.order_number, customerId: summary.customer_id || 'c4', cashier: cashier, staffId: (mem && mem.staffId) || null,
    subtotal: Number(summary.subtotal) || 0, discount: Number(summary.discount) || 0, tax: Number(summary.tax) || 0, total: Number(summary.total) || 0,
    paymentMethod: summary.payment_method || payMethod, amountReceived: Number(summary.amount_received) || 0, changeAmount: Number(summary.change_amount) || 0,
    status: summary.status || 'Completed', createdAt: (summary.created_at ? Date.parse(summary.created_at) : Date.now()), items: items
  };
  DB.orders.unshift(order);
  /* local stock view: decrement what was just sold + a display-only
     movement row (the server wrote the real one; the next pull replaces
     this mirror). */
  cart.forEach(function(l){
    const p = prodById(l.productId);
    if(!p) return;
    const prev = p.stock;
    p.stock = Math.max(0, p.stock - l.qty);
    DB.movements.unshift({ id: uid('m'), productId: p.id, type: 'sale', quantity: -l.qty, previousStock: prev, newStock: p.stock, reference: order.orderNumber, note: t('inventory.sale'), staffId: order.staffId, createdAt: Date.now() });
  });
  save();
  cart = [];
  renderCurrent();
  lastOrderId = order.id;
  closeModal();
  showReceipt(order.id, true);
  toast(t('checkout.saleCompleted'));
  if(payMethod === 'Cash') maybeAutoKick(order);
}

/* ⚠️ OFFLINE FALLBACK (Stage 4 — temporary, until Stage 5b): the sale
   RPC could not be reached, so the sale is recorded locally as Pending
   with a local number and queued in the outbox (posHtmlOutbox.v1).
   NOTHING sends it yet — Stage 5b adds the flush worker. Do NOT re-enter
   the same sale by hand: on flush, the idempotency key makes the server
   return this one order instead of a second sale. The local stock
   decrement below can disagree with the server if another device sold
   the same product meanwhile (audit C-1 — fixed properly in 5b). */
function holdSaleOffline(payMethod, customerId, discount, r, cashier, checkoutKey, payload){
  const mem = loadMembership();
  const tot = cartTotals(discount);
  const orderNum = localOrderNumber();
  const items = cart.map(function(l){
    const p = prodById(l.productId);
    const price = effPrice(p);
    return { productId: p.id, productName: p.name, sku: p.sku, quantity: l.qty, unitPrice: price, discount: 0, lineTotal: round2(price * l.qty) };
  });
  const order = {
    id: uid('o'), orderNumber: orderNum, customerId: customerId || 'c4', cashier: cashier, staffId: (mem && mem.staffId) || null,
    subtotal: tot.subtotal, discount: discount, tax: r.tax, total: r.total,
    paymentMethod: payMethod, amountReceived: r.received, changeAmount: round2(Math.max(0, r.received - r.total)),
    status: 'Pending', createdAt: Date.now(), items: items
  };
  DB.orders.unshift(order);
  cart.forEach(function(l){
    const p = prodById(l.productId);
    if(!p) return;
    const prev = p.stock;
    p.stock = Math.max(0, p.stock - l.qty);
    DB.movements.unshift({ id: uid('m'), productId: p.id, type: 'sale', quantity: -l.qty, previousStock: prev, newStock: p.stock, reference: orderNum, note: t('inventory.sale'), staffId: order.staffId, createdAt: Date.now() });
  });
  queueHeldSale({ key: checkoutKey, payload: payload, localOrderId: order.id, createdAt: Date.now() });
  save();
  cart = [];
  renderCurrent();
  lastOrderId = order.id;
  closeModal();
  showReceipt(order.id, true);
  toast(t('checkout.savedOffline'));
  if(payMethod === 'Cash') maybeAutoKick(order);
}

function receiptHtml(order){
  const s = DB.settings;
  const cust = custById(order.customerId);
  const cls = s.receiptSize === '58mm' ? 'w58' : 'w80';
  const lines = order.items.map(function(it){
    return '<div class="receipt-item"><div class="ri-main"><span>' + esc(it.productName) + ' × ' + it.quantity + '</span><strong>' + money(it.lineTotal) + '</strong></div>' +
      '<small>' + money(it.unitPrice) + ' × ' + it.quantity + (it.discount > 0 ? ' · −' + money(it.discount) : '') + '</small></div>';
  }).join('');
  return '<div class="receipt-paper ' + cls + '">' +
    '<h3>' + esc(s.storeName) + '</h3><p>' + esc(s.address) + '<br>' + esc(s.phone) + '</p>' +
    '<div class="receipt-meta"><span>' + esc(t('receipt.order')) + ': ' + esc(order.orderNumber) + '</span>' +
    '<span>' + esc(t('receipt.date')) + ': ' + fmtDate(order.createdAt) + '</span>' +
    '<span>' + esc(t('receipt.cashier')) + ': ' + esc(order.cashier) + '</span>' +
    '<span>' + esc(t('receipt.customer')) + ': ' + esc(cust ? cust.name : t('common.walkIn')) + '</span></div>' +
    lines +
    '<div class="receipt-summary">' +
    '<div class="receipt-line"><span>' + esc(t('receipt.subtotal')) + '</span><span>' + money(order.subtotal) + '</span></div>' +
    (order.discount > 0 ? '<div class="receipt-line"><span>' + esc(t('receipt.discount')) + '</span><span>−' + money(order.discount) + '</span></div>' : '') +
    '<div class="receipt-line"><span>' + esc(t('receipt.tax')) + '</span><span>' + money(order.tax) + '</span></div>' +
    '<div class="receipt-total"><span>' + esc(t('receipt.total')) + '</span><strong>' + money(order.total) + '</strong></div>' +
    '<div class="receipt-line"><span>' + esc(t('receipt.payment')) + '</span><span>' + esc(tPay(order.paymentMethod)) + '</span></div>' +
    '<div class="receipt-line"><span>' + esc(t('receipt.amountReceived')) + '</span><span>' + money(order.amountReceived) + '</span></div>' +
    '<div class="receipt-line"><span>' + esc(t('receipt.change')) + '</span><span>' + money(order.changeAmount) + '</span></div></div>' +
    '<p class="thanks">' + esc(t('receipt.thanks')) + '</p></div>';
}

function showReceipt(orderId, justCompleted){
  const order = DB.orders.find(function(o){ return o.id === orderId; });
  if(!order) return;
  /* A Pending (held offline) sale shows the sale as completed AND an
     amber notice below it — the goods changed hands, but the sale is NOT
     on the server yet and will be sent when the connection returns. */
  const pending = (order.status === 'Pending');
  openModal(
    (justCompleted ? '<div class="success-mark">✓</div><h2 style="text-align:center;margin:0 0 14px">' + esc(t('checkout.saleCompleted')) + '</h2>' +
      (pending ? '<div class="pending-banner"><strong>' + esc(t('checkout.pendingSale')) + '</strong><p>' + esc(t('checkout.pendingNotice')) + '</p></div>' : '')
      : '<header><h2>' + esc(t('receipt.title')) + ' · ' + esc(order.orderNumber) + '</h2><button class="btn icon-btn" type="button" data-close>✕</button></header>') +
    '<div id="receiptView">' + receiptHtml(order) + '</div>' +
    '<div class="receipt-actions"><button class="btn" type="button" id="rcPrint">🖨 ' + esc(t('receipt.print')) + '</button>' +
    '<button class="btn" type="button" id="rcDrawer">💵 ' + esc(t('drawer.open')) + '</button>' +
    '<button class="btn" type="button" data-close>' + esc(t('common.close')) + '</button>' +
    '<button class="btn primary" type="button" id="rcNew">' + esc(t('receipt.newSale')) + '</button></div>'
  );
  document.getElementById('rcPrint').addEventListener('click', function(){
    document.getElementById('printArea').innerHTML = receiptHtml(order);
    window.print();
  });
  document.getElementById('rcDrawer').addEventListener('click', openDrawerManual);
  document.getElementById('rcNew').addEventListener('click', function(){
    closeModal(); showView('pos');
  });
}

/* ================= modal helpers ================= */
// The cart panel is moved into the modal when the mobile cart sheet opens.
// openModal/closeModal replace modalBox.innerHTML, which would destroy the
// panel if it is still inside the modal. Rescue it first.

const SCAN_FORMATS = ['ean_13','ean_8','code_128','code_39','upc_a','upc_e','qr_code'];

let scanStream = null, scanDetector = null, scanTimer = null, scanMode = 'pos', scanPaused = false;

let scanLastCode = '', scanLastAt = 0, scanNotFoundCode = '';

function scanSetStatus(msg){ document.getElementById('scanStatus').textContent = msg || ''; }

function scanShowMessage(msg){
  document.getElementById('scanVideo').style.visibility = 'hidden';
  document.getElementById('scanFrame').style.visibility = 'hidden';
  scanSetStatus(msg);
}

function openScanner(mode){
  scanMode = mode || 'pos';
  scanPaused = false; scanNotFoundCode = '';
  document.getElementById('scanNotFound').classList.add('hidden');
  document.getElementById('scanWrap').classList.remove('hidden');
  document.getElementById('scanVideo').style.visibility = 'visible';
  document.getElementById('scanFrame').style.visibility = 'visible';
  if(!window.isSecureContext){ scanShowMessage(t('scan.needHttps')); return; }
  if(!('BarcodeDetector' in window) || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)){
    scanShowMessage(t('scan.unsupported')); return;
  }
  try { scanDetector = new BarcodeDetector({ formats: SCAN_FORMATS }); }
  catch(e){ scanShowMessage(t('scan.unsupported')); return; }
  scanSetStatus(t('scan.hint'));
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(function(stream){
    scanStream = stream;
    const video = document.getElementById('scanVideo');
    video.srcObject = stream;
    return video.play();
  }).then(function(){
    scanTick();
  }).catch(function(){
    scanShowMessage(t('scan.cameraDenied'));
  });
}

function scanTick(){
  if(!scanStream) return;
  const video = document.getElementById('scanVideo');
  if(video.readyState >= 2 && !scanPaused && scanDetector){
    try {
      scanDetector.detect(video).then(function(codes){
        if(codes && codes.length) handleScan(codes[0].rawValue);
      }).catch(function(){ /* ignore frame errors */ });
    } catch(e){ /* BarcodeDetector unavailable */ }
  }
  scanTimer = setTimeout(scanTick, 200);
}

function handleScan(code){
  if(!code) return;
  const now = Date.now();
  if(code === scanLastCode && now - scanLastAt < 1500) return;
  scanLastCode = code; scanLastAt = now;
  if(scanMode === 'product'){
    const field = document.getElementById('pfBarcode');
    if(field) field.value = code;
    toast(t('scan.barcodeFilled', {code: code}));
    closeScanner();
    return;
  }
  const p = DB.products.find(function(x){ return x.active && (x.barcode || '') === code; });
  if(p){
    if(p.stock <= 0){ scanSetStatus(t('pos.outOfStock')); return; }
    const before = cartQty(p.id);
    addToCart(p.id);
    if(cartQty(p.id) > before){
      if(navigator.vibrate) navigator.vibrate(80);
      scanSetStatus(t('scan.added', {name: p.name}));
    } else {
      scanSetStatus(t('pos.inStock', {count: p.stock}));
    }
  } else {
    scanNotFoundCode = code;
    scanPaused = true;
    document.getElementById('scanNotFoundCode').textContent = code;
    document.getElementById('scanNotFoundText').textContent = t('scan.notFound');
    document.getElementById('scanNotFound').classList.remove('hidden');
    scanSetStatus('');
  }
}

function closeScanner(){
  if(scanTimer){ clearTimeout(scanTimer); scanTimer = null; }
  if(scanStream){ scanStream.getTracks().forEach(function(tr){ tr.stop(); }); scanStream = null; }
  scanDetector = null;
  document.getElementById('scanWrap').classList.add('hidden');
  document.getElementById('scanNotFound').classList.add('hidden');
  const video = document.getElementById('scanVideo');
  video.srcObject = null;
  scanPaused = false;
}

/* ================= products ================= */
