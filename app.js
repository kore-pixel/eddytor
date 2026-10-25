/* eddytor — 문서 편집 앱 (순수 JS, 빌드 없음) */
(() => {
'use strict';

/* ------------------------------------------------------------------ 기본 */
const $ = (s, r = document) => r.querySelector(s);
const CFG = window.EDDYTOR_CONFIG || window.BYEOL_CONFIG || {};   // 예전 이름(BYEOL_CONFIG)도 읽어요
const SY = window.EDSYNC;
const LS_KEY = 'byeol.v1';   // 예전 문서가 그대로 보이도록 저장 이름은 바꾸지 않았어요

const FONTS = {
  pretendard: '"Pretendard Variable",Pretendard,-apple-system,system-ui,sans-serif',
  kopub: '"KoPubWorld Dotum","KoPubWorld돋움체",Pretendard,sans-serif',
  myeongjo: '"Nanum Myeongjo","NanumMyeongjo","나눔명조",serif',
};
const PALETTE = [
  '#161616', '#555552', '#8c8c88', '#c4c4c0', '#b3261e', '#d9480f', '#e8a200', '#2f9e44',
  '#0b7285', '#1c64f2', '#5f3dc4', '#c2255c', '#7a4a21', '#0f5132', '#1b3a6b', '#ffffff',
];
const HL_PALETTE = [
  '#fff3a3', '#ffd8a8', '#ffc9c9', '#fcc2d7', '#e5dbff', '#d0ebff', '#c3fae8', '#d8f5a2',
];
const ALLOWED_CSS = new Set([
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height', 'color',
  'background-color', 'text-align', 'text-decoration', 'text-decoration-line', 'text-decoration-color',
  'text-decoration-style', 'text-decoration-thickness', 'text-indent',
]);

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = t => new Date(t).toLocaleString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const stripZ = s => s.replace(/​/g, '');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el[k] = v;
    else if (k === 'text') el.textContent = v;
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  kids.flat().forEach(c => c != null && el.append(c));
  return el;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2400);
}

/* ------------------------------------------------------------------ 문서 정리(공유·불러오기 시 안전하게) */
function sanitizeHTML(html) {
  if (window.DOMPurify) {
    const clean = window.DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'div', 'span', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'font'],
      ALLOWED_ATTR: ['style'],
    });
    const tpl = document.createElement('template');
    tpl.innerHTML = clean;
    tpl.content.querySelectorAll('[style]').forEach(el => {
      const keep = [], st = el.style;
      for (let i = 0; i < st.length; i++) {
        const p = st[i];
        if (!ALLOWED_CSS.has(p)) continue;
        const v = st.getPropertyValue(p);
        if (/url\(|expression|@import|javascript:|<|>/i.test(v)) continue;
        keep.push(p + ':' + v);
      }
      keep.length ? el.setAttribute('style', keep.join(';')) : el.removeAttribute('style');
    });
    return tpl.innerHTML;
  }
  // DOMPurify를 못 불러왔다면 서식 없이 글자만 안전하게 보여줘요.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.body.children].map(p => '<p>' + (esc(p.textContent) || '<br>') + '</p>').join('');
}

/* ------------------------------------------------------------------ 공유 보기 모드 */
const params = new URLSearchParams(location.search);
if (params.get('s')) { runViewer(params.get('s')); return; }

