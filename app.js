'use strict';
/* Ben Dor field reports.
   The server (google/Code.gs, a Google Sheet) is the database. This file keeps a copy of the
   worker's own recent records on the phone plus an outbox of reports not yet delivered,
   so everything keeps working without reception and is sent later. */

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dstr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const tnow = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const mins = hm => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);
const dshow = s => s.split('-').reverse().join('.');
const h2 = n => n == null ? '' : (Math.round(n * 100) / 100).toFixed(2);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
const API_URL = (window.FR_CONFIG && window.FR_CONFIG.apiUrl) || 'api';
const MAX_FILE = 25 * 1024 * 1024;

let lang = localStorage.getItem('fr_lang') || 'he';
const t = k => (I18N[lang] && I18N[lang][k]) ?? I18N.he[k] ?? k;

function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.tm); toast.tm = setTimeout(() => el.classList.remove('show'), 3500);
}

const ACTIVITIES = [
  ['prune', 'trees'], ['thin', 'trees'], ['harvest', 'cartons'], ['irrigate', 'none'], ['spray', 'dunam'],
  ['plant', 'trees'], ['weed', 'rows'], ['train', 'trees'], ['pack', 'cartons'], ['other', 'none']
];
const UNITS = ['trees', 'cartons', 'bins', 'rows', 'dunam', 'none'];

// ---------- local state ----------
const LS = 'fr_state_v2';
const EMPTY = { token: null, user: null, users: [], punches: [], reports: [], consent: false };
let S = (() => {
  try { const j = JSON.parse(localStorage.getItem(LS)); if (j && Array.isArray(j.outbox)) return { ...EMPTY, ...j }; } catch (e) { /* start clean */ }
  return { ...EMPTY, outbox: [] };
})();
const persist = () => localStorage.setItem(LS, JSON.stringify(S));
const nameOf = (id, list) => (list || S.users).find(u => u.id === id)?.name || '';
const myOutbox = () => S.user ? S.outbox.filter(o => o.userId === S.user.id) : [];

// media blobs wait in IndexedDB until they are delivered
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('fr_media', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function mediaTx(mode, fn) {
  const d = await idb();
  return new Promise((res, rej) => { const tx = d.transaction('files', mode); const q = fn(tx.objectStore('files')); tx.oncomplete = () => res(q.result); tx.onerror = () => rej(tx.error); });
}
const mediaPut = (id, blob) => mediaTx('readwrite', s => s.put(blob, id));
const mediaGet = id => mediaTx('readonly', s => s.get(id));
const mediaDel = id => mediaTx('readwrite', s => s.delete(id));
const toB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
async function shrink(file) {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bmp = await createImageBitmap(file), k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.8));
  } catch (e) { return file; }
}

// ---------- server ----------
async function api(action, payload = {}) {
  const r = await fetch(API_URL, { method: 'POST', body: JSON.stringify({ action, token: S.token, ...payload }) });
  if (!r.ok) throw new Error('http ' + r.status);
  const j = await r.json();
  if (!j.ok && j.error === 'auth' && S.token) { signOutLocal(); render(); }
  return j;
}
function signOutLocal() { S = { ...EMPTY, outbox: S.outbox }; A = null; view = 'home'; persist(); }

// Server records plus anything still waiting in the outbox.
function applyState(st) {
  const pend = myOutboxFor(st.user.id);
  const merge = (server, op) => {
    const ids = new Set(server.map(x => x.id));
    return server.concat(pend.filter(o => o.op === op && !ids.has(o.id)).map(o => ({ ...o.rec, id: o.id, userId: o.userId })));
  };
  S.user = st.user; S.users = st.users;
  S.punches = merge(st.punches, 'punch'); S.reports = merge(st.reports, 'report');
  S.consent = st.consent || pend.some(o => o.op === 'consent');
}
const myOutboxFor = id => S.outbox.filter(o => o.userId === id);
const drop = ids => { S.outbox = S.outbox.filter(o => !ids.includes(o.id)); };

