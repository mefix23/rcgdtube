-- ============================================================
-- РКГДTUBE — SQL-база в Supabase.
-- Запускается один раз целиком: Supabase → SQL Editor → вставить → Run.
-- Повторный запуск ничего не ломает.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- Профили ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  tg_id       bigint unique,
  username    text,
  name        text not null default 'Зритель',
  photo_url   text,
  role        text not null default 'user' check (role in ('user', 'moderator', 'owner')),
  created_at  timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "profiles: читать всем" on public.profiles;
create policy "profiles: читать всем" on public.profiles for select using (true);
-- менять профили можно только через серверную функцию входа и функции ниже

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from profiles where id = auth.uid()), 'guest');
$$;

create or replace function public.is_mod() returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() in ('moderator', 'owner');
$$;

-- ---------- Заявки (плюсик) ----------
create table if not exists public.submissions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  kind          text not null check (kind in ('youtube', 'file')),
  yt_id         text check (yt_id ~ '^[A-Za-z0-9_-]{11}$'),
  file_path     text check (char_length(file_path) <= 200),
  thumb_path    text check (char_length(thumb_path) <= 200),
  title         text not null check (char_length(title) between 1 and 140),
  author        text not null default '' check (char_length(author) <= 80),
  description   text not null default '' check (char_length(description) <= 1500),
  tags          text not null default '' check (char_length(tags) <= 120),
  is_short      boolean not null default false,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reject_reason text check (char_length(reject_reason) <= 300),
  reviewed_by   uuid references public.profiles(id) on delete set null,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  constraint submissions_media check (
    (kind = 'youtube' and yt_id is not null) or (kind = 'file' and file_path is not null))
);
create index if not exists submissions_status_idx on public.submissions (status, created_at desc);
alter table public.submissions enable row level security;

drop policy if exists "submissions: читать" on public.submissions;
create policy "submissions: читать" on public.submissions for select
  using (status = 'approved' or user_id = auth.uid() or public.is_mod());
drop policy if exists "submissions: отправить" on public.submissions;
create policy "submissions: отправить" on public.submissions for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending' and reviewed_by is null
              and reviewed_at is null and reject_reason is null);
drop policy if exists "submissions: удалить свою или модератор" on public.submissions;
create policy "submissions: удалить свою или модератор" on public.submissions for delete to authenticated
  using ((user_id = auth.uid() and status = 'pending') or public.is_mod());

-- не больше 5 заявок на проверке у одного человека
create or replace function public.limit_pending() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from submissions where user_id = new.user_id and status = 'pending') >= 5 then
    raise exception 'У тебя уже 5 заявок на проверке. Подожди, пока модераторы их посмотрят.';
  end if;
  return new;
end $$;
drop trigger if exists limit_pending on public.submissions;
create trigger limit_pending before insert on public.submissions
  for each row execute function public.limit_pending();

