// РКГДTUBE — весь сайт в одном файле.
// Видео: data/posts.json (база ворков канала, собирает GitHub) + одобренные заявки из Supabase.
// Аккаунты, лайки, комментарии, подписки, история, заявки и модерация — Supabase.
"use strict";

const CFG = window.RCGD_CONFIG || {};
const CHANNEL = CFG.channel || "RCGDTUBE";
const SITE = CFG.site || location.href.split("#")[0];
const PAGE = 24;
const sb = (CFG.supabaseUrl && CFG.supabaseKey && window.supabase)
  ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, detectSessionInUrl: false } })
  : null;

const S = {
  posts: [], byKey: new Map(), meta: {}, hidden: new Set(),
  user: null, profile: null, subs: new Map(),
  sort: "new", query: "", shown: PAGE, shuffled: null,
};

// ---------- мелочи ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hue = s => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const authorKey = p => p.channel || "n:" + p.author;
const isMod = () => ["moderator", "owner"].includes(S.profile?.role);
const isOwner = () => S.profile?.role === "owner";
const icon = {
  like: '<svg viewBox="0 0 24 24"><path d="M7 11v9H4v-9zM7 11l4-7c1.5 0 2.5 1 2.2 2.6L12.6 10H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 20H7"/></svg>',
  dislike: '<svg viewBox="0 0 24 24"><path d="M17 13V4h3v9zM17 13l-4 7c-1.5 0-2.5-1-2.2-2.6l.6-3.4H5a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 6.2 4H17"/></svg>',
  comment: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M14 5l7 7-7 7v-4c-5 0-8 1.5-11 5 1-5 4-10 11-11z"/></svg>',
  tg: '<svg viewBox="0 0 24 24"><path d="m21 4-18 7 6 2 2 6 3-4 5 4z"/><path d="m9 13 8-6"/></svg>',
  yt: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5.5" width="19" height="13" rx="3.5"/><path d="m10 9 5 3-5 3z"/></svg>',
  shorts: '<svg viewBox="0 0 24 24"><path d="M15.5 3.5 7 8.2a3.4 3.4 0 0 0 0 6l1 .5-1 .6a3.4 3.4 0 1 0 3.4 5.9l8.5-4.7a3.4 3.4 0 0 0 0-6l-1-.5 1-.6a3.4 3.4 0 1 0-3.4-5.9Z"/><path d="m10 9.5 5 2.5-5 2.5z"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>',
};

function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "только что";
  if (s < 3600) return Math.round(s / 60) + " мин. назад";
  if (s < 86400) return Math.round(s / 3600) + " ч. назад";
  if (s < 86400 * 30) return Math.round(s / 86400) + " дн. назад";
  if (s < 86400 * 365) return Math.round(s / 86400 / 30) + " мес. назад";
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  return (a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? few : many);
}
const num = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(".0", "") + " млн" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(".0", "") + " тыс." : String(n || 0);

function letterAv(name, size, cls = "av") {
  const cols = ["#e43ad6", "#ff8a1f", "#ffd23d"];
  const letter = [...String(name || "?").replace(/[^\p{L}\p{N}]/gu, "")][0] || "?";
  return `<span class="${cls}" style="background:${cols[hue(name) % 3]};width:${size}px;height:${size}px;font-size:${Math.round(size * .4)}px">${esc(letter.toUpperCase())}</span>`;
}
function userAv(p, size) {
  return p?.photo_url ? `<img class="av" src="${esc(p.photo_url)}" alt="" style="width:${size}px;height:${size}px" referrerpolicy="no-referrer">` : letterAv(p?.name || "?", size);
}
function toast(text) {
  const t = $("#toast"); t.textContent = text; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600);
}
function errText(e) { return (e && (e.message || e.error_description || e.error)) || String(e); }

const thumbOf = (p, q = "mqdefault") => p.thumb || (p.yt ? `https://i.ytimg.com/vi/${p.yt}/${q}.jpg` : "media/logo.jpg");
const shortThumb = p => p.thumb || (p.yt ? `https://i.ytimg.com/vi/${p.yt}/oar2.jpg` : "media/logo.jpg");
const storageUrl = path => `${CFG.supabaseUrl}/storage/v1/object/public/videos/${path}`;
const watchUrl = p => (p.short ? "#/shorts/" : "#/watch/") + encodeURIComponent(p.key);
const channelUrl = p => p.handle ? "https://www.youtube.com/" + encodeURI(p.handle) : p.channel ? "https://www.youtube.com/channel/" + encodeURIComponent(p.channel) : null;
const fullUrl = p => SITE + watchUrl(p);

