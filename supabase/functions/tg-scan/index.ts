// Свежие видео из канала — без ожидания GitHub.
// Каждые 5 минут Supabase (pg_cron) вызывает эту функцию. Она читает открытую страницу
// t.me/s/RCGDTUBE, берёт собственные посты канала (не пересылки) со ссылкой на YouTube
// и записывает их в таблицу channel_posts. Сайт показывает их сразу.
// Настройка функции: «Verify JWT» выключить (функция только читает открытую страницу канала).
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

const CHANNEL = Deno.env.get("TG_CHANNEL") || "RCGDTUBE";
const UA = { "user-agent": "Mozilla/5.0 (RCGDTUBE site; +https://mefix23.github.io/rcgdtube/)" };
const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const YT_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^"'\s]*?&(?:amp;)?)?v=|shorts\/|live\/|embed\/))([A-Za-z0-9_-]{11})/g;
const POST_RE = /data-post="[^"\/]+\/(\d+)"/;
const DATE_RE = /class="tgme_widget_message_date"[^>]*>\s*<time datetime="([^"]+)"/;
const TEXT_RE = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
const PREVIEW_RE = /<a class="tgme_widget_message_link_preview"[^>]*href="([^"]+)"/;
const QUOTE_RE = /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/;

type Row = { tg: number; yt: string; title: string; author: string; descr: string; posted_at: string | null; short: boolean };

function unescape(s: string) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
function plain(f: string) {
  return unescape(f.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "")).replace(/ㅤ/g, " ").trim();
}
function parseHead(text: string): [string, string] {
  let first = (text.split("\n").find((l) => l.trim()) || "").trim();
  first = first.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  for (const dash of [" — ", " – ", " - "]) {
    const i = first.lastIndexOf(dash);
    if (i > 0) return [first.slice(0, i).trim(), first.slice(i + dash.length).trim()];
  }
  return [first, ""];
}

function parsePage(page: string): { tg: number; row: Row | null }[] {
  const out: { tg: number; row: Row | null }[] = [];
  for (const chunk of page.split('<div class="tgme_widget_message_wrap').slice(1)) {
    const m = chunk.match(POST_RE);
    if (!m) continue;
    const tg = Number(m[1]);
    if (chunk.includes("tgme_widget_message_forwarded_from")) { out.push({ tg, row: null }); continue; }
    const texts = [...chunk.matchAll(TEXT_RE)].map((x) => x[1]);
    const body = texts.length ? texts[texts.length - 1] : "";
    let ids = [...body.matchAll(YT_RE)].map((x) => x[1]);
    let url = body.match(/href="([^"]*(?:youtu\.be|youtube\.com)[^"]*)"/)?.[1] || "";
    if (!ids.length) {
      const pm = chunk.match(PREVIEW_RE);
      if (pm) { ids = [...pm[1].matchAll(YT_RE)].map((x) => x[1]); url = pm[1]; }
    }
    if (!ids.length) { out.push({ tg, row: null }); continue; }
    const [title, author] = parseHead(plain(body));
    const q = body.match(QUOTE_RE);
    const descr = q ? plain(q[1]).replace(/^['"‘’«»\s]+|['"‘’«»\s]+$/g, "") : "";
    const d = chunk.match(DATE_RE)?.[1] || null;
    out.push({
      tg,
      row: {
        tg, yt: ids[0], title: title.slice(0, 200), author: author.slice(0, 80), descr: descr.slice(0, 1500),
        posted_at: d ? d.replace("+00:00", "Z") : null, short: url.includes("/shorts/"),
      },
    });
  }
  return out;
}

async function isShort(vid: string): Promise<boolean | null> {
  try {
    const r = await fetch(`https://www.youtube.com/shorts/${vid}`, {
      method: "HEAD", redirect: "manual", headers: { ...UA, cookie: "CONSENT=YES+cb; SOCS=CAI" },
    });
    if (r.status === 200) return true;
    if (r.status >= 300 && r.status < 400) return (r.headers.get("location") || "").includes("consent") ? null : false;
  } catch (_) { /* YouTube не ответил */ }
  return null;
}

async function oembed(vid: string): Promise<{ t: string; a: string } | null> {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vid}&format=json`, { headers: UA });
    if (!r.ok) return null;
    const j = await r.json();
    return { t: j.title || "", a: j.author_name || "" };
  } catch (_) { return null; }
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

Deno.serve(async () => {
  try {
    const { data: last } = await db.from("channel_posts").select("tg").order("tg", { ascending: false }).limit(1);
    const lastTg = last?.[0]?.tg || 0;
    const found: Row[] = [];
    let before: number | null = null;
    for (let page = 0; page < 3; page++) { // обычно хватает одной страницы (≈20 постов)
      const r = await fetch(`https://t.me/s/${CHANNEL}` + (before ? `?before=${before}` : ""), { headers: UA });
      if (!r.ok) return json({ error: `t.me ответил ${r.status}` }, 502);
      const items = parsePage(await r.text());
      if (!items.length) break;
      for (const it of items) if (it.row) found.push(it.row);
      const low = Math.min(...items.map((i) => i.tg));
      if (low <= lastTg || !lastTg) break; // первый запуск — только последняя страница
      before = low;
    }
    if (!found.length) return json({ ok: true, found: 0, added: 0 });

    const { data: have } = await db.from("channel_posts").select("tg").in("tg", found.map((f) => f.tg));
    const known = new Set((have || []).map((h) => h.tg));
    const fresh = found.filter((f) => !known.has(f.tg));
    for (const row of fresh) {
      if (!row.short) row.short = (await isShort(row.yt)) === true;
      if (!row.author) {
        const o = await oembed(row.yt);
        if (o) { row.title = o.t || row.title; row.author = o.a; }
      }
    }
    if (fresh.length) {
      const { error } = await db.from("channel_posts").upsert(fresh, { onConflict: "tg", ignoreDuplicates: true });
      if (error) return json({ error: error.message }, 500);
    }
    return json({ ok: true, found: found.length, added: fresh.length });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
