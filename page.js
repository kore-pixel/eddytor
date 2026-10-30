/* eddytor — 쪽(페이지) 모드
   · 문서를 A4/슬라이드 비율의 "쪽"으로 나눠서 보여줘요 (쪽 구분선 + 쪽 번호 n / N).
   · 왼쪽 쪽 목록(썸네일)에서 쪽을 눌러 이동하고, 쪽을 추가해요.
   · 글·필기·사진·PDF는 그대로 한 문서 좌표에 있고, 쪽은 그 위에 얹은 "구획"이에요. */
(() => {
'use strict';
const W = 780;
const RATIO = { p: Math.SQRT2, l: 1 / Math.SQRT2, s: 9 / 16 };
const BGS = { none: '없음', lines: '줄 노트', grid: '모눈', dots: '점' };
const NAME = { p: '세로 (A4)', l: '가로 (A4)', s: '슬라이드 (16:9)' };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const h = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k.startsWith('on')) e[k] = v; else if (k === 'text') e.textContent = v; else if (v != null && v !== false) e.setAttribute(k, v); }
  kids.flat().forEach(c => c != null && e.append(c));
  return e;
};
let ctx = null, doc = null, layer = null, pill = null, panel = null, list = null;
let N = 1, panelOn = false, layT = null, thT = null, scT = null, cur = 0;
try { panelOn = localStorage.getItem('eddytor.pgPanel') === '1'; } catch (e) { /* 무시 */ }

const info = d => (d && d.paged ? { ratio: RATIO[d.pageR] || RATIO.p, PH: Math.round(W * (RATIO[d.pageR] || RATIO.p)) } : null);
const sc = () => (ctx.page.offsetWidth || W) / W;

/* ---------- 내용이 어디까지 차 있나 → 필요한 쪽 수 ---------- */
function contentBottom() {
  const s = sc(), pr = ctx.page.getBoundingClientRect();
  let b = (ctx.editor.getBoundingClientRect().bottom - pr.top) / s + 24;
  (doc.ink || []).forEach(it => {
    if (it.kind === 'img') b = Math.max(b, it.y + it.h);
    else if (it.pts) { const pad = (it.w || 3) / 2; for (const p of it.pts) if (p[1] + pad > b) b = p[1] + pad; }
  });
  (doc.pdfs || []).forEach(p => { if (window.EDPDF) b = Math.max(b, EDPDF.bottom(p)); });
  return b;
}

/* ---------- 배치 ---------- */
function layout() {
  if (!doc) return;
  const f = info(doc);
  if (!f) {
    ctx.page.classList.remove('paged'); layer && layer.replaceChildren();
    pill.hidden = true; panel.hidden = true; ctx.body.classList.remove('pg-open');
    if (window.EDINK && EDINK.refreshHeight) EDINK.refreshHeight();
    return;
  }
  const s = sc(), { PH } = f;
  N = Math.max(1, Math.round(doc.pages) || 1, Math.ceil(contentBottom() / PH));
  ctx.page.classList.add('paged');
  ctx.page.style.setProperty('--ink-h', N * PH * s + 'px');
  while (layer.children.length > N) layer.lastChild.remove();
  while (layer.children.length < N) layer.append(h('div', { class: 'pgbg' }, h('span', { class: 'pgno' })));
  layer.style.setProperty('--pgs', s);
  [...layer.children].forEach((d, k) => {
    d.className = 'pgbg' + (doc.pageBg && doc.pageBg !== 'none' ? ' bg-' + doc.pageBg : '');
    d.style.top = k * PH * s + 'px'; d.style.height = PH * s + 'px';
    d.firstChild.textContent = (k + 1) + ' / ' + N;
  });
  pill.hidden = false;
  panel.hidden = !panelOn; ctx.body.classList.toggle('pg-open', panelOn);
  updatePill();
  if (panelOn) { clearTimeout(thT); thT = setTimeout(renderThumbs, 500); }
}
function ensure(y) {                       // 필기가 쪽 맨 아래에 닿으면 쪽을 하나 더 만들어요
  const f = info(doc); if (!f) return;
  if (y > N * f.PH - 60) { doc.pages = Math.ceil((y + 120) / f.PH); layout(); }
}
function changed() { clearTimeout(layT); layT = setTimeout(layout, 180); }

/* ---------- 현재 쪽 표시 · 이동 ---------- */
function currentPage() {
  const f = info(doc); if (!f) return 0;
  const sr = ctx.scroller.getBoundingClientRect(), pr = ctx.page.getBoundingClientRect();
  return clamp(Math.floor(((sr.top + sr.height * 0.35 - pr.top) / sc()) / f.PH), 0, N - 1);
}
function updatePill() {
  if (!doc || !doc.paged) return;
  cur = currentPage();
  pill.textContent = (cur + 1) + ' / ' + N;
  list && [...list.children].forEach(c => c.classList.toggle('on', +c.dataset.k === cur));
}
function goto(k) {
  const f = info(doc); if (!f) return;
  const sr = ctx.scroller.getBoundingClientRect(), pr = ctx.page.getBoundingClientRect();
  ctx.scroller.scrollTop += pr.top + k * f.PH * sc() - sr.top - 12;
}
function addPage() {
  const f = info(doc); if (!f) return;
  doc.pages = N + 1; ctx.touch(doc); layout();
  setTimeout(() => goto(N - 1), 60);
}

