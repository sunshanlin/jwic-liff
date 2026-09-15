// Copyright (c) 2026 JWIC. All rights reserved.
// Licensed to the named customer for internal use only. Redistribution or resale prohibited.

/**
 * The LINE Channel's Quote Request page (docs/adr/0005-liff-to-quote.md, GitHub #52).
 *
 * One page for every customer. The LIFF app's endpoint URL carries the only configuration:
 *   https://<pages host>/?liffId=<LIFF ID>&api=<URL-encoded Apps Script /exec URL>[&img=<URL-encoded picture base>]
 * img is optional and names where item pictures live - a Cloudflare Worker's /img/ (ADR 0007), whichever
 * endpoint api points at. Without it the list simply has no pictures.
 *
 * Two screens: the Catalogue with its docket, then the buyer. That is the order the Form's own flow
 * already taught (catalogue, ยืนยัน, form), and on a phone it gives the list the whole screen.
 *
 * validate() and buildSubmitBody() touch no DOM. check-queue.cjs requires this file and feeds what
 * buildSubmitBody() makes straight into the library, so page and endpoint are tested as one
 * contract. validate() is only instant feedback - the endpoint checks every rule again and decides.
 */
(function () {
  'use strict';

  var TAX_ID = /^\d{13}$/;
  var FIVE_DIGITS = /^\d{5}$/;
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function digits(v) { return String(v || '').replace(/[\s-]/g, ''); }
  function text(v) { return String(v || '').trim(); }

  /** Field name -> message for everything wrong with the request; {} when it may be sent. */
  function validate(state, lineLimit, provinces) {
    var e = {};
    if (state.basket.length === 0) {
      e.basket = 'เลือกสินค้าอย่างน้อย 1 รายการ';
    } else if (state.basket.length > lineLimit) {
      e.basket = 'เลือกได้ไม่เกิน ' + lineLimit + ' รายการ';
    } else if (state.basket.some(function (l) { return !(Number(l.qty) > 0); })) {
      e.basket = 'จำนวนต้องมากกว่า 0';
    }
    if (!state.useBinding) {
      var id = state.identity;
      if (id === 'returning') {
        if (!TAX_ID.test(digits(state.taxId))) e.taxId = 'กรอกตัวเลข 13 หลัก';
        if (digits(state.branchNo) && !FIVE_DIGITS.test(digits(state.branchNo))) e.branchNo = 'กรอกตัวเลข 5 หลัก หรือเว้นว่าง';
      } else if (id === 'company' || id === 'person') {
        var company = id === 'company';
        if (company && !text(state.companyName)) e.companyName = 'กรุณากรอกชื่อกิจการ';
        if (!company && !text(state.personName)) e.personName = 'กรุณากรอกชื่อ-นามสกุล';
        if ((company || digits(state.taxId)) && !TAX_ID.test(digits(state.taxId))) e.taxId = 'กรอกตัวเลข 13 หลัก';
        if (company && state.branchType === 'Branch' && !FIVE_DIGITS.test(digits(state.branchNo))) e.branchNo = 'กรอกตัวเลข 5 หลัก';
        if (!text(state.address1)) e.address1 = 'กรุณากรอกที่อยู่';
        if (provinces.indexOf(state.city) === -1) e.city = 'กรุณาเลือกจังหวัด';
        if (!FIVE_DIGITS.test(digits(state.postCode))) e.postCode = 'กรอกตัวเลข 5 หลัก';
      } else {
        e.identity = 'กรุณาเลือกข้อใดข้อหนึ่ง';
      }
    }
    if (text(state.email) && !EMAIL.test(text(state.email))) e.email = 'รูปแบบอีเมลไม่ถูกต้อง';
    return e;
  }

  /** The op=liffSubmit body. The only place page state becomes the wire contract. */
  function buildSubmitBody(state, idToken) {
    var id = state.useBinding ? '' : state.identity;
    return {
      idToken: idToken,
      submissionId: state.submissionId,
      useBinding: !!state.useBinding,
      basket: state.basket.map(function (l) { return { no: l.no, qty: Number(l.qty) }; }),
      returning: id === 'returning',
      submitterType: id === 'company' ? 'Company' : (id === 'person' ? 'Person' : ''),
      companyName: text(state.companyName),
      branchType: id === 'company' ? (state.branchType || 'HeadOffice') : '',
      personName: text(state.personName),
      taxId: digits(state.taxId),
      branchNo: digits(state.branchNo),
      address1: text(state.address1),
      subDistrict: text(state.subDistrict),
      district: text(state.district),
      city: text(state.city),
      postCode: digits(state.postCode),
      contactName: text(state.contactName),
      phone: text(state.phone),
      email: text(state.email),
      deliveryDate: text(state.deliveryDate),
      note: text(state.note)
    };
  }

  /**
   * An item's picture: the img base, then the item code as ONE path segment - a code may contain a slash.
   * large asks for the popup's picture rather than the list row's.
   */
  function imageUrl(base, no, large) {
    return base + encodeURIComponent(no) + (large ? '?size=large' : '');
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { validate: validate, buildSubmitBody: buildSubmitBody, imageUrl: imageUrl };
    return;
  }

  // ---------------------------------------------------------------------------------------------
  // The page
  // ---------------------------------------------------------------------------------------------

  var params = new URLSearchParams(location.search);
  var LIFF_ID = params.get('liffId') || '';
  var API = params.get('api') || '';
  var IMG = params.get('img') || '';
  var SAVED = 'jwic-quote-request:' + LIFF_ID;
  var RELOGIN = 'jwic-quote-relogin:' + LIFF_ID;
  // v1: bump when the liffInit answer changes shape, so a new page never draws an old page's leftovers.
  var CATALOGUE = 'jwic-quote-catalogue-v1:' + LIFF_ID;
  // Where an item with no category is filed - the same word the Form's catalogue uses.
  var OTHER = 'อื่นๆ';
  var data = null;
  var byNo = {};
  var state = {
    submissionId: newId(), basket: [], identity: '', useBinding: false,
    companyName: '', branchType: 'HeadOffice', personName: '', taxId: '', branchNo: '',
    address1: '', subDistrict: '', district: '', city: '', postCode: '',
    contactName: '', phone: '', email: '', deliveryDate: '', note: ''
  };
  // Rows sit under their category heading unless a search is on; only a search result, which has no
  // heading, repeats the category on the row.
  var grouped = true;
  var shopScroll = 0;
  var sent = false;
  // The endpoint has answered (settle). Until then the shop may be a remembered Catalogue, with no ID token behind it.
  var live = false;
  // The category a chip narrowed the list to; blank is ทั้งหมด.
  var picked = '';
  var typing = 0;
  var toastTimer = 0;

  var SVG = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" ' +
    'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  // A bin rather than a minus for delete: minus reads as "one fewer", which is the stepper's job.
  // add's cart glyph is Feather's shopping-cart path scaled to this grid (bbox lines up with del's);
  // the two wheels are round-capped zero-length strokes, not <circle> - ctrl() only emits one <path>.
  var GLYPH = {
    inc: 'M9 4v10M4 9h10', dec: 'M4 9h10', del: 'M3.5 5.5h11M7.5 5.5V3.5h3v2M5.8 5.5l.7 8.5h5l.7-8.5',
    add: 'M3.5 3.75h2l1.34 6.7a1 1 0 0 0 1 .81h4.86a1 1 0 0 0 1-.81L14.5 6.25H6M7.5 13.75h.01M13 13.75h.01'
  };
  var LABEL = { inc: 'เพิ่มจำนวน ', dec: 'ลดจำนวน ', del: 'ลบออกจากตะกร้า ', add: 'เพิ่มลงตะกร้า ' };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-');
  }

  function call(op, body) {
    return fetch(API + (API.indexOf('?') === -1 ? '?' : '&') + 'op=' + op, {
      method: 'POST',
      // text/plain keeps this a CORS simple request - Apps Script cannot answer a preflight.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  function errorText(res) {
    if (res.code === 'auth') return 'การเข้าสู่ระบบ LINE หมดอายุ กรุณาเปิดหน้าใหม่';
    if (res.code === 'setup') return 'ระบบยังตั้งค่าไม่เสร็จ กรุณาติดต่อร้านค้า';
    return res.error || 'ส่งไม่สำเร็จ กรุณาลองอีกครั้ง';
  }

  function fail(message) {
    // A remembered Catalogue may already be up (start) when the endpoint refuses.
    show('');
    $('loading').hidden = true;
    $('fatalText').textContent = message;
    $('fatal').hidden = false;
  }

  /** Staged, not simulated: each call marks a real point in start()/render(), not a timer guessing. */
  function progress(pct) {
    var el = $('bar');
    if (!el) return;
    el.style.width = pct + '%';
    el.setAttribute('aria-valuenow', pct);
    $('barPct').textContent = pct + '%';
  }

  function toast(message, long) {
    var el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, long ? 5000 : 2500);
  }

  function start() {
    if (!LIFF_ID || !API) return fail('ลิงก์นี้ตั้งค่าไม่ครบ กรุณาติดต่อร้านค้า');
    preconnect();
    // The Catalogue this phone was last shown goes up at once, while LINE and the endpoint are still
    // answering, and what they answer takes over (settle). Only a first visit waits on the bar.
    var early = recall();
    if (early) {
      data = early;
      render();
      enter();
    } else {
      progress(10);
    }
    liff.init({ liffId: LIFF_ID })
      .then(function () {
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: location.href });
          return null;
        }
        if (!early) progress(45);
        return call('liffInit', { idToken: liff.getIDToken() }).then(function (res) {
          if (res.code === 'auth' && onExpired()) return;
          if (res.error) return fail(errorText(res));
          keep(res);
          if (early) {
            if (settle(res)) resume();
            return;
          }
          progress(85);
          data = res;
          render();
          var resumed = settle(res);
          progress(100);
          // A beat so 100% actually paints before the switch - matches the bar's own CSS transition
          // (index.html). The only artificial delay on the screen, and only a first visit pays it.
          setTimeout(function () {
            enter();
            if (resumed) resume();
          }, 150);
        });
      })
      .catch(function (err) { fail('เปิดหน้าไม่สำเร็จ กรุณาลองใหม่ (' + ((err && err.message) || err) + ')'); });
  }

  /** Opens the connection to the endpoint while liff.init() runs, so the handshake is done by the time the ID token is. */
  function preconnect() {
    var origins;
    try {
      origins = [new URL(API, location.href).origin];
    } catch (err) {
      return;
    }
    // Apps Script answers every call with a redirect to a second host.
    if (origins[0] === 'https://script.google.com') origins.push('https://script.googleusercontent.com');
    origins.forEach(function (origin) {
      if (origin === location.origin) return;
      var link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = origin;
      // fetch() sends no credentials cross-origin, and only a crossorigin preconnect is a connection it reuses.
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    });
  }

  /** The Catalogue this phone was last shown, or null. The caller's LINE Binding is never kept on the phone. */
  function recall() {
    try {
      var kept = JSON.parse(localStorage.getItem(CATALOGUE) || 'null');
      return kept && Array.isArray(kept.items) && Array.isArray(kept.provinces) ? kept : null;
    } catch (err) {
      return null;
    }
  }

  function keep(res) {
    try {
      localStorage.setItem(CATALOGUE, JSON.stringify({
        items: res.items, provinces: res.provinces, lineLimit: res.lineLimit, notice: res.notice
      }));
    } catch (err) {
      // Storage blocked or full: the next visit waits on the endpoint, like a first one.
    }
  }

  /**
   * The endpoint refused the ID token. LINE's ID token lives one hour, and outside the LINE app the
   * SDK keeps handing back the one it stored at login long after that - there is no refresh call - so
   * the way out is a fresh login. The request being built is saved first and put back by restore():
   * after the redirect here, or when the customer reopens the page inside the LINE app, where a new
   * launch is the only way to a new token. Returns true when the page is redirecting away.
   */
  function onExpired() {
    try {
      if (state.basket.length) localStorage.setItem(SAVED, JSON.stringify({ at: Date.now(), state: state }));
      if (liff.isInClient()) return false;
      // Once a minute at most: a refusal straight after a fresh login is not an expiry, and looping
      // through LINE's login page would hide whatever it really is.
      if (Date.now() - Number(sessionStorage.getItem(RELOGIN) || 0) < 60000) return false;
      sessionStorage.setItem(RELOGIN, String(Date.now()));
    } catch (err) {
      // Storage blocked (private mode): no guard against a loop, so no automatic login either.
      return false;
    }
    liff.logout();
    liff.login({ redirectUri: location.href });
    return true;
  }

  /** A request onExpired() saved within the hour, put back where the customer left it. */
  function restore() {
    var saved;
    try {
      saved = JSON.parse(localStorage.getItem(SAVED) || 'null');
      localStorage.removeItem(SAVED);
    } catch (err) {
      return false;
    }
    if (!saved || !(Date.now() - saved.at < 3600000)) return false;
    Object.keys(state).forEach(function (k) {
      if (k in saved.state) state[k] = saved.state[k];
    });
    // An item taken off the Catalogue in the meantime is not put back.
    state.basket = state.basket.filter(function (l) { return byNo[l.no]; });
    state.useBinding = !!(state.useBinding && data.binding);
    Array.prototype.forEach.call($('form').elements, function (el) {
      if (!el.name || !(el.name in state)) return;
      if (el.type === 'radio') el.checked = el.value === state[el.name];
      else el.value = state[el.name];
    });
    return state.basket.length > 0;
  }

  /** Draws the shop from data and wires it up. Once per page, whichever answer data came from. */
  function render() {
    data.provinces.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p;
      o.textContent = p;
      $('city').append(o);
    });
    bindShop();
    bindForm();
    drawCatalogue();
    syncBuyer();
  }

  /** Everything the shop draws from data.items - again when the endpoint's Catalogue is not the one remembered. */
  function drawCatalogue() {
    byNo = {};
    data.items.forEach(function (it) { byNo[it.no] = it; });
    // An item taken off the Catalogue since it went in the basket does not stay there.
    state.basket = state.basket.filter(function (l) { return byNo[l.no]; });
    $('notice').textContent = data.notice;
    $('list').classList.toggle('thumbs', !!IMG);
    // The text column and the wider shop only when some item has Marketing Text to put in them.
    var descs = data.items.some(function (it) { return !!it.marketingText; });
    $('list').classList.toggle('descs', descs);
    $('shop').classList.toggle('descs', descs);
    renderList();
    drawDocket();
  }

  /**
   * The endpoint's answer: a newer Catalogue if it differs, the caller's LINE Binding, and a request
   * saved before a login. Returns true when that request was put back.
   */
  function settle(res) {
    // ponytail: a changed Catalogue (the hourly stock refresh flips In stock) rebuilds every row a
    // second or two after the remembered one went up, taking the focus out of a quantity being typed.
    // Patch the rows in place if that shows up in practice.
    var changed = JSON.stringify(res.items) !== JSON.stringify(data.items);
    data = res;
    live = true;
    if (changed) drawCatalogue();
    // Not once the buyer screen is open: the questions being answered do not vanish from under the customer.
    if (res.binding && $('form').hidden) {
      state.useBinding = true;
      var b = res.binding;
      $('boundName').textContent = (b.buyerName || 'เลขประจำตัวผู้เสียภาษี ' + b.taxIdMasked) +
        (b.branchNo ? ' สาขา ' + b.branchNo : '');
    }
    var resumed = restore();
    if (resumed) {
      renderList();
      drawDocket();
    }
    syncBuyer();
    return resumed;
  }

  /** Swaps the loading card for the shop. */
  function enter() {
    $('loading').hidden = true;
    $('shop').hidden = false;
  }

  function resume() {
    next();
    toast('ข้อมูลที่กรอกไว้ยังอยู่ กด “ส่งคำขอราคา” อีกครั้ง', true);
  }

  function show(screen) {
    $('shop').hidden = screen !== 'shop';
    $('form').hidden = screen !== 'buyer';
    $('done').hidden = screen !== 'done';
    clearTimeout(toastTimer);
    $('toast').hidden = true;
    window.scrollTo(0, 0);
  }

  // --- Screen 1: the Catalogue -----------------------------------------------------------------

  function catOf(it) { return it.categoryName || it.category || OTHER; }

  /** Categories alphabetically by the Thai alphabet, anything uncategorised last. */
  function groups(rows) {
    var by = {}, order = [];
    rows.forEach(function (it) {
      var c = catOf(it);
      if (!by[c]) { by[c] = []; order.push(c); }
      by[c].push(it);
    });
    order.sort(function (a, b) {
      if (a === OTHER) return 1;
      if (b === OTHER) return -1;
      return a.localeCompare(b, 'th');
    });
    return order.map(function (c) { return { cat: c, items: by[c] }; });
  }

  function lineOf(code) {
    for (var i = 0; i < state.basket.length; i++) {
      if (state.basket[i].no === code) return state.basket[i];
    }
    return null;
  }

  /**
   * One control. Minus, quantity, plus reads less-to-more; delete is its own button rather than
   * "minus at 1", so a tap meant as "one fewer" never throws the line away. At 1 the minus is
   * disabled rather than hidden, so nothing shifts sideways mid-tap.
   */
  function ctrl(kind, code, disabled) {
    var label = esc(LABEL[kind] + code);
    return '<button type="button" class="icon' + (kind === 'del' ? ' del on' : '') + '" data-act="' + kind + '"' +
      (disabled ? ' disabled' : '') + ' aria-label="' + label + '" title="' + label + '">' +
      SVG + '<path d="' + GLYPH[kind] + '"/></svg></button>';
  }

  /** The action cell: a lone cart until the line is in the basket (at 1), then the full set with its quantity box. */
  function controls(code, qty) {
    if (qty === null) return ctrl('add', code, false);
    var box = '<input class="qty" type="number" min="1" step="any" inputmode="decimal" placeholder="จำนวน" ' +
      'aria-label="จำนวน ' + esc(code) + '" value="' + esc(String(qty)) + '">';
    return ctrl('dec', code, qty <= 1) + box + ctrl('inc', code, false) + ctrl('del', code, false);
  }

  function row(it) {
    var line = lineOf(it.no);
    var cls = [line ? 'picked' : '', it.inStock ? '' : 'dim'].filter(Boolean).join(' ');
    var meta = (grouped ? [it.uom] : [catOf(it), it.uom]).filter(Boolean).join(' · ');
    return '<li data-row="' + esc(it.no) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' +
      // lazy: a phone fetches only the pictures scrolled near, however long the Catalogue.
      (IMG ? '<span class="thumb"><img loading="lazy" alt="" src="' + esc(imageUrl(IMG, it.no)) + '"></span>' : '') +
      '<span class="code">' + esc(it.no) + '</span>' +
      '<span class="name">' + esc(it.name) + '</span>' +
      '<span class="meta">' + esc(meta) + '</span>' +
      // Two lines of it here; a tap opens the whole text with the picture.
      (it.marketingText ? '<span class="desc">' + esc(it.marketingText) + '</span>' : '') +
      (it.inStock ? '<span class="stamp">In stock</span>' : '') +
      '<span class="act">' + controls(it.no, line ? line.qty : null) + '</span></li>';
  }

  function renderList() {
    var term = $('search').value.trim().toLowerCase();
    var shown = !term ? data.items : data.items.filter(function (it) {
      // Both spellings of a category are searchable: the name the customer reads, and the code
      // sales reads off the quote while on the phone with them.
      return [it.no, it.name, it.category, it.categoryName].join(' ').toLowerCase().indexOf(term) > -1;
    });
    // A chip narrows the list to its category; a search looks through the whole Catalogue, so typing lets go of it.
    var all = groups(shown);
    if (term || !all.some(function (g) { return g.cat === picked; })) picked = '';
    var gs = picked ? all.filter(function (g) { return g.cat === picked; }) : all;
    var count = gs.reduce(function (n, g) { return n + g.items.length; }, 0);
    $('tally').textContent = (term || picked ? count + ' / ' : '') + data.items.length + ' รายการ';
    $('empty').hidden = count > 0;
    grouped = !term;
    $('list').innerHTML = gs.map(function (g) {
      return '<section class="group"><h2 class="cat">' + esc(g.cat) +
        '<span>' + g.items.length + ' รายการ</span></h2>' +
        '<ul class="items">' + g.items.map(row).join('') + '</ul></section>';
    }).join('');
    // The chips are a map of the whole Catalogue, so they only show while nothing is typed. The picked one is dark.
    var chips = $('chips');
    chips.hidden = !!term;
    chips.innerHTML = term ? '' : chip('', 'ทั้งหมด') + all.map(function (g) { return chip(g.cat, g.cat); }).join('');
  }

  function chip(cat, label) {
    return '<button type="button" data-cat="' + esc(cat) + '"' + (cat === picked ? ' class="now"' : '') + '>' +
      esc(label) + '</button>';
  }

  /** Scrolls a chip swiped past back into the bar. */
  function reveal(c) {
    var chips = $('chips');
    if (c && (c.offsetLeft < chips.scrollLeft || c.offsetLeft + c.offsetWidth > chips.scrollLeft + chips.clientWidth)) {
      chips.scrollTo({ left: Math.max(0, c.offsetLeft - 16), behavior: 'smooth' });
    }
  }

  function rowOf(code) {
    var rows = $('list').querySelectorAll('li');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset.row === code) return rows[i];
    }
    return null;
  }

  // Repaints ONE row. Rebuilding the list would take the focus out of a quantity being typed in another row.
  function paint(code) {
    var li = rowOf(code);
    if (!li) return;
    var line = lineOf(code);
    li.querySelector('.act').innerHTML = controls(code, line ? line.qty : null);
    li.classList.toggle('picked', !!line);
  }

  function addLine(code) {
    if (state.basket.length >= data.lineLimit) return toast('เลือกได้สูงสุด ' + data.lineLimit + ' รายการ');
    var it = byNo[code];
    state.basket.push({ no: it.no, name: it.name, uom: it.uom, qty: 1 });
    paint(code);
    drawDocket();
  }

  function stepLine(code, delta) {
    var line = lineOf(code);
    if (!line || line.qty + delta < 1) return;
    line.qty += delta;
    paint(code);
    drawDocket();
  }

  function removeLine(code) {
    state.basket = state.basket.filter(function (l) { return l.no !== code; });
    paint(code);
    drawDocket();
  }

  function drawDocket() {
    var n = state.basket.length;
    $('docket').hidden = n === 0;
    $('count').textContent = n + ' / ' + data.lineLimit + ' รายการ';
    $('count').classList.toggle('full', n >= data.lineLimit);
    $('lines').innerHTML = state.basket.map(function (l) {
      return '<button type="button" data-drop="' + esc(l.no) + '" title="ลบออกจากตะกร้า">' + esc(l.no) +
        '</button> &times;' + esc(String(l.qty));
    }).join('&nbsp; &middot; &nbsp;');
  }

  // A row's picture as large as the screen allows, with its whole Marketing Text. The row's small picture is already
  // loaded, so it shows at once; the large one takes its place when it arrives, if that item's popup is still the one
  // open. An item with no large picture keeps the small one, and one with no picture at all opens on its text alone.
  // No history entry: the buyer screen owns popstate, and a tap anywhere is the way out.
  function zoom(li) {
    var code = li.dataset.row;
    var it = byNo[code] || {};
    var thumb = li.querySelector('.thumb img:not([hidden])');
    var shown = $('zoomImg');
    var text = it.marketingText || '';
    shown.hidden = !thumb;
    shown.dataset.code = code;
    if (thumb) {
      var large = imageUrl(IMG, code, true);
      var loader = new Image();
      shown.src = thumb.src;
      loader.onload = function () {
        if (!$('zoom').hidden && shown.dataset.code === code) shown.src = large;
      };
      loader.src = large;
    }
    $('zoomName').textContent = it.name || code;
    $('zoomDesc').textContent = text;
    $('zoomDesc').hidden = !text;
    $('zoom').classList.toggle('has-desc', !!text);
    $('zoom').hidden = false;
    document.body.classList.add('zooming');
  }

  function unzoom() {
    var shown = $('zoomImg');
    $('zoom').hidden = true;
    shown.removeAttribute('src');
    delete shown.dataset.code;
    document.body.classList.remove('zooming');
  }

  function bindShop() {
    // An item with no picture answers 404: the image goes, its box stays, so every row keeps one alignment.
    // Captured, because error does not bubble.
    $('list').addEventListener('error', function (e) {
      if (e.target.tagName === 'IMG') e.target.hidden = true;
    }, true);
    $('zoom').addEventListener('click', function (e) {
      // The text is there to be read and copied: a click inside it, or the end of a drag that selected some of it, keeps
      // the popup open. A click on the picture or the backdrop closes it.
      if (e.target.closest('.zoom-text') || String(window.getSelection())) return;
      unzoom();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('zoom').hidden) unzoom();
    });
    // A chip narrows the list to its category and turns dark; ทั้งหมด brings the whole Catalogue back.
    $('chips').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      picked = b.getAttribute('data-cat');
      renderList();
      reveal($('chips').querySelector('.now'));
      // The shorter list starts again from its first row, just under the sticky chips - if it was scrolled past that.
      var top = $('list').getBoundingClientRect().top + window.scrollY - $('chips').offsetHeight;
      if (window.scrollY > top) window.scrollTo({ top: top, behavior: 'smooth' });
    });
    // closest, not e.target: the buttons' whole label is an SVG, so a tap lands on the path inside.
    $('list').addEventListener('click', function (e) {
      if (e.target.closest('.thumb img, .desc')) return zoom(e.target.closest('li'));
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      var li = b.closest('li');
      var code = li.dataset.row;
      var act = b.getAttribute('data-act');
      if (act === 'del') return removeLine(code);
      if (act === 'dec') return stepLine(code, -1);
      // The cart puts a line in the basket at 1; + is its increment once it is there.
      if (lineOf(code)) return stepLine(code, 1);
      addLine(code);
    });
    // A quantity typed into a row already in the basket counts as you type. Not repainted: that
    // would pull the focus out of the box being typed in.
    $('list').addEventListener('input', function (e) {
      if (!e.target.classList.contains('qty')) return;
      var li = e.target.closest('li');
      var line = lineOf(li.dataset.row);
      var qty = parseFloat(e.target.value);
      if (!line || !(qty > 0)) return;
      line.qty = qty;
      var dec = li.querySelector('[data-act="dec"]');
      if (dec) dec.disabled = qty <= 1;
      drawDocket();
    });
    $('lines').addEventListener('click', function (e) {
      var b = e.target.closest('[data-drop]');
      if (b) removeLine(b.getAttribute('data-drop'));
    });
    $('wipe').addEventListener('click', function () {
      var codes = state.basket.map(function (l) { return l.no; });
      state.basket = [];
      codes.forEach(paint);
      drawDocket();
    });
    $('next').addEventListener('click', next);
    $('clear').addEventListener('click', function () {
      $('search').value = '';
      renderList();
      $('search').focus();
    });
    // Debounced like the Form's catalogue: every keystroke rebuilds every row, and a Thai IME fires
    // input far more often than a Latin one.
    $('search').addEventListener('input', function () {
      clearTimeout(typing);
      typing = setTimeout(renderList, 120);
    });
    // The phone's back button on the buyer screen returns to the basket instead of closing LINE's
    // window with the basket in it. Once sent there is nothing to go back to.
    window.addEventListener('popstate', function () {
      if (sent || $('form').hidden) return;
      show('shop');
      window.scrollTo(0, shopScroll);
    });
  }

  function next() {
    if (!state.basket.length) return;
    shopScroll = window.scrollY;
    renderSummary();
    show('buyer');
    history.pushState({ screen: 'buyer' }, '');
  }

  // --- Screen 2: the buyer -----------------------------------------------------------------------

  /** The basket read back, so a wrong quantity is caught here rather than on the quote. */
  function renderSummary() {
    $('sumCount').textContent = state.basket.length + ' รายการ';
    $('summary').innerHTML = state.basket.map(function (l) {
      return '<li><span class="s-code">' + esc(l.no) + '</span><span class="s-name">' + esc(l.name) + '</span>' +
        '<span class="s-qty">× ' + esc(String(l.qty) + (l.uom ? ' ' + l.uom : '')) + '</span></li>';
    }).join('');
  }

  function bindForm() {
    var form = $('form');
    var onField = function (e) {
      var el = e.target;
      if (!el.name || !(el.name in state) || (el.type === 'radio' && !el.checked)) return;
      state[el.name] = el.value;
      // An error answered is an error gone - left up, it reads as if the fix did not take.
      var err = document.querySelector('[data-err="' + el.name + '"]');
      if (err) err.textContent = '';
      if (el.name === 'identity' || el.name === 'branchType') syncBuyer();
    };
    form.addEventListener('input', onField);
    form.addEventListener('change', onField);
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    $('rebind').addEventListener('click', function () {
      state.useBinding = false;
      syncBuyer();
    });
    $('back').addEventListener('click', function () { history.back(); });
    $('send').addEventListener('click', send);
    $('close').addEventListener('click', function () {
      if (liff.isInClient()) liff.closeWindow(); else window.close();
    });
  }

  /** Shows the identity questions that apply - none at all while a LINE Binding is in use. */
  function syncBuyer() {
    var bound = state.useBinding && !!data.binding;
    var id = state.identity;
    $('bound').hidden = !bound;
    $('identityChoice').hidden = bound;
    Array.prototype.forEach.call(document.querySelectorAll('[data-for]'), function (el) {
      var show = el.dataset.for === 'branch'
        ? id === 'returning' || (id === 'company' && state.branchType === 'Branch')
        : el.dataset.for.split(' ').indexOf(id) !== -1;
      el.hidden = bound || !show;
    });
    $('taxLabel').textContent = id === 'person'
      ? 'เลขประจำตัวประชาชน 13 หลัก (ไม่บังคับ)'
      : 'เลขประจำตัวผู้เสียภาษี 13 หลัก';
    $('branchHint').textContent = id === 'returning' ? '(เว้นว่างถ้าเป็นสำนักงานใหญ่)' : '';
  }

  function showErrors(errors) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-err]'), function (el) {
      el.textContent = errors[el.dataset.err] || '';
    });
  }

  function send() {
    // A remembered Catalogue lets a customer get this far before LINE has handed over an ID token.
    if (!live) return toast('กำลังเชื่อมต่อ LINE กรุณารอสักครู่');
    var errors = validate(state, data.lineLimit, data.provinces);
    showErrors(errors);
    var first = Object.keys(errors)[0];
    if (first) {
      var at = document.querySelector('[data-err="' + first + '"]');
      if (at) at.parentNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return toast('กรุณาตรวจสอบข้อความสีแดง');
    }
    var button = $('send');
    button.disabled = true;
    button.textContent = 'กำลังส่ง…';
    call('liffSubmit', buildSubmitBody(state, liff.getIDToken()))
      .then(function (res) {
        if (res.ok) return done(res.reference);
        if (res.code === 'auth' && onExpired()) return;
        if (res.code === 'rebind') {
          state.useBinding = false;
          data.binding = null;
          syncBuyer();
        }
        toast(errorText(res), true);
      })
      .catch(function () { toast('ส่งไม่สำเร็จ กรุณาลองอีกครั้ง', true); })
      .then(function () {
        button.disabled = false;
        button.textContent = 'ส่งคำขอราคา';
      });
  }

  function done(reference) {
    sent = true;
    $('reference').textContent = reference;
    show('done');
    // In the customer's own name, into the chat the page was opened from - no OA message, no quota,
    // and it gives sales a thread to answer in. Anywhere LINE will not post (a link opened in a
    // browser) the confirmation on screen has already said everything.
    var context = liff.isInClient() ? liff.getContext() : null;
    if (context && ['utou', 'room', 'group', 'square_chat'].indexOf(context.type) !== -1) {
      liff.sendMessages([{ type: 'text', text: chatText(reference) }]).catch(function () {});
    }
  }

  function chatText(reference) {
    return 'ส่งคำขอราคาแล้ว (อ้างอิง ' + reference + ')\n' + state.basket.map(function (l) {
      return '• ' + l.name + ' × ' + l.qty;
    }).join('\n');
  }

  document.addEventListener('DOMContentLoaded', start);
})();
