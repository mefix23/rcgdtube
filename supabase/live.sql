-- ============================================================
-- РКГДTUBE — свежие видео из канала без ожидания GitHub.
-- Запускается один раз в SQL Editor (после schema.sql). Повторный запуск ничего не ломает.
-- Каждые 5 минут база сама вызывает функцию tg-scan, та читает t.me/s/RCGDTUBE
-- и складывает новые посты с YouTube сюда. Сайт берёт их отсюда сразу.
-- ============================================================

create table if not exists public.channel_posts (
  tg          integer primary key,          -- номер поста в канале
  yt          text not null,                -- id видео на YouTube
  title       text not null default '',
  author      text not null default '',
  descr       text not null default '',
  posted_at   timestamptz,
  short       boolean not null default false,
  scanned_at  timestamptz not null default now()
);
create index if not exists channel_posts_yt on public.channel_posts (yt);

alter table public.channel_posts enable row level security;
drop policy if exists "channel_posts: читают все" on public.channel_posts;
create policy "channel_posts: читают все" on public.channel_posts for select using (true);
grant select on public.channel_posts to anon, authenticated;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'rcgd-tg-scan',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://koyesdmntcuabkqdrjjr.supabase.co/functions/v1/tg-scan',
       headers := jsonb_build_object('Content-Type', 'application/json',
                                     'apikey', 'sb_publishable_4-ciYVyVJjgz3tYofVL1rA_O-J-IMoq'),
       body := '{}'::jsonb,
       timeout_milliseconds := 60000
     ); $$
);
