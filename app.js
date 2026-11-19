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
// sort key for punches: within the same minute, a clock-in comes before a clock-out
const pkey = p => p.date + p.time + (p.type === 'out' ? '1' : '0');
const mins = hm => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);
const dshow = s => s.split('-').reverse().join('.');
const h2 = n => n == null ? '' : (Math.round(n * 100) / 100).toFixed(2);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
const API_URL = (window.FR_CONFIG && window.FR_CONFIG.apiUrl) || 'api';
const MAX_FILE = 25 * 1024 * 1024;

// No saved choice yet: follow the phone's own language (Thai or Arabic phone), otherwise Hebrew.
function phoneLang() {
  const list = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']).map(x => String(x).toLowerCase().slice(0, 2));
  for (const l of list) { if (l === 'th' || l === 'ar' || l === 'he' || l === 'iw') return l === 'iw' ? 'he' : l; }
  return 'he';
}
let lang = localStorage.getItem('fr_lang') || phoneLang();
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
const LS = 'fr_state_v2' + (API_URL === 'api' ? '_mock' : ''); // local test data never mixes with the real session
const EMPTY = { token: null, user: null, users: [], punches: [], reports: [], consent: false };
let S = (() => {
  try { const j = JSON.parse(localStorage.getItem(LS)); if (j && Array.isArray(j.outbox)) return { ...EMPTY, ...j }; } catch (e) { /* start clean */ }
  return { ...EMPTY, outbox: [] };
})();
const persist = () => localStorage.setItem(LS, JSON.stringify(S));
// Managers see the Hebrew nickname first (label); workers' own screens have no nickname and show the name.
const nameOf = (id, list) => { const u = (list || S.users).find(u => u.id === id); return u ? (u.label || u.name) : ''; };
const labelUsers = j => { (j.users || []).forEach(u => { u.label = u.nick ? `${u.nick} · ${u.name}` : u.name; }); return j; };
const MGR = ['admin', 'viewer'];
const isMgr = () => !!S.user && MGR.includes(S.user.role);
// A full manager only looks at the data: no clock-in, no personal work report, no location notice (Ido 19.11.2026).
const noSelf = () => !!S.user && S.user.role === 'admin';
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
  S.punches = merge(st.punches, 'punch');
  // An unsent report (new, or an edit of today's) wins over the server's copy of the same report.
  const reps = new Map(st.reports.map(r => [r.id, r]));
  pend.filter(o => o.op === 'report').forEach(o => {
    const id = o.rec.reportId || o.id, prev = reps.get(id);
    reps.set(id, { ...o.rec, id, userId: o.userId, media: (prev && prev.media) || [] });
  });
  S.reports = [...reps.values()];
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
// A cold GPS often needs more than 15 seconds for its first fix, so two requests run side by side:
// a precise one (GPS) and a coarse one (network). The precise fix wins when it arrives in time;
// otherwise the coarse one is used. posDenied tells the caller the phone blocked location.
let posDenied = false;
function getPos() {
  return new Promise(res => {
    const none = { lat: null, lng: null, acc: null };
    if (!navigator.geolocation) return res(none);
    // The first GPS answer is often a rough cell-tower guess (hundreds of metres). Keep listening and
    // keep the best reading: stop at once at 30 m, accept 100 m after 6 s, take whatever there is at 15 s.
    let best = warmFix && Date.now() - warmFix.at < 20000 ? warmFix.v : null, done = false, late = false, wid = null, t1 = 0, t2 = 0;
    posDenied = false;
    const finish = () => {
      if (done) return; done = true; clearTimeout(t1); clearTimeout(t2);
      if (wid != null) navigator.geolocation.clearWatch(wid);
      res(best || none);
    };
    if (best && best.acc <= 30) return finish();
    const ok = p => {
      const v = fixOf(p);
      if (!best || v.acc < best.acc) best = v;
      if (best.acc <= 30 || (late && best.acc <= 100)) finish();
    };
    const fail = e => { if (e && e.code === 1) { posDenied = true; finish(); } };
    wid = navigator.geolocation.watchPosition(ok, fail, { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 });
    navigator.geolocation.getCurrentPosition(ok, () => {}, { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 });
    t1 = setTimeout(() => { late = true; if (best && best.acc <= 100) finish(); }, 6000);
    t2 = setTimeout(finish, 15000);
  });
}
const fixOf = p => ({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) });
// Called when the home screen opens: the phone asks for the location permission before the first
// clock-in, and the GPS warms up for one minute so it is already accurate when the worker taps.
// The reading stays in memory only and is used only if a clock-in follows within 20 seconds.
let warmed = false, warmFix = null;
function warmPos() {
  if (warmed || !navigator.geolocation) return;
  warmed = true;
  const wid = navigator.geolocation.watchPosition(p => { warmFix = { v: fixOf(p), at: Date.now() }; }, () => {}, { enableHighAccuracy: true, timeout: 25000, maximumAge: 0 });
  setTimeout(() => { navigator.geolocation.clearWatch(wid); warmed = false; }, 60000);
}
function locPill(l) {
  if (!l) return '';
  if (l.lat == null) return `<span class="pill bad">${esc(t('noGps'))}</span>`;
  return `<a class="pill ok" href="https://www.google.com/maps?q=${l.lat},${l.lng}" target="_blank" rel="noopener">📍 ${esc(t('map'))}</a>`;
}
const locText = l => !l ? '' : l.lat == null ? t('noGps') : `${l.lat}, ${l.lng}`;

