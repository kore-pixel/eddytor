/* eddytor — 펜 필기 (S펜·마우스) : 문서 위 어디에나 쓰기, 올가미 선택, 스타일 변경
   · 획(stroke)을 점 좌표로 저장해서, 나중에 선택·이동·크기 조절·색 변경이 가능해요.
   · 좌표는 "페이지 폭 780 기준"으로 저장해서 화면 크기가 달라도 같은 모양으로 보여요. */
(() => {
'use strict';
const NS = 'http://www.w3.org/2000/svg';
const BASE = 780;
const COLORS = ['#161616', '#b3261e', '#d9480f', '#e8a200', '#2f9e44', '#1c64f2', '#5f3dc4', '#ffd43b', '#ff8fab'];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs || {}) e.setAttribute(k, attrs[k]); return e; };
const h = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k.startsWith('on')) e[k] = v; else if (k === 'text') e.textContent = v; else if (v != null && v !== false) e.setAttribute(k, v); }
  kids.flat().forEach(c => c != null && e.append(c));
  return e;
};

/* ---------- 데이터 정리 (서버·백업에서 온 값도 안전하게) ---------- */
function clean(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr.slice(0, 6000)) {
    if (!s || !Array.isArray(s.pts)) continue;
    const pts = [];
    for (const p of s.pts.slice(0, 20000)) {
      if (Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])) pts.push([+p[0], +p[1], isFinite(p[2]) ? clamp(+p[2], 0, 1) : 0.5]);
    }
    if (!pts.length) continue;
    out.push({
      id: String(s.id || uid()).replace(/[^\w-]/g, '').slice(0, 24) || uid(),
      tool: s.tool === 'hl' ? 'hl' : 'pen',
      color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#161616',
      w: clamp(+s.w || 3, 0.5, 80), pts,
    });
  }
  return out;
}

/* ---------- 상태 ---------- */
let ctx = null;                 // { page, scroller, changed(), toast(), onActive() }
let doc = null, strokes = [];
let active = false, tool = 'pen';
const sel = new Set();
const st = { color: '#161616', hcolor: '#ffd43b', pw: 3, hw: 16, partial: 'whole' };
let hist = [], hi = -1;
let scale = 1;
let svg, gS, gU, bar;
const els = new Map();
let drag = null, penAt = 0, penDown = false, clip = null, pasteN = 0;

/* ---------- 그리기 ---------- */
const radius = (s, p) => (s.tool === 'hl' ? s.w / 2 : (s.w / 2) * (0.4 + 0.8 * p[2]));
function outline(s) {
  const P = s.pts, n = P.length;
  const f = v => Math.round(v * 10) / 10;
  if (n === 1) { const r = radius(s, P[0]); return `M${f(P[0][0] - r)} ${f(P[0][1])}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0z`; }
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const r = radius(s, P[i]);
    L.push(f(P[i][0] - dy * r) + ' ' + f(P[i][1] + dx * r));
    R.push(f(P[i][0] + dy * r) + ' ' + f(P[i][1] - dx * r));
  }
  return 'M' + L.join('L') + 'L' + R.reverse().join('L') + 'Z';
}
function paint(s) {
  let e = els.get(s.id);
  if (!e) { e = el('path'); e.dataset.id = s.id; gS.append(e); els.set(s.id, e); }
  e.setAttribute('d', outline(s));
  e.setAttribute('fill', s.color); e.setAttribute('stroke', s.color);
  e.setAttribute('stroke-width', '0.8'); e.setAttribute('stroke-linejoin', 'round');
  if (s.tool === 'hl') { e.setAttribute('opacity', '0.38'); e.style.mixBlendMode = 'multiply'; } else { e.removeAttribute('opacity'); e.style.mixBlendMode = ''; }
}
function renderAll() {
  gS.replaceChildren(); els.clear();
  strokes.forEach(paint);
  renderUI();
}
function remove(id) { const e = els.get(id); if (e) e.remove(); els.delete(id); }