async function rpc(fn, args) {
  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) throw new Error('config');
  const headers = { apikey: CFG.supabaseAnonKey, 'Content-Type': 'application/json' };
  if (CFG.supabaseAnonKey.startsWith('eyJ')) headers.Authorization = 'Bearer ' + CFG.supabaseAnonKey;
  const res = await fetch(`${CFG.supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers, body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(await res.text());
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

async function runViewer(id) {
  document.body.classList.add('view-mode');
  const msg = $('#viewerMsg');
  try {
    const rows = await rpc('get_shared', { p_id: id });
    const row = rows && rows[0];
    if (!row) { msg.textContent = '공개되지 않았거나 삭제된 문서예요.'; document.title = 'eddytor'; return; }
    $('#viewerTitle').textContent = row.title || '제목 없음';
    $('#viewerMeta').textContent = '마지막 수정 ' + fmtDate(row.updated_at);
    $('#viewerDoc').innerHTML = sanitizeHTML(row.html || '');
    document.title = (row.title || '제목 없음') + ' · eddytor';
    msg.hidden = true;
  } catch (e) {
    msg.textContent = e.message === 'config' ? '이 앱에 공유 서버(config.js)가 설정되지 않았어요.' : '문서를 불러오지 못했어요.';
  }
}

/* ------------------------------------------------------------------ 저장소 (이 기기) */
const editor = $('#editor');
const titleInp = $('#docTitle');

function loadDb() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { /* 새로 시작 */ }
  if (!d || !d.items) d = { items: {} };
  d.expanded = d.expanded || {};
  d.dirty = d.dirty || {};      // 서버에 아직 못 올린 변경
  d.tomb = d.tomb || {};        // 서버에 아직 못 알린 삭제
  d.lastPull = d.lastPull || '';
  d.userId = d.userId || null;
  d.open = null;                // 앱을 열면 항상 스페이스 홈에서 시작
  return d;
}
let db = loadDb();
let current = null;
let saveTimer, pubTimer, syncTimer;

function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(db)); return true; }
  catch (e) { toast('저장 공간이 부족해요. 백업을 내려받아 주세요.'); return false; }
}
function scheduleSave() {
  $('#saveState').textContent = '저장 중…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (persist()) $('#saveState').textContent = '저장됨 · ' + new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  }, 350);
}
function markDirty(id) {
  if (!id) return;
  db.dirty[id] = Date.now();
  scheduleSync();
}

/* ------------------------------------------------------------------ 트리 */
const kids = pid => Object.values(db.items)
  .filter(i => i.parent === pid || (pid === null && i.parent && !db.items[i.parent]))   // 부모를 못 찾으면 최상위로
  .sort((a, b) => (a.type === b.type ? (a.title || '').localeCompare(b.title || '', 'ko') : a.type === 'folder' ? -1 : 1));
const pathOf = it => {
  const names = []; let p = it.parent;
  while (p && db.items[p]) { names.unshift(db.items[p].title || '제목 없음'); p = db.items[p].parent; }
  return names.length ? '스페이스 / ' + names.join(' / ') : '스페이스';
};
function descendants(id) {
  const out = [];
  kids(id).forEach(k => { out.push(k.id, ...descendants(k.id)); });
  return out;
}

/* ---------- 문서 검색 (제목 + 본문) ---------- */
let searchQ = '';
const searchInp = $('#search'), searchX = $('#searchClear');
function clearSearch() { searchInp.value = ''; searchQ = ''; searchX.hidden = true; renderTree(); }
searchInp.addEventListener('input', () => { searchQ = searchInp.value.trim(); searchX.hidden = !searchInp.value; renderTree(); });
searchInp.addEventListener('keydown', e => { if (e.key === 'Escape') clearSearch(); });
searchX.onclick = clearSearch;

function renderSearch() {
  const root = $('#tree');
  root.replaceChildren();
  const q = searchQ.toLowerCase();
  const hits = [];
  for (const it of Object.values(db.items)) {
    const title = it.title || '제목 없음';
    const tIdx = title.toLowerCase().indexOf(q);
    let body = '', bIdx = -1;
    if (it.type === 'doc') { body = textOfHtml(it.html).replace(/\s+/g, ' '); bIdx = body.toLowerCase().indexOf(q); }
    if (tIdx < 0 && bIdx < 0) continue;
    hits.push({ it, title, tIdx, body, bIdx });
  }
  hits.sort((a, b) => (a.tIdx >= 0 ? 0 : 1) - (b.tIdx >= 0 ? 0 : 1) || b.it.updated - a.it.updated);
  if (!hits.length) { root.append(h('div', { class: 'tree-empty', text: '검색 결과가 없어요.' })); return; }
  const mark = (s, i) => (i < 0 ? [s] : [s.slice(0, i), h('mark', { text: s.slice(i, i + q.length) }), s.slice(i + q.length)]);
  hits.slice(0, 60).forEach(({ it, title, tIdx, body, bIdx }) => {
    const st = Math.max(0, bIdx - 24);
    const row = h('div', { class: 'node result' + (db.open === it.id ? ' active' : '') },
      h('span', { class: 'nico', text: it.type === 'folder' ? '▢' : '✦' }),
      h('div', { class: 'rtext' },
        h('div', { class: 'nname' }, mark(title, tIdx)),
        bIdx >= 0 ? h('div', { class: 'rsnip' }, st > 0 ? '…' : '', mark(body.slice(st, bIdx + q.length + 40), bIdx - st)) : null,
        h('div', { class: 'rpath', text: pathOf(it) }),
      ),
    );
    row.onclick = () => {
      if (it.type === 'folder') {
        for (let p = it.id; p && db.items[p]; p = db.items[p].parent) db.expanded[p] = true;
        persist(); clearSearch();
      } else {
        const q0 = searchQ;
        openDoc(it.id); jumpTo(q0);
        document.body.classList.remove('side-open');
      }
    };
    root.append(row);
  });
}
function jumpTo(q) {
  if (!q || !current) return;
  const ql = q.toLowerCase();
  const w = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const i = n.data.toLowerCase().indexOf(ql);
    if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + q.length);
    editor.focus({ preventScroll: true });
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    n.parentElement.scrollIntoView({ block: 'center' });
    return;
  }
}

function renderTree() {
  if (searchQ) return renderSearch();
  const root = $('#tree');
  root.replaceChildren();
  const list = kids(null);
  if (!list.length) root.append(h('div', { class: 'tree-empty', text: '아직 아무것도 없어요. 위의 ＋ 버튼으로 시작해 보세요.' }));
  const draw = (items, depth) => items.forEach(it => {
    const isF = it.type === 'folder', open = db.expanded[it.id];
    const row = h('div', { class: 'node' + (db.open === it.id ? ' active' : ''), style: `padding-left:${8 + depth * 16}px`, 'data-id': it.id },
      h('span', { class: 'twirl', text: isF ? (open ? '▾' : '▸') : '' }),
      h('span', { class: 'nico', text: isF ? (open ? '▤' : '▢') : '✦' }),
      h('span', { class: 'nname', text: it.title || '제목 없음' }),
      !isF && it.share && it.share.on ? h('span', { class: 'nshare', text: '공개' }) : null,
      h('button', { class: 'more', 'aria-label': '메뉴', text: '⋯', onclick: e => { e.stopPropagation(); openItemMenu(it.id, e.currentTarget.getBoundingClientRect()); } }),
    );
    row.onclick = () => {
      if (isF) { db.expanded[it.id] = !open; persist(); renderTree(); }
      else { openDoc(it.id); document.body.classList.remove('side-open'); }
    };
    row.oncontextmenu = e => { e.preventDefault(); openItemMenu(it.id, { left: e.clientX, bottom: e.clientY, top: e.clientY }); };
    root.append(row);
    if (isF && open) draw(kids(it.id), depth + 1);
  });
  draw(list, 0);
}

// 새 문서·폴더는 "항상 내가 누른 곳"에 만들어져요: 위쪽 ＋ 버튼 = 스페이스 최상위, 폴더 ⋯ 메뉴 = 그 폴더 안
function addItem(type, parent) {
  const id = uid(), now = Date.now();
  db.items[id] = { id, type, parent: parent || null, title: type === 'folder' ? '새 폴더' : '', created: now, updated: now, html: '<p><br></p>', indent: false, share: null };
  if (parent) db.expanded[parent] = true;
  markDirty(id); persist();
  return id;
}

/* ------------------------------------------------------------------ 메뉴 */
const menu = $('#menu');
function showMenu(entries, rect) {
  menu.replaceChildren();
  entries.forEach(e => {
    if (e === '-') return menu.append(h('hr'));
    menu.append(h('button', { class: e.cls || '', text: e.label, onclick: () => { hideMenu(); e.fn(); } }));
  });
  menu.hidden = false;
  const w = menu.offsetWidth, hh = menu.offsetHeight;
  let x = Math.min(rect.left, innerWidth - w - 8), y = rect.bottom + 4;
  if (y + hh > innerHeight - 8) y = Math.max(8, (rect.top || rect.bottom) - hh - 4);
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = y + 'px';
}
const hideMenu = () => (menu.hidden = true);
document.addEventListener('mousedown', e => {
  if (!menu.hidden && !menu.contains(e.target)) hideMenu();
  if (!colorPop.hidden && !colorPop.contains(e.target) && !e.target.closest('[data-act="color"],[data-act="hl"]')) colorPop.hidden = true;
}, true);

function openItemMenu(id, rect) {
  const it = db.items[id];
  const entries = [
    { label: '이름 바꾸기', fn: () => renameItem(id) },
    { label: '이동', fn: () => moveItem(id) },
    { label: '세부정보', fn: () => showDetails(id) },
  ];
  if (it.type === 'doc') entries.push({ label: '공유 설정', fn: () => { if (db.open !== id) openDoc(id); shareDialog(); } });
  if (it.type === 'folder') entries.unshift(
    { label: '이 폴더에 새 문서', fn: () => { const n = addItem('doc', id); openDoc(n); titleInp.focus(); } },
    { label: '이 폴더에 새 폴더', fn: () => { const n = addItem('folder', id); renderTree(); renameItem(n); } },
  );
  entries.push('-', { label: '삭제', cls: 'danger', fn: () => deleteItem(id) });
  showMenu(entries, rect);
}

/* ------------------------------------------------------------------ 다이얼로그 */
const dlg = $('#dlg');
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close('cancel'); });
const origShow = dlg.showModal.bind(dlg);
dlg.showModal = () => { origShow(); setTimeout(() => { const i = $('#dlgBody input[type=text],#dlgBody input[type=email]'); if (i) { i.focus(); i.select(); } }, 30); };
function dialog({ title, body, actions }) {
  return new Promise(res => {
    $('#dlgTitle').textContent = title;
    const b = $('#dlgBody'); b.replaceChildren(...[].concat(body || []));
    const a = $('#dlgActions'); a.replaceChildren();
    actions.forEach(ac => a.append(h('button', {
      class: 'btn ' + (ac.cls || ''), text: ac.label,
      onclick: () => { if (ac.onClick && ac.onClick() === false) return; dlg.close(ac.value || ac.label); },
    })));
    dlg.returnValue = 'cancel';
    dlg.onclose = () => res(dlg.returnValue);
    dlg.showModal();
  });
}
const closeBtn = { label: '닫기', value: 'cancel' };
async function askText(title, value, placeholder) {
  const inp = h('input', { type: 'text', value: value || '', placeholder: placeholder || '' });
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); dlg.close('ok'); } };
  const r = await dialog({ title, body: inp, actions: [{ label: '취소', value: 'cancel' }, { label: '확인', cls: 'primary', value: 'ok' }] });
  return r === 'ok' ? inp.value.trim() : null;
}
async function askConfirm(title, text, danger) {
  const r = await dialog({
    title, body: h('div', { text }),
    actions: [{ label: '취소', value: 'cancel' }, { label: danger ? '삭제' : '확인', cls: danger ? 'primary danger' : 'primary', value: 'ok' }],
  });
  return r === 'ok';
}

/* ------------------------------------------------------------------ 항목 동작 */
async function renameItem(id) {
  const it = db.items[id];
  const v = await askText('이름 바꾸기', it.title);
  if (v == null) return;
  it.title = v || (it.type === 'folder' ? '새 폴더' : '');
  it.updated = Date.now();
  if (db.open === id) titleInp.value = it.title;
  markDirty(id); persist(); renderTree(); if (it.share && it.share.on) schedulePublish();
}
async function moveItem(id) {
  const it = db.items[id];
  const banned = new Set([id, ...descendants(id)]);
  const sel = h('select', {});
  sel.append(h('option', { value: '', text: '스페이스 (최상위)' }));
  const addOpts = (pid, depth) => kids(pid).filter(k => k.type === 'folder' && !banned.has(k.id)).forEach(f => {
    sel.append(h('option', { value: f.id, text: '  '.repeat(depth) + '▢ ' + f.title }));
    addOpts(f.id, depth + 1);
  });
  addOpts(null, 0);
  sel.value = it.parent || '';
  const r = await dialog({ title: '이동', body: sel, actions: [{ label: '취소', value: 'cancel' }, { label: '이동', cls: 'primary', value: 'ok' }] });
  if (r !== 'ok') return;
  it.parent = sel.value || null; it.updated = Date.now();
  if (it.parent) db.expanded[it.parent] = true;
  markDirty(id); persist(); renderTree();
}
async function deleteItem(id) {
  const it = db.items[id];
  const all = [id, ...descendants(id)];
  const text = it.type === 'folder' && all.length > 1
    ? `“${it.title}” 폴더와 안에 있는 ${all.length - 1}개 항목이 모두 삭제돼요. 되돌릴 수 없어요.`
    : `“${it.title || '제목 없음'}”을(를) 삭제할까요? 되돌릴 수 없어요.`;
  if (!await askConfirm('삭제', text, true)) return;
  for (const x of all) {
    const d = db.items[x];
    if (!d) continue;
    if (d.share && d.share.on) { try { await rpc('unpublish_doc', { p_id: d.share.id, p_token: d.share.token }); } catch (e) { /* 서버 정리는 최선만 */ } }
    db.tomb[x] = { t: Date.now(), type: d.type };
    delete db.dirty[x]; delete db.items[x];
  }
  if (all.includes(db.open)) showHome();
  persist(); renderTree(); renderHomeIfShown(); scheduleSync();
}
function showDetails(id) {
  const it = db.items[id];
  const rows = [['종류', it.type === 'folder' ? '폴더' : '문서'], ['이름', it.title || '제목 없음'], ['위치', pathOf(it)], ['생성일', fmtDate(it.created)], ['수정일', fmtDate(it.updated)]];
  if (it.type === 'doc') {
    const c = counts(textOfHtml(it.html));
    rows.push(['글자 수', c.all.toLocaleString() + '자 (공백 제외 ' + c.nospace.toLocaleString() + '자)']);
    rows.push(['공유', it.share && it.share.on ? '링크로 공개 중' : '비공개']);
  } else rows.push(['포함 항목', descendants(id).length + '개']);
  const dl = h('dl', { class: 'kv' });
  rows.forEach(([k, v]) => dl.append(h('dt', { text: k }), h('dd', { text: v })));
  dialog({ title: '세부정보', body: dl, actions: [closeBtn] });
}

/* ------------------------------------------------------------------ 글자 수 */
function textOfHtml(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return stripZ([...d.children].map(c => c.textContent).join('\n'));
}
function counts(t) {
  const flat = t.replace(/\n/g, '');
  return { all: [...flat].length, nospace: [...flat.replace(/\s/g, '')].length };
}
function updateCount() {
  if (!current) { $('#count').textContent = ''; return; }
  const c = counts(stripZ(editor.innerText || ''));
  let s = `글자 수 ${c.all.toLocaleString()}자 · 공백 제외 ${c.nospace.toLocaleString()}자`;
  const sel = getSelection();
  if (sel.rangeCount && !sel.isCollapsed && editor.contains(sel.anchorNode)) {
    const sc = counts(stripZ(sel.toString()));
    if (sc.all) s += ` · 선택 ${sc.all.toLocaleString()}자`;
  }
  $('#count').textContent = s;
}

/* ------------------------------------------------------------------ 스페이스 홈 */
function renderHome() {
  const all = Object.values(db.items);
  const docs = all.filter(i => i.type === 'doc').sort((a, b) => b.updated - a.updated);
  const recent = $('#homeRecent'); recent.replaceChildren();
  if (!docs.length) recent.append(h('div', { class: 'cards-empty', text: '아직 문서가 없어요. “새 문서”로 첫 글을 시작해 보세요.' }));
  docs.slice(0, 8).forEach(it => {
    const snip = textOfHtml(it.html).replace(/\s+/g, ' ').trim().slice(0, 100);
    const c = h('button', { class: 'card', onclick: () => openDoc(it.id) },
      h('div', { class: 'ct', text: it.title || '제목 없음' }),
      h('div', { class: 'cs', text: snip || '내용 없음' }),
      h('div', { class: 'cm', text: pathOf(it) + ' · ' + fmtDate(it.updated) }),
    );
    recent.append(c);
  });
  const fl = $('#homeFolders'); fl.replaceChildren();
  const folders = kids(null).filter(k => k.type === 'folder');
  if (!folders.length) fl.append(h('div', { class: 'cards-empty', text: '폴더가 없어요. “새 폴더”로 강의나 원고별로 나눠 보세요.' }));
  folders.forEach(f => {
    const d = descendants(f.id).map(i => db.items[i]);
    const c = h('button', {
      class: 'card', onclick: () => {
        db.expanded[f.id] = true; persist(); renderTree();
        document.body.classList.add('side-open');
      },
    },
      h('div', { class: 'ct', text: '▢ ' + (f.title || '새 폴더') }),
      h('div', { class: 'cs', text: `문서 ${d.filter(x => x.type === 'doc').length}개 · 폴더 ${d.filter(x => x.type === 'folder').length}개` }),
      h('div', { class: 'cm', text: '수정 ' + fmtDate(f.updated) }),
    );
    fl.append(c);
  });
  $('#homeStats').textContent = `문서 ${docs.length}개 · 폴더 ${all.length - docs.length}개`;
}
const renderHomeIfShown = () => { if (!$('#home').hidden) renderHome(); };
function showHome() {
  if (current) flushNow();
  current = null; db.open = null;
  $('#page').hidden = true; $('#home').hidden = false;
  $('#saveState').textContent = '';
  $('#btnShare').disabled = true; $('#btnExport').disabled = true;
  $('#indentChk').checked = false;
  document.title = 'eddytor';
  renderHome(); renderTree(); updateCount();
  $('#scroller').scrollTop = 0;
}

/* ------------------------------------------------------------------ 문서 열기 / 편집기 */
function openDoc(id) {
  if (current) flushNow();
  const it = db.items[id];
  if (!it || it.type !== 'doc') return showHome();
  current = it; db.open = id;
  editor.innerHTML = it.html || '<p><br></p>';
  ensureBlocks();
  editor.classList.toggle('indent-on', !!it.indent);
  $('#indentChk').checked = !!it.indent;
  titleInp.value = it.title;
  $('#page').hidden = false; $('#home').hidden = true;
  $('#btnShare').disabled = false; $('#btnExport').disabled = false;
  hist = []; hi = -1; snap();
  persist(); renderTree(); updateCount(); updateState();
  $('#saveState').textContent = '';
  document.title = (it.title || '제목 없음') + ' · eddytor';
  $('#scroller').scrollTop = 0;
}
function flushNow() {
  if (!current) return;
  clearTimeout(inputTimer);
  if (current.html !== editor.innerHTML) current.html = editor.innerHTML;
  persist();
}

function ensureBlocks() {
  let changed = false;
  if (!editor.firstChild) { editor.innerHTML = '<p><br></p>'; return true; }
  let cur = null;
  [...editor.childNodes].forEach(n => {
    const isBlock = n.nodeType === 1 && /^(P|DIV)$/.test(n.tagName);
    if (isBlock) { cur = null; return; }
    if (!cur) { cur = document.createElement('p'); n.replaceWith(cur); }
    cur.appendChild(n); changed = true;
  });
  return changed;
}

/* --- 선택 영역 저장 / 복원 --- */
let lastRange = null, selRaf;
document.addEventListener('selectionchange', () => {
  const s = getSelection();
  if (s.rangeCount && editor.contains(s.anchorNode) && editor.contains(s.focusNode)) lastRange = s.getRangeAt(0).cloneRange();
  if (!current) return;
  cancelAnimationFrame(selRaf);
  selRaf = requestAnimationFrame(() => { updateState(); updateCount(); });
});
function restoreRange() {
  const s = getSelection();
  if (s.rangeCount && editor.contains(s.anchorNode) && document.activeElement === editor) return s.getRangeAt(0);
  editor.focus({ preventScroll: true });
  if (lastRange && editor.contains(lastRange.startContainer)) { s.removeAllRanges(); s.addRange(lastRange); }
  else { const r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); s.removeAllRanges(); s.addRange(r); }
  return s.getRangeAt(0);
}
const offsetOf = (node, o) => { const r = document.createRange(); r.selectNodeContents(editor); r.setEnd(node, o); return r.toString().length; };
function getOffsets() {
  const s = getSelection();
  if (!s.rangeCount) return null;
  const r = s.getRangeAt(0);
  if (!editor.contains(r.startContainer) || !editor.contains(r.endContainer)) return null;
  return [offsetOf(r.startContainer, r.startOffset), offsetOf(r.endContainer, r.endOffset)];
}
function setOffsets(o) {
  if (!o) return;
  const w = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  const pos = t => { let acc = 0, n; w.currentNode = editor; while ((n = w.nextNode())) { if (acc + n.length >= t) return [n, t - acc]; acc += n.length; } return null; };
  const a = pos(o[0]), b = pos(o[1]);
  const r = document.createRange();
  if (a) r.setStart(...a); else r.setStart(editor, editor.childNodes.length);
  if (b) r.setEnd(...b); else r.setEnd(editor, editor.childNodes.length);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

/* --- 실행 취소 / 다시 실행 (직접 관리) --- */
let hist = [], hi = -1, inputTimer;
function snap() {
  const html = editor.innerHTML;
  if (hist[hi] && hist[hi].html === html) { hist[hi].sel = getOffsets() || hist[hi].sel; return; }
  hist = hist.slice(0, hi + 1);
  hist.push({ html, sel: getOffsets() });
  if (hist.length > 300) hist.shift();
  hi = hist.length - 1;
}
function applySnap(s) {
  editor.innerHTML = s.html;
  editor.focus({ preventScroll: true });
  setOffsets(s.sel);
  onChanged(true);
}
function undo() { clearTimeout(inputTimer); snap(); if (hi > 0) { hi--; applySnap(hist[hi]); } }
function redo() { clearTimeout(inputTimer); if (hi < hist.length - 1) { hi++; applySnap(hist[hi]); } }

function onChanged(skipSnap) {
  if (!current) return;
  current.html = editor.innerHTML;
  current.updated = Date.now();
  markDirty(current.id);
  scheduleSave();
  updateCount();
  if (current.share && current.share.on) schedulePublish();
  if (!skipSnap) { clearTimeout(inputTimer); inputTimer = setTimeout(snap, 350); }
}

/* --- 입력 처리 --- */
editor.addEventListener('focus', () => { try { document.execCommand('styleWithCSS', false, true); document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* 무시 */ } });
editor.addEventListener('beforeinput', e => {
  if (e.inputType === 'historyUndo') { e.preventDefault(); undo(); }
  else if (e.inputType === 'historyRedo') { e.preventDefault(); redo(); }
});
editor.addEventListener('input', () => {
  if (ensureBlocks()) { const r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  onChanged();
});
editor.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (mod && e.shiftKey && k === 'x') { e.preventDefault(); fmt('strikeThrough'); }
  else if (mod && k === 's') { e.preventDefault(); flushNow(); toast('저장됨'); }
});
titleInp.addEventListener('input', () => {
  if (!current) return;
  current.title = titleInp.value; current.updated = Date.now();
  document.title = (current.title || '제목 없음') + ' · eddytor';
  markDirty(current.id); scheduleSave(); renderTree();
  if (current.share && current.share.on) schedulePublish();
});
titleInp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); editor.focus(); } });

// 문단 들여쓰기 (체크하면 모든 문단의 첫 줄이 들여쓰기 돼요)
$('#indentChk').addEventListener('change', e => {
  if (!current) return;
  current.indent = e.target.checked;
  editor.classList.toggle('indent-on', current.indent);
  current.updated = Date.now();
  markDirty(current.id); scheduleSave();
  if (current.share && current.share.on) schedulePublish();
});

/* --- 복사 / 붙여넣기: 내부 복사는 서식 유지, 외부는 글자만 --- */
let lastCopy = null;
function captureCopy() {
  const s = getSelection();
  if (!s.rangeCount || s.isCollapsed || !editor.contains(s.anchorNode)) return;
  const d = document.createElement('div');
  d.append(s.getRangeAt(0).cloneContents());
  lastCopy = { text: s.toString().replace(/\s+/g, ' ').trim(), html: d.innerHTML };
}
editor.addEventListener('copy', captureCopy);
editor.addEventListener('cut', captureCopy);
editor.addEventListener('paste', e => {
  e.preventDefault();
  const t = (e.clipboardData || window.clipboardData).getData('text/plain') || '';
  if (lastCopy && t.replace(/\s+/g, ' ').trim() === lastCopy.text) {
    document.execCommand('insertHTML', false, sanitizeHTML(lastCopy.html));
  } else {
    t.replace(/\r/g, '').split('\n').forEach((ln, i) => {
      if (i) document.execCommand('insertParagraph');
      if (ln) document.execCommand('insertText', false, ln);
    });
  }
});

/* ------------------------------------------------------------------ 서식 */
function fmt(cmd) {
  if (!current) return;
  restoreRange(); snap();
  document.execCommand(cmd, false, null);
  snap(); onChanged(true); updateState();
}

// 글자 단위 스타일 (크기·자간·글꼴·색·하이라이트) — 선택한 글자에만 적용
function wrapStyle(styles) {
  if (!current) return;
  const r = restoreRange(); snap();
  const s = getSelection();
  if (r.collapsed) {
    const span = h('span', {}); Object.assign(span.style, styles); span.textContent = '​';
    r.insertNode(span);
    const nr = document.createRange(); nr.setStart(span.firstChild, 1); nr.collapse(true);
    s.removeAllRanges(); s.addRange(nr);
  } else {
    const root = r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentNode : r.commonAncestorContainer;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = []; let n;
    while ((n = w.nextNode())) if (r.intersectsNode(n) && n.length) texts.push(n);
    if (root.nodeType === 1 && !texts.length && root.firstChild && root.firstChild.nodeType === 3) texts.push(root.firstChild);
    let first = null, last = null;
    texts.forEach(node => {
      const start = node === r.startContainer ? r.startOffset : 0;
      const end = node === r.endContainer ? r.endOffset : node.length;
      if (start >= end) return;
      let target = node;
      if (end < node.length) node.splitText(end);
      if (start > 0) target = node.splitText(start);
      const par = target.parentNode;
      let span;
      if (par !== editor && par.tagName === 'SPAN' && par.childNodes.length === 1) span = par;   // 겹겹이 쌓이지 않게 재사용
      else { span = h('span', {}); par.insertBefore(span, target); span.appendChild(target); }
      Object.assign(span.style, styles);
      first = first || span; last = span;
    });
    if (first) {
      const nr = document.createRange(); nr.setStartBefore(first); nr.setEndAfter(last);
      s.removeAllRanges(); s.addRange(nr);
    }
  }
  snap(); onChanged(true); updateState();
}

// 문단 단위 스타일 (정렬·줄간격)
function blockOf(node) {
  while (node && node.parentNode !== editor) node = node.parentNode;
  return node && node.nodeType === 1 ? node : null;
}
function blockStyle(styles) {
  if (!current) return;
  const r = restoreRange(); snap();
  let a = blockOf(r.startContainer) || editor.firstElementChild, b = blockOf(r.endContainer) || a;
  for (let el = a; el; el = el.nextElementSibling) {
    Object.assign(el.style, styles);
    if (el === b) break;
  }
  snap(); onChanged(true); updateState();
}

/* --- 도구 줄 상태 --- */
let ui = { size: 16, sp: 0, lh: 1.8 };
function updateState() {
  if (!current) return;
  const s = getSelection();
  if (!s.rangeCount || !editor.contains(s.focusNode)) return;
  const node = s.focusNode.nodeType === 3 ? s.focusNode.parentElement : s.focusNode;
  if (!node) return;
  document.querySelectorAll('#toolbar [data-st]').forEach(b => {
    let on = false; try { on = document.queryCommandState(b.dataset.st); } catch (e) { /* 무시 */ }
    b.classList.toggle('on', on);
  });
  const cs = getComputedStyle(node);
  const ff = cs.fontFamily.toLowerCase();
  $('#fontSel').value = ff.includes('kopub') ? 'kopub' : ff.includes('nanum') || ff.includes('나눔') ? 'myeongjo' : 'pretendard';
  ui.size = Math.round(parseFloat(cs.fontSize) * 10) / 10 || 16;
  if (document.activeElement !== $('#sizeInp')) $('#sizeInp').value = ui.size;
  const ls = parseFloat(cs.letterSpacing);
  ui.sp = isNaN(ls) ? 0 : Math.round((ls / ui.size) * 100);
  $('#spVal').textContent = ui.sp + '%';
  const blk = blockOf(node);
  if (blk) {
    const bs = getComputedStyle(blk);
    const lh = parseFloat(bs.lineHeight) / parseFloat(bs.fontSize);
    ui.lh = isNaN(lh) ? 1.8 : Math.round(lh * 10) / 10;
    $('#lhVal').textContent = ui.lh.toFixed(1);
    let al = bs.textAlign; if (al === 'start') al = 'left'; if (al === 'end') al = 'right';
    document.querySelectorAll('#toolbar [data-al]').forEach(b => b.classList.toggle('on', b.dataset.al === al));
  }
}

const ACTS = {
  undo, redo,
  bold: () => fmt('bold'), italic: () => fmt('italic'), underline: () => fmt('underline'), strike: () => fmt('strikeThrough'),
  'size-up': () => wrapStyle({ fontSize: clamp(ui.size + 1, 8, 200) + 'px' }),
  'size-down': () => wrapStyle({ fontSize: clamp(ui.size - 1, 8, 200) + 'px' }),
  'sp-up': () => wrapStyle({ letterSpacing: clamp(ui.sp + 1, -10, 50) / 100 + 'em' }),
  'sp-down': () => wrapStyle({ letterSpacing: clamp(ui.sp - 1, -10, 50) / 100 + 'em' }),
  'lh-up': () => blockStyle({ lineHeight: String(clamp(Math.round((ui.lh + 0.1) * 10) / 10, 1, 3.5)) }),
  'lh-down': () => blockStyle({ lineHeight: String(clamp(Math.round((ui.lh - 0.1) * 10) / 10, 1, 3.5)) }),
  left: () => blockStyle({ textAlign: 'left' }), center: () => blockStyle({ textAlign: 'center' }),
  right: () => blockStyle({ textAlign: 'right' }), justify: () => blockStyle({ textAlign: 'justify' }),
  color: el => openColor('color', el), hl: el => openColor('hl', el),
};
$('#toolbar').addEventListener('mousedown', e => { if (e.target.closest('.tb')) e.preventDefault(); });
$('#toolbar').addEventListener('click', e => {
  const b = e.target.closest('.tb[data-act]');
  if (b && ACTS[b.dataset.act]) ACTS[b.dataset.act](b);
});
$('#fontSel').addEventListener('change', e => wrapStyle({ fontFamily: FONTS[e.target.value] }));
const sizeInp = $('#sizeInp');
const applySize = () => { const v = parseFloat(sizeInp.value); if (v >= 6 && v <= 300) wrapStyle({ fontSize: v + 'px' }); else sizeInp.value = ui.size; };
sizeInp.addEventListener('change', applySize);
sizeInp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applySize(); } });

/* --- 색 / 하이라이트 팝업 --- */
const colorPop = $('#colorPop');
let lastColor = '#161616';
function openColor(kind, btn) {
  const isHl = kind === 'hl';
  const colors = isHl ? HL_PALETTE : PALETTE;
  const apply = c => {
    colorPop.hidden = true;
    if (isHl) wrapStyle({ backgroundColor: c });
    else { wrapStyle({ color: c }); lastColor = c; $('#colorBar').style.background = c; }
  };
  colorPop.replaceChildren(
    h('div', { class: 'grid' }, colors.map(c => h('button', { class: 'sw', style: `background:${c}`, 'aria-label': c, onmousedown: e => e.preventDefault(), onclick: () => apply(c) }))),
    h('div', { class: 'row' },
      h('span', { text: '직접 고르기' }),
      h('input', { type: 'color', value: isHl ? '#fff3a3' : lastColor, onchange: e => apply(e.target.value) }),
      h('button', { class: 'clear', text: isHl ? '지우기' : '기본색', onmousedown: e => e.preventDefault(), onclick: () => apply(isHl ? 'transparent' : '#161616') }),
    ),
  );
  colorPop.hidden = false;
  const rc = btn.getBoundingClientRect();
  colorPop.style.left = Math.max(8, Math.min(rc.left, innerWidth - 226)) + 'px';
  colorPop.style.top = rc.bottom + 6 + 'px';
}

/* ------------------------------------------------------------------ 내보내기 */
const fileName = () => ((current && current.title) || '제목 없음').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
function download(name, mime, data) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const isSideAligned = p => p.style && (p.style.textAlign === 'center' || p.style.textAlign === 'right');
// 공유·HTML 내보내기용: "문단 들여쓰기"를 각 문단에 직접 적어 넣어요
function bakedHtml(html, indent) {
  if (!indent) return stripZ(html);
  const d = document.createElement('div');
  d.innerHTML = html;
  [...d.children].forEach(p => { if (!isSideAligned(p)) p.style.textIndent = '1em'; });
  return stripZ(d.innerHTML);
}
function exportTxt() {
  const ind = !!current.indent;
  const body = [...editor.children].map(p => (ind && !isSideAligned(p) ? '　' : '') + stripZ(p.innerText || '').replace(/\n+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n');
  download(fileName() + '.txt', 'text/plain;charset=utf-8', (current.title ? current.title + '\n\n' : '') + body);
}
function exportHtml() {
  const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(current.title || '제목 없음')}</title>
<style>body{max-width:780px;margin:40px auto;padding:0 20px;font-family:${FONTS.pretendard};font-size:16px;line-height:1.8;color:#161616;word-break:keep-all}p{margin:0;min-height:1.8em;white-space:pre-wrap}h1{font-size:30px}</style>
</head><body><h1>${esc(current.title || '')}</h1>${bakedHtml(editor.innerHTML, current.indent)}</body></html>`;
  download(fileName() + '.html', 'text/html;charset=utf-8', doc);
}
function exportPdf() {
  const old = document.title;
  document.title = fileName();
  setTimeout(() => { window.print(); document.title = old; }, 60);
}
$('#btnExport').onclick = () => {
  if (!current) return;
  flushNow();
  const big = (label, sub, fn) => h('button', { class: 'btn', style: 'text-align:left;padding:12px 14px;width:100%', onclick: () => { dlg.close('x'); fn(); } },
    h('div', { text: label, style: 'font-weight:700' }), h('div', { text: sub, class: 'note', style: 'font-weight:400' }));
  dialog({
    title: '내보내기',
    body: [
      big('PDF', '인쇄 창이 열리면 “PDF로 저장”을 고르세요 (폰트 모양 그대로)', exportPdf),
      big('TXT', '서식 없이 글자만', exportTxt),
      big('HTML', '웹 문서로 저장', exportHtml),
    ],
    actions: [closeBtn],
  });
};

