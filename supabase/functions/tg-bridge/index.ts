// Мост комментариев между сайтом и группой комментариев Telegram-канала.
//
// Что делает:
//  1) Telegram присылает сюда новые сообщения из группы комментариев канала (вебхук):
//     - пересланный из канала пост запоминается (пост канала ↔ ветка комментариев в группе);
//     - комментарий в такой ветке сохраняется на сайт под нужным видео.
//  2) Сайт присылает {action: "relay", comment_id} — комментарий с сайта публикуется
//     в ветку под постом в Telegram (от имени бота, с именем автора).
//  3) Владелец присылает {action: "setup"} — функция подключает вебхук у бота.
//
// Работает, только когда владелец канала добавил бота админом в группу комментариев.
// Секреты в Supabase: TELEGRAM_BOT_TOKEN. Необязательно: TG_CHANNEL (по умолчанию RCGDTUBE),
// SITE_URL (по умолчанию https://mefix23.github.io/rcgdtube/).
// Настройка функции: «Verify JWT» выключить (функция сама проверяет, кто пишет).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const enc = new TextEncoder();
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

const BOT = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const BOT_ID = Number(BOT.split(":")[0] || 0);
const CHANNEL = (Deno.env.get("TG_CHANNEL") || "RCGDTUBE").replace(/^@/, "").toLowerCase();
const SITE = Deno.env.get("SITE_URL") || "https://mefix23.github.io/rcgdtube/";
const URL_SELF = `${Deno.env.get("SUPABASE_URL")}/functions/v1/tg-bridge`;
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function webhookSecret() {
  const h = await crypto.subtle.digest("SHA-256", enc.encode("rcgdtube-webhook:" + BOT));
  return [...new Uint8Array(h)].slice(0, 24).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function tg(method: string, body: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return await r.json();
}

// номер поста в канале ↔ видео на сайте (берём из списка сайта, кэшируем на 10 минут)
let mapCache: { at: number; byTg: Map<number, string>; byKey: Map<string, number> } | null = null;
async function videoMap() {
  if (mapCache && Date.now() - mapCache.at < 600_000) return mapCache;
  const r = await fetch(SITE + "data/posts.json?t=" + Date.now());
  const d = await r.json();
  const byTg = new Map<number, string>(), byKey = new Map<string, number>();
  for (const p of d.posts || []) {
    const key = p.key || p.yt;
    if (p.tg && key) { byTg.set(Number(p.tg), key); byKey.set(key, Number(p.tg)); }
  }
  mapCache = { at: Date.now(), byTg, byKey };
  return mapCache;
}

async function onTelegram(update: any) {
  const m = update.message;
  if (!m || !m.chat || (m.chat.type !== "supergroup" && m.chat.type !== "group")) return;

  // 1) пост канала автоматически переслан в группу комментариев
  if (m.is_automatic_forward) {
    const origin = m.forward_origin || {};
    const chan = (origin.chat?.username || m.sender_chat?.username || "").toLowerCase();
    const postId = origin.message_id || m.forward_from_message_id;
    if (chan === CHANNEL && postId) {
      await admin.from("tg_threads").upsert({
        channel_msg_id: postId, group_chat_id: m.chat.id, group_msg_id: m.message_id,
      });
    }
    return;
  }

  // 2) комментарий в ветке под постом
  if (m.from?.id === BOT_ID || m.from?.is_bot) return; // свои сообщения не повторяем
  const text = (m.text || m.caption || "").trim();
  if (!text) return;
  const root = m.message_thread_id || m.reply_to_message?.message_id;
  if (!root) return;
  const { data: th } = await admin.from("tg_threads").select("channel_msg_id")
    .eq("group_chat_id", m.chat.id).eq("group_msg_id", root).maybeSingle();
  if (!th) return;
  const key = (await videoMap()).byTg.get(Number(th.channel_msg_id));
  if (!key) return;
  const who = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || m.from?.username || "Telegram";
  await admin.from("comments").insert({
    video_key: key, user_id: null, body: text.slice(0, 1000), source: "tg",
    tg_author: who.slice(0, 80), tg_message_id: m.message_id,
  });
}

async function userFrom(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data?.user || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Нужен POST" }, 405);
  if (!BOT) return json({ error: "Нет TELEGRAM_BOT_TOKEN" }, 500);
  try {
    // вебхук от Telegram
    const tgSecret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (tgSecret !== null) {
      if (tgSecret !== (await webhookSecret())) return json({ ok: false }, 401);
      await onTelegram(await req.json());
      return json({ ok: true });
    }

    const body = await req.json();
    const user = await userFrom(req);
    if (!user) return json({ error: "Нужно войти в аккаунт" }, 401);

    if (body.action === "setup") {
      const { data: p } = await admin.from("profiles").select("role").eq("id", user.id).single();
      if (p?.role !== "owner") return json({ error: "Только для владельца" }, 403);
      const r = await tg("setWebhook", {
        url: URL_SELF, secret_token: await webhookSecret(), allowed_updates: ["message"], drop_pending_updates: true,
      });
      return json(r);
    }

    if (body.action === "relay") {
      const { data: c } = await admin.from("comments").select("id, video_key, user_id, body, source, tg_message_id")
        .eq("id", body.comment_id).single();
      if (!c || c.user_id !== user.id || c.source !== "site") return json({ error: "Нет такого комментария" }, 404);
      if (c.tg_message_id) return json({ ok: true, already: true });
      const post = (await videoMap()).byKey.get(c.video_key);
      if (!post) return json({ ok: false, reason: "У этого видео нет поста в канале" });
      const { data: th } = await admin.from("tg_threads").select("group_chat_id, group_msg_id")
        .eq("channel_msg_id", post).maybeSingle();
      if (!th) return json({ ok: false, reason: "Ветка комментариев этого поста ещё не подключена" });
      const { data: prof } = await admin.from("profiles").select("name").eq("id", user.id).single();
      const r = await tg("sendMessage", {
        chat_id: th.group_chat_id, reply_to_message_id: th.group_msg_id, parse_mode: "HTML",
        text: `💬 <b>${esc(prof?.name || "Зритель")}</b> с сайта:\n${esc(c.body)}`,
        link_preview_options: { is_disabled: true },
      });
      if (r.ok) await admin.from("comments").update({ tg_message_id: r.result.message_id }).eq("id", c.id);
      return json({ ok: !!r.ok });
    }

    return json({ error: "Неизвестное действие" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message || String(e) }, 500);
  }
});
