#!/usr/bin/env python3
"""
ZoomWar for the Zoom desktop client on Linux.

Same two features as the browser extension:
  * hand raise on a loop  - sends Zoom's Alt+Y shortcut to the meeting window
  * self-rename on a loop - drives the Participants panel through the
    accessibility bus (AT-SPI): your row -> More -> Rename -> type -> confirm.
    Names are your own list (in order) or copied from the meeting (random).

Needs: python3-tk, python3-gi, gir1.2-atspi-2.0, at-spi2-core, xdotool
(install.sh sets these up). Zoom must be started with accessibility on;
the "Запустить Zoom" button does that.
"""

import os
import random
import re
import shutil
import subprocess
import threading
import time
import tkinter as tk
from tkinter import messagebox

try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
    ATSPI_OK = True
except Exception:  # missing gir1.2-atspi-2.0 / python3-gi
    Atspi = None
    ATSPI_OK = False

XDOTOOL = shutil.which("xdotool")
APP_TITLE = "ZoomWar"

# One AT-SPI user at a time: the name loop, the dump and the check all walk
# the same accessibility tree from worker threads.
ATSPI_LOCK = threading.Lock()


# ==================== xdotool ====================
def xdo(*args, timeout=3):
    if not XDOTOOL:
        return False, "xdotool не установлен"
    try:
        r = subprocess.run([XDOTOOL, *map(str, args)], capture_output=True,
                           text=True, timeout=timeout)
        return r.returncode == 0, (r.stdout or r.stderr).strip()
    except Exception as e:
        return False, str(e)


MEETING_RE = re.compile(r"meeting|конферен|встреч|зустріч", re.I)


def find_meeting_window():
    """The Zoom meeting window: prefer one titled like a meeting."""
    ok, out = xdo("search", "--onlyvisible", "--class", "zoom")
    if not ok or not out:
        return None, ""
    fallback = None
    for wid in out.split():
        _, name = xdo("getwindowname", wid)
        if name == APP_TITLE:
            continue
        if MEETING_RE.search(name):
            return wid, name
        if fallback is None:
            fallback = (wid, name)
    return fallback or (None, "")


def press_alt_y(wid):
    """Zoom's raise/lower-hand shortcut, delivered to the meeting window."""
    ok, active = xdo("getactivewindow")
    if not (ok and active == wid):
        if not xdo("windowactivate", "--sync", wid, timeout=2)[0]:
            # No --sync: on a window that already has focus it would wait
            # for a focus event that never arrives.
            xdo("windowfocus", wid)
            time.sleep(0.05)
    return xdo("key", "--clearmodifiers", "alt+y")[0]


# ==================== AT-SPI helpers ====================
def a_name(n):
    try:
        return n.get_name() or ""
    except Exception:
        return ""


def a_role(n):
    try:
        return n.get_role_name() or ""
    except Exception:
        return ""


def a_parent(n):
    try:
        return n.get_parent()
    except Exception:
        return None


def a_children(n):
    try:
        count = n.get_child_count()
    except Exception:
        return []
    out = []
    for i in range(count):
        try:
            ch = n.get_child_at_index(i)
        except Exception:
            ch = None
        if ch is not None:
            out.append(ch)
    return out


def walk(root, max_nodes=20000, max_depth=60):
    stack = [(root, 0)]
    seen = 0
    while stack and seen < max_nodes:
        node, depth = stack.pop()
        seen += 1
        yield node, depth
        if depth < max_depth:
            for ch in reversed(a_children(node)):
                stack.append((ch, depth + 1))


def showing(n):
    try:
        return n.get_state_set().contains(Atspi.StateType.SHOWING)
    except Exception:
        return True


def editable(n):
    try:
        return n.get_state_set().contains(Atspi.StateType.EDITABLE)
    except Exception:
        return False


def actions(n):
    try:
        a = n.get_action_iface()
        if not a:
            return []
        return [a.get_action_name(i) for i in range(a.get_n_actions())]
    except Exception:
        return []


