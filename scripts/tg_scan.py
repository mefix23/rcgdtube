"""
Читает открытую страницу канала t.me/s/RCGDTUBE и находит собственные посты канала
(не пересылки) со ссылкой на YouTube.

Зачем: база создателя канала (gdchannels.db) знает только видео с YouTube-каналов из своего
списка, а в канал выкладывают и других авторов. Эти посты сайт берёт отсюда.

Что запоминаем — data/tg_scan.json:
    posts   — {номер поста: {yt, date, title, author, desc, short}}
    oldest  — самый старый просмотренный пост (дальше в прошлое докачиваем понемногу)
    done    — история канала просмотрена до самого начала
"""
import html
import os
import re
import time

import requests

from common import ROOT, UA, load_json

CHANNEL = os.environ.get("TG_CHANNEL", "RCGDTUBE")
STATE = os.path.join(ROOT, "data", "tg_scan.json")
NEW_PAGES = int(os.environ.get("TG_NEW_PAGES", "30"))           # догнать свежие посты
BACKFILL_PAGES = int(os.environ.get("TG_BACKFILL_PAGES", "40"))  # сколько страниц истории за запуск

YT_RE = re.compile(r"(?:youtu\.be/|youtube\.com/(?:watch\?(?:[^\"'\s]*?&(?:amp;)?)?v=|shorts/|live/|embed/))([A-Za-z0-9_-]{11})")
POST_RE = re.compile(r'data-post="[^"/]+/(\d+)"')
DATE_RE = re.compile(r'class="tgme_widget_message_date"[^>]*>\s*<time datetime="([^"]+)"')
TEXT_RE = re.compile(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', re.S)
PREVIEW_RE = re.compile(r'<a class="tgme_widget_message_link_preview"[^>]*href="([^"]+)"')
QUOTE_RE = re.compile(r"<blockquote[^>]*>(.*?)</blockquote>", re.S)


def plain(fragment):
    """HTML → обычный текст с переносами строк."""
    s = re.sub(r"<br\s*/?>", "\n", fragment)
    s = re.sub(r"<[^>]+>", "", s)
    return html.unescape(s).replace("ㅤ", " ").strip()


def tg_date(s):
    """'2026-10-16T09:39:18+00:00' → '2026-10-16T09:39:18Z'"""
    return s.replace("+00:00", "Z") if s else s


def parse_head(text):
    """Первая строка поста «Название — Автор [ORIGINAL]» → (название, автор)."""
    first = next((l.strip() for l in text.split("\n") if l.strip()), "")
    first = re.sub(r"\s*\[[^\]]*\]\s*$", "", first).strip()
    for dash in (" — ", " – ", " - "):
        if dash in first:
            title, author = first.rsplit(dash, 1)
            return title.strip(), author.strip()
    return first, ""


def parse_page(page):
    """Все посты страницы: [(номер, данные или None)]. None — пост без YouTube или пересылка."""
    out = []
    for chunk in page.split('<div class="tgme_widget_message_wrap')[1:]:
        m = POST_RE.search(chunk)
        if not m:
            continue
        mid = int(m.group(1))
        if "tgme_widget_message_forwarded_from" in chunk:
            out.append((mid, None))  # пересылка из другого канала — не берём
            continue
        texts = TEXT_RE.findall(chunk)
        body = texts[-1] if texts else ""
        ids = YT_RE.findall(body)
        url = re.search(r'href="([^"]*(?:youtu\.be|youtube\.com)[^"]*)"', body)
        if not ids:
            pm = PREVIEW_RE.search(chunk)
            if pm:
                ids = YT_RE.findall(pm.group(1))
                url = pm
        if not ids:
            out.append((mid, None))
            continue
        text = plain(body)
        title, author = parse_head(text)
        q = QUOTE_RE.search(body)
        desc = plain(q.group(1)).strip().strip("'\"‘’«»").strip() if q else ""
        d = DATE_RE.search(chunk)
        out.append((mid, {
            "yt": ids[0],
            "date": tg_date(d.group(1)) if d else None,
            "title": title[:200],
            "author": author[:80],
            "desc": desc[:1500],
            "short": bool(url and "/shorts/" in url.group(1)),
        }))
    return out


def fetch(before=None):
    url = f"https://t.me/s/{CHANNEL}" + (f"?before={before}" if before else "")
    r = requests.get(url, headers=UA, timeout=30)
    if r.status_code == 429:
        raise RuntimeError("Telegram просит подождать (429)")
    r.raise_for_status()
    return parse_page(r.text)


def scan():
    """Обновить data/tg_scan.json и вернуть {номер поста: данные}."""
    state = load_json(STATE, {"posts": {}, "oldest": None, "done": False})
    posts = state.setdefault("posts", {})
    known_max = max((int(k) for k in posts), default=0)
    seen_max = state.get("seen_max", known_max)
    pages = 0
    try:
        # 1. свежие посты: листаем назад, пока не дойдём до уже просмотренных
        before = None
        while pages < NEW_PAGES:
            items = fetch(before)
            pages += 1
            if not items:
                break
            for mid, data in items:
                if data:
                    posts[str(mid)] = data
            low = min(mid for mid, _ in items)
            if state.get("oldest") is None or low < state["oldest"]:
                state["oldest"] = low
            state["seen_max"] = max(state.get("seen_max", 0), max(mid for mid, _ in items))
            if low <= seen_max or low <= 1:
                break
            before = low
            time.sleep(1)
        # 2. история: понемногу идём в прошлое
        n = 0
        while not state.get("done") and n < BACKFILL_PAGES and state.get("oldest"):
            time.sleep(1)
            items = fetch(state["oldest"])
            n += 1
            older = [(mid, d) for mid, d in items if mid < state["oldest"]]
            if not older:
                if state["oldest"] <= 100:  # дошли до самого начала канала
                    state["done"] = True
                break  # иначе Telegram просто отдал пустую страницу — продолжим в следующий раз
            for mid, data in older:
                if data:
                    posts[str(mid)] = data
            state["oldest"] = min(mid for mid, _ in older)
            if state["oldest"] <= 1:
                state["done"] = True
        pages += n
    except (requests.RequestException, RuntimeError) as e:
        print("  страница канала не прочиталась, продолжу в следующий раз:", e)

    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    import json
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print(f"страница канала: просмотрено страниц {pages}, постов с YouTube всего {len(posts)}, "
          f"история до поста {state.get('oldest')}{' (вся)' if state.get('done') else ''}")
    return posts