/* ---------- 선택 UI ---------- */
function bbox(list) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  list.forEach(s => s.pts.forEach(p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }));
  const pad = list.reduce((m, s) => Math.max(m, s.w / 2), 0) + 3;
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}
const selList = () => strokes.filter(s => sel.has(s.id));
function renderUI() {
  gU.replaceChildren();
  const k = 1 / scale;
  if (drag && drag.type === 'lasso' && drag.pts.length > 1) {
    gU.append(el('path', { d: 'M' + drag.pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L') + 'Z', fill: 'rgba(28,100,242,.07)', stroke: '#1c64f2', 'stroke-width': 1.6 * k, 'stroke-dasharray': `${6 * k} ${5 * k}`, 'stroke-linecap': 'round', 'pointer-events': 'none' }));
  }
  const list = selList();
  if (tool === 'select' && list.length) {
    const b = bbox(list);
    gU.append(el('rect', { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, fill: 'transparent', stroke: '#1c64f2', 'stroke-width': 1.5 * k, 'stroke-dasharray': `${6 * k} ${5 * k}`, 'data-h': 'move' }));
    const hs = 7 * k;
    [['tl', b.x0, b.y0], ['tr', b.x1, b.y0], ['bl', b.x0, b.y1], ['br', b.x1, b.y1]].forEach(([n, x, y]) =>
      gU.append(el('rect', { x: x - hs, y: y - hs, width: hs * 2, height: hs * 2, rx: 3 * k, fill: '#fff', stroke: '#1c64f2', 'stroke-width': 1.6 * k, 'data-h': 's-' + n, style: 'cursor:nwse-resize' })));
    const cx = (b.x0 + b.x1) / 2, ry = b.y0 - 28 * k;
    gU.append(el('line', { x1: cx, y1: b.y0, x2: cx, y2: ry, stroke: '#1c64f2', 'stroke-width': 1.4 * k, 'pointer-events': 'none' }));
    gU.append(el('circle', { cx, cy: ry, r: 8 * k, fill: '#fff', stroke: '#1c64f2', 'stroke-width': 1.6 * k, 'data-h': 'rot', style: 'cursor:grab' }));
  }
}

/* ---------- 기록 (필기 전용 실행 취소) ---------- */
function snapshot() { hist = hist.slice(0, hi + 1); hist.push(JSON.stringify(strokes)); if (hist.length > 60) hist.shift(); hi = hist.length - 1; }
function commit() {
  doc.ink = strokes;
  snapshot(); ctx.changed(); syncBar();
}
function restore(i) {
  hi = i; strokes = JSON.parse(hist[hi]); doc.ink = strokes;
  [...sel].forEach(id => { if (!strokes.some(s => s.id === id)) sel.delete(id); });
  renderAll(); ctx.changed(); syncBar();
}
const undo = () => { if (hi > 0) restore(hi - 1); };
const redo = () => { if (hi < hist.length - 1) restore(hi + 1); };

/* ---------- 좌표·페이지 ---------- */
function pt(e) { const r = svg.getBoundingClientRect(); return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale]; }
function setScale() {
  scale = (ctx.page.offsetWidth || BASE) / BASE;
  gS.setAttribute('transform', `scale(${scale})`); gU.setAttribute('transform', `scale(${scale})`);
  applyHeight(); renderUI();
}
function applyHeight() {
  const hgt = doc && doc.inkH ? doc.inkH * scale : 0;
  ctx.page.style.setProperty('--ink-h', hgt + 'px');
}
function ensureRoom(y) {   // 아래쪽 끝에 가까워지면 페이지를 자동으로 늘려요
  const pageH = ctx.page.offsetHeight / scale;
  if (y > pageH - 100) { doc.inkH = Math.ceil(y + 500); applyHeight(); }
}

/* ---------- 기하 ---------- */
function inPoly(x, y, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
function segDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0; t = clamp(t, 0, 1);
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
function hit(s, x, y, r) {
  const P = s.pts, rr = r + s.w / 2;
  if (P.length === 1) return Math.hypot(P[0][0] - x, P[0][1] - y) <= rr;
  for (let i = 1; i < P.length; i++) if (segDist(x, y, P[i - 1], P[i]) <= rr) return true;
  return false;
}
function smooth(pts) {
  if (pts.length < 3) return pts;
  const o = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    o.push([(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4, (a[2] + 2 * b[2] + c[2]) / 4]);
  }
  o.push(pts[pts.length - 1]);
  return o;
}
const roundPts = pts => pts.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 100) / 100]);