-- модератор: выложить или отказать
create or replace function public.review_submission(sub_id uuid, approve boolean, reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_mod() then raise exception 'Только для модераторов'; end if;
  update submissions
     set status = case when approve then 'approved' else 'rejected' end,
         reject_reason = case when approve then null else left(coalesce(reason, ''), 300) end,
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = sub_id;
  if not found then raise exception 'Заявка не найдена'; end if;
end $$;

-- ---------- Скрытые видео ----------
create table if not exists public.hidden_videos (
  video_key  text primary key check (char_length(video_key) <= 64),
  hidden_by  uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.hidden_videos enable row level security;
drop policy if exists "hidden: читать всем" on public.hidden_videos;
create policy "hidden: читать всем" on public.hidden_videos for select using (true);
drop policy if exists "hidden: модераторы" on public.hidden_videos;
create policy "hidden: модераторы" on public.hidden_videos for all to authenticated
  using (public.is_mod()) with check (public.is_mod());

-- ---------- Лайки ----------
create table if not exists public.likes (
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  video_key  text not null check (char_length(video_key) <= 64),
  value      smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (user_id, video_key)
);
create index if not exists likes_video_idx on public.likes (video_key);
alter table public.likes enable row level security;
drop policy if exists "likes: свои" on public.likes;
create policy "likes: свои" on public.likes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- Комментарии ----------
create table if not exists public.comments (
  id            bigint generated always as identity primary key,
  video_key     text not null check (char_length(video_key) <= 64),
  user_id       uuid default auth.uid() references public.profiles(id) on delete set null,
  body          text not null check (char_length(body) between 1 and 1000),
  source        text not null default 'site' check (source in ('site', 'tg')),
  tg_author     text,
  tg_message_id bigint,
  deleted       boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists comments_video_idx on public.comments (video_key, created_at desc);
alter table public.comments enable row level security;
drop policy if exists "comments: читать" on public.comments;
create policy "comments: читать" on public.comments for select using (not deleted or public.is_mod());
drop policy if exists "comments: писать" on public.comments;
create policy "comments: писать" on public.comments for insert to authenticated
  with check (user_id = auth.uid() and source = 'site' and tg_author is null
              and tg_message_id is null and deleted = false);

-- не чаще одного комментария в 10 секунд
create or replace function public.limit_comments() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'site' and exists (select 1 from comments where user_id = new.user_id
       and created_at > now() - interval '10 seconds') then
    raise exception 'Слишком часто. Подожди пару секунд.';
  end if;
  return new;
end $$;
drop trigger if exists limit_comments on public.comments;
create trigger limit_comments before insert on public.comments
  for each row execute function public.limit_comments();

create or replace function public.delete_comment(cid bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  update comments set deleted = true
   where id = cid and (user_id = auth.uid() or public.is_mod());
  if not found then raise exception 'Нельзя удалить этот комментарий'; end if;
end $$;

-- ---------- Подписки ----------
create table if not exists public.subscriptions (
  user_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  author_key  text not null check (char_length(author_key) <= 100),
  author_name text not null default '' check (char_length(author_name) <= 100),
  created_at  timestamptz not null default now(),
  primary key (user_id, author_key)
);
alter table public.subscriptions enable row level security;
drop policy if exists "subs: свои" on public.subscriptions;
create policy "subs: свои" on public.subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- История просмотров ----------
create table if not exists public.history (
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  video_key  text not null check (char_length(video_key) <= 64),
  watched_at timestamptz not null default now(),
  primary key (user_id, video_key)
);
create index if not exists history_user_idx on public.history (user_id, watched_at desc);
alter table public.history enable row level security;
drop policy if exists "history: своя" on public.history;
create policy "history: своя" on public.history for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- Счётчики для видео (лайки, дизлайки, комментарии, подписчики) ----------
create or replace function public.video_stats(keys text[])
returns table (video_key text, likes bigint, dislikes bigint, comments bigint, my_vote smallint)
language sql stable security definer set search_path = public as $$
  select k,
         (select count(*) from likes l where l.video_key = k and l.value = 1),
         (select count(*) from likes l where l.video_key = k and l.value = -1),
         (select count(*) from comments c where c.video_key = k and not c.deleted),
         (select l.value from likes l where l.video_key = k and l.user_id = auth.uid())
  from unnest(keys[1:200]) as k;
$$;

create or replace function public.author_subscribers(akey text) returns bigint
language sql stable security definer set search_path = public as $$
  select count(*) from subscriptions where author_key = akey;
$$;

-- ---------- Коды модераторов ----------
create table if not exists public.mod_codes (
  n         int primary key,
  code_hash text not null unique,
  grants    text not null default 'moderator' check (grants in ('moderator', 'owner')),
  used_by   uuid references public.profiles(id) on delete set null,
  used_at   timestamptz,
  disabled  boolean not null default false
);
alter table public.mod_codes enable row level security;
-- политик нет: напрямую коды не читает никто, только функции ниже

create or replace function public.redeem_code(code text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  h text := encode(extensions.digest('rcgdtube-key:' || upper(regexp_replace(coalesce(code, ''), '\s', '', 'g')), 'sha256'), 'hex');
  r public.mod_codes;
begin
  if auth.uid() is null then raise exception 'Сначала войди в аккаунт'; end if;
  select * into r from mod_codes where code_hash = h;
  if not found or r.disabled then raise exception 'Такого кода нет или он отключён'; end if;
  if r.used_by is not null and r.used_by <> auth.uid() then raise exception 'Этот код уже использовал другой человек'; end if;
  update mod_codes set used_by = auth.uid(), used_at = coalesce(used_at, now()) where n = r.n;
  update profiles set role = case when r.grants = 'owner' or role = 'owner' then 'owner' else 'moderator' end
   where id = auth.uid();
  return r.grants;
end $$;

-- владелец: список модераторов и кодов, снять модератора, отключить код
create or replace function public.team() returns table (
  n int, grants text, disabled boolean, used_at timestamptz,
  user_id uuid, name text, username text, role text)
language plpgsql stable security definer set search_path = public as $$
begin
  if public.my_role() <> 'owner' then raise exception 'Только для владельца'; end if;
  return query
    select c.n, c.grants, c.disabled, c.used_at, p.id, p.name, p.username, p.role
      from mod_codes c left join profiles p on p.id = c.used_by
     order by c.n;
end $$;

create or replace function public.set_code_disabled(code_n int, off boolean) returns void
language plpgsql security definer set search_path = public as $$
declare u uuid;
begin
  if public.my_role() <> 'owner' then raise exception 'Только для владельца'; end if;
  update mod_codes set disabled = off where n = code_n and grants = 'moderator' returning used_by into u;
  if off and u is not null then
    update profiles set role = 'user' where id = u and role = 'moderator';
  elsif not off and u is not null then
    update profiles set role = 'moderator' where id = u and role = 'user';
  end if;
end $$;

-- ---------- Связь с группой комментариев Telegram (включится позже) ----------
create table if not exists public.tg_threads (
  channel_msg_id bigint primary key,
  group_chat_id  bigint not null,
  group_msg_id   bigint not null,
  created_at     timestamptz not null default now()
);
alter table public.tg_threads enable row level security;
-- политик нет: пишет и читает только серверная функция

-- ---------- Хранилище видеофайлов ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('videos', 'videos', true, 52428800,
        array['video/mp4', 'video/webm', 'video/quicktime', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 52428800,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "videos: загрузить в свою папку" on storage.objects;
create policy "videos: загрузить в свою папку" on storage.objects for insert to authenticated
  with check (bucket_id = 'videos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "videos: удалить своё или модератор" on storage.objects;
create policy "videos: удалить своё или модератор" on storage.objects for delete to authenticated
  using (bucket_id = 'videos' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_mod()));

-- ---------- Права на функции ----------
grant execute on function public.my_role(), public.is_mod(), public.video_stats(text[]),
  public.author_subscribers(text) to anon, authenticated;
grant execute on function public.review_submission(uuid, boolean, text), public.delete_comment(bigint),
  public.redeem_code(text), public.team(), public.set_code_disabled(int, boolean) to authenticated;
revoke execute on function public.review_submission(uuid, boolean, text), public.delete_comment(bigint),
  public.redeem_code(text), public.team(), public.set_code_disabled(int, boolean) from anon;