/* ------------------------------------------------------------------ 공유(공개 게시) */
const shareLink = sh => `${location.origin}${location.pathname}?s=${sh.id}`;
async function publishNow() {
  const sh = current && current.share;
  if (!sh || !sh.on) return;
  const html = bakedHtml(editor.innerHTML, current.indent);
  if (html.length > 1500000) { $('#saveState').textContent = '문서가 너무 커서 공유에 반영하지 못했어요'; return; }
  try {
    await rpc('publish_doc', { p_id: sh.id, p_token: sh.token, p_title: current.title || '제목 없음', p_html: html });
  } catch (e) { $('#saveState').textContent = '공유 반영 실패 (인터넷 확인)'; throw e; }
}
function schedulePublish() { clearTimeout(pubTimer); pubTimer = setTimeout(() => publishNow().catch(() => {}), 1500); }
const randStr = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

function shareDialog() {
  if (!current) return;
  const it = current;
  const ready = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
  const on = !!(it.share && it.share.on);
  const chk = h('input', { type: 'checkbox' }); chk.checked = on; chk.disabled = !ready;
  const info = h('div', { class: 'note' });
  const box = h('div', { class: 'linkbox' });
  const paint = () => {
    const sh = it.share;
    box.replaceChildren();
    if (sh && sh.on) {
      const inp = h('input', { type: 'text', value: shareLink(sh), readonly: true });
      inp.onfocus = () => inp.select();
      box.append(inp, h('button', { class: 'btn', text: '복사', onclick: async () => { try { await navigator.clipboard.writeText(shareLink(sh)); toast('링크를 복사했어요'); } catch (e) { inp.select(); document.execCommand('copy'); toast('링크를 복사했어요'); } } }));
      info.textContent = '링크를 아는 사람은 누구나 볼 수 있어요. 문서를 고치면 자동으로 반영돼요. 끄면 링크가 바로 닫혀요.';
    } else info.textContent = '지금은 비공개예요. 켜면 링크가 만들어져요.';
  };
  paint();
  chk.onchange = async () => {
    chk.disabled = true;
    try {
      if (chk.checked) {
        it.share = it.share || { id: randStr(10), token: randStr(28), on: false };
        it.share.on = true;
        await publishNow();
        toast('공개 게시했어요');
      } else {
        await rpc('unpublish_doc', { p_id: it.share.id, p_token: it.share.token });
        it.share.on = false;
        toast('비공개로 바꿨어요');
      }
      it.updated = Date.now(); markDirty(it.id); persist(); renderTree(); paint();
    } catch (e) {
      chk.checked = !chk.checked;
      if (it.share && chk.checked === false) it.share.on = false;
      toast('실패했어요. 인터넷과 서버 설정을 확인해 주세요');
    }
    chk.disabled = false;
  };
  const body = [
    h('div', { class: 'switch-row' }, h('span', { text: '링크로 공개 게시' }), h('label', { class: 'switch' }, chk, h('i'))),
    box, info,
  ];
  if (!ready) body.unshift(h('div', { class: 'warn', text: '공유 서버가 아직 연결되지 않았어요. config.js에 Supabase 주소와 키를 넣으면 쓸 수 있어요. (README 참고)' }));
  dialog({ title: '공유', body, actions: [closeBtn] });
}
$('#btnShare').onclick = shareDialog;

