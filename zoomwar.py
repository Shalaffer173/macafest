"""
ZoomWar
-------
Five tabs:
1) Hand Raise Spam  - configurable cooldown
2) Name Changer     - manual list or auto-scrape
3) Chat Spam        - send a message to Zoom chat on a cooldown
4) Cleanup          - clear cookies + toggle Urban VPN
5) Soundpad         - embeds the installed Soundpad and drives it

Requirements:
    pip install pyautogui selenium webdriver-manager

The Soundpad tab needs Soundpad installed, with "Allow remote control"
enabled under Settings -> Remote control. Routing its output into Zoom
is set up inside Soundpad itself.
"""

import os
import random
import subprocess
import sys
import threading
import time
import tkinter as tk
import xml.etree.ElementTree as ET
from tkinter import ttk, messagebox, scrolledtext, filedialog

try:
    import pyautogui
except ImportError:
    raise SystemExit("pip install pyautogui")

pyautogui.FAILSAFE = True

SELENIUM_AVAILABLE = False
try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    SELENIUM_AVAILABLE = True
except ImportError:
    pass

IS_WINDOWS = sys.platform == "win32"

if IS_WINDOWS:
    import ctypes
    from ctypes import wintypes
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

SOUNDPAD_PIPE = r"\\.\pipe\sp_remote_control"
SOUNDPAD_EXE_CANDIDATES = (
    r"C:\Program Files\Soundpad\Soundpad.exe",
    r"C:\Program Files (x86)\Soundpad\Soundpad.exe",
)

# ==================== THEME ====================
BG = "#09090b"
TILE = "#141418"
TILE_HI = "#1d1d23"
FIELD = "#0e0e11"
EDGE = "#2b2b34"
FG = "#ececf1"
MUTED = "#75757f"
ACCENT = "#ff2d55"
OK = "#2ee06a"
WARN = "#f5a524"
DANGER = "#ff4d4d"
INK = "#09090b"

FONT = "Segoe UI" if IS_WINDOWS else "DejaVu Sans"
MONO = "Consolas" if IS_WINDOWS else "DejaVu Sans Mono"


def apply_theme(root):
    root.configure(bg=BG)
    style = ttk.Style(root)
    style.theme_use("clam")

    style.configure("TNotebook", background=BG, borderwidth=0)
    style.configure("TNotebook.Tab", background=TILE, foreground=MUTED,
                    padding=(13, 8), borderwidth=0, font=(FONT, 9, "bold"))
    style.map("TNotebook.Tab",
              background=[("selected", TILE_HI)],
              foreground=[("selected", ACCENT)],
              expand=[("selected", (0, 0, 0, 0))])

    style.configure("TCombobox", fieldbackground=FIELD, background=TILE_HI,
                    foreground=FG, arrowcolor=ACCENT, bordercolor=EDGE,
                    lightcolor=EDGE, darkcolor=EDGE, borderwidth=1)
    style.map("TCombobox",
              fieldbackground=[("readonly", FIELD)],
              foreground=[("readonly", FG)],
              selectbackground=[("readonly", FIELD)],
              selectforeground=[("readonly", FG)])
    root.option_add("*TCombobox*Listbox.background", FIELD)
    root.option_add("*TCombobox*Listbox.foreground", FG)
    root.option_add("*TCombobox*Listbox.selectBackground", ACCENT)
    root.option_add("*TCombobox*Listbox.selectForeground", INK)

    style.configure("TSeparator", background=EDGE)


def tile(parent, title=None, pad=10):
    """A bordered dark card. Fill the returned widget's .body."""
    outer = tk.Frame(parent, bg=EDGE)
    body = tk.Frame(outer, bg=TILE, padx=pad, pady=pad)
    body.pack(fill=tk.BOTH, expand=True, padx=1, pady=1)
    if title:
        tk.Label(body, text=title.upper(), font=(FONT, 8, "bold"),
                 bg=TILE, fg=MUTED).pack(anchor=tk.W, pady=(0, 7))
    outer.body = body
    return outer


def row(parent, **pack_kw):
    frame = tk.Frame(parent, bg=parent["bg"])
    frame.pack(fill=tk.X, **pack_kw)
    return frame


def lbl(parent, text="", size=9, color=FG, bold=False, **kw):
    return tk.Label(parent, text=text, bg=parent["bg"], fg=color,
                    font=(FONT, size, "bold" if bold else "normal"), **kw)


def ent(parent, width=None, size=10, mono=False):
    entry = tk.Entry(parent, font=(MONO if mono else FONT, size), bg=FIELD, fg=FG,
                     insertbackground=ACCENT, relief=tk.FLAT, highlightthickness=1,
                     highlightbackground=EDGE, highlightcolor=ACCENT,
                     disabledbackground=FIELD, selectbackground=ACCENT,
                     selectforeground=INK)
    if width:
        entry.config(width=width)
    return entry


def check(parent, text, variable, color=FG):
    return tk.Checkbutton(parent, text=text, variable=variable, bg=parent["bg"],
                          fg=color, selectcolor=FIELD, activebackground=parent["bg"],
                          activeforeground=ACCENT, font=(FONT, 9), bd=0,
                          highlightthickness=0, anchor=tk.W, cursor="hand2")


def radio(parent, text, variable, value, command=None):
    return tk.Radiobutton(parent, text=text, variable=variable, value=value,
                          command=command, bg=parent["bg"], fg=FG, selectcolor=FIELD,
                          activebackground=parent["bg"], activeforeground=ACCENT,
                          font=(FONT, 9), bd=0, highlightthickness=0, cursor="hand2")


def btn(parent, text, command, color=ACCENT, filled=False, size=9, width=None):
    """Flat tile button: dark face with coloured text, or a filled slab."""
    widget = tk.Button(parent, text=text, command=command, relief=tk.FLAT, bd=0,
                       font=(FONT, size, "bold"), cursor="hand2",
                       highlightthickness=1, padx=12, pady=5,
                       disabledforeground=MUTED)
    if filled:
        widget.config(bg=color, fg=INK, activebackground=color, activeforeground=INK,
                      highlightbackground=color)
    else:
        widget.config(bg=TILE_HI, fg=color, activebackground=EDGE, activeforeground=color,
                      highlightbackground=EDGE)
    if width:
        widget.config(width=width)
    return widget