let syncing = false, again = false;
async function sync() {
  if (!S.token) return;
  if (syncing) { again = true; return; }
  syncing = true;
  try {
    const mine = myOutbox();
    const j = await api('sync', { ops: mine.filter(o => o.op !== 'media') });
    if (j.ok) {
      drop(j.done); applyState(j.state); persist();
      for (const m of mine.filter(o => o.op === 'media')) {
        const blob = await mediaGet(m.id);
        if (!blob) { drop([m.id]); continue; }
        const r = await api('sync', { ops: [{ ...m, rec: { ...m.rec, data: await toB64(blob) } }] });
        if (!r.ok) break;
        drop(r.done); await mediaDel(m.id); applyState(r.state); persist();
      }
    }
  } catch (e) { /* no reception: the outbox keeps everything for the next attempt */ }
  syncing = false; persist(); softRender();
  if (again) { again = false; sync(); }
}
function queue(op, rec, id = uid()) {
  S.outbox.push({ op, id, userId: S.user.id, rec }); persist(); sync(); return id;
}

// ---------- location ----------
function getPos() {
  return new Promise(res => {
    const none = { lat: null, lng: null, acc: null };
    if (!navigator.geolocation) return res(none);
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) }),
      () => res(none), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}
function locPill(l) {
  if (!l) return '';
  if (l.lat == null) return `<span class="pill bad">${esc(t('noGps'))}</span>`;
  return `<a class="pill ok" href="https://www.google.com/maps?q=${l.lat},${l.lng}" target="_blank" rel="noopener">📍 ${esc(t('map'))}</a>`;
}
const locText = l => !l ? '' : l.lat == null ? t('noGps') : `${l.lat}, ${l.lng}`;

// ---------- view state ----------
let view = 'home', adminTab = 'att';
let pending = [];      // attachments in the open report form: {id, blob, name, kind}
let recorder = null;
let A = null, aBusy = false, aErr = false;   // manager data for the chosen date range
const now0 = new Date();
let filt = { from: dstr(new Date(now0.getFullYear(), now0.getMonth(), 1)), to: dstr(now0), user: '' };

// ---------- attendance logic ----------
function attendanceRows(data, from, to, userId) {
  const rows = [];
  for (const u of data.users) {
    if (userId && u.id !== userId) continue;
    const ps = data.punches.filter(p => p.userId === u.id).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const mk = (pin, pout) => {
      const base = pin || pout;
      rows.push({ date: base.date, userId: u.id, name: u.name, tin: pin ? pin.time : '', tout: pout ? pout.time : '',
        hours: pin && pout ? (mins(pout.time) - mins(pin.time)) / 60 : null, lin: pin, lout: pout, source: 'self', by: '' });
    };
    let open = null;
    for (const p of ps) {
      if (p.type === 'in') { if (open) mk(open, null); open = p; }
      else if (open && open.date === p.date) { mk(open, p); open = null; }
      else { if (open) { mk(open, null); open = null; } mk(null, p); }
    }
    if (open) mk(open, null);
  }
  for (const r of data.reports) {
    for (const id of r.crew) {
      if (userId && id !== userId) continue;
      const name = nameOf(id, data.users); if (!name) continue;
      rows.push({ date: r.date, userId: id, name, tin: r.start, tout: r.end, hours: r.hours, lin: r.loc, lout: null, source: 'leader', by: nameOf(r.userId, data.users) });
    }
  }
  return rows.filter(r => r.date >= from && r.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name) || a.tin.localeCompare(b.tin));
}
const reportRows = (data, from, to, userId) => data.reports
  .filter(r => r.date >= from && r.date <= to && (!userId || r.userId === userId || r.crew.includes(userId)))
  .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
const mineData = () => ({ users: S.users.some(u => u.id === S.user.id) ? S.users : [S.user, ...S.users], punches: S.punches, reports: S.reports });
const lastPunch = () => S.punches.filter(p => p.userId === S.user.id).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))[0] || null;

