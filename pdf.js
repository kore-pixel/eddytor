/* eddytor — PDF 불러오기
   방식 ① 글자를 살려서(권장): PDF 원본을 이 기기에 한 번 저장하고, 보이는 쪽만 그려요. 그 위에 글자 층이 겹쳐서
            글자 선택·복사, 형광펜 칠하기, PDF 안 검색이 돼요.
   방식 ② 그림으로: 각 쪽을 그림으로 바꿔 사진처럼 옮기고 지울 수 있어요. (스캔본·자유 배치용)
   PDF 읽기: Mozilla pdf.js (vendor/pdfjs/, Apache-2.0) */
(() => {
'use strict';
const BASE = 780, GAP = 14, MAX_IMG_PAGES = 80, MAX_TEXT_PAGES = 600, MAX_BYTES = 150 * 1024 * 1024;
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const h = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k.startsWith('on')) e[k] = v; else if (k === 'text') e.textContent = v; else if (v != null && v !== false) e.setAttribute(k, v); }
  kids.flat().forEach(c => c != null && e.append(c));
  return e;
};
let ctx = null, fileIn = null, busy = false, loading = null;
let doc = null, blocks = [], io = null, ro = null, roT = null;
const visible = new Set();
const cache = new Map();          // pid → pdf.js 문서
const texts = new Map();          // pid:n → 글자 (검색용)
let hlBtn = null, hlT = null;

/* ---------- pdf.js 불러오기 (처음 쓸 때만) ---------- */
function loadLib() {
  if (window.pdfjsLib) return Promise.resolve();
  if (!loading) loading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/pdfjs/pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.js', location.href).href; res(); };
    s.onerror = () => { loading = null; rej(new Error('lib')); };
    document.head.append(s);
  });
  return loading;
}
const openData = data => window.pdfjsLib.getDocument({ data, cMapUrl: new URL('vendor/pdfjs/cmaps/', location.href).href, cMapPacked: true }).promise;
function getPdf(pid) {
  if (!cache.has(pid)) {
    const p = (async () => {
      await loadLib();
      const rec = await EDINK.store.get('pdf-' + pid);
      if (!rec || !rec.blob) throw new Error('missing');
      return openData(new Uint8Array(await rec.blob.arrayBuffer()));
    })();
    p.catch(() => cache.delete(pid));
    cache.set(pid, p);
  }
  return cache.get(pid);
}

/* ---------- 데이터 정리 ---------- */
function clean(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const p of arr.slice(0, 20)) {
    if (!p || !Array.isArray(p.pages) || !isFinite(p.y)) continue;
    const pages = p.pages.slice(0, MAX_TEXT_PAGES).filter(q => q && isFinite(q.n) && isFinite(q.w) && isFinite(q.h) && q.w > 0 && q.h > 0).map(q => ({ n: Math.round(+q.n), w: +q.w, h: +q.h }));
    if (!pages.length) continue;
    out.push({ id: String(p.id || uid()).replace(/[^\w-]/g, '').slice(0, 24), pid: String(p.pid || '').replace(/[^\w-]/g, '').slice(0, 40), name: String(p.name || 'PDF').slice(0, 120), y: +p.y, pages, ...(p.gap === 0 ? { gap: 0 } : {}) });
  }
  return out;
}
const gapOf = p => (p.gap === 0 ? 0 : GAP);
const pageH = q => BASE * q.h / q.w;
const blockH = p => p.pages.reduce((a, q) => a + pageH(q) + gapOf(p), 0);

