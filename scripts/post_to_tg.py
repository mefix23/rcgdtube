"""
Бот РКГДTUBE: выкладывает в Telegram-канал видео, которые прислали зрители через плюсик
как заявку «в канал» и одобрили модераторы. Видео «только на сайт» бот не трогает,
ворки из базы канала — тоже (они в канале уже есть).

Формат поста:
    <b>Название</b> — by <b>ник</b> [ORIGINAL]
    > описание (цитатой)
    #хэштеги

    СМОТРЕТЬ НА САЙТЕ

Ссылки YouTube уходят текстом с превью видео сверху, свои файлы — самим видео (до 50 МБ).

Настройки (GitHub → Settings → Secrets and variables → Actions):
    секрет     TELEGRAM_BOT_TOKEN — токен бота от @BotFather
    переменная TELEGRAM_CHAT_ID   — канал: @имя_канала или -100…
Без них бот ничего не делает. Что уже выложено — data/tg_posted.json.
"""
import html
import json
import os
import re
import sys
import tempfile
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ROOT, SITE, UA, approved_submissions, hashtag, hidden_keys, load_json, storage_url, submission_key  # noqa: E402

POSTED = os.path.join(ROOT, "data", "tg_posted.json")
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
CHAT = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
MAX_PER_RUN = int(os.environ.get("TG_MAX_PER_RUN", "10"))  # чтобы не завалить канал за раз


def youtube_description(vid):
    """Описание видео со страницы YouTube (без ключей). Пусто, если не получилось."""
    try:
        r = requests.get(f"https://www.youtube.com/watch?v={vid}", headers=UA, timeout=20,
                         cookies={"CONSENT": "YES+cb", "SOCS": "CAI"})
        m = re.search(r'"shortDescription":("(?:[^"\\]|\\.)*")', r.text)
        return json.loads(m.group(1)).strip() if m else ""
    except Exception:
        return ""


def build_text(s, key, limit):
    """Текст поста в формате канала. limit — сколько символов можно (у подписи к видео меньше)."""
    e = html.escape
    title = (s.get("title") or "").strip() or "Без названия"
    author = (s.get("author") or "").strip() or "неизвестный автор"
    original = f"https://youtu.be/{s['yt_id']}" if s.get("yt_id") else None
    head = f"<b>{e(title)}</b> — by <b>{e(author)}</b>" + (f" [<a href=\"{original}\">ORIGINAL</a>]" if original else "")

    tags = [hashtag(author)]
    for t in re.split(r"[\s,]+", s.get("tags") or ""):
        t = hashtag(t.lstrip("#"))
        if t and t.lower() not in (x.lower() for x in tags):
            tags.append(t)
    tags_line = " ".join(t for t in tags if t)
    link = f"<a href=\"{SITE}#/{'shorts' if s.get('is_short') else 'watch'}/{key}\">СМОТРЕТЬ НА САЙТЕ</a>"

    desc = (s.get("description") or "").strip() or (youtube_description(s["yt_id"]) if s.get("yt_id") else "")
    desc = re.sub(r"\n{3,}", "\n\n", desc)
    fixed = len(head) + len(tags_line) + len(link) + 60
    room = max(0, min(700, limit - fixed))
    if len(desc) > room:
        desc = (desc[:room].rsplit(" ", 1)[0] + "…") if room > 20 else ""

    parts = [head]
    if desc:
        parts.append(f"<blockquote expandable>{e(desc)}</blockquote>")
    if tags_line:
        parts.append(tags_line)
    return "\n".join(parts) + "\n\n" + link


def call(method, **kw):
    """Запрос к Telegram. Возвращает (ответ, код)."""
    for _ in range(3):
        try:
            r = requests.post(f"https://api.telegram.org/bot{TOKEN}/{method}", timeout=120, **kw)
        except requests.RequestException as ex:
            print("  Telegram не ответил:", ex)
            return None, 0
        try:
            j = r.json()
        except ValueError:
            j = {}
        if r.status_code == 429:
            time.sleep(int(j.get("parameters", {}).get("retry_after", 5)) + 1)
            continue
        return j, r.status_code
    return None, 429


def publish(s, key):
    """'ok' + номер сообщения, 'retry' (позже), 'skip' (не получится никогда) или 'fatal' (бот не настроен)."""
    if s["kind"] == "youtube":
        j, code = call("sendMessage", json={
            "chat_id": CHAT, "text": build_text(s, key, 4096), "parse_mode": "HTML",
            "link_preview_options": {"url": f"https://www.youtube.com/watch?v={s['yt_id']}",
                                     "prefer_large_media": True, "show_above_text": True},
        })
    else:
        url = storage_url(s["file_path"])
        try:
            with requests.get(url, headers=UA, timeout=120, stream=True) as r:
                r.raise_for_status()
                tmp = tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(s["file_path"])[1] or ".mp4")
                for chunk in r.iter_content(1 << 16):
                    tmp.write(chunk)
                tmp.close()
        except Exception as ex:
            print("  файл не скачался:", ex)
            return "retry", None
        try:
            with open(tmp.name, "rb") as f:
                j, code = call("sendVideo", data={
                    "chat_id": CHAT, "caption": build_text(s, key, 1024), "parse_mode": "HTML", "supports_streaming": "true",
                }, files={"video": (os.path.basename(s["file_path"]), f)})
        finally:
            os.remove(tmp.name)
    if j and j.get("ok"):
        return "ok", j["result"]["message_id"]
    desc = (j or {}).get("description", "")
    print("  Telegram отказал:", code, desc)
    if code in (401, 403) or "chat not found" in desc.lower():
        return "fatal", None
    return ("skip" if code == 400 else "retry"), None


def main():
    if not TOKEN or not CHAT:
        print("Бот не настроен (нет TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID) — пропускаю.")
        return
    state = load_json(POSTED, {"posted": {}, "failed": []})
    done = state.setdefault("posted", {})
    failed = set(state.setdefault("failed", []))
    hidden = hidden_keys()

    todo = []
    for s in approved_submissions():
        if s.get("target") == "site":
            continue  # зритель выбрал «только на сайт» — в канал не выкладываем
        key = submission_key(s)
        if key not in done and key not in failed and key not in hidden:
            todo.append((s, key))
    todo.sort(key=lambda x: x[0].get("reviewed_at") or "")
    if not todo:
        print("Новых видео для канала нет.")
        return

    sent, fatal = 0, False
    for s, key in todo[:MAX_PER_RUN]:
        res, msg_id = publish(s, key)
        print(f"  {key} «{s.get('title')}»: {res}")
        if res == "ok":
            done[key] = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "msg": msg_id}
            sent += 1
        elif res == "skip":
            failed.add(key)
        elif res == "fatal":
            fatal = True
            break
        time.sleep(3)

    state["failed"] = sorted(failed)
    os.makedirs(os.path.dirname(POSTED), exist_ok=True)
    with open(POSTED, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    print(f"Опубликовано в канал: {sent}")
    if fatal:
        sys.exit("Проверь токен бота и что бот — админ канала с правом публиковать сообщения.")


if __name__ == "__main__":
    main()
