-- 별문서 공유 서버 (Supabase → SQL Editor 에 통째로 붙여넣고 Run)
-- 표는 아무도 직접 읽거나 쓸 수 없고, 아래 3개 함수로만 접근해요.
--  · get_shared    : 공유 ID를 아는 사람만 해당 문서 1개를 읽음 (목록 조회 불가)
--  · publish_doc   : 비밀 토큰이 맞아야 게시/수정 (토큰은 만든 기기에만 있음)
--  · unpublish_doc : 비밀 토큰이 맞아야 공개 해제(삭제)

create table if not exists public.shared_docs (
  id         text primary key,
  token      text not null,
  title      text,
  html       text,
  updated_at timestamptz not null default now()
);

alter table public.shared_docs enable row level security;   -- 정책을 만들지 않음 = 직접 접근 전부 차단
revoke all on public.shared_docs from anon, authenticated;

create or replace function public.get_shared(p_id text)
returns table(title text, html text, updated_at timestamptz)
language sql security definer set search_path = public as $$
  select title, html, updated_at from public.shared_docs where id = p_id;
$$;

create or replace function public.publish_doc(p_id text, p_token text, p_title text, p_html text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if length(p_id) < 8 or length(p_token) < 16 then raise exception 'bad id/token'; end if;
  if length(coalesce(p_html, '')) > 1500000 then raise exception 'too large'; end if;
  if exists (select 1 from public.shared_docs where id = p_id and token <> p_token) then
    raise exception 'forbidden';
  end if;
  insert into public.shared_docs (id, token, title, html)
  values (p_id, p_token, left(p_title, 300), p_html)
  on conflict (id) do update
    set title = excluded.title, html = excluded.html, updated_at = now();
end;
$$;

create or replace function public.unpublish_doc(p_id text, p_token text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.shared_docs where id = p_id and token = p_token;
end;
$$;

revoke all on function public.get_shared(text) from public;
revoke all on function public.publish_doc(text, text, text, text) from public;
revoke all on function public.unpublish_doc(text, text) from public;
grant execute on function public.get_shared(text) to anon, authenticated;
grant execute on function public.publish_doc(text, text, text, text) to anon, authenticated;
grant execute on function public.unpublish_doc(text, text) to anon, authenticated;