/* ---------- 화면에 놓기 (보이는 쪽만 그려요) ---------- */
const sc = () => (ctx.page.offsetWidth || BASE) / BASE;
function unmount() {
  blocks.forEach(b => b.el.remove()); blocks = []; visible.clear();
  if (io) io.disconnect();
}
function mount() {
  unmount();
  if (!doc || !(doc.pdfs && doc.pdfs.length)) return;
  io = new IntersectionObserver(es => es.forEach(e => {
    const b = e.target;
    if (e.isIntersecting) { visible.add(b); renderPg(b); } else { visible.delete(b); freePg(b); }
  }), { root: ctx.scroller, rootMargin: '900px 0px' });
  doc.pdfs.forEach(p => {
    const el = h('div', { class: 'pdfblk' });
    const del = h('button', { class: 'pdfdel', text: 'PDF 삭제', title: p.name, onclick: () => removePdf(p) });
    const boxes = p.pages.map((q, i) => {
      const b = h('div', { class: 'pdfpg' }); b._p = p; b._q = q;
      if (i === 0) b.append(del);
      el.append(b); io.observe(b);
      return b;
    });
    ctx.page.append(el);
    blocks.push({ el, p, boxes });
  });
  layout();
}
function layout() {
  const s = sc();
  blocks.forEach(({ el, p, boxes }) => {
    el.style.top = p.y * s + 'px';
    boxes.forEach(b => { b.style.height = pageH(b._q) * s + 'px'; b.style.marginBottom = gapOf(p) * s + 'px'; });
  });
}
function freePg(b) { b._g = (b._g || 0) + 1; b._r = false; [...b.children].forEach(c => { if (!c.classList.contains('pdfdel')) c.remove(); }); }
async function renderPg(b) {
  if (b._r) return; b._r = true;
  const g = b._g = (b._g || 0) + 1;
  try {
    const pdf = await getPdf(b._p.pid);
    const page = await pdf.getPage(b._q.n);
    if (b._g !== g) return;
    const cssW = b.clientWidth || BASE;
    const vp = page.getViewport({ scale: cssW / page.getViewport({ scale: 1 }).width });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cv = h('canvas'); cv.width = Math.round(vp.width * dpr); cv.height = Math.round(vp.height * dpr);
    cv.style.width = '100%'; cv.style.height = '100%';
    const tl = h('div', { class: 'textLayer' }); tl.style.setProperty('--scale-factor', vp.scale);
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp, transform: [dpr, 0, 0, dpr, 0, 0], background: '#ffffff' }).promise;
    if (b._g !== g) return;
    [...b.children].forEach(c => { if (!c.classList.contains('pdfdel')) c.remove(); });
    b.prepend(cv); b.append(tl);
    const tc = await page.getTextContent();
    if (b._g !== g) return;
    const task = window.pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: [] });
    await task.promise;
  } catch (e) {
    if (b._g !== g) return;
    b._r = false;
    if (e && e.message === 'missing') { [...b.children].forEach(c => { if (!c.classList.contains('pdfdel')) c.remove(); }); b.append(h('div', { class: 'pdfmiss', text: '이 기기에 PDF 파일이 없어요' })); }
    else console.warn('pdf page', e);
  }
}
async function removePdf(p) {
  if (!await ctx.confirm('PDF 삭제', `“${p.name}”을(를) 이 문서에서 지울까요? 그 위에 쓴 필기는 남아요.`, true)) return;
  doc.pdfs = doc.pdfs.filter(x => x !== p);
  if (!doc.pdfs.some(x => x.pid === p.pid)) { await EDINK.store.del('pdf-' + p.pid).catch(() => {}); cache.delete(p.pid); }
  ctx.touch(doc); mount(); toggleFind();
}
function toggleFind() { const b = document.getElementById('btnPdfFind'); if (b) b.hidden = !(doc && doc.pdfs && doc.pdfs.length); }

/* ---------- 글자 선택 → 형광펜 칠하기 ---------- */
function selRects() {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  const a = r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentElement : r.commonAncestorContainer;
  if (!a || !(a.closest && (a.closest('.textLayer') || a.querySelector && a.querySelector('.textLayer')))) return null;
  const pr = ctx.page.getBoundingClientRect(), s = sc();
  const list = [...r.getClientRects()].filter(q => q.width > 2 && q.height > 2 && q.height < 120);
  return list.map(q => [(q.left - pr.left) / s, (q.right - pr.left) / s, ((q.top + q.bottom) / 2 - pr.top) / s, q.height / s]);
}
function updateHlBtn() {
  clearTimeout(hlT);
  hlT = setTimeout(() => {
    const rs = doc && selRects();
    if (!rs || !rs.length) { hlBtn.hidden = true; return; }
    const q = getSelection().getRangeAt(0).getBoundingClientRect();
    hlBtn.style.left = Math.max(8, Math.min(innerWidth - 110, q.left)) + 'px';
    hlBtn.style.top = Math.max(8, q.top - 46) + 'px';
    hlBtn.hidden = false;
  }, 250);
}

