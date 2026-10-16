-- ============================================================
-- РКГДTUBE — видео «только на сайт».
-- Любой вошедший может добавить видео, которое сразу появляется на сайте
-- и НЕ уходит в Telegram-канал. Заявки «в канал» по-прежнему проверяют модераторы.
-- Запускается один раз в SQL Editor (после schema.sql). Повторный запуск ничего не ломает.
-- ============================================================

-- куда отправлено видео: 'channel' — заявка в канал, 'site' — только на сайт
alter table public.submissions add column if not exists target text not null default 'channel';
alter table public.submissions drop constraint if exists submissions_target;
alter table public.submissions add constraint submissions_target check (target in ('channel', 'site'));

drop policy if exists "submissions: отправить" on public.submissions;
create policy "submissions: отправить" on public.submissions for insert to authenticated
  with check (user_id = auth.uid() and reviewed_by is null and reject_reason is null
              and ((target = 'channel' and status = 'pending' and reviewed_at is null)
                   or (target = 'site' and status = 'approved')));

-- своё видео «только на сайт» автор может удалить в любой момент
drop policy if exists "submissions: удалить свою или модератор" on public.submissions;
create policy "submissions: удалить свою или модератор" on public.submissions for delete to authenticated
  using ((user_id = auth.uid() and (status = 'pending' or target = 'site')) or public.is_mod());

-- перед записью: заявка в канал всегда ждёт модератора, видео на сайт публикуется сразу
create or replace function public.limit_pending() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.target = 'site' then
    if (select count(*) from submissions
         where user_id = new.user_id and target = 'site' and created_at > now() - interval '1 day') >= 10 then
      raise exception 'Можно добавить не больше 10 видео в сутки. Попробуй завтра.';
    end if;
    new.status := 'approved';
    new.reviewed_at := now();
    new.reviewed_by := null;
  else
    new.target := 'channel';
    new.status := 'pending';
    new.reviewed_at := null;
    if (select count(*) from submissions where user_id = new.user_id and status = 'pending') >= 5 then
      raise exception 'У тебя уже 5 заявок на проверке. Подожди, пока модераторы их посмотрят.';
    end if;
  end if;
  return new;
end $$;

-- модератор: отправить видео зрителя с сайта в канал (бот выложит его в Telegram)
create or replace function public.send_to_channel(sub_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_mod() then raise exception 'Только для модераторов'; end if;
  update submissions set target = 'channel', reviewed_by = auth.uid(), reviewed_at = now()
   where id = sub_id and target = 'site' and status = 'approved';
  if not found then raise exception 'Видео не найдено'; end if;
end $$;
revoke all on function public.send_to_channel(uuid) from public, anon;
grant execute on function public.send_to_channel(uuid) to authenticated;
