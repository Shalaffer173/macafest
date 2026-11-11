#!/usr/bin/env bash
# Автозапуск бота на своём компьютере (Linux с systemd): npm run autostart
# Создаёт пользовательскую службу, которая при входе в систему запускает
# «npm run tunnel» и перезапускает его при сбое. Убрать: npm run autostart -- remove
set -euo pipefail

NAME=homework-bot
DIR="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/$NAME.service"

if [ "${1:-}" = "remove" ]; then
  systemctl --user disable --now "$NAME" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "Автозапуск убран."
  exit 0
fi

[ -f "$DIR/.env" ] || { echo "Нет файла .env в $DIR — сначала настрой бота."; exit 1; }
NODE="$(command -v node)"

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Домашка: Telegram-бот со списком заданий
After=network-online.target

[Service]
WorkingDirectory=$DIR
ExecStart=$NODE src/dev-tunnel.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT_EOF

if [ "${DRY_RUN:-}" = "1" ]; then cat "$UNIT"; exit 0; fi

systemctl --user daemon-reload
systemctl --user enable --now "$NAME"
echo "Готово: бот запущен и будет стартовать сам после входа в систему."
echo "Состояние:  systemctl --user status $NAME"
echo "Журнал:     journalctl --user -u $NAME -f"
echo "Остановить: systemctl --user stop $NAME"