/* ---------- PDF 안 검색 ---------- */
async function pageText(p, q) {
  const k = p.pid + ':' + q.n;
  if (texts.has(k)) return texts.get(k);
  const pdf = await getPdf(p.pid), pg = await pdf.getPage(q.n), tc = await pg.getTextContent();
  const t = tc.items.map(i => i.str).join(' ').replace(/\s+/g, ' ');
  texts.set(k, t); return t;
}
function searchDialog() {
  if (!doc || !(doc.pdfs && doc.pdfs.length)) return;
  const inp = h('input', { type: 'text', placeholder: 'PDF에서 찾을 말', autocomplete: 'off' });
  const res = h('div', { class: 'pdfres' });
  let run = 0;
  const go = async () => {
    const q = inp.value.trim().toLowerCase(), my = ++run;
    res.replaceChildren();
    if (!q) return;
    res.append(h('div', { class: 'note', text: '찾는 중…' }));
    const hits = []; let done = 0, total = doc.pdfs.reduce((a, p) => a + p.pages.length, 0);
    try {
      for (const p of doc.pdfs) for (const pg of p.pages) {
        if (my !== run) return;
        const t = await pageText(p, pg); done++;
        const i = t.toLowerCase().indexOf(q);
        if (i >= 0) hits.push({ p, pg, snip: (i > 24 ? '…' : '') + t.slice(Math.max(0, i - 24), i + q.length + 50) });
        if (hits.length >= 100) break;
      }
    } catch (e) { res.replaceChildren(h('div', { class: 'note', text: '이 기기에 PDF 파일이 없거나 읽을 수 없어요.' })); return; }
    if (my !== run) return;
    res.replaceChildren();
    if (!hits.length) { res.append(h('div', { class: 'note', text: '찾는 말이 없어요. (스캔본 PDF는 글자가 없어서 검색되지 않아요)' })); return; }
    hits.forEach(({ p, pg, snip }) => res.append(h('button', {
      class: 'pdfhit', onclick: () => {
        ctx.closeDialog();
        const blk = blocks.find(b => b.p === p); const box = blk && blk.boxes.find(b => b._q === pg);
        if (box) ctx.scroller.scrollTop += box.getBoundingClientRect().top - ctx.scroller.getBoundingClientRect().top - 60;
      },
    }, h('b', { text: (p.pages.indexOf(pg) + 1) + '쪽 ' }), h('span', { text: snip }))));
  };
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
  ctx.dialog({ title: 'PDF 검색', body: [inp, res], actions: [{ label: '닫기', value: 'cancel' }, { label: '찾기', cls: 'primary', onClick: () => { go(); return false; } }] });
}

