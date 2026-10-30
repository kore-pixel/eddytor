/* eddytor — 펜 필기 (S펜·마우스) : 문서 위 어디에나 쓰기, 올가미 선택, 스타일 변경
   · 획(stroke)을 점 좌표로 저장해서, 나중에 선택·이동·크기 조절·색 변경이 가능해요.
   · 좌표는 "페이지 폭 780 기준"으로 저장해서 화면 크기가 달라도 같은 모양으로 보여요. */
(() => {
'use strict';
const NS = 'http://www.w3.org/2000/svg';
const BASE = 780;
const COLORS = ['#161616', '#b3261e', '#d9480f', '#e8a200', '#2f9e44', '#1c64f2', '#5f3dc4', '#ffd43b', '#ff8fab'];
const meta = s => (s.r ? { r: s.r, t: s.t } : {});
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
    if (!s) continue;
    if (s.kind === 'img') {                                   // 사진 (좌표·크기만 저장, 그림 자체는 이 기기의 IndexedDB)
      if (!['x', 'y', 'w', 'h'].every(k => isFinite(s[k]))) continue;
      out.push({ id: String(s.id || uid()).replace(/[^\w-]/g, '').slice(0, 24) || uid(), kind: 'img', bid: String(s.bid || '').replace(/[^\w-]/g, '').slice(0, 40),
        x: +s.x, y: +s.y, w: clamp(+s.w, 4, 4000), h: clamp(+s.h, 4, 4000), rot: isFinite(s.rot) ? +s.rot : 0 });
      continue;
    }
    if (!Array.isArray(s.pts)) continue;
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
      ...(typeof s.r === 'string' && isFinite(s.t) ? { r: s.r.replace(/[^\w-]/g, '').slice(0, 24), t: Math.max(0, Math.round(+s.t)) } : {}),
    });
  }
  return out;
}

/* ---------- 상태 ---------- */
let ctx = null;                 // { page, scroller, changed(), toast(), onActive() }
let doc = null, strokes = [];
let active = false, tool = 'pen';
const sel = new Set();
const st = { er: 9, emode: 'stroke', color: '#161616', hcolor: '#ffd43b', pw: 3, hw: 16, partial: 'whole' };
let hist = [], hi = -1;
let scale = 1;
let svg, gI, gS, gU, gC, bar;
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
const urls = new Map();
function loadUrl(bid) {
  if (urls.has(bid)) return Promise.resolve(urls.get(bid));
  return idbGet(bid).then(rec => { const u = rec && rec.blob ? URL.createObjectURL(rec.blob) : null; if (u) urls.set(bid, u); return u; }).catch(() => null);
}
function paintImg(s) {
  let g = els.get(s.id);
  if (!g) {
    g = el('g'); g.dataset.id = s.id; gI.append(g); els.set(s.id, g);
    g.append(el('image', { preserveAspectRatio: 'none' }), el('rect', { fill: '#ececea', stroke: '#b5b5b0', 'stroke-dasharray': '6 4', display: 'none' }), el('text', { 'text-anchor': 'middle', fill: '#8c8c88', 'font-size': 13, display: 'none' }));
  }
  const [im, rc, tx] = g.children;
  g.setAttribute('transform', s.rot ? `rotate(${s.rot} ${s.x + s.w / 2} ${s.y + s.h / 2})` : '');
  [im, rc].forEach(n => { n.setAttribute('x', s.x); n.setAttribute('y', s.y); n.setAttribute('width', s.w); n.setAttribute('height', s.h); });
  tx.setAttribute('x', s.x + s.w / 2); tx.setAttribute('y', s.y + s.h / 2);
  tx.textContent = '사진이 이 기기에 없어요';
  if (g.dataset.bid !== s.bid) {
    g.dataset.bid = s.bid;
    loadUrl(s.bid).then(u => {
      if (g.dataset.bid !== s.bid) return;
      if (u) { im.setAttribute('href', u); im.removeAttribute('display'); rc.setAttribute('display', 'none'); tx.setAttribute('display', 'none'); }
      else { im.setAttribute('display', 'none'); rc.removeAttribute('display'); tx.removeAttribute('display'); }
    });
  }
}
function paint(s) {
  if (s.kind === 'img') return paintImg(s);
  let e = els.get(s.id);
  if (!e) { e = el('path'); e.dataset.id = s.id; gS.append(e); els.set(s.id, e); }
  e.setAttribute('d', outline(s));
  e.setAttribute('fill', s.color); e.setAttribute('stroke', s.color);
  e.setAttribute('stroke-width', '0.8'); e.setAttribute('stroke-linejoin', 'round');
  if (s.tool === 'hl') { e.setAttribute('opacity', '0.38'); e.style.mixBlendMode = 'multiply'; } else { e.removeAttribute('opacity'); e.style.mixBlendMode = ''; }
}
function renderAll() {
  gI.replaceChildren(); gS.replaceChildren(); els.clear();
  strokes.forEach(paint);
  renderUI();
}
function remove(id) { const e = els.get(id); if (e) e.remove(); els.delete(id); }

