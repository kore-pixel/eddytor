/* 별문서 — 문서 편집 앱 (순수 JS, 빌드 없음) */
(() => {
'use strict';

/* ------------------------------------------------------------------ 기본 */
const $ = (s, r = document) => r.querySelector(s);
const CFG = window.BYEOL_CONFIG || {};
const LS_KEY = 'byeol.v1';

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
  'text-decoration-style', 'text-decoration-thickness', 'padding-left',
]);

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = t => new Date(t).toLocaleString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const stripZ = s => s.replace(/​/g, '');

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
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

/* ------------------------------------------------------------------ 문서 정리(공유·불러오기 시 안전하게) */
function sanitizeHTML(html) {
  let clean;
  if (window.DOMPurify) {
    clean = window.DOMPurify.sanitize(html, {
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
    if (!row) { msg.textContent = '공개되지 않았거나 삭제된 문서예요.'; document.title = '별문서'; return; }
    $('#viewerTitle').textContent = row.title || '제목 없음';
    $('#viewerMeta').textContent = '마지막 수정 ' + fmtDate(row.updated_at);
    $('#viewerDoc').innerHTML = sanitizeHTML(row.html || '');
    document.title = (row.title || '제목 없음') + ' · 별문서';
    msg.hidden = true;
  } catch (e) {
    msg.textContent = e.message === 'config' ? '이 앱에 공유 서버(config.js)가 설정되지 않았어요.' : '문서를 불러오지 못했어요.';
  }
}

/* ------------------------------------------------------------------ 저장소 */
const editor = $('#editor');
const titleInp = $('#docTitle');

function freshDb() {
  const id = uid(), now = Date.now();
  return {
    items: {
      [id]: {
        id, type: 'doc', parent: null, title: '별문서에 오신 걸 환영해요', created: now, updated: now, share: null,
        html: '<p>왼쪽 <b>스페이스</b>에서 문서와 폴더를 만들 수 있어요.</p><p>글꼴·굵기·자간·줄간격·정렬·색·하이라이트는 위쪽 도구 줄에서 바꿔요.</p><p><br></p><p>강의 필기나 원고 초안을 편하게 적어 보세요 ✦</p>',
      },
    },
    open: id, expanded: {},
  };
}
function loadDb() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY));
    if (d && d.items) return d;
  } catch (e) { /* 새로 시작 */ }
  return freshDb();
}
let db = loadDb();
let current = null;
let saveTimer, pubTimer;

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

/* ------------------------------------------------------------------ 트리 */
const kids = pid => Object.values(db.items).filter(i => i.parent === pid)
  .sort((a, b) => (a.type === b.type ? a.title.localeCompare(b.title, 'ko') : a.type === 'folder' ? -1 : 1));
const pathOf = it => {
  const names = []; let p = it.parent;
  while (p) { names.unshift(db.items[p].title || '제목 없음'); p = db.items[p].parent; }
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
        for (let p = it.id; p; p = db.items[p] && db.items[p].parent) db.expanded[p] = true;
        targetFolder = it.id; persist(); clearSearch();
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
  if (!list.length) root.append(h('div', { class: 'tree-empty', text: '아직 아무것도 없어요.' }));
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
      if (isF) { targetFolder = it.id; db.expanded[it.id] = !open; persist(); renderTree(); }
      else { openDoc(it.id); document.body.classList.remove('side-open'); }
    };
    row.oncontextmenu = e => { e.preventDefault(); openItemMenu(it.id, { left: e.clientX, bottom: e.clientY, top: e.clientY }); };
    root.append(row);
    if (isF && open) draw(kids(it.id), depth + 1);
  });
  draw(list, 0);
}

let targetFolder = null;   // 새 문서·폴더가 만들어질 곳 (마지막으로 누른 폴더 / 열어 둔 문서의 폴더)
function currentFolder() {
  return targetFolder && db.items[targetFolder] ? targetFolder : null;
}
function addItem(type, parent) {
  const id = uid(), now = Date.now();
  db.items[id] = { id, type, parent, title: type === 'folder' ? '새 폴더' : '', created: now, updated: now, html: '<p><br></p>', share: null };
  if (parent) db.expanded[parent] = true;
  persist();
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
    { label: '여기에 새 문서', fn: () => { const n = addItem('doc', id); openDoc(n); titleInp.focus(); } },
    { label: '여기에 새 폴더', fn: () => { addItem('folder', id); renderTree(); } },
  );
  entries.push('-', { label: '삭제', cls: 'danger', fn: () => deleteItem(id) });
  showMenu(entries, rect);
}

