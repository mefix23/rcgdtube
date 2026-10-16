"""Общее для сборщика и бота: настройки сайта и чтение базы Supabase."""
import json
import os
import re

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {"User-Agent": "Mozilla/5.0 (compatible; RCGDTUBE-site/3.0)", "Accept-Language": "ru,en;q=0.8"}


def site_config():
    """Настройки из assets/config.js (адрес Supabase и публичный ключ)."""
    try:
        with open(os.path.join(ROOT, "assets", "config.js"), encoding="utf-8") as f:
            text = f.read()
        return json.loads(text[text.index("{"):text.rindex("}") + 1])
    except (OSError, ValueError):
        return {}


CFG = site_config()
SB_URL = (os.environ.get("SUPABASE_URL") or CFG.get("supabaseUrl") or "").rstrip("/")
SB_KEY = os.environ.get("SUPABASE_KEY") or CFG.get("supabaseKey") or ""
SITE = CFG.get("site") or "https://mefix23.github.io/rcgdtube/"


def sb_ready():
    return bool(SB_URL and SB_KEY)


def sb_get(table, params):
    """Прочитать таблицу Supabase через REST (только то, что разрешено всем)."""
    headers = {**UA, "apikey": SB_KEY}
    if SB_KEY.startswith("eyJ"):  # старый формат ключа (JWT) нужно передавать и сюда
        headers["Authorization"] = f"Bearer {SB_KEY}"
    r = requests.get(f"{SB_URL}/rest/v1/{table}", params=params, timeout=30, headers=headers)
    r.raise_for_status()
    return r.json()


def storage_url(path):
    return f"{SB_URL}/storage/v1/object/public/videos/{path}" if path else None


def approved_submissions():
    if not sb_ready():
        return []
    try:
        return sb_get("submissions", {"select": "*", "status": "eq.approved", "order": "reviewed_at.desc", "limit": "2000"})
    except Exception as e:
        print("  заявки из базы не прочитались:", e)
        return []


def hidden_keys():
    if not sb_ready():
        return set()
    try:
        return {x["video_key"] for x in sb_get("hidden_videos", {"select": "video_key"})}
    except Exception as e:
        print("  скрытые видео не прочитались:", e)
        return set()


def submission_key(s):
    return s["yt_id"] if s["kind"] == "youtube" else "f-" + s["id"]


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def hashtag(s):
    t = re.sub(r"[^\w]+", "_", (s or "").strip(), flags=re.UNICODE).strip("_")
    return "#" + t if t else ""
