"""
Бот РКГДTUBE: выкладывает в Telegram-канал видео, которые админы добавили на сайт
(их ещё нет в канале — всё, что есть в базе канала, бот не трогает).

Формат поста:
    <b>Название</b> — by <b>ник</b> [ORIGINAL]
    > описание видео (цитатой)
    #хэштеги

    СМОТРЕТЬ НА САЙТЕ

Настройки (GitHub → Settings → Secrets and variables → Actions):
    секрет     TELEGRAM_BOT_TOKEN — токен бота от @BotFather
    переменная TELEGRAM_CHAT_ID   — канал: @имя_канала или -100…
Если их нет, бот просто ничего не делает.

Что уже выложено, запоминается в data/tg_posted.json.
"""
import html
import json
import os
import re
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POSTS = os.path.join(ROOT, "data", "posts.json")
POSTED = os.path.join(ROOT, "data", "tg_posted.json")
UPLOADS_URL = os.environ.get("UPLOADS_URL", "https://raw.githubusercontent.com/mefix23/rcgdtube-uploads/main/uploads.json")
SITE = os.environ.get("SITE_URL", "https://mefix23.github.io/rcgdtube/")
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
CHAT = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
MAX_PER_RUN = int(os.environ.get("TG_MAX_PER_RUN", "10"))  # чтобы не завалить канал за один раз
UA = {"User-Agent": "Mozilla/5.0 (compatible; RCGDTUBE-bot/1.0)", "Accept-Language": "ru,en;q=0.8"}


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def youtube_description(vid):
    """Описание видео со страницы YouTube (без ключей и регистрации). Пусто, если не получилось."""
    try:
        r = requests.get(f"https://www.youtube.com/watch?v={vid}", headers=UA, timeout=20)
        m = re.search(r'"shortDescription":("(?:[^"\\]|\\.)*")', r.text)
        return json.loads(m.group(1)).strip() if m else ""
    except Exception:
        return ""


def hashtag(s):
    t = re.sub(r"[^\w]+", "_", s.strip(), flags=re.UNICODE).strip("_")
    return "#" + t if t else ""


def build_text(p, extra):
    """Текст поста в формате канала."""
    e = html.escape
    yt = f"https://youtu.be/{p['yt']}"
    title = (extra.get("title") or p["title"]).strip()
    author = (extra.get("author") or p["author"]).strip()
    head = f"<b>{e(title)}</b> — by <b>{e(author)}</b> [<a href=\"{yt}\">ORIGINAL</a>]"

    desc = (extra.get("desc") or "").strip() or youtube_description(p["yt"])
    desc = re.sub(r"\n{3,}", "\n\n", desc)
    if len(desc) > 700:
        desc = desc[:700].rsplit(" ", 1)[0] + "…"

    tags = [hashtag(author)]
    for t in re.split(r"[\s,]+", extra.get("tags") or ""):
        t = hashtag(t.lstrip("#"))
        if t and t.lower() not in (x.lower() for x in tags):
            tags.append(t)

    parts = [head]
    if desc:
        parts.append(f"<blockquote expandable>{e(desc)}</blockquote>")
    tags = [t for t in tags if t]
    if tags:
        parts.append(" ".join(tags))
    link = f"<a href=\"{SITE}#v{p['yt']}\">СМОТРЕТЬ НА САЙТЕ</a>"
    return "\n".join(parts) + "\n\n" + link


def send(text, vid):
    """Отправить пост. Возвращает 'ok', 'retry' (попробовать в следующий раз) или 'skip'."""
    body = {
        "chat_id": CHAT,
        "text": text,
        "parse_mode": "HTML",
        # сверху поста — превью видео с YouTube, его можно смотреть прямо в Telegram
        "link_preview_options": {"url": f"https://www.youtube.com/watch?v={vid}",
                                 "prefer_large_media": True, "show_above_text": True},
    }
    for _ in range(3):
        try:
            r = requests.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage", json=body, timeout=30)
        except requests.RequestException as ex:
            print("  Telegram не ответил:", ex)
            return "retry"
        j = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if j.get("ok"):
            return "ok"
        if r.status_code == 429:
            time.sleep(int(j.get("parameters", {}).get("retry_after", 5)) + 1)
            continue
        desc = j.get("description", r.text[:200])
        print("  Telegram отказал:", r.status_code, desc)
        if r.status_code in (401, 403) or "chat not found" in desc.lower():
            return "fatal"
        return "skip" if r.status_code == 400 else "retry"
    return "retry"


def main():
    if not TOKEN or not CHAT:
        print("Бот не настроен (нет TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID) — пропускаю.")
        return

    posts = load(POSTS, {}).get("posts", [])
    state = load(POSTED, {"posted": {}, "failed": []})
    done = state.setdefault("posted", {})
    failed = set(state.setdefault("failed", []))

    try:
        up = requests.get(UPLOADS_URL, headers=UA, timeout=30).json()
    except Exception:
        up = {"videos": []}
    extra = {v.get("yt"): v for v in up.get("videos", []) if v.get("yt")}

    # только видео от админов: всё, что из базы, в канале уже есть
    todo = [p for p in posts if p.get("admin") and p["yt"] not in done and p["yt"] not in failed]
    todo.sort(key=lambda p: p.get("date") or "")
    if not todo:
        print("Новых видео для канала нет.")
        return

    sent, fatal = 0, False
    for p in todo[:MAX_PER_RUN]:
        text = build_text(p, extra.get(p["yt"], {}))
        res = send(text, p["yt"])
        print(f"  {p['yt']} «{p['title']}»: {res}")
        if res == "ok":
            done[p["yt"]] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            sent += 1
        elif res == "skip":
            failed.add(p["yt"])
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