def text_area(parent, height=4, size=9):
    area = scrolledtext.ScrolledText(parent, height=height, font=(FONT, size), bg=FIELD,
                                     fg=FG, insertbackground=ACCENT, relief=tk.FLAT,
                                     highlightthickness=1, highlightbackground=EDGE,
                                     highlightcolor=ACCENT, selectbackground=ACCENT,
                                     selectforeground=INK, bd=0, wrap=tk.WORD)
    area.vbar.config(bg=TILE_HI, troughcolor=BG, activebackground=ACCENT, bd=0,
                     relief=tk.FLAT, highlightthickness=0, width=12)
    return area


def make_cooldown_row(parent, default="1.0"):
    frame = tk.Frame(parent, bg=parent["bg"])
    lbl(frame, "Кулдаун (сек)", color=MUTED).pack(side=tk.LEFT)
    entry = ent(frame, width=6)
    entry.pack(side=tk.LEFT, padx=6)
    entry.insert(0, default)
    return frame, entry


def make_status_and_buttons(parent, start_cmd, stop_cmd, start_text="START"):
    status_var = tk.StringVar(value="ВЫКЛ")
    status_label = tk.Label(parent, textvariable=status_var, font=(FONT, 11, "bold"),
                            bg=parent["bg"], fg=MUTED)
    status_label.pack(pady=(0, 7))

    btn_frame = tk.Frame(parent, bg=parent["bg"])
    btn_frame.pack()
    start_btn = btn(btn_frame, start_text, start_cmd, color=OK, width=16)
    start_btn.pack(side=tk.LEFT, padx=3)
    stop_btn = btn(btn_frame, "STOP", stop_cmd, color=DANGER, width=10)
    stop_btn.config(state=tk.DISABLED)
    stop_btn.pack(side=tk.LEFT, padx=3)
    return status_var, status_label, start_btn, stop_btn