/* ---------- 올가미 선택 ---------- */
function applyLasso(poly) {
  sel.clear();
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * scale;
  if (span < 8) {                                  // 그냥 톡 눌렀으면 그 자리의 획 하나 선택
    const [x, y] = poly[0];
    for (let i = strokes.length - 1; i >= 0; i--) if (hit(strokes[i], x, y, 8)) { sel.add(strokes[i].id); break; }
    return;
  }
  const next = [];
  let changed = false;
  strokes.forEach(s => {
    const flags = s.pts.map(p => inPoly(p[0], p[1], poly));
    const any = flags.some(Boolean);
    if (!any) { next.push(s); return; }
    if (st.partial === 'whole' || flags.every(Boolean)) { sel.add(s.id); next.push(s); return; }
    // 잘라서 선택: 안쪽 구간만 새 획으로 나눠요
    changed = true;
    let i = 0;
    while (i < flags.length) {
      let j = i; while (j + 1 < flags.length && flags[j + 1] === flags[i]) j++;
      const a = Math.max(0, i - 1), b = Math.min(flags.length - 1, j + 1);   // 경계 점을 양쪽에 걸쳐 두면 잘린 자리가 끊겨 보이지 않아요
      const ns = { id: uid(), tool: s.tool, color: s.color, w: s.w, pts: s.pts.slice(a, b + 1).map(p => p.slice()) };
      next.push(ns); if (flags[i]) sel.add(ns.id);
      i = j + 1;
    }
  });
  if (changed) { strokes = next; doc.ink = strokes; renderAll(); commit(); }
}