/* ---------- 불러오기 ---------- */
function parseRange(txt, n) {                 // "1-5, 8" → [1,2,3,4,5,8]
  const out = new Set();
  String(txt || '').split(/[,\s]+/).filter(Boolean).forEach(part => {
    const m = part.match(/^(\d+)(?:-(\d+))?$/); if (!m) return;
    let a = +m[1], b = m[2] ? +m[2] : a; if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(n, b); i++) out.add(i);
  });
  return [...out].sort((x, y) => x - y);
}
async function importFile(file) {
  if (busy) return;
  if (!EDINK.hasDoc()) { ctx.toast('문서를 먼저 열어 주세요'); return; }
  if (file.size > MAX_BYTES) { ctx.toast('PDF가 너무 커요 (150MB 이하만 가능)'); return; }
  busy = true;
  try {
    const mode = await ctx.dialog({
      title: 'PDF 불러오기',
      body: [h('div', { class: 'note', text: `“${file.name}”` }),
        h('div', { class: 'note', text: '글자를 살려서: 글자 선택·복사, 형광펜 칠하기, PDF 안 검색이 돼요. 쪽은 위아래로 이어 붙고 옮길 수 없어요.' }),
        h('div', { class: 'note', text: '그림으로: 각 쪽이 사진처럼 바뀌어 자유롭게 옮기고 지울 수 있어요. 글자 선택은 안 돼요. 스캔한 PDF에 알맞아요.' })],
      actions: [{ label: '취소', value: 'cancel' }, { label: '그림으로', value: 'img' }, { label: '글자를 살려서', cls: 'primary', value: 'text' }],
    });
    if (mode !== 'text' && mode !== 'img') { busy = false; return; }
    ctx.toast('PDF를 여는 중…');
    await loadLib();
    const buf = new Uint8Array(await file.arrayBuffer());
    const pdf = await openData(buf.slice());
    const n = pdf.numPages, cap = mode === 'text' ? MAX_TEXT_PAGES : MAX_IMG_PAGES;
    const ans = n > 1 ? await ctx.ask(`PDF ${n}쪽 — 가져올 쪽 (예: 1-10, 3, 5-7 · 비우면 ${n <= cap ? '전체' : '처음 ' + cap + '쪽'})`, '') : '';
    if (ans == null) { busy = false; return; }
    let list = ans.trim() ? parseRange(ans, n) : Array.from({ length: Math.min(n, cap) }, (_, i) => i + 1);
    if (!list.length) { ctx.toast('가져올 쪽 번호를 확인해 주세요'); busy = false; return; }
    if (list.length > cap) { list = list.slice(0, cap); ctx.toast(`한 번에 ${cap}쪽까지만 가져와요`); }

    if (mode === 'text') {
      const dims = [];
      for (const k of list) { const pg = await pdf.getPage(k); const v = pg.getViewport({ scale: 1 }); dims.push({ n: k, w: v.width, h: v.height }); pg.cleanup(); }
      const pid = uid() + uid();
      await EDINK.store.put('pdf-' + pid, { blob: new Blob([buf], { type: 'application/pdf' }) });
      const d = EDINK.currentDoc();
      d.pdfs = d.pdfs || [];
      let y = EDINK.nextY();
      d.pdfs.forEach(p => { y = Math.max(y, p.y + blockH(p)); });
      const sl = window.EDPAGE && EDPAGE.info(d);       // 쪽 모드이고 PDF 쪽 비율이 같으면 쪽 칸에 딱 맞춰요
      const fit = sl && dims.every(q => Math.abs(q.h / q.w / sl.ratio - 1) < 0.03);
      if (fit) y = Math.ceil(y / sl.PH) * sl.PH;
      const entry = { id: uid(), pid, name: file.name.replace(/\.pdf$/i, ''), y: Math.round(y), pages: dims, ...(fit ? { gap: 0 } : {}) };
      d.pdfs.push(entry);
      EDINK.ensureHeight(entry.y + blockH(entry));
      ctx.touch(d); mount(); toggleFind();
      ctx.scroller.scrollTop += ctx.page.getBoundingClientRect().top + entry.y * sc() - ctx.scroller.getBoundingClientRect().top - 24;
      ctx.toast(`PDF ${dims.length}쪽을 넣었어요. 글자를 선택하면 형광펜으로 칠할 수 있고, ✎ 필기로 위에 쓸 수 있어요`);
    } else {
      const pages = [];
      for (let i = 0; i < list.length; i++) {
        ctx.toast(`PDF 변환 중… ${i + 1} / ${list.length}`);
        const page = await pdf.getPage(list[i]);
        const vp1 = page.getViewport({ scale: 1 });
        const k = Math.min(1600 / vp1.width, 3200 / vp1.height);
        const vp = page.getViewport({ scale: k });
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(vp.width)); cv.height = Math.max(1, Math.round(vp.height));
        const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.82));
        pages.push({ blob, w: cv.width, h: cv.height });
        page.cleanup(); cv.width = cv.height = 0;
      }
      await EDINK.placePages(pages);
      ctx.toast(`PDF ${pages.length}쪽을 그림으로 넣었어요`);
      if (!EDINK.isActive()) EDINK.setActive(true);
    }
  } catch (e) {
    console.warn('pdf', e);
    ctx.toast(e && e.message === 'lib' ? 'PDF 읽기 도구를 불러오지 못했어요 (vendor 폴더 확인)' : 'PDF를 읽지 못했어요 (암호가 걸렸거나 손상된 파일일 수 있어요)');
  }
  busy = false;
}