// ---------- данные ----------
function addPost(p) {
  if (!p.key) p.key = p.yt || p.file;
  if (S.byKey.has(p.key) || S.hidden.has(p.key)) return;
  S.byKey.set(p.key, p); S.posts.push(p);
}
function fromSubmission(s) {
  return {
    key: s.kind === "youtube" ? s.yt_id : "f-" + s.id, yt: s.kind === "youtube" ? s.yt_id : null,
    file: s.file_path ? storageUrl(s.file_path) : null, thumb: s.thumb_path ? storageUrl(s.thumb_path) : null,
    title: s.title, author: s.author || "Неизвестный автор", desc: s.description, date: s.reviewed_at || s.created_at,
    short: s.is_short, approved: true,
  };
}
// свежий пост из канала (таблица channel_posts — обновляется каждые 5 минут)
function fromChannel(r) {
  const author = r.author || "Неизвестный автор";
  return { key: r.yt, yt: r.yt, tg: r.tg, title: r.title || "Ворк от " + author, author, desc: r.descr || "",
    date: r.posted_at || r.scanned_at, short: !!r.short };
}
async function loadData() {
  const d = await fetch("data/posts.json?t=" + Math.floor(Date.now() / 60000)).then(r => r.json());
  S.meta = d;
  if (sb) {
    const [h, a, c] = await Promise.all([
      sb.from("hidden_videos").select("video_key"),
      sb.from("submissions").select("*").eq("status", "approved").order("reviewed_at", { ascending: false }).limit(500),
      sb.from("channel_posts").select("*").order("tg", { ascending: false }).limit(150),
    ]);
    (h.data || []).forEach(x => S.hidden.add(x.video_key));
    (d.posts || []).forEach(addPost);
    (c.data || []).forEach(r => addPost(fromChannel(r)));
    (a.data || []).forEach(s => addPost(fromSubmission(s)));
  } else (d.posts || []).forEach(addPost);
  S.posts.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

// ---------- аккаунт ----------
async function loadMe() {
  if (!sb) return;
  const { data } = await sb.auth.getSession();
  S.user = data.session?.user || null;
  S.profile = null; S.subs = new Map();
  if (S.user) {
    const [p, s] = await Promise.all([
      sb.from("profiles").select("*").eq("id", S.user.id).maybeSingle(),
      sb.from("subscriptions").select("author_key, author_name").order("created_at", { ascending: false }),
    ]);
    S.profile = p.data;
    (s.data || []).forEach(x => S.subs.set(x.author_key, x.author_name));
  }
  renderAccount();
}
function renderAccount() {
  const box = $("#account");
  if (S.profile) box.innerHTML = `<button class="avatar" id="meBtn" type="button" aria-label="Мой профиль">${userAv(S.profile, 32)}</button>`;
  else box.innerHTML = `<button class="signin" id="signinBtn" type="button">${icon.user}<span>Войти</span></button>`;
  const yt = $("#youTab");
  yt.innerHTML = S.profile ? `${userAv(S.profile, 24)}<span>Вы</span>` : `${icon.user}<span>Вы</span>`;
  const side = $("#sideSubs");
  side.innerHTML = S.subs.size ? `<hr><h3>Подписки</h3>` + [...S.subs].slice(0, 12).map(([k, n]) =>
    `<a href="#/author/${encodeURIComponent(k)}">${letterAv(n, 24, "av sub-av")}<span>${esc(n)}</span></a>`).join("") : "";
}
function needLogin(why) {
  if (S.profile) return false;
  openLogin(why); return true;
}
function openLogin(why) {
  if (!sb || !CFG.loginBot) {
    openSheet("Вход", `<div class="tg-box"><p class="muted">Аккаунты скоро заработают. Владелец сайта ещё настраивает вход через Telegram.</p></div>`);
    return;
  }
  openSheet("Вход в РКГДTUBE", `<div class="tg-box">
    <p>${esc(why || "Войди, чтобы ставить лайки, писать комментарии, подписываться и отправлять видео.")}</p>
    <div id="tgWidget"></div>
    <p class="muted" style="font-size:13px">Мы видим только твоё имя, ник и аватарку из Telegram. Номер телефона сайту не передаётся.</p>
    <p class="msg" id="loginMsg"></p></div>`);
  const s = document.createElement("script");
  s.async = true; s.src = "https://telegram.org/js/telegram-widget.js?22";
  s.dataset.telegramLogin = CFG.loginBot; s.dataset.size = "large"; s.dataset.radius = "10";
  s.dataset.onauth = "RCGD_onTelegramAuth(user)"; s.dataset.requestAccess = "write";
  $("#tgWidget").appendChild(s);
}
window.RCGD_onTelegramAuth = async user => {
  const msg = $("#loginMsg"); if (msg) { msg.textContent = "Вхожу…"; msg.className = "msg"; }
  try {
    const { data, error } = await sb.functions.invoke("tg-login", { body: user });
    if (error) throw new Error((await error.context?.json?.().catch(() => null))?.error || error.message);
    if (data?.error) throw new Error(data.error);
    let r = await sb.auth.verifyOtp({ token_hash: data.token_hash, type: "magiclink" });
    if (r.error) r = await sb.auth.verifyOtp({ token_hash: data.token_hash, type: "email" });
    if (r.error) throw r.error;
    closeSheet(); await loadMe(); toast("Привет, " + (S.profile?.name || "зритель") + "!"); route();
  } catch (e) { if (msg) { msg.textContent = errText(e); msg.className = "msg err"; } }
};
async function logout() { await sb.auth.signOut(); await loadMe(); route(); toast("Ты вышел из аккаунта"); }

// ---------- всплывающее окно ----------
function openSheet(title, html) {
  $("#sheetTitle").textContent = title; $("#sheetBody").innerHTML = html;
  $("#sheet").hidden = false; $("#sheetBg").hidden = false;
}
function closeSheet() { $("#sheet").hidden = true; $("#sheetBg").hidden = true; $("#sheetBody").innerHTML = ""; }
$("#sheetClose").onclick = closeSheet; $("#sheetBg").onclick = closeSheet;
addEventListener("keydown", e => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });

// ---------- карточки ----------
function card(p, small) {
  const badge = p.approved ? `<span class="badge">от зрителей</span>` : "";
  return `<a class="card" href="${watchUrl(p)}">
    <div class="thumb"><img src="${esc(thumbOf(p))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">${badge}${p.short ? '<span class="dur">SHORTS</span>' : ""}</div>
    <div class="meta">${small ? "" : letterAv(p.author, 36)}<div><h3>${esc(p.title)}</h3>
    <p>${esc(p.author)}<br>${ago(p.date)}</p></div></div></a>`;
}
function scard(p) {
  return `<a class="scard" href="#/shorts/${encodeURIComponent(p.key)}"><div class="thumb"><img src="${esc(shortThumb(p))}" alt="" loading="lazy" onerror="this.src='${esc(thumbOf(p, "hqdefault"))}'"></div>
    <h4>${esc(p.title)}</h4><p>${esc(p.author)}</p></a>`;
}
function gridHtml(items, withShelf) {
  if (!items.length) return `<div class="empty"><b>Ничего не нашлось</b>Попробуй другой запрос.</div>`;
  const shorts = withShelf ? S.posts.filter(p => p.short).slice(0, 14) : [];
  const cards = items.slice(0, S.shown).map(p => card(p));
  if (shorts.length >= 3 && cards.length > 8)
    cards.splice(8, 0, `<section class="shelf"><div class="shelf-head">${icon.shorts}Shorts</div><div class="shelf-row">${shorts.map(scard).join("")}</div></section>`);
  return `<div class="grid">${cards.join("")}</div>${items.length > S.shown ? `<div class="more"><button class="btn" id="more" type="button">Показать ещё</button></div>` : ""}`;
}
function bindMore(render) { const m = $("#more"); if (m) m.onclick = () => { S.shown += PAGE; render(); }; }
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }
function matches(list) {
  const q = S.query.toLowerCase();
  return q ? list.filter(p => (p.title + " " + p.author).toLowerCase().includes(q)) : list;
}

// ---------- главная ----------
function home() {
  const base = S.posts.filter(p => !p.short || S.query);
  const list = S.sort === "old" ? base.slice().reverse() : S.sort === "random" ? (S.shuffled ||= shuffle(base)) : S.sort === "fans" ? base.filter(p => p.approved) : base;
  const items = matches(list);
  const chips = [["new", "Новые"], ["random", "Случайные"], ["old", "Старые"]];
  if (S.posts.some(p => p.approved)) chips.push(["fans", "От зрителей"]);
  $("#app").innerHTML = `<div class="wrap">
    <div class="chips">${chips.map(([k, l]) => `<button class="chip" data-sort="${k}" aria-pressed="${k === S.sort}" type="button">${l}</button>`).join("")}</div>
    ${S.query ? `<p class="found">По запросу «${esc(S.query)}» найдено: ${items.length}</p>` : ""}
    ${gridHtml(items, !S.query && S.sort === "new")}</div>`;
  $$(".chip").forEach(c => c.onclick = () => { S.sort = c.dataset.sort; S.shuffled = null; S.shown = PAGE; home(); });
  bindMore(home);
}