function textsByPage() {                    // 쪽마다 들어 있는 글 (글은 이어 흐르는 내용이라 위치로 쪽을 나눠요)
  const f = info(doc), out = Array.from({ length: N }, () => '');
  if (!f) return out;
  const s = sc(), pr = ctx.page.getBoundingClientRect();
  [...ctx.editor.children].forEach(el => {
    const t = (el.textContent || '').trim(); if (!t) return;
    const r = el.getBoundingClientRect();
    const k0 = clamp(Math.floor(((r.top - pr.top) / s) / f.PH), 0, N - 1);
    const k1 = clamp(Math.floor(((r.bottom - pr.top) / s - 1) / f.PH), 0, N - 1);
    for (let k = k0; k <= k1; k++) out[k] += t + '\n';
  });
  return out;
}

/* ---------- 쪽 삭제 · 이동 · 빈 쪽 넣기 ---------- */
async function pageOp(kind, k) {
  const f = info(doc); if (!f) return;
  const PH = f.PH, tx = textsByPage(), has = i => !!(tx[i] || '').trim();
  let map, newN = N;
  if (kind === 'del') {
    if (N <= 1) { ctx.toast('마지막 한 쪽은 지울 수 없어요'); return; }
    if (has(k)) { ctx.toast('글이 들어 있는 쪽은 지울 수 없어요. 글을 먼저 지워 주세요'); return; }
    if (!(await ctx.confirm((k + 1) + '쪽을 삭제할까요?', '이 쪽의 필기·사진·PDF도 함께 지워져요.', true))) return;
    map = s => (s === k ? null : s > k ? -PH : 0); newN = N - 1;
  } else if (kind === 'insBefore' || kind === 'insAfter') {
    const at = kind === 'insBefore' ? k : k + 1;
    for (let i = at; i < N; i++) if (has(i)) { ctx.toast('아래 쪽에 글이 있어서 쪽을 끼워 넣을 수 없어요'); return; }
    map = s => (s >= at ? PH : 0); newN = N + 1;
  } else {
    const j = kind === 'up' ? k - 1 : k + 1;
    if (j < 0 || j >= N) return;
    if (has(k) || has(j)) { ctx.toast('글이 들어 있는 쪽은 옮길 수 없어요'); return; }
    map = s => (s === k ? (j - k) * PH : s === j ? (k - j) * PH : 0);
  }
  const fn = cy => map(Math.floor(cy / PH));
  if (window.EDINK && EDINK.transformItems) EDINK.transformItems(fn);
  if (window.EDPDF && EDPDF.pageOp) EDPDF.pageOp(PH, fn);
  doc.pages = Math.max(1, newN); ctx.touch(doc); layout();
  if (kind === 'up' || kind === 'down') setTimeout(() => goto(kind === 'up' ? k - 1 : k + 1), 80);
}
function pageMenu(k, rect) {
  ctx.menu([
    { label: '위로 이동', fn: () => pageOp('up', k) },
    { label: '아래로 이동', fn: () => pageOp('down', k) },
    { label: '앞에 빈 쪽 넣기', fn: () => pageOp('insBefore', k) },
    { label: '뒤에 빈 쪽 넣기', fn: () => pageOp('insAfter', k) },
    { label: '이 쪽 삭제', cls: 'danger', fn: () => pageOp('del', k) },
  ], rect);
}