// ---------- CSV ----------
function downloadCsv(name, header, rows) {
  const cell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = '﻿' + [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
}

// ---------- rendering ----------
function renderTop() {
  const n = myOutbox().length;
  $('#top').innerHTML = `<div class="title">${esc(t('appTitle'))}</div><div class="right">
    ${S.user ? `<button data-act="syncNow" title="${esc(n ? t('pendingSend') : t('allSent'))}">${n ? '⏳ ' + n : '✓'}</button>` : ''}
    <select id="langSel" aria-label="language"><option value="he"${lang === 'he' ? ' selected' : ''}>עברית</option><option value="ar"${lang === 'ar' ? ' selected' : ''}>العربية</option><option value="th"${lang === 'th' ? ' selected' : ''}>ไทย</option></select>
    ${S.user ? `<button data-act="logout">${esc(t('logout'))}</button>` : ''}</div>`;
}
// After a background sync: do not redraw a form someone is typing in.
function softRender() {
  if (!S.user || !S.consent) return render();
  if (view === 'report' || (view === 'admin' && adminTab === 'users')) return renderTop();
  render();
}
function render() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'th' ? 'ltr' : 'rtl';
  document.title = t('appTitle');
  renderTop();
  const app = $('#app');
  app.className = '';
  if (!S.user) { $('#nav').innerHTML = ''; app.innerHTML = vLogin(); return; }
  if (!S.consent) { $('#nav').innerHTML = ''; app.innerHTML = vConsent(); return; }
  if (view === 'admin' && S.user.role !== 'admin') view = 'home';
  const tabs = [['home', '🏠'], ['report', '📝'], ['mine', '📋']];
  if (S.user.role === 'admin') tabs.push(['admin', '⚙️']);
  $('#nav').innerHTML = tabs.map(([v, ic]) => `<button data-act="go" data-view="${v}" class="${view === v ? 'sel' : ''}"><span class="ic">${ic}</span>${esc(t(v))}</button>`).join('');
  if (view === 'admin') app.className = 'wide';
  app.innerHTML = ({ home: vHome, report: vReport, mine: vMine, admin: vAdmin })[view]();
  if (view === 'report') afterReport();
  // On a phone each table row is shown as a card; every cell needs its column name.
  $$('table', app).forEach(tb => {
    const heads = $$('th', tb).map(h => h.textContent);
    $$('tbody tr', tb).forEach(tr => [...tr.children].forEach((td, i) => { td.dataset.label = heads[i] || ''; }));
  });
}

function vLogin() {
  return `<form id="loginForm" class="card"><h2>${esc(t('loginTitle'))}</h2>
    <label for="num">${esc(t('workerNum'))}</label><input id="num" inputmode="numeric" autocomplete="username" required>
    <label for="pin">${esc(t('pin'))}</label><input id="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="8" required>
    <button class="btn" id="loginBtn">${esc(t('login'))}</button></form>`;
}
function vConsent() {
  return `<div class="card consent"><h2>${esc(t('consentTitle'))}</h2>
    <p>${esc(t('consent1'))}</p><p>${esc(t('consent2'))}</p><p>${esc(t('consent3'))}</p>
    <button class="btn" data-act="agree">${esc(t('agree'))}</button></div>`;
}