// ---------- страница видео ----------
function playerHtml(p) {
  if (p.file) return `<div class="player${p.short ? " vertical" : ""}"><video src="${esc(p.file)}" controls autoplay playsinline poster="${esc(p.thumb || "")}"></video></div>`;
  const yt = `https://www.youtube.com/watch?v=${encodeURIComponent(p.yt)}`;
  if (p.noembed) return `<a class="player" href="${yt}" target="_blank" rel="noopener"><img src="${esc(thumbOf(p, "hqdefault"))}" alt="">
    <div class="overlay">${icon.yt}<b>Автор разрешил смотреть это видео только на YouTube</b><span class="btn hot">Открыть на YouTube</span></div></a>`;
  return `<div class="player"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(p.yt)}?rel=0&autoplay=1&playsinline=1"
    title="${esc(p.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
}
function subBtn(p) {
  const k = authorKey(p), on = S.subs.has(k);
  return `<button class="subbtn${on ? " on" : ""}" type="button" data-sub="${esc(k)}" data-name="${esc(p.author)}">${on ? "Вы подписаны" : "Подписаться"}</button>`;
}
function watch(key) {
  const p = S.byKey.get(key);
  if (!p) return notFound();
  const k = authorKey(p);
  const same = S.posts.filter(x => x.key !== key && authorKey(x) === k && !x.short).slice(0, 8);
  const rest = S.posts.filter(x => x.key !== key && authorKey(x) !== k && !x.short).slice(0, 20 - same.length);
  $("#app").innerHTML = `<div class="watch"><div style="min-width:0">
    ${playerHtml(p)}
    <h1>${esc(p.title)}</h1>
    <div class="row">
      <div class="chan-row"><a href="#/author/${encodeURIComponent(k)}">${letterAv(p.author, 40)}</a>
        <a href="#/author/${encodeURIComponent(k)}"><b>${esc(p.author)}</b><span id="subCount"></span></a>${subBtn(p)}</div>
      <div class="pill"><button class="btn" type="button" data-vote="1">${icon.like}<span id="nLike">0</span></button><button class="btn" type="button" data-vote="-1">${icon.dislike}</button></div>
      <button class="btn" type="button" data-share>${icon.share}Поделиться</button>
      ${p.tg ? `<a class="btn" href="https://t.me/${CHANNEL}/${p.tg}" target="_blank" rel="noopener">${icon.tg}Пост</a>` : ""}
      ${p.yt ? `<a class="btn" href="https://www.youtube.com/watch?v=${encodeURIComponent(p.yt)}" target="_blank" rel="noopener">${icon.yt}YouTube</a>` : ""}
    </div>
    <div class="desc"><div class="when">${ago(p.date)}${p.approved ? " · прислал зритель" : ""}</div>${esc(p.desc || (p.yt ? "Оригинальное видео на YouTube. Все права у автора." : ""))}
      ${channelUrl(p) ? `\n<a href="${esc(channelUrl(p))}" target="_blank" rel="noopener">Канал автора на YouTube</a>` : ""}</div>
    <section class="comments" id="comments"></section>
  </div>
  <aside class="up-next">${same.length ? `<h4>Ещё от ${esc(p.author)}</h4>${same.map(x => card(x, true)).join("")}` : ""}<h4>${same.length ? "Новое на канале" : "Ещё на канале"}</h4>${rest.map(x => card(x, true)).join("")}</aside></div>`;
  window.scrollTo(0, 0);
  bindVideoActions($("#app"), p);
  loadStats(p, $("#app"));
  renderComments(p, $("#comments"));
  remember(p);
  loadSubCount(k);
}
async function loadSubCount(k) {
  if (!sb) return;
  const { data } = await sb.rpc("author_subscribers", { akey: k });
  const el = $("#subCount"); if (el && data != null) el.textContent = data ? `${num(data)} ${plural(data, "подписчик", "подписчика", "подписчиков")}` : "";
}
async function remember(p) {
  if (!sb || !S.user) return;
  sb.from("history").upsert({ video_key: p.key, watched_at: new Date().toISOString() }, { onConflict: "user_id,video_key" }).then(() => { });
}
async function loadStats(p, root) {
  if (!sb) return;
  const { data } = await sb.rpc("video_stats", { keys: [p.key] });
  const s = data?.[0]; if (!s) return;
  p._stats = s; paintStats(p, root);
}
function paintStats(p, root) {
  const s = p._stats || { likes: 0, comments: 0, my_vote: null };
  $$("[data-n=like]", root).concat($$("#nLike", root)).forEach(el => el.textContent = num(Number(s.likes)));
  $$("[data-n=comments]", root).forEach(el => el.textContent = num(Number(s.comments)));
  $$("[data-vote]", root).forEach(b => b.classList.toggle("on", Number(b.dataset.vote) === s.my_vote));
}
function bindVideoActions(root, p) {
  $$("[data-vote]", root).forEach(b => b.onclick = () => vote(p, Number(b.dataset.vote), root));
  $$("[data-share]", root).forEach(b => b.onclick = () => share(p));
  $$("[data-sub]", root).forEach(b => b.onclick = () => toggleSub(b.dataset.sub, b.dataset.name));
  $$("[data-comments]", root).forEach(b => b.onclick = () => openComments(p));
}
async function vote(p, v, root) {
  if (needLogin("Войди, чтобы ставить лайки.")) return;
  const s = p._stats ||= { likes: 0, dislikes: 0, comments: 0, my_vote: null };
  const prev = s.my_vote, next = prev === v ? null : v;
  if (prev === 1) s.likes--; if (prev === -1) s.dislikes--;
  if (next === 1) s.likes++; if (next === -1) s.dislikes++;
  s.my_vote = next; paintStats(p, root);
  const r = next === null
    ? await sb.from("likes").delete().eq("user_id", S.user.id).eq("video_key", p.key)
    : await sb.from("likes").upsert({ video_key: p.key, value: next }, { onConflict: "user_id,video_key" });
  if (r.error) { toast("Не получилось: " + errText(r.error)); loadStats(p, root); }
}
async function share(p) {
  const url = fullUrl(p);
  try {
    if (navigator.share && matchMedia("(pointer:coarse)").matches) await navigator.share({ title: p.title, url });
    else { await navigator.clipboard.writeText(url); toast("Ссылка скопирована"); }
  } catch { /* отмена */ }
}
async function toggleSub(k, name) {
  if (needLogin("Войди, чтобы подписываться на авторов.")) return;
  const on = S.subs.has(k);
  const r = on ? await sb.from("subscriptions").delete().eq("user_id", S.user.id).eq("author_key", k)
    : await sb.from("subscriptions").insert({ author_key: k, author_name: name });
  if (r.error) return toast("Не получилось: " + errText(r.error));
  on ? S.subs.delete(k) : S.subs.set(k, name);
  $$(`[data-sub="${CSS.escape(k)}"]`).forEach(b => { b.classList.toggle("on", !on); b.textContent = on ? "Подписаться" : "Вы подписаны"; });
  renderAccount(); toast(on ? "Подписка отменена" : "Ты подписался на " + name);
  if (location.hash.startsWith("#/author/")) loadSubCount(k);
}

// ---------- комментарии ----------
async function renderComments(p, box, compact) {
  if (!sb) { box.innerHTML = compact ? `<p class="muted">Комментарии скоро заработают.</p>` : ""; return; }
  box.innerHTML = `${compact ? "" : `<h2 class="c-head">Комментарии</h2>`}
    <div class="c-new">${S.profile ? userAv(S.profile, 40) : letterAv("?", 40)}
      <form id="cForm"><textarea id="cText" rows="1" maxlength="1000" placeholder="${S.profile ? "Напиши комментарий" : "Войди, чтобы написать комментарий"}"></textarea>
      <div class="row" hidden id="cRow"><button class="btn ghost" type="button" id="cCancel">Отмена</button><button class="btn hot" type="submit">Отправить</button></div></form></div>
    <div id="cList"><p class="muted">Загружаю…</p></div>`;
  const ta = $("#cText", box), rowEl = $("#cRow", box);
  ta.onfocus = () => { if (needLogin("Войди, чтобы писать комментарии.")) { ta.blur(); return; } rowEl.hidden = false; };
  ta.oninput = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  $("#cCancel", box).onclick = () => { ta.value = ""; rowEl.hidden = true; };
  $("#cForm", box).onsubmit = async e => {
    e.preventDefault();
    const body = ta.value.trim(); if (!body || !S.user) return;
    const { data, error } = await sb.from("comments").insert({ video_key: p.key, body }).select("id").single();
    if (error) return toast(errText(error));
    ta.value = ""; rowEl.hidden = true; loadComments(p, box);
    sb.functions.invoke("tg-bridge", { body: { action: "relay", comment_id: data.id } }).catch(() => { });
  };
  loadComments(p, box);
}
async function loadComments(p, box) {
  const { data, error } = await sb.from("comments").select("id, body, created_at, source, tg_author, user_id, deleted, profiles(name, username, photo_url)")
    .eq("video_key", p.key).order("created_at", { ascending: false }).limit(200);
  const list = $("#cList", box); if (!list) return;
  if (error) { list.innerHTML = `<p class="msg err">${esc(errText(error))}</p>`; return; }
  const n = (data || []).filter(c => !c.deleted).length;
  $$("[data-n=comments]", box).forEach(el => el.textContent = n);
  const head = $(".c-head", box); if (head) head.textContent = n ? `${n} ${plural(n, "комментарий", "комментария", "комментариев")}` : "Комментарии";
  if (p._stats) { p._stats.comments = n; }
  list.innerHTML = (data || []).map(c => {
    const name = c.source === "tg" ? c.tg_author : c.profiles?.name || "Зритель";
    const canDel = !c.deleted && S.user && (c.user_id === S.user.id || isMod());
    return `<div class="c">${c.source === "tg" ? letterAv(name, 40) : userAv(c.profiles || { name }, 40)}<div>
      <div class="who">${esc(name)}${c.profiles?.username ? ` <span>@${esc(c.profiles.username)}</span>` : ""}${c.source === "tg" ? ` <span class="tgb">из Telegram</span>` : ""}<span>${ago(c.created_at)}</span></div>
      <p>${c.deleted ? "<i>комментарий удалён</i>" : esc(c.body)}</p>
      ${canDel ? `<button class="del" type="button" data-del="${c.id}">Удалить</button>` : ""}</div></div>`;
  }).join("") || `<p class="muted">Комментариев пока нет. Будь первым!</p>`;
  $$("[data-del]", list).forEach(b => b.onclick = async () => {
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Точно удалить?"; return; }
    const { error } = await sb.rpc("delete_comment", { cid: Number(b.dataset.del) });
    error ? toast(errText(error)) : loadComments(p, box);
  });
}
function openComments(p) {
  openSheet("Комментарии", `<div id="sheetComments"></div>`);
  renderComments(p, $("#sheetComments"), true);
}

// ---------- Shorts ----------
let shortsObserver = null;
function shorts(startKey) {
  document.body.classList.add("shorts-mode");
  let list = S.posts.filter(p => p.short);
  if (!list.length) {
    $("#app").innerHTML = `<div class="empty"><b>Shorts пока нет</b>Сайт ещё определяет, какие ворки вертикальные. Загляни через полчаса или пришли свой Shorts через плюсик.</div>`;
    return;
  }
  if (startKey && S.byKey.get(startKey)?.short) list = [S.byKey.get(startKey), ...list.filter(p => p.key !== startKey)];
  $("#app").innerHTML = `<div class="shorts" id="shorts">${list.slice(0, 60).map(shortSlide).join("")}</div>`;
  const box = $("#shorts");
  shortsObserver?.disconnect();
  shortsObserver = new IntersectionObserver(es => es.forEach(e => {
    const el = e.target, p = S.byKey.get(el.dataset.key);
    if (e.isIntersecting) activateShort(el, p); else deactivateShort(el, p);
  }), { root: box, threshold: .6 });
  $$(".short", box).forEach(el => { shortsObserver.observe(el); bindVideoActions(el, S.byKey.get(el.dataset.key)); });
  let more = 60;
  box.addEventListener("scroll", () => {
    if (box.scrollTop + box.clientHeight * 3 > box.scrollHeight && more < list.length) {
      const add = list.slice(more, more + 30); more += 30;
      box.insertAdjacentHTML("beforeend", add.map(shortSlide).join(""));
      add.forEach(p => { const el = box.querySelector(`[data-key="${CSS.escape(p.key)}"]`); shortsObserver.observe(el); bindVideoActions(el, p); });
    }
  }, { passive: true });
}
function shortSlide(p) {
  const k = authorKey(p);
  return `<section class="short" data-key="${esc(p.key)}">
    <div class="s-frame"><img src="${esc(shortThumb(p))}" alt="" loading="lazy" onerror="this.src='${esc(thumbOf(p, "hqdefault"))}'"><div class="s-slot"></div>
      <div class="s-info"><div class="chan-row"><a href="#/author/${encodeURIComponent(k)}">${letterAv(p.author, 32)}</a><a href="#/author/${encodeURIComponent(k)}"><b>${esc(p.author)}</b></a>${subBtn(p)}</div>
      <h3>${esc(p.title)}</h3></div></div>
    <div class="s-actions">
      <button class="s-act" type="button" data-vote="1"><i>${icon.like}</i><span data-n="like">Нравится</span></button>
      <button class="s-act" type="button" data-vote="-1"><i>${icon.dislike}</i><span>Не нравится</span></button>
      <button class="s-act" type="button" data-comments><i>${icon.comment}</i><span data-n="comments">0</span></button>
      <button class="s-act" type="button" data-share><i>${icon.share}</i><span>Поделиться</span></button>
      ${p.yt ? `<a class="s-act" href="https://youtube.com/shorts/${encodeURIComponent(p.yt)}" target="_blank" rel="noopener"><i>${icon.yt}</i><span>YouTube</span></a>` : ""}
    </div></section>`;
}
function activateShort(el, p) {
  const slot = $(".s-slot", el); if (!slot || slot.childElementCount) return;
  if (p.file) {
    slot.innerHTML = `<video src="${esc(p.file)}" loop playsinline></video>`;
    const v = $("video", slot);
    v.play().catch(() => { v.muted = true; v.play().catch(() => { }); });
    v.onclick = () => { if (v.muted) v.muted = false; else v.paused ? v.play() : v.pause(); };
  }
  else slot.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(p.yt)}?autoplay=1&loop=1&playlist=${encodeURIComponent(p.yt)}&playsinline=1&rel=0&modestbranding=1"
    allow="autoplay; encrypted-media; picture-in-picture; web-share" allowfullscreen title="${esc(p.title)}"></iframe>`;
  history.replaceState(null, "", "#/shorts/" + encodeURIComponent(p.key));
  loadStats(p, el); remember(p);
}
function deactivateShort(el) { const slot = $(".s-slot", el); if (slot) slot.innerHTML = ""; }