class SoundpadRemote:
    """Talks to an installed Soundpad over its remote-control named pipe."""

    @staticmethod
    def send(command, want_response=True):
        with open(SOUNDPAD_PIPE, "r+b", 0) as pipe:
            pipe.write(command.encode("utf-8"))
            pipe.flush()
            if not want_response:
                return ""
            chunks = []
            for _ in range(64):
                chunk = pipe.read(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                if b"</Soundlist>" in b"".join(chunks) or len(chunk) < 65536:
                    break
            return b"".join(chunks).decode("utf-8", errors="ignore")

    @classmethod
    def is_alive(cls):
        try:
            cls.send("IsAlive()")
            return True
        except Exception:
            return False

    @classmethod
    def sound_list(cls):
        root = ET.fromstring(cls.send("GetSoundlist()").strip())
        sounds = []
        for node in root.iter("Sound"):
            index = node.get("index")
            if index:
                title = node.get("title") or os.path.basename(node.get("url") or "")
                sounds.append((int(index), title or f"sound {index}"))
        return sounds

    @classmethod
    def play(cls, index):
        cls.send(f"DoPlaySound({index})")

    @classmethod
    def play_random(cls):
        cls.send("DoPlayRandomSound()")

    @classmethod
    def stop(cls):
        cls.send("DoStopSound()")


class WindowEmbedder:
    """Reparents another process's top-level window into a Tk widget."""

    GWL_STYLE = -16
    WS_CHILD = 0x40000000
    WS_POPUP = 0x80000000
    WS_CAPTION = 0x00C00000
    WS_THICKFRAME = 0x00040000
    WS_SYSMENU = 0x00080000
    WS_MINIMIZEBOX = 0x00020000
    WS_MAXIMIZEBOX = 0x00010000
    SWP_FRAMECHANGED = 0x0020
    SWP_NOZORDER = 0x0004
    SWP_NOACTIVATE = 0x0010
    SW_SHOW = 5
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

    def __init__(self):
        self.hwnd = None
        self.original_style = None

    @staticmethod
    def _find_window_by_exe(exe_name):
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        target = exe_name.lower()
        found = []

        def callback(hwnd, _param):
            if not user32.IsWindowVisible(hwnd):
                return True
            if user32.GetWindowTextLengthW(hwnd) == 0:
                return True
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            handle = kernel32.OpenProcess(
                WindowEmbedder.PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
            if not handle:
                return True
            try:
                buf = ctypes.create_unicode_buffer(32768)
                size = wintypes.DWORD(len(buf))
                if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                    if os.path.basename(buf.value).lower() == target:
                        found.append(hwnd)
                        return False
            finally:
                kernel32.CloseHandle(handle)
            return True

        user32.EnumWindows(WNDENUMPROC(callback), 0)
        return found[0] if found else None

    def attach(self, container, exe_name="Soundpad.exe"):
        if not IS_WINDOWS:
            raise RuntimeError("Встраивание окна работает только на Windows")
        if self.hwnd:
            # Re-attaching would overwrite the saved style and leave the
            # window frameless after detach.
            self.resize(container.winfo_width(), container.winfo_height())
            return
        hwnd = self._find_window_by_exe(exe_name)
        if not hwnd:
            raise RuntimeError(f"Окно {exe_name} не найдено — запусти программу")

        user32 = ctypes.windll.user32
        self.original_style = user32.GetWindowLongW(hwnd, self.GWL_STYLE)
        stripped = self.original_style & ~(self.WS_CAPTION | self.WS_THICKFRAME |
                                           self.WS_POPUP | self.WS_SYSMENU |
                                           self.WS_MINIMIZEBOX | self.WS_MAXIMIZEBOX)
        user32.SetWindowLongW(hwnd, self.GWL_STYLE, stripped | self.WS_CHILD)
        user32.SetParent(hwnd, container.winfo_id())
        user32.ShowWindow(hwnd, self.SW_SHOW)
        self.hwnd = hwnd
        self.resize(container.winfo_width(), container.winfo_height())

    def resize(self, width, height):
        if not self.hwnd or width < 2 or height < 2:
            return
        ctypes.windll.user32.SetWindowPos(
            self.hwnd, 0, 0, 0, width, height,
            self.SWP_FRAMECHANGED | self.SWP_NOZORDER | self.SWP_NOACTIVATE)

    def detach(self):
        """Give the window back to its owner, restoring its original frame."""
        if not self.hwnd:
            return
        user32 = ctypes.windll.user32
        try:
            user32.SetParent(self.hwnd, 0)
            if self.original_style is not None:
                user32.SetWindowLongW(self.hwnd, self.GWL_STYLE, self.original_style)
            user32.SetWindowPos(self.hwnd, 0, 100, 100, 900, 650,
                                self.SWP_FRAMECHANGED | self.SWP_NOZORDER)
            user32.ShowWindow(self.hwnd, self.SW_SHOW)
        except Exception:
            pass
        self.hwnd = None
        self.original_style = None


class ZoomWar:
    def __init__(self, root):
        self.root = root
        self.root.title("ZoomWar")
        self.root.geometry("660x960")
        self.root.minsize(580, 760)
        apply_theme(self.root)

        self.hand_running = False
        self.name_running = False
        self.chat_running = False
        self.clean_running = False
        self.spad_running = False
        self.driver = None
        self.spad_list = []
        self.embedder = WindowEmbedder()

        header = tk.Frame(root, bg=BG)
        header.pack(pady=(12, 8))
        tk.Label(header, text="ZOOM", font=(FONT, 20, "bold"), bg=BG, fg=FG).pack(side=tk.LEFT)
        tk.Label(header, text="WAR", font=(FONT, 20, "bold"), bg=BG, fg=ACCENT).pack(side=tk.LEFT)

        notebook = ttk.Notebook(root)
        notebook.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 6))

        self._build_hand_tab(notebook)
        self._build_name_tab(notebook)
        self._build_chat_tab(notebook)
        self._build_clean_tab(notebook)
        self._build_soundpad_tab(notebook)

        full_frame = tk.Frame(root, bg=BG)
        full_frame.pack(fill=tk.X, padx=10)
        self.full_btn = btn(full_frame, "ЗАПУСТИТЬ ВСЁ РАЗОМ", self.start_all,
                            color=ACCENT, filled=True, size=12)
        self.full_btn.pack(fill=tk.X, ipady=5)
        self.full_stop_btn = btn(full_frame, "ОСТАНОВИТЬ ВСЁ", self.stop_all, color=DANGER)
        self.full_stop_btn.config(state=tk.DISABLED)
        self.full_stop_btn.pack(fill=tk.X, pady=(4, 0))

        info = tile(root, "Инструкция", pad=9)
        info.pack(fill=tk.X, padx=10, pady=10)
        tk.Label(info.body, bg=TILE, fg=MUTED, font=(FONT, 8), justify=tk.LEFT, text=(
            "Рука: фокус на Zoom, жми START. Ник/Чат/Очистка: запусти Chrome с флагом\n"
            "chrome.exe --remote-debugging-port=9222, зайди на app.zoom.us\n"
            "Soundpad: жми 'Втащить Soundpad внутрь' + включи в нём Remote control"
        )).pack(anchor=tk.W)

        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    def _new_tab(self, notebook, text):
        tab = tk.Frame(notebook, bg=BG, padx=10, pady=10)
        notebook.add(tab, text=text)
        return tab

    def _enable_strip(self, tab, variable):
        strip = tile(tab, pad=7)
        strip.pack(fill=tk.X, pady=(0, 8))
        check(strip.body, "Включить в «ЗАПУСТИТЬ ВСЁ РАЗОМ»", variable,
              color=ACCENT).pack(anchor=tk.W)

    # ==================== HAND TAB ====================
    def _build_hand_tab(self, notebook):
        tab = self._new_tab(notebook, " ✋ Рука ")

        self.hand_enabled = tk.BooleanVar(value=True)
        self._enable_strip(tab, self.hand_enabled)

        card = tile(tab, "Спам руки")
        card.pack(fill=tk.X, pady=(0, 8))
        lbl(card.body, "Жмёт Alt+Y по кругу. Фокус должен быть на окне Zoom.",
            color=MUTED).pack(anchor=tk.W, pady=(0, 8))
        self.hand_cd_frame, self.hand_cd_entry = make_cooldown_row(card.body, "0.2")
        self.hand_cd_frame.pack(anchor=tk.W)

        control = tile(tab, "Управление")
        control.pack(fill=tk.X)
        self.hand_status, self.hand_status_label, self.hand_start_btn, self.hand_stop_btn = \
            make_status_and_buttons(control.body, self.hand_start, self.hand_stop)

    def hand_start(self):
        try:
            cd = float(self.hand_cd_entry.get())
            if cd < 0.05:
                cd = 0.05
        except ValueError:
            cd = 0.2
        self.hand_running = True
        self.hand_status.set("СПАМИМ ✋")
        self.hand_status_label.config(fg=OK)
        self.hand_start_btn.config(state=tk.DISABLED)
        self.hand_stop_btn.config(state=tk.NORMAL)
        threading.Thread(target=self._hand_loop, args=(cd,), daemon=True).start()

    def hand_stop(self):
        self.hand_running = False
        self.hand_status.set("ВЫКЛ")
        self.hand_status_label.config(fg=MUTED)
        self.hand_start_btn.config(state=tk.NORMAL)
        self.hand_stop_btn.config(state=tk.DISABLED)

    def _hand_loop(self, cooldown):
        while self.hand_running:
            pyautogui.hotkey("alt", "y")
            time.sleep(cooldown)

    # ==================== NAME TAB ====================
    def _build_name_tab(self, notebook):
        tab = self._new_tab(notebook, " 👤 Ник ")

        self.name_enabled = tk.BooleanVar(value=True)
        self._enable_strip(tab, self.name_enabled)

        source = tile(tab, "Источник имён")
        source.pack(fill=tk.X, pady=(0, 8))

        self.name_mode = tk.StringVar(value="manual")
        mode_f = row(source.body, pady=(0, 6))
        radio(mode_f, "Ручной список", self.name_mode, "manual",
              self._toggle_name_mode).pack(side=tk.LEFT)
        radio(mode_f, "Авто (парсить участников)", self.name_mode, "auto",
              self._toggle_name_mode).pack(side=tk.LEFT, padx=10)

        self.manual_frame = tk.Frame(source.body, bg=TILE)
        self.manual_frame.pack(fill=tk.X)
        lbl(self.manual_frame, "Имена, по одному на строку",
            color=MUTED).pack(anchor=tk.W, pady=(0, 3))
        self.names_text = text_area(self.manual_frame, height=4)
        self.names_text.pack(fill=tk.X)
        self.names_text.insert(tk.END, "Иван Петров\nМария Сидорова\nАлексей Козлов")

        self.auto_frame = tk.Frame(source.body, bg=TILE)
        lbl(self.auto_frame, "Берёт имена прямо из списка участников Zoom",
            color=MUTED).pack(anchor=tk.W)
        self.participants_var = tk.StringVar(value="Участники: ещё не загружены")
        tk.Label(self.auto_frame, textvariable=self.participants_var, bg=TILE, fg=FG,
                 font=(FONT, 8), wraplength=540, justify=tk.LEFT).pack(anchor=tk.W, pady=3)

        conn = tile(tab, "Подключение")
        conn.pack(fill=tk.X, pady=(0, 8))
        conn_row = row(conn.body)
        lbl(conn_row, "Chrome Port", color=MUTED).pack(side=tk.LEFT)
        self.name_port = ent(conn_row, width=6, mono=True)
        self.name_port.pack(side=tk.LEFT, padx=6)
        self.name_port.insert(0, "9222")
        lbl(conn_row, "Кулдаун (сек)", color=MUTED).pack(side=tk.LEFT, padx=(16, 0))
        self.name_cd_entry = ent(conn_row, width=6)
        self.name_cd_entry.pack(side=tk.LEFT, padx=6)
        self.name_cd_entry.insert(0, "1.0")

        control = tile(tab, "Управление")
        control.pack(fill=tk.X)
        self.name_status, self.name_status_label, self.name_start_btn, self.name_stop_btn = \
            make_status_and_buttons(control.body, self.name_start, self.name_stop,
                                    "CONNECT & START")

    def _toggle_name_mode(self):
        if self.name_mode.get() == "manual":
            self.auto_frame.pack_forget()
            self.manual_frame.pack(fill=tk.X)
        else:
            self.manual_frame.pack_forget()
            self.auto_frame.pack(fill=tk.X)

    def name_start(self):
        if not SELENIUM_AVAILABLE:
            messagebox.showerror("Ошибка", "pip install selenium webdriver-manager")
            return
        if self.name_mode.get() == "manual":
            names = [n.strip() for n in self.names_text.get("1.0", tk.END).strip().split("\n") if n.strip()]
            if len(names) < 2:
                messagebox.showwarning("Мало имён", "Впиши хотя бы 2 имени")
                return
        else:
            names = None
        try:
            cd = float(self.name_cd_entry.get())
            if cd < 0.3:
                cd = 0.3
        except ValueError:
            cd = 1.0
        port = self.name_port.get().strip()
        self.name_start_btn.config(state=tk.DISABLED)
        self.name_status.set("ПОДКЛЮЧАЮСЬ...")
        self.name_status_label.config(fg=WARN)
        threading.Thread(target=self._name_loop, args=(names, port, cd), daemon=True).start()

    def _name_loop(self, manual_names, port, cooldown):
        try:
            self._ensure_driver(port)
            self.name_running = True
            self.root.after(0, lambda: self.name_status.set("МЕНЯЕМ ИМЕНА"))
            self.root.after(0, lambda: self.name_status_label.config(fg=OK))
            self.root.after(0, lambda: self.name_stop_btn.config(state=tk.NORMAL))

            while self.name_running:
                try:
                    if manual_names:
                        new_name = random.choice(manual_names)
                    else:
                        participants = self._scrape_participants()
                        count = len(participants)
                        self.root.after(0, lambda c=count, p=participants:
                                        self.participants_var.set(
                                            f"Участники ({c}): {', '.join(p[:5])}{'...' if c > 5 else ''}"))
                        if len(participants) < 2:
                            time.sleep(cooldown)
                            continue
                        new_name = random.choice(participants)
                    self._do_rename(new_name)
                except Exception:
                    pass
                time.sleep(cooldown)
        except Exception as e:
            self.root.after(0, lambda: messagebox.showerror("Ошибка", f"Chrome порт {port}:\n{e}"))
            self.root.after(0, lambda: self.name_start_btn.config(state=tk.NORMAL))
            self.root.after(0, lambda: self.name_status.set("ОШИБКА"))
            self.root.after(0, lambda: self.name_status_label.config(fg=DANGER))

    def name_stop(self):
        self.name_running = False
        self.name_status.set("ВЫКЛ")
        self.name_status_label.config(fg=MUTED)
        self.name_start_btn.config(state=tk.NORMAL)
        self.name_stop_btn.config(state=tk.DISABLED)

    # ==================== CHAT TAB ====================
    def _build_chat_tab(self, notebook):
        tab = self._new_tab(notebook, " 💬 Чат ")

        self.chat_enabled = tk.BooleanVar(value=True)
        self._enable_strip(tab, self.chat_enabled)

        msg = tile(tab, "Сообщение")
        msg.pack(fill=tk.X, pady=(0, 8))
        lbl(msg.body, "Этот текст полетит в чат конференции",
            color=MUTED).pack(anchor=tk.W, pady=(0, 3))
        self.chat_text = text_area(msg.body, height=4, size=10)
        self.chat_text.pack(fill=tk.X)
        self.chat_text.insert(tk.END, "ВНИМАНИЕ! ОБЪЯВЛЕНИЕ!")

        conn = tile(tab, "Подключение")
        conn.pack(fill=tk.X, pady=(0, 8))
        conn_row = row(conn.body)
        lbl(conn_row, "Chrome Port", color=MUTED).pack(side=tk.LEFT)
        self.chat_port = ent(conn_row, width=6, mono=True)
        self.chat_port.pack(side=tk.LEFT, padx=6)
        self.chat_port.insert(0, "9222")
        lbl(conn_row, "Кулдаун (сек)", color=MUTED).pack(side=tk.LEFT, padx=(16, 0))
        self.chat_cd_entry = ent(conn_row, width=6)
        self.chat_cd_entry.pack(side=tk.LEFT, padx=6)
        self.chat_cd_entry.insert(0, "2.0")

        control = tile(tab, "Управление")
        control.pack(fill=tk.X)
        self.chat_status, self.chat_status_label, self.chat_start_btn, self.chat_stop_btn = \
            make_status_and_buttons(control.body, self.chat_start, self.chat_stop,
                                    "CONNECT & START")

    def chat_start(self):
        if not SELENIUM_AVAILABLE:
            messagebox.showerror("Ошибка", "pip install selenium webdriver-manager")
            return
        text = self.chat_text.get("1.0", tk.END).strip()
        if not text:
            messagebox.showwarning("Пусто", "Впиши текст сообщения")
            return
        try:
            cd = float(self.chat_cd_entry.get())
            if cd < 0.5:
                cd = 0.5
        except ValueError:
            cd = 2.0
        port = self.chat_port.get().strip()
        self.chat_start_btn.config(state=tk.DISABLED)
        self.chat_status.set("ПОДКЛЮЧАЮСЬ...")
        self.chat_status_label.config(fg=WARN)
        threading.Thread(target=self._chat_loop, args=(text, port, cd), daemon=True).start()

    def _chat_loop(self, text, port, cooldown):
        try:
            self._ensure_driver(port)
            self.chat_running = True
            self.root.after(0, lambda: self.chat_status.set("СПАМИМ ЧАТ 💬"))
            self.root.after(0, lambda: self.chat_status_label.config(fg=OK))
            self.root.after(0, lambda: self.chat_stop_btn.config(state=tk.NORMAL))

            while self.chat_running:
                try:
                    self._send_chat_message(text)
                except Exception:
                    pass
                time.sleep(cooldown)
        except Exception as e:
            self.root.after(0, lambda: messagebox.showerror("Ошибка", f"Chrome порт {port}:\n{e}"))
            self.root.after(0, lambda: self.chat_start_btn.config(state=tk.NORMAL))
            self.root.after(0, lambda: self.chat_status.set("ОШИБКА"))
            self.root.after(0, lambda: self.chat_status_label.config(fg=DANGER))

    def _send_chat_message(self, text):
        d = self.driver
        wait = WebDriverWait(d, 3)

        try:
            chat_panels = d.find_elements(By.CSS_SELECTOR,
                '[class*="chat-container"], [class*="ChatContainer"], '
                '[aria-label*="Chat panel"], [aria-label*="chat panel"], '
                '[class*="chat-box"], [id*="chat"]')
            if not chat_panels:
                chat_btn = d.find_element(By.CSS_SELECTOR,
                    '[aria-label*="Chat"], [aria-label*="chat"], '
                    'button[data-testid="chat-button"], '
                    '[aria-label*="Чат"], [aria-label*="чат"]')
                chat_btn.click()
                time.sleep(0.5)
        except Exception:
            pass

        try:
            chat_input = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR,
                '[class*="chat-box"] textarea, [class*="chat-box"] [contenteditable="true"], '
                'textarea[placeholder*="message"], textarea[placeholder*="сообщение"], '
                '[contenteditable="true"][aria-label*="chat"], '
                '[contenteditable="true"][aria-label*="Chat"], '
                '[contenteditable="true"][aria-label*="message"], '
                'textarea[aria-label*="chat"], textarea[aria-label*="Chat"], '
                '[class*="ChatInput"] textarea, [class*="ChatInput"] [contenteditable], '
                '[data-testid*="chat-input"], [data-testid*="ChatInput"]'
            )))

            chat_input.click()
            time.sleep(0.1)

            if chat_input.tag_name.lower() == "textarea":
                chat_input.clear()
                chat_input.send_keys(text)
            else:
                chat_input.send_keys(Keys.CONTROL + "a")
                time.sleep(0.05)
                chat_input.send_keys(text)

            time.sleep(0.1)
            chat_input.send_keys(Keys.ENTER)
        except Exception:
            pass

    def chat_stop(self):
        self.chat_running = False
        self.chat_status.set("ВЫКЛ")
        self.chat_status_label.config(fg=MUTED)
        self.chat_start_btn.config(state=tk.NORMAL)
        self.chat_stop_btn.config(state=tk.DISABLED)

    # ==================== CLEAN TAB ====================
    def _build_clean_tab(self, notebook):
        tab = self._new_tab(notebook, " 🧹 Очистка ")

        self.clean_enabled = tk.BooleanVar(value=True)
        self._enable_strip(tab, self.clean_enabled)

        vpn = tile(tab, "Urban VPN")
        vpn.pack(fill=tk.X, pady=(0, 8))
        lbl(vpn.body, "Чистит куки и дёргает кнопку подключения в расширении",
            color=MUTED).pack(anchor=tk.W, pady=(0, 6))
        lbl(vpn.body, "ID расширения в Chrome", color=MUTED).pack(anchor=tk.W)
        self.vpn_ext_id = ent(vpn.body, size=9, mono=True)
        self.vpn_ext_id.pack(fill=tk.X, pady=3)
        self.vpn_ext_id.insert(0, "eppiocemhmnlbhjplcgkofciiegomcon")
        lbl(vpn.body, "chrome://extensions → ID расширения Urban VPN",
            size=8, color=MUTED).pack(anchor=tk.W)

        conn = tile(tab, "Подключение")
        conn.pack(fill=tk.X, pady=(0, 8))
        conn_row = row(conn.body)
        lbl(conn_row, "Chrome Port", color=MUTED).pack(side=tk.LEFT)
        self.clean_port = ent(conn_row, width=6, mono=True)
        self.clean_port.pack(side=tk.LEFT, padx=6)
        self.clean_port.insert(0, "9222")
        lbl(conn_row, "Кулдаун (сек)", color=MUTED).pack(side=tk.LEFT, padx=(16, 0))
        self.clean_cd_entry = ent(conn_row, width=6)
        self.clean_cd_entry.pack(side=tk.LEFT, padx=6)
        self.clean_cd_entry.insert(0, "30")

        control = tile(tab, "Управление")
        control.pack(fill=tk.X)
        self.clean_status, self.clean_status_label, self.clean_start_btn, self.clean_stop_btn = \
            make_status_and_buttons(control.body, self.clean_start, self.clean_stop,
                                    "CONNECT & START")
        self.clean_log_var = tk.StringVar(value="")
        tk.Label(control.body, textvariable=self.clean_log_var, bg=TILE, fg=MUTED,
                 font=(FONT, 8), wraplength=520, justify=tk.LEFT).pack(anchor=tk.W, pady=(8, 0))

    def clean_start(self):
        if not SELENIUM_AVAILABLE:
            messagebox.showerror("Ошибка", "pip install selenium webdriver-manager")
            return
        try:
            cd = float(self.clean_cd_entry.get())
            if cd < 5:
                cd = 5
        except ValueError:
            cd = 30
        port = self.clean_port.get().strip()
        ext_id = self.vpn_ext_id.get().strip()
        self.clean_start_btn.config(state=tk.DISABLED)
        self.clean_status.set("ПОДКЛЮЧАЮСЬ...")
        self.clean_status_label.config(fg=WARN)
        threading.Thread(target=self._clean_loop, args=(port, cd, ext_id), daemon=True).start()

    def _clean_loop(self, port, cooldown, ext_id):
        btn_selectors = [
            'button.connect-btn', 'button.disconnect-btn',
            '[class*="connect"]', '[class*="power"]',
            'button.main-button', '.on-off-btn',
            '#connectBtn', '#connect', '.connect',
            'button[class*="Connect"]', 'button[class*="Disconnect"]',
            '.vpn-button', '[class*="toggle"]',
        ]
        try:
            self._ensure_driver(port)
            self.clean_running = True
            self.root.after(0, lambda: self.clean_status.set("ЧИСТИМ + VPN"))
            self.root.after(0, lambda: self.clean_status_label.config(fg=OK))
            self.root.after(0, lambda: self.clean_stop_btn.config(state=tk.NORMAL))

            while self.clean_running:
                try:
                    self.driver.delete_all_cookies()
                    self.root.after(0, lambda: self.clean_log_var.set("Куки очищены"))
                except Exception as e:
                    self.root.after(0, lambda err=e: self.clean_log_var.set(f"Ошибка куки: {err}"))

                try:
                    self.driver.execute_script("window.localStorage.clear(); window.sessionStorage.clear();")
                except Exception:
                    pass

                try:
                    current_url = self.driver.current_url
                    self.driver.get(f"chrome-extension://{ext_id}/popup.html")
                    time.sleep(1.5)

                    clicked = False
                    for sel in btn_selectors:
                        try:
                            found = self.driver.find_element(By.CSS_SELECTOR, sel)
                            if found.is_displayed():
                                found.click()
                                clicked = True
                                self.root.after(0, lambda: self.clean_log_var.set(
                                    "VPN: нажал кнопку подключения"))
                                break
                        except Exception:
                            continue

                    if not clicked:
                        for b in self.driver.find_elements(By.TAG_NAME, "button"):
                            try:
                                if b.is_displayed() and b.size["height"] > 30:
                                    b.click()
                                    clicked = True
                                    self.root.after(0, lambda: self.clean_log_var.set(
                                        "VPN: нажал кнопку (fallback)"))
                                    break
                            except Exception:
                                continue

                    if not clicked:
                        self.root.after(0, lambda: self.clean_log_var.set(
                            "VPN: не нашёл кнопку подключения"))

                    time.sleep(2)

                    for sel in btn_selectors:
                        try:
                            found = self.driver.find_element(By.CSS_SELECTOR, sel)
                            if found.is_displayed():
                                found.click()
                                self.root.after(0, lambda: self.clean_log_var.set(
                                    "VPN: переподключение к новому серверу"))
                                break
                        except Exception:
                            continue

                    time.sleep(1)
                    self.driver.get(current_url)
                    time.sleep(1)
                except Exception as e:
                    self.root.after(0, lambda err=e: self.clean_log_var.set(f"VPN ошибка: {err}"))

                time.sleep(cooldown)
        except Exception as e:
            self.root.after(0, lambda: messagebox.showerror("Ошибка", f"Chrome порт {port}:\n{e}"))
            self.root.after(0, lambda: self.clean_start_btn.config(state=tk.NORMAL))
            self.root.after(0, lambda: self.clean_status.set("ОШИБКА"))
            self.root.after(0, lambda: self.clean_status_label.config(fg=DANGER))

    def clean_stop(self):
        self.clean_running = False
        self.clean_status.set("ВЫКЛ")
        self.clean_status_label.config(fg=MUTED)
        self.clean_start_btn.config(state=tk.NORMAL)
        self.clean_stop_btn.config(state=tk.DISABLED)

    # ==================== SOUNDPAD TAB (embedded real app) ====================
    def _build_soundpad_tab(self, notebook):
        tab = self._new_tab(notebook, " 🎚 Soundpad ")

        self.spad_enabled = tk.BooleanVar(value=True)
        self._enable_strip(tab, self.spad_enabled)

        prog = tile(tab, "Программа")
        prog.pack(fill=tk.X, pady=(0, 8))
        path_f = row(prog.body)
        lbl(path_f, "Soundpad.exe", color=MUTED).pack(side=tk.LEFT)
        self.spad_path = ent(path_f, size=8, mono=True)
        self.spad_path.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=6)
        self.spad_path.insert(0, next((p for p in SOUNDPAD_EXE_CANDIDATES if os.path.isfile(p)),
                                      SOUNDPAD_EXE_CANDIDATES[0]))
        btn(path_f, "Обзор", self.spad_pick_exe, size=8).pack(side=tk.LEFT)

        attach_f = row(prog.body, pady=(7, 0))
        btn(attach_f, "Втащить Soundpad внутрь", self.spad_attach).pack(side=tk.LEFT)
        btn(attach_f, "Отцепить", self.spad_detach, color=MUTED).pack(side=tk.LEFT, padx=5)

        self.spad_embed_var = tk.StringVar(value="Soundpad не встроен")
        tk.Label(prog.body, textvariable=self.spad_embed_var, bg=TILE, fg=MUTED,
                 font=(FONT, 8)).pack(anchor=tk.W, pady=(6, 0))

        frame = tk.Frame(tab, bg=EDGE)
        frame.pack(fill=tk.BOTH, expand=True, pady=(0, 8))
        self.spad_container = tk.Frame(frame, bg="#000000", height=150)
        self.spad_container.pack(fill=tk.BOTH, expand=True, padx=1, pady=1)
        self.spad_container.pack_propagate(False)
        self.spad_container.bind("<Configure>", self._on_spad_resize)

        auto = tile(tab, "Автоматика (через Remote Control)")
        auto.pack(fill=tk.X, pady=(0, 8))
        load_f = row(auto.body)
        btn(load_f, "Загрузить список", self.spad_load_list, size=8).pack(side=tk.LEFT)
        self.spad_count_var = tk.StringVar(value="список не загружен")
        tk.Label(load_f, textvariable=self.spad_count_var, bg=TILE, fg=MUTED,
                 font=(FONT, 8)).pack(side=tk.LEFT, padx=8)

        self.spad_mode = tk.StringVar(value="random")
        mode_f = row(auto.body, pady=(6, 0))
        radio(mode_f, "Случайный трек", self.spad_mode, "random").pack(side=tk.LEFT)
        radio(mode_f, "Один на постоянке", self.spad_mode, "fixed").pack(side=tk.LEFT, padx=10)

        self.spad_combo = ttk.Combobox(auto.body, state="readonly", font=(FONT, 8))
        self.spad_combo.pack(fill=tk.X, pady=5)

        opts_f = row(auto.body)
        self.spad_interrupt = tk.BooleanVar(value=True)
        check(opts_f, "Обрывать предыдущий", self.spad_interrupt).pack(side=tk.LEFT)
        lbl(opts_f, "Кулдаун (сек)", color=MUTED).pack(side=tk.LEFT, padx=(14, 0))
        self.spad_cd_entry = ent(opts_f, width=6)
        self.spad_cd_entry.pack(side=tk.LEFT, padx=6)
        self.spad_cd_entry.insert(0, "5.0")

        control = tile(tab, "Управление")
        control.pack(fill=tk.X)
        self.spad_status, self.spad_status_label, self.spad_start_btn, self.spad_stop_btn = \
            make_status_and_buttons(control.body, self.spad_start, self.spad_stop)
        self.spad_log_var = tk.StringVar(value="")
        tk.Label(control.body, textvariable=self.spad_log_var, bg=TILE, fg=MUTED,
                 font=(FONT, 8), wraplength=560, justify=tk.LEFT).pack(anchor=tk.W, pady=(8, 0))

    def _on_spad_resize(self, event):
        self.embedder.resize(event.width, event.height)

    def spad_pick_exe(self):
        path = filedialog.askopenfilename(title="Выбери Soundpad.exe",
                                          filetypes=[("Soundpad", "Soundpad.exe"),
                                                     ("Программы", "*.exe")])
        if path:
            self.spad_path.delete(0, tk.END)
            self.spad_path.insert(0, path)

    def spad_attach(self):
        if not IS_WINDOWS:
            messagebox.showerror("Только Windows",
                                 "Встраивание чужого окна работает только на Windows")
            return
        try:
            self.embedder.attach(self.spad_container)
            self.spad_embed_var.set("Soundpad встроен в окно")
            return
        except RuntimeError:
            pass

        exe = self.spad_path.get().strip()
        if not os.path.isfile(exe):
            messagebox.showerror("Не найден Soundpad",
                                 f"Нет файла:\n{exe}\n\nУкажи путь через 'Обзор'")
            return
        self.spad_embed_var.set("Запускаю Soundpad...")
        threading.Thread(target=self._spad_launch_and_attach, args=(exe,), daemon=True).start()

    def _spad_launch_and_attach(self, exe):
        try:
            subprocess.Popen([exe], cwd=os.path.dirname(exe))
        except Exception as e:
            self.root.after(0, lambda err=e: messagebox.showerror(
                "Не запустился", f"Soundpad не запустился:\n{err}"))
            return

        for _ in range(30):
            time.sleep(0.5)
            try:
                self.root.after(0, self._spad_try_attach)
                if self.embedder.hwnd:
                    return
            except Exception:
                pass
        self.root.after(0, lambda: self.spad_embed_var.set(
            "Soundpad запущен, но окно не поймалось — жми 'Втащить' ещё раз"))

    def _spad_try_attach(self):
        try:
            self.embedder.attach(self.spad_container)
            self.spad_embed_var.set("Soundpad встроен в окно")
        except Exception:
            pass

    def spad_detach(self):
        self.embedder.detach()
        self.spad_embed_var.set("Soundpad отцеплен — снова отдельное окно")

    def spad_load_list(self):
        threading.Thread(target=self._spad_load_worker, daemon=True).start()

    def _spad_load_worker(self):
        try:
            sounds = SoundpadRemote.sound_list()
            if not sounds:
                raise ValueError("Soundpad вернул пустой список")
            self.spad_list = sounds
            labels = [f"{i}. {t}" for i, t in sounds]
            self.root.after(0, lambda: self.spad_combo.config(values=labels))
            self.root.after(0, lambda: self.spad_combo.current(0))
            self.root.after(0, lambda n=len(sounds): self.spad_count_var.set(f"треков: {n}"))
            self.root.after(0, lambda: self.spad_log_var.set(""))
        except FileNotFoundError:
            self.root.after(0, lambda: messagebox.showerror(
                "Нет Remote Control",
                "Soundpad не отвечает по пайпу. Включи в нём:\n"
                "Settings -> Remote control -> Allow remote control"))
        except Exception as e:
            self.root.after(0, lambda err=e: self.spad_log_var.set(f"Ошибка списка: {err}"))

    def spad_start(self):
        try:
            cd = float(self.spad_cd_entry.get())
            if cd < 0.5:
                cd = 0.5
        except ValueError:
            cd = 5.0

        fixed_index = None
        if self.spad_mode.get() == "fixed":
            if not self.spad_list:
                messagebox.showwarning("Нет списка", "Сначала нажми 'Загрузить список'")
                return
            pos = self.spad_combo.current()
            if pos < 0:
                messagebox.showwarning("Не выбран трек", "Выбери трек в списке")
                return
            fixed_index = self.spad_list[pos][0]

        self.spad_start_btn.config(state=tk.DISABLED)
        self.spad_status.set("ПРОВЕРЯЮ SOUNDPAD...")
        self.spad_status_label.config(fg=WARN)
        threading.Thread(target=self._spad_loop, args=(fixed_index, cd), daemon=True).start()

    def _spad_loop(self, fixed_index, cooldown):
        if not SoundpadRemote.is_alive():
            self.root.after(0, lambda: messagebox.showerror(
                "Soundpad недоступен",
                "Soundpad не отвечает. Запусти его и включи:\n"
                "Settings -> Remote control -> Allow remote control"))
            self.root.after(0, lambda: self.spad_start_btn.config(state=tk.NORMAL))
            self.root.after(0, lambda: self.spad_status.set("ОШИБКА"))
            self.root.after(0, lambda: self.spad_status_label.config(fg=DANGER))
            return

        self.spad_running = True
        self.root.after(0, lambda: self.spad_status.set("КРУТИМ ЗВУК 🎚"))
        self.root.after(0, lambda: self.spad_status_label.config(fg=OK))
        self.root.after(0, lambda: self.spad_stop_btn.config(state=tk.NORMAL))

        while self.spad_running:
            try:
                if self.spad_interrupt.get():
                    SoundpadRemote.stop()
                if fixed_index is not None:
                    SoundpadRemote.play(fixed_index)
                    label = f"трек {fixed_index}"
                elif self.spad_list:
                    index, title = random.choice(self.spad_list)
                    SoundpadRemote.play(index)
                    label = f"{index}. {title}"
                else:
                    SoundpadRemote.play_random()
                    label = "случайный (выбрал сам Soundpad)"
                self.root.after(0, lambda t=label: self.spad_log_var.set(f"Играет: {t}"))
            except Exception as e:
                self.root.after(0, lambda err=e: self.spad_log_var.set(f"Ошибка: {err}"))
            time.sleep(cooldown)

    def spad_stop(self):
        self.spad_running = False
        try:
            SoundpadRemote.stop()
        except Exception:
            pass
        self.spad_status.set("ВЫКЛ")
        self.spad_status_label.config(fg=MUTED)
        self.spad_start_btn.config(state=tk.NORMAL)
        self.spad_stop_btn.config(state=tk.DISABLED)

    # ==================== SHARED ====================
    def _ensure_driver(self, port):
        if self.driver:
            try:
                self.driver.title
                return
            except Exception:
                self.driver = None
        options = Options()
        options.add_experimental_option("debuggerAddress", f"127.0.0.1:{port}")
        self.driver = webdriver.Chrome(options=options)

    def _scrape_participants(self):
        d = self.driver
        names = []
        try:
            panel = d.find_elements(By.CSS_SELECTOR,
                '.participants-section-container, [aria-label*="Participants panel"], '
                '#participants-list, .participants-ul, '
                '[class*="participants-list"], [class*="ParticipantsList"]')
            if not panel:
                d.find_element(By.CSS_SELECTOR,
                    '[aria-label*="Participants"], [aria-label*="participant"], '
                    'button[data-testid="participants-button"], [aria-label*="участник"]').click()
                time.sleep(0.5)
        except Exception:
            pass

        selectors = [
            '.participants-item__name-section span',
            '[class*="participant"] [class*="name"]',
            '[class*="ParticipantItem"] span',
            '.participants-li .participants-item__display-name',
            '[data-testid*="participant"] span',
            'li[class*="participant"] span:first-child',
        ]
        for sel in selectors:
            try:
                for el in d.find_elements(By.CSS_SELECTOR, sel):
                    text = el.text.strip()
                    if text and len(text) > 1 and not any(m in text for m in ("(Me)", "(me)", "(Я)")):
                        names.append(text)
                if names:
                    break
            except Exception:
                continue

        if not names:
            try:
                list_el = d.find_element(By.CSS_SELECTOR,
                    '[class*="participants-list"], [class*="ParticipantsList"], '
                    '.participants-ul, #participants-list')
                for s in list_el.find_elements(By.TAG_NAME, "span"):
                    text = s.text.strip()
                    if text and len(text) > 1 and not any(m in text for m in ("(Me)", "(me)", "(Я)")):
                        if not any(kw in text.lower() for kw in ("mute", "unmute", "more", "host", "ещё")):
                            names.append(text)
            except Exception:
                pass

        return list(dict.fromkeys(names))

    def _do_rename(self, new_name):
        d = self.driver
        wait = WebDriverWait(d, 3)
        try:
            panel = d.find_elements(By.CSS_SELECTOR,
                '.participants-section-container, [aria-label*="Participants panel"], '
                '#participants-list, .participants-ul')
            if not panel:
                d.find_element(By.CSS_SELECTOR,
                    '[aria-label*="Participants"], [aria-label*="participant"], '
                    'button[data-testid="participants-button"], [aria-label*="участник"]').click()
                time.sleep(0.5)
        except Exception:
            pass

        try:
            me_items = d.find_elements(By.XPATH,
                '//*[contains(text(),"(Me)") or contains(text(),"(Я)") or contains(text(),"(me)")]')
            if not me_items:
                return
            target = me_items[0]
            for _ in range(5):
                target = target.find_element(By.XPATH, "..")
                if "participant" in (target.get_attribute("class") or "").lower():
                    break

            ActionChains(d).move_to_element(target).perform()
            time.sleep(0.3)

            target.find_element(By.CSS_SELECTOR,
                '[aria-label*="More"], [aria-label*="ещё"], [aria-label*="Ещё"], '
                'button.more-button, [data-testid="more-button"], '
                '.participants-item__buttons button').click()
            time.sleep(0.3)

            wait.until(EC.element_to_be_clickable((By.XPATH,
                '//a[contains(text(),"Rename")] | //a[contains(text(),"Переименовать")] | '
                '//span[contains(text(),"Rename")] | //span[contains(text(),"Переименовать")] | '
                '//*[@role="menuitem"][contains(.,"Rename") or contains(.,"Переименовать")]'
            ))).click()
            time.sleep(0.3)

            inp = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR,
                'input[aria-label*="name"], input[aria-label*="имя"], '
                '.zm-modal input[type="text"], input.rename-input, '
                'input[placeholder*="name"], input[placeholder*="имя"]'
            )))
            inp.clear()
            inp.send_keys(new_name)
            time.sleep(0.1)

            wait.until(EC.element_to_be_clickable((By.XPATH,
                '//button[contains(text(),"OK") or contains(text(),"Save") or '
                'contains(text(),"Сохранить") or contains(text(),"Ок")]'
            ))).click()
        except Exception:
            pass

    def start_all(self):
        self.full_btn.config(state=tk.DISABLED)
        self.full_stop_btn.config(state=tk.NORMAL)
        if self.hand_enabled.get() and not self.hand_running:
            self.hand_start()
        if self.name_enabled.get() and not self.name_running:
            self.name_start()
        if self.chat_enabled.get() and not self.chat_running:
            self.chat_start()
        if self.clean_enabled.get() and not self.clean_running:
            self.clean_start()
        if self.spad_enabled.get() and not self.spad_running:
            self.spad_start()

    def stop_all(self):
        self.hand_stop()
        self.name_stop()
        self.chat_stop()
        self.clean_stop()
        self.spad_stop()
        self.full_btn.config(state=tk.NORMAL)
        self.full_stop_btn.config(state=tk.DISABLED)

    def _on_close(self):
        self.hand_running = False
        self.name_running = False
        self.chat_running = False
        self.clean_running = False
        self.spad_running = False
        # Hand Soundpad back its window, or it dies with this one.
        self.embedder.detach()
        if self.driver:
            try:
                self.driver.quit()
            except Exception:
                pass
        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    ZoomWar(root)
    root.mainloop()