/* ---------- 포인터 ---------- */
function down(e) {
  if (!active) return;
  if (e.pointerType === 'touch') {                              // 손가락: 화면 스크롤 (펜 쓰는 중 손바닥은 무시)
    if (penDown || Date.now() - penAt < 900) return;
    drag = { type: 'scroll', x: e.clientX, y: e.clientY }; svg.setPointerCapture(e.pointerId); return;
  }
  e.preventDefault();
  if (e.pointerType === 'pen') { penDown = true; penAt = Date.now(); }
  svg.setPointerCapture(e.pointerId);
  const [x, y] = pt(e);
  const erasing = tool === 'erase' || (e.pointerType === 'pen' && (e.buttons & 32));
  if (erasing) { drag = { type: 'erase', hit: false }; eraseAt(x, y); return; }
  if (tool === 'select') {
    const hd = e.target && e.target.dataset ? e.target.dataset.h : null;
    const list = selList();
    if (hd && list.length) {
      const b = bbox(list);
      const orig = new Map(list.map(s => [s.id, { pts: s.pts.map(p => p.slice()), w: s.w }]));
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      if (hd === 'move') drag = { type: 'move', sx: x, sy: y, orig };
      else if (hd === 'rot') drag = { type: 'rot', cx, cy, a0: Math.atan2(y - cy, x - cx), orig };
      else {
        const ax = hd.endsWith('l') ? b.x1 : b.x0, ay = hd.startsWith('s-t') ? b.y1 : b.y0;
        drag = { type: 'scale', ax, ay, d0: Math.hypot(x - ax, y - ay) || 1, orig };
      }
      drag.moved = false; return;
    }
    sel.clear();
    drag = { type: 'lasso', pts: [[x, y]] }; renderUI(); syncBar(); return;
  }
  const s = { id: uid(), tool: tool === 'hl' ? 'hl' : 'pen', color: tool === 'hl' ? st.hcolor : st.color, w: tool === 'hl' ? st.hw : st.pw, pts: [[x, y, e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5]] };
  drag = { type: 'draw', s };
  paint(s);
}
function move(e) {
  if (e.pointerType === 'pen') penAt = Date.now();
  if (!drag || !active) return;
  if (drag.type === 'scroll') {
    ctx.scroller.scrollTop -= e.clientY - drag.y; ctx.scroller.scrollLeft -= e.clientX - drag.x;
    drag.x = e.clientX; drag.y = e.clientY; return;
  }
  const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
  if (drag.type === 'draw') {
    const s = drag.s, W = BASE;
    evs.forEach(ev => {
      const [x, y] = pt(ev), last = s.pts[s.pts.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) < 0.6) return;
      s.pts.push([clamp(x, 0, ctx.page.offsetWidth / scale || W), Math.max(0, y), ev.pointerType === 'pen' ? ev.pressure || 0.5 : 0.5]);
      ensureRoom(y);
    });
    paint(s); return;
  }
  const [x, y] = pt(e);
  if (drag.type === 'erase') { eraseAt(x, y); return; }
  if (drag.type === 'lasso') { drag.pts.push([x, y]); renderUI(); return; }
  drag.moved = true;
  const list = selList();
  list.forEach(s => {
    const o = drag.orig.get(s.id); if (!o) return;
    let f;
    if (drag.type === 'move') { const dx = x - drag.sx, dy = y - drag.sy; f = p => [p[0] + dx, p[1] + dy, p[2]]; }
    else if (drag.type === 'scale') { const k = clamp(Math.hypot(x - drag.ax, y - drag.ay) / drag.d0, 0.1, 10); f = p => [drag.ax + (p[0] - drag.ax) * k, drag.ay + (p[1] - drag.ay) * k, p[2]]; s.w = clamp(o.w * k, 0.5, 80); }
    else { const a = Math.atan2(y - drag.cy, x - drag.cx) - drag.a0, c = Math.cos(a), sn = Math.sin(a); f = p => { const dx = p[0] - drag.cx, dy = p[1] - drag.cy; return [drag.cx + dx * c - dy * sn, drag.cy + dx * sn + dy * c, p[2]]; }; }
    s.pts = o.pts.map(f); paint(s);
  });
  renderUI();
}
function up(e) {
  if (e.pointerType === 'pen') { penDown = false; penAt = Date.now(); }
  const d = drag; drag = null;
  if (!d || !active) return;
  if (d.type === 'draw') {
    const s = d.s;
    s.pts = roundPts(s.pts.length > 2 ? smooth(s.pts) : s.pts);
    strokes.push(s); paint(s); commit(); return;
  }
  if (d.type === 'erase') { if (d.hit) { renderUI(); commit(); } return; }
  if (d.type === 'lasso') { applyLasso(d.pts); renderUI(); syncBar(); return; }
  if (d.moved) { selList().forEach(s => { s.pts = roundPts(s.pts); }); renderAll(); commit(); }
}
function eraseAt(x, y) {
  const r = 9 / Math.max(scale, 0.5);
  const dead = strokes.filter(s => hit(s, x, y, r));
  if (!dead.length) return;
  dead.forEach(s => { remove(s.id); sel.delete(s.id); });
  strokes = strokes.filter(s => !dead.includes(s)); doc.ink = strokes;
  drag.hit = true;
}