/* ---------- 선택 UI ---------- */
function corners(s) {
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2, a = (s.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
  return [[-s.w / 2, -s.h / 2], [s.w / 2, -s.h / 2], [s.w / 2, s.h / 2], [-s.w / 2, s.h / 2]].map(([dx, dy]) => [cx + dx * c - dy * sn, cy + dx * sn + dy * c]);
}
function imgHit(s, x, y) {
  const a = -(s.rot || 0) * Math.PI / 180, dx = x - (s.x + s.w / 2), dy = y - (s.y + s.h / 2);
  const rx = dx * Math.cos(a) - dy * Math.sin(a), ry = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(rx) <= s.w / 2 && Math.abs(ry) <= s.h / 2;
}
function bbox(list) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  list.forEach(s => (s.kind === 'img' ? corners(s) : s.pts).forEach(p => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }));
  const pad = list.reduce((m, s) => Math.max(m, s.kind === 'img' ? 0 : s.w / 2), 0) + 3;
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
  [gI, gS, gU, gC].forEach(g => g.setAttribute('transform', `scale(${scale})`));
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
  if (s.kind === 'img') return false;
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
    for (let i = strokes.length - 1; i >= 0; i--) if (hit(strokes[i], x, y, 8)) { sel.add(strokes[i].id); return; }
    for (let i = strokes.length - 1; i >= 0; i--) if (strokes[i].kind === 'img' && imgHit(strokes[i], x, y)) { sel.add(strokes[i].id); return; }
    return;
  }
  const next = [];
  let changed = false;
  strokes.forEach(s => {
    if (s.kind === 'img') {
      const cs = corners(s).concat([[s.x + s.w / 2, s.y + s.h / 2]]);
      if (cs.some(p => inPoly(p[0], p[1], poly)) || poly.some(p => imgHit(s, p[0], p[1]))) sel.add(s.id);
      next.push(s); return;
    }
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
      const ns = { id: uid(), tool: s.tool, color: s.color, w: s.w, ...meta(s), pts: s.pts.slice(a, b + 1).map(p => p.slice()) };
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
  if (erasing) { drag = { type: 'erase', hit: false, last: null }; eraseTo(x, y); cursor(x, y); return; }
  if (tool === 'listen') {                                   // 획을 누르면 녹음의 그 시점으로
    const t = [...strokes].reverse().find(q => !q.kind && hit(q, x, y, 10));
    if (!t) return;
    if (t.r && t.t != null) ctx.onSeek && ctx.onSeek(t.r, t.t); else ctx.toast('녹음 중에 쓴 필기가 아니에요');
    return;
  }
  if (tool === 'select') {
    const hd = e.target && e.target.dataset ? e.target.dataset.h : null;
    const list = selList();
    if (hd && list.length) {
      const b = bbox(list);
      const orig = new Map(list.map(s => [s.id, s.kind === 'img' ? { x: s.x, y: s.y, w: s.w, h: s.h, rot: s.rot || 0 } : { pts: s.pts.map(p => p.slice()), w: s.w }]));
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
  const rn = ctx.recNow && ctx.recNow();            // 녹음 중이면 이 획이 쓰인 시점을 기록해요
  if (rn) { s.r = rn.rid; s.t = rn.ms; }
  drag = { type: 'draw', s };
  paint(s);
}
function move(e) {
  if (e.pointerType === 'pen') penAt = Date.now();
  if (active && tool === 'erase' && e.pointerType !== 'touch') { const [cx, cy] = pt(e); cursor(cx, cy); }
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
  if (drag.type === 'erase') { eraseTo(x, y); cursor(x, y); return; }
  if (drag.type === 'lasso') { drag.pts.push([x, y]); renderUI(); return; }
  drag.moved = true;
  const list = selList();
  let k = 1, ang = 0;
  if (drag.type === 'scale') k = clamp(Math.hypot(x - drag.ax, y - drag.ay) / drag.d0, 0.1, 10);
  if (drag.type === 'rot') ang = Math.atan2(y - drag.cy, x - drag.cx) - drag.a0;
  const c = Math.cos(ang), sn = Math.sin(ang);
  const f = p => {
    if (drag.type === 'move') return [p[0] + (x - drag.sx), p[1] + (y - drag.sy), p[2]];
    if (drag.type === 'scale') return [drag.ax + (p[0] - drag.ax) * k, drag.ay + (p[1] - drag.ay) * k, p[2]];
    const dx = p[0] - drag.cx, dy = p[1] - drag.cy; return [drag.cx + dx * c - dy * sn, drag.cy + dx * sn + dy * c, p[2]];
  };
  list.forEach(s => {
    const o = drag.orig.get(s.id); if (!o) return;
    if (s.kind === 'img') {
      const m = f([o.x + o.w / 2, o.y + o.h / 2, 0]);
      s.w = drag.type === 'scale' ? clamp(o.w * k, 4, 4000) : o.w; s.h = drag.type === 'scale' ? clamp(o.h * k, 4, 4000) : o.h;
      s.x = m[0] - s.w / 2; s.y = m[1] - s.h / 2; s.rot = o.rot + (drag.type === 'rot' ? ang * 180 / Math.PI : 0);
    } else {
      if (drag.type === 'scale') s.w = clamp(o.w * k, 0.5, 80);
      s.pts = o.pts.map(f);
    }
    paint(s);
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
  if (d.type === 'erase') { if (d.hit) { renderAll(); commit(); } return; }
  if (d.type === 'lasso') { applyLasso(d.pts); renderUI(); syncBar(); return; }
  if (d.moved) { selList().forEach(s => { if (s.kind === 'img') { ['x', 'y', 'w', 'h', 'rot'].forEach(k => { s[k] = Math.round(s[k] * 10) / 10; }); } else s.pts = roundPts(s.pts); }); renderAll(); commit(); }
}
function densify(pts) {
  const o = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.5));
    for (let k = 1; k <= n; k++) { const t = k / n; o.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
  }
  return o;
}
function erasePart(s, x, y, r) {       // 지우개가 닿은 부분만 도려내고 나머지 조각을 돌려줘요 (안 닿았으면 null)
  if (!hit(s, x, y, r)) return null;
  const D = densify(s.pts), rr = r + s.w / 4;
  const keep = D.map(p => Math.hypot(p[0] - x, p[1] - y) > rr);
  if (keep.every(Boolean)) return null;
  const pieces = []; let cur = [];
  D.forEach((p, i) => { if (keep[i]) cur.push(p); else { if (cur.length) pieces.push(cur); cur = []; } });
  if (cur.length) pieces.push(cur);
  return pieces.filter(c => c.length >= 2).map(c => ({ id: uid(), tool: s.tool, color: s.color, w: s.w, ...meta(s), pts: c }));
}
function eraseAt(x, y) {
  const r = st.er;
  let touched = false;
  if (st.emode === 'stroke') {
    const dead = strokes.filter(s => hit(s, x, y, r));
    if (!dead.length) return;
    dead.forEach(s => { remove(s.id); sel.delete(s.id); });
    strokes = strokes.filter(s => !dead.includes(s)); touched = true;
  } else {
    const next = [];
    strokes.forEach(s => {
      const parts = erasePart(s, x, y, r);
      if (!parts) { next.push(s); return; }
      touched = true; remove(s.id); sel.delete(s.id);
      parts.forEach(p => { next.push(p); paint(p); });
    });
    if (touched) strokes = next;
  }
  if (!touched) return;
  doc.ink = strokes; drag.hit = true;
}
function eraseTo(x, y) {                // 빠르게 움직여도 빠짐없이 지워지도록 사이를 채워요
  const l = drag.last;
  if (l) {
    const d = Math.hypot(x - l[0], y - l[1]), n = Math.ceil(d / Math.max(2, st.er / 2));
    for (let k = 1; k < n; k++) eraseAt(l[0] + (x - l[0]) * k / n, l[1] + (y - l[1]) * k / n);
  }
  eraseAt(x, y); drag.last = [x, y];
}
function cursor(x, y) {
  gC.replaceChildren();
  if (x == null || tool !== 'erase' || !active) return;
  gC.append(el('circle', { cx: x, cy: y, r: st.er, fill: 'rgba(255,255,255,.35)', stroke: '#555', 'stroke-width': 1.2 / scale, 'pointer-events': 'none' }));
}

/* ---------- 선택 편집 ---------- */
function delSel() { if (!sel.size) return; strokes = strokes.filter(s => !sel.has(s.id)); sel.clear(); doc.ink = strokes; renderAll(); commit(); }
function dup(s, off) {
  if (s.kind === 'img') return { id: uid(), kind: 'img', bid: s.bid, x: s.x + off, y: s.y + off, w: s.w, h: s.h, rot: s.rot || 0 };
  return { id: uid(), tool: s.tool, color: s.color, w: s.w, ...meta(s), pts: s.pts.map(p => [p[0] + off, p[1] + off, p[2]]) };
}
function cloneSel(off) {
  const list = selList(); if (!list.length) return;
  sel.clear();
  list.forEach(s => { const c = dup(s, off); strokes.push(c); sel.add(c.id); });
  doc.ink = strokes; renderAll(); commit();
}
function copySel() { const l = selList(); if (l.length) { clip = JSON.parse(JSON.stringify(l)); pasteN = 0; ctx.toast('복사했어요'); } }
function paste() {
  if (!clip) return;
  pasteN++; sel.clear();
  clip.forEach(s => { const c = dup(s, 20 * pasteN); strokes.push(c); sel.add(c.id); });
  doc.ink = strokes; setTool('select'); renderAll(); commit();
}
function styleSel(patch, final) {            // 스타일 변경: 선택한 획 전체에 적용
  const list = selList(); if (!list.length) return;
  list.forEach(s => {
    if (s.kind) return;
    if (patch.color) s.color = patch.color;
    if (patch.w) s.w = patch.w;
    if (patch.tool && patch.tool !== s.tool) { s.tool = patch.tool; s.w = patch.tool === 'hl' ? Math.max(s.w, 14) : Math.min(s.w, 6); }
    paint(s);
  });
  renderUI();
  if (final) commit();
}

/* ---------- 도구 줄 ---------- */
const TOOLS = [['pen', '펜'], ['hl', '형광펜'], ['erase', '지우개'], ['select', '선택'], ['listen', '듣기']];
function buildBar() {
  bar = $bar();
  const mk = (t, l) => h('button', { class: 'tb tool', 'data-tool': t, text: l, onclick: () => setTool(t) });
  const colorBtns = COLORS.map(c => h('button', { class: 'sw-ink', 'data-c': c, style: `background:${c}`, 'aria-label': c, onclick: () => setColor(c) }));
  const colorIn = h('input', { type: 'color', class: 'ink-color', value: '#161616', 'aria-label': '색 직접 고르기', oninput: e => setColor(e.target.value, false), onchange: e => setColor(e.target.value, true) });
  const wIn = h('input', { type: 'range', min: 1, max: 40, step: 1, value: 3, class: 'ink-w', 'aria-label': '굵기', oninput: e => setWidth(+e.target.value, false), onchange: e => setWidth(+e.target.value, true) });
  const partial = h('select', { class: 'ink-partial', title: '올가미가 획의 일부만 걸쳤을 때', onchange: e => { st.partial = e.target.value; } },
    h('option', { value: 'whole', text: '부분 선택: 획 전체' }), h('option', { value: 'cut', text: '부분 선택: 잘라서' }));
  const emode = h('select', { class: 'ink-emode', title: '지우개 방식', onchange: e => { st.emode = e.target.value; } },
    h('option', { value: 'stroke', text: '획 지우기' }), h('option', { value: 'part', text: '부분 지우기' }));
  bar.replaceChildren(
    ...TOOLS.map(([t, l]) => mk(t, l)), h('i', { class: 'sep' }),
    ...colorBtns, colorIn, h('span', { class: 'ink-wl', text: '굵기' }), wIn, h('span', { class: 'ink-wv', text: '3' }),
    h('i', { class: 'sep' }), emode, partial,
    h('span', { class: 'ink-selact' },
      h('button', { class: 'tb stylebtn', text: '펜으로', title: '선택한 획을 펜으로', onclick: () => styleSel({ tool: 'pen' }, true) }),
      h('button', { class: 'tb stylebtn', text: '형광펜으로', title: '선택한 획을 형광펜으로', onclick: () => styleSel({ tool: 'hl' }, true) }),
      h('button', { class: 'tb', text: '복제', onclick: () => cloneSel(18) }),
      h('button', { class: 'tb danger', text: '삭제', onclick: delSel })),
    h('i', { class: 'sep' }),
    h('button', { class: 'tb', text: '사진', title: '사진 넣기', onclick: () => E.pickImage() }),
    h('button', { class: 'tb', text: 'PDF', title: 'PDF 불러오기', onclick: () => window.EDPDF && EDPDF.pick() }),
    h('button', { class: 'tb', 'data-k': 'undo', text: '↶', title: '필기 실행 취소', onclick: undo }),
    h('button', { class: 'tb', 'data-k': 'redo', text: '↷', title: '필기 다시 실행', onclick: redo }),
    h('button', { class: 'tb done', text: '필기 끝내기', onclick: () => E.setActive(false) }),
  );
  bar.addEventListener('mousedown', e => { if (e.target.closest('.tb,.sw-ink')) e.preventDefault(); });
}
const $bar = () => document.getElementById('inkBar');
function setTool(t) {
  tool = t; cursor(); if (t !== 'select') sel.clear();
  renderUI(); syncBar();
  svg.style.cursor = t === 'select' ? 'default' : t === 'erase' ? 'cell' : t === 'listen' ? 'pointer' : 'crosshair';
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
  else if (tool === 'erase') st.er = w;
  else if (tool === 'hl') st.hw = w; else st.pw = w;
  bar.querySelector('.ink-wv').textContent = w;
}
function syncBar() {
  if (!bar) return;
  const all = selList(), list = all.filter(s => !s.kind), has = list.length > 0;
  bar.querySelectorAll('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
  const col = has ? list[0].color : (tool === 'hl' ? st.hcolor : st.color);
  bar.querySelectorAll('.sw-ink').forEach(b => b.classList.toggle('on', b.dataset.c.toLowerCase() === col.toLowerCase()));
  bar.querySelector('.ink-color').value = col;
  const w = has ? Math.round(list[0].w) : Math.round(tool === 'erase' ? st.er : tool === 'hl' ? st.hw : st.pw);
  const wi = bar.querySelector('.ink-w'); wi.value = w; bar.querySelector('.ink-wv').textContent = w;
  bar.querySelector('.ink-emode').style.display = tool === 'erase' ? '' : 'none';
  bar.querySelector('.ink-emode').value = st.emode;
  bar.querySelector('.ink-wl').textContent = tool === 'erase' ? '지우개 크기' : '굵기';
  bar.querySelector('.ink-partial').style.display = tool === 'select' ? '' : 'none';
  bar.querySelector('.ink-selact').style.display = tool === 'select' && all.length ? '' : 'none';
  bar.querySelectorAll('.stylebtn').forEach(b => { b.style.display = has ? '' : 'none'; });
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

/* ---------- 사진 저장소 (IndexedDB: 브라우저 localStorage보다 훨씬 큰 공간) ---------- */
let idbP = null;
function idb() {
  if (!idbP) idbP = new Promise((res, rej) => {
    const r = indexedDB.open('eddytor-img', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('b');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return idbP;
}
const idbPut = (k, v) => idb().then(d => new Promise((res, rej) => { const t = d.transaction('b', 'readwrite'); t.objectStore('b').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }));
const idbGet = k => idb().then(d => new Promise((res, rej) => { const q = d.transaction('b').objectStore('b').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }));

const idbDel = k => idb().then(d => new Promise((res, rej) => { const t = d.transaction('b', 'readwrite'); t.objectStore('b').delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); }));
function setHead(rid, ms) {                  // 재생 중: 아직 안 쓴 획은 흐리게
  strokes.forEach(s => {
    if (s.kind) return; const e = els.get(s.id); if (!e) return;
    e.style.opacity = (rid == null || s.r !== rid || s.t == null || s.t <= ms) ? '' : '0.12';
  });
}
async function shrink(file) {                 // 긴 변 1600px 이하로 줄여서 저장 (용량 절약)
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), hh = Math.max(1, Math.round(bmp.height * k));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = hh;
  const g = cv.getContext('2d');
  const png = file.type === 'image/png' || file.type === 'image/gif' || file.type === 'image/webp';
  if (!png) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, hh); }
  g.drawImage(bmp, 0, 0, w, hh);
  const blob = await new Promise(r => cv.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.86));
  return { blob, w, h: hh };
}
async function addImages(files) {
  if (!doc) return;
  let n = 0; const ids = [];
  for (const f of files) {
    if (!/^image\//.test(f.type)) continue;
    try {
      const { blob, w, h: hh } = await shrink(f);
      const bid = uid() + uid();
      await idbPut(bid, { blob });
      const W = ctx.page.offsetWidth / scale || BASE;
      const dw = Math.min(w, 360), dh = dw * hh / w;
      const sr = ctx.scroller.getBoundingClientRect(), r = svg.getBoundingClientRect();
      const cy = Math.max(40, (sr.top + sr.height / 2 - r.top) / scale);
      const it = { id: uid(), kind: 'img', bid, x: Math.round((W - dw) / 2 + n * 24), y: Math.round(Math.max(0, cy - dh / 2) + n * 24), w: Math.round(dw), h: Math.round(dh), rot: 0 };
      strokes.push(it); ensureRoom(it.y + it.h); n++;
      ids.push(it.id);
    } catch (e) { ctx.toast('사진을 불러오지 못했어요'); }
  }
  if (!n) return;
  doc.ink = strokes;
  if (!active) E.setActive(true);
  setTool('select'); sel.clear(); ids.forEach(i => sel.add(i)); renderAll(); commit();
  ctx.toast('사진을 넣었어요. 끌어서 옮기고 모서리로 크기를 바꿔요');
}
function nextY() {                          // 문서 글 아래, 이미 놓은 그림 아래의 빈 자리
  const W = ctx.page.offsetWidth / scale || BASE;
  const ed = ctx.page.querySelector('#editor');
  let y = (ed.getBoundingClientRect().bottom - ctx.page.getBoundingClientRect().top) / scale;
  strokes.forEach(s => { if (s.kind === 'img') y = Math.max(y, s.y + s.h); });
  return Math.round(y + 16);
}
function ensureHeight(y) { if (!doc) return; doc.inkH = Math.max(doc.inkH || 0, Math.ceil(y + 80)); applyHeight(); ctx.changed(); }
function addHighlights(rects) {             // [[x0, x1, yMid, height], ...] (페이지 좌표) → 형광펜 획
  if (!doc || !rects.length) return;
  const rn = ctx.recNow && ctx.recNow();
  rects.forEach(([x0, x1, y, hh]) => strokes.push({ id: uid(), tool: 'hl', color: st.hcolor, w: Math.max(4, Math.round(hh * 10) / 10), pts: [[Math.round(x0 * 10) / 10, Math.round(y * 10) / 10, .5], [Math.round(x1 * 10) / 10, Math.round(y * 10) / 10, .5]], ...(rn ? { r: rn.rid, t: rn.ms } : {}) }));
  doc.ink = strokes; renderAll(); commit();
}
async function placePages(pages) {           // PDF 쪽(그림)을 문서 아래에 쭉 이어서 놓기
  if (!doc || !pages.length) return;
  const W = ctx.page.offsetWidth / scale || BASE;
  const ed = ctx.page.querySelector('#editor');
  let y = (ed.getBoundingClientRect().bottom - ctx.page.getBoundingClientRect().top) / scale;
  strokes.forEach(s => { if (s.kind === 'img') y = Math.max(y, s.y + s.h); });
  y = Math.round(y + 16);
  const y0 = y;
  for (const pg of pages) {
    const bid = uid() + uid();
    await idbPut(bid, { blob: pg.blob });
    const dh = W * pg.h / pg.w;
    strokes.push({ id: uid(), kind: 'img', bid, x: 0, y: Math.round(y), w: Math.round(W), h: Math.round(dh), rot: 0 });
    y += dh + 14;
  }
  doc.ink = strokes; doc.inkH = Math.max(doc.inkH || 0, Math.ceil(y + 80)); applyHeight();
  renderAll(); commit();
  const r = svg.getBoundingClientRect(), sr = ctx.scroller.getBoundingClientRect();
  ctx.scroller.scrollTop += (r.top + y0 * scale) - sr.top - 24;
}
let fileIn = null;
function pickImage() {
  if (!doc) return;
  if (!fileIn) {
    fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none' });
    fileIn.onchange = () => { addImages([...fileIn.files]); fileIn.value = ''; };
    document.body.append(fileIn);
  }
  fileIn.click();
}
document.addEventListener('paste', e => {      // 필기 모드에서 클립보드의 사진 붙여넣기
  if (!active) return;
  const fs = [...((e.clipboardData && e.clipboardData.files) || [])].filter(f => /^image\//.test(f.type));
  if (fs.length) { e.preventDefault(); addImages(fs); }
});
const toDataURL = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
async function collectImages(items) {           // 백업 파일에 사진도 같이 담기
  const out = {};
  for (const it of Object.values(items)) for (const s of it.ink || []) {
    if (s.kind === 'img' && s.bid && !out[s.bid]) { const rec = await idbGet(s.bid).catch(() => null); if (rec && rec.blob) out[s.bid] = await toDataURL(rec.blob); }
  }
  return out;
}
async function importImages(map) {
  for (const [bid, url] of Object.entries(map || {})) {
    if (!/^[\w-]{1,40}$/.test(bid) || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(url)) continue;
    const blob = await (await fetch(url)).blob();
    await idbPut(bid, { blob });
  }
}

/* ---------- 바깥에서 쓰는 함수 ---------- */
const E = window.EDINK = {
  currentDoc: () => doc, nextY, ensureHeight, addHighlights, placePages, hasDoc: () => !!doc,
  store: { put: idbPut, get: idbGet, del: idbDel }, setHead,
  clean, pickImage, collectImages, importImages,
  init(c) {
    ctx = c;
    svg = el('svg', { id: 'ink', 'aria-hidden': 'true' });
    gS = el('g'); gU = el('g');
    gI = el('g'); gC = el('g'); svg.append(gI, gS, gU, gC); ctx.page.append(svg);
    svg.addEventListener('pointerdown', down);
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    svg.addEventListener('pointerleave', () => cursor());
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
  unload() { E.setActive(false); doc = null; strokes = []; sel.clear(); gI && gI.replaceChildren(); gS && gS.replaceChildren(); gU && gU.replaceChildren(); ctx && ctx.page.style.removeProperty('--ink-h'); },
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