// ---------- автор ----------
function authorPage(k) {
  const all = S.posts.filter(p => authorKey(p) === k);
  if (!all.length) return notFound();
  const a = all[0], url = channelUrl(a), shortsOf = all.filter(p => p.short), vids = all.filter(p => !p.short);
  $("#app").innerHTML = `<div class="wrap">
    <section class="ch-head">${letterAv(a.author, 120)}<div><h1>${esc(a.author)}</h1>
      <p>${a.handle ? esc(a.handle) + " · " : ""}<span id="subCount"></span> ${all.length} ${plural(all.length, "ворк", "ворка", "ворков")} на РКГДTUBE</p>
      <div class="row">${subBtn(a)}${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${icon.yt}Канал на YouTube</a>` : ""}</div></div></section>
    ${shortsOf.length ? `<section class="shelf" style="margin-bottom:28px"><div class="shelf-head">${icon.shorts}Shorts</div><div class="shelf-row">${shortsOf.map(scard).join("")}</div></section>` : ""}
    ${gridHtml(matches(vids.length ? vids : all))}</div>`;
  $$("[data-sub]").forEach(b => b.onclick = () => toggleSub(b.dataset.sub, b.dataset.name));
  bindMore(() => authorPage(k)); window.scrollTo(0, 0); loadSubCount(k);
}

// ---------- подписки ----------
function subsPage() {
  if (!S.profile) return loginWall("Подписки", "Подпишись на любимых авторов, и их новые ворки будут собираться здесь.");
  if (!S.subs.size) { $("#app").innerHTML = `<div class="empty"><b>Ты пока ни на кого не подписан</b>Открой видео и нажми «Подписаться» рядом с автором.</div>`; return; }
  const keys = new Set(S.subs.keys());
  const items = matches(S.posts.filter(p => keys.has(authorKey(p))));
  $("#app").innerHTML = `<div class="wrap"><div class="chips">${[...S.subs].map(([k, n]) => `<a class="chip" href="#/author/${encodeURIComponent(k)}" style="text-decoration:none">${esc(n)}</a>`).join("")}</div>
    ${gridHtml(items)}</div>`;
  bindMore(subsPage);
}
function loginWall(title, text) {
  $("#app").innerHTML = `<div class="empty"><b>${esc(title)}</b>${esc(text)}<div style="margin-top:18px"><button class="btn hot" id="wallLogin" type="button">${icon.tg}Войти через Telegram</button></div></div>`;
  $("#wallLogin").onclick = () => openLogin();
}

// ---------- профиль ----------
const TABS = [["history", "История"], ["liked", "Понравившиеся"], ["mine", "Мои заявки"], ["subs", "Подписки"]];
async function you(tab) {
  if (!S.profile) return loginWall("Твой профиль", "Войди через Telegram, чтобы видеть историю, понравившиеся видео и отправлять свои ворки.");
  const tabs = TABS.slice();
  if (isMod()) tabs.push(["mod", "Модерация"]);
  if (isOwner()) tabs.push(["team", "Команда"]);
  tab = tabs.some(t => t[0] === tab) ? tab : "history";
  const roleName = { owner: "владелец", moderator: "модератор" }[S.profile.role];
  $("#app").innerHTML = `<div class="wrap" style="max-width:1300px">
    <section class="ch-head">${userAv(S.profile, 120)}<div><h1>${esc(S.profile.name)}${roleName ? `<span class="role">${roleName}</span>` : ""}</h1>
      <p>${S.profile.username ? "@" + esc(S.profile.username) + " · " : ""}на РКГДTUBE с ${new Date(S.profile.created_at).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</p>
      <div class="row"><button class="btn hot" type="button" id="youCreate">Отправить видео</button><button class="btn" type="button" id="logout">Выйти</button></div></div></section>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/you/${k}" class="${k === tab ? "on" : ""}">${l}</a>`).join("")}</nav>
    <div id="tab"><p class="muted">Загружаю…</p></div>
    ${isMod() ? "" : `<details class="panel" style="margin-top:28px"><summary style="cursor:pointer;font-weight:800">Есть код модератора?</summary>
      <form class="stack" id="codeForm" style="margin-top:12px"><input type="text" id="code" placeholder="RCGD-XXXXX-XXXXX-XXXXX-XXXXX" autocomplete="off">
      <button class="btn hot" type="submit" style="align-self:flex-start">Активировать</button><p class="msg" id="codeMsg"></p></form></details>`}
  </div>`;
  $("#logout").onclick = logout; $("#youCreate").onclick = openSubmit;
  const cf = $("#codeForm");
  if (cf) cf.onsubmit = async e => {
    e.preventDefault();
    const m = $("#codeMsg"); m.textContent = "Проверяю…"; m.className = "msg";
    const { data, error } = await sb.rpc("redeem_code", { code: $("#code").value });
    if (error) { m.textContent = errText(error); m.className = "msg err"; return; }
    await loadMe(); toast(data === "owner" ? "Ты теперь владелец сайта" : "Ты теперь модератор!"); location.hash = "#/you/mod";
  };
  const box = $("#tab");
  ({ history: tabHistory, liked: tabLiked, mine: tabMine, subs: tabSubs, mod: tabMod, team: tabTeam })[tab](box);
}
function keysGrid(keys, emptyText) {
  const items = keys.map(k => S.byKey.get(k)).filter(Boolean);
  return items.length ? `<div class="grid">${items.map(p => card(p)).join("")}</div>` : `<div class="empty">${emptyText}</div>`;
}
async function tabHistory(box) {
  const { data } = await sb.from("history").select("video_key").order("watched_at", { ascending: false }).limit(200);
  box.innerHTML = (data?.length ? `<div class="row" style="margin-bottom:16px"><button class="btn" type="button" id="clearHist">Очистить историю</button></div>` : "")
    + keysGrid((data || []).map(x => x.video_key), "Здесь появятся видео, которые ты смотрел.");
  const b = $("#clearHist"); if (b) b.onclick = async () => { await sb.from("history").delete().eq("user_id", S.user.id); tabHistory(box); };
}
async function tabLiked(box) {
  const { data } = await sb.from("likes").select("video_key").eq("value", 1).order("created_at", { ascending: false }).limit(300);
  box.innerHTML = keysGrid((data || []).map(x => x.video_key), "Ставь лайки видео, и они соберутся здесь.");
}
async function tabSubs(box) {
  box.innerHTML = S.subs.size ? `<div class="items">${[...S.subs].map(([k, n]) => `<div class="panel row" style="margin:0">
      ${letterAv(n, 40)}<a href="#/author/${encodeURIComponent(k)}" style="font-weight:800;margin-right:auto;text-decoration:none">${esc(n)}</a>
      <button class="subbtn on" type="button" data-sub="${esc(k)}" data-name="${esc(n)}">Отписаться</button></div>`).join("")}</div>`
    : `<div class="empty">Подписок пока нет.</div>`;
  $$("[data-sub]", box).forEach(b => b.onclick = async () => { await toggleSub(b.dataset.sub, b.dataset.name); tabSubs(box); });
}
const STATUS = { pending: "На проверке", approved: "Выложено", rejected: "Отказано" };
function subThumb(s) {
  if (s.thumb_path) return storageUrl(s.thumb_path);
  return s.yt_id ? `https://i.ytimg.com/vi/${s.yt_id}/mqdefault.jpg` : "media/logo.jpg";
}
async function tabMine(box) {
  const { data, error } = await sb.from("submissions").select("*").eq("user_id", S.user.id).order("created_at", { ascending: false });
  if (error) { box.innerHTML = `<p class="msg err">${esc(errText(error))}</p>`; return; }
  box.innerHTML = `<div class="row" style="margin-bottom:16px"><button class="btn hot" type="button" id="mineNew">Отправить видео</button></div>`
    + (data.length ? `<div class="items">${data.map(s => `<div class="item"><div class="thumb${s.is_short ? " vertical" : ""}"><img src="${esc(subThumb(s))}" alt="" loading="lazy"></div><div>
      <span class="status ${s.status}">${STATUS[s.status]}</span><h3 style="margin-top:8px">${esc(s.title)}</h3>
      <p>${esc(s.author || "автор не указан")} · отправлено ${ago(s.created_at)}</p>
      ${s.status === "rejected" && s.reject_reason ? `<p>Причина: ${esc(s.reject_reason)}</p>` : ""}
      <div class="row">${s.status === "approved" ? `<a class="btn" href="${watchUrl(fromSubmission(s))}">Смотреть</a>` : ""}
      ${s.status === "pending" ? `<button class="btn danger" type="button" data-rm="${s.id}">Отменить заявку</button>` : ""}</div></div></div>`).join("")}</div>`
      : `<div class="empty">Ты ещё ничего не отправлял. Нажми плюсик внизу, чтобы прислать свой ворк.</div>`);
  $("#mineNew").onclick = openSubmit;
  $$("[data-rm]", box).forEach(b => b.onclick = async () => {
    const s = data.find(x => x.id === b.dataset.rm);
    const { error } = await sb.from("submissions").delete().eq("id", s.id);
    if (error) return toast(errText(error));
    const files = [s.file_path, s.thumb_path].filter(Boolean); if (files.length) sb.storage.from("videos").remove(files);
    tabMine(box);
  });
}

