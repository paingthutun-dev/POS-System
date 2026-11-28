/* reports.js — split from pos-system.html 1.0.5 (mechanical split, no logic changes). Dashboard, orders history, expenses, Excel export. */
'use strict';

function xlsxCrc32(bytes){
  if(!xlsxCrc32.table){
    const tb = new Uint32Array(256);
    for(let n = 0; n < 256; n++){
      let c = n;
      for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      tb[n] = c >>> 0;
    }
    xlsxCrc32.table = tb;
  }
  let crc = 0xFFFFFFFF;
  for(let i = 0; i < bytes.length; i++) crc = xlsxCrc32.table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function xlsxZip(files){
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  files.forEach(function(f){
    const nameBytes = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = xlsxCrc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);   // UTF-8 filenames
    lh.setUint16(8, 0, true);        // method: STORED
    lh.setUint16(10, 0, true);
    lh.setUint16(12, 0x21, true);    // 1980-01-01
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, nameBytes, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, 0, true);
    ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint16(30, 0, true);
    ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true);
    ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  });
  const cdSize = central.reduce(function(s, b){ return s + b.byteLength; }, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, 0, true);
  parts.push.apply(parts, central);
  parts.push(eocd.buffer);
  return new Blob(parts, {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
/* Excel serial date (epoch 1899-12-30, local time). */

function xlsxDateSerial(ts){
  const d = new Date(ts);
  const day = Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86400000);
  const frac = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
  return day + frac;
}

function xlsxCol(n){
  let s = '';
  n++;
  while(n > 0){ const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function xlsxCellXml(ref, cell, shared){
  if(cell.t === 's'){
    let idx = shared.map[cell.v];
    if(idx === undefined){ idx = shared.list.length; shared.map[cell.v] = idx; shared.list.push(cell.v); }
    shared.count = (shared.count || 0) + 1;
    return '<c r="' + ref + '" t="s"' + (cell.s ? ' s="' + cell.s + '"' : '') + '><v>' + idx + '</v></c>';
  }
  return '<c r="' + ref + '"' + (cell.s ? ' s="' + cell.s + '"' : '') + '><v>' + cell.v + '</v></c>';
}

function xlsxSheetXml(cols, rows, shared){
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:' + xlsxCol(cols.length - 1) + rows.length + '"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>' +
    cols.map(function(c, i){ return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + c.w + '" customWidth="1"/>'; }).join('') +
    '</cols><sheetData>';
  rows.forEach(function(row, ri){
    xml += '<row r="' + (ri + 1) + '">';
    row.forEach(function(cell, ci){
      if(cell == null) return;
      xml += xlsxCellXml(xlsxCol(ci) + (ri + 1), cell, shared);
    });
    xml += '</row>';
  });
  return xml + '</sheetData></worksheet>';
}

const XLSX_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
'<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts>' +
'<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
'<cellXfs count="8">' +
'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
'<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/>' +
'<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
'<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
'<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
'<xf numFmtId="2" fontId="1" fillId="0" borderId="0" xfId="0"/>' +
'<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
'<xf numFmtId="1" fontId="1" fillId="0" borderId="0" xfId="0"/>' +
'</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
/* Build the monthly sales workbook. Returns a Blob, or null if the month is invalid. */

function buildSalesXlsx(monthVal){
  const parts = (monthVal || '').split('-');
  const y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  if(!y || !m || m < 1 || m > 12) return null;
  const orders = DB.orders.filter(function(o){
    if(o.status !== 'Completed') return false;
    const d = new Date(o.createdAt);
    return d.getFullYear() === y && (d.getMonth() + 1) === m;
  }).sort(function(a, b){ return a.createdAt - b.createdAt || (a.orderNumber < b.orderNumber ? -1 : 1); });
  /* Month expenses and cost of goods — same formula as the Dashboard net profit:
     net = total sales (sum of Completed order totals) - cost of goods
           (current product costPrice x qty sold) - total expenses. */
  const monthExpenses = DB.expenses.filter(function(e){
    const d = new Date(e.date);
    return d.getFullYear() === y && (d.getMonth() + 1) === m;
  }).sort(function(a, b){ return a.date - b.date; });
  const expTotal = round2(monthExpenses.reduce(function(s,e){ return s + (e.amount || 0); }, 0));
  const costMonth = round2(orders.reduce(function(s,o){
    return s + (o.items || []).reduce(function(a,it){
      const p = prodById(it.productId); return a + (p ? p.costPrice * it.quantity : 0);
    }, 0);
  }, 0));
  const S = function(v, st){ return {t:'s', v:String(v == null ? '' : v), s:st || 0}; };
  const N = function(v, st){ return {t:'n', v:round2(v || 0), s:st || 0}; };
  const D = function(ts, st){ return {t:'n', v:xlsxDateSerial(ts), s:st}; };
  /* ---- Sales (detail) ---- */
  const salesRows = [[S(t('orders.xDate'), 1), S(t('orders.xOrderNo'), 1), S(t('orders.xProduct'), 1), S(t('orders.xSku'), 1), S(t('orders.xQty'), 1), S(t('orders.xUnitPrice'), 1), S(t('orders.xDiscount'), 1), S(t('orders.xLineTotal'), 1), S(t('orders.xPayment'), 1), S(t('orders.xCashier'), 1), S(t('orders.xCustomer'), 1)]];
  let totalQty = 0, totalLine = 0;
  orders.forEach(function(o){
    const cust = custById(o.customerId);
    (o.items || []).forEach(function(it){
      salesRows.push([D(o.createdAt, 3), S(o.orderNumber), S(it.productName), S(it.sku || ''), N(it.quantity, 6), N(it.unitPrice, 4), N(it.discount || 0, 4), N(it.lineTotal, 4), S(tPay(o.paymentMethod)), S(o.cashier || ''), S(cust ? cust.name : t('common.walkIn'))]);
      totalQty += it.quantity || 0;
      totalLine = round2(totalLine + (it.lineTotal || 0));
    });
  });
  salesRows.push([S(t('orders.xTotal'), 1), null, null, null, N(totalQty, 7), null, null, N(totalLine, 5), null, null, null]);
  /* ---- Summary ---- */
  const byDay = {}, byPay = {};
  let grandOrders = 0, grandTotal = 0;
  orders.forEach(function(o){
    const key = fmtDay(o.createdAt);
    byDay[key] = byDay[key] || {count:0, total:0};
    byDay[key].count++; byDay[key].total = round2(byDay[key].total + o.total);
    byPay[o.paymentMethod] = byPay[o.paymentMethod] || {count:0, total:0};
    byPay[o.paymentMethod].count++; byPay[o.paymentMethod].total = round2(byPay[o.paymentMethod].total + o.total);
    grandOrders++; grandTotal = round2(grandTotal + o.total);
  });
  const sumRows = [[S(t('orders.xDate'), 1), S(t('orders.xOrders'), 1), S(t('orders.xTotal'), 1)]];
  Object.keys(byDay).sort().forEach(function(k){
    sumRows.push([D(new Date(k + 'T00:00:00').getTime(), 2), N(byDay[k].count, 6), N(byDay[k].total, 4)]);
  });
  sumRows.push([null, null, null]);
  sumRows.push([S(t('orders.xByPayment'), 1), S(t('orders.xOrders'), 1), S(t('orders.xTotal'), 1)]);
  PAY_METHODS.forEach(function(pm){
    if(!byPay[pm]) return;
    sumRows.push([S(tPay(pm)), N(byPay[pm].count, 6), N(byPay[pm].total, 4)]);
  });
  sumRows.push([null, null, null]);
  sumRows.push([S(t('orders.xGrandTotal'), 1), N(grandOrders, 7), N(grandTotal, 5)]);
  /* ---- Profit section (same formula as the Dashboard) ---- */
  sumRows.push([null, null, null]);
  sumRows.push([S(t('orders.xSalesTotal'), 1), null, N(grandTotal, 5)]);
  sumRows.push([S(t('orders.xCost'), 1), null, N(costMonth, 5)]);
  sumRows.push([S(t('orders.xExpensesTotal'), 1), null, N(expTotal, 5)]);
  sumRows.push([S(t('orders.xNetProfit'), 1), null, N(round2(grandTotal - costMonth - expTotal), 5)]);
  /* ---- Expenses (detail) ---- */
  const expRows = [[S(t('orders.xDate'), 1), S(t('orders.xName'), 1), S(t('orders.xCategory'), 1), S(t('orders.xAmount'), 1), S(t('orders.xPayment'), 1), S(t('orders.xNote'), 1)]];
  monthExpenses.forEach(function(e){
    expRows.push([D(e.date, 3), S(e.name), S(tExpCat(e.category)), N(e.amount, 4), S(tPay(e.paymentMethod)), S(e.note || '')]);
  });
  expRows.push([S(t('orders.xTotal'), 1), null, null, N(expTotal, 5), null, null]);
  /* ---- Assemble workbook ---- */
  const shared = {list:[], map:{}, count:0};
  const salesXml = xlsxSheetXml([{w:19},{w:13},{w:28},{w:13},{w:7},{w:12},{w:11},{w:13},{w:14},{w:12},{w:16}], salesRows, shared);
  const sumXml = xlsxSheetXml([{w:14},{w:10},{w:16}], sumRows, shared);
  const expXml = xlsxSheetXml([{w:19},{w:26},{w:16},{w:13},{w:14},{w:26}], expRows, shared);
  const sst = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + shared.count + '" uniqueCount="' + shared.list.length + '">' +
    shared.list.map(function(s){ return '<si><t xml:space="preserve">' + esc(s) + '</t></si>'; }).join('') + '</sst>';
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Summary" sheetId="2" r:id="rId2"/><sheet name="Expenses" sheetId="3" r:id="rId3"/></sheets></workbook>';
  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>';
  return xlsxZip([
    {name:'[Content_Types].xml', data:contentTypes},
    {name:'_rels/.rels', data:rels},
    {name:'xl/workbook.xml', data:workbook},
    {name:'xl/_rels/workbook.xml.rels', data:workbookRels},
    {name:'xl/worksheets/sheet1.xml', data:salesXml},
    {name:'xl/worksheets/sheet2.xml', data:sumXml},
    {name:'xl/worksheets/sheet3.xml', data:expXml},
    {name:'xl/styles.xml', data:XLSX_STYLES},
    {name:'xl/sharedStrings.xml', data:sst}
  ]);
}

function curMonthStr(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function exportMonthExcel(){
  if(deny('reports')) return false;
  const monthVal = document.getElementById('exportMonth').value;
  const blob = buildSalesXlsx(monthVal);
  if(!blob) return false;
  downloadBlob('sales-' + monthVal + '.xlsx', blob);
  return true;
}

function renderDashboard(){
  const done = DB.orders.filter(function(o){ return o.status === 'Completed'; });
  const today = done.filter(function(o){ return isToday(o.createdAt); });
  const month = done.filter(function(o){ return isThisMonth(o.createdAt); });
  const expMonth = DB.expenses.filter(function(e){ return isThisMonth(e.date); });
  const expTotal = expMonth.reduce(function(s,e){ return s + e.amount; }, 0);
  const monthSales = month.reduce(function(s,o){ return s + o.total; }, 0);
  const costMonth = month.reduce(function(s,o){
    return s + o.items.reduce(function(a,it){
      const p = prodById(it.productId); return a + (p ? p.costPrice * it.quantity : 0);
    }, 0);
  }, 0);
  document.getElementById('mToday').textContent = money(today.reduce(function(s,o){ return s + o.total; }, 0));
  document.getElementById('mTodayOrders').textContent = t('dashboard.ordersToday', {count: today.length});
  document.getElementById('mMonth').textContent = money(monthSales);
  document.getElementById('mMonthOrders').textContent = t('dashboard.ordersMonth', {count: month.length});
  document.getElementById('mExp').textContent = money(expTotal);
  document.getElementById('mExpCount').textContent = t('dashboard.expenseCount', {count: expMonth.length});
  document.getElementById('mNet').textContent = money(monthSales - costMonth - expTotal);
  // top products this month
  const qty = {};
  month.forEach(function(o){ o.items.forEach(function(it){ qty[it.productId] = (qty[it.productId] || 0) + it.quantity; }); });
  const top = Object.keys(qty).map(function(pid){ return {p: prodById(pid), q: qty[pid]}; })
    .filter(function(x){ return x.p; }).sort(function(a,b){ return b.q - a.q; }).slice(0, 5);
  document.getElementById('topProducts').innerHTML = top.length ? top.map(function(x){
    return '<div><div><strong>' + esc(x.p.name) + '</strong><small>' + esc(x.p.sku) + '</small></div><strong>' + t('dashboard.unitsSold', {count: x.q}) + '</strong></div>';
  }).join('') : '<div class="empty"><p>' + esc(t('dashboard.noSales')) + '</p></div>';
  // low stock
  const low = DB.products.filter(function(p){ return p.active && p.stock <= p.minStock; }).sort(function(a,b){ return a.stock - b.stock; });
  document.getElementById('lowStockNote').textContent = t('dashboard.lowCount', {count: low.length});
  document.getElementById('lowStockList').innerHTML = low.length ? low.slice(0, 6).map(function(p){
    return '<div><div><strong>' + esc(p.name) + '</strong><small>' + esc(p.sku) + '</small></div><span class="badge ' + (p.stock === 0 ? 'bad' : 'warn') + '">' + t('dashboard.left', {count: p.stock}) + '</span></div>';
  }).join('') : '<div class="empty"><p>✓</p></div>';
}

/* ================= POS ================= */

function renderOrders(){
  /* The Excel export is a report: hidden for cashiers (the handler is
     guarded too — hiding alone is never the check). */
  const expBtn = document.getElementById('exportExcelBtn');
  if(expBtn) expBtn.style.display = can('reports') ? '' : 'none';
  const expMonth = document.getElementById('exportMonth');
  if(expMonth) expMonth.style.display = can('reports') ? '' : 'none';
  const q = (document.getElementById('orderSearch').value || '').trim().toLowerCase();
  const f = document.getElementById('orderStatusFilter').value;
  const list = DB.orders.filter(function(o){
    const cust = custById(o.customerId);
    if(f !== 'all' && o.status !== f) return false;
    if(q && (o.orderNumber + ' ' + (cust ? cust.name : '') + ' ' + o.paymentMethod).toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
  document.getElementById('ordersDetail').textContent = t('orders.detail', {count: DB.orders.length});
  document.getElementById('orderList').innerHTML = list.length ? list.map(function(o){
    const cust = custById(o.customerId);
    const badge = o.status === 'Completed' ? 'good' : o.status === 'Refunded' ? 'warn' : o.status === 'Pending' ? 'warn' : 'bad';
    return '<button type="button" class="list-row" data-order="' + o.id + '" style="width:100%;background:transparent;border-left:0;border-right:0;border-top:0;text-align:left;cursor:pointer">' +
      '<div class="grow"><strong>' + esc(o.orderNumber) + '</strong><small>' + fmtDate(o.createdAt) + ' · ' + esc(cust ? cust.name : t('common.walkIn')) + ' · ' + esc(tPay(o.paymentMethod)) + '</small></div>' +
      '<span class="badge ' + badge + '">' + esc(tStatus(o.status)) + '</span>' +
      '<div class="amt">' + money(o.total) + '</div></button>';
  }).join('') : '<div class="empty"><h3>' + esc(t('orders.noOrders')) + '</h3></div>';
  document.querySelectorAll('[data-order]').forEach(function(b){
    b.addEventListener('click', function(){ showReceipt(b.dataset.order, false); });
  });
}

/* ================= customers ================= */

function renderExpenses(){
  const month = DB.expenses.filter(function(e){ return isThisMonth(e.date); });
  const total = month.reduce(function(s,e){ return s + e.amount; }, 0);
  document.getElementById('expensesDetail').textContent = t('expenses.detail', {amount: money(total)});
  const list = DB.expenses.slice().sort(function(a,b){ return b.date - a.date; });
  document.getElementById('expenseList').innerHTML = list.map(function(e){
    return '<div class="list-row"><div class="avatar" style="border-radius:8px;background:#fdf0d3;color:var(--warn)">💸</div>' +
      '<div class="grow"><strong>' + esc(e.name) + '</strong><small>' + esc(tExpCat(e.category)) + ' · ' + fmtDay(e.date) + (e.note ? ' · ' + esc(e.note) : '') + '</small></div>' +
      '<div class="amt">' + money(e.amount) + '</div>' +
      (can('expenses_manage') ? '<button class="btn icon-btn" type="button" data-del-expense="' + e.id + '" aria-label="Delete">✕</button>' : '') + '</div>';
  }).join('');
  document.querySelectorAll('[data-del-expense]').forEach(function(b){
    b.addEventListener('click', function(){
      if(deny('expenses_manage')) return;
      if(!confirm(t('common.confirmDelete'))) return;
      DB.expenses = DB.expenses.filter(function(x){ return x.id !== b.dataset.delExpense; });
      sbDelete('expenses', b.dataset.delExpense);
      save(); renderExpenses(); toast(t('expenses.deleted'));
    });
  });
}

function openExpenseForm(){
  const catOpts = EXP_CATS.map(function(c){ return '<option value="' + esc(c) + '">' + esc(tExpCat(c)) + '</option>'; }).join('');
  const payOpts = PAY_METHODS.map(function(m){ return '<option value="' + esc(m) + '">' + esc(tPay(m)) + '</option>'; }).join('');
  const today = fmtDay(Date.now());
  openModal(
    '<header><h2>' + esc(t('expenses.add')) + '</h2><button class="btn icon-btn" type="button" data-close>✕</button></header>' +
    fieldHtml(t('expenses.name'), '<input type="text" id="efName">') +
    '<div class="form-grid">' +
    fieldHtml(t('common.category'), '<select id="efCat">' + catOpts + '</select>') +
    fieldHtml(t('common.amount'), '<input type="number" id="efAmount" min="0" step="any">') +
    fieldHtml(t('common.date'), '<input type="date" id="efDate" value="' + today + '">') +
    fieldHtml(t('checkout.paymentMethod'), '<select id="efPay">' + payOpts + '</select>') +
    '</div>' +
    fieldHtml(t('common.note'), '<input type="text" id="efNote">') +
    '<div class="form-actions"><button class="btn" type="button" data-close>' + esc(t('common.cancel')) + '</button>' +
    '<button class="btn primary" type="button" id="efSave">' + esc(t('expenses.save')) + '</button></div>'
  );
  document.getElementById('efSave').addEventListener('click', function(){
    const name = document.getElementById('efName').value.trim();
    const amount = parseFloat(document.getElementById('efAmount').value);
    if(!name || !(amount > 0)){ toast(t('common.required')); return; }
    const dv = document.getElementById('efDate').value;
    DB.expenses.push({
      id: uid('e'), name: name, category: document.getElementById('efCat').value,
      amount: round2(amount), paymentMethod: document.getElementById('efPay').value,
      note: document.getElementById('efNote').value.trim(),
      date: dv ? new Date(dv + 'T12:00:00').getTime() : Date.now()
    });
    save(); closeModal(); renderExpenses(); toast(t('expenses.recorded'));
  });
}

/* ================= settings & staff ================= */
