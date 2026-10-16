// РКГДTUBE — главная страница.
// Список видео лежит в data/posts.json (его собирает GitHub из SQL-базы ворков),
// плюс видео, которые админы добавили через upload.html — они подмешиваются сразу.
const CHANNEL = "RCGDTUBE";
const UPLOADS_RAW = "https://raw.githubusercontent.com/mefix23/rcgdtube-uploads/main/uploads.json";
const PAGE = 24;

let POSTS = [], META = {}, sort = "new", query = "", shown = PAGE, shuffled = null;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hue = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const thumbUrl = (id, q = "mqdefault") => `https://i.ytimg.com/vi/${id}/${q}.jpg`;
const authorKey = p => p.channel || "n:" + p.author;

function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + " мин назад";
  if (s < 86400) return Math.round(s / 3600) + " ч назад";
  if (s < 86400 * 30) return Math.round(s / 86400) + " дн назад";
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  return n + " " + (a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? few : many);
}

function avatar(name, size) {
  const cols = ["#e43ad6", "#ff8a1f", "#ffd23d"];
  const letter = [...String(name).replace(/[^\p{L}\p{N}]/gu, "")][0] || "?";
  return `<span class="av" style="background:${cols[hue(String(name)) % 3]};width:${size}px;height:${size}px">${esc(letter.toUpperCase())}</span>`;
}

function channelUrl(p) {
  if (p.handle) return "https://www.youtube.com/" + encodeURI(p.handle);
  if (p.channel) return "https://www.youtube.com/channel/" + encodeURIComponent(p.channel);
  return null;
}

