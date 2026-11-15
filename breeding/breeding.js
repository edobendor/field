/* Ben Dor breeding evaluations: one short form per variety code, kept on the phone until it is sent.
   Two stages: the mother tree in the breeding block (few fields) and the grafted trees (more fields).
   It has its own users, grouped in teams (Ben Dor, Cultirex...). A team sees only its own records;
   a manager sees every team. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dstr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dshow = s => String(s || '').split('-').reverse().join('.');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
const API = (window.FR_CONFIG && window.FR_CONFIG.apiUrl) || '../api';
const MOCK = API === '../api';
// 7C-07-10, 07C07-10 and 7c 7 10 are the same variety: letters and numbers are compared without zeros and separators
const ckey = s => (String(s || '').toUpperCase().match(/[A-Z]+|\d+/g) || []).map(t => /^\d+$/.test(t) ? String(parseInt(t, 10)) : t).join('-');

// ---------- languages ----------
const L = {
  he: {
    title: 'בן דור - טיפוח', loginTitle: 'כניסה', user: 'שם משתמש', pin: 'קוד אישי', login: 'כניסה', logout: 'יציאה',
    badLogin: 'שם משתמש או קוד שגויים', locked: 'המשתמש ננעל. פנה למנהל.', offline: 'אין חיבור לשרת', allTeams: 'כל הצוותים',
    code: 'קוד זן', open: 'פתח', recent: 'הערכות אחרונות', none: 'אין עדיין הערכות', evals: 'הערכות', typeCode: 'הקלד קוד זן',
    back: 'חזרה', backNoSave: 'חזרה בלי לשמור', newEval: '+ הערכה חדשה', history: 'היסטוריה',
    noneFor: 'אין עדיין הערכות לקוד הזה. אם הקוד קיים בכתיב אחר, בדוק ברשימה במסך הראשי.',
    stage: 'שלב', mother: 'עץ אם', graft: 'מורכב', when: 'מועד ההערכה', harvest: 'בקטיף', storage: 'אחרי קירור',
    dHarvest: 'תאריך קטיף', dStorage: 'תאריך הוצאה מקירור', photos: 'תמונות', addPhoto: '📷 צלם או בחר תמונות',
    decision: 'החלטה (לא חובה)', d_keep: 'להמשיך לעקוב', d_graft: 'להרכיב', d_advance: 'לקדם', d_discard: 'לפסול', save: 'שמור',
    saved: 'נשמר', savedOffline: 'נשמר בטלפון, יישלח כשתהיה קליטה', nothing: 'אין מה לשמור: הוסף תמונה או נתון אחד לפחות',
    badValue: 'ערך לא סביר', badPhoto: 'לא ניתן לקרוא את התמונה',
    f_plot: 'מיקום', ph_plot: 'אתר / חלקה / שורה', f_size: 'גודל פרי (מ"מ)', f_sizeClass: 'מיון גודל', ph_sizeClass: 'למשל A/AA/B', f_brix: 'בריקס', f_firm: 'מוצקות (ק"ג)',
    f_yield: 'צפי יבול', h_yield: '1 = נמוך · 3 = בינוני · 5 = גבוה מאוד', f_taste: 'טעם',
    h_taste: 'כיול: 4 = African Rose · 6 = Laetitia · 8 = Ruby Sun · 10 = Flavor King', f_tasteNote: 'תיאור טעם ומרקם', ph_tasteNote: 'למשל: פריך, ארומטי, חמצמץ ליד הקליפה',
    f_skin: 'צבע קליפה', f_flesh: 'צבע ציפה', f_fruitSet: 'חנטה', h_fruitSet: '1 = דלה · 5 = שופעת', f_tree: 'עץ', ph_tree: 'עוצמה, בריאות, צורת גידול',
    f_bloom: 'פריחה', ph_bloom: 'פריחה מלאה יחד עם...', f_weeks: 'שבועות בקירור', f_shrivel: 'כמישה', f_ib: 'השחמה פנימית',
    f_pos: 'יתרונות', f_neg: 'חסרונות', f_note: 'הערות',
    c_R: 'אדום', c_P: 'סגול', c_B: 'שחור', c_Y: 'צהוב', c_G: 'ירוק', c_O: 'כתום', c_M: 'מנומר', c_W: 'לבן', c_RY: 'אדום-צהוב',
    l_none: 'אין', l_light: 'קלה', l_heavy: 'משמעותית',
    n_size: 'גודל', n_mm: 'מ"מ', n_yield: 'יבול', n_weeks: 'שבועות קירור', n_firm: 'מוצקות', n_set: 'חנטה'
  },
  en: {
    title: 'Ben Dor - Breeding', loginTitle: 'Sign in', user: 'User name', pin: 'Personal code', login: 'Sign in', logout: 'Sign out',
    badLogin: 'Wrong user name or code', locked: 'This user is locked. Contact the manager.', offline: 'No connection to the server', allTeams: 'All teams',
    code: 'Variety code', open: 'Open', recent: 'Recent evaluations', none: 'No evaluations yet', evals: 'evaluations', typeCode: 'Type a variety code',
    back: 'Back', backNoSave: 'Back without saving', newEval: '+ New evaluation', history: 'History',
    noneFor: 'No evaluations for this code yet. If the code exists in another spelling, check the list on the main screen.',
    stage: 'Stage', mother: 'Mother tree', graft: 'Grafted', when: 'Evaluation time', harvest: 'At harvest', storage: 'After cold storage',
    dHarvest: 'Harvest date', dStorage: 'Date out of cold storage', photos: 'Photos', addPhoto: '📷 Take or choose photos',
    decision: 'Decision (optional)', d_keep: 'Keep following', d_graft: 'Graft', d_advance: 'Advance', d_discard: 'Discard', save: 'Save',
    saved: 'Saved', savedOffline: 'Saved on the phone, will be sent when there is reception', nothing: 'Nothing to save: add a photo or at least one value',
    badValue: 'value out of range', badPhoto: 'The photo could not be read',
    f_plot: 'Location', ph_plot: 'Site / block / row', f_size: 'Fruit size (mm)', f_sizeClass: 'Size classes', ph_sizeClass: 'e.g. A/AA/B', f_brix: 'Brix', f_firm: 'Pressure (kg)',
    f_yield: 'Yield expectation', h_yield: '1 = low · 3 = medium · 5 = very high', f_taste: 'Taste',
    h_taste: 'Calibration: 4 = African Rose · 6 = Laetitia · 8 = Ruby Sun · 10 = Flavor King', f_tasteNote: 'Taste and texture', ph_tasteNote: 'e.g. crunchy, aromatic, acidic under the skin',
    f_skin: 'Skin colour', f_flesh: 'Flesh colour', f_fruitSet: 'Fruit set', h_fruitSet: '1 = poor · 5 = abundant', f_tree: 'Tree', ph_tree: 'Vigour, health, growth habit',
    f_bloom: 'Bloom', ph_bloom: 'Full bloom together with...', f_weeks: 'Weeks in cold storage', f_shrivel: 'Shrivel', f_ib: 'Internal browning',
    f_pos: 'Positives', f_neg: 'Negatives', f_note: 'Notes',
    c_R: 'Red', c_P: 'Purple', c_B: 'Black', c_Y: 'Yellow', c_G: 'Green', c_O: 'Orange', c_M: 'Dapple', c_W: 'White', c_RY: 'Red-yellow',
    l_none: 'None', l_light: 'Light', l_heavy: 'Significant',
    n_size: 'Size', n_mm: 'mm', n_yield: 'Yield', n_weeks: 'weeks stored', n_firm: 'Pressure', n_set: 'Set'
  }
};
let lang = localStorage.getItem('br_lang') || '';
const t = k => (L[lang || 'he'][k]) ?? L.he[k] ?? k;

function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 3000);
}

// ---------- what is asked at each stage ----------
const STAGES = ['mother', 'graft'], KINDS = ['harvest', 'storage'], LEVELS = ['none', 'light', 'heavy'];
const FIELDS = {
  plot: { t: 'text' }, size: { t: 'num', step: '1', min: 15, max: 120 }, sizeClass: { t: 'text' },
  brix: { t: 'num', step: '0.1', min: 4, max: 35 }, firm: { t: 'num', step: '0.1', min: 0, max: 15 },
  yield: { t: 'scale', n: 5 }, taste: { t: 'scale', n: 10 }, tasteNote: { t: 'text' },
  skin: { t: 'chips', opts: ['R', 'P', 'B', 'Y', 'G', 'O', 'M'], pre: 'c_' }, flesh: { t: 'chips', opts: ['R', 'Y', 'O', 'W', 'G', 'RY'], pre: 'c_' },
  fruitSet: { t: 'scale', n: 5 }, tree: { t: 'text' }, bloom: { t: 'text' },
  weeks: { t: 'num', step: '1', min: 0, max: 40 }, shrivel: { t: 'chips', opts: LEVELS, pre: 'l_' }, ib: { t: 'chips', opts: LEVELS, pre: 'l_' },
  pos: { t: 'text' }, neg: { t: 'text' }, note: { t: 'text' }
};
const LAYOUT = {
  'mother/harvest': ['size', 'brix', 'yield', 'taste', 'tasteNote', 'note'],
  'mother/storage': ['weeks', 'brix', 'taste', 'shrivel', 'ib', 'note'],
  'graft/harvest': ['plot', 'size', 'sizeClass', 'brix', 'firm', 'yield', 'taste', 'tasteNote', 'skin', 'flesh', 'fruitSet', 'tree', 'bloom', 'pos', 'neg', 'note'],
  'graft/storage': ['plot', 'weeks', 'brix', 'firm', 'taste', 'tasteNote', 'shrivel', 'ib', 'pos', 'neg', 'note']
};
const DECISIONS = { mother: ['keep', 'graft', 'discard'], graft: ['keep', 'advance', 'discard'] };

// ---------- state ----------
const LS = 'br_state_v2' + (MOCK ? '_mock' : '');
const EMPTY = { token: null, me: null, team: '', codes: [], cache: {}, evals: [], photos: [] };
let B = (() => { try { return Object.assign({}, EMPTY, JSON.parse(localStorage.getItem(LS))); } catch (e) { return { ...EMPTY }; } })();
const persist = () => localStorage.setItem(LS, JSON.stringify(B));
let view = 'home', cur = '', busy = false;
let form = null;      // { code, stage, kind, date, vals, decision, photos: [{id, blob, thumb}] }
const myTeam = () => (B.me && B.me.admin ? B.team : '') || (B.me && B.me.team) || '';
const tkey = (team, code) => team + '|' + ckey(code);

// ---------- photo storage on the phone ----------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('br_media', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('m');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function mtx(mode, fn) { const db = await idb(); return new Promise((res, rej) => { const q = fn(db.transaction('m', mode).objectStore('m')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
const mput = (id, blob) => mtx('readwrite', s => s.put(blob, id));
const mget = id => mtx('readonly', s => s.get(id));
const mdel = id => mtx('readwrite', s => s.delete(id));
const toB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
// A phone photo is 4-10 MB. It is reduced to about 1600 px for the archive, plus a tiny preview kept in the sheet.
async function scaled(file, max, q) {
  const img = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, 'image/jpeg', q));
}

// ---------- server ----------
async function api(action, payload = {}) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, btoken: B.token, ...payload }) });
  const j = await r.json();
  if (j.error === 'auth' && action !== 'blogin') { B.token = null; B.me = null; persist(); render(); throw new Error('auth'); }
  return j;
}
const waiting = () => B.evals.length + B.photos.length;
// what was just sent stays visible in the variety's history even before the server copy is read again
function keep(team, code, list, rec) { const k = tkey(team, code), c = B.cache[k] || (B.cache[k] = { evals: [], photos: [] }); if (!c[list].some(x => x.id === rec.id)) c[list].push(rec); }
async function sync() {
  if (busy || !B.token || !waiting()) return;
  busy = true; renderTop();
  try {
    if (B.evals.length) {
      const j = await api('bsave', { evals: B.evals });
      if (j.ok) { B.evals.filter(e => j.done.includes(e.id)).forEach(e => keep(e.team, e.code, 'evals', e)); B.evals = B.evals.filter(e => !j.done.includes(e.id)); persist(); }
    }
    for (const p of B.photos.slice()) {          // one photo per request keeps each upload small
      const blob = await mget(p.id);
      if (!blob) { B.photos = B.photos.filter(x => x.id !== p.id); persist(); continue; }
      const j = await api('bsave', { photos: [{ ...p, mime: blob.type, data: await toB64(blob) }] });
      if (!j.ok) break;
      keep(p.team, p.code, 'photos', p); B.photos = B.photos.filter(x => x.id !== p.id); persist(); await mdel(p.id); renderTop();
    }
  } catch (e) { /* no reception: everything stays on the phone and is sent later */ }
  busy = false; renderTop();
  if (view === 'card') { render(); loadCode(cur); }
  if (!waiting()) loadCodes();
}
async function loadCodes() {
  try { const j = await api('bcodes', { team: myTeam() }); if (j.ok) { B.codes = j.codes; persist(); if (view === 'home') drawRecent(); } } catch (e) { /* offline */ }
}
async function loadCode(code) {
  const team = myTeam();
  try {
    const j = await api('bget', { code, team });
    if (j.ok) {
      B.cache[tkey(team, code)] = { evals: j.evals, photos: j.photos };
      const ks = Object.keys(B.cache); while (ks.length > 40) delete B.cache[ks.shift()];
      persist(); if (view === 'card' && ckey(cur) === ckey(code)) render();
    }
  } catch (e) { /* offline: the copy kept on the phone is shown */ }
}