function vHome() {
  const today = dstr(new Date()), last = lastPunch();
  const on = !!last && last.type === 'in' && last.date === today;
  const stale = !!last && last.type === 'in' && last.date !== today;
  let hrs = attendanceRows(mineData(), today, today, S.user.id).filter(r => r.source === 'self').reduce((s, r) => s + (r.hours || 0), 0);
  if (on) hrs += Math.max(0, mins(tnow()) - mins(last.time)) / 60;
  const todays = S.punches.filter(p => p.userId === S.user.id && p.date === today).sort((a, b) => a.time.localeCompare(b.time));
  return `<div class="card"><div class="muted">${esc(t('hello'))}, ${esc(S.user.name)}</div>
    <div class="state ${on ? 'on' : ''}">${on ? `${esc(t('workingSince'))} ${last.time}` : esc(t('notWorking'))}</div>
    ${stale ? `<p class="pill warn" style="white-space:normal">${esc(t('openFromBefore'))}</p>` : ''}
    <button class="punch ${on ? 'out' : ''}" data-act="punch" data-type="${on ? 'out' : 'in'}">${esc(t(on ? 'punchOut' : 'punchIn'))}</button>
    <div id="gpsmsg" class="muted" style="margin-top:8px;min-height:20px"></div></div>
  <div class="card"><h2>${esc(t('today'))} · ${esc(t('hoursToday'))}: ${h2(hrs)}</h2>
    ${todays.length ? `<ul class="list">${todays.map(p => `<li><span>${esc(t(p.type))} ${p.time}</span><span>${locPill(p)}</span></li>`).join('')}</ul>` : `<div class="muted">${esc(t('noPunches'))}</div>`}</div>
  <button class="btn sec" data-act="go" data-view="report">📝 ${esc(t('report'))}</button>`;
}

function vReport() {
  const crew = S.users.filter(u => u.role !== 'admin' || u.id === S.user.id);
  const single = S.user.role === 'worker';
  return `<form id="repForm" class="card"><h2>${esc(t('report'))}</h2>
    <label for="rDate">${esc(t('date'))}</label><input id="rDate" type="date" value="${dstr(new Date())}" max="${dstr(new Date())}" required>
    <label for="rAct">${esc(t('activity'))}</label><select id="rAct">${ACTIVITIES.map(([a]) => `<option value="${a}">${esc(t('act_' + a))}</option>`).join('')}</select>
    ${single ? '' : `<label>${esc(t('crew'))}</label><div class="crew">${crew.map(u => `<label><input type="checkbox" name="crew" value="${u.id}"${u.id === S.user.id && S.user.role !== 'admin' ? ' checked' : ''}>${esc(u.name)}</label>`).join('')}</div>
    <label for="rExtra">${esc(t('extraWorkers'))}</label><input id="rExtra" type="number" min="0" value="0" inputmode="numeric">`}
    <div class="row"><div><label for="rStart">${esc(t('start'))}</label><input id="rStart" type="time" value="06:00" required></div>
      <div><label for="rEnd">${esc(t('end'))}</label><input id="rEnd" type="time" value="${tnow()}" required></div></div>
    <label for="rBreak">${esc(t('breakMin'))}</label><input id="rBreak" type="number" min="0" value="30" inputmode="numeric">
    <div class="row"><div><label for="rQty">${esc(t('qty'))}</label><input id="rQty" type="number" min="0" step="any" inputmode="decimal"></div>
      <div><label for="rUnit">${esc(t('unit'))}</label><select id="rUnit">${UNITS.map(u => `<option value="${u}">${esc(t('unit_' + u))}</option>`).join('')}</select></div></div>
    <label for="rNotes">${esc(t('notes'))}</label><textarea id="rNotes"></textarea>
    <div class="row" style="margin-top:12px">
      <button type="button" class="btn sec" style="margin:0" data-act="attach">📷 ${esc(t('attach'))}</button>
      <button type="button" class="btn sec" style="margin:0" data-act="rec" id="recBtn">🎤 ${esc(t('recVoice'))}</button></div>
    <input id="rFiles" type="file" accept="image/*,video/*" multiple hidden>
    <div class="att" id="attList"></div>
    <button class="btn" id="sendBtn">${esc(t('send'))}</button></form>`;
}
function afterReport() {
  const act = $('#rAct'), unit = $('#rUnit');
  const setUnit = () => { unit.value = (ACTIVITIES.find(a => a[0] === act.value) || [])[1] || 'none'; };
  act.addEventListener('change', setUnit); setUnit();
  $('#rFiles').addEventListener('change', async e => {
    for (const f of [...e.target.files]) {
      const blob = await shrink(f);
      if (blob.size > MAX_FILE) { toast(t('tooBig')); continue; }
      pending.push({ id: uid(), blob, name: f.name, kind: f.type.startsWith('video') ? 'video' : 'image' });
    }
    e.target.value = ''; drawAtt();
  });
  drawAtt();
}
const kindIcon = k => k === 'audio' ? '🎤' : k === 'video' ? '🎬' : '📷';
function drawAtt() {
  const el = $('#attList'); if (!el) return;
  el.innerHTML = pending.map(a => `<div><span>${kindIcon(a.kind)} ${esc(a.name)}</span><button type="button" class="btn small danger" data-act="unattach" data-id="${a.id}">${esc(t('remove'))}</button></div>`).join('');
}