// --- раздел модераторов ---
async function tabMod(box) {
  const { data, error } = await sb.from("submissions").select("*, profiles!submissions_user_id_fkey(name, username, photo_url)")
    .eq("status", "pending").order("created_at", { ascending: true }).limit(100);
  const hid = await sb.from("hidden_videos").select("video_key, created_at").order("created_at", { ascending: false }).limit(100);
  if (error) { box.innerHTML = `<p class="msg err">${esc(errText(error))}</p>`; return; }
  box.innerHTML = `<h2 style="margin:0 0 12px">Заявки на проверке: ${data.length}</h2>
    ${data.length ? `<div class="items">${data.map(modItem).join("")}</div>` : `<div class="empty" style="padding:30px">Новых заявок нет 🎉</div>`}
    <div class="panel" style="margin-top:28px"><h2>Скрыть видео с сайта</h2><p class="muted">Любое видео, в том числе из базы канала. Вставь ссылку на YouTube или на видео с сайта.</p>
      <form class="row" id="hideForm" style="margin-top:10px"><input type="text" id="hideUrl" placeholder="https://youtu.be/…" style="flex:1;min-width:200px"><button class="btn" type="submit">Скрыть</button></form>
      <div class="items" style="margin-top:14px">${(hid.data || []).map(h => `<div class="row"><span style="margin-right:auto;font-family:var(--f-mono);font-size:13px;overflow-wrap:anywhere">${esc(S.byKey.get(h.video_key)?.title || h.video_key)}</span>
        <button class="btn" type="button" data-unhide="${esc(h.video_key)}">Вернуть</button></div>`).join("")}</div></div>`;
  $$("[data-approve]", box).forEach(b => b.onclick = () => review(b.dataset.approve, true, null, box));
  $$("[data-reject]", box).forEach(b => b.onclick = () => {
    const wrap = b.closest(".item"); const r = $(".reason", wrap);
    if (r.hidden) { r.hidden = false; $("input", r).focus(); return; }
    review(b.dataset.reject, false, $("input", r).value, box, data.find(s => s.id === b.dataset.reject));
  });
  $$("[data-play]", box).forEach(b => b.onclick = () => {
    const s = data.find(x => x.id === b.dataset.play), t = b.closest(".thumb");
    t.innerHTML = s.kind === "file" ? `<video src="${esc(storageUrl(s.file_path))}" controls autoplay playsinline style="object-fit:contain;background:#000"></video>`
      : `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(s.yt_id)}?autoplay=1" allow="autoplay; encrypted-media" allowfullscreen style="width:100%;height:100%;border:0"></iframe>`;
  });
  $("#hideForm").onsubmit = async e => {
    e.preventDefault();
    const key = videoKeyFrom($("#hideUrl").value);
    if (!key) return toast("Не понял ссылку");
    const { error } = await sb.from("hidden_videos").insert({ video_key: key });
    if (error && !/duplicate/.test(error.message)) return toast(errText(error));
    toast("Скрыто"); S.hidden.add(key); tabMod(box);
  };
  $$("[data-unhide]", box).forEach(b => b.onclick = async () => {
    await sb.from("hidden_videos").delete().eq("video_key", b.dataset.unhide); S.hidden.delete(b.dataset.unhide);
    toast("Видео вернётся на сайт после обновления страницы"); tabMod(box);
  });
}
function modItem(s) {
  const who = s.profiles;
  return `<div class="item"><div class="thumb${s.is_short ? " vertical" : ""}"><img src="${esc(subThumb(s))}" alt="">
      <button class="overlay" type="button" data-play="${s.id}" style="border:0;cursor:pointer;color:inherit;font:inherit">${icon.yt}<b>Посмотреть</b></button></div><div>
    <span class="status pending">${s.kind === "file" ? "файл" : "YouTube"}${s.is_short ? " · Shorts" : ""}</span>
    <h3 style="margin-top:8px">${esc(s.title)}</h3>
    <p>Автор: ${esc(s.author || "не указан")}${s.tags ? " · " + esc(s.tags) : ""}</p>
    ${s.description ? `<p>${esc(s.description)}</p>` : ""}
    <p>Прислал: ${esc(who?.name || "?")}${who?.username ? " (@" + esc(who.username) + ")" : ""} · ${ago(s.created_at)}</p>
    <div class="reason" hidden><input type="text" maxlength="300" placeholder="Причина отказа (её увидит автор заявки)"></div>
    <div class="row"><button class="btn hot" type="button" data-approve="${s.id}">Выложить</button><button class="btn danger" type="button" data-reject="${s.id}">Отказать</button></div></div></div>`;
}
async function review(id, approve, reason, box, sub) {
  const { error } = await sb.rpc("review_submission", { sub_id: id, approve, reason: reason || null });
  if (error) return toast(errText(error));
  if (!approve && sub) { const files = [sub.file_path, sub.thumb_path].filter(Boolean); if (files.length) sb.storage.from("videos").remove(files); }
  if (approve) {
    const { data } = await sb.from("submissions").select("*").eq("id", id).single();
    if (data) { addPost(fromSubmission(data)); S.posts.sort((a, b) => (b.date || "").localeCompare(a.date || "")); }
  }
  toast(approve ? "Выложено на сайт. В Telegram уйдёт в течение 15 минут." : "Заявка отклонена");
  tabMod(box);
}
async function tabTeam(box) {
  const { data, error } = await sb.rpc("team");
  if (error) { box.innerHTML = `<p class="msg err">${esc(errText(error))}</p>`; return; }
  const mods = data.filter(r => r.grants === "moderator");
  box.innerHTML = `<div class="panel"><h2>Коды модераторов</h2><p class="muted">Каждый код можно активировать только один раз, в своём профиле. Отключишь код, и человек перестанет быть модератором.</p>
    <div class="team" style="margin-top:14px">${mods.map(r => `<div class="${r.disabled ? "off" : ""}"><span>№${r.n} · ${r.user_id ? `<b>${esc(r.name)}</b>${r.username ? " @" + esc(r.username) : ""}` : "свободен"}${r.disabled ? " · отключён" : ""}</span>
      <button class="btn" type="button" data-code="${r.n}" data-off="${r.disabled ? 0 : 1}">${r.disabled ? "Включить" : "Отключить"}</button></div>`).join("")}</div></div>
    <div class="panel"><h2>Комментарии из Telegram</h2><p class="muted">Когда владелец канала добавит бота админом в группу комментариев канала, нажми кнопку. После этого комментарии с сайта будут уходить под посты, а комментарии из Telegram появятся на сайте.</p>
      <div class="row" style="margin-top:12px"><button class="btn hot" type="button" id="bridge">Подключить комментарии Telegram</button></div><p class="msg" id="bridgeMsg"></p></div>`;
  $$("[data-code]", box).forEach(b => b.onclick = async () => {
    const { error } = await sb.rpc("set_code_disabled", { code_n: Number(b.dataset.code), off: b.dataset.off === "1" });
    error ? toast(errText(error)) : tabTeam(box);
  });
  $("#bridge").onclick = async () => {
    const m = $("#bridgeMsg"); m.textContent = "Подключаю…"; m.className = "msg";
    const { data, error } = await sb.functions.invoke("tg-bridge", { body: { action: "setup" } });
    if (error || !data?.ok) { m.textContent = "Не получилось: " + (data?.description || data?.error || errText(error)); m.className = "msg err"; }
    else { m.textContent = "Готово! Комментарии будут работать для новых постов канала."; m.className = "msg ok"; }
  };
}