/* ------------------------------------------------------------------ 백업 / 복원 (파일) */
$('#btnBackup').onclick = () => {
  const fileInp = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  fileInp.onchange = async () => {
    const f = fileInp.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data.items) throw 0;
      let n = 0;
      Object.values(data.items).forEach(it => {
        if (!it || !it.id) return;
        const have = db.items[it.id];
        if (have && have.updated >= it.updated) return;
        if (it.type === 'doc') it.html = sanitizeHTML(it.html || '');
        it.share = have ? have.share : null;
        db.items[it.id] = it; delete db.tomb[it.id]; markDirty(it.id); n++;
      });
      persist(); renderTree(); renderHomeIfShown();
      if (current) openDoc(current.id);
      dlg.close('x'); toast(`${n}개 항목을 불러왔어요`);
    } catch (e) { toast('백업 파일을 읽지 못했어요'); }
  };
  dialog({
    title: '백업 · 복원',
    body: [
      h('div', { class: 'note', text: '문서는 이 기기에 저장돼요. 로그인하면 서버에도 보관돼요. 파일로 따로 백업해 두면 더 안전해요.' }),
      h('button', { class: 'btn', text: '백업 파일 내려받기', onclick: () => { flushNow(); const copy = { items: JSON.parse(JSON.stringify(db.items)) }; Object.values(copy.items).forEach(i => { i.share = null; }); download('eddytor-백업-' + new Date().toISOString().slice(0, 10) + '.json', 'application/json', JSON.stringify(copy)); } }),
      h('button', { class: 'btn', text: '백업 파일 불러오기', onclick: () => fileInp.click() }),
      fileInp,
    ],
    actions: [closeBtn],
  });
};