function vMine() {
  const d = new Date(), from = dstr(new Date(d.getFullYear(), d.getMonth(), 1)), to = dstr(d), data = mineData();
  const rows = attendanceRows(data, from, to, S.user.id);
  const self = rows.filter(r => r.source === 'self'), lead = rows.filter(r => r.source === 'leader');
  const sum = a => a.reduce((s, r) => s + (r.hours || 0), 0);
  const reps = reportRows(data, from, to, S.user.id).reverse();
  const waiting = new Set(myOutbox().map(o => o.id));
  return `<div class="card"><h2>${esc(t('monthHours'))}</h2>
    <ul class="list"><li><span>${esc(t('hoursSelf'))}</span><b>${h2(sum(self))}</b></li><li><span>${esc(t('hoursLeader'))}</span><b>${h2(sum(lead))}</b></li></ul></div>
  <div class="card"><h2>${esc(t('myPunches'))}</h2>${self.length ? `<ul class="list">${self.slice().reverse().map(r => `<li><span>${dshow(r.date)} · ${r.tin || '--:--'} - ${r.tout || `<span class="pill bad">${esc(t('missingOut'))}</span>`}</span><span>${r.hours != null ? h2(r.hours) : ''} ${locPill(r.lin)}</span></li>`).join('')}</ul>` : `<div class="muted">${esc(t('noPunches'))}</div>`}</div>
  <div class="card"><h2>${esc(t('myReports'))}</h2>${reps.length ? `<ul class="list">${reps.map(r => `<li><span>${dshow(r.date)} · ${esc(t('act_' + r.activity))}${waiting.has(r.id) ? ' ⏳' : ''}<br><span class="muted">${r.start}-${r.end} · ${r.crew.length + r.extra} ${esc(t('workers'))}${r.qty != null ? ` · ${r.qty} ${esc(t('unit_' + r.unit))}` : ''}</span></span><b>${h2(r.hours)}</b></li>`).join('')}</ul>` : `<div class="muted">${esc(t('noPunches'))}</div>`}</div>`;
}