function card(p, small) {
  const badge = p.admin ? `<span class="kind">от админов</span>` : "";
  return `<a class="card" href="#v${esc(p.yt)}">
    <div class="thumb"><img src="${thumbUrl(p.yt)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">${badge}</div>
    <div class="meta">${small ? "" : avatar(p.author, 36)}<div><h3>${esc(p.title)}</h3>
    <p>${esc(p.author)}<br>${ago(p.date)}</p></div></div></a>`;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function ordered() {
  if (sort === "old") return POSTS.slice().reverse();
  if (sort === "random") return shuffled || (shuffled = shuffle(POSTS));
  if (sort === "admin") return POSTS.filter(p => p.admin);
  return POSTS;
}

function filtered(list) {
  const ql = query.toLowerCase();
  return ql ? list.filter(p => (p.title + " " + p.author).toLowerCase().includes(ql)) : list;
}

function grid(items) {
  return `<div class="grid">${items.slice(0, shown).map(p => card(p)).join("") ||
    `<div class="empty">${POSTS.length ? "Ничего не нашлось. Попробуй другой запрос." : "Видео ещё не загрузились. Первое обновление займёт пару минут."}</div>`}</div>
    ${items.length > shown ? `<div class="more"><button class="btn hot" id="more">Показать ещё</button></div>` : ""}`;
}

function bindMore(render) { const m = $("#more"); if (m) m.onclick = () => { shown += PAGE; render(); }; }

function list() {
  const items = filtered(ordered());
  const upd = META.updated ? `<span class="updated">обновлено ${ago(META.updated)}</span>` : "";
  $("#app").innerHTML = `
  <section class="chan"><img src="media/logo.jpg" alt="Аватар канала"><div><h1>РКГДTUBE</h1>
    <p>Ворки креаторов Geometry Dash, которые выходили в канале · <a href="https://t.me/${CHANNEL}" target="_blank" rel="noopener">@${CHANNEL}</a></p>
    <div class="stats"><span><b>${POSTS.length}</b> ${plural(POSTS.length, "ворк", "ворка", "ворков").replace(/^\d+ /, "")}</span>
    <span><b>${META.authors || ""}</b> ${plural(META.authors || 0, "автор", "автора", "авторов").replace(/^\d+ /, "")}</span>${upd}</div></div></section>
  ${query ? `<p class="found">Найдено: ${items.length}</p>` : ""}
  ${grid(items)}`;
  bindMore(list);
}

function authorPage(key) {
  const all = POSTS.filter(p => authorKey(p) === key);
  if (!all.length) return list();
  const a = all[0], url = channelUrl(a);
  const items = filtered(all);
  $("#app").innerHTML = `
  <section class="chan">${avatar(a.author, 84)}<div><h1>${esc(a.author)}</h1>
    <p>${plural(all.length, "ворк", "ворка", "ворков")} на РКГДTUBE${a.handle ? " · " + esc(a.handle) : ""}</p>
    <div class="row" style="margin-top:10px">${url ? `<a class="btn hot" href="${esc(url)}" target="_blank" rel="noopener">Канал на YouTube</a>` : ""}
    <a class="btn" href="#top">← Все видео</a></div></div></section>
  ${grid(items)}`;
  bindMore(() => authorPage(key));
  window.scrollTo(0, 0);
}

function watch(id) {
  const p = POSTS.find(x => x.yt === id); if (!p) return list();
  const key = authorKey(p);
  const same = POSTS.filter(x => x.yt !== id && authorKey(x) === key).slice(0, 6);
  const fresh = POSTS.filter(x => x.yt !== id && authorKey(x) !== key).slice(0, 12 - same.length);
  const yt = `https://www.youtube.com/watch?v=${encodeURIComponent(p.yt)}`;
  const player = p.noembed
    ? `<a class="player" href="${yt}" target="_blank" rel="noopener"><img src="${thumbUrl(p.yt, "hqdefault")}" alt="">
        <div class="overlay"><span class="play"><svg viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z"/></svg></span>
        <small>Автор запретил показ на других сайтах. Смотреть на YouTube</small></div></a>`
    : `<div class="player"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(p.yt)}?rel=0&autoplay=1"
        title="${esc(p.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
  const chUrl = channelUrl(p);
  $("#app").innerHTML = `<div class="watch"><div style="min-width:0">
    ${player}
    <h2>${esc(p.title)}</h2>
    <div class="row"><a class="who" href="#a${encodeURIComponent(key)}">${avatar(p.author, 40)}<div><b>${esc(p.author)}</b><span>${p.admin ? "добавлено админом · " : ""}${ago(p.date)}</span></div></a>
      <a class="btn" href="${yt}" target="_blank" rel="noopener">Смотреть на YouTube</a>
      ${p.tg ? `<a class="btn hot" href="https://t.me/${CHANNEL}/${p.tg}" target="_blank" rel="noopener">Пост в Telegram</a>` : ""}</div>
    <div class="desc"><div class="top">${esc(p.author)}${p.handle ? " · " + esc(p.handle) : ""}</div>
      <span style="color:var(--muted)">Оригинальное видео на YouTube. Все права у автора.</span>
      ${chUrl ? `<div class="reacts"><a class="btn" href="${esc(chUrl)}" target="_blank" rel="noopener">Канал автора</a>
        <a class="btn" href="#a${encodeURIComponent(key)}">Все ворки автора на сайте</a></div>` : ""}</div>
    <a class="btn back" href="#top">← Все видео</a></div>
    <aside class="side">${same.length ? `<h4>Ещё от ${esc(p.author)}</h4>${same.map(x => card(x, true)).join("")}` : ""}
      <h4>${same.length ? "Новое на канале" : "Ещё на канале"}</h4>${fresh.map(x => card(x, true)).join("")}</aside></div>`;
  window.scrollTo(0, 0);
}

function route() {
  const h = decodeURIComponent(location.hash);
  let m;
  if ((m = h.match(/^#v([\w-]{6,20})$/))) return watch(m[1]);
  if ((m = h.match(/^#a(.+)$/))) return authorPage(m[1]);
  list();
}

function chips() {
  const opts = [["new", "Новые"], ["random", "Случайные"], ["old", "Старые"]];
  if (POSTS.some(p => p.admin)) opts.push(["admin", "От админов"]);
  $("#chips").innerHTML = opts.map(([k, l]) => `<button class="chip" data-k="${k}" aria-pressed="${k === sort}">${l}</button>`).join("");
}

$("#chips").addEventListener("click", e => {
  const b = e.target.closest(".chip"); if (!b) return;
  if (b.dataset.k === "random") shuffled = null;
  sort = b.dataset.k; shown = PAGE;
  document.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", c.dataset.k === sort));
  location.hash && location.hash !== "#top" ? (location.hash = "top") : list();
});
$("#q").addEventListener("input", e => {
  query = e.target.value.trim(); shown = PAGE;
  /^#v/.test(location.hash) ? (location.hash = "top") : route();
});
addEventListener("hashchange", () => { shown = PAGE; route(); });

// свежие загрузки админов показываем сразу, не дожидаясь обновления списка
async function mergeUploads() {
  try {
    const r = await fetch(UPLOADS_RAW + "?t=" + Math.floor(Date.now() / 60000));
    if (!r.ok) return;
    const u = await r.json();
    const hidden = new Set(u.hidden || []);
    const have = new Set(POSTS.map(p => p.yt));
    const extra = (u.videos || []).filter(v => v.yt && !have.has(v.yt)).map(v => ({
      yt: v.yt, title: v.title || "Новое видео", author: v.author || "Неизвестный автор", date: v.added, admin: true
    }));
    POSTS = extra.concat(POSTS).filter(p => !hidden.has(p.yt));
    POSTS.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  } catch (e) { /* не страшно: появятся при следующем обновлении */ }
}

fetch("data/posts.json?t=" + Math.floor(Date.now() / 60000))
  .then(r => r.json())
  .then(async d => { POSTS = d.posts || []; META = d; await mergeUploads(); chips(); route(); })
  .catch(() => { $("#app").innerHTML = `<div class="loading">Не получилось загрузить видео. Обнови страницу через минуту.</div>`; });
