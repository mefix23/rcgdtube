"""
Собирает список видео для сайта РКГДTUBE → data/posts.json.

Откуда берутся видео:
  1. SQL-база создателя канала: github.com/kilor231/rcgdtube-bd (gdchannels.db) —
     ворки с YouTube, которые выходили в канале, без пересылок.
  2. Открытая страница канала t.me/s/RCGDTUBE — собственные посты канала (не пересылки)
     со ссылкой на YouTube. Так на сайт попадают авторы, которых нет в базе (scripts/tg_scan.py).
  3. Заявки зрителей, которые одобрили модераторы (таблица submissions в Supabase).

Для видео с YouTube узнаём название и проверяем, Shorts это или обычное видео.
Ответы YouTube запоминаются в data/yt_meta.json, чтобы не спрашивать заново.
Модераторы могут скрыть любое видео (таблица hidden_videos) — его в списке не будет.
Запускается на GitHub каждые 15 минут.
"""
import json
import os
import sqlite3
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ROOT, UA, approved_submissions, hidden_keys, load_json, storage_url, submission_key  # noqa: E402
from tg_scan import scan as scan_channel  # noqa: E402

DB_URL = os.environ.get("DB_URL", "https://raw.githubusercontent.com/kilor231/rcgdtube-bd/main/gdchannels.db")
MAIN_CHAT_ID = int(os.environ.get("MAIN_CHAT_ID", "-1002627414327"))  # канал РКГДTUBE внутри базы
CHANNEL = "RCGDTUBE"
LOOKUPS_PER_RUN = int(os.environ.get("LOOKUPS_PER_RUN", "1500"))  # сколько видео проверять на YouTube за запуск

