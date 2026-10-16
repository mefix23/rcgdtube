// Общие функции админки РКГДTUBE: проверка ключей и работа с репозиторием загрузок.
//
// Как это устроено (чтобы ключи нельзя было подделать на открытом сайте):
// - в репозитории mefix23/rcgdtube-uploads лежит config.json;
// - в нём для каждого из 30 ключей зашифрован общий «мастер-код», а мастер-кодом зашифрован
//   токен GitHub, которым можно записывать в репозиторий загрузок;
// - без правильного ключа расшифровать ничего нельзя, а сами ключи нигде не хранятся.
const ADMIN = {
  owner: "mefix23",
  repo: "rcgdtube-uploads",
  api: "https://api.github.com",
};

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = {
  to: buf => btoa(String.fromCharCode(...new Uint8Array(buf))),
  from: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};
// base64 для текста с русскими буквами
const utf8b64 = {
  to: s => { const b = enc.encode(s); let out = ""; for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(out); },
  from: s => dec.decode(Uint8Array.from(atob(s.replace(/\s/g, "")), c => c.charCodeAt(0))),
};

function normKey(k) { return String(k || "").trim().toUpperCase().replace(/\s+/g, ""); }

async function sha256hex(s) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function keyId(key) { return (await sha256hex("rcgdtube-key:" + normKey(key))).slice(0, 16); }

async function kekFromKey(key, salt, iter) {
  const base = await crypto.subtle.importKey("raw", enc.encode(normKey(key)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

// ключ -> мастер-код (или ошибка, если ключ неверный/отключён)
async function unlockMaster(config, key) {
  const kid = await keyId(key);
  const entry = (config.keys || []).find(e => e.kid === kid);
  if (!entry) throw new Error("Такого ключа нет или он отключён.");
  const kek = await kekFromKey(key, b64.from(entry.salt), config.kdf.iter);
  let raw;
  try {
    raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.from(entry.iv) }, kek, b64.from(entry.ct));
  } catch { throw new Error("Ключ не подошёл."); }
  const master = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { master, n: entry.n };
}

async function decryptToken(config, master) {
  if (!config.token) return null;
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.from(config.token.iv) }, master, b64.from(config.token.ct));
  return dec.decode(pt);
}

async function encryptToken(master, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, master, enc.encode(token));
  return { iv: b64.to(iv), ct: b64.to(ct) };
}

// --- GitHub ---
async function gh(path, opts = {}, token) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) };
  if (token) headers.Authorization = "Bearer " + token;
  const r = await fetch(ADMIN.api + path, { ...opts, headers, cache: "no-store" });
  return r;
}

// прочитать файл из репозитория загрузок: { data, sha } или null, если файла нет
async function readFile(name, token) {
  const r = await gh(`/repos/${ADMIN.owner}/${ADMIN.repo}/contents/${name}?ref=main`, {}, token);
  if (r.status === 404) return null;
  if (r.status === 403 || r.status === 429) throw new Error("GitHub временно ограничил запросы. Подожди пару минут и попробуй ещё раз.");
  if (!r.ok) throw new Error("Не удалось прочитать " + name + " (ошибка " + r.status + ").");
  const j = await r.json();
  return { data: JSON.parse(utf8b64.from(j.content)), sha: j.sha };
}

async function writeFile(name, data, sha, message, token) {
  const body = { message, content: utf8b64.to(JSON.stringify(data, null, 1) + "\n"), branch: "main" };
  if (sha) body.sha = sha;
  const r = await gh(`/repos/${ADMIN.owner}/${ADMIN.repo}/contents/${name}`, {
    method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
  }, token);
  if (r.status === 409 || r.status === 422) throw new Error("Файл только что изменил кто-то ещё. Нажми ещё раз.");
  if (r.status === 401) throw new Error("Токен больше не работает. Владельцу нужно подключить новый на странице setup.html.");
  if (r.status === 403 || r.status === 404) throw new Error("У токена нет права записи в " + ADMIN.repo + ".");
  if (!r.ok) throw new Error("GitHub не принял изменения (ошибка " + r.status + ").");
  return (await r.json()).content.sha;
}

// ссылка на YouTube -> id видео
function youtubeId(s) {
  s = String(s || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, "");
    if (host === "youtu.be") return (u.pathname.slice(1).match(/^[\w-]{11}/) || [])[0] || null;
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (u.searchParams.get("v")) return (u.searchParams.get("v").match(/^[\w-]{11}/) || [])[0] || null;
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      return m ? m[1] : null;
    }
  } catch { /* не ссылка */ }
  return null;
}

function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { } }
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }
