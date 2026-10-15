"""
Забирает новые посты с открытой страницы канала t.me/s/RCGDTUBE
и складывает их в data/posts.json, а превью и фото — в media/.

Запускается автоматически на GitHub каждые 15 минут.
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

CHANNEL = os.environ.get("CHANNEL", "RCGDTUBE")
MAX_POSTS = int(os.environ.get("MAX_POSTS", "600"))      # сколько последних постов хранить
FIRST_RUN_PAGES = int(os.environ.get("FIRST_RUN_PAGES", "15"))  # сколько страниц истории взять при первом запуске
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data", "posts.json")
MEDIA = os.path.join(ROOT, "media")
UA = {"User-Agent": "Mozilla/5.0 (compatible; RCGDTUBE-site/1.0)"}

BG_URL = re.compile(r"background-image:\s*url\(['\"]?([^'\")]+)")


def bg(el):
    if not el:
        return None
    m = BG_URL.search(el.get("style", ""))
    return m.group(1) if m else None


def parse_page(html):
    soup = BeautifulSoup(html, "html.parser")
    og = soup.select_one('meta[property="og:image"]')
    if og and og.get("content"):
        try:
            r = requests.get(og["content"], headers=UA, timeout=30)
            r.raise_for_status()
            with open(os.path.join(MEDIA, "logo.jpg"), "wb") as f:
                f.write(r.content)
        except Exception as e:
            print("  аватарка не скачалась:", e)
    posts = []
    for msg in soup.select("div.tgme_widget_message[data-post]"):
        try:
            pid = int(msg["data-post"].split("/")[-1])
        except ValueError:
            continue

        text_el = msg.select_one(".tgme_widget_message_text")
        text = ""
        if text_el:
            for br in text_el.find_all("br"):
                br.replace_with("\n")
            text = re.sub(r"[ \t]+", " ", text_el.get_text("")).strip()

        videos = msg.select(".tgme_widget_message_video_player")
        photos = msg.select("a.tgme_widget_message_photo_wrap")
        if not videos and not photos:
            continue  # на сайт попадают только посты с видео или фото

        fwd = msg.select_one(".tgme_widget_message_forwarded_from_name")
        sign = msg.select_one(".tgme_widget_message_from_author")
        when = msg.select_one(".tgme_widget_message_date time[datetime]")
        views = msg.select_one(".tgme_widget_message_views")

        first = text.split("\n", 1)[0].strip() if text else ""
        title, author = first, None
        # посты канала оформлены как «Название — Автор [ORIGINAL]»
        m = re.match(r"^(.*?)\s+—\s+(.+?)(?:\s*\[\s*ORIGINAL\s*\])?$", first)
        if m:
            title, author = m.group(1).strip(), m.group(2).strip()
        if not author:
            author = (fwd.get_text(strip=True) if fwd else None) or (sign.get_text(strip=True) if sign else None) or "РКГДTUBE"
        if not title:
            title = ("Видео от " if videos else "Фото от ") + author

        yt = None
        for a in (text_el.select("a[href]") if text_el else []):
            if re.search(r"youtu\.?be", a["href"]):
                yt = a["href"]
                break

        quote = None
        if text and "\n" in text:
            rest = text.split("\n", 1)[1]
            rest = re.sub(r"(?m)^#\S+.*$", "", rest).strip()
            rest = rest.replace("РКГДTUBE", "").replace("ㅤ", "").strip()
            quote = rest[:600] or None

        reactions = []
        for r in msg.select(".tgme_reaction"):
            t = r.get_text(" ", strip=True)
            if t:
                reactions.append(t)

        post = {
            "id": pid,
            "title": title[:140],
            "author": author[:80],
            "date": when["datetime"] if when else None,
            "views": views.get_text(strip=True) if views else "",
            "tags": sorted(set(re.findall(r"#([\w\d_]+)", text))),
            "forwarded": bool(fwd),
            "youtube": yt,
            "quote": quote,
            "reactions": reactions[:6],
            "kind": "video" if videos else "photo",
        }
        if videos:
            dur = msg.select_one(".message_video_duration")
            post["duration"] = dur.get_text(strip=True) if dur else None
            post["_thumb_src"] = bg(videos[0].select_one(".tgme_widget_message_video_thumb"))
        else:
            post["photo_count"] = len(photos)
            post["_photo_srcs"] = [u for u in (bg(p) for p in photos) if u]
        posts.append(post)

    more = soup.select_one("a.tme_messages_more[data-before]")
    before = int(more["data-before"]) if more else None
    return posts, before


def fetch(before=None):
    url = f"https://t.me/s/{CHANNEL}" + (f"?before={before}" if before else "")
    r = requests.get(url, headers=UA, timeout=30)
    r.raise_for_status()
    return r.text


def download(url, path):
    if os.path.exists(path):
        return True
    try:
        r = requests.get(url, headers=UA, timeout=30)
        r.raise_for_status()
        with open(path, "wb") as f:
            f.write(r.content)
        return True
    except Exception as e:
        print("  не скачалось:", url[:60], e)
        return False


def main():
    os.makedirs(MEDIA, exist_ok=True)
    old = []
    if os.path.exists(DATA):
        with open(DATA, encoding="utf-8") as f:
            old = json.load(f).get("posts", [])
    known = {p["id"]: p for p in old}

    pages = 1 if known else FIRST_RUN_PAGES
    found, before = [], None
    for i in range(pages):
        batch, before = parse_page(fetch(before))
        found += batch
        print(f"страница {i + 1}: {len(batch)} постов с медиа")
        if not before:
            break
        time.sleep(1.5)

    for p in found:
        pid = p["id"]
        if p["kind"] == "video":
            src = p.pop("_thumb_src", None)
            name = f"{pid}.jpg"
            if src and download(src, os.path.join(MEDIA, name)):
                p["thumb"] = f"media/{name}"
            elif pid in known and known[pid].get("thumb"):
                p["thumb"] = known[pid]["thumb"]
        else:
            srcs = p.pop("_photo_srcs", [])
            p["photos"] = []
            for n, src in enumerate(srcs[:10]):
                name = f"{pid}_{n}.jpg"
                if download(src, os.path.join(MEDIA, name)):
                    p["photos"].append(f"media/{name}")
            if p["photos"]:
                p["thumb"] = p["photos"][0]
        known[pid] = p  # свежие данные (просмотры, реакции) заменяют старые

    posts = sorted(known.values(), key=lambda p: p["id"], reverse=True)[:MAX_POSTS]

    # удаляем картинки постов, которые выпали из списка
    keep = {"logo.jpg"}
    for p in posts:
        keep.update(os.path.basename(x) for x in ([p.get("thumb")] + p.get("photos", [])) if x)
    for name in os.listdir(MEDIA):
        if name not in keep and name.endswith(".jpg"):
            os.remove(os.path.join(MEDIA, name))

    os.makedirs(os.path.dirname(DATA), exist_ok=True)
    with open(DATA, "w", encoding="utf-8") as f:
        json.dump({
            "channel": CHANNEL,
            "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "posts": posts,
        }, f, ensure_ascii=False, indent=1)
    print(f"готово: {len(posts)} постов на сайте")


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print("Telegram не ответил, попробуем в следующий раз:", e)
        sys.exit(0)
