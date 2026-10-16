"""
РКГДTUBE stream — отдаёт сайту видео из Telegram-канала, чтобы смотреть без YouTube и без VPN.

Как работает: сервер входит в Telegram (обычный аккаунт, лучше запасной), по номеру поста
находит видео в канале @RCGDTUBE и отдаёт его кусочками (HTTP Range) — поэтому перемотка
работает сразу, а файл целиком никуда не скачивается и нигде не хранится.

Адреса:
  GET /                 — проверка, что сервер жив: {"ok": true, "authorized": true}
  GET /info/<пост>      — есть ли в посте видео: размер, длительность, ширина, высота
  GET /v/<пост>         — само видео (поддерживает перемотку)
  GET /thumb/<пост>     — картинка-превью из Telegram
  GET /setup?key=…      — первый вход в Telegram через QR-код (ключ — SETUP_KEY)

Настройки (переменные окружения):
  TG_API_ID, TG_API_HASH — ключи приложения с my.telegram.org (бесплатно)
  SESSION_PATH           — файл, где сервер сам хранит вход (на своём сервере/VPS — удобнее всего)
  TG_SESSION             — или строка входа (для хостингов без диска); её показывает /setup
  SETUP_KEY              — пароль для страницы /setup (любой длинный)
  CHANNEL                — канал, по умолчанию RCGDTUBE
  PORT                   — порт, хостинг подставляет сам
"""
import asyncio
import html
import json
import os
import time
from collections import OrderedDict

from aiohttp import web
from telethon import TelegramClient, errors
from telethon.sessions import StringSession
from telethon.tl.types import DocumentAttributeVideo, MessageMediaDocument

API_ID = int(os.environ.get("TG_API_ID", "0") or 0)
API_HASH = os.environ.get("TG_API_HASH", "")
SESSION = os.environ.get("TG_SESSION", "")
SESSION_PATH = os.environ.get("SESSION_PATH", "")
SETUP_KEY = os.environ.get("SETUP_KEY", "")
CHANNEL = os.environ.get("CHANNEL", "RCGDTUBE").lstrip("@")
PORT = int(os.environ.get("PORT", "8080"))

CHUNK = 512 * 1024          # Telegram отдаёт файл кусками по 512 КБ
MSG_TTL = 30 * 60           # сколько помнить найденный пост
MAX_STREAMS = int(os.environ.get("MAX_STREAMS", "8"))  # одновременных просмотров

FILE_SESSION = bool(SESSION_PATH and not SESSION)
client = TelegramClient(SESSION_PATH if FILE_SESSION else StringSession(SESSION), API_ID, API_HASH,
                        device_model="RCGDTUBE stream", app_version="1.0", connection_retries=None)
streams = asyncio.Semaphore(MAX_STREAMS)
msg_cache: "OrderedDict[int, tuple[float, object]]" = OrderedDict()
thumb_cache: "OrderedDict[int, bytes]" = OrderedDict()
setup = {"qr": None, "need_password": False, "error": "", "done": False}


# ---------- Telegram ----------
def video_of(msg):
    """Документ с видео из поста или None."""
    media = getattr(msg, "media", None)
    if not isinstance(media, MessageMediaDocument) or not media.document:
        return None
    doc = media.document
    if not (doc.mime_type or "").startswith("video/"):
        return None
    return doc


def info_of(doc):
    attr = next((a for a in doc.attributes if isinstance(a, DocumentAttributeVideo)), None)
    return {
        "size": doc.size,
        "mime": doc.mime_type,
        "duration": getattr(attr, "duration", None),
        "w": getattr(attr, "w", None),
        "h": getattr(attr, "h", None),
        "thumb": bool(doc.thumbs),
    }


async def get_post(mid, fresh=False):
    """Пост канала по номеру (с кэшем). None — поста нет."""
    now = time.time()
    hit = msg_cache.get(mid)
    if hit and not fresh and hit[0] > now:
        msg_cache.move_to_end(mid)
        return hit[1]
    msg = await client.get_messages(CHANNEL, ids=mid)
    msg_cache[mid] = (now + MSG_TTL, msg)
    while len(msg_cache) > 2000:
        msg_cache.popitem(last=False)
    return msg


def authorized_or_503():
    if not client.is_connected() or not setup.get("authorized"):
        raise web.HTTPServiceUnavailable(text=json.dumps({"ok": False, "error": "not authorized"}),
                                         content_type="application/json", headers=CORS)


# ---------- HTTP ----------
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges"}


def jresp(data, status=200, cache=0):
    h = dict(CORS)
    h["Cache-Control"] = f"public, max-age={cache}" if cache else "no-store"
    return web.json_response(data, status=status, headers=h)


def post_id(request):
    try:
        mid = int(request.match_info["mid"].split(".")[0])
    except ValueError:
        raise web.HTTPNotFound()
    if not 0 < mid < 10 ** 9:
        raise web.HTTPNotFound()
    return mid


def parse_range(header, size):
    """'bytes=100-' → (100, size-1). None — весь файл. ValueError — плохой диапазон."""
    if not header or not header.startswith("bytes="):
        return None
    spec = header[6:].split(",")[0].strip()
    a, _, b = spec.partition("-")
    if a == "":  # последние N байт
        n = int(b)
        if n <= 0:
            raise ValueError
        return max(0, size - n), size - 1
    start = int(a)
    end = int(b) if b else size - 1
    if start >= size or start > end:
        raise ValueError
    return start, min(end, size - 1)


async def health(request):
    return jresp({"ok": True, "authorized": bool(setup.get("authorized")), "channel": CHANNEL})


async def info(request):
    authorized_or_503()
    mid = post_id(request)
    try:
        msg = await get_post(mid)
    except (errors.RPCError, ValueError) as e:
        return jresp({"ok": False, "error": type(e).__name__}, 502)
    doc = video_of(msg) if msg else None
    return jresp({"ok": True, "post": mid, "video": info_of(doc) if doc else None}, cache=300)


async def thumb(request):
    authorized_or_503()
    mid = post_id(request)
    if mid in thumb_cache:
        data = thumb_cache[mid]
    else:
        msg = await get_post(mid)
        doc = video_of(msg) if msg else None
        if not doc or not doc.thumbs:
            raise web.HTTPNotFound()
        data = await client.download_media(msg, file=bytes, thumb=-1)
        if not data:
            raise web.HTTPNotFound()
        thumb_cache[mid] = data
        while len(thumb_cache) > 300:
            thumb_cache.popitem(last=False)
    return web.Response(body=data, content_type="image/jpeg", headers={**CORS, "Cache-Control": "public, max-age=86400"})


async def video(request):
    authorized_or_503()
    mid = post_id(request)
    msg = await get_post(mid)
    doc = video_of(msg) if msg else None
    if not doc:
        raise web.HTTPNotFound(text="в этом посте нет видео")
    size = doc.size
    try:
        rng = parse_range(request.headers.get("Range"), size)
    except ValueError:
        raise web.HTTPRequestRangeNotSatisfiable(headers={**CORS, "Content-Range": f"bytes */{size}"})
    start, end = rng if rng else (0, size - 1)
    length = end - start + 1
    headers = {**CORS, "Content-Type": doc.mime_type or "video/mp4", "Accept-Ranges": "bytes",
               "Content-Length": str(length), "Cache-Control": "public, max-age=86400"}
    if rng:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    resp = web.StreamResponse(status=206 if rng else 200, headers=headers)
    if request.method == "HEAD":
        await resp.prepare(request)
        return resp

    async with streams:
        await resp.prepare(request)
        sent, retried = 0, False
        while sent < length:
            pos = start + sent
            aligned = pos - pos % CHUNK
            skip = pos - aligned
            try:
                async for chunk in client.iter_download(doc, offset=aligned, request_size=CHUNK, file_size=size):
                    if skip:
                        chunk, skip = chunk[skip:], 0
                    chunk = chunk[: length - sent]
                    if not chunk:
                        break
                    await resp.write(chunk)
                    sent += len(chunk)
                    if sent >= length:
                        break
                break
            except errors.FileReferenceExpiredError:
                if retried:
                    raise
                retried = True  # ссылка на файл протухла — берём пост заново и продолжаем с того же места
                msg = await get_post(mid, fresh=True)
                doc = video_of(msg)
                if not doc:
                    break
            except ConnectionResetError:
                break  # зритель закрыл видео или перемотал
    return resp


# ---------- первый вход (QR-код) ----------
PAGE = """<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>РКГДTUBE stream — вход</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0c0711;color:#f3e9f7;max-width:560px;margin:0 auto;padding:24px 16px}
h1{font-size:22px}.card{background:#1a1022;border-radius:14px;padding:18px;margin:16px 0}#qr{background:#fff;padding:14px;border-radius:12px;width:fit-content}
input,button{font:inherit;padding:10px 14px;border-radius:10px;border:1px solid #4a3357;background:#120a18;color:inherit}button{background:#e43ad6;border:0;color:#fff;cursor:pointer}
textarea{width:100%;height:120px;font:12px monospace;background:#120a18;color:#f3e9f7;border-radius:10px;border:1px solid #4a3357;padding:10px;box-sizing:border-box}.err{color:#ff7a7a}</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head><body>
<h1>Вход сервера РКГДTUBE в Telegram</h1><div id="box" class="card">Загружаю…</div>
<script>
const key=new URLSearchParams(location.search).get("key")||"";
const box=document.getElementById("box");
async function step(){
  const r=await fetch("setup/state?key="+encodeURIComponent(key)); const s=await r.json();
  if(s.error){box.innerHTML='<p class="err">'+s.error+'</p><button onclick="location.reload()">Попробовать ещё раз</button>';return;}
  if(s.session){box.innerHTML='<p><b>Готово, сервер вошёл в Telegram.</b></p><p>Чтобы вход не пропал после перезапуска, скопируй строку ниже и вставь её в настройках хостинга в переменную <b>TG_SESSION</b>. Никому её не показывай — это как пароль от аккаунта.</p><textarea readonly onclick="this.select()">'+s.session+'</textarea>';return;}
  if(s.done){box.innerHTML='<p><b>Сервер уже вошёл в Telegram.</b> Ничего делать не нужно.</p>';return;}
  if(s.need_password){box.innerHTML='<p>На аккаунте стоит облачный пароль. Введи его:</p><form id="pf"><input type="password" id="pw" autocomplete="current-password"> <button>Войти</button></form>';
    document.getElementById("pf").onsubmit=async e=>{e.preventDefault();box.textContent="Проверяю…";
      await fetch("setup/password?key="+encodeURIComponent(key),{method:"POST",body:document.getElementById("pw").value});step();};return;}
  if(s.qr){box.innerHTML='<p>Открой Telegram на телефоне → <b>Настройки → Устройства → Подключить устройство</b> и наведи камеру на код:</p><div id="qr"></div><p style="opacity:.7">Код обновляется сам. Лучше использовать запасной аккаунт.</p>';
    new QRCode(document.getElementById("qr"),{text:s.qr,width:240,height:240});}
  setTimeout(step,2500);
}
step();
</script></body></html>"""


def check_key(request):
    if not SETUP_KEY or request.query.get("key") != SETUP_KEY:
        raise web.HTTPForbidden(text="Нужен правильный ключ: /setup?key=…")


async def setup_page(request):
    check_key(request)
    return web.Response(text=PAGE, content_type="text/html")


async def qr_loop():
    """Показываем QR-код, пока человек его не отсканирует."""
    while not setup.get("authorized") and not setup["need_password"]:
        qr = await client.qr_login()
        setup["qr"] = qr.url
        try:
            await qr.wait(timeout=25)
        except asyncio.TimeoutError:
            continue  # код устарел — делаем новый
        except errors.SessionPasswordNeededError:
            setup["need_password"] = True
            return
        except Exception as e:  # noqa: BLE001
            setup["error"] = f"Не получилось: {type(e).__name__}"
            return
        await logged_in()
        return


async def logged_in():
    setup.update(authorized=True, qr=None, need_password=False,
                 session=None if FILE_SESSION else client.session.save())  # строку показываем, только если диска нет
    me = await client.get_me()
    print(f"вошли в Telegram как {me.first_name} (id {me.id})", flush=True)


async def setup_state(request):
    check_key(request)
    if setup.get("authorized"):
        s = setup.pop("session", None)  # строку показываем один раз
        return jresp({"done": True, "session": s} if s else {"done": True})
    if setup["error"]:
        err, setup["error"] = setup["error"], ""
        setup["task"] = None
        return jresp({"error": err})
    if not setup.get("task") and not setup["need_password"]:
        setup["task"] = asyncio.create_task(qr_loop())
    return jresp({"qr": setup.get("qr"), "need_password": setup["need_password"]})


async def setup_password(request):
    check_key(request)
    pw = (await request.text())[:256]
    try:
        await client.sign_in(password=pw)
        await logged_in()
    except errors.PasswordHashInvalidError:
        setup["error"] = "Неверный облачный пароль."
        setup["need_password"] = False
    except errors.RPCError as e:
        setup["error"] = f"Не получилось: {type(e).__name__}"
        setup["need_password"] = False
    return jresp({"ok": True})


async def on_start(app):
    if not API_ID or not API_HASH:
        print("Нет TG_API_ID / TG_API_HASH — сервер не сможет войти в Telegram.", flush=True)
        return
    await client.connect()
    if await client.is_user_authorized():
        setup["authorized"] = True
        me = await client.get_me()
        print(f"Telegram: вошли как {me.first_name}", flush=True)
    else:
        print("Telegram: нужен вход — открой /setup?key=… (SETUP_KEY)", flush=True)


async def on_stop(app):
    await client.disconnect()


def make_app():
    app = web.Application()
    app.router.add_get("/", health)
    app.router.add_get("/info/{mid}", info)
    app.router.add_get("/thumb/{mid}", thumb)
    app.router.add_route("GET", "/v/{mid}", video)
    app.router.add_route("HEAD", "/v/{mid}", video)
    app.router.add_get("/setup", setup_page)
    app.router.add_get("/setup/state", setup_state)
    app.router.add_post("/setup/password", setup_password)
    app.on_startup.append(on_start)
    app.on_cleanup.append(on_stop)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), port=PORT, access_log=None)