/* ---------- 바깥에서 쓰는 함수 ---------- */
window.EDPDF = {
  clean,
  init(c) {
    ctx = c;
    hlBtn = h('button', { id: 'pdfHl', class: 'btn primary', text: '형광펜 칠하기', hidden: true,
      onmousedown: e => e.preventDefault(),
      onclick: () => { const rs = selRects(); if (rs && rs.length) EDINK.addHighlights(rs); getSelection().removeAllRanges(); hlBtn.hidden = true; } });
    document.body.append(hlBtn);
    document.addEventListener('selectionchange', updateHlBtn);
    $find = document.getElementById('btnPdfFind'); if ($find) $find.onclick = searchDialog;
    if (window.ResizeObserver) ro = new ResizeObserver(() => {
      clearTimeout(roT);
      roT = setTimeout(() => { if (!doc) return; layout(); visible.forEach(b => { freePg(b); renderPg(b); }); }, 200);
    }), ro.observe(ctx.page);
  },
  load(d) { doc = d; d.pdfs = clean(d.pdfs); mount(); toggleFind(); },
  unload() { unmount(); doc = null; toggleFind(); if (hlBtn) hlBtn.hidden = true; },
  bottom: p => p.y + blockH(p),
  pageOp(PH, fn) {                           // 쪽 삭제·이동: 쪽 칸에 맞춘 PDF는 한 쪽씩 나눠서 옮기거나 지워요
    if (!doc || !doc.pdfs) return;
    const out = [];
    doc.pdfs.forEach(p => {
      const parts = (p.gap === 0 && p.pages.length > 1) ? p.pages.map((q, i) => ({ ...p, id: uid(), y: p.y + i * PH, pages: [q] })) : [p];
      parts.forEach(e => {
        const r = fn(e.y + blockH(e) / 2);
        if (r === null) return;
        e.y += r; out.push(e);
      });
    });
    const gone = new Set(doc.pdfs.map(p => p.pid).filter(pid => !out.some(e => e.pid === pid)));
    doc.pdfs = out;
    gone.forEach(pid => { EDINK.store.del('pdf-' + pid).catch(() => {}); cache.delete(pid); });
    mount(); toggleFind();
  },
  thumbCanvases() {                          // 쪽 목록 썸네일용: 이미 그려진 PDF 쪽의 캔버스
    if (!doc) return [];
    const pr = ctx.page.getBoundingClientRect(), s = sc(), out = [];
    blocks.forEach(({ boxes }) => boxes.forEach(b => {
      const c = b.querySelector('canvas'); if (!c) return;
      const r = b.getBoundingClientRect();
      out.push({ canvas: c, y: (r.top - pr.top) / s, h: r.height / s });
    }));
    return out;
  },
  async dropDoc(d) { for (const p of d.pdfs || []) await EDINK.store.del('pdf-' + p.pid).catch(() => {}); },
  pick() {
    if (!EDINK.hasDoc()) { ctx.toast('문서를 먼저 열어 주세요'); return; }
    if (!fileIn) {
      fileIn = document.createElement('input'); fileIn.type = 'file'; fileIn.accept = 'application/pdf,.pdf'; fileIn.style.display = 'none';
      fileIn.onchange = () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) importFile(f); };
      document.body.append(fileIn);
    }
    fileIn.click();
  },
};
let $find = null;
})();