// ---------- screens ----------
function renderTop() {
  const n = waiting();
  $('#top').innerHTML = `<div class="title">${esc(t('title'))}</div><div class="right">
    ${B.token ? `<button data-act="sync">${busy ? '⟳' : n ? '⏳ ' + n : '✓'}</button>` : ''}
    <select id="langSel" aria-label="language"><option value="he"${(lang || 'he') === 'he' ? ' selected' : ''}>עברית</option><option value="en"${lang === 'en' ? ' selected' : ''}>English</option></select>
    ${B.token ? `<button data-act="logout">${esc(t('logout'))}</button>` : ''}</div>`;
}
function render() {
  document.documentElement.lang = lang || 'he';
  document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
  document.title = t('title');
  renderTop();
  const app = $('#app');
  if (!B.token) { app.innerHTML = vLogin(); return; }
  app.innerHTML = ({ home: vHome, card: vCard, form: vForm })[view]();
  if (view === 'form') drawPhotos();
}
function vLogin() {
  return `<form id="loginForm" class="card"><h2>${esc(t('loginTitle'))}</h2>
    <label for="lUser">${esc(t('user'))}</label><input id="lUser" autocomplete="username" autocapitalize="none" value="${esc(localStorage.getItem('br_lastuser') || '')}" required>
    <label for="lPin">${esc(t('pin'))}</label><input id="lPin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="8" required>
    <button class="btn" id="loginBtn">${esc(t('login'))}</button></form>`;
}
function vHome() {
  const teams = B.me.admin && B.me.teams && B.me.teams.length > 1
    ? `<select id="teamSel" style="margin-bottom:12px">${B.me.teams.map(x => `<option${myTeam() === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>` : '';
  return `${teams}<div class="card"><h2>${esc(t('code'))}</h2>
    <form id="find"><input id="code" class="codein" autocomplete="off" autocapitalize="characters" placeholder="${myTeam() === 'Cultirex' ? '07C07-10' : 'AS-5-13-68'}">
    <button class="btn">${esc(t('open'))}</button></form></div>
  <div class="card"><h2>${esc(t('recent'))}</h2><div id="recent">${recentHtml()}</div></div>`;
}
function recentHtml() {
  const q = ckey($('#code') ? $('#code').value : '');
  const list = B.codes.filter(c => c.team === myTeam() && (!q || ckey(c.code).includes(q))).slice(0, 40);
  return list.length ? `<ul class="list">${list.map(c => `<li data-act="open" data-code="${esc(c.code)}" style="cursor:pointer"><span><span class="code">${esc(c.code)}</span><br><span class="muted">${dshow(c.last)} · ${esc(t(c.stage))} · ${c.n} ${esc(t('evals'))}</span></span>
    ${c.decision ? `<span class="pill ${c.decision === 'discard' ? 'bad' : 'ok'}">${esc(t('d_' + c.decision))}</span>` : ''}</li>`).join('')}</ul>` : `<div class="muted">${esc(t('none'))}</div>`;
}
function drawRecent() { const el = $('#recent'); if (el) el.innerHTML = recentHtml(); }

// everything known about one code: what the server has plus what is still waiting on this phone
function history(code) {
  const team = myTeam(), k = ckey(code), c = B.cache[tkey(team, code)] || { evals: [], photos: [] };
  const mine = x => x.team === team && ckey(x.code) === k;
  const evals = c.evals.concat(B.evals.filter(e => mine(e) && !c.evals.some(x => x.id === e.id)).map(e => ({ ...e, local: true })));
  const photos = c.photos.concat(B.photos.filter(p => mine(p) && !c.photos.some(x => x.id === p.id)).map(p => ({ ...p, local: true })));
  const key = e => e.date + (e.kind === 'storage' ? '1' : '0');
  return { evals: evals.sort((a, b) => key(b).localeCompare(key(a))), photos };
}
function nums(e) {
  const out = [], has = k => e[k] != null && e[k] !== '';
  if (has('size')) out.push(`${esc(t('n_size'))} <b>${esc(e.size)}</b> ${esc(t('n_mm'))}`);
  if (has('sizeClass')) out.push(`<b>${esc(e.sizeClass)}</b>`);
  if (has('brix')) out.push(`${esc(t('f_brix'))} <b>${esc(e.brix)}</b>`);
  if (has('firm')) out.push(`${esc(t('n_firm'))} <b>${esc(e.firm)}</b>`);
  if (has('yield')) out.push(`${esc(t('n_yield'))} <b>${esc(e.yield)}</b>/5`);
  if (has('taste')) out.push(`${esc(t('f_taste'))} <b>${esc(e.taste)}</b>/10`);
  if (has('fruitSet')) out.push(`${esc(t('n_set'))} <b>${esc(e.fruitSet)}</b>/5`);
  if (has('weeks')) out.push(`<b>${esc(e.weeks)}</b> ${esc(t('n_weeks'))}`);
  if (has('shrivel')) out.push(`${esc(t('f_shrivel'))}: <b>${esc(t('l_' + e.shrivel))}</b>`);
  if (has('ib')) out.push(`${esc(t('f_ib'))}: <b>${esc(t('l_' + e.ib))}</b>`);
  if (has('skin')) out.push(`${esc(t('f_skin'))}: ${esc(t('c_' + e.skin))}`);
  if (has('flesh')) out.push(`${esc(t('f_flesh'))}: ${esc(t('c_' + e.flesh))}`);
  return out.join(' · ');
}
function vCard() {
  const h = history(cur);
  const texts = e => ['plot', 'tasteNote', 'tree', 'bloom', 'pos', 'neg', 'note'].filter(k => e[k]).map(k => `<div><span class="muted">${esc(t('f_' + k))}:</span> ${esc(e[k])}</div>`).join('');
  return `<button class="back" data-act="home">${esc(t('back'))}</button>
  <div class="card"><h2 class="code" style="font-size:26px;text-align:center">${esc(cur)}</h2>
    <button class="btn" data-act="new">${esc(t('newEval'))}</button></div>
  <div class="card"><h2>${esc(t('history'))} (${h.evals.length})</h2>
    ${h.evals.length ? h.evals.map(e => `<div class="ev"><div class="h"><span>${dshow(e.date)} · ${esc(t(e.stage))} · ${esc(t(e.kind))}${e.local ? ' ⏳' : ''}</span>
      ${e.decision ? `<span class="pill ${e.decision === 'discard' ? 'bad' : 'ok'}">${esc(t('d_' + e.decision))}</span>` : ''}</div>
      <div class="nums">${nums(e)}</div>${texts(e)}
      <div class="muted" style="font-size:13px">${esc(e.evaluator || '')}</div>
      <div class="thumbs">${h.photos.filter(p => p.evalId === e.id).map(p => `<img src="data:image/jpeg;base64,${p.thumb}" data-act="zoom" data-id="${p.id}" data-local="${p.local ? 1 : ''}" alt="">`).join('')}</div></div>`).join('')
    : `<div class="muted">${esc(t('noneFor'))}</div>`}</div>`;
}
function fieldHtml(k) {
  const f = FIELDS[k], v = form.vals[k] ?? '';
  let inner;
  if (f.t === 'num') inner = `<input data-f="${k}" type="number" inputmode="decimal" step="${f.step}" value="${esc(v)}">`;
  else if (f.t === 'text') inner = `<input data-f="${k}" value="${esc(v)}" placeholder="${esc(L[lang || 'he']['ph_' + k] || '')}" maxlength="300">`;
  else if (f.t === 'scale') inner = `<div class="scale n${f.n}">${Array.from({ length: f.n }, (_, i) => `<button type="button" data-act="pick" data-f="${k}" data-v="${i + 1}" class="${String(v) === String(i + 1) ? 'sel' : ''}">${i + 1}</button>`).join('')}</div>`;
  else inner = `<div class="chips">${f.opts.map(o => `<button type="button" data-act="pick" data-f="${k}" data-v="${o}" class="${v === o ? 'sel' : ''}">${esc(t(f.pre + o))}</button>`).join('')}</div>`;
  const hint = L[lang || 'he']['h_' + k];
  return `<label>${esc(t('f_' + k))}</label>${inner}${hint ? `<div class="hint">${esc(hint)}</div>` : ''}`;
}
function vForm() {
  const seg = (name, list, val) => `<div class="seg">${list.map(k => `<button type="button" data-act="seg" data-name="${name}" data-v="${k}" class="${val === k ? 'sel' : ''}">${esc(t(k))}</button>`).join('')}</div>`;
  return `<button class="back" data-act="card">${esc(t('backNoSave'))}</button>
  <form id="evalForm" class="card"><h2 class="code">${esc(form.code)}</h2>
    <label>${esc(t('stage'))}</label>${seg('stage', STAGES, form.stage)}
    <label>${esc(t('when'))}</label>${seg('kind', KINDS, form.kind)}
    <label for="fDate">${esc(t(form.kind === 'harvest' ? 'dHarvest' : 'dStorage'))}</label><input id="fDate" type="date" value="${form.date}" max="${dstr(new Date())}">
    <label>${esc(t('photos'))}</label>
    <button type="button" class="btn sec" data-act="addPhoto" style="margin-top:0">${esc(t('addPhoto'))}</button>
    <input id="fFiles" type="file" accept="image/*" multiple hidden>
    <div id="fThumbs" class="thumbs"></div>
    ${LAYOUT[form.stage + '/' + form.kind].map(fieldHtml).join('')}
    <label>${esc(t('decision'))}</label><div class="chips">${DECISIONS[form.stage].map(k => `<button type="button" data-act="decide" data-v="${k}" class="${form.decision === k ? 'sel' : ''}">${esc(t('d_' + k))}</button>`).join('')}</div>
    <button class="btn" id="saveBtn">${esc(t('save'))}</button></form>`;
}
function drawPhotos() {
  const el = $('#fThumbs'); if (!el) return;
  el.innerHTML = form.photos.map(p => `<div class="t"><img src="data:image/jpeg;base64,${p.thumb}" alt=""><button type="button" class="x" data-act="rmPhoto" data-id="${p.id}">✕</button></div>`).join('');
}
function readForm() {
  if (!form || !$('#evalForm')) return;
  $$('#evalForm [data-f]').forEach(i => { if (i.tagName === 'INPUT') form.vals[i.dataset.f] = i.value.trim(); });
  form.date = $('#fDate').value || form.date;
}
function openCode(code) {
  code = String(code || '').trim().toUpperCase().replace(/\s+/g, '-');
  if (!ckey(code)) return toast(t('typeCode'));
  const known = B.codes.find(c => c.team === myTeam() && ckey(c.code) === ckey(code));   // keep one spelling per variety
  cur = known ? known.code : code; view = 'card'; render(); window.scrollTo(0, 0); loadCode(cur);
}

// ---------- actions ----------
const actions = {
  sync() { sync(); },
  logout() { if (waiting() && !confirm('⏳ ' + waiting())) return; B = { ...EMPTY, evals: B.evals, photos: B.photos }; persist(); view = 'home'; render(); },
  home() { view = 'home'; render(); loadCodes(); },
  card() { view = 'card'; form = null; render(); },
  open(el) { openCode(el.dataset.code); },
  new() {
    const last = history(cur).evals[0];
    form = { code: cur, stage: last ? last.stage : 'mother', kind: 'harvest', date: dstr(new Date()), vals: {}, decision: '', photos: [] };
    if (last && last.plot) form.vals.plot = last.plot;
    view = 'form'; render(); window.scrollTo(0, 0);
  },
  seg(el) { readForm(); form[el.dataset.name] = el.dataset.v; if (el.dataset.name === 'stage') form.decision = ''; render(); },
  pick(el) { readForm(); const k = el.dataset.f; form.vals[k] = form.vals[k] === el.dataset.v ? '' : el.dataset.v; $$(`[data-act=pick][data-f="${k}"]`).forEach(b => b.classList.toggle('sel', b.dataset.v === form.vals[k])); },
  decide(el) { form.decision = form.decision === el.dataset.v ? '' : el.dataset.v; $$('[data-act=decide]').forEach(b => b.classList.toggle('sel', b.dataset.v === form.decision)); },
  addPhoto() { $('#fFiles').click(); },
  rmPhoto(el) { form.photos = form.photos.filter(p => p.id !== el.dataset.id); drawPhotos(); },
  async zoom(el) {
    const v = $('#view'); v.hidden = false; v.innerHTML = `<img src="${el.src}" alt="">`;
    try {
      let src = '';
      if (el.dataset.local) { const b = await mget(el.dataset.id); if (b) src = URL.createObjectURL(b); }
      else { const j = await api('bphoto', { id: el.dataset.id }); if (j.ok) src = `data:${j.mime};base64,${j.data}`; }
      if (src && !v.hidden) v.innerHTML = `<img src="${src}" alt="">`;
    } catch (e) { /* offline: the small preview stays */ }
  }
};
document.addEventListener('click', e => {
  if (e.target.closest('#view')) { $('#view').hidden = true; $('#view').innerHTML = ''; return; }
  const el = e.target.closest('[data-act]'); if (el) actions[el.dataset.act]?.(el);
});
document.addEventListener('input', e => { if (e.target.id === 'code') drawRecent(); });
document.addEventListener('change', async e => {
  if (e.target.id === 'langSel') { readForm(); lang = e.target.value; localStorage.setItem('br_lang', lang); render(); return; }
  if (e.target.id === 'teamSel') { B.team = e.target.value; B.codes = []; persist(); render(); loadCodes(); return; }
  if (e.target.id !== 'fFiles') return;
  for (const f of [...e.target.files]) {
    try {
      const blob = await scaled(f, 1600, 0.8), small = await scaled(f, 200, 0.6);
      form.photos.push({ id: uid(), blob, thumb: await toB64(small) });
    } catch (err) { toast(t('badPhoto')); }
  }
  e.target.value = ''; drawPhotos();
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.id === 'loginForm') {
    const btn = $('#loginBtn'); btn.disabled = true;
    try {
      const user = $('#lUser').value.trim();
      const j = await api('blogin', { user, pin: $('#lPin').value });
      if (j.ok) {
        localStorage.setItem('br_lastuser', user);
        B.token = j.token; B.me = j.me; B.team = j.me.team; B.codes = []; B.cache = {};
        if (!lang) { lang = j.me.team === 'Ben Dor' ? 'he' : 'en'; localStorage.setItem('br_lang', lang); }   // first sign-in: partners outside Israel start in English
        persist(); view = 'home'; render(); loadCodes(); sync(); return;
      }
      toast(t(j.error === 'locked' ? 'locked' : 'badLogin'));
    } catch (err) { toast(t('offline')); }
    btn.disabled = false; $('#lPin').value = '';
    return;
  }
  if (e.target.id === 'find') return openCode($('#code').value);
  if (e.target.id !== 'evalForm') return;
  readForm();
  const keys = LAYOUT[form.stage + '/' + form.kind], vals = {};
  for (const k of keys) {
    const f = FIELDS[k], v = form.vals[k];
    if (v == null || v === '') continue;
    if (f.t === 'num') { const n = parseFloat(v); if (isNaN(n) || n < f.min || n > f.max) return toast(`${t('f_' + k)}: ${t('badValue')} (${f.min}-${f.max})`); vals[k] = n; }
    else vals[k] = v;
  }
  if (!Object.keys(vals).length && !form.photos.length) return toast(t('nothing'));
  const id = uid(), team = myTeam();
  const rec = { id, team, code: form.code, stage: form.stage, kind: form.kind, date: form.date, season: form.date.slice(0, 4), decision: form.decision, evaluator: B.me.name, ...vals };
  for (const p of form.photos) await mput(p.id, p.blob);
  B.evals.push(rec);
  form.photos.forEach((p, i) => B.photos.push({ id: p.id, evalId: id, team, code: form.code, name: `${form.code}_${form.date}_${form.stage}_${form.kind}_${i + 1}.jpg`, thumb: p.thumb }));
  if (!B.codes.some(c => c.team === team && ckey(c.code) === ckey(form.code))) B.codes.unshift({ team, code: form.code, last: form.date, stage: form.stage, n: 1, decision: form.decision });
  persist(); form = null; view = 'card'; render(); window.scrollTo(0, 0);
  toast(t(navigator.onLine ? 'saved' : 'savedOffline'));
  sync();
});
window.addEventListener('online', sync);
setInterval(sync, 60000);
if ('serviceWorker' in navigator && !MOCK) navigator.serviceWorker.register('../sw.js').catch(() => {});

render();
if (B.token) { loadCodes(); sync(); }