/* ------------------------------------------------------------------ 다이얼로그 */
const dlg = $('#dlg');
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close('cancel'); });
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
// 입력창이 있으면 바로 커서가 가도록
const origShow = dlg.showModal.bind(dlg);
dlg.showModal = () => { origShow(); setTimeout(() => { const i = $('#dlgBody input[type=text]'); if (i) { i.focus(); i.select(); } }, 30); };
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
  persist(); renderTree(); if (it.share && it.share.on) schedulePublish();
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
  it.parent = sel.value || null;
  if (it.parent) db.expanded[it.parent] = true;
  persist(); renderTree();
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
    if (d && d.share && d.share.on) { try { await rpc('unpublish_doc', { p_id: d.share.id, p_token: d.share.token }); } catch (e) { /* 서버 정리는 최선만 */ } }
    delete db.items[x];
  }
  if (all.includes(db.open)) { db.open = null; showEmpty(); }
  persist(); renderTree();
}
function showDetails(id) {
  const it = db.items[id];
  const rows = [['종류', it.type === 'folder' ? '폴더' : '문서'], ['이름', it.title || '제목 없음'], ['위치', pathOf(it)], ['생성일', fmtDate(it.created)], ['수정일', fmtDate(it.updated)]];
  if (it.type === 'doc') {
    const t = textOfHtml(it.html);
    rows.push(['글자 수', counts(t).all.toLocaleString() + '자 (공백 제외 ' + counts(t).nospace.toLocaleString() + '자)']);
    rows.push(['공유', it.share && it.share.on ? '링크로 공개 중' : '비공개']);
  } else rows.push(['포함 항목', descendants(id).length + '개']);
  const dl = h('dl', { class: 'kv' });
  rows.forEach(([k, v]) => dl.append(h('dt', { text: k }), h('dd', { text: v })));
  dialog({ title: '세부정보', body: dl, actions: [closeBtn] });
}

/* ------------------------------------------------------------------ 글자 수 */
function textOfHtml(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return stripZ([...d.children].map(c => c.textContent).join('\n'));
}
function counts(t) {
  const flat = t.replace(/\n/g, '');
  return { all: [...flat].length, nospace: [...flat.replace(/\s/g, '')].length };
}
function updateCount() {
  if (!current) { $('#count').textContent = ''; return; }
  const t = stripZ(editor.innerText || '');
  const c = counts(t);
  let s = `글자 수 ${c.all.toLocaleString()}자 · 공백 제외 ${c.nospace.toLocaleString()}자`;
  const sel = getSelection();
  if (sel.rangeCount && !sel.isCollapsed && editor.contains(sel.anchorNode)) {
    const sc = counts(stripZ(sel.toString()));
    if (sc.all) s += ` · 선택 ${sc.all.toLocaleString()}자`;
  }
  $('#count').textContent = s;
}

/* ------------------------------------------------------------------ 문서 열기 / 편집기 */
function showEmpty() {
  current = null;
  $('#page').hidden = true; $('#empty').hidden = false;
  $('#saveState').textContent = '';
  $('#btnShare').disabled = true; $('#btnExport').disabled = true;
  updateCount();
}
function openDoc(id) {
  flushNow();
  const it = db.items[id];
  if (!it || it.type !== 'doc') return showEmpty();
  current = it; db.open = id; targetFolder = it.parent;
  editor.innerHTML = it.html || '<p><br></p>';
  ensureBlocks();
  titleInp.value = it.title;
  $('#page').hidden = false; $('#empty').hidden = true;
  $('#btnShare').disabled = false; $('#btnExport').disabled = false;
  hist = []; hi = -1; snap();
  persist(); renderTree(); updateCount(); updateState();
  $('#saveState').textContent = '';
  document.title = (it.title || '제목 없음') + ' · 별문서';
}
function flushNow() {
  if (!current) return;
  clearTimeout(inputTimer);
  current.html = editor.innerHTML;
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
let lastRange = null;
document.addEventListener('selectionchange', () => {
  const s = getSelection();
  if (s.rangeCount && editor.contains(s.anchorNode) && editor.contains(s.focusNode)) lastRange = s.getRangeAt(0).cloneRange();
  if (!current) return;
  cancelAnimationFrame(selRaf);
  selRaf = requestAnimationFrame(() => { updateState(); updateCount(); });
});
let selRaf;
function restoreRange() {
  const s = getSelection();
  if (s.rangeCount && editor.contains(s.anchorNode) && document.activeElement === editor) return s.getRangeAt(0);
  editor.focus({ preventScroll: true });
  if (lastRange) { s.removeAllRanges(); s.addRange(lastRange); }
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
  if (ensureBlocks()) { /* 내용이 감싸진 경우 커서를 끝에 */ const r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  onChanged();
});
editor.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (mod && e.shiftKey && k === 'x') { e.preventDefault(); fmt('strikeThrough'); }
  else if (mod && k === 's') { e.preventDefault(); flushNow(); toast('저장됨'); }
  else if (e.key === 'Tab' && !mod && !e.altKey) { e.preventDefault(); handleTab(e.shiftKey); }
});