/* ------------------------------------------------------------------ 로그인 + 서버 동기화 */
const toRow = it => ({
  user_id: SY.session().user.id, id: it.id, type: it.type, parent: it.parent || null, title: it.title || '', html: it.html || '',
  indent: !!it.indent, share: it.share || null, created: it.created, updated: it.updated, deleted: false,
});
let syncing = false, syncAgain = false, syncSeq = 0;
const setSync = t => { $('#syncState').textContent = t; };
const loggedIn = () => !!(SY && SY.configured() && SY.session());

function scheduleSync(delay = 2500) {
  if (!loggedIn()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), delay);
}

function applyRemote(r) {
  const l = db.items[r.id];
  const t = db.tomb[r.id];
  if (t && t.t >= r.updated) return;                      // 이 기기에서 더 나중에 지운 문서
  if (l && l.updated >= r.updated) return;                // 이 기기 것이 더 최신
  if (r.deleted) {
    if (l) {
      delete db.items[r.id]; delete db.dirty[r.id];
      if (current && current.id === r.id) { current = null; showHome(); toast('다른 기기에서 삭제된 문서예요'); }
    }
    return;
  }
  delete db.tomb[r.id];
  const it = { id: r.id, type: r.type, parent: r.parent, title: r.title, html: r.html, indent: !!r.indent, share: r.share, created: Number(r.created), updated: Number(r.updated) };
  db.items[r.id] = it; delete db.dirty[r.id];
  if (current && current.id === r.id) {          // 열어 둔 문서가 다른 기기에서 바뀐 경우
    const sel = getOffsets();
    current = it;
    editor.innerHTML = it.html || '<p><br></p>'; ensureBlocks();
    editor.classList.toggle('indent-on', !!it.indent); $('#indentChk').checked = !!it.indent;
    titleInp.value = it.title;
    setOffsets(sel); hist = []; hi = -1; snap(); updateCount();
  }
}

