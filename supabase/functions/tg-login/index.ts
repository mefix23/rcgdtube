// Вход на сайт через Telegram.
// Сайт присылает сюда данные от кнопки «Войти через Telegram».
// Функция проверяет подпись Telegram (ключом бота), создаёт/обновляет аккаунт
// и возвращает одноразовый код, которым сайт открывает сессию.
//
// Секрет в Supabase: TELEGRAM_BOT_TOKEN — токен того же бота, что указан в кнопке входа.
// Настройка функции: «Verify JWT» выключить.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Ключ с полными правами: новый (sb_secret_…) или старый service_role — что есть в проекте.
function serviceKey(): string {
  try {
    const j = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const v = j.default || Object.values(j)[0];
    if (typeof v === "string" && v) return v;
  } catch (_) { /* старый формат */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const FIELDS = ["id", "first_name", "last_name", "username", "photo_url", "auth_date"];

async function checkTelegram(data: Record<string, unknown>, botToken: string) {
  const parts = FIELDS.filter((k) => data[k] !== undefined && data[k] !== null && data[k] !== "")
    .sort().map((k) => `${k}=${data[k]}`);
  const secret = await crypto.subtle.digest("SHA-256", enc.encode(botToken));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", key, enc.encode(parts.join("\n"))));
  return sig === String(data.hash || "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Нужен POST" }, 405);
  try {
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    if (!botToken) return json({ error: "Вход через Telegram ещё не настроен (нет TELEGRAM_BOT_TOKEN)." }, 500);

    const data = await req.json();
    if (!(await checkTelegram(data, botToken))) return json({ error: "Telegram не подтвердил вход. Попробуй ещё раз." }, 401);
    if (Date.now() / 1000 - Number(data.auth_date) > 86400) return json({ error: "Вход устарел. Нажми кнопку ещё раз." }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const tgId = Number(data.id);
    const email = `tg${tgId}@tg.rcgdtube.app`; // письма сюда не отправляются, это просто внутренний логин
    const name = [data.first_name, data.last_name].filter(Boolean).join(" ").slice(0, 80) || String(data.username || "Зритель");

    // создать аккаунт, если его ещё нет (ошибку «уже существует» пропускаем)
    await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { tg_id: tgId } });

    const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (error || !link?.user) throw error || new Error("Не удалось создать вход");

    const { error: pErr } = await admin.from("profiles").upsert({
      id: link.user.id,
      tg_id: tgId,
      username: data.username ? String(data.username).slice(0, 64) : null,
      name,
      photo_url: data.photo_url ? String(data.photo_url).slice(0, 500) : null,
    }, { onConflict: "id" });
    if (pErr) throw pErr;

    return json({ token_hash: link.properties.hashed_token });
  } catch (e) {
    console.error(e);
    return json({ error: "Ошибка входа: " + ((e as Error).message || String(e)) }, 500);
  }
});
