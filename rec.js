/* eddytor — 녹음 + 필기 시점 연동
   · 녹음하는 동안 쓴 글(문단)과 필기(획)에 "녹음의 몇 초 지점인지"를 같이 저장해요.
   · 나중에 글이나 필기를 누르면 녹음이 그 지점부터 재생돼요. (삼성노트의 "녹음하며 필기"와 같은 방식)
   · 녹음 파일은 이 기기의 IndexedDB에 저장돼요. (서버로 동기화되지 않아요) */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const h = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k.startsWith('on')) e[k] = v; else if (k === 'text') e.textContent = v; else if (v != null && v !== false) e.setAttribute(k, v); }
  kids.flat().forEach(c => c != null && e.append(c));
  return e;
};
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const EXT = m => (/mp4|aac/.test(m || '') ? 'm4a' : /ogg/.test(m || '') ? 'ogg' : 'webm');

let ctx = null, store = null;
let doc = null;
let rec = null;                 // 녹음 중 상태
let curId = null, curUrl = null;
let panel, listEl, audio, hi, badge;

/* ---------- 지금 녹음의 몇 ms 지점? (일시정지한 시간은 빼요) ---------- */
function now() {
  if (!rec || rec.paused || !doc || rec.doc !== doc) return null;
  return { rid: rec.rid, ms: Math.max(0, Math.round(performance.now() - rec.t0 - rec.pausedTotal)) };
}
const elapsed = () => (rec ? Math.round((rec.paused ? rec.pauseAt : performance.now()) - rec.t0 - rec.pausedTotal) : 0);

/* ---------- 글(문단)에 시점 표시 ---------- */
function mark(inputType) {
  const n = now(); if (!n) return;
  const sel = getSelection();
  if (!sel.rangeCount) return;
  let node = sel.anchorNode;
  const ed = ctx.editor;
  if (!node || !ed.contains(node)) return;
  while (node && node.parentNode !== ed) node = node.parentNode;
  if (!node || node.nodeType !== 1) return;
  const cur = node.getAttribute('data-rec');
  if (!cur || cur.split(':')[0] !== n.rid || inputType === 'insertParagraph') node.setAttribute('data-rec', n.rid + ':' + n.ms);
}

/* ---------- 녹음 시작 / 정지 ---------- */
async function start() {
  if (!doc) return;
  if (rec) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) { ctx.toast('이 브라우저는 녹음을 지원하지 않아요'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { ctx.toast('마이크 권한을 허용해 주세요'); return; }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(m => MediaRecorder.isTypeSupported(m)) || '';
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  rec = { rid: uid(), mr, stream, chunks: [], doc, t0: performance.now(), paused: false, pauseAt: 0, pausedTotal: 0, mime: mr.mimeType || mime || 'audio/webm', timer: null, lock: null };
  mr.ondataavailable = e => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  mr.onstart = () => { rec.t0 = performance.now(); };
  mr.onstop = finish;
  mr.start(2000);
  try { if (navigator.wakeLock) rec.lock = await navigator.wakeLock.request('screen'); } catch (e) { /* 화면 켜두기는 못 해도 녹음은 계속 */ }
  rec.timer = setInterval(tick, 250);
  ui();
}
function stop() { if (rec && rec.mr.state !== 'inactive') rec.mr.stop(); }
function togglePause() {
  if (!rec) return;
  if (!rec.paused) { rec.mr.pause(); rec.paused = true; rec.pauseAt = performance.now(); }
  else { rec.mr.resume(); rec.pausedTotal += performance.now() - rec.pauseAt; rec.paused = false; }
  ui();
}
async function finish() {
  const r = rec; rec = null;
  clearInterval(r.timer);
  r.stream.getTracks().forEach(t => t.stop());
  try { r.lock && r.lock.release(); } catch (e) { /* 무시 */ }
  const dur = Math.round((r.paused ? r.pauseAt : performance.now()) - r.t0 - r.pausedTotal);
  const blob = new Blob(r.chunks, { type: r.mime });
  const d = r.doc;
  try {
    await store.put('rec-' + r.rid, { blob });
    d.recs = d.recs || [];
    const t = new Date();
    d.recs.push({ id: r.rid, name: '녹음 ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'), at: Date.now(), dur, mime: r.mime });
    ctx.touch(d);
    ctx.toast('녹음을 저장했어요 (' + mmss(dur) + ')');
  } catch (e) { ctx.toast('녹음을 저장하지 못했어요. 저장 공간을 확인해 주세요'); }
  ui(); renderList();
  if (doc === d) select(r.rid, true);
}
function tick() {
  const t = mmss(elapsed());
  $('#recTime').textContent = t;
  badge.textContent = (rec && rec.paused ? '일시정지 ' : '● 녹음 중 ') + t;
}

