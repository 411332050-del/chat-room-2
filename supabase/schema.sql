-- 匿名聊天室 2：資料庫設定
--
-- 貼到 Supabase 後台 SQL Editor 執行（貼檔案「內容」，不是檔案路徑）。可以重複執行。
-- 前提：Authentication → Sign In / Providers 已打開 Allow anonymous sign-ins。
--
-- 原則：前端的檢查只是體貼使用者，真正的把關都在這裡。
--   * 發言者、名稱、時間一律由資料庫填，前端只能送 id 與 body
--   * 沒有任何人能修改或刪除貼文
--   * 沒登入（沒有匿名身分）的請求讀不到也寫不進


-- ============================================================
-- 1. 成員：每個匿名身分一個固定的 3 碼編號
-- ============================================================

create table if not exists public.room_members (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  tag        text not null,
  nickname   text not null,
  created_at timestamptz not null default now()
);

alter table public.room_members enable row level security;
revoke all on public.room_members from anon, authenticated;
grant select on public.room_members to authenticated;

drop policy if exists "members_read_own" on public.room_members;
create policy "members_read_own"
  on public.room_members for select to authenticated
  using (user_id = (select auth.uid()));


-- ============================================================
-- 2. 貼文
-- ============================================================

create table if not exists public.room_posts (
  id         uuid primary key,
  user_id    uuid not null,
  nickname   text not null,
  body       text not null,
  created_at timestamptz not null default now(),
  constraint room_posts_body_len check (char_length(body) between 1 and 500)
);

create index if not exists room_posts_time_idx on public.room_posts (created_at desc, id desc);
create index if not exists room_posts_user_time_idx on public.room_posts (user_id, created_at desc);

alter table public.room_posts enable row level security;
revoke all on public.room_posts from anon, authenticated;
grant select on public.room_posts to authenticated;
grant insert (id, body) on public.room_posts to authenticated;

drop policy if exists "posts_read_all" on public.room_posts;
create policy "posts_read_all"
  on public.room_posts for select to authenticated
  using (true);

drop policy if exists "posts_insert_own" on public.room_posts;
create policy "posts_insert_own"
  on public.room_posts for insert to authenticated
  with check (user_id = (select auth.uid()));


-- ============================================================
-- 3. join_room(p_alias)：按下「進入聊天室」時呼叫
--    代號清理後必須 1～12 字；編號第一次產生後固定不變。
--    錯誤代碼：NOT_AUTHENTICATED / BAD_ALIAS
-- ============================================================

create or replace function public.join_room(p_alias text)
returns table (member_id uuid, nickname text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid   uuid := auth.uid();
  v_alias text;
  v_tag   text;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  -- 去掉控制字元與零寬字元，再去頭尾空白
  v_alias := coalesce(p_alias, '');
  v_alias := regexp_replace(v_alias, '[\u0001-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]', '', 'g');
  v_alias := regexp_replace(v_alias, '^[\s  -   　]+|[\s  -   　]+$', '', 'g');
  if char_length(v_alias) not between 1 and 12 then
    raise exception 'BAD_ALIAS' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 11));

  select m.tag into v_tag from public.room_members m where m.user_id = v_uid;
  if v_tag is null then
    v_tag := lpad(floor(random() * 1000)::int::text, 3, '0');
  end if;

  insert into public.room_members (user_id, tag, nickname)
  values (v_uid, v_tag, v_alias || '#' || v_tag)
  on conflict (user_id) do update set nickname = excluded.nickname;

  return query
    select m.user_id, m.nickname from public.room_members m where m.user_id = v_uid;
end;
$$;

revoke all on function public.join_room(text) from public, anon;
grant execute on function public.join_room(text) to authenticated;


-- ============================================================
-- 4. 寫入前的把關：身分、清理、長度、頻率
--    錯誤代碼：NOT_AUTHENTICATED / NOT_JOINED / EMPTY / TOO_LONG / TOO_FAST
-- ============================================================

create or replace function public.room_posts_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text;
  v_body text;
  v_cnt  int;
  v_last timestamptz;
  v_now  timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  select m.nickname into v_name from public.room_members m where m.user_id = v_uid;
  if v_name is null then
    raise exception 'NOT_JOINED' using errcode = 'P0001';
  end if;

  new.user_id    := v_uid;
  new.nickname   := v_name;
  new.created_at := v_now;

  -- 內容清理：統一換行、去隱形字元、空行最多一行、去頭尾空白
  v_body := regexp_replace(new.body, '\r\n?', E'\n', 'g');
  v_body := regexp_replace(v_body, '[\u0001-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]', '', 'g');
  v_body := regexp_replace(v_body, '\n{3,}', E'\n\n', 'g');
  v_body := regexp_replace(v_body, '^[\s  -   　]+|[\s  -   　]+$', '', 'g');

  if char_length(v_body) = 0 then
    raise exception 'EMPTY' using errcode = 'P0001';
  end if;
  if char_length(v_body) > 500 then
    raise exception 'TOO_LONG' using errcode = 'P0001';
  end if;
  new.body := v_body;

  -- 頻率限制：每人 10 秒最多 5 則，兩則至少間隔 0.5 秒
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 12));
  select count(*), max(p.created_at) into v_cnt, v_last
  from public.room_posts p
  where p.user_id = v_uid and p.created_at > v_now - interval '10 seconds';
  if v_cnt >= 5 or (v_last is not null and v_now - v_last < interval '0.5 seconds') then
    raise exception 'TOO_FAST' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.room_posts_guard() from public, anon, authenticated;

drop trigger if exists room_posts_guard on public.room_posts;
create trigger room_posts_guard
  before insert on public.room_posts
  for each row execute function public.room_posts_guard();


-- ============================================================
-- 5. 即時推送
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_posts'
  ) then
    alter publication supabase_realtime add table public.room_posts;
  end if;
end;
$$;