// ---------- view state ----------
let view = 'home', adminTab = 'dash';
let regMode = false, regDone = false;   // login screen: registration form / "registration received" notice
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
    const ps = data.punches.filter(p => p.userId === u.id).sort((a, b) => pkey(a).localeCompare(pkey(b)));
    const mk = (pin, pout) => {
      const base = pin || pout;
      rows.push({ date: base.date, userId: u.id, name: u.label || u.name, tin: pin ? pin.time : '', tout: pout ? pout.time : '',
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
const lastPunch = () => S.punches.filter(p => p.userId === S.user.id).sort((a, b) => pkey(b).localeCompare(pkey(a)))[0] || null;

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
  if (!S.user || (!S.consent && !noSelf())) return render();
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
  document.body.classList.toggle('bg', !S.user);   // orchard photo behind the login and registration screens
  if (!S.user) { $('#nav').innerHTML = ''; app.innerHTML = vLogin(); return; }
  if (!S.consent && !noSelf()) { $('#nav').innerHTML = ''; app.innerHTML = vConsent(); return; }
  if (noSelf()) view = 'admin';
  if (view === 'admin' && !isMgr()) view = 'home';
  const tabs = noSelf() ? [] : [['home', '🏠'], ['report', '📝'], ['mine', '📋']];
  if (isMgr()) tabs.push(['admin', '⚙️']);
  $('#nav').innerHTML = tabs.length < 2 ? '' : tabs.map(([v, ic]) => `<button data-act="go" data-view="${v}" class="${view === v ? 'sel' : ''}"><span class="ic">${ic}</span>${esc(t(v))}</button>`).join('');
  if (view === 'admin') app.className = 'wide';
  app.innerHTML = ({ home: vHome, report: vReport, mine: vMine, admin: vAdmin })[view]();
  if (view === 'report') afterReport();
  if (view === 'home') warmPos();
  // On a phone each table row is shown as a card; every cell needs its column name.
  $$('table', app).forEach(tb => {
    const heads = $$('th', tb).map(h => h.textContent);
    $$('tbody tr', tb).forEach(tr => [...tr.children].forEach((td, i) => { td.dataset.label = heads[i] || ''; }));
  });
}

function vLogin() {
  if (regMode) return `<form id="regForm" class="card"><h2>${esc(t('regTitle'))}</h2>
    <label for="gName">${esc(t('fullName'))}</label><input id="gName" autocomplete="name" maxlength="60" required>
    <label for="gId">${esc(t('idnum'))}</label><input id="gId" autocomplete="off" maxlength="15" required>
    <label for="gPhone">${esc(t('phone'))}</label><input id="gPhone" type="tel" inputmode="tel" autocomplete="tel" maxlength="20">
    <label for="gPin">${esc(t('choosePin'))}</label><input id="gPin" type="password" inputmode="numeric" autocomplete="new-password" minlength="4" maxlength="8" required>
    <label for="gPin2">${esc(t('pinAgain'))}</label><input id="gPin2" type="password" inputmode="numeric" autocomplete="new-password" minlength="4" maxlength="8" required>
    <button class="btn" id="regBtn">${esc(t('register'))}</button>
    <button type="button" class="btn sec" data-act="hideReg">${esc(t('backToLogin'))}</button></form>`;
  return `<div class="hero">${esc(t('loginHero'))}</div>${regDone ? `<div class="card"><span class="pill ok" style="white-space:normal;font-size:16px">${esc(t(regDone === 'now' ? 'regNow' : 'regDone'))}</span></div>` : ''}
  <form id="loginForm" class="card"><h2>${esc(t('loginTitle'))}</h2>
    <label for="num">${esc(t('loginId'))}</label><input id="num" autocomplete="username" value="${esc(localStorage.getItem('fr_lastid') || '')}" required>
    <label for="pin">${esc(t('pin'))}</label><input id="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="8" required>
    <button class="btn" id="loginBtn">${esc(t('login'))}</button>
    <button type="button" class="btn sec" data-act="showReg">${esc(t('newWorker'))}</button></form>`;
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
  const todays = S.punches.filter(p => p.userId === S.user.id && p.date === today).sort((a, b) => pkey(a).localeCompare(pkey(b)));
  const mrows = attendanceRows(mineData(), today.slice(0, 8) + '01', today, S.user.id).filter(r => r.source === 'self');
  const mdays = new Set(mrows.map(r => r.date)).size;
  const mhrs = mrows.reduce((s, r) => s + (r.hours || 0), 0) + (on ? Math.max(0, mins(tnow()) - mins(last.time)) / 60 : 0);
  const hr = new Date().getHours(), greet = t(hr < 12 ? 'gMorning' : hr < 17 ? 'gNoon' : 'gEve');
  return `<div class="card"><div class="greet">${esc(greet)}, ${esc(S.user.name)}</div>
    <div class="state ${on ? 'on' : ''}">${on ? `${esc(t('workingSince'))} ${last.time}` : esc(t('notWorking'))}</div>
    ${stale ? `<p class="pill warn" style="white-space:normal">${esc(t('openFromBefore'))}</p>` : ''}
    <button class="punch ${on ? 'out' : ''}" data-act="punch" data-type="${on ? 'out' : 'in'}">${esc(t(on ? 'punchOut' : 'punchIn'))}</button>
    <div id="gpsmsg" class="muted" style="margin-top:8px;min-height:20px"></div></div>
  <div class="card"><h2>${esc(t('today'))} · ${esc(t('hoursToday'))}: ${h2(hrs)}</h2>
    ${todays.length ? `<ul class="list">${todays.map(p => `<li><span>${esc(t(p.type))} ${p.time}</span><span>${locPill(p)}</span></li>`).join('')}</ul>` : `<div class="muted">${esc(t('noPunches'))}</div>`}</div>
  <button class="card monthcard" data-act="go" data-view="mine"><span>${esc(t('monthHours'))}<br><span class="muted">${mdays} ${esc(t('workDays'))}</span></span><b>${h2(mhrs)}</b></button>
  ${homeReportBlock(on)}`;
}
// One work report per day, filled in at clock-out and editable until the end of that day.
const todayStr = () => dstr(new Date());
const myTodayPunches = () => S.punches.filter(p => p.userId === S.user.id && p.date === todayStr()).sort((a, b) => pkey(a).localeCompare(pkey(b)));
const todayReport = () => S.reports.find(r => r.userId === S.user.id && r.date === todayStr()) || null;
const outToday = () => myTodayPunches().some(p => p.type === 'out');
const canReport = () => isMgr() || outToday() || !!todayReport();
function homeReportBlock(on) {
  const btn = k => `<button class="btn sec" data-act="go" data-view="report">📝 ${esc(t(k))}</button>`;
  if (todayReport()) return btn('editToday');
  if (on || !canReport()) return `<p class="muted" style="text-align:center">${esc(t('reportAtOut'))}</p>`;
  return `${outToday() ? `<p class="pill warn" style="white-space:normal;font-size:15px;display:block;text-align:center">${esc(t('noReportToday'))}</p>` : ''}${btn('reportNow')}`;
}

function vReport() {
  if (!canReport()) return `<div class="card"><h2>${esc(t('report'))}</h2><p>${esc(t('reportAfterOut'))}</p>
    <button class="btn sec" data-act="go" data-view="home">${esc(t('home'))}</button></div>`;
  const crew = S.users.filter(u => !MGR.includes(u.role) || u.id === S.user.id);
  const single = S.user.role === 'worker';
  const prev = todayReport(), ps = myTodayPunches();
  const firstIn = ps.find(p => p.type === 'in'), lastOut = ps.filter(p => p.type === 'out').pop();
  const v = prev || { activity: ACTIVITIES[0][0], crew: isMgr() ? [] : [S.user.id], extra: 0, start: firstIn ? firstIn.time : '06:00', end: lastOut ? lastOut.time : tnow(), breakMin: 30, qty: null, unit: '', notes: '', media: [] };
  if (!prev && mins(v.end) - mins(v.start) < 360) v.breakMin = 0;   // no default break on a short day
  const sel = (a, b) => a === b ? ' selected' : '';
  return `<form id="repForm" class="card"${prev ? ' data-edit="1"' : ''}><h2>${esc(t(prev ? 'editTitle' : 'report'))} · ${dshow(prev ? prev.date : todayStr())}</h2>
    ${prev ? `<p class="muted">${esc(t('editHelp'))}</p>` : ''}
    <label for="rAct">${esc(t('activity'))}</label><select id="rAct">${ACTIVITIES.map(([a]) => `<option value="${a}"${sel(a, v.activity)}>${esc(t('act_' + a))}</option>`).join('')}</select>
    ${single ? '' : `<label for="rTotal">${esc(t('totalWorkers'))}</label><input id="rTotal" type="number" min="1" value="${prev ? Math.max(1, v.crew.length + v.extra) : 1}" inputmode="numeric">
    <label>${esc(t('crew'))}</label><div class="crew">${crew.map(u => `<label><input type="checkbox" name="crew" value="${u.id}"${v.crew.includes(u.id) ? ' checked' : ''}>${esc(u.name)}</label>`).join('')}</div>`}
    <div class="row"><div><label for="rStart">${esc(t('start'))}</label><input id="rStart" type="time" value="${esc(v.start)}" required></div>
      <div><label for="rEnd">${esc(t('end'))}</label><input id="rEnd" type="time" value="${esc(v.end)}" required></div></div>
    <label for="rBreak">${esc(t('breakMin'))}</label><input id="rBreak" type="number" min="0" value="${v.breakMin}" inputmode="numeric">
    <div class="row"><div><label for="rQty">${esc(t('qty'))}</label><input id="rQty" type="number" min="0" step="any" inputmode="decimal" value="${v.qty ?? ''}"></div>
      <div><label for="rUnit">${esc(t('unit'))}</label><select id="rUnit">${UNITS.map(u => `<option value="${u}"${sel(u, v.unit)}>${esc(t('unit_' + u))}</option>`).join('')}</select></div></div>
    <label for="rNotes">${esc(t('notes'))}</label><textarea id="rNotes">${esc(v.notes)}</textarea>
    <div class="row" style="margin-top:12px">
      <button type="button" class="btn sec" style="margin:0" data-act="attach">📷 ${esc(t('attach'))}</button>
      <button type="button" class="btn sec" style="margin:0" data-act="rec" id="recBtn">🎤 ${esc(t('recVoice'))}</button></div>
    <input id="rFiles" type="file" accept="image/*,video/*" multiple hidden>
    ${v.media && v.media.length ? `<p class="muted">${esc(t('alreadySent'))}: ${v.media.map(m => kindIcon(m.kind)).join(' ')}</p>` : ''}
    <div class="att" id="attList"></div>
    <button class="btn" id="sendBtn">${esc(t(prev ? 'saveChanges' : 'send'))}</button>
    ${prev ? '' : `<button type="button" class="btn sec" data-act="go" data-view="home">${esc(t('skipReport'))}</button>`}</form>`;
}
function afterReport() {
  const form = $('#repForm'); if (!form) return;
  const act = $('#rAct'), unit = $('#rUnit');
  const setUnit = () => { unit.value = (ACTIVITIES.find(a => a[0] === act.value) || [])[1] || 'none'; };
  act.addEventListener('change', setUnit); if (!form.dataset.edit) setUnit();
  // Ticking names never leaves the total smaller than the number of names.
  form.addEventListener('change', e => {
    if (e.target.name !== 'crew') return;
    const tot = $('#rTotal'), n = $$('input[name=crew]:checked').length;
    if (tot && (parseInt(tot.value, 10) || 0) < n) tot.value = n;
  });
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
  const waiting = new Set(myOutbox().map(o => o.rec.reportId || o.id));
  return `<div class="card"><h2>${esc(t('monthHours'))}</h2>
    <ul class="list"><li><span>${esc(t('hoursSelf'))}</span><b>${h2(sum(self))}</b></li><li><span>${esc(t('hoursLeader'))}</span><b>${h2(sum(lead))}</b></li></ul></div>
  <div class="card"><h2>${esc(t('myPunches'))}</h2>${self.length ? `<ul class="list">${self.slice().reverse().map(r => `<li><span>${dshow(r.date)} · ${r.tin || '--:--'} - ${r.tout || `<span class="pill bad">${esc(t('missingOut'))}</span>`}</span><span>${r.hours != null ? h2(r.hours) : ''} ${locPill(r.lin)}</span></li>`).join('')}</ul>` : `<div class="muted">${esc(t('noPunches'))}</div>`}</div>
  <div class="card"><h2>${esc(t('myReports'))}</h2>${reps.length ? `<ul class="list">${reps.map(r => `<li><span>${dshow(r.date)} · ${esc(t('act_' + r.activity))}${waiting.has(r.id) ? ' ⏳' : ''}<br><span class="muted">${r.start}-${r.end} · ${r.crew.length + r.extra} ${esc(t('workers'))}${r.qty != null ? ` · ${r.qty} ${esc(t('unit_' + r.unit))}` : ''}</span></span><b>${h2(r.hours)}</b></li>`).join('')}</ul>` : `<div class="muted">${esc(t('noPunches'))}</div>`}</div>`;
}

async function loadAdmin() {
  aBusy = true; render();
  try { const j = await api('admin', { from: filt.from, to: filt.to }); if (j.ok) { A = labelUsers(j); aErr = false; } else aErr = true; }
  catch (e) { aErr = true; }
  aBusy = false; render();
}
function vAdmin() {
  const tabs = [['dash', 'tabDash'], ['att', 'tabAtt'], ['sum', 'tabSum'], ['rep', 'tabRep']];
  if (S.user.role === 'admin') tabs.push(['users', 'tabUsers']); else if (adminTab === 'users') adminTab = 'dash';
  const src = A || D;
  const waiting = src ? src.users.filter(u => u.pending).length : 0;
  const head = `<div class="tabs">${tabs.map(([k, l]) => `<button data-act="tab" data-tab="${k}" class="${adminTab === k ? 'sel' : ''}">${esc(t(l))}${k === 'users' && waiting ? ` (${waiting})` : ''}</button>`).join('')}</div>`;
  if (adminTab === 'dash') return head + vDash(waiting);
  if (aBusy) return head + `<div class="card muted">${esc(t('loading'))}</div>`;
  if (!A || aErr) return head + `<div class="card"><p class="muted">${esc(aErr ? t('offline') : t('loading'))}</p><button class="btn small" data-act="reload">${esc(t('retry'))}</button></div>`;
  const filters = `<div class="filters">
    <div><label for="fFrom">${esc(t('from'))}</label><input id="fFrom" type="date" value="${filt.from}"></div>
    <div><label for="fTo">${esc(t('to'))}</label><input id="fTo" type="date" value="${filt.to}"></div>
    <div class="f-user"><label for="fUser">${esc(t('worker'))}</label><select id="fUser"><option value="">${esc(t('all'))}</option>${A.users.map(u => `<option value="${u.id}"${filt.user === u.id ? ' selected' : ''}>${esc(u.label || u.name)}</option>`).join('')}</select></div>
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
      <td>${r.media.map(m => `<button type="button" class="mediabtn" data-act="media" data-id="${esc(m.id)}" data-url="${esc(m.url)}" title="${esc(m.name)}">${kindIcon(m.kind)}</button>`).join(' ')}</td></tr>`));
  } else {
    // People waiting for approval come first. Ticking "active" and saving approves them.
    const list = A.users.slice().sort((a, b) => (b.pending ? 1 : 0) - (a.pending ? 1 : 0));
    body = `${waiting ? `<p class="pill warn" style="white-space:normal;font-size:15px">${esc(t('approveHelp'))}</p>
      <button class="btn" style="margin:8px 0 14px" data-act="approveAll">✓ ${esc(t('approveAll'))} (${waiting})</button>` : ''}
      <div class="scroll"><table><thead><tr><th>${esc(t('workerNum'))}</th><th>${esc(t('nick'))}</th><th>${esc(t('name'))}</th><th>${esc(t('idnum'))}</th><th>${esc(t('phone'))}</th><th>${esc(t('role'))}</th><th>${esc(t('pin'))}</th><th>${esc(t('active'))}</th></tr></thead><tbody>
      ${list.map(u => `<tr data-id="${u.id}"${u.pending ? ' class="pending"' : ''}><td><input data-f="num" value="${esc(u.num)}" inputmode="numeric" style="width:70px"></td><td><input data-f="nick" value="${esc(u.nick || '')}" maxlength="30" style="width:110px"></td><td><input data-f="name" value="${esc(u.name)}"></td>
        <td><input data-f="idnum" value="${esc(u.idnum || '')}" maxlength="15" style="width:130px"></td><td><input data-f="phone" value="${esc(u.phone || '')}" inputmode="tel" maxlength="20" style="width:130px"></td>
        <td><select data-f="role">${['worker', 'leader', 'viewer', 'admin'].map(r => `<option value="${r}"${u.role === r ? ' selected' : ''}>${esc(t('role_' + r))}</option>`).join('')}</select></td>
        <td><input data-f="pin" value="${esc(u.pin)}" inputmode="numeric" maxlength="8" style="width:100px"></td>
        <td><span>${u.pending ? `<span class="pill warn">${esc(t('pendingBadge'))}</span> ` : ''}<input data-f="active" type="checkbox" style="width:22px;height:22px;vertical-align:middle"${u.active ? ' checked' : ''}></span></td></tr>`).join('')}
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

// ---------- dashboard: one day at a glance ----------
let D = null, dDay = dstr(new Date()), dBusy = false, dErr = false, dAt = '', dAbsOpen = false;
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return dstr(d); };
const openAdmin = () => adminTab === 'dash' ? loadDash(!!D) : loadAdmin();
async function loadDash(quiet) {
  const day = dDay;
  if (!quiet) { dBusy = true; render(); }
  try { const j = await api('admin', { from: addDays(day, -6), to: day }); if (j.ok) { if (day === dDay) { D = labelUsers(j); dAt = tnow(); } dErr = false; } else dErr = true; }
  catch (e) { dErr = true; }
  dBusy = false;
  if (view === 'admin' && adminTab === 'dash') render();
}
// One line per worker for the day. Own clock-in/out counts first; a team leader's report counts
// only for a worker who did not clock in, so nobody's hours are counted twice.
function dayStats(day) {
  const live = day === todayStr(), nowM = mins(tnow()), m = new Map();
  for (const r of attendanceRows(D, day, day, '')) {
    if (!m.has(r.userId)) m.set(r.userId, { id: r.userId, name: r.name, self: [], leader: [] });
    m.get(r.userId)[r.source].push(r);
  }
  const reps = D.reports.filter(r => r.date === day);
  const people = [...m.values()].map(p => {
    const rows = p.self.length ? p.self : p.leader, last = p.self[p.self.length - 1];
    const open = last && last.tin && !last.tout ? last : null, on = !!open && live;
    let hours = rows.reduce((a, r) => a + (r.hours || 0), 0);
    if (on) hours += Math.max(0, nowM - mins(open.tin)) / 60;
    return { id: p.id, name: p.name, on, hours, byLeader: !p.self.length ? rows[0].by : '',
      missing: p.self.some(r => !r.tin || (!r.tout && !(on && r === open))),
      tin: rows[0].tin, tout: on ? '' : rows[rows.length - 1].tout, loc: rows[0].lin,
      hasReport: reps.some(r => r.userId === p.id || r.crew.includes(p.id)) };
  }).sort((a, b) => (b.on - a.on) || a.name.localeCompare(b.name));
  const absent = D.users.filter(u => u.active && !u.pending && (u.role === 'worker' || u.role === 'leader') && !m.has(u.id));
  return { live, people, reps, absent, hours: people.reduce((a, p) => a + p.hours, 0) };
}
function vDash(waiting) {
  const today = todayStr(), rtl = lang !== 'th';
  const nav = `<div class="dnav"><button data-act="dStep" data-n="-1" aria-label="prev">${rtl ? '▶' : '◀'}</button>
    <input id="dDate" type="date" value="${dDay}" max="${today}">
    <button data-act="dStep" data-n="1" aria-label="next"${dDay >= today ? ' disabled' : ''}>${rtl ? '◀' : '▶'}</button>
    <button data-act="dToday"${dDay === today ? ' class="sel"' : ''}>${esc(t('today'))}</button></div>`;
  if (dBusy) return nav + `<div class="card muted">${esc(t('loading'))}</div>`;
  if (!D) return nav + `<div class="card"><p class="muted">${esc(dErr ? t('offline') : t('loading'))}</p><button class="btn small" data-act="dReload">${esc(t('retry'))}</button></div>`;
  const st = dayStats(dDay), onN = st.people.filter(p => p.on).length, missN = st.people.filter(p => p.missing).length;
  const noRep = st.people.filter(p => !p.on && !p.hasReport).length;
  const activeN = st.people.length + st.absent.length;
  const kpi = (n, label, sub, cls) => `<div class="kpi${cls ? ' ' + cls : ''}"><b>${n}</b><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  const kpis = `<div class="kpis">
    ${st.live ? kpi(onN, t('dNow'), '', onN ? 'on' : '') : kpi(missN, t('missingOut'), '', missN ? 'warn' : '')}
    ${kpi(st.people.length, t('dWorked'), `${t('dOf')} ${activeN} ${t('dActive')}`)}
    ${kpi(h2(st.hours), t('dHours'), st.live && onN ? t('dSoFar') : '')}
    ${kpi(st.reps.length, t('dReports'), noRep ? `${t('dNoReport')}: ${noRep}` : '', noRep ? 'warn' : '')}</div>`;
  const alerts = [
    waiting && S.user.role === 'admin' ? `<button class="pill warn" data-act="tab" data-tab="users">${esc(t('dWaiting'))}: ${waiting}</button>` : '',
    st.live && missN ? `<span class="pill bad">${esc(t('missingOut'))}: ${missN}</span>` : ''
  ].filter(Boolean).join(' ');
  const week = [6, 5, 4, 3, 2, 1, 0].map(i => { const d = addDays(dDay, -i), s = dayStats(d); return { d, n: s.people.length, h: s.hours }; });
  const maxH = Math.max(1, ...week.map(w => w.h));
  const wd = d => new Date(d + 'T12:00:00').toLocaleDateString(lang === 'th' ? 'th-TH' : lang === 'ar' ? 'ar' : 'he-IL', { weekday: 'narrow' });
  const chart = `<div class="card"><h2>${esc(t('dWeek'))}</h2><div class="week">${week.map(w => `<button data-act="dGo" data-d="${w.d}" class="${w.d === dDay ? 'sel' : ''}" title="${h2(w.h)} ${esc(t('hours'))}">
      <span class="n">${w.n || ''}</span><span class="bar" style="height:${Math.round(84 * w.h / maxH)}px"></span><span>${esc(wd(w.d))}</span><span>${w.d.slice(8)}.${w.d.slice(5, 7)}</span></button>`).join('')}</div>
    <div class="muted" style="margin-top:8px;font-size:13px">${esc(t('dWeekHelp'))}</div></div>`;
  const status = p => p.on ? `<span class="pill ok">● ${esc(t('dOn'))}</span>` : p.missing ? `<span class="pill bad">${esc(t('missingOut'))}</span>` : `<span class="pill">${esc(t('dDone'))}</span>`;
  const list = `<div class="card"><h2>${esc(t('dPeople'))} (${st.people.length})</h2>${st.people.length ? `<ul class="list plist">${st.people.map(p => `<li>
      <span><b>${esc(p.name)}</b> ${status(p)}<br><span class="muted">${p.tin || '--:--'} - ${p.tout || '--:--'}${p.byLeader ? ` · ${esc(t('srcLeader'))}: ${esc(p.byLeader)}` : ''} · ${locPill(p.loc)}
      ${p.on ? '' : ` · <span class="pill ${p.hasReport ? 'ok' : 'warn'}">${esc(t('dRep'))} ${p.hasReport ? '✓' : '✗'}</span>`}</span></span>
      <b class="hrs">${h2(p.hours)}</b></li>`).join('')}</ul>` : `<div class="muted">${esc(t('dNone'))}</div>`}
    ${st.absent.length ? `<details id="dAbs"${dAbsOpen ? ' open' : ''}><summary>${esc(t('dAbsent'))} (${st.absent.length})</summary><div class="muted">${st.absent.map(u => esc(u.label || u.name)).join(', ')}</div></details>` : ''}</div>`;
  const acts = new Map();
  for (const r of st.reps) {
    if (!acts.has(r.activity)) acts.set(r.activity, { n: 0, wh: 0, q: new Map() });
    const a = acts.get(r.activity), n = r.crew.length + r.extra; a.n += n; a.wh += r.hours * n;
    if (r.qty != null) a.q.set(r.unit, (a.q.get(r.unit) || 0) + r.qty);
  }
  const work = st.reps.length ? `<div class="card"><h2>${esc(t('dActs'))}</h2><ul class="list">${[...acts].map(([k, a]) => `<li>
      <span><b>${esc(t('act_' + k))}</b><br><span class="muted">${a.n} ${esc(t('workers'))}${[...a.q].map(([u, q]) => ` · ${q} ${esc(t('unit_' + u))}`).join('')}</span></span><b class="hrs">${h2(a.wh)}</b></li>`).join('')}</ul></div>` : '';
  const foot = `<div class="dfoot"><span class="muted">${esc(t('dUpdated'))} ${dAt}${st.live ? ' · ' + esc(t('dAuto')) : ''}${dErr ? ' · ' + esc(t('offline')) : ''}</span>
    <span><button class="btn small sec" data-act="dReload">⟳ ${esc(t('refresh'))}</button> <button class="btn small" data-act="dCsv">⬇ ${esc(t('dExport'))}</button></span></div>`;
  return nav + kpis + (alerts ? `<p>${alerts}</p>` : '') + list + work + chart + foot;
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
  go(el) { view = el.dataset.view; render(); window.scrollTo(0, 0); if (view === 'admin') openAdmin(); else sync(); },
  tab(el) { adminTab = el.dataset.tab; render(); window.scrollTo(0, 0); if (adminTab === 'dash') loadDash(!!D); else if (!A) loadAdmin(); },
  dStep(el) { const d = addDays(dDay, +el.dataset.n); if (d > todayStr()) return; dDay = d; loadDash(); },
  dGo(el) { if (el.dataset.d === dDay) return; dDay = el.dataset.d; loadDash(); },
  dToday() { dDay = todayStr(); loadDash(); },
  dReload() { loadDash(!!D && !dErr); },
  dCsv() {
    const st = dayStats(dDay);
    downloadCsv(`day_${dDay}.csv`, ['date', 'worker', 'in', 'out', 'hours', 'status', 'dRep', 'location', 'source'].map(t),
      st.people.map(p => [dshow(dDay), p.name, p.tin, p.tout, h2(p.hours), t(p.on ? 'dOn' : p.missing ? 'missingOut' : 'dDone'), p.hasReport ? '✓' : '', locText(p.loc), p.byLeader ? t('srcLeader') + ': ' + p.byLeader : t('srcSelf')]));
  },
  reload() { loadAdmin(); },
  async punch(el) {
    el.disabled = true; $('#gpsmsg').textContent = t('locating');
    const type = el.dataset.type, date = dstr(new Date()), time = tnow();   // the time of the tap, not of the GPS answer
    const pos = await getPos();
    const rec = { type, date, time, ...pos };
    const id = uid();
    S.punches.push({ ...rec, id, userId: S.user.id });
    queue('punch', rec, id);
    if (type === 'out' && !todayReport()) { view = 'report'; window.scrollTo(0, 0); }   // the day's report is filled in at clock-out
    render();
    toast(`${t(type === 'in' ? 'savedIn' : 'savedOut')} · ${t(pos.lat == null ? (posDenied ? 'gpsDenied' : 'noGps') : 'withLoc')}`);
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
    A.users.push({ id: uid(), num: String(next), name: '', role: 'worker', pin: newPin(), active: true, pending: false, idnum: '', phone: '' }); render();
  },
  // Ticks "active" for everyone who is waiting and saves, after one confirmation.
  async approveAll() {
    const rows = $$('tbody tr.pending');
    if (!rows.length || !confirm(`${t('approveAll')}? (${rows.length})`)) return;
    rows.forEach(tr => { const c = $('[data-f="active"]', tr); if (c) c.checked = true; });
    await actions.saveUsers();
  },
  async saveUsers() {
    readUsers();
    try {
      // Every row is sent: one whose name was cleared is deleted by the server.
      const j = await api('saveUsers', { users: A.users });
      if (j.ok) { A.users = labelUsers(j).users; render(); toast(t('saved')); }
      else toast(t({ dup_num: 'dupNum', dup_id: 'dupId', need_admin: 'needAdmin' }[j.error] || 'serverErr'));
    } catch (e) { toast(t('offline')); }
  },
  // A manager opens a photo, video or recording from a work report inside the app. The server reads the file
  // from Drive, so no Google account or Drive permission is needed on the manager's phone.
  async media(el) {
    let box = $('#viewer');
    if (!box) { box = document.createElement('div'); box.id = 'viewer'; document.body.appendChild(box); box.addEventListener('click', e => { if (e.target === box || e.target.dataset.close) actions.closeMedia(); }); }
    box.innerHTML = `<div class="vmsg">${esc(t('loadingFile'))}</div>`; box.hidden = false;
    try {
      const j = await api('media', { id: el.dataset.id });
      if (box.hidden) return;
      if (!j.ok) { box.innerHTML = `<div class="vmsg">${esc(t('serverErr'))}</div><button class="vclose" data-close="1">✕</button>`; return; }
      if (j.big) { actions.closeMedia(); window.open(j.url || el.dataset.url, '_blank', 'noopener'); return; }
      const bin = atob(j.data), buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([buf], { type: j.mime || 'application/octet-stream' }));
      box.dataset.url = url;
      const tag = (j.mime || '').startsWith('video') ? `<video src="${url}" controls autoplay playsinline></video>` : (j.mime || '').startsWith('audio') ? `<audio src="${url}" controls autoplay></audio>` : `<img src="${url}" alt="">`;
      box.innerHTML = `${tag}<div class="vname">${esc(j.name || '')}</div><button class="vclose" data-close="1">✕</button>`;
    } catch (e) { box.innerHTML = `<div class="vmsg">${esc(t('offline'))}</div><button class="vclose" data-close="1">✕</button>`; }
  },
  closeMedia() { const box = $('#viewer'); if (!box) return; if (box.dataset.url) { URL.revokeObjectURL(box.dataset.url); delete box.dataset.url; } box.innerHTML = ''; box.hidden = true; },
  showReg() { regMode = true; regDone = false; render(); },
  hideReg() { regMode = false; render(); }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  actions[el.dataset.act]?.(el);
});
document.addEventListener('change', e => {
  if (e.target.id === 'langSel') { lang = e.target.value; localStorage.setItem('fr_lang', lang); render(); renderInstall(); }
  if (e.target.id === 'dDate') { const v = e.target.value; if (v && v <= todayStr()) { dDay = v; loadDash(); } else render(); }
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
        localStorage.setItem('fr_lastid', $('#num').value.trim()); regDone = false;
        S.token = j.token; applyState(j.state); persist();
        view = isMgr() ? 'admin' : 'home'; render();
        if (view === 'admin' && (S.consent || noSelf())) openAdmin();
        sync(); return;
      }
      toast(t({ locked: 'locked', bad_login: 'badLogin', pending: 'pendingMsg' }[j.error] || 'serverErr'));
    } catch (err) { toast(t('offline')); }
    btn.disabled = false; $('#pin').value = '';
  }
  if (e.target.id === 'regForm') {
    if ($('#gPin').value !== $('#gPin2').value) return toast(t('pinMismatch'));
    const btn = $('#regBtn'); btn.disabled = true;
    try {
      const idnum = $('#gId').value.trim();
      const j = await api('register', { name: $('#gName').value.trim(), idnum, phone: $('#gPhone').value.trim(), pin: $('#gPin').value, lang });
      if (j.ok) { localStorage.setItem('fr_lastid', idnum); regMode = false; regDone = j.approved ? 'now' : true; render(); window.scrollTo(0, 0); return; }
      toast(t({ invalid: 'regInvalid', exists: 'regExists' }[j.error] || 'serverErr'));
    } catch (err) { toast(t('offline')); }
    btn.disabled = false;
  }
  if (e.target.id === 'repForm') {
    const start = $('#rStart').value, end = $('#rEnd').value, brk = parseInt($('#rBreak').value, 10) || 0;
    const m = mins(end) - mins(start) - brk;
    if (mins(end) <= mins(start)) return toast(t('badTimes'));
    if (m <= 0) return toast(t('breakTooLong'));
    const single = S.user.role === 'worker';
    const crew = single ? [S.user.id] : $$('input[name=crew]:checked').map(i => i.value);
    // The form asks for the total number of workers; names ticked in the list are part of that total.
    const total = single ? 1 : Math.max(parseInt($('#rTotal').value, 10) || 0, crew.length);
    const extra = total - crew.length;
    if (total < 1) return toast(t('noCrew'));
    const btn = $('#sendBtn'); btn.disabled = true; btn.textContent = t('locating');
    const rec = {
      date: todayReport() ? todayReport().date : todayStr(), activity: $('#rAct').value, crew, extra, start, end, breakMin: brk, hours: m / 60,
      qty: $('#rQty').value === '' ? null : parseFloat($('#rQty').value), unit: $('#rUnit').value, notes: $('#rNotes').value.trim()
    };
    rec.loc = await getPos();
    const prev = todayReport();
    const id = prev ? prev.id : uid(), files = pending; pending = [];
    rec.reportId = id; rec.edit = !!prev;
    for (const a of files) await mediaPut(a.id, a.blob);
    const media = ((prev && prev.media) || []).concat(files.map(a => ({ id: a.id, name: a.name, kind: a.kind, url: '' })));
    S.reports = S.reports.filter(r => r.id !== id).concat([{ ...rec, id, userId: S.user.id, media }]);
    // an earlier version of today's report that was not sent yet is replaced by this one
    S.outbox = S.outbox.filter(o => !(o.op === 'report' && o.userId === S.user.id && (o.rec.reportId || o.id) === id));
    for (const a of files) S.outbox.push({ op: 'media', id: a.id, userId: S.user.id, rec: { reportId: id, name: a.name, kind: a.kind, mime: a.blob.type } });
    queue('report', rec);
    view = 'mine'; render(); window.scrollTo(0, 0);
    toast(navigator.onLine ? t('sent') : t('savedOffline'));
  }
});