/* ---------- 재생 ---------- */
async function select(id, noPlay) {
  if (!doc) return;
  const r = (doc.recs || []).find(x => x.id === id);
  if (!r) return;
  curId = id;
  if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
  const rec0 = await store.get('rec-' + id).catch(() => null);
  if (curId !== id) return;
  if (!rec0 || !rec0.blob) { audio.hidden = true; ctx.toast('이 기기에 녹음 파일이 없어요'); renderList(); return; }
  curUrl = URL.createObjectURL(rec0.blob);
  audio.src = curUrl; audio.hidden = false;
  await fixDuration();
  renderList();
}
function fixDuration() {      // 브라우저가 만든 webm에는 길이 정보가 없어서, 끝으로 한 번 갔다 와서 길이를 알아내요
  return new Promise(res => {
    const done = () => { clearTimeout(to); audio.removeEventListener('loadedmetadata', meta); audio.removeEventListener('timeupdate', back); res(); };
    const to = setTimeout(done, 3000);
    const back = () => { if (isFinite(audio.duration)) { audio.currentTime = 0; done(); } };
    const meta = () => { if (isFinite(audio.duration)) return done(); audio.addEventListener('timeupdate', back); audio.currentTime = 1e101; };
    if (audio.readyState >= 1) meta(); else audio.addEventListener('loadedmetadata', meta, { once: true });
  });
}
async function seek(rid, ms) {
  if (!doc) return;
  if (!(doc.recs || []).some(x => x.id === rid)) { ctx.toast('그 녹음이 이 기기에 없어요'); return; }
  if (panel.hidden) togglePanel(true);
  if (curId !== rid || !audio.src) { await select(rid); if (!audio.src) return; }
  const go = () => { audio.currentTime = Math.max(0, ms / 1000 - 1); audio.play().catch(() => {}); };
  if (audio.readyState >= 1) go(); else audio.addEventListener('loadedmetadata', go, { once: true });
}
function onTime() {
  const ms = audio.currentTime * 1000;
  EDINK.setHead(curId, ms);
  // 지금 재생 중인 문단을 살짝 표시
  let best = null, bt = -1;
  ctx.editor.querySelectorAll(':scope > [data-rec]').forEach(p => {
    const [rid, t] = p.getAttribute('data-rec').split(':');
    if (rid === curId && +t <= ms && +t > bt) { best = p; bt = +t; }
  });
  if (best && !audio.paused) {
    const pr = ctx.page.getBoundingClientRect(), br = best.getBoundingClientRect();
    hi.style.top = (br.top - pr.top) + 'px'; hi.style.height = br.height + 'px'; hi.hidden = false;
  } else hi.hidden = true;
}
function clearHead() { EDINK.setHead(null, 0); hi.hidden = true; }