/* ---------- 선택 편집 ---------- */
function delSel() { if (!sel.size) return; strokes = strokes.filter(s => !sel.has(s.id)); sel.clear(); doc.ink = strokes; renderAll(); commit(); }
function cloneSel(off) {
  const list = selList(); if (!list.length) return;
  sel.clear();
  list.forEach(s => { const c = { id: uid(), tool: s.tool, color: s.color, w: s.w, pts: s.pts.map(p => [p[0] + off, p[1] + off, p[2]]) }; strokes.push(c); sel.add(c.id); });
  doc.ink = strokes; renderAll(); commit();
}
function copySel() { const l = selList(); if (l.length) { clip = JSON.parse(JSON.stringify(l)); pasteN = 0; ctx.toast('복사했어요'); } }
function paste() {
  if (!clip) return;
  pasteN++; sel.clear();
  clip.forEach(s => { const c = { id: uid(), tool: s.tool, color: s.color, w: s.w, pts: s.pts.map(p => [p[0] + 20 * pasteN, p[1] + 20 * pasteN, p[2]]) }; strokes.push(c); sel.add(c.id); });
  doc.ink = strokes; setTool('select'); renderAll(); commit();
}
function styleSel(patch, final) {            // 스타일 변경: 선택한 획 전체에 적용
  const list = selList(); if (!list.length) return;
  list.forEach(s => {
    if (patch.color) s.color = patch.color;
    if (patch.w) s.w = patch.w;
    if (patch.tool && patch.tool !== s.tool) { s.tool = patch.tool; s.w = patch.tool === 'hl' ? Math.max(s.w, 14) : Math.min(s.w, 6); }
    paint(s);
  });
  renderUI();
  if (final) commit();
}

/* ---------- 도구 줄 ---------- */
const TOOLS = [['pen', '펜'], ['hl', '형광펜'], ['erase', '지우개'], ['select', '선택']];
function buildBar() {
  bar = $bar();
  const mk = (t, l) => h('button', { class: 'tb tool', 'data-tool': t, text: l, onclick: () => setTool(t) });
  const colorBtns = COLORS.map(c => h('button', { class: 'sw-ink', 'data-c': c, style: `background:${c}`, 'aria-label': c, onclick: () => setColor(c) }));
  const colorIn = h('input', { type: 'color', class: 'ink-color', value: '#161616', 'aria-label': '색 직접 고르기', oninput: e => setColor(e.target.value, false), onchange: e => setColor(e.target.value, true) });
  const wIn = h('input', { type: 'range', min: 1, max: 40, step: 1, value: 3, class: 'ink-w', 'aria-label': '굵기', oninput: e => setWidth(+e.target.value, false), onchange: e => setWidth(+e.target.value, true) });
  const partial = h('select', { class: 'ink-partial', title: '올가미가 획의 일부만 걸쳤을 때', onchange: e => { st.partial = e.target.value; } },
    h('option', { value: 'whole', text: '부분 선택: 획 전체' }), h('option', { value: 'cut', text: '부분 선택: 잘라서' }));
  bar.replaceChildren(
    ...TOOLS.map(([t, l]) => mk(t, l)), h('i', { class: 'sep' }),
    ...colorBtns, colorIn, h('span', { class: 'ink-wl', text: '굵기' }), wIn, h('span', { class: 'ink-wv', text: '3' }),
    h('i', { class: 'sep' }), partial,
    h('span', { class: 'ink-selact' },
      h('button', { class: 'tb', text: '펜으로', title: '선택한 획을 펜으로', onclick: () => styleSel({ tool: 'pen' }, true) }),
      h('button', { class: 'tb', text: '형광펜으로', title: '선택한 획을 형광펜으로', onclick: () => styleSel({ tool: 'hl' }, true) }),
      h('button', { class: 'tb', text: '복제', onclick: () => cloneSel(18) }),
      h('button', { class: 'tb danger', text: '삭제', onclick: delSel })),
    h('i', { class: 'sep' }),
    h('button', { class: 'tb', 'data-k': 'undo', text: '↶', title: '필기 실행 취소', onclick: undo }),
    h('button', { class: 'tb', 'data-k': 'redo', text: '↷', title: '필기 다시 실행', onclick: redo }),
    h('button', { class: 'tb done', text: '필기 끝내기', onclick: () => E.setActive(false) }),
  );
  bar.addEventListener('mousedown', e => { if (e.target.closest('.tb,.sw-ink')) e.preventDefault(); });
}
const $bar = () => document.getElementById('inkBar');
function setTool(t) {
  tool = t; if (t !== 'select') sel.clear();
  renderUI(); syncBar();
  svg.style.cursor = t === 'select' ? 'default' : t === 'erase' ? 'cell' : 'crosshair';
}
function setColor(c, final = true) {
  if (tool === 'hl') st.hcolor = c; else st.color = c;
  const list = selList();
  if (list.length) styleSel({ color: c }, final);
  syncBar();
}
function setWidth(w, final = true) {
  const list = selList();
  if (list.length) styleSel({ w }, final);
  else if (tool === 'hl') st.hw = w; else st.pw = w;
  bar.querySelector('.ink-wv').textContent = w;
}
function syncBar() {
  if (!bar) return;
  const list = selList(), has = list.length > 0;
  bar.querySelectorAll('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
  const col = has ? list[0].color : (tool === 'hl' ? st.hcolor : st.color);
  bar.querySelectorAll('.sw-ink').forEach(b => b.classList.toggle('on', b.dataset.c.toLowerCase() === col.toLowerCase()));
  bar.querySelector('.ink-color').value = col;
  const w = has ? Math.round(list[0].w) : Math.round(tool === 'hl' ? st.hw : st.pw);
  const wi = bar.querySelector('.ink-w'); wi.value = w; bar.querySelector('.ink-wv').textContent = w;
  bar.querySelector('.ink-partial').style.display = tool === 'select' ? '' : 'none';
  bar.querySelector('.ink-selact').style.display = tool === 'select' && has ? '' : 'none';
  bar.querySelector('[data-k=undo]').disabled = hi <= 0;
  bar.querySelector('[data-k=redo]').disabled = hi >= hist.length - 1;
}

/* ---------- 키보드 ---------- */
document.addEventListener('keydown', e => {
  if (!active) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test((e.target.tagName || ''))) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (mod && k === 'c') { copySel(); }
  else if (mod && k === 'v') { e.preventDefault(); paste(); }
  else if (mod && k === 'd') { e.preventDefault(); cloneSel(18); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); delSel(); }
  else if (e.key === 'Escape') { if (sel.size) { sel.clear(); renderUI(); syncBar(); } else E.setActive(false); }
}, true);

