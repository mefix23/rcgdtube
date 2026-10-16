"""
Собирает список видео для сайта РКГДTUBE.

Откуда берутся видео:
  1. SQL-база создателя канала: github.com/kilor231/rcgdtube-bd (файл gdchannels.db).
     В ней только ворки с YouTube, которые выходили в канале, без пересылок.
  2. Видео, которые админы добавили вручную через страницу upload.html
     (хранятся в репозитории mefix23/rcgdtube-uploads, файл uploads.json).

Названия видео подтягиваются с YouTube и запоминаются в data/yt_meta.json,
чтобы каждый раз не спрашивать заново. Превью и плеер тоже с YouTube,
поэтому картинки хранить не нужно.

Результат: data/posts.json — его читает сайт.
Запускается автоматически на GitHub каждые 30 минут.
"""
import json
import os
import sqlite3
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests

DB_URL = os.environ.get("DB_URL", "https://raw.githubusercontent.com/kilor231/rcgdtube-bd/main/gdchannels.db")
UPLOADS_URL = os.environ.get("UPLOADS_URL", "https://raw.githubusercontent.com/mefix23/rcgdtube-uploads/main/uploads.json")
# номер канала РКГДTUBE внутри базы
MAIN_CHAT_ID = int(os.environ.get("MAIN_CHAT_ID", "-1002627414327"))
CHANNEL = "RCGDTUBE"
LOOKUPS_PER_RUN = int(os.environ.get("LOOKUPS_PER_RUN", "1500"))  # сколько новых названий узнавать за один запуск

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "posts.json")
META = os.path.join(ROOT, "data", "yt_meta.json")
UA = {"User-Agent": "Mozilla/5.0 (compatible; RCGDTUBE-site/2.0)"}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def db_time(s):
    """'2026-10-15 18:33:37' (UTC) -> '2026-10-15T18:33:37Z'"""
    return s.replace(" ", "T") + "Z" if s and "T" not in s else s


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def download_db():
    r = requests.get(DB_URL, headers=UA, timeout=60)
    r.raise_for_status()
    fd, path = tempfile.mkstemp(suffix=".db")
    with os.fdopen(fd, "wb") as f:
        f.write(r.content)
    return path


def read_db(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    rows = con.execute(
        """
        SELECT p.message_id, p.video_id, p.detected_at,
               c.channel_id, c.channel_name, c.handle, c.channel_url
        FROM gdchannel_posts p
        LEFT JOIN gdchannels c ON c.channel_id = p.channel_id
        WHERE p.chat_id = ?
        ORDER BY p.detected_at DESC, p.message_id DESC
        """,
        (MAIN_CHAT_ID,),
    ).fetchall()
    con.close()
    posts, seen = [], set()
    for mid, vid, at, cid, cname, handle, curl in rows:
        if not vid or vid in seen:
            continue  # одно и то же видео выкладывали несколько раз: оставляем самый свежий пост
        seen.add(vid)
        posts.append({
            "yt": vid,
            "tg": mid,
            "date": db_time(at),
            "author": cname or "Неизвестный автор",
            "channel": cid,
            "handle": handle,
        })
    return posts


def read_uploads():
    """Видео, добавленные админами. Если репозитория ещё нет — просто пустой список."""
    try:
        r = requests.get(UPLOADS_URL, headers=UA, timeout=30)
        if r.status_code == 404:
            return {"videos": [], "hidden": []}
        r.raise_for_status()
        d = r.json()
        return {"videos": d.get("videos", []), "hidden": d.get("hidden", [])}
    except Exception as e:
        print("  загрузки админов не прочитались:", e)
        return {"videos": [], "hidden": []}


def oembed(vid):
    """Название и автор видео с YouTube. Возвращает (vid, данные или None если надо спросить позже)."""
    url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={vid}&format=json"
    try:
        r = requests.get(url, headers=UA, timeout=20)
    except requests.RequestException:
        return vid, None
    if r.status_code == 200:
        try:
            j = r.json()
        except ValueError:
            return vid, None
        return vid, {"t": j.get("title", ""), "a": j.get("author_name", ""), "s": "ok"}
    if r.status_code in (401, 403):
        return vid, {"t": "", "a": "", "s": "noembed"}  # видео есть, но встраивать запрещено
    if r.status_code in (400, 404):
        return vid, {"t": "", "a": "", "s": "gone"}  # видео удалено или скрыто
    return vid, None  # YouTube притормозил — попробуем в следующий раз


def main():
    meta = load_json(META, {})

    db_path = download_db()
    posts = read_db(db_path)
    os.remove(db_path)
    print(f"в базе: {len(posts)} видео канала")

    up = read_uploads()
    hidden = set(up["hidden"])
    in_db = {p["yt"] for p in posts}
    for v in up["videos"]:
        vid = v.get("yt")
        if not vid or vid in in_db:
            continue
        posts.append({
            "yt": vid,
            "tg": None,
            "date": v.get("added") or now_iso(),
            "author": v.get("author") or "",
            "channel": None,
            "handle": None,
            "title": v.get("title") or "",
            "admin": True,
            "uid": v.get("id"),
        })
        in_db.add(vid)
    print(f"от админов: {sum(1 for p in posts if p.get('admin'))} видео")

    # узнаём названия новых видео (свежие в первую очередь)
    todo = [p["yt"] for p in sorted(posts, key=lambda p: p["date"], reverse=True) if p["yt"] not in meta][:LOOKUPS_PER_RUN]
    if todo:
        print(f"узнаю названия: {len(todo)}")
        done = 0
        with ThreadPoolExecutor(max_workers=8) as pool:
            for vid, info in pool.map(oembed, todo):
                if info:
                    info["at"] = now_iso()[:10]
                    meta[vid] = info
                    done += 1
        print(f"  получено: {done}")

    out = []
    for p in posts:
        m = meta.get(p["yt"], {})
        if m.get("s") == "gone" or p["yt"] in hidden:
            continue
        title = p.get("title") or m.get("t") or ""
        author = p["author"] or m.get("a") or "Неизвестный автор"
        item = {
            "yt": p["yt"],
            "title": title or f"Ворк от {author}",
            "author": author,
            "date": p["date"],
        }
        if p.get("tg"):
            item["tg"] = p["tg"]
        if p.get("channel"):
            item["channel"] = p["channel"]
        if p.get("handle"):
            item["handle"] = p["handle"]
        if m.get("s") == "noembed":
            item["noembed"] = True
        if p.get("admin"):
            item["admin"] = True
        out.append(item)

    out.sort(key=lambda p: p["date"], reverse=True)
    authors = len({p.get("channel") or p["author"] for p in out})

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"channel": CHANNEL, "updated": now_iso(), "authors": authors, "posts": out},
                  f, ensure_ascii=False, separators=(",", ":"))
    with open(META, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print(f"готово: {len(out)} видео от {authors} авторов на сайте")


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print("База не скачалась, попробуем в следующий раз:", e)
        sys.exit(0)
