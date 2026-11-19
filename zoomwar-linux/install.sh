#!/usr/bin/env bash
# Installs what ZoomWar for Linux needs, turns desktop accessibility on and
# adds a ZoomWar entry to the applications menu.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "== Зависимости =="
if command -v apt-get >/dev/null; then
  $SUDO apt-get install -y python3-tk python3-gi gir1.2-atspi-2.0 at-spi2-core xdotool
elif command -v dnf >/dev/null; then
  $SUDO dnf install -y python3-tkinter python3-gobject at-spi2-core xdotool
elif command -v pacman >/dev/null; then
  $SUDO pacman -S --needed --noconfirm tk python-gobject at-spi2-core xdotool
else
  echo "Поставь вручную: python3-tk, python3-gi (PyGObject), at-spi2-core, xdotool"
fi

echo "== Доступность (accessibility) =="
# Qt apps such as Zoom only expose their UI over AT-SPI when this is on.
gsettings set org.gnome.desktop.interface toolkit-accessibility true 2>/dev/null \
  && echo "включена" || echo "gsettings нет — не GNOME, пропускаю"

echo "== Ярлык в меню =="
chmod +x "$DIR/zoomwar_linux.py"
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/zoomwar.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=ZoomWar
Comment=Рука и смена ника в Zoom
Exec=python3 "$DIR/zoomwar_linux.py"
Terminal=false
Categories=Utility;
EOF
echo "готово: ZoomWar в меню приложений, или запускай: python3 \"$DIR/zoomwar_linux.py\""
