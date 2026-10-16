#!/usr/bin/env bash
# =====================================================================
#  РКГДTUBE stream — установка на свой сервер (VPS с Ubuntu 22.04 / 24.04).
#  Запуск (в консоли сервера, под root):
#     curl -fsSL https://raw.githubusercontent.com/mefix23/rcgdtube/main/server/install.sh | bash
#  Повторный запуск обновляет сервер до свежей версии и ничего не ломает.
# =====================================================================
set -euo pipefail
REPO_RAW="https://raw.githubusercontent.com/mefix23/rcgdtube/main/server"
DIR=/opt/rcgd-stream
ENV="$DIR/.env"
say() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Запусти под root (или через sudo)."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

say "Ставлю нужные программы"
apt-get update -y -q
apt-get install -y -q python3-venv python3-pip curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y -q && apt-get install -y -q caddy >/dev/null
fi

say "Скачиваю сервер"
mkdir -p "$DIR"
curl -fsSL "$REPO_RAW/app.py" -o "$DIR/app.py"
curl -fsSL "$REPO_RAW/requirements.txt" -o "$DIR/requirements.txt"
[ -d "$DIR/venv" ] || python3 -m venv "$DIR/venv"
"$DIR/venv/bin/pip" install -q --upgrade pip
"$DIR/venv/bin/pip" install -q -r "$DIR/requirements.txt"

if [ ! -f "$ENV" ]; then
  say "Ключи приложения Telegram (с сайта my.telegram.org → API development tools)"
  read -rp "  App api_id: " API_ID </dev/tty
  read -rp "  App api_hash: " API_HASH </dev/tty
  SETUP_KEY=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
  IP=$(curl -4 -fsS https://api.ipify.org)
  DOMAIN="${DOMAIN:-$(echo "$IP" | tr . -).sslip.io}"
  umask 077
  cat > "$ENV" <<EOF
TG_API_ID=$API_ID
TG_API_HASH=$API_HASH
SESSION_PATH=$DIR/telegram.session
SETUP_KEY=$SETUP_KEY
CHANNEL=RCGDTUBE
PORT=8080
DOMAIN=$DOMAIN
EOF
fi
# shellcheck disable=SC1090
. "$ENV"

say "Включаю автозапуск"
id rcgd >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin rcgd
chown -R rcgd:rcgd "$DIR"
cat > /etc/systemd/system/rcgd-stream.service <<EOF
[Unit]
Description=RCGDTUBE stream (видео из Telegram для сайта)
After=network-online.target
Wants=network-online.target

[Service]
User=rcgd
WorkingDirectory=$DIR
EnvironmentFile=$ENV
ExecStart=$DIR/venv/bin/python $DIR/app.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now rcgd-stream >/dev/null 2>&1
systemctl restart rcgd-stream

say "Настраиваю HTTPS для $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  reverse_proxy 127.0.0.1:$PORT {
    flush_interval -1
  }
}
EOF
command -v ufw >/dev/null && ufw status | grep -q active && { ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; }
systemctl reload caddy || systemctl restart caddy

sleep 4
say "Готово!"
echo "  Адрес сервера:      https://$DOMAIN"
echo "  Вход в Telegram:    https://$DOMAIN/setup?key=$SETUP_KEY"
echo "  (открой ссылку, отсканируй QR-код в Telegram: Настройки → Устройства → Подключить устройство)"
echo
echo "  Проверка: curl -s https://$DOMAIN/   → должно быть \"ok\": true"
echo "  Журнал:   journalctl -u rcgd-stream -f"