// The dashboard refreshes by itself once a minute while it is on screen.
setInterval(() => { if (S.user && view === 'admin' && adminTab === 'dash' && D && !dBusy && !document.hidden) loadDash(true); }, 60000);
document.addEventListener('toggle', e => { if (e.target.id === 'dAbs') dAbsOpen = e.target.open; }, true);

// ---------- install to home screen ----------
// Shown as the first thing on every visit until the app is installed. A browser only lets a page
// open its install dialog after a tap, so the screen has one big button. iPhones have no install
// dialog at all, so there the screen explains the two taps in Safari.
let installEvt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
function renderInstall() {
  const el = $('#install');
  const skipped = (() => { try { return sessionStorage.getItem('fr_install_skip'); } catch (e) { return null; } })();
  const show = !isStandalone() && !skipped && (installEvt || isIos());
  el.hidden = !show;
  el.innerHTML = !show ? '' : `<div class="card">
    <img src="icon.svg" alt="" width="84" height="84">
    <h2>${esc(t('installTitle'))}</h2>
    <p>${esc(t(installEvt ? 'installText' : 'installIos'))}</p>
    ${installEvt ? `<button class="btn" data-act="install">${esc(t('installBtn'))}</button>` : ''}
    <button class="btn sec" data-act="skipInstall">${esc(t('installSkip'))}</button></div>`;
}
actions.install = async () => {
  if (!installEvt) return;
  installEvt.prompt();
  try { await installEvt.userChoice; } catch (e) { /* dialog closed */ }
  installEvt = null; renderInstall();
};
actions.skipInstall = () => { try { sessionStorage.setItem('fr_install_skip', '1'); } catch (e) { /* private mode */ } renderInstall(); };
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; renderInstall(); });
window.addEventListener('appinstalled', () => { installEvt = null; renderInstall(); });

window.addEventListener('online', sync);
setInterval(() => { if (myOutbox().length) sync(); }, 60000);
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
render();
renderInstall();
if (S.token) { if (view === 'admin') openAdmin(); sync(); }