OUT = os.path.join(ROOT, "data", "posts.json")
META = os.path.join(ROOT, "data", "yt_meta.json")
POSTED = os.path.join(ROOT, "data", "tg_posted.json")
YT_COOKIES = {"CONSENT": "YES+cb", "SOCS": "CAI"}  # чтобы YouTube не показывал окно согласия


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def db_time(s):
    """'2026-10-15 18:33:37' (UTC) -> '2026-10-15T18:33:37Z'"""
    return s.replace(" ", "T") + "Z" if s and "T" not in s else s


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
        SELECT p.message_id, p.video_id, p.detected_at, c.channel_id, c.channel_name, c.handle
        FROM gdchannel_posts p
        LEFT JOIN gdchannels c ON c.channel_id = p.channel_id
        WHERE p.chat_id = ?
        ORDER BY p.detected_at DESC, p.message_id DESC
        """,
        (MAIN_CHAT_ID,),
    ).fetchall()
    handles = {h.lower(): (cid, name, h) for cid, name, h in
               con.execute("SELECT channel_id, channel_name, handle FROM gdchannels WHERE handle IS NOT NULL")}
    con.close()
    posts, seen = [], set()
    for mid, vid, at, cid, cname, handle in rows:
        if not vid or vid in seen:
            continue  # одно видео выкладывали несколько раз: берём самый свежий пост
        seen.add(vid)
        posts.append({"key": vid, "yt": vid, "tg": mid, "date": db_time(at),
                      "author": cname or "", "channel": cid, "handle": handle})
    return posts, handles


def oembed(vid):
    """Название и автор с YouTube. None — YouTube не ответил, спросим в следующий раз."""
    url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={vid}&format=json"
    try:
        r = requests.get(url, headers=UA, timeout=20)
    except requests.RequestException:
        return None
    if r.status_code == 200:
        try:
            j = r.json()
        except ValueError:
            return None
        return {"t": j.get("title", ""), "a": j.get("author_name", ""), "u": j.get("author_url", ""), "s": "ok"}
    if r.status_code in (401, 403):
        return {"t": "", "a": "", "s": "noembed"}  # видео есть, но встраивать запрещено
    if r.status_code in (400, 404):
        return {"t": "", "a": "", "s": "gone"}  # видео удалено или скрыто
    return None


def is_short(vid):
    """Shorts открывается по адресу /shorts/ID, обычное видео оттуда перекидывает на /watch."""
    try:
        r = requests.head(f"https://www.youtube.com/shorts/{vid}", headers=UA, cookies=YT_COOKIES,
                          allow_redirects=False, timeout=15)
    except requests.RequestException:
        return None
    if r.status_code == 200:
        return True
    if r.status_code in (301, 302, 303, 307, 308):
        loc = r.headers.get("location", "")
        if "consent" in loc:
            return None
        return False
    return None


def lookup(vid, have):
    """Узнать то, чего ещё нет в кэше: название и/или Shorts."""
    info = dict(have or {})
    if "s" not in info:
        o = oembed(vid)
        if o is None:
            return vid, None
        info.update(o)
    if "sh" not in info and info.get("s") != "gone":
        sh = is_short(vid)
        if sh is not None:
            info["sh"] = sh
    info["at"] = now_iso()[:10]
    return vid, info


def main():
    meta = load_json(META, {})
    posted = load_json(POSTED, {}).get("posted", {})

    db_path = download_db()
    posts, handles = read_db(db_path)
    os.remove(db_path)
    print(f"в базе канала: {len(posts)} видео")

    # посты со страницы канала: подписи к ворку (название, автор, описание) и видео, которых нет в базе
    scanned = scan_channel()
    by_vid = {p["yt"]: p for p in posts}
    added = 0
    for mid, sp in sorted(scanned.items(), key=lambda x: int(x[0]), reverse=True):
        vid = sp.get("yt")
        if not vid:
            continue
        p = by_vid.get(vid)
        if p is None:
            p = {"key": vid, "yt": vid, "tg": int(mid), "date": sp.get("date"), "author": "", "scan": True}
            posts.append(p)
            by_vid[vid] = p
            added += 1
        elif p.get("tg") != int(mid):
            continue  # то же видео в другом посте — подпись берём только из своего поста
        if sp.get("author"):  # пост в формате канала «Название — Автор»
            p["title"] = sp.get("title") or p.get("title")
            p.setdefault("post_author", sp["author"])
        if sp.get("desc"):
            p["desc"] = sp["desc"]
        if sp.get("short"):
            p["short"] = True
    print(f"со страницы канала добавлено видео, которых нет в базе: {added}")

    hidden = hidden_keys()
    keys = {p["key"] for p in posts}
    subs = approved_submissions()
    for s in subs:
        key = submission_key(s)
        if key in keys:
            continue
        keys.add(key)
        tg = posted.get(key)
        posts.append({
            "key": key, "yt": s.get("yt_id"), "file": storage_url(s.get("file_path")), "thumb": storage_url(s.get("thumb_path")),
            "title": s.get("title") or "", "author": s.get("author") or "", "desc": s.get("description") or "",
            "date": s.get("reviewed_at") or s.get("created_at"), "short": bool(s.get("is_short")), "approved": True,
            "tg": (tg.get("msg") if isinstance(tg, dict) else None),
        })
    print(f"одобренных заявок: {len(subs)}, скрыто модераторами: {len(hidden)}")

    # что узнать на YouTube: сначала свежие, сначала то, чего совсем нет в кэше
    need = [p["yt"] for p in sorted(posts, key=lambda p: p.get("date") or "", reverse=True)
            if p.get("yt") and ("s" not in meta.get(p["yt"], {}) or "sh" not in meta.get(p["yt"], {}))
            and meta.get(p["yt"], {}).get("s") != "gone"]
    need.sort(key=lambda v: "s" in meta.get(v, {}))
    need = need[:LOOKUPS_PER_RUN]
    if need:
        print(f"проверяю на YouTube: {len(need)}")
        got = 0
        with ThreadPoolExecutor(max_workers=8) as pool:
            for vid, info in pool.map(lambda v: lookup(v, meta.get(v)), need):
                if info:
                    meta[vid] = info
                    got += 1
        print(f"  получено: {got}")

    out = []
    for p in posts:
        m = meta.get(p.get("yt") or "", {})
        if p["key"] in hidden or m.get("s") == "gone":
            continue
        if p.get("scan") and not p.get("channel"):
            h = (m.get("u") or "").rstrip("/").rsplit("/", 1)[-1]
            if h.startswith("@") and h.lower() in handles:
                p["channel"], p["author"], p["handle"] = handles[h.lower()]
            elif h.startswith("@"):
                p["handle"] = h
        author = p.get("author") or p.get("post_author") or m.get("a") or "Неизвестный автор"
        item = {"key": p["key"], "title": p.get("title") or m.get("t") or f"Ворк от {author}",
                "author": author, "date": p.get("date")}
        for f in ("yt", "file", "thumb", "tg", "channel", "handle", "desc"):
            if p.get(f):
                item[f] = p[f]
        if p.get("short") or m.get("sh"):
            item["short"] = True
        if m.get("s") == "noembed":
            item["noembed"] = True
        if p.get("approved"):
            item["approved"] = True
        out.append(item)

    out.sort(key=lambda p: p.get("date") or "", reverse=True)
    authors = len({p.get("channel") or p["author"] for p in out})
    shorts = sum(1 for p in out if p.get("short"))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"channel": CHANNEL, "updated": now_iso(), "authors": authors, "shorts": shorts, "posts": out},
                  f, ensure_ascii=False, separators=(",", ":"))
    with open(META, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print(f"готово: {len(out)} видео ({shorts} Shorts) от {authors} авторов")


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print("База не скачалась, попробуем в следующий раз:", e)
        sys.exit(0)