// ---------- плюсик: отправить видео ----------
function youtubeId(s) {
  s = String(s || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s), host = u.hostname.replace(/^(www|m|music)\./, "");
    if (host === "youtu.be") return (u.pathname.slice(1).match(/^[\w-]{11}/) || [])[0] || null;
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (u.searchParams.get("v")) return (u.searchParams.get("v").match(/^[\w-]{11}/) || [])[0] || null;
      return (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/) || [])[1] || null;
    }
  } catch { /* не ссылка */ }
  return null;
}
function videoKeyFrom(s) {
  const m = String(s).match(/#\/(?:watch|shorts)\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : youtubeId(s);
}
function openSubmit() {
  if (needLogin("Войди, чтобы отправлять видео. Модераторы проверят и выложат его на сайт.")) return;
  openSheet("Отправить видео", `<div class="seg"><button type="button" class="on" data-kind="youtube">Ссылка YouTube</button><button type="button" data-kind="file">Свой файл</button></div>
    <form class="stack" id="subForm">
      <div id="ytPart" class="stack"><label for="sUrl">Ссылка на видео</label><input id="sUrl" type="url" placeholder="https://youtu.be/… или youtube.com/shorts/…"></div>
      <div id="filePart" class="stack" hidden><label for="sFile">Видеофайл (до 50 МБ: mp4, webm, mov)</label><input id="sFile" type="file" accept="video/mp4,video/webm,video/quicktime"></div>
      <div class="preview" id="sPrev" hidden></div>
      <label for="sTitle">Название</label><input id="sTitle" type="text" maxlength="140" required placeholder="Например: My part in …">
      <label for="sAuthor">Автор (ник креатора)</label><input id="sAuthor" type="text" maxlength="80" placeholder="Ник">
      <label for="sDesc">Описание</label><textarea id="sDesc" maxlength="1500" placeholder="Необязательно"></textarea>
      <label for="sTags">Хэштеги</label><input id="sTags" type="text" maxlength="120" placeholder="Например: gp_deco deco">
      <label class="check"><input type="checkbox" id="sShort"> Это Shorts (вертикальное видео)</label>
      <button class="btn hot" type="submit" id="sBtn">Отправить на проверку</button><p class="msg" id="sMsg"></p>
    </form>`);
  let kind = "youtube", thumbBlob = null;
  $$(".seg button").forEach(b => b.onclick = () => {
    kind = b.dataset.kind; $$(".seg button").forEach(x => x.classList.toggle("on", x === b));
    $("#ytPart").hidden = kind !== "youtube"; $("#filePart").hidden = kind !== "file"; $("#sPrev").hidden = true;
  });
  $("#sUrl").oninput = async () => {
    const v = $("#sUrl").value, id = youtubeId(v), prev = $("#sPrev");
    prev.hidden = !id; if (!id) return;
    prev.innerHTML = `<img src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt="">`;
    if (/\/shorts\//.test(v)) $("#sShort").checked = true;
    if (S.byKey.has(id)) { $("#sMsg").textContent = "Это видео уже есть на сайте."; $("#sMsg").className = "msg err"; return; }
    $("#sMsg").textContent = "";
    try { // название и автор с YouTube, если сервис ответит
      const j = await fetch("https://noembed.com/embed?url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id)).then(r => r.json());
      if (j.title && !$("#sTitle").value) $("#sTitle").value = j.title.slice(0, 140);
      if (j.author_name && !$("#sAuthor").value) $("#sAuthor").value = j.author_name.slice(0, 80);
    } catch { /* впишут руками */ }
  };
  $("#sFile").onchange = () => {
    const f = $("#sFile").files[0], prev = $("#sPrev"); thumbBlob = null;
    if (!f) { prev.hidden = true; return; }
    if (f.size > 50 * 1024 * 1024) { $("#sMsg").textContent = "Файл больше 50 МБ. Сожми видео или залей его на YouTube и пришли ссылку."; $("#sMsg").className = "msg err"; prev.hidden = true; return; }
    $("#sMsg").textContent = "";
    const url = URL.createObjectURL(f);
    prev.hidden = false; prev.innerHTML = `<video src="${url}" controls muted playsinline preload="metadata"></video>`;
    const v = $("video", prev);
    v.onloadeddata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); };
    v.onseeked = () => {
      if (thumbBlob) return;
      $("#sShort").checked = v.videoHeight > v.videoWidth;
      const c = document.createElement("canvas"), scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
      c.width = v.videoWidth * scale; c.height = v.videoHeight * scale;
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      c.toBlob(b => thumbBlob = b, "image/jpeg", .82);
    };
    if (!$("#sTitle").value) $("#sTitle").value = f.name.replace(/\.[^.]+$/, "").slice(0, 140);
  };
  $("#subForm").onsubmit = async e => {
    e.preventDefault();
    const btn = $("#sBtn"), msg = $("#sMsg"), say = (t, k) => { msg.textContent = t; msg.className = "msg" + (k ? " " + k : ""); };
    const row = { kind, title: $("#sTitle").value.trim(), author: $("#sAuthor").value.trim(), description: $("#sDesc").value.trim(), tags: $("#sTags").value.trim(), is_short: $("#sShort").checked };
    if (!row.title) return say("Напиши название.", "err");
    btn.disabled = true;
    try {
      if (kind === "youtube") {
        row.yt_id = youtubeId($("#sUrl").value);
        if (!row.yt_id) throw new Error("Это не похоже на ссылку на видео YouTube.");
        if (S.byKey.has(row.yt_id)) throw new Error("Это видео уже есть на сайте.");
      } else {
        const f = $("#sFile").files[0];
        if (!f) throw new Error("Выбери видеофайл.");
        if (f.size > 50 * 1024 * 1024) throw new Error("Файл больше 50 МБ.");
        const id = crypto.randomUUID(), ext = (f.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "mp4";
        say("Загружаю видео… не закрывай окно");
        const up = await sb.storage.from("videos").upload(`${S.user.id}/${id}.${ext}`, f, { contentType: f.type || "video/mp4" });
        if (up.error) throw up.error;
        row.file_path = up.data.path;
        if (thumbBlob) {
          const t = await sb.storage.from("videos").upload(`${S.user.id}/${id}.jpg`, thumbBlob, { contentType: "image/jpeg" });
          if (!t.error) row.thumb_path = t.data.path;
        }
      }
      say("Отправляю заявку…");
      const { error } = await sb.from("submissions").insert(row);
      if (error) throw error;
      closeSheet(); toast("Заявка отправлена! Модераторы скоро посмотрят.");
      if (location.hash.startsWith("#/you")) route();
    } catch (err) { say(errText(err), "err"); btn.disabled = false; }
  };
}

// ---------- навигация ----------
function notFound() { $("#app").innerHTML = `<div class="empty"><b>Видео не найдено</b>Возможно, его скрыли или удалили. <a href="#/">На главную</a></div>`; }
function route() {
  document.body.classList.remove("shorts-mode", "side-open", "search-open");
  shortsObserver?.disconnect();
  const h = location.hash || "#/";
  let m, nav = "home";
  if ((m = h.match(/^#v([\w-]{6,20})$/))) { location.replace("#/watch/" + m[1]); return; } // старые ссылки
  if ((m = h.match(/^#a(.+)$/))) { location.replace("#/author/" + m[1]); return; }
  if ((m = h.match(/^#\/watch\/(.+)$/))) { nav = ""; watch(decodeURIComponent(m[1])); }
  else if ((m = h.match(/^#\/shorts(?:\/(.+))?$/))) { nav = "shorts"; shorts(m[1] && decodeURIComponent(m[1])); }
  else if ((m = h.match(/^#\/author\/(.+)$/))) { nav = ""; authorPage(decodeURIComponent(m[1])); }
  else if (h.startsWith("#/subs")) { nav = "subs"; subsPage(); }
  else if ((m = h.match(/^#\/you(?:\/(\w+))?/))) { nav = m[1] === "history" ? "history" : m[1] === "liked" ? "liked" : "you"; you(m[1]); }
  else home();
  $$("[data-nav]").forEach(a => a.classList.toggle("on", a.dataset.nav === nav || (nav === "history" || nav === "liked") && a.dataset.nav === "you" && a.closest(".bottom")));
}
addEventListener("hashchange", () => { S.shown = PAGE; route(); });
$("#searchForm").onsubmit = e => {
  e.preventDefault(); S.query = $("#q").value.trim(); S.shown = PAGE;
  document.body.classList.remove("search-open");
  if (location.hash === "#/" || location.hash === "") home(); else location.hash = "#/";
};
$("#q").oninput = () => { if (!$("#q").value) { S.query = ""; if (!location.hash || location.hash === "#/") home(); } };
$("#searchToggle").onclick = () => { document.body.classList.add("search-open"); $("#q").focus(); };
$("#q").onblur = () => setTimeout(() => document.body.classList.remove("search-open"), 150);
$("#menuBtn").onclick = () => document.body.classList.toggle(innerWidth >= 1100 ? "side-closed" : "side-open");
$("#side").onclick = e => { if (e.target.closest("a")) document.body.classList.remove("side-open"); };
$("#createTop").onclick = openSubmit; $("#createBottom").onclick = openSubmit;
document.addEventListener("click", e => {
  if (e.target.closest("#signinBtn")) openLogin();
  if (e.target.closest("#meBtn")) location.hash = "#/you";
  if (document.body.classList.contains("side-open") && !e.target.closest("#side, #menuBtn")) document.body.classList.remove("side-open");
});

// ---------- старт ----------
(async () => {
  try {
    await Promise.all([loadData(), loadMe().catch(() => { })]);
  } catch (e) {
    $("#app").innerHTML = `<div class="loading">Не получилось загрузить видео. Обнови страницу через минуту.</div>`;
    return;
  }
  sb?.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") { S.user = null; S.profile = null; renderAccount(); } });
  route();
})();