async function syncNow() {
  if (!loggedIn()) return;
  if (!navigator.onLine) { setSync('오프라인 · 연결되면 자동으로 맞춰요'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true; setSync('동기화 중…');
  try {
    // 1) 서버의 변경 받기
    let since = db.lastPull || '';
    if (since) { const t = Date.parse(since); if (!isNaN(t)) since = new Date(t - 5000).toISOString(); }   // 겹쳐서 받아 누락 방지
    for (let guard = 0; guard < 50; guard++) {
      const rows = await SY.pull(since);
      rows.forEach(applyRemote);
      if (rows.length) since = rows[rows.length - 1].synced_at;
      if (rows.length < 1000) break;
    }
    if (since) db.lastPull = since;
    // 2) 이 기기의 변경 올리기
    const snapD = { ...db.dirty }, snapT = { ...db.tomb };
    const rows = [];
    for (const id of Object.keys(snapD)) { if (db.items[id]) rows.push(toRow(db.items[id])); }
    for (const [id, t] of Object.entries(snapT)) {
      rows.push({ user_id: SY.session().user.id, id, type: t.type || 'doc', parent: null, title: '', html: '', indent: false, share: null, created: t.t, updated: t.t, deleted: true });
    }
    if (rows.length) {
      for (let i = 0; i < rows.length; i += 200) await SY.push(rows.slice(i, i + 200));
      for (const id of Object.keys(snapD)) if (db.dirty[id] === snapD[id]) delete db.dirty[id];
      for (const id of Object.keys(snapT)) if (db.tomb[id] && db.tomb[id].t === snapT[id].t) delete db.tomb[id];
    }
    persist(); renderTree(); renderHomeIfShown();
    setSync('☁ 동기화됨 · ' + new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
  } catch (e) {
    console.warn('sync', e);
    setSync(/relation .* does not exist|PGRST205|42P01/i.test(String(e.message)) ? '동기화 실패: 서버 표가 없어요 (SQL 실행 필요)' : '동기화 실패 · 곧 다시 시도해요');
    scheduleSync(30000);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(500); }
  }
}

function wipeLocal() {
  db.items = {}; db.dirty = {}; db.tomb = {}; db.expanded = {}; db.lastPull = '';
  current = null; db.open = null;
}
async function afterLogin() {
  const u = SY.session().user;
  if (db.userId && db.userId !== u.id && Object.keys(db.items).length) {
    const ok = await askConfirm('다른 계정이에요', '이 기기에 있는 문서는 다른 계정의 것이에요. 지우고 이 계정의 문서를 불러올까요?', true);
    if (!ok) { await SY.signOut(); return; }
    wipeLocal();
  }
  db.userId = u.id; db.lastPull = '';
  Object.values(db.items).forEach(it => { db.dirty[it.id] = Date.now(); });   // 처음 연결할 때 이 기기의 문서를 모두 올려요
  persist(); showHome(); syncNow();
}

function friendlyAuthError(e) {
  const m = String(e && e.message || e), c = (e && e.code) || '';
  if (/invalid login credentials|invalid_credentials/i.test(m + c)) return '이메일이나 비밀번호가 맞지 않아요.';
  if (/already registered|user_already_exists/i.test(m + c)) return '이미 가입된 이메일이에요. “로그인”을 눌러 주세요.';
  if (/not confirmed|email_not_confirmed/i.test(m + c)) return '메일 확인이 필요하게 설정돼 있어요. Supabase에서 “Confirm email”을 꺼 주세요. (README 참고)';
  if (/password should|weak_password|at least/i.test(m + c)) return '비밀번호는 6자 이상으로 해 주세요.';
  if (/rate limit|over_email_send_rate_limit|too many/i.test(m + c)) return '잠시 후에 다시 시도해 주세요.';
  if (/signup.*disabled|signups_disabled/i.test(m + c)) return 'Supabase에서 새 가입이 꺼져 있어요.';
  if (/failed to fetch|network/i.test(m)) return '인터넷 연결을 확인해 주세요.';
  return m;
}

function accountDialog() {
  if (!SY || !SY.configured()) {
    dialog({ title: '로그인 · 동기화', body: h('div', { class: 'warn', text: '서버가 아직 연결되지 않았어요. config.js에 Supabase 주소와 키를 넣어야 로그인할 수 있어요. (README 참고)' }), actions: [closeBtn] });
    return;
  }
  const s = SY.session();
  if (s) {
    dialog({
      title: '로그인 · 동기화',
      body: [
        h('div', { text: s.user.email, style: 'color:var(--ink);font-weight:700;word-break:break-all' }),
        h('div', { class: 'note', text: '이 기기의 문서가 서버에 자동으로 저장되고, 같은 계정으로 로그인한 다른 기기와 맞춰져요. 인터넷이 없을 때 쓴 내용은 연결되면 올라가요.' }),
        h('div', { class: 'note', id: 'acctStatus', text: $('#syncState').textContent || '' }),
      ],
      actions: [
        { label: '비밀번호 변경', onClick: () => { dlg.close('x'); setTimeout(() => newPasswordDialog(false), 50); return false; } },
        { label: '로그아웃', onClick: () => { askLogout(); return false; } },
        { label: '지금 동기화', cls: 'primary', onClick: () => { syncNow(); toast('동기화를 시작했어요'); } },
      ],
    });
    return;
  }
  const em = h('input', { type: 'email', placeholder: '이메일', autocomplete: 'email', inputmode: 'email' });
  const pw = h('input', { type: 'text', placeholder: '비밀번호 (6자 이상)', autocomplete: 'current-password', style: '-webkit-text-security:disc' });
  const msg = h('div', { class: 'note' });
  let busy = false;
  const go = async mode => {
    if (busy) return;
    const email = em.value.trim(), pass = pw.value;
    if (!email || !pass) { msg.textContent = '이메일과 비밀번호를 입력해 주세요.'; return; }
    busy = true; msg.textContent = mode === 'up' ? '가입 중…' : '로그인 중…';
    try {
      if (mode === 'up') {
        const r = await SY.signUp(email, pass);
        if (!r.signedIn) { msg.textContent = '가입은 됐는데 메일 확인이 필요하게 설정돼 있어요. 메일의 링크를 누르거나, Supabase에서 “Confirm email”을 꺼 주세요.'; busy = false; return; }
      } else await SY.signIn(email, pass);
      dlg.close('ok');
      await afterLogin();
    } catch (e) { msg.textContent = friendlyAuthError(e); }
    busy = false;
  };
  pw.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go('in'); } };
  dialog({
    title: '로그인 · 동기화',
    body: [
      h('div', { class: 'note', text: '로그인하면 문서가 서버에도 저장돼서 폰·태블릿·컴퓨터에서 같은 문서를 볼 수 있어요. 처음이라면 “가입하기”를 눌러 주세요.' }),
      em, pw, msg,
    ],
    actions: [
      { label: '비밀번호 잊음', onClick: async () => {
        const email = em.value.trim();
        if (!email) { msg.textContent = '위 칸에 이메일을 먼저 적고 다시 눌러 주세요.'; return false; }
        msg.textContent = '메일 보내는 중…';
        try { await SY.recover(email); msg.textContent = '재설정 메일을 보냈어요. 메일의 링크를 누르면 새 비밀번호를 정할 수 있어요. (스팸함도 확인해 주세요)'; }
        catch (e) { msg.textContent = friendlyAuthError(e); }
        return false;
      } },
      { label: '가입하기', onClick: () => { go('up'); return false; } },
      { label: '로그인', cls: 'primary', onClick: () => { go('in'); return false; } },
    ],
  });
}
async function askLogout() {
  dlg.close('x');
  const keep = await dialog({
    title: '로그아웃',
    body: h('div', { text: '이 기기에 있는 문서는 그대로 둘까요, 지울까요? 서버에는 계속 남아 있어서 다시 로그인하면 돌아와요.' }),
    actions: [{ label: '취소', value: 'cancel' }, { label: '기기에서 문서 지우기', value: 'wipe' }, { label: '문서는 두기', cls: 'primary', value: 'keep' }],
  });
  if (keep === 'cancel') return;
  if (db.dirty && Object.keys(db.dirty).length && navigator.onLine) { try { await syncNow(); } catch (e) { /* 무시 */ } }
  await SY.signOut();
  if (keep === 'wipe') { wipeLocal(); db.userId = null; persist(); showHome(); }
  setSync('');
}
function newPasswordDialog(isRecovery) {
  const pw = h('input', { type: 'text', placeholder: '새 비밀번호 (6자 이상)', autocomplete: 'new-password', style: '-webkit-text-security:disc' });
  const msg = h('div', { class: 'note' });
  const save = async () => {
    if (pw.value.length < 6) { msg.textContent = '비밀번호는 6자 이상으로 해 주세요.'; return false; }
    msg.textContent = '저장 중…';
    try { await SY.updatePassword(pw.value); dlg.close('ok'); toast('비밀번호를 바꿨어요'); }
    catch (e) { msg.textContent = /same|different/i.test(String(e.message)) ? '이전과 다른 비밀번호를 써 주세요.' : friendlyAuthError(e); }
    return false;
  };
  pw.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
  dialog({
    title: '새 비밀번호 정하기',
    body: [h('div', { class: 'note', text: isRecovery ? '메일 인증이 끝났어요. 앞으로 쓸 비밀번호를 정해 주세요.' : '새 비밀번호를 입력해 주세요.' }), pw, msg],
    actions: [{ label: '나중에' }, { label: '저장', cls: 'primary', onClick: save }],
  });
}
function updateAccountBtn() {
  const b = $('#btnAccount');
  const s = SY && SY.session();
  b.textContent = s ? '☁ ' + s.user.email : '로그인 · 동기화';
  b.title = s ? '계정 · 동기화' : '로그인하면 서버에도 저장돼요';
}
$('#btnAccount').onclick = accountDialog;
if (SY) SY.onChange(() => { updateAccountBtn(); if (!SY.session()) setSync(''); });

