// Страница владельца: подключить токен GitHub к админке и управлять ключами.
const $ = s => document.querySelector(s);
let TOKEN = null, CFG = null, CFG_SHA = null;

$("#patLink").href = "https://github.com/settings/personal-access-tokens/new?" + new URLSearchParams({
  name: "rcgdtube-uploads",
  description: "Админка сайта РКГДTUBE: запись в репозиторий rcgdtube-uploads",
  target_name: ADMIN.owner,
  expires_in: "366",
  contents: "write",
});

function say(text, kind) { const m = $("#setupMsg"); m.textContent = text; m.className = "msg" + (kind ? " " + kind : ""); }

$("#setupForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#setupBtn"); btn.disabled = true;
  const token = $("#token").value.trim(), key = $("#key").value;
  try {
    say("Проверяю токен…");
    const who = await gh("/user", {}, token);
    if (!who.ok) throw new Error("GitHub не принял токен. Проверь, что скопировал его целиком.");

    say("Проверяю ключ…");
    const f = await readFile("config.json", token);
    if (!f) throw new Error("В репозитории rcgdtube-uploads нет config.json. Его должен был создать Claude при настройке.");
    const { master } = await unlockMaster(f.data, key);

    say("Сохраняю…");
    f.data.token = await encryptToken(master, token);
    f.data.token_set = new Date().toISOString();
    CFG_SHA = await writeFile("config.json", f.data, f.sha, "Подключён токен админки", token);
    CFG = f.data; TOKEN = token;

    if (!(await readFile("uploads.json", token)))
      await writeFile("uploads.json", { videos: [], hidden: [] }, null, "Создан список загрузок", token);

    say("Готово! Админка подключена. Теперь любой из 30 ключей работает на странице upload.html.", "ok");
    $("#token").value = ""; $("#key").value = "";
    renderKeys();
  } catch (err) { say(err.message, "err"); }
  btn.disabled = false;
});

function renderKeys() {
  $("#keysPanel").hidden = false;
  const on = new Set(CFG.keys.map(k => k.n));
  const all = Array.from({ length: CFG.total || 30 }, (_, i) => i + 1);
  $("#keys").innerHTML = all.map(n => `<div class="keyrow${on.has(n) ? "" : " off"}">
    <span>Ключ №${n}${on.has(n) ? "" : " · отключён"}</span>
    ${on.has(n) ? `<button class="btn" type="button" data-off="${n}">Отключить</button>` : ""}</div>`).join("");
}

$("#keys").addEventListener("click", async e => {
  const b = e.target.closest("[data-off]"); if (!b) return;
  if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Точно?"; return; }
  b.disabled = true;
  const n = +b.dataset.off;
  try {
    const f = await readFile("config.json", TOKEN);
    if (f.data.keys.length <= 1) throw new Error("Нельзя отключить последний ключ.");
    f.data.keys = f.data.keys.filter(k => k.n !== n);
    CFG_SHA = await writeFile("config.json", f.data, f.sha, `Отключён ключ №${n}`, TOKEN);
    CFG = f.data; renderKeys();
  } catch (err) { b.textContent = "Ошибка"; b.title = err.message; b.disabled = false; }
});
