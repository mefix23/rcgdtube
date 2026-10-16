// Админка: вход по ключу, добавление и скрытие видео.
let TOKEN = null, KEY_NO = null;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function say(el, text, kind) { el.textContent = text; el.className = "msg" + (kind ? " " + kind : ""); }
function busy(btn, on) { btn.disabled = on; }

async function login(key, remember) {
  const cfgFile = await readFile("config.json");
  if (!cfgFile) throw new Error("Админка ещё не настроена: в репозитории нет config.json.");
  const { master, n } = await unlockMaster(cfgFile.data, key);
  const token = await decryptToken(cfgFile.data, master);
  if (!token) throw new Error("Ключ верный, но владелец ещё не подключил админку. Ему нужно открыть страницу setup.html.");
  TOKEN = token; KEY_NO = n;
  store("rcgd-admin-key", remember ? normKey(key) : null);
  $("#keyNo").textContent = "№" + n;
  $("#login").hidden = true;
  $("#panel").hidden = false;
  await refresh();
}

async function getUploads() {
  const f = await readFile("uploads.json", TOKEN);
  return f || { data: { videos: [], hidden: [] }, sha: null };
}

// изменить uploads.json: читаем свежую версию, меняем, сохраняем (с повтором, если кто-то успел раньше)
async function changeUploads(fn, message) {
  for (let i = 0; i < 3; i++) {
    const f = await getUploads();
    f.data.videos = f.data.videos || []; f.data.hidden = f.data.hidden || [];
    fn(f.data);
    try { await writeFile("uploads.json", f.data, f.sha, message, TOKEN); return f.data; }
    catch (e) { if (i === 2 || !/кто-то ещё/.test(e.message)) throw e; }
  }
}

async function refresh() {
  try { render((await getUploads()).data); }
  catch (e) { $("#upList").innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
}

function render(d) {
  const vids = (d.videos || []).slice().sort((a, b) => (b.added || "").localeCompare(a.added || ""));
  $("#upCount").textContent = vids.length || "";
  $("#upList").innerHTML = vids.map(v => `<div class="item">
      <img src="https://i.ytimg.com/vi/${esc(v.yt)}/mqdefault.jpg" alt="" loading="lazy">
      <div><b>${esc(v.title || "Без названия")}</b><span>${esc(v.author || "автор не указан")} · ключ №${esc(v.by)} · ${new Date(v.added).toLocaleString("ru-RU")}</span></div>
      <button class="btn" type="button" data-del="${esc(v.id)}">Удалить</button></div>`).join("")
    || `<p class="muted">Пока ничего не добавлено.</p>`;
  const hid = d.hidden || [];
  $("#hidCount").textContent = hid.length || "";
  $("#hidList").innerHTML = hid.map(id => `<div class="item">
      <img src="https://i.ytimg.com/vi/${esc(id)}/mqdefault.jpg" alt="" loading="lazy">
      <div><b><a href="https://youtu.be/${esc(id)}" target="_blank" rel="noopener">youtu.be/${esc(id)}</a></b><span>скрыто с сайта</span></div>
      <button class="btn" type="button" data-unhide="${esc(id)}">Вернуть</button></div>`).join("")
    || `<p class="muted">Скрытых видео нет.</p>`;
}

$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#loginBtn"), msg = $("#loginMsg");
  busy(btn, true); say(msg, "Проверяю ключ…");
  try { await login($("#key").value, $("#remember").checked); say(msg, ""); }
  catch (err) { say(msg, err.message, "err"); }
  busy(btn, false);
});

$("#logout").addEventListener("click", () => {
  TOKEN = null; KEY_NO = null; store("rcgd-admin-key", null);
  $("#key").value = ""; $("#panel").hidden = true; $("#login").hidden = false;
});

$("#url").addEventListener("input", () => {
  const id = youtubeId($("#url").value);
  $("#preview").hidden = !id;
  if (id) $("#previewImg").src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
});

$("#addForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#addBtn"), msg = $("#addMsg");
  const id = youtubeId($("#url").value);
  if (!id) return say(msg, "Это не похоже на ссылку на видео YouTube. Пример: https://youtu.be/fJP5DtkLl_k", "err");
  const title = $("#title").value.trim(), author = $("#author").value.trim();
  const desc = $("#desc").value.trim(), tags = $("#tags").value.trim();
  busy(btn, true); say(msg, "Выкладываю…");
  try {
    let dup = false;
    const d = await changeUploads(data => {
      if (data.videos.some(v => v.yt === id)) { dup = true; return; }
      data.videos.push({ id: crypto.randomUUID(), yt: id, title, author, desc, tags, added: new Date().toISOString(), by: KEY_NO });
      data.hidden = data.hidden.filter(x => x !== id);
    }, `Добавлено видео ${id} (ключ №${KEY_NO})`);
    if (dup) say(msg, "Это видео уже добавлено.", "err");
    else {
      say(msg, "Готово! Видео появится на сайте через пару минут, а в Telegram-канале — в течение 15 минут.", "ok");
      $("#addForm").reset(); $("#preview").hidden = true;
    }
    render(d);
  } catch (err) { say(msg, err.message, "err"); }
  busy(btn, false);
});

$("#hideForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#hideBtn"), msg = $("#hideMsg");
  const id = youtubeId($("#hideUrl").value);
  if (!id) return say(msg, "Это не похоже на ссылку на видео YouTube.", "err");
  busy(btn, true); say(msg, "Скрываю…");
  try {
    const d = await changeUploads(data => { if (!data.hidden.includes(id)) data.hidden.push(id); }, `Скрыто видео ${id} (ключ №${KEY_NO})`);
    say(msg, "Скрыто. С сайта пропадёт в течение пары минут.", "ok");
    $("#hideForm").reset(); render(d);
  } catch (err) { say(msg, err.message, "err"); }
  busy(btn, false);
});

document.addEventListener("click", async e => {
  const del = e.target.closest("[data-del]"), un = e.target.closest("[data-unhide]");
  if (!del && !un) return;
  const btn = del || un;
  if (del && btn.dataset.confirm !== "1") { btn.dataset.confirm = "1"; btn.textContent = "Точно удалить?"; return; }
  busy(btn, true);
  try {
    const d = del
      ? await changeUploads(data => { data.videos = data.videos.filter(v => v.id !== del.dataset.del); }, `Удалено видео (ключ №${KEY_NO})`)
      : await changeUploads(data => { data.hidden = data.hidden.filter(x => x !== un.dataset.unhide); }, `Возвращено видео ${un.dataset.unhide} (ключ №${KEY_NO})`);
    render(d);
  } catch (err) { btn.textContent = "Ошибка"; btn.title = err.message; busy(btn, false); }
});

// если ключ запомнен — входим сразу
const saved = load("rcgd-admin-key");
if (saved) { $("#key").value = saved; $("#remember").checked = true; login(saved, true).catch(err => say($("#loginMsg"), err.message, "err")); }