/* ---------- 쪽 목록(썸네일) ---------- */
function renderThumbs() {
  if (!doc || !doc.paged || !list) return;
  const { PH } = info(doc), tw = 104, th = Math.round(tw * PH / W);
  const texts = textsByPage();
  const pdfs = window.EDPDF ? EDPDF.thumbCanvases() : [];
  const frag = document.createDocumentFragment();
  for (let k = 0; k < N; k++) {
    const y0 = k * PH, y1 = y0 + PH;
    const sheet = h('div', { class: 'pgsheet' + (doc.pageBg && doc.pageBg !== 'none' ? ' bg-' + doc.pageBg : ''), style: `height:${th}px` });
    pdfs.filter(q => q.y + q.h > y0 + 4 && q.y < y1 - 4).forEach(q => {
      const c = document.createElement('canvas'); c.width = tw * 2; c.height = Math.max(1, Math.round(q.h / W * tw * 2));
      try { c.getContext('2d').drawImage(q.canvas, 0, 0, c.width, c.height); } catch (e) { /* 무시 */ }
      c.className = 'pgpdf'; c.style.top = ((q.y - y0) / PH * 100) + '%'; c.style.height = (q.h / PH * 100) + '%';
      sheet.append(c);
    });
    if (texts[k].trim()) sheet.append(h('div', { class: 'pgtxt', text: texts[k].trim().slice(0, 500) }));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 ${y0} ${W} ${PH}`); svg.setAttribute('class', 'pgink');
    if (window.EDINK) EDINK.thumbNodes(y0, y1).forEach(n => svg.append(n));
    sheet.append(svg);
    sheet.append(h('button', { class: 'pgmore', text: '⋯', title: '쪽 메뉴', onclick: e => { e.stopPropagation(); pageMenu(k, e.currentTarget.getBoundingClientRect()); } }));
    const it = h('div', { class: 'pgth' + (k === cur ? ' on' : ''), 'data-k': k, onclick: () => goto(k) }, sheet, h('div', { class: 'pgn', text: String(k + 1) }));
    frag.append(it);
  }
  list.replaceChildren(frag);
}
function setPanel(on) {
  panelOn = on;
  try { localStorage.setItem('eddytor.pgPanel', on ? '1' : '0'); } catch (e) { /* 무시 */ }
  layout();
  if (on) renderThumbs();
}

/* ---------- 설정 창 ---------- */
function settings() {
  if (!doc) return;
  const on = h('input', { type: 'checkbox' }); on.checked = !!doc.paged;
  const sel = h('select', {}, ...Object.keys(NAME).map(k => h('option', { value: k, text: NAME[k] })));
  sel.value = doc.pageR || 'p';
  const bg = h('select', {}, ...Object.keys(BGS).map(k => h('option', { value: k, text: BGS[k] }))); bg.value = doc.pageBg || 'none';
  const pn = h('input', { type: 'checkbox' }); pn.checked = panelOn;
  const apply = () => {
    const was = !!doc.paged;
    doc.paged = on.checked; doc.pageR = sel.value; doc.pageBg = bg.value;
    if (doc.paged && !doc.pages) doc.pages = 1;
    ctx.touch(doc); panelOn = pn.checked;
    try { localStorage.setItem('eddytor.pgPanel', panelOn ? '1' : '0'); } catch (e) { /* 무시 */ }
    layout(); if (panelOn && doc.paged) renderThumbs();
    if (doc.paged && !was) ctx.toast('쪽 모드를 켰어요');
  };
  ctx.dialog({
    title: '쪽 설정',
    body: [
      h('label', { class: 'chk-row' }, on, h('span', { text: '쪽으로 나누기 (쪽 번호·쪽 구분선)' })),
      h('div', { class: 'row-l' }, h('span', { text: '쪽 크기' }), sel),
      h('div', { class: 'row-l' }, h('span', { text: '쪽 배경' }), bg),
      h('label', { class: 'chk-row' }, pn, h('span', { text: '왼쪽에 쪽 목록 보기' })),
      h('div', { class: 'note', text: '글·필기·사진·PDF는 그대로 두고 쪽 구분만 얹어요. 끄면 예전처럼 한 장으로 이어진 문서가 돼요. 필기가 쪽 맨 아래에 닿으면 쪽이 자동으로 늘어나요.' }),
      doc.paged ? h('button', { class: 'btn', text: '＋ 쪽 추가', onclick: () => { ctx.closeDialog(); addPage(); } }) : null,
    ],
    actions: [{ label: '닫기', value: 'cancel' }, { label: '적용', cls: 'primary', onClick: apply }],
  });
}

/* ---------- 바깥에서 쓰는 함수 ---------- */
window.EDPAGE = {
  info, layout, changed, ensure, settings,
  cleanLayout(it) {
    it.paged = !!it.paged; it.pageR = RATIO[it.pageR] ? it.pageR : 'p';
    it.pages = clamp(Math.round(+it.pages) || 1, 1, 500);
    it.pageBg = BGS[it.pageBg] ? it.pageBg : 'none';
  },
  init(c) {
    ctx = c;
    layer = h('div', { id: 'pgLayer' }); ctx.page.prepend(layer);
    panel = document.getElementById('pgPanel'); list = document.getElementById('pgList'); pill = document.getElementById('pgPill');
    document.getElementById('pgAdd').onclick = addPage;
    pill.onclick = () => setPanel(!panelOn);
    ctx.scroller.addEventListener('scroll', () => { cancelAnimationFrame(scT); scT = requestAnimationFrame(updatePill); });
    if (window.ResizeObserver) new ResizeObserver(() => { if (doc && doc.paged) changed(); }).observe(ctx.page);
  },
  load(d) { doc = d; if (d.paged !== undefined || d.pages !== undefined || d.pageBg !== undefined) EDPAGE.cleanLayout(d); layout(); },
  unload() { doc = null; layer && layer.replaceChildren(); pill && (pill.hidden = true); panel && (panel.hidden = true); ctx && ctx.body.classList.remove('pg-open'); ctx && ctx.page.classList.remove('paged'); },
};
})();
