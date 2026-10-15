// РКГДTUBE — сайт читает data/posts.json, который обновляет GitHub каждые 15 минут.
const CHANNEL = "RCGDTUBE";
const PAGE = 24;
let POSTS = [], UPDATED = null, filter = "all", query = "", shown = PAGE;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hue = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + " мин назад";
  if (s < 86400) return Math.round(s / 3600) + " ч назад";
  if (s < 86400 * 7) return Math.round(s / 86400) + " дн назад";
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}
const views = v => v ? v + " просмотров" : "";

function avatar(name, size) {
  const cols = ["#e43ad6", "#ff8a1f", "#ffd23d"];
  const letter = [...name.replace(/[^\p{L}\p{N}]/gu, "")][0] || "?";
  return `<span class="av" style="background:${cols[hue(name) % 3]};width:${size}px;height:${size}px">${esc(letter.toUpperCase())}</span>`;
}

// запасное превью в стиле GD, если картинку не удалось скачать
function paint(cv, id) {
  const W = cv.width = 640, H = cv.height = 360, c = cv.getContext("2d"); let s = id * 9301 + 49297;
  const R = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const g = c.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, `hsl(${280 + R() * 40},70%,${8 + R() * 8}%)`); g.addColorStop(1, `hsl(${300 + R() * 30},60%,${14 + R() * 8}%)`);
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  const pal = ["#e43ad6", "#ff8a1f", "#ffd23d", "#b14dff", "#ff4f8b"];
  c.globalCompositeOperation = "lighter";
  for (let i = 0; i < 14; i++) {
    const x = R() * W, y = R() * H, z = 8 + R() * 40; c.fillStyle = pal[(R() * 5) | 0] + "aa";
    c.save(); c.translate(x, y); c.rotate(R() * 6.28); c.shadowColor = c.fillStyle; c.shadowBlur = 18;
    if (R() > .5) c.fillRect(-z / 2, -z / 2, z, z); else { c.beginPath(); c.moveTo(0, -z); c.lineTo(z, z); c.lineTo(-z, z); c.fill(); }
    c.restore();
  }
  c.globalCompositeOperation = "source-over";
}

function thumb(p) {
  const pic = p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy">` : `<canvas data-id="${p.id}" aria-hidden="true"></canvas>`;
  const kind = p.kind === "photo" ? `<span class="kind">Фото${p.photo_count > 1 ? " · " + p.photo_count : ""}</span>` : "";
  const dur = p.kind === "video" ? `<span class="dur">${esc(p.duration || "видео")}</span>` : "";
  return `<div class="thumb">${pic}${kind}${dur}</div>`;
}

function card(p, small) {
  return `<a class="card" href="#v${p.id}">${thumb(p)}
  <div class="meta">${small ? "" : avatar(p.author, 36)}<div><h3>${esc(p.title)}</h3>
  <p>${esc(p.author)}<br>${[views(p.views), ago(p.date)].filter(Boolean).join(" · ")}</p></div></div></a>`;
}

function paintAll(root) { root.querySelectorAll("canvas[data-id]").forEach(cv => paint(cv, +cv.dataset.id)); }

function matches(p) {
  const ql = query.toLowerCase();
  const okFilter = filter === "all" || (filter === "video" && p.kind === "video") || (filter === "photo" && p.kind === "photo") || p.tags.includes(filter);
  return okFilter && (!ql || (p.title + " " + p.author + " " + p.tags.join(" ")).toLowerCase().includes(ql));
}

function list() {
  const items = POSTS.filter(matches);
  const upd = UPDATED ? `<span class="updated">обновлено ${ago(UPDATED)}</span>` : "";
  $("#app").innerHTML = `
  <section class="chan"><img src="media/logo.jpg" alt="Аватар канала"><div><h1>РКГДTUBE</h1>
    <p>Канал, совмещающий в себе десятки каналов других креаторов · <a href="https://t.me/${CHANNEL}" target="_blank" rel="noopener">@${CHANNEL}</a></p>
    <div class="stats"><span><b>${POSTS.length}</b> постов на сайте</span>${upd}</div></div></section>
  <div class="grid">${items.slice(0, shown).map(p => card(p)).join("") ||
    `<div class="empty">${POSTS.length ? "Ничего не нашлось. Попробуй другой запрос." : "Посты ещё не загрузились. Первое обновление займёт пару минут."}</div>`}</div>
  ${items.length > shown ? `<div class="more"><button class="btn hot" id="more">Показать ещё</button></div>` : ""}`;
  paintAll($("#app"));
  const m = $("#more"); if (m) m.onclick = () => { shown += PAGE; list(); };
}

