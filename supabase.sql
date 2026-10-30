-- eddytor 서버 (공유 + 로그인 동기화) (Supabase → SQL Editor 에 통째로 붙여넣고 Run)
-- [1] 공유(공개 게시): 표는 아무도 직접 읽거나 쓸 수 없고, 아래 3개 함수로만 접근해요.
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


-- ============================================================
-- [2] 내 문서 보관함 (로그인 동기화)
--  · 로그인한 사람은 "자기 문서만" 읽고 쓸 수 있어요 (행 단위 보안, RLS)
--  · 여러 번 실행해도 안전해요 (이미 있으면 건너뜀)
-- ============================================================
create table if not exists public.eddytor_items (
  user_id   uuid   not null default auth.uid() references auth.users(id) on delete cascade,
  id        text   not null,
  type      text   not null,
  parent    text,
  title     text   not null default '',
  html      text   not null default '',
  indent    boolean not null default false,
  share     jsonb,
  created   bigint not null,
  updated   bigint not null,
  deleted   boolean not null default false,
  synced_at timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);
create index if not exists eddytor_items_sync on public.eddytor_items (user_id, synced_at);

create or replace function public.eddytor_touch() returns trigger
language plpgsql as $$
begin
  new.synced_at := clock_timestamp();
  if length(coalesce(new.html, '')) > 3000000 then raise exception 'too large'; end if;
  return new;
end;
$$;
drop trigger if exists eddytor_touch on public.eddytor_items;
create trigger eddytor_touch before insert or update on public.eddytor_items
  for each row execute function public.eddytor_touch();

alter table public.eddytor_items enable row level security;
drop policy if exists "own rows" on public.eddytor_items;
create policy "own rows" on public.eddytor_items
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.eddytor_items from anon;
grant select, insert, update, delete on public.eddytor_items to authenticated;

-- [3] 펜 필기 데이터 (이미 위 표가 있어도 이 두 줄이 추가돼요. 여러 번 실행해도 안전)
alter table public.eddytor_items add column if not exists ink jsonb;
alter table public.eddytor_items add column if not exists ink_h integer not null default 0;

-- [4] 쪽(페이지) 모드 설정
alter table public.eddytor_items add column if not exists layout jsonb;