async function loadAdmin() {
  aBusy = true; render();
  try { const j = await api('admin', { from: filt.from, to: filt.to }); if (j.ok) { A = j; aErr = false; } else aErr = true; }
  catch (e) { aErr = true; }
  aBusy = false; render();
}
function vAdmin() {
  if (aBusy) return `<div class="card muted">${esc(t('loading'))}</div>`;
  if (!A || aErr) return `<div class="card"><p class="muted">${esc(aErr ? t('offline') : t('loading'))}</p><button class="btn small" data-act="reload">${esc(t('retry'))}</button></div>`;
  const tabs = [['att', 'tabAtt'], ['sum', 'tabSum'], ['rep', 'tabRep'], ['users', 'tabUsers']];
  const head = `<div class="tabs">${tabs.map(([k, l]) => `<button data-act="tab" data-tab="${k}" class="${adminTab === k ? 'sel' : ''}">${esc(t(l))}</button>`).join('')}</div>`;
  const filters = `<div class="filters">
    <div><label for="fFrom">${esc(t('from'))}</label><input id="fFrom" type="date" value="${filt.from}"></div>
    <div><label for="fTo">${esc(t('to'))}</label><input id="fTo" type="date" value="${filt.to}"></div>
    <div class="f-user"><label for="fUser">${esc(t('worker'))}</label><select id="fUser"><option value="">${esc(t('all'))}</option>${A.users.map(u => `<option value="${u.id}"${filt.user === u.id ? ' selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
    <div class="f-btns"><button class="btn small sec" data-act="reload">⟳ ${esc(t('refresh'))}</button> <button class="btn small" data-act="csv">⬇ ${esc(t('exportCsv'))}</button></div></div>`;
  const tbl = (cols, rows) => rows.length ? `<div class="scroll"><table><thead><tr>${cols.map(c => `<th>${esc(t(c))}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<div class="muted">${esc(t('noRows'))}</div>`;
  let body = '';
  if (adminTab === 'att') {
    body = filters + tbl(['date', 'worker', 'in', 'out', 'hours', 'locIn', 'locOut', 'source'], attendanceRows(A, filt.from, filt.to, filt.user).map(r => `<tr>
      <td>${dshow(r.date)}</td><td>${esc(r.name)}</td><td>${r.tin}</td><td>${r.tout || `<span class="pill bad">${esc(t('missingOut'))}</span>`}</td>
      <td>${h2(r.hours)}</td><td>${locPill(r.lin)}</td><td>${locPill(r.lout)}</td>
      <td>${r.source === 'self' ? esc(t('srcSelf')) : esc(t('srcLeader')) + ': ' + esc(r.by)}</td></tr>`));
  } else if (adminTab === 'sum') {
    body = filters + tbl(['worker', 'days', 'hoursSelf', 'hoursLeader'], summaryRows().map(s => `<tr><td>${esc(s.name)}</td><td>${s.days}</td><td>${h2(s.self)}</td><td>${h2(s.leader)}</td></tr>`));
  } else if (adminTab === 'rep') {
    body = filters + tbl(['date', 'reporter', 'activity', 'workers', 'start', 'end', 'hours', 'workerHours', 'qty', 'unit', 'location', 'notes', 'files'], reportRows(A, filt.from, filt.to, filt.user).map(r => `<tr>
      <td>${dshow(r.date)}</td><td>${esc(nameOf(r.userId, A.users))}</td><td>${esc(t('act_' + r.activity))}</td>
      <td title="${esc(r.crew.map(id => nameOf(id, A.users)).join(', '))}">${r.crew.length + r.extra}</td><td>${r.start}</td><td>${r.end}</td><td>${h2(r.hours)}</td><td>${h2(r.hours * (r.crew.length + r.extra))}</td>
      <td>${r.qty ?? ''}</td><td>${r.qty != null ? esc(t('unit_' + r.unit)) : ''}</td><td>${locPill(r.loc)}</td><td class="wrap">${esc(r.notes)}</td>
      <td>${r.media.map(m => `<a href="${esc(m.url)}" target="_blank" rel="noopener" title="${esc(m.name)}">${kindIcon(m.kind)}</a>`).join(' ')}</td></tr>`));
  } else {
    body = `<div class="scroll"><table><thead><tr><th>${esc(t('workerNum'))}</th><th>${esc(t('name'))}</th><th>${esc(t('role'))}</th><th>${esc(t('pin'))}</th><th>${esc(t('active'))}</th></tr></thead><tbody>
      ${A.users.map(u => `<tr data-id="${u.id}"><td><input data-f="num" value="${esc(u.num)}" inputmode="numeric" style="width:80px"></td><td><input data-f="name" value="${esc(u.name)}"></td>
        <td><select data-f="role">${['worker', 'leader', 'admin'].map(r => `<option value="${r}"${u.role === r ? ' selected' : ''}>${esc(t('role_' + r))}</option>`).join('')}</select></td>
        <td><input data-f="pin" value="${esc(u.pin)}" inputmode="numeric" maxlength="8" style="width:110px"></td>
        <td><input data-f="active" type="checkbox" style="width:22px;height:22px"${u.active ? ' checked' : ''}></td></tr>`).join('')}
      </tbody></table></div><div class="row" style="margin-top:12px"><button class="btn small sec" data-act="addUser">+ ${esc(t('add'))}</button><button class="btn small" data-act="saveUsers">${esc(t('save'))}</button></div>`;
  }
  return head + `<div class="card">${body}</div>`;
}
function summaryRows() {
  const m = new Map();
  for (const r of attendanceRows(A, filt.from, filt.to, filt.user)) {
    if (!m.has(r.userId)) m.set(r.userId, { name: r.name, dates: new Set(), self: 0, leader: 0 });
    const s = m.get(r.userId); s.dates.add(r.date); s[r.source] += r.hours || 0;
  }
  return [...m.values()].map(s => ({ ...s, days: s.dates.size })).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- actions ----------
function readUsers() {
  $$('tbody tr[data-id]').forEach(tr => {
    const o = A.users.find(x => x.id === tr.dataset.id); if (!o) return;
    $$('[data-f]', tr).forEach(i => { o[i.dataset.f] = i.type === 'checkbox' ? i.checked : i.value.trim(); });
  });
}
const newPin = () => String(1000 + crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
const actions = {
  logout() { if (myOutbox().length && !confirm(t('unsentWarn'))) return; signOutLocal(); render(); },
  syncNow() { sync(); },
  agree() { S.consent = true; queue('consent', { lang }); render(); },
  go(el) { view = el.dataset.view; render(); window.scrollTo(0, 0); if (view === 'admin') loadAdmin(); else sync(); },
  tab(el) { adminTab = el.dataset.tab; render(); },
  reload() { loadAdmin(); },
  async punch(el) {
    el.disabled = true; $('#gpsmsg').textContent = t('locating');
    const pos = await getPos(), type = el.dataset.type;
    const rec = { type, date: dstr(new Date()), time: tnow(), ...pos };
    const id = uid();
    S.punches.push({ ...rec, id, userId: S.user.id });
    queue('punch', rec, id); render();
    toast(`${t(type === 'in' ? 'savedIn' : 'savedOut')} · ${t(pos.lat == null ? 'noGps' : 'withLoc')}`);
  },
  attach() { $('#rFiles').click(); },
  unattach(el) { pending = pending.filter(a => a.id !== el.dataset.id); drawAtt(); },
  async rec() {
    if (recorder) { recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = []; recorder = new MediaRecorder(stream);
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach(tr => tr.stop());
        pending.push({ id: uid(), blob: new Blob(chunks, { type: recorder.mimeType }), name: `${t('voice')} ${tnow()}`, kind: 'audio' });
        recorder = null; const b = $('#recBtn'); if (b) b.textContent = '🎤 ' + t('recVoice'); drawAtt();
      };
      recorder.start(); $('#recBtn').textContent = '⏹ ' + t('stopRec');
    } catch (e) { recorder = null; toast(t('noMic')); }
  },
  csv() {
    const stamp = `${filt.from}_${filt.to}`;
    if (adminTab === 'att') {
      downloadCsv(`attendance_${stamp}.csv`, ['date', 'worker', 'in', 'out', 'hours', 'locIn', 'locOut', 'source', 'reporter'].map(t),
        attendanceRows(A, filt.from, filt.to, filt.user).map(r => [dshow(r.date), r.name, r.tin, r.tout, h2(r.hours), locText(r.lin), locText(r.lout), t(r.source === 'self' ? 'srcSelf' : 'srcLeader'), r.by]));
    } else if (adminTab === 'sum') {
      downloadCsv(`payroll_summary_${stamp}.csv`, ['worker', 'days', 'hoursSelf', 'hoursLeader'].map(t), summaryRows().map(s => [s.name, s.days, h2(s.self), h2(s.leader)]));
    } else if (adminTab === 'rep') {
      downloadCsv(`work_reports_${stamp}.csv`, ['date', 'reporter', 'activity', 'crew', 'workers', 'start', 'end', 'breakMin', 'hours', 'workerHours', 'qty', 'unit', 'lat', 'lng', 'notes', 'files'].map(t),
        reportRows(A, filt.from, filt.to, filt.user).map(r => [dshow(r.date), nameOf(r.userId, A.users), t('act_' + r.activity), r.crew.map(id => nameOf(id, A.users)).join('; '), r.crew.length + r.extra, r.start, r.end, r.breakMin, h2(r.hours), h2(r.hours * (r.crew.length + r.extra)), r.qty ?? '', r.qty != null ? t('unit_' + r.unit) : '', r.loc.lat ?? '', r.loc.lng ?? '', r.notes, r.media.map(m => m.url).join(' ')]));
    }
  },
  addUser() {
    readUsers();
    const next = Math.max(0, ...A.users.map(u => parseInt(u.num, 10) || 0)) + 1;
    A.users.push({ id: uid(), num: String(next), name: '', role: 'worker', pin: newPin(), active: true }); render();
  },
  async saveUsers() {
    readUsers();
    try {
      const j = await api('saveUsers', { users: A.users.filter(u => u.name) });
      if (j.ok) { A.users = j.users; render(); toast(t('saved')); }
      else toast(t(j.error === 'dup_num' ? 'dupNum' : j.error === 'need_admin' ? 'needAdmin' : 'serverErr'));
    } catch (e) { toast(t('offline')); }
  }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  actions[el.dataset.act]?.(el);
});
document.addEventListener('change', e => {
  if (e.target.id === 'langSel') { lang = e.target.value; localStorage.setItem('fr_lang', lang); render(); }
  if (e.target.id === 'fUser') { filt.user = e.target.value; render(); }
  if (e.target.id === 'fFrom' || e.target.id === 'fTo') { filt.from = $('#fFrom').value || filt.from; filt.to = $('#fTo').value || filt.to; loadAdmin(); }
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.id === 'loginForm') {
    const btn = $('#loginBtn'); btn.disabled = true;
    try {
      const j = await api('login', { num: $('#num').value.trim(), pin: $('#pin').value });
      if (j.ok) {
        S.token = j.token; applyState(j.state); persist();
        view = S.user.role === 'admin' ? 'admin' : 'home'; render();
        if (view === 'admin' && S.consent) loadAdmin();
        sync(); return;
      }
      toast(t(j.error === 'locked' ? 'locked' : j.error === 'bad_login' ? 'badLogin' : 'serverErr'));
    } catch (err) { toast(t('offline')); }
    btn.disabled = false; $('#pin').value = '';
  }
  if (e.target.id === 'repForm') {
    const start = $('#rStart').value, end = $('#rEnd').value, brk = parseInt($('#rBreak').value, 10) || 0;
    const m = mins(end) - mins(start) - brk;
    if (m <= 0) return toast(t('badTimes'));
    const single = S.user.role === 'worker';
    const crew = single ? [S.user.id] : $$('input[name=crew]:checked').map(i => i.value);
    const extra = single ? 0 : (parseInt($('#rExtra').value, 10) || 0);
    if (!crew.length && !extra) return toast(t('noCrew'));
    const btn = $('#sendBtn'); btn.disabled = true; btn.textContent = t('locating');
    const rec = {
      date: $('#rDate').value, activity: $('#rAct').value, crew, extra, start, end, breakMin: brk, hours: m / 60,
      qty: $('#rQty').value === '' ? null : parseFloat($('#rQty').value), unit: $('#rUnit').value, notes: $('#rNotes').value.trim()
    };
    rec.loc = await getPos();
    const id = uid(), files = pending; pending = [];
    for (const a of files) await mediaPut(a.id, a.blob);
    S.reports.push({ ...rec, id, userId: S.user.id, media: files.map(a => ({ id: a.id, name: a.name, kind: a.kind, url: '' })) });
    for (const a of files) S.outbox.push({ op: 'media', id: a.id, userId: S.user.id, rec: { reportId: id, name: a.name, kind: a.kind, mime: a.blob.type } });
    queue('report', rec, id);
    view = 'mine'; render(); window.scrollTo(0, 0);
    toast(navigator.onLine ? t('sent') : t('savedOffline'));
  }
});

window.addEventListener('online', sync);
setInterval(() => { if (myOutbox().length) sync(); }, 60000);
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
render();
if (S.token) { if (view === 'admin') loadAdmin(); sync(); }