/* ------------------------------------------------------------------ 사이드바 / 시작 */
$('#brandHome').onclick = () => { showHome(); document.body.classList.remove('side-open'); };
$('#newDoc').onclick = () => { const id = addItem('doc', null); openDoc(id); titleInp.focus(); document.body.classList.remove('side-open'); };
$('#newFolder').onclick = () => { const id = addItem('folder', null); renderTree(); renderHomeIfShown(); renameItem(id); };
$('#homeNewDoc').onclick = $('#newDoc').onclick;
$('#homeNewFolder').onclick = $('#newFolder').onclick;
$('#menuBtn').onclick = () => document.body.classList.add('side-open');
$('#backdrop').onclick = () => document.body.classList.remove('side-open');
addEventListener('beforeunload', flushNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushNow(); else scheduleSync(300); });
addEventListener('online', () => scheduleSync(500));
setInterval(() => { if (!document.hidden) scheduleSync(100); }, 60000);

updateAccountBtn();
$('#colorBar').style.background = lastColor;
showHome();
if (SY) SY.handleRedirect().then(async r => {
  if (!r) return;
  if (r.error) { toast('메일 링크가 안 맞아요: ' + r.error); return; }
  updateAccountBtn();
  await afterLogin();
  if (r.type === 'recovery') newPasswordDialog(true); else toast('로그인됐어요');
});
if (loggedIn()) { db.userId = db.userId || SY.session().user.id; scheduleSync(300); }

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
})();