function embedTelegram(box, id) {
  const s = document.createElement("script");
  s.async = true;
  s.src = "https://telegram.org/js/telegram-widget.js?22";
  s.dataset.telegramPost = `${CHANNEL}/${id}`;
  s.dataset.width = "100%";
  s.dataset.dark = "1";
  s.dataset.color = "FF8A1F";
  s.dataset.userpic = "false";
  box.appendChild(s);
}

function watch(id) {
  const p = POSTS.find(x => x.id == id); if (!p) return list();
  const tg = `https://t.me/${CHANNEL}/${p.id}`;
  const rest = POSTS.filter(x => x.id != p.id)
    .sort((a, b) => (b.author === p.author) - (a.author === p.author) || b.id - a.id).slice(0, 10);
  const media = p.kind === "photo" && p.photos?.length
    ? `<div class="gallery">${p.photos.map(src => `<img src="${esc(src)}" alt="" loading="lazy">`).join("")}</div>`
    : `<div class="player embed" id="embed"></div>`;
  $("#app").innerHTML = `<div class="watch"><div style="min-width:0">
    ${media}
    <h2>${esc(p.title)}</h2>
    <div class="row"><div class="who">${avatar(p.author, 40)}<div><b>${esc(p.author)}</b><span>${[views(p.views), ago(p.date)].filter(Boolean).join(" · ")}</span></div></div>
      ${p.youtube ? `<a class="btn" href="${esc(p.youtube)}" target="_blank" rel="noopener">Оригинал на YouTube</a>` : ""}
      <a class="btn hot" href="${tg}" target="_blank" rel="noopener">Пост в Telegram</a></div>
    <div class="desc"><div class="top">${p.tags.map(t => "#" + esc(t)).join(" ") || "РКГДTUBE"} · пост №${p.id}</div>
      ${p.quote ? `<blockquote>${esc(p.quote)}</blockquote>` : `<span style="color:var(--muted)">Автор: ${esc(p.author)}${p.forwarded ? ". Репост в РКГДTUBE." : "."}</span>`}
      ${p.reactions?.length ? `<div class="reacts">${p.reactions.map(r => `<span>${esc(r)}</span>`).join("")}</div>` : ""}</div>
    <a class="btn back" href="#top">← Все видео</a></div>
    <aside class="side"><h4>Ещё на канале</h4>${rest.map(x => card(x, true)).join("")}</aside></div>`;
  const box = $("#embed"); if (box) embedTelegram(box, p.id);
  paintAll($("#app")); window.scrollTo(0, 0);
}

function route() { const m = location.hash.match(/^#v(\d+)$/); m ? watch(m[1]) : list(); }

function chips() {
  const count = {};
  POSTS.forEach(p => p.tags.forEach(t => count[t] = (count[t] || 0) + 1));
  const top = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => [t, "#" + t]);
  const all = [["all", "Все"], ["video", "Видео"], ["photo", "Фото"], ...top];
  $("#chips").innerHTML = all.map(([k, l]) => `<button class="chip" data-k="${esc(k)}" aria-pressed="${k === filter}">${esc(l)}</button>`).join("");
}

$("#chips").addEventListener("click", e => {
  const b = e.target.closest(".chip"); if (!b) return;
  filter = b.dataset.k; shown = PAGE;
  document.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", c.dataset.k === filter));
  location.hash.startsWith("#v") ? (location.hash = "top") : list();
});
$("#q").addEventListener("input", e => {
  query = e.target.value.trim(); shown = PAGE;
  location.hash.startsWith("#v") ? (location.hash = "top") : list();
});
addEventListener("hashchange", route);

fetch("data/posts.json?t=" + Date.now())
  .then(r => r.json())
  .then(d => { POSTS = d.posts || []; UPDATED = d.updated; chips(); route(); })
  .catch(() => { $("#app").innerHTML = `<div class="loading">Не получилось загрузить посты. Обнови страницу через минуту.</div>`; });