def extents(n):
    try:
        c = n.get_component_iface()
        if not c:
            return None
        e = c.get_extents(Atspi.CoordType.SCREEN)
        return (e.x, e.y, e.width, e.height)
    except Exception:
        return None


def text_of(n):
    # Call the Text interface explicitly: on the Accessible object, get_text
    # resolves to a different method and always failed, returning "".
    try:
        if n.get_text_iface() is None:
            return ""
        return Atspi.Text.get_text(n, 0, Atspi.Text.get_character_count(n)) or ""
    except Exception:
        return ""


def click_center(n):
    ext = extents(n)
    if not ext or ext[2] <= 0 or ext[3] <= 0:
        return False
    x, y = ext[0] + ext[2] // 2, ext[1] + ext[3] // 2
    ok = xdo("mousemove", x, y)[0]
    time.sleep(0.05)
    return ok and xdo("click", "1")[0]


def hover(n):
    ext = extents(n)
    if ext and ext[2] > 0 and ext[3] > 0:
        # No --sync: it waits for a motion event, and when the pointer is
        # already on the spot (every pass after the first) none ever comes,
        # so it hung for the full 3 s timeout.
        xdo("mousemove", ext[0] + ext[2] // 2, ext[1] + ext[3] // 2)


def activate(n):
    """Press a control: its first accessible action, else a real click."""
    try:
        a = n.get_action_iface()
        if a and a.get_n_actions() > 0 and a.do_action(0):
            return True
    except Exception:
        pass
    return click_center(n)


def zoom_apps():
    try:
        desk = Atspi.get_desktop(0)
    except Exception:
        return []
    return [app for app in a_children(desk)
            if "zoom" in a_name(app).lower() and APP_TITLE.lower() not in a_name(app).lower()]


def find_first(pred, roots=None, max_nodes=20000):
    for root in (roots if roots is not None else zoom_apps()):
        for n, _ in walk(root, max_nodes=max_nodes):
            if pred(n):
                return n
    return None


def wait_for(fn, timeout, step=0.15):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v is not None:
            return v
        time.sleep(step)
    return None


# ==================== rename via AT-SPI ====================
SELF_RE = re.compile(r"\((?:[^)]*[,\s])?(?:me|я|ви|вы)\s*\)", re.I)
TAG_RE = re.compile(r"\s*\([^)]*\)\s*$")
ROW_ROLES = {"list item", "table cell", "tree item", "table row"}
BUTTON_ROLES = {"push button", "toggle button", "menu button", "button"}
TEXT_ROLES = {"text", "entry", "editbar", "paragraph"}
WINDOW_ROLES = {"dialog", "frame", "window", "alert", "file chooser"}
MORE_WORDS = ("more", "ещё", "еще", "больше", "подробнее", "більше", "ще")
RENAME_WORDS = ("rename", "переименовать", "перейменувати", "изменить имя", "змінити ім")
CONFIRM_WORDS = ("rename", "save", "change", "ok", "переименовать", "сохранить",
                 "изменить", "ок", "перейменувати", "зберегти", "змінити")
CANCEL_WORDS = ("cancel", "отмена", "скасувати")


def bare_name(label):
    return TAG_RE.sub("", label).strip()


def starts_with_any(text, words):
    t = text.strip().lower()
    return bool(t) and any(t == w or t.startswith(w) for w in words)


def row_label(row):
    """A participant row's text: its own name, else the first named
    descendant (rows are often unnamed containers around a label)."""
    nm = a_name(row)
    if nm:
        return nm
    for n, _ in walk(row, max_nodes=80, max_depth=4):
        if n is not row and a_role(n) not in BUTTON_ROLES and a_name(n):
            return a_name(n)
    return ""


def find_self_row():
    """Your entry in the participants list, tagged (Me)/(Я)/(Хост, я)."""
    label = None
    for app in zoom_apps():
        for n, _ in walk(app):
            nm = a_name(n)
            if nm and len(nm) < 120 and SELF_RE.search(nm) and showing(n):
                if a_role(n) in ROW_ROLES:
                    return n
                if label is None:
                    label = n
    if label is None:
        return None
    # A bare label: climb to the row that holds it.
    p = a_parent(label)
    for _ in range(4):
        if p is None:
            break
        if a_role(p) in ROW_ROLES:
            return p
        p = a_parent(p)
    return a_parent(label) or label


def find_more_button(row):
    scopes = [row]
    parent = a_parent(row)
    if parent is not None:
        scopes.append(parent)
    for scope in scopes:
        for n, _ in walk(scope, max_nodes=600, max_depth=6):
            if a_role(n) in BUTTON_ROLES and showing(n):
                nm = a_name(n).lower()
                if any(w in nm for w in MORE_WORDS):
                    return n
    return None


def find_rename_item():
    return find_first(lambda n: showing(n) and
                      a_role(n) in {"menu item", "push button", "label", "list item"} and
                      starts_with_any(a_name(n), RENAME_WORDS))


def window_of(n):
    p = n
    for _ in range(30):
        if p is None:
            return None
        if a_role(p) in WINDOW_ROLES:
            return p
        p = a_parent(p)
    return None


def find_rename_input(current):
    """The dialog's name field. Never a bare editable: that could be chat.

    Accept it when its window is titled like a rename dialog, or when it is
    prefilled with your current name (which the rename dialog always is).
    """
    def ok(n):
        if a_role(n) not in TEXT_ROLES or not showing(n) or not editable(n):
            return False
        win = window_of(n)
        if win is not None and any(w in a_name(win).lower() for w in RENAME_WORDS):
            return True
        return bool(current) and text_of(n).strip() == current
    return find_first(ok)


def set_text(n, value):
    try:
        if (n.get_editable_text_iface() is not None and
                Atspi.EditableText.set_text_contents(n, value) and
                text_of(n) == value):
            return True
    except Exception:
        pass
    # Keyboard fallback: focus the field, select all, type.
    try:
        c = n.get_component_iface()
        if c:
            c.grab_focus()
    except Exception:
        pass
    if not click_center(n):
        return False
    xdo("key", "--clearmodifiers", "ctrl+a")
    xdo("type", "--delay", "8", "--", value, timeout=10)
    return True


def press_in(root, words):
    if root is None:
        return False
    btn = find_first(lambda n: a_role(n) in BUTTON_ROLES and showing(n) and
                     starts_with_any(a_name(n), words), roots=[root], max_nodes=2000)
    return bool(btn) and activate(btn)


def scrape_participants():
    row = find_self_row()
    if row is None:
        return []
    names = []
    parent = a_parent(row)
    for sib in a_children(parent) if parent is not None else []:
        nm = row_label(sib)
        if nm and not SELF_RE.search(nm):
            name = bare_name(nm)
            if 1 < len(name) < 50:
                names.append(name)
    return list(dict.fromkeys(names))


def rename_me(new_name, still_on, log):
    """One rename pass. Returns True when the new name was confirmed."""
    row = find_self_row()
    if row is None:
        log("не нашёл себя в списке участников — открой панель «Участники»")
        return False
    current = bare_name(row_label(row))

    item = find_rename_item()
    if item is None:
        hover(row)
        time.sleep(0.35)
        more = find_more_button(row)
        if more is None:
            log("нет кнопки «More» у твоей строки — сделай дамп")
            return False
        activate(more)
        item = wait_for(find_rename_item, 1.5)
    if item is None:
        xdo("key", "Escape")
        log("в меню нет «Переименовать» — сделай дамп с открытым меню")
        return False
    activate(item)

    field = wait_for(lambda: find_rename_input(current), 2.5)
    if field is None:
        log("окно переименования не нашлось — сделай дамп с открытым окном")
        return False
    dialog = window_of(field)
    if not still_on():
        press_in(dialog, CANCEL_WORDS) or xdo("key", "Escape")
        return False
    # Verify before confirming: a stray focus change mid-typing once left
    # just the first letter in the field, which must never be saved.
    for _ in range(2):
        set_text(field, new_name)
        time.sleep(0.15)
        if text_of(field) == new_name:
            break
    else:
        press_in(dialog, CANCEL_WORDS) or xdo("key", "Escape")
        log("имя вписалось криво — отменил, попробую на следующем круге")
        return False
    if not press_in(dialog, CONFIRM_WORDS):
        xdo("key", "Return")
    log("ник → " + new_name)
    return True


def dump_tree(path):
    lines = []
    apps = zoom_apps()
    if not apps:
        lines.append("Zoom не найден в accessibility. Запусти его кнопкой «Запустить Zoom».")
    for app in apps:
        for n, d in walk(app, max_nodes=40000):
            parts = [f"{'  ' * d}[{a_role(n)}] {a_name(n)!r}"]
            if a_role(n) in TEXT_ROLES:
                parts.append(f"text={text_of(n)[:60]!r}")
            acts = actions(n)
            if acts:
                parts.append(f"actions={acts}")
            ext = extents(n)
            if ext:
                parts.append(f"@{ext}")
            if not showing(n):
                parts.append("(hidden)")
            lines.append(" ".join(parts))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return len(lines)


# ==================== launching Zoom with accessibility ====================
def enable_a11y_bus():
    """Ask the desktop to turn accessibility on so Qt apps expose their UI."""
    if shutil.which("gsettings"):
        subprocess.run(["gsettings", "set", "org.gnome.desktop.interface",
                        "toolkit-accessibility", "true"], capture_output=True)
    if shutil.which("dbus-send"):
        subprocess.run(["dbus-send", "--session", "--dest=org.a11y.Bus",
                        "--print-reply", "/org/a11y/bus",
                        "org.freedesktop.DBus.Properties.Set",
                        "string:org.a11y.Status", "string:IsEnabled",
                        "variant:boolean:true"], capture_output=True)


def zoom_running():
    return subprocess.run(["pgrep", "-x", "zoom"], capture_output=True).returncode == 0


def launch_zoom():
    env = dict(os.environ, QT_LINUX_ACCESSIBILITY_ALWAYS_ON="1", QT_ACCESSIBILITY="1")
    if shutil.which("zoom"):
        cmd = ["zoom"]
    elif os.path.exists("/opt/zoom/ZoomLauncher"):
        cmd = ["/opt/zoom/ZoomLauncher"]
    elif shutil.which("flatpak") and subprocess.run(
            ["flatpak", "info", "us.zoom.Zoom"], capture_output=True).returncode == 0:
        cmd = ["flatpak", "run", "--env=QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1",
               "--env=QT_ACCESSIBILITY=1", "us.zoom.Zoom"]
    elif shutil.which("snap") and os.path.exists("/snap/bin/zoom-client"):
        cmd = ["/snap/bin/zoom-client"]
    else:
        return "Не нашёл Zoom (zoom / /opt/zoom / flatpak us.zoom.Zoom / snap zoom-client)"
    subprocess.Popen(cmd, env=env, start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return None


# ==================== UI ====================
BG = "#09090b"
TILE = "#141418"
TILE_HI = "#1d1d23"
FIELD = "#0e0e11"
EDGE = "#2b2b34"
FG = "#ececf1"
MUTED = "#75757f"
ACCENT = "#ff2d55"
OK = "#2ee06a"
DANGER = "#ff4d4d"
FONT = "DejaVu Sans"


def tile(parent, title):
    outer = tk.Frame(parent, bg=EDGE)
    body = tk.Frame(outer, bg=TILE, padx=11, pady=10)
    body.pack(fill=tk.BOTH, expand=True, padx=1, pady=1)
    tk.Label(body, text=title, bg=TILE, fg=MUTED,
             font=(FONT, 8, "bold")).pack(anchor=tk.W, pady=(0, 6))
    outer.body = body
    return outer


def btn(parent, text, cmd, color):
    return tk.Button(parent, text=text, command=cmd, bg=TILE_HI, fg=color,
                     activebackground=EDGE, activeforeground=color,
                     disabledforeground=MUTED, relief=tk.FLAT, bd=0,
                     highlightthickness=1, highlightbackground=EDGE,
                     font=(FONT, 9, "bold"), padx=10, pady=5, cursor="hand2")


def entry(parent, value, width=6):
    e = tk.Entry(parent, width=width, bg=FIELD, fg=FG, insertbackground=ACCENT,
                 relief=tk.FLAT, highlightthickness=1, highlightbackground=EDGE,
                 highlightcolor=ACCENT, font=(FONT, 10))
    e.insert(0, value)
    return e


def cooldown(entry_widget, default, minimum):
    try:
        return max(minimum, float(entry_widget.get().replace(",", ".")))
    except ValueError:
        return default


class ZoomWarLinux:
    def __init__(self, root):
        self.root = root
        root.title(APP_TITLE)
        root.configure(bg=BG)
        root.geometry("360x690")
        root.minsize(340, 640)

        self.hand_on = False
        self.name_on = False
        # Set while a rename is in progress: the hand loop pulls focus to the
        # meeting window and presses keys, which would hijack the rename dialog.
        self.renaming = threading.Event()

        head = tk.Frame(root, bg=BG)
        head.pack(pady=(12, 10))
        tk.Label(head, text="ZOOM", bg=BG, fg=FG, font=(FONT, 18, "bold")).pack(side=tk.LEFT)
        tk.Label(head, text="WAR", bg=BG, fg=ACCENT, font=(FONT, 18, "bold")).pack(side=tk.LEFT)

        wrap = tk.Frame(root, bg=BG, padx=12)
        wrap.pack(fill=tk.BOTH, expand=True)

        # Hand
        hand = tile(wrap, "✋ РУКА")
        hand.pack(fill=tk.X, pady=(0, 9))
        r = tk.Frame(hand.body, bg=TILE)
        r.pack(anchor=tk.W)
        tk.Label(r, text="Кулдаун (сек)", bg=TILE, fg=MUTED, font=(FONT, 9)).pack(side=tk.LEFT)
        self.hand_cd = entry(r, "0.4")
        self.hand_cd.pack(side=tk.LEFT, padx=6)
        self.hand_status = tk.Label(hand.body, text="ВЫКЛ", bg=TILE, fg=MUTED,
                                    font=(FONT, 10, "bold"))
        self.hand_status.pack(pady=(7, 5))
        b = tk.Frame(hand.body, bg=TILE)
        b.pack(fill=tk.X)
        self.hand_start = btn(b, "START", self.start_hand, OK)
        self.hand_start.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(0, 3))
        self.hand_stop = btn(b, "STOP", self.stop_hand, DANGER)
        self.hand_stop.config(state=tk.DISABLED)
        self.hand_stop.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(3, 0))

        # Name
        name = tile(wrap, "👤 НИК")
        name.pack(fill=tk.X, pady=(0, 9))
        self.mode = tk.StringVar(value="manual")
        m = tk.Frame(name.body, bg=TILE)
        m.pack(anchor=tk.W, pady=(0, 5))
        for text, val in (("Свои имена", "manual"), ("Из конференции", "auto")):
            tk.Radiobutton(m, text=text, variable=self.mode, value=val, bg=TILE, fg=FG,
                           selectcolor=FIELD, activebackground=TILE, activeforeground=ACCENT,
                           highlightthickness=0, bd=0, font=(FONT, 9)).pack(side=tk.LEFT, padx=(0, 12))
        self.names = tk.Text(name.body, height=4, bg=FIELD, fg=FG, insertbackground=ACCENT,
                             relief=tk.FLAT, highlightthickness=1, highlightbackground=EDGE,
                             highlightcolor=ACCENT, font=(FONT, 9), wrap=tk.WORD)
        self.names.insert("1.0", "Иван Петров\nМария Сидорова\nАлексей Козлов")
        self.names.pack(fill=tk.X)
        tk.Label(name.body, text="по одному на строку — пойдут по порядку", bg=TILE, fg=MUTED,
                 font=(FONT, 8)).pack(anchor=tk.W, pady=(2, 0))
        r = tk.Frame(name.body, bg=TILE)
        r.pack(anchor=tk.W, pady=(6, 0))
        tk.Label(r, text="Кулдаун (сек)", bg=TILE, fg=MUTED, font=(FONT, 9)).pack(side=tk.LEFT)
        self.name_cd = entry(r, "2.0")
        self.name_cd.pack(side=tk.LEFT, padx=6)
        self.name_status = tk.Label(name.body, text="ВЫКЛ", bg=TILE, fg=MUTED,
                                    font=(FONT, 10, "bold"))
        self.name_status.pack(pady=(7, 5))
        b = tk.Frame(name.body, bg=TILE)
        b.pack(fill=tk.X)
        self.name_start = btn(b, "START", self.start_name, OK)
        self.name_start.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(0, 3))
        self.name_stop = btn(b, "STOP", self.stop_name, DANGER)
        self.name_stop.config(state=tk.DISABLED)
        self.name_stop.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(3, 0))

        # Setup
        setup = tile(wrap, "⚙ НАСТРОЙКА")
        setup.pack(fill=tk.X)
        b = tk.Frame(setup.body, bg=TILE)
        b.pack(fill=tk.X)
        btn(b, "Проверить", self.check, FG).pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(0, 3))
        btn(b, "Дамп Zoom", self.dump, FG).pack(side=tk.LEFT, expand=True, fill=tk.X, padx=(3, 0))
        btn(setup.body, "Запустить Zoom (с доступностью)", self.launch, ACCENT).pack(fill=tk.X, pady=(6, 0))

        self.log_var = tk.StringVar(value="Зайди в конференцию в программе Zoom")
        tk.Label(root, textvariable=self.log_var, bg=BG, fg=MUTED, font=(FONT, 8),
                 wraplength=330, justify=tk.LEFT).pack(fill=tk.X, padx=12, pady=(8, 10))

        root.protocol("WM_DELETE_WINDOW", self.close)

    def log(self, msg):
        print("[ZoomWar]", msg, flush=True)
        self.root.after(0, lambda: self.log_var.set(msg))

    # ---- hand ----
    def start_hand(self):
        if not XDOTOOL:
            messagebox.showerror(APP_TITLE, "Нужен xdotool:\nsudo apt install xdotool")
            return
        cd = cooldown(self.hand_cd, 0.4, 0.1)
        self.hand_on = True
        self.hand_start.config(state=tk.DISABLED)
        self.hand_stop.config(state=tk.NORMAL)
        self.hand_status.config(text="СПАМИМ ✋", fg=OK)
        threading.Thread(target=self._hand_loop, args=(cd,), daemon=True).start()

    def stop_hand(self):
        self.hand_on = False
        self.hand_start.config(state=tk.NORMAL)
        self.hand_stop.config(state=tk.DISABLED)
        self.hand_status.config(text="ВЫКЛ", fg=MUTED)

    def _hand_loop(self, cd):
        warned = False
        while self.hand_on:
            started = time.time()
            if self.renaming.is_set():
                time.sleep(0.1)
                continue
            wid, _ = find_meeting_window()
            if wid:
                press_alt_y(wid)
                warned = False
            elif not warned:
                self.log("окно конференции Zoom не найдено")
                warned = True
            time.sleep(max(0.0, cd - (time.time() - started)))

    # ---- name ----
    def start_name(self):
        if not ATSPI_OK:
            messagebox.showerror(APP_TITLE, "Нужен AT-SPI:\nsudo apt install python3-gi gir1.2-atspi-2.0")
            return
        mode = self.mode.get()
        names = [n.strip() for n in self.names.get("1.0", tk.END).splitlines() if n.strip()]
        if mode == "manual" and not names:
            messagebox.showwarning(APP_TITLE, "Впиши хотя бы одно имя")
            return
        cd = cooldown(self.name_cd, 2.0, 0.5)
        self.name_on = True
        self.name_start.config(state=tk.DISABLED)
        self.name_stop.config(state=tk.NORMAL)
        self.name_status.config(text="МЕНЯЕМ ИМЯ", fg=OK)
        threading.Thread(target=self._name_loop, args=(mode, names, cd), daemon=True).start()

    def stop_name(self):
        self.name_on = False
        self.name_start.config(state=tk.NORMAL)
        self.name_stop.config(state=tk.DISABLED)
        self.name_status.config(text="ВЫКЛ", fg=MUTED)

    def _name_loop(self, mode, names, cd):
        nxt = 0
        while self.name_on:
            started = time.time()
            with ATSPI_LOCK:
                self.renaming.set()
                try:
                    if mode == "auto":
                        pool = scrape_participants()
                        if pool:
                            rename_me(random.choice(pool), lambda: self.name_on, self.log)
                        else:
                            self.log("не вижу других участников — открой панель «Участники»")
                    elif rename_me(names[nxt % len(names)], lambda: self.name_on, self.log):
                        nxt = (nxt + 1) % len(names)
                except Exception as e:
                    self.log(f"ошибка: {e}")
                finally:
                    self.renaming.clear()
            time.sleep(max(0.0, cd - (time.time() - started)))

    # ---- setup ----
    def check(self):
        threading.Thread(target=self._check, daemon=True).start()

    def _check(self):
        lines = [f"Сессия: {os.environ.get('XDG_SESSION_TYPE', '?')}",
                 f"xdotool: {'да' if XDOTOOL else 'НЕТ'}",
                 f"AT-SPI: {'да' if ATSPI_OK else 'НЕТ'}"]
        wid, title = find_meeting_window() if XDOTOOL else (None, "")
        lines.append(f"Окно конференции: {title or 'не найдено'}")
        if ATSPI_OK:
            with ATSPI_LOCK:
                apps = zoom_apps()
                count = sum(1 for app in apps for _ in walk(app, max_nodes=40000))
                me = find_self_row() if apps else None
            lines.append(f"Zoom в accessibility: {'да, узлов ' + str(count) if apps else 'НЕТ'}")
            lines.append(f"Себя в участниках: {row_label(me) if me else 'не вижу'}")
        msg = "\n".join(lines)
        print(msg, flush=True)
        self.root.after(0, lambda: messagebox.showinfo(APP_TITLE, msg))

    def dump(self):
        if not ATSPI_OK:
            messagebox.showerror(APP_TITLE, "Нужен AT-SPI:\nsudo apt install python3-gi gir1.2-atspi-2.0")
            return
        path = os.path.expanduser("~/zoomwar-dump.txt")

        def work():
            with ATSPI_LOCK:
                n = dump_tree(path)
            self.log(f"дамп: {path} ({n} строк)")
        threading.Thread(target=work, daemon=True).start()

    def launch(self):
        if zoom_running():
            messagebox.showwarning(APP_TITLE, "Zoom уже запущен.\nЗакрой его полностью "
                                   "(и из трея), потом нажми ещё раз.")
            return
        enable_a11y_bus()
        err = launch_zoom()
        self.log(err or "Zoom запускается с доступностью")

    def close(self):
        self.hand_on = False
        self.name_on = False
        self.root.destroy()


def main():
    root = tk.Tk(className="warpanel")
    ZoomWarLinux(root)
    root.mainloop()


if __name__ == "__main__":
    main()
