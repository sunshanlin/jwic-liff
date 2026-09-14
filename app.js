// Copyright (c) 2026 JWIC. All rights reserved.
// Licensed to the named customer for internal use only. Redistribution or resale prohibited.

/**
 * The LINE Channel's Quote Request page (docs/adr/0005-liff-to-quote.md, GitHub #52).
 *
 * One page for every customer. The LIFF app's endpoint URL carries the only configuration:
 *   https://<pages host>/?liffId=<LIFF ID>&api=<URL-encoded Apps Script /exec URL>
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

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { validate: validate, buildSubmitBody: buildSubmitBody };
    return;
  }

  // ---------------------------------------------------------------------------------------------
  // The page
  // ---------------------------------------------------------------------------------------------

  var params = new URLSearchParams(location.search);
  var LIFF_ID = params.get('liffId') || '';
  var API = params.get('api') || '';
  var data = null;
  var state = {
    submissionId: newId(), basket: [], identity: '', useBinding: false,
    companyName: '', branchType: 'HeadOffice', personName: '', taxId: '', branchNo: '',
    address1: '', subDistrict: '', district: '', city: '', postCode: '',
    contactName: '', phone: '', email: '', deliveryDate: '', note: ''
  };

  function $(id) { return document.getElementById(id); }

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
    $('loading').hidden = true;
    $('fatal').textContent = message;
    $('fatal').hidden = false;
  }

  var toastTimer = 0;
  function toast(message, long) {
    var el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, long ? 5000 : 2500);
  }

  function start() {
    if (!LIFF_ID || !API) return fail('ลิงก์นี้ตั้งค่าไม่ครบ กรุณาติดต่อร้านค้า');
    liff.init({ liffId: LIFF_ID })
      .then(function () {
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: location.href });
          return null;
        }
        return call('liffInit', { idToken: liff.getIDToken() }).then(function (res) {
          if (res.error) return fail(errorText(res));
          data = res;
          render();
        });
      })
      .catch(function (err) { fail('เปิดหน้าไม่สำเร็จ กรุณาลองใหม่ (' + ((err && err.message) || err) + ')'); });
  }

  function render() {
    $('notice').textContent = data.notice;
    $('limit').textContent = data.lineLimit;
    $('barLimit').textContent = data.lineLimit;
    renderItems();
    data.provinces.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p;
      o.textContent = p;
      $('city').append(o);
    });
    if (data.binding) {
      state.useBinding = true;
      var b = data.binding;
      $('boundName').textContent = (b.buyerName || 'เลขประจำตัวผู้เสียภาษี ' + b.taxIdMasked) +
        (b.branchNo ? ' สาขา ' + b.branchNo : '');
    }
    bindForm();
    syncBuyer();
    renderBasket();
    $('loading').hidden = true;
    $('form').hidden = false;
    $('bar').hidden = false;
  }

  function renderItems() {
    var list = $('items');
    data.items.forEach(function (it) {
      var li = document.createElement('li');
      li.dataset.search = [it.no, it.name, it.category, it.categoryName].join(' ').toLowerCase();
      var info = document.createElement('div');
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = it.name;
      if (it.inStock) {
        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'พร้อมส่ง';
        name.append(' ', badge);
      }
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = it.no + ((it.categoryName || it.category) ? ' · ' + (it.categoryName || it.category) : '');
      info.append(name, meta);
      var qty = document.createElement('input');
      qty.type = 'number';
      qty.min = '1';
      qty.value = '1';
      qty.inputMode = 'decimal';
      qty.setAttribute('aria-label', 'จำนวน ' + it.name);
      var add = document.createElement('button');
      add.type = 'button';
      add.textContent = 'เพิ่ม';
      add.addEventListener('click', function () { addLine(it, Number(qty.value)); });
      li.append(info, qty, add);
      list.append(li);
    });
    $('search').addEventListener('input', function () {
      var q = this.value.trim().toLowerCase();
      Array.prototype.forEach.call(list.children, function (li) {
        li.hidden = q !== '' && li.dataset.search.indexOf(q) === -1;
      });
    });
  }

  function addLine(item, qty) {
    if (!(qty > 0)) return toast('จำนวนต้องมากกว่า 0');
    var line = state.basket.filter(function (l) { return l.no === item.no; })[0];
    if (line) {
      line.qty += qty;
    } else if (state.basket.length >= data.lineLimit) {
      return toast('เลือกได้ไม่เกิน ' + data.lineLimit + ' รายการ');
    } else {
      state.basket.push({ no: item.no, name: item.name, qty: qty });
    }
    renderBasket();
    toast('เพิ่ม ' + item.name + ' แล้ว');
  }

  function renderBasket() {
    var ul = $('basket');
    ul.textContent = '';
    state.basket.forEach(function (line, i) {
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = line.name + ' (' + line.no + ')';
      var qty = document.createElement('input');
      qty.type = 'number';
      qty.min = '1';
      qty.value = line.qty;
      qty.inputMode = 'decimal';
      qty.setAttribute('aria-label', 'จำนวน ' + line.name);
      qty.addEventListener('change', function () { line.qty = Number(qty.value); });
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link';
      remove.textContent = 'ลบ';
      remove.addEventListener('click', function () { state.basket.splice(i, 1); renderBasket(); });
      li.append(name, qty, remove);
      ul.append(li);
    });
    var n = state.basket.length;
    $('lineCount').textContent = n;
    $('barCount').textContent = n;
    $('basketEmpty').hidden = n > 0;
    if (n > 0) document.querySelector('[data-err="basket"]').textContent = '';
    $('bar').classList.toggle('full', n >= data.lineLimit);
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
    $('form').hidden = true;
    $('bar').hidden = true;
    clearTimeout(toastTimer);
    $('toast').hidden = true;
    $('reference').textContent = reference;
    $('done').hidden = false;
    window.scrollTo(0, 0);
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