/* ---------- 바깥에서 쓰는 함수 ---------- */
const E = window.EDINK = {
  clean,
  init(c) {
    ctx = c;
    svg = el('svg', { id: 'ink', 'aria-hidden': 'true' });
    gS = el('g'); gU = el('g');
    svg.append(gS, gU); ctx.page.append(svg);
    svg.addEventListener('pointerdown', down);
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    svg.addEventListener('contextmenu', e => { if (active) e.preventDefault(); });
    buildBar();
    if (window.ResizeObserver) new ResizeObserver(() => { if (doc) setScale(); }).observe(ctx.page);
  },
  load(d) {
    drag = null; sel.clear();
    doc = d; strokes = clean(d.ink); d.ink = strokes;
    hist = [JSON.stringify(strokes)]; hi = 0;
    setScale(); renderAll(); syncBar();
  },
  unload() { E.setActive(false); doc = null; strokes = []; sel.clear(); gS && gS.replaceChildren(); gU && gU.replaceChildren(); ctx && ctx.page.style.removeProperty('--ink-h'); },
  setActive(on) {
    if (on && !doc) return;
    active = !!on; drag = null;
    ctx.page.classList.toggle('ink-on', active);
    document.getElementById('toolbar').hidden = active;
    $bar().hidden = !active;
    if (active) { document.activeElement && document.activeElement.blur && document.activeElement.blur(); setTool(tool); }
    else { sel.clear(); renderUI(); }
    ctx.onActive && ctx.onActive(active);
  },
  toggle() { E.setActive(!active); },
  isActive: () => active,
};
})();