/* --- Tab 들여쓰기 ---
   · 커서만 있을 때 Tab: 그 자리에 들여쓰기(탭) 삽입, Shift+Tab: 앞의 탭 지우기
   · 글을 드래그해서 선택했을 때 Tab / Shift+Tab: 선택한 문단 전체를 들여쓰기 / 내어쓰기 */
function shiftBlocks(a, b, back) {
  for (let el = a; el; el = el.nextElementSibling) {
    const cur = parseFloat(el.style.paddingLeft) || 0;
    const v = Math.max(0, Math.min(16, cur + (back ? -2 : 2)));
    el.style.paddingLeft = v ? v + 'em' : '';
    if (el === b) break;
  }
}
function handleTab(back) {
  if (!current) return;
  const r = restoreRange(); snap();
  const a = blockOf(r.startContainer), b = blockOf(r.endContainer) || a;
  if (!r.collapsed) shiftBlocks(a, b, back);
  else if (!back) document.execCommand('insertText', false, '\t');
  else {
    const n = r.startContainer;
    if (n.nodeType === 3 && r.startOffset > 0 && n.data[r.startOffset - 1] === '\t') document.execCommand('delete');
    else if (a) shiftBlocks(a, a, true);
  }
  snap(); onChanged(true); updateState();
}
titleInp.addEventListener('input', () => {
  if (!current) return;
  current.title = titleInp.value; current.updated = Date.now();
  document.title = (current.title || '제목 없음') + ' · 별문서';
  scheduleSave(); renderTree();
  if (current.share && current.share.on) schedulePublish();
});
titleInp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); editor.focus(); } });

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

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
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
function cleanHtml() { return stripZ(editor.innerHTML); }
function exportTxt() {
  const t = stripZ(editor.innerText).replace(/\n{3,}/g, '\n\n');
  download(fileName() + '.txt', 'text/plain;charset=utf-8', ((current.title ? current.title + '\n\n' : '') + t));
}
function exportHtml() {
  const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(current.title || '제목 없음')}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/font-kopubworld@1.0/dotum.min.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@400;700;800&display=swap">
<style>body{max-width:780px;margin:40px auto;padding:0 20px;font-family:${FONTS.pretendard};font-size:16px;line-height:1.8;color:#161616;word-break:keep-all}p{margin:0;min-height:1.8em;white-space:pre-wrap}h1{font-size:30px}</style>
</head><body><h1>${esc(current.title || '')}</h1>${cleanHtml()}</body></html>`;
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
  const html = cleanHtml();
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
      persist(); renderTree(); paint();
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

/* ------------------------------------------------------------------ 백업 / 복원 */
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
        db.items[it.id] = it; n++;
      });
      persist(); renderTree();
      if (current) openDoc(current.id);
      dlg.close('x'); toast(`${n}개 항목을 불러왔어요`);
    } catch (e) { toast('백업 파일을 읽지 못했어요'); }
  };
  dialog({
    title: '백업 · 복원',
    body: [
      h('div', { class: 'note', text: '문서는 이 기기의 브라우저에 저장돼요. 기기를 바꾸거나 브라우저 데이터를 지우기 전에 백업해 두세요.' }),
      h('button', { class: 'btn', text: '백업 파일 내려받기', onclick: () => { flushNow(); const copy = JSON.parse(JSON.stringify(db)); Object.values(copy.items).forEach(i => { i.share = null; }); download('별문서-백업-' + new Date().toISOString().slice(0, 10) + '.json', 'application/json', JSON.stringify(copy)); } }),
      h('button', { class: 'btn', text: '백업 파일 불러오기', onclick: () => fileInp.click() }),
      fileInp,
    ],
    actions: [closeBtn],
  });
};

/* ------------------------------------------------------------------ 사이드바 / 시작 */
$('#newDoc').onclick = () => { const id = addItem('doc', currentFolder()); openDoc(id); titleInp.focus(); document.body.classList.remove('side-open'); };
$('#newFolder').onclick = () => { const id = addItem('folder', currentFolder()); renderTree(); renameItem(id); };
$('#menuBtn').onclick = () => document.body.classList.add('side-open');
$('#backdrop').onclick = () => document.body.classList.remove('side-open');
addEventListener('beforeunload', flushNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushNow(); });

renderTree();
$('#colorBar').style.background = lastColor;
if (db.open && db.items[db.open]) openDoc(db.open); else showEmpty();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
})();