/* ---------- 화면 ---------- */
function renderList() {
  listEl.replaceChildren();
  const recs = (doc && doc.recs) || [];
  if (!recs.length) { listEl.append(h('div', { class: 'note', text: '이 문서의 녹음이 아직 없어요. 녹음하면서 글이나 필기를 하면 시점이 같이 저장돼요.' })); return; }
  recs.forEach(r => {
    const row = h('div', { class: 'rec-item' + (r.id === curId ? ' on' : ''), onclick: () => select(r.id) },
      h('span', { class: 'nm', text: r.name + ' · ' + mmss(r.dur) }),
      h('button', { class: 'tb', text: '이름', onclick: async e => { e.stopPropagation(); const v = await ctx.ask('녹음 이름', r.name); if (v) { r.name = v; ctx.touch(doc); renderList(); } } }),
      h('button', { class: 'tb', text: '저장', title: '녹음 파일 내려받기', onclick: async e => {
        e.stopPropagation();
        const x = await store.get('rec-' + r.id).catch(() => null);
        if (!x || !x.blob) { ctx.toast('이 기기에 녹음 파일이 없어요'); return; }
        const u = URL.createObjectURL(x.blob), a = h('a', { href: u, download: r.name + '.' + EXT(r.mime) });
        document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
      } }),
      h('button', { class: 'tb danger', text: '삭제', onclick: async e => {
        e.stopPropagation();
        if (!await ctx.confirm('녹음 삭제', `“${r.name}”을(를) 삭제할까요? 글·필기에 남은 시점 표시는 그대로지만 재생은 안 돼요.`, true)) return;
        doc.recs = doc.recs.filter(x => x.id !== r.id); await store.del('rec-' + r.id).catch(() => {});
        if (curId === r.id) { curId = null; audio.pause(); audio.removeAttribute('src'); audio.hidden = true; clearHead(); }
        ctx.touch(doc); renderList();
      } }),
    );
    listEl.append(row);
  });
}
function ui() {
  const live = !!rec, mine = live && rec.doc === doc;
  $('#recToggle').textContent = live ? '녹음 끝내기' : '녹음 시작';
  $('#recToggle').classList.toggle('danger', live);
  $('#recPause').hidden = !live;
  $('#recPause').textContent = live && rec.paused ? '이어서 녹음' : '일시정지';
  $('#recTime').classList.toggle('live', live);
  $('#recTime').textContent = live ? mmss(elapsed()) : '00:00';
  $('#recHint').textContent = live ? (mine ? '녹음 중에 쓰는 글과 필기에 시점이 저장돼요' : '다른 문서에서 녹음 중이에요') : '';
  badge.hidden = !live;
  if (live) tick();
}
function togglePanel(on) {
  const show = on === undefined ? panel.hidden : on;
  panel.hidden = !show;
  ctx.page.classList.toggle('rec-on', show);
  $('#btnRec').classList.toggle('on', show);
  if (show) { renderList(); ui(); } else { audio.pause(); clearHead(); }
}

/* ---------- 바깥에서 쓰는 함수 ---------- */
window.EDREC = {
  now, mark, seek,
  init(c) {
    ctx = c; store = EDINK.store;
    panel = $('#recPanel'); listEl = $('#recList'); audio = $('#recAudio');
    hi = h('div', { id: 'recHi', hidden: true }); ctx.page.append(hi);
    badge = h('span', { id: 'recBadge', hidden: true, title: '누르면 녹음 화면이 열려요', onclick: () => togglePanel(true) });
    $('#saveState').before(badge);
    $('#recToggle').onclick = () => (rec ? stop() : start());
    $('#recPause').onclick = togglePause;
    $('#recClose').onclick = () => togglePanel(false);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('pause', clearHead);
    audio.addEventListener('ended', clearHead);
    audio.addEventListener('play', onTime);
    // 글을 누르면 그 시점으로 (녹음 중이 아닐 때만)
    ctx.editor.addEventListener('click', () => {
      if (rec || !doc || panel.hidden || !$('#recSeek').checked) return;
      const sel = getSelection(); if (!sel.rangeCount) return;
      let n = sel.anchorNode;
      while (n && n.parentNode !== ctx.editor) n = n.parentNode;
      if (!n || n.nodeType !== 1 || !n.getAttribute('data-rec')) return;
      const [rid, t] = n.getAttribute('data-rec').split(':');
      seek(rid, +t);
    });
    addEventListener('beforeunload', e => { if (rec) { e.preventDefault(); e.returnValue = ''; } });
  },
  load(d) {
    doc = d; curId = null;
    if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
    audio.pause(); audio.removeAttribute('src'); audio.hidden = true; clearHead();
    if (!panel.hidden) { renderList(); } ui();
  },
  unload() { audio.pause(); clearHead(); doc = null; curId = null; panel.hidden = true; ctx.page.classList.remove('rec-on'); $('#btnRec').classList.remove('on'); ui(); },
  toggle: () => doc && togglePanel(),
  async dropDoc(d) { for (const r of d.recs || []) await store.del('rec-' + r.id).catch(() => {}); },
  isRecording: () => !!rec,
};
})();
