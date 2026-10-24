/* eddytor — 서버(Supabase) 연결: 로그인 + 문서 주고받기
   이 파일은 "통신"만 맡아요. 어떤 문서를 어떻게 합칠지는 app.js 가 정해요. */
(() => {
'use strict';
const CFG = window.EDDYTOR_CONFIG || window.BYEOL_CONFIG || {};   // 예전 이름(BYEOL_CONFIG)도 그대로 읽어요
const AUTH_KEY = 'eddytor.auth';
const TABLE = 'eddytor_items';

const configured = () => !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
const base = () => CFG.supabaseUrl.replace(/\/$/, '');

let session = null;
try { session = JSON.parse(localStorage.getItem(AUTH_KEY)); } catch (e) { /* 로그아웃 상태 */ }
const listeners = [];
function setSession(s) {
  session = s;
  try { s ? localStorage.setItem(AUTH_KEY, JSON.stringify(s)) : localStorage.removeItem(AUTH_KEY); } catch (e) { /* 무시 */ }
  listeners.forEach(f => f(s));
}
const toSession = r => ({
  access_token: r.access_token,
  refresh_token: r.refresh_token,
  expires_at: Math.floor(Date.now() / 1000) + (r.expires_in || 3600),
  user: { id: r.user.id, email: r.user.email },
});

async function authCall(path, body, bearer) {
  const headers = { apikey: CFG.supabaseAnonKey, 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  const res = await fetch(base() + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) { /* 글자 그대로 */ }
  if (!res.ok) {
    const err = new Error((j && (j.msg || j.error_description || j.message)) || text || String(res.status));
    err.code = (j && (j.error_code || j.code || j.error)) || '';
    err.status = res.status;
    throw err;
  }
  return j;
}

async function signUp(email, password) {
  const j = await authCall('/auth/v1/signup', { email, password });
  if (j && j.access_token) { setSession(toSession(j)); return { signedIn: true }; }
  return { signedIn: false };            // 서버가 "메일 확인"을 요구하는 설정인 경우
}
async function signIn(email, password) {
  setSession(toSession(await authCall('/auth/v1/token?grant_type=password', { email, password })));
}
async function refresh() {
  if (!session) throw new Error('로그인이 필요해요');
  try {
    setSession(toSession(await authCall('/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token })));
  } catch (e) {
    if (e.status === 400 || e.status === 401 || e.status === 403) setSession(null);   // 세션이 끝났어요
    throw e;
  }
}
async function signOut() {
  const t = session && session.access_token;
  setSession(null);
  if (t) { try { await authCall('/auth/v1/logout', {}, t); } catch (e) { /* 이미 끝난 세션이면 무시 */ } }
}
async function accessToken() {
  if (!session) throw new Error('로그인이 필요해요');
  if (session.expires_at - 60 < Date.now() / 1000) await refresh();
  return session.access_token;
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { apikey: CFG.supabaseAnonKey, Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${base()}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401 && attempt === 0) { await refresh(); continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(text || String(res.status));
    return text ? JSON.parse(text) : null;
  }
}

// 서버에 바뀐 문서 가져오기 (since: 마지막으로 받은 시각)
const pull = since => rest(`${TABLE}?select=*&order=synced_at.asc&limit=1000` + (since ? '&synced_at=gt.' + encodeURIComponent(since) : ''));
// 내 문서 올리기 (같은 id 는 덮어쓰기)
const push = rows => rest(`${TABLE}?on_conflict=user_id,id`, { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal' });

window.EDSYNC = { configured, session: () => session, signUp, signIn, signOut, pull, push, onChange: f => listeners.push(f) };
})();
