"""
Zoom Troll Tool
---------------
Five tabs:
1) Hand Raise Spam  - configurable cooldown
2) Name Changer     - manual list or auto-scrape
3) Chat Spam        - send a message to Zoom chat on a cooldown
4) Cleanup          - clear cookies + toggle Urban VPN
5) Soundpad         - built-in soundboard, random or single track on repeat

Requirements:
    pip install pyautogui selenium webdriver-manager sounddevice soundfile numpy

To get the soundboard into Zoom as your microphone, install a virtual
audio cable (VB-CABLE), point this app's output at "CABLE Input" and set
Zoom's microphone to "CABLE Output".
"""

import os
import random
import threading
import time
import tkinter as tk
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

AUDIO_AVAILABLE = False
try:
    import numpy as np
    import sounddevice as sd
    import soundfile as sf
    AUDIO_AVAILABLE = True
except ImportError:
    pass

AUDIO_EXTS = (".wav", ".mp3", ".ogg", ".flac", ".aiff", ".aif", ".opus")
VIRTUAL_HINTS = ("cable", "voicemeeter", "virtual", "vb-audio")


def _to_stereo(block):
    if block.shape[1] == 1:
        return np.repeat(block, 2, axis=1)
    if block.shape[1] > 2:
        return block[:, :2]
    return block


def _resample(block, ratio):
    n_out = max(1, int(round(block.shape[0] * ratio)))
    x_old = np.linspace(0.0, 1.0, block.shape[0], endpoint=False)
    x_new = np.linspace(0.0, 1.0, n_out, endpoint=False)
    cols = [np.interp(x_new, x_old, block[:, c]) for c in range(block.shape[1])]
    return np.stack(cols, axis=1).astype(np.float32)


class SoundEngine:
    """Streams an audio file to one or more output devices at once."""

    BLOCK = 2048

    def __init__(self):
        self.volume = 0.8
        self._voices = []
        self._lock = threading.RLock()

    @staticmethod
    def output_devices():
        if not AUDIO_AVAILABLE:
            return []
        found = []
        for idx, dev in enumerate(sd.query_devices()):
            if dev["max_output_channels"] > 0:
                found.append((idx, dev["name"]))
        return found

    def stop(self):
        with self._lock:
            voices = list(self._voices)
            self._voices = []
        for _thread, event in voices:
            event.set()
        for thread, _event in voices:
            thread.join(timeout=1.0)

    def play(self, path, devices, exclusive=True):
        if exclusive:
            self.stop()
        event = threading.Event()
        started = []
        for dev in devices:
            thread = threading.Thread(target=self._worker, args=(path, dev, event), daemon=True)
            thread.start()
            started.append((thread, event))
        with self._lock:
            self._voices = [v for v in self._voices if v[0].is_alive()] + started

    def _open_stream(self, device, file_rate):
        try:
            return sd.OutputStream(device=device, samplerate=file_rate,
                                   channels=2, dtype="float32"), file_rate
        except Exception:
            rate = int(sd.query_devices(device)["default_samplerate"])
            return sd.OutputStream(device=device, samplerate=rate,
                                   channels=2, dtype="float32"), rate

    def _worker(self, path, device, stop_evt):
        try:
            with sf.SoundFile(path) as handle:
                stream, rate = self._open_stream(device, handle.samplerate)
                ratio = rate / handle.samplerate
                with stream:
                    while not stop_evt.is_set():
                        block = handle.read(self.BLOCK, dtype="float32", always_2d=True)
                        if block.shape[0] == 0:
                            break
                        block = _to_stereo(block)
                        if ratio != 1.0:
                            block = _resample(block, ratio)
                        stream.write(np.clip(block * self.volume, -1.0, 1.0))
        except Exception:
            pass


def make_cooldown_row(parent, default="1.0"):
    frame = tk.Frame(parent)
    tk.Label(frame, text="Кулдаун (сек):", font=("Arial", 9)).pack(side=tk.LEFT)
    entry = tk.Entry(frame, width=6, font=("Arial", 10))
    entry.pack(side=tk.LEFT, padx=5)
    entry.insert(0, default)
    return frame, entry


def make_status_and_buttons(parent, start_cmd, stop_cmd, start_text="START"):
    status_var = tk.StringVar(value="Выкл")
    status_label = tk.Label(parent, textvariable=status_var, font=("Arial", 10, "bold"), fg="red")
    status_label.pack(pady=2)

    btn_frame = tk.Frame(parent)
    btn_frame.pack(pady=3)
    start_btn = tk.Button(btn_frame, text=start_text, width=14, bg="#4CAF50", fg="white",
                          font=("Arial", 10, "bold"), command=start_cmd)
    start_btn.pack(side=tk.LEFT, padx=3)
    stop_btn = tk.Button(btn_frame, text="STOP", width=10, bg="#f44336", fg="white",
                         font=("Arial", 10, "bold"), command=stop_cmd, state=tk.DISABLED)
    stop_btn.pack(side=tk.LEFT, padx=3)
    return status_var, status_label, start_btn, stop_btn


class ZoomTrollTool:
    def __init__(self, root):
        self.root = root
        self.root.title("Zoom Troll Tool")
        self.root.geometry("560x780")
        self.root.resizable(False, False)

        self.hand_running = False
        self.name_running = False
        self.chat_running = False
        self.clean_running = False
        self.sound_running = False
        self.driver = None
        self.sound_list = []
        self.sound_engine = SoundEngine()

        tk.Label(root, text="ZOOM TROLL TOOL", font=("Arial", 16, "bold")).pack(pady=6)

        notebook = ttk.Notebook(root)
        notebook.pack(fill=tk.BOTH, expand=True, padx=8, pady=(0, 4))

        self._build_hand_tab(notebook)
        self._build_name_tab(notebook)
        self._build_chat_tab(notebook)
        self._build_clean_tab(notebook)
        self._build_sound_tab(notebook)

        full_frame = tk.Frame(root)
        full_frame.pack(fill=tk.X, padx=8, pady=(2, 0))
        self.full_btn = tk.Button(full_frame, text="ЗАПУСТИТЬ ВСЁ РАЗОМ",
                                  bg="#9C27B0", fg="white", font=("Arial", 12, "bold"),
                                  command=self.start_all)
        self.full_btn.pack(fill=tk.X, ipady=4)
        self.full_stop_btn = tk.Button(full_frame, text="ОСТАНОВИТЬ ВСЁ",
                                       bg="#333", fg="white", font=("Arial", 10, "bold"),
                                       command=self.stop_all, state=tk.DISABLED)
        self.full_stop_btn.pack(fill=tk.X, ipady=2, pady=(2, 0))

        info = tk.LabelFrame(root, text=" Инструкция ", font=("Arial", 9), padx=8, pady=4)
        info.pack(fill=tk.X, padx=8, pady=(0, 6))
        tk.Label(info, text=(
            "Рука: фокус на Zoom, жми START. Ник/Чат/Очистка: запусти Chrome с флагом\n"
            "chrome.exe --remote-debugging-port=9222, зайди на app.zoom.us\n"
            "Соундпад: поставь VB-CABLE, выход = CABLE Input, микрофон в Zoom = CABLE Output"
        ), font=("Arial", 8), justify=tk.LEFT).pack(anchor=tk.W)

        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ==================== HAND TAB ====================
    def _build_hand_tab(self, notebook):
        tab = tk.Frame(notebook, padx=10, pady=10)
        notebook.add(tab, text=" ✋ Рука ")

        self.hand_enabled = tk.BooleanVar(value=True)
        tk.Checkbutton(tab, text="Включить в 'Запустить всё разом'", variable=self.hand_enabled,
                       font=("Arial", 9)).pack(anchor=tk.W)

        tk.Label(tab, text="Спам поднятия/опускания руки (Alt+Y)", font=("Arial", 10)).pack(pady=5)

        self.hand_cd_frame, self.hand_cd_entry = make_cooldown_row(tab, "0.2")
        self.hand_cd_frame.pack(pady=5)

        self.hand_status, self.hand_status_label, self.hand_start_btn, self.hand_stop_btn = \
            make_status_and_buttons(tab, self.hand_start, self.hand_stop)

    def hand_start(self):
        try:
            cd = float(self.hand_cd_entry.get())
            if cd < 0.05:
                cd = 0.05
        except ValueError:
            cd = 0.2
        self.hand_running = True
        self.hand_status.set("СПАМИМ ✋")
        self.hand_status_label.config(fg="green")
        self.hand_start_btn.config(state=tk.DISABLED)
        self.hand_stop_btn.config(state=tk.NORMAL)
        threading.Thread(target=self._hand_loop, args=(cd,), daemon=True).start()

    def hand_stop(self):
        self.hand_running = False
        self.hand_status.set("Выкл")
        self.hand_status_label.config(fg="red")
        self.hand_start_btn.config(state=tk.NORMAL)
        self.hand_stop_btn.config(state=tk.DISABLED)

    def _hand_loop(self, cooldown):
        while self.hand_running:
            pyautogui.hotkey("alt", "y")
            time.sleep(cooldown)

    # ==================== NAME TAB ====================
    def _build_name_tab(self, notebook):
        tab = tk.Frame(notebook, padx=10, pady=8)
        notebook.add(tab, text=" 👤 Ник ")

        self.name_enabled = tk.BooleanVar(value=True)
        tk.Checkbutton(tab, text="Включить в 'Запустить всё разом'", variable=self.name_enabled,
                       font=("Arial", 9)).pack(anchor=tk.W)

        self.name_mode = tk.StringVar(value="manual")
        mode_f = tk.Frame(tab)
        mode_f.pack(fill=tk.X, pady=3)
        tk.Radiobutton(mode_f, text="Ручной список", variable=self.name_mode, value="manual",
                       font=("Arial", 9), command=self._toggle_name_mode).pack(side=tk.LEFT, padx=5)
        tk.Radiobutton(mode_f, text="Авто (парсить участников)", variable=self.name_mode, value="auto",
                       font=("Arial", 9), command=self._toggle_name_mode).pack(side=tk.LEFT, padx=5)

        self.manual_frame = tk.Frame(tab)
        self.manual_frame.pack(fill=tk.X)
        tk.Label(self.manual_frame, text="Имена (по одному на строку):", font=("Arial", 9)).pack(anchor=tk.W)
        self.names_text = scrolledtext.ScrolledText(self.manual_frame, width=52, height=4, font=("Arial", 9))
        self.names_text.pack(pady=2)
        self.names_text.insert(tk.END, "Иван Петров\nМария Сидорова\nАлексей Козлов")

        self.auto_frame = tk.Frame(tab)
        tk.Label(self.auto_frame, text="Автопарсинг участников из Zoom", font=("Arial", 9),
                 fg="#2196F3").pack(anchor=tk.W)
        self.participants_var = tk.StringVar(value="Участники: ещё не загружены")
        tk.Label(self.auto_frame, textvariable=self.participants_var, font=("Arial", 8),
                 fg="#666").pack(anchor=tk.W)

        settings_f = tk.Frame(tab)
        settings_f.pack(fill=tk.X, pady=4)
        tk.Label(settings_f, text="Chrome Port:", font=("Arial", 9)).pack(side=tk.LEFT)
        self.name_port = tk.Entry(settings_f, width=6, font=("Arial", 10))
        self.name_port.pack(side=tk.LEFT, padx=5)
        self.name_port.insert(0, "9222")
        tk.Label(settings_f, text="Кулдаун (сек):", font=("Arial", 9)).pack(side=tk.LEFT, padx=(15, 0))
        self.name_cd_entry = tk.Entry(settings_f, width=6, font=("Arial", 10))
        self.name_cd_entry.pack(side=tk.LEFT, padx=5)
        self.name_cd_entry.insert(0, "1.0")

        self.name_status, self.name_status_label, self.name_start_btn, self.name_stop_btn = \
            make_status_and_buttons(tab, self.name_start, self.name_stop, "CONNECT & START")
        self.name_start_btn.config(bg="#2196F3")

    def _toggle_name_mode(self):
        settings = self.name_port.master
        if self.name_mode.get() == "manual":
            self.auto_frame.pack_forget()
            self.manual_frame.pack(fill=tk.X, before=settings)
        else:
            self.manual_frame.pack_forget()
            self.auto_frame.pack(fill=tk.X, before=settings)

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
        self.name_status.set("Подключаюсь...")
        self.name_status_label.config(fg="orange")
        threading.Thread(target=self._name_loop, args=(names, port, cd), daemon=True).start()

    def _name_loop(self, manual_names, port, cooldown):
        try:
            self._ensure_driver(port)
            self.name_running = True
            self.root.after(0, lambda: self.name_status.set("МЕНЯЕМ ИМЕНА"))
            self.root.after(0, lambda: self.name_status_label.config(fg="green"))
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
            self.root.after(0, lambda: self.name_status.set("Ошибка"))
            self.root.after(0, lambda: self.name_status_label.config(fg="red"))

    def name_stop(self):
        self.name_running = False
        self.name_status.set("Выкл")
        self.name_status_label.config(fg="red")
        self.name_start_btn.config(state=tk.NORMAL)
        self.name_stop_btn.config(state=tk.DISABLED)

    # ==================== CHAT TAB ====================
    def _build_chat_tab(self, notebook):
        tab = tk.Frame(notebook, padx=10, pady=10)
        notebook.add(tab, text=" 💬 Чат ")

        self.chat_enabled = tk.BooleanVar(value=True)
        tk.Checkbutton(tab, text="Включить в 'Запустить всё разом'", variable=self.chat_enabled,
                       font=("Arial", 9)).pack(anchor=tk.W)

        tk.Label(tab, text="Спам сообщений в чат Zoom", font=("Arial", 10)).pack(pady=3)

        tk.Label(tab, text="Текст сообщения:", font=("Arial", 9)).pack(anchor=tk.W, pady=(5, 0))
        self.chat_text = scrolledtext.ScrolledText(tab, width=52, height=4, font=("Arial", 10))
        self.chat_text.pack(pady=3)
        self.chat_text.insert(tk.END, "ВНИМАНИЕ! ОБЪЯВЛЕНИЕ!")

        settings_f = tk.Frame(tab)
        settings_f.pack(fill=tk.X, pady=4)
        tk.Label(settings_f, text="Chrome Port:", font=("Arial", 9)).pack(side=tk.LEFT)
        self.chat_port = tk.Entry(settings_f, width=6, font=("Arial", 10))
        self.chat_port.pack(side=tk.LEFT, padx=5)
        self.chat_port.insert(0, "9222")
        tk.Label(settings_f, text="Кулдаун (сек):", font=("Arial", 9)).pack(side=tk.LEFT, padx=(15, 0))
        self.chat_cd_entry = tk.Entry(settings_f, width=6, font=("Arial", 10))
        self.chat_cd_entry.pack(side=tk.LEFT, padx=5)
        self.chat_cd_entry.insert(0, "2.0")

        self.chat_status, self.chat_status_label, self.chat_start_btn, self.chat_stop_btn = \
            make_status_and_buttons(tab, self.chat_start, self.chat_stop, "CONNECT & START")
        self.chat_start_btn.config(bg="#FF9800")

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
        self.chat_status.set("Подключаюсь...")
        self.chat_status_label.config(fg="orange")
        threading.Thread(target=self._chat_loop, args=(text, port, cd), daemon=True).start()

    def _chat_loop(self, text, port, cooldown):
        try:
            self._ensure_driver(port)
            self.chat_running = True
            self.root.after(0, lambda: self.chat_status.set("СПАМИМ ЧАТ 💬"))
            self.root.after(0, lambda: self.chat_status_label.config(fg="green"))
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
            self.root.after(0, lambda: self.chat_status.set("Ошибка"))
            self.root.after(0, lambda: self.chat_status_label.config(fg="red"))

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
        self.chat_status.set("Выкл")
        self.chat_status_label.config(fg="red")
        self.chat_start_btn.config(state=tk.NORMAL)
        self.chat_stop_btn.config(state=tk.DISABLED)

    # ==================== CLEAN TAB ====================
    def _build_clean_tab(self, notebook):
        tab = tk.Frame(notebook, padx=10, pady=10)
        notebook.add(tab, text=" 🧹 Очистка ")

        self.clean_enabled = tk.BooleanVar(value=True)
        tk.Checkbutton(tab, text="Включить в 'Запустить всё разом'", variable=self.clean_enabled,
                       font=("Arial", 9)).pack(anchor=tk.W)

        tk.Label(tab, text="Очистка куки + смена IP через Urban VPN", font=("Arial", 10)).pack(pady=3)

        tk.Label(tab, text="ID расширения Urban VPN в Chrome:", font=("Arial", 9)).pack(anchor=tk.W, pady=(5, 0))
        id_frame = tk.Frame(tab)
        id_frame.pack(fill=tk.X, pady=2)
        self.vpn_ext_id = tk.Entry(id_frame, width=40, font=("Arial", 9))
        self.vpn_ext_id.pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.vpn_ext_id.insert(0, "eppiocemhmnlbhjplcgkofciiegomcon")

        tk.Label(tab, text="(chrome://extensions -> ID расширения Urban VPN)",
                 font=("Arial", 8), fg="#666").pack(anchor=tk.W)

        settings_f = tk.Frame(tab)
        settings_f.pack(fill=tk.X, pady=5)
        tk.Label(settings_f, text="Chrome Port:", font=("Arial", 9)).pack(side=tk.LEFT)
        self.clean_port = tk.Entry(settings_f, width=6, font=("Arial", 10))
        self.clean_port.pack(side=tk.LEFT, padx=5)
        self.clean_port.insert(0, "9222")
        tk.Label(settings_f, text="Кулдаун (сек):", font=("Arial", 9)).pack(side=tk.LEFT, padx=(15, 0))
        self.clean_cd_entry = tk.Entry(settings_f, width=6, font=("Arial", 10))
        self.clean_cd_entry.pack(side=tk.LEFT, padx=5)
        self.clean_cd_entry.insert(0, "30")

        self.clean_status, self.clean_status_label, self.clean_start_btn, self.clean_stop_btn = \
            make_status_and_buttons(tab, self.clean_start, self.clean_stop, "CONNECT & START")
        self.clean_start_btn.config(bg="#795548")

        self.clean_log_var = tk.StringVar(value="")
        tk.Label(tab, textvariable=self.clean_log_var, font=("Arial", 8), fg="#666",
                 wraplength=450, justify=tk.LEFT).pack(anchor=tk.W, pady=(3, 0))

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
        self.clean_status.set("Подключаюсь...")
        self.clean_status_label.config(fg="orange")
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
            self.root.after(0, lambda: self.clean_status_label.config(fg="green"))
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
                            btn = self.driver.find_element(By.CSS_SELECTOR, sel)
                            if btn.is_displayed():
                                btn.click()
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
                            btn = self.driver.find_element(By.CSS_SELECTOR, sel)
                            if btn.is_displayed():
                                btn.click()
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
            self.root.after(0, lambda: self.clean_status.set("Ошибка"))
            self.root.after(0, lambda: self.clean_status_label.config(fg="red"))

    def clean_stop(self):
        self.clean_running = False
        self.clean_status.set("Выкл")
        self.clean_status_label.config(fg="red")
        self.clean_start_btn.config(state=tk.NORMAL)
        self.clean_stop_btn.config(state=tk.DISABLED)

    # ==================== SOUND TAB ====================
    def _build_sound_tab(self, notebook):
        tab = tk.Frame(notebook, padx=10, pady=6)
        notebook.add(tab, text=" 🔊 Соундпад ")

        self.sound_enabled = tk.BooleanVar(value=True)
        tk.Checkbutton(tab, text="Включить в 'Запустить всё разом'", variable=self.sound_enabled,
                       font=("Arial", 9)).pack(anchor=tk.W)

        folder_f = tk.Frame(tab)
        folder_f.pack(fill=tk.X, pady=(2, 0))
        tk.Label(folder_f, text="Папка:", font=("Arial", 9)).pack(side=tk.LEFT)
        self.sound_folder = tk.Entry(folder_f, font=("Arial", 9))
        self.sound_folder.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=4)
        tk.Button(folder_f, text="Обзор", font=("Arial", 8, "bold"), bg="#009688", fg="white",
                  command=self.sound_pick_folder).pack(side=tk.LEFT)

        self.sound_count_var = tk.StringVar(value="папка не выбрана")
        tk.Label(tab, textvariable=self.sound_count_var, font=("Arial", 8),
                 fg="#666").pack(anchor=tk.W)

        list_f = tk.Frame(tab)
        list_f.pack(fill=tk.BOTH, expand=True, pady=2)
        scroll = tk.Scrollbar(list_f, orient=tk.VERTICAL)
        scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self.sound_listbox = tk.Listbox(list_f, height=6, font=("Arial", 9),
                                        yscrollcommand=scroll.set, exportselection=False)
        self.sound_listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.sound_listbox.bind("<Double-Button-1>", lambda _e: self.sound_play_selected())
        scroll.config(command=self.sound_listbox.yview)

        manual_f = tk.Frame(tab)
        manual_f.pack(fill=tk.X, pady=2)
        tk.Button(manual_f, text="▶ Играть выбранный", font=("Arial", 9, "bold"),
                  bg="#607D8B", fg="white", command=self.sound_play_selected).pack(side=tk.LEFT)
        tk.Button(manual_f, text="■ Тишина", font=("Arial", 9, "bold"),
                  bg="#607D8B", fg="white", command=self.sound_silence).pack(side=tk.LEFT, padx=4)

        dev_f = tk.Frame(tab)
        dev_f.pack(fill=tk.X, pady=(4, 0))
        tk.Label(dev_f, text="Выход в Zoom:", font=("Arial", 9)).pack(anchor=tk.W)
        self.zoom_dev_combo = ttk.Combobox(dev_f, state="readonly", font=("Arial", 8))
        self.zoom_dev_combo.pack(fill=tk.X, pady=1)

        mon_f = tk.Frame(tab)
        mon_f.pack(fill=tk.X)
        self.sound_monitor = tk.BooleanVar(value=False)
        tk.Checkbutton(mon_f, text="Дублировать себе в наушники:", variable=self.sound_monitor,
                       font=("Arial", 9)).pack(anchor=tk.W)
        self.monitor_dev_combo = ttk.Combobox(mon_f, state="readonly", font=("Arial", 8))
        self.monitor_dev_combo.pack(fill=tk.X, pady=1)

        vol_f = tk.Frame(tab)
        vol_f.pack(fill=tk.X, pady=(2, 0))
        tk.Label(vol_f, text="Громкость:", font=("Arial", 9)).pack(side=tk.LEFT)
        self.sound_volume = tk.Scale(vol_f, from_=0, to=100, orient=tk.HORIZONTAL,
                                     showvalue=True, command=self._on_volume_change)
        self.sound_volume.set(80)
        self.sound_volume.pack(side=tk.LEFT, fill=tk.X, expand=True)

        self.sound_mode = tk.StringVar(value="random")
        mode_f = tk.Frame(tab)
        mode_f.pack(fill=tk.X)
        tk.Radiobutton(mode_f, text="Случайный трек", variable=self.sound_mode, value="random",
                       font=("Arial", 9)).pack(side=tk.LEFT)
        tk.Radiobutton(mode_f, text="Выбранный на постоянке", variable=self.sound_mode,
                       value="fixed", font=("Arial", 9)).pack(side=tk.LEFT, padx=6)

        self.sound_interrupt = tk.BooleanVar(value=True)
        tk.Checkbutton(tab, text="Обрывать предыдущий трек перед новым",
                       variable=self.sound_interrupt, font=("Arial", 9)).pack(anchor=tk.W)

        self.sound_cd_frame, self.sound_cd_entry = make_cooldown_row(tab, "5.0")
        self.sound_cd_frame.pack(anchor=tk.W, pady=2)

        self.sound_status, self.sound_status_label, self.sound_start_btn, self.sound_stop_btn = \
            make_status_and_buttons(tab, self.sound_start, self.sound_stop)
        self.sound_start_btn.config(bg="#E91E63")

        self.sound_log_var = tk.StringVar(value="")
        tk.Label(tab, textvariable=self.sound_log_var, font=("Arial", 8), fg="#666",
                 wraplength=460, justify=tk.LEFT).pack(anchor=tk.W)

        self._load_audio_devices()

    def _load_audio_devices(self):
        if not AUDIO_AVAILABLE:
            self.sound_log_var.set("Нет аудиодвижка: pip install sounddevice soundfile numpy")
            return
        devices = SoundEngine.output_devices()
        if not devices:
            self.sound_log_var.set("Не найдено ни одного устройства вывода")
            return
        labels = [f"{idx}: {name}" for idx, name in devices]
        self.zoom_dev_combo.config(values=labels)
        self.monitor_dev_combo.config(values=labels)

        virtual = next((i for i, (_, name) in enumerate(devices)
                        if any(h in name.lower() for h in VIRTUAL_HINTS)), None)
        self.zoom_dev_combo.current(virtual if virtual is not None else 0)
        self.monitor_dev_combo.current(0)
        if virtual is None:
            self.sound_log_var.set("Виртуальный кабель не найден — поставь VB-CABLE, "
                                   "иначе в Zoom звук не уйдёт")

    def _on_volume_change(self, value):
        self.sound_engine.volume = int(value) / 100.0

    def _selected_devices(self):
        devices = []
        zoom_label = self.zoom_dev_combo.get()
        if zoom_label:
            devices.append(int(zoom_label.split(":", 1)[0]))
        if self.sound_monitor.get():
            mon_label = self.monitor_dev_combo.get()
            if mon_label:
                mon_idx = int(mon_label.split(":", 1)[0])
                if mon_idx not in devices:
                    devices.append(mon_idx)
        return devices

    def sound_pick_folder(self):
        folder = filedialog.askdirectory(title="Папка со звуками")
        if not folder:
            return
        self.sound_folder.delete(0, tk.END)
        self.sound_folder.insert(0, folder)
        self.sound_scan_folder()

    def sound_scan_folder(self):
        folder = self.sound_folder.get().strip()
        if not os.path.isdir(folder):
            self.sound_count_var.set("папка не найдена")
            return
        found = []
        for dirpath, _dirnames, filenames in os.walk(folder):
            for name in sorted(filenames):
                if name.lower().endswith(AUDIO_EXTS):
                    found.append(os.path.join(dirpath, name))
        self.sound_list = found
        self.sound_listbox.delete(0, tk.END)
        for path in found:
            self.sound_listbox.insert(tk.END, os.path.basename(path))
        self.sound_count_var.set(f"треков: {len(found)}")
        if found:
            self.sound_listbox.selection_set(0)

    def sound_play_selected(self):
        if not self._require_audio():
            return
        picks = self.sound_listbox.curselection()
        if not picks:
            messagebox.showwarning("Не выбран трек", "Выбери трек в списке")
            return
        self._play_path(self.sound_list[picks[0]])

    def sound_silence(self):
        self.sound_engine.stop()
        self.sound_log_var.set("Тишина")

    def _require_audio(self):
        if not AUDIO_AVAILABLE:
            messagebox.showerror("Нет аудиодвижка",
                                 "pip install sounddevice soundfile numpy")
            return False
        if not self.sound_list:
            messagebox.showwarning("Нет треков", "Выбери папку со звуками")
            return False
        if not self._selected_devices():
            messagebox.showwarning("Нет устройства", "Выбери устройство вывода")
            return False
        return True

    def _play_path(self, path, exclusive=True):
        self.sound_engine.play(path, self._selected_devices(), exclusive=exclusive)
        name = os.path.basename(path)
        self.root.after(0, lambda: self.sound_log_var.set(f"Играет: {name}"))

    def sound_start(self):
        if not self._require_audio():
            return
        try:
            cd = float(self.sound_cd_entry.get())
            if cd < 0.5:
                cd = 0.5
        except ValueError:
            cd = 5.0

        fixed_path = None
        if self.sound_mode.get() == "fixed":
            picks = self.sound_listbox.curselection()
            if not picks:
                messagebox.showwarning("Не выбран трек", "Выбери трек в списке")
                return
            fixed_path = self.sound_list[picks[0]]

        self.sound_running = True
        self.sound_status.set("КРУТИМ ЗВУК 🔊")
        self.sound_status_label.config(fg="green")
        self.sound_start_btn.config(state=tk.DISABLED)
        self.sound_stop_btn.config(state=tk.NORMAL)
        threading.Thread(target=self._sound_loop, args=(fixed_path, cd), daemon=True).start()

    def _sound_loop(self, fixed_path, cooldown):
        while self.sound_running:
            try:
                path = fixed_path if fixed_path else random.choice(self.sound_list)
                self._play_path(path, exclusive=self.sound_interrupt.get())
            except Exception as e:
                self.root.after(0, lambda err=e: self.sound_log_var.set(f"Ошибка: {err}"))
            time.sleep(cooldown)

    def sound_stop(self):
        self.sound_running = False
        self.sound_engine.stop()
        self.sound_status.set("Выкл")
        self.sound_status_label.config(fg="red")
        self.sound_start_btn.config(state=tk.NORMAL)
        self.sound_stop_btn.config(state=tk.DISABLED)

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
            row = me_items[0]
            for _ in range(5):
                row = row.find_element(By.XPATH, "..")
                if "participant" in (row.get_attribute("class") or "").lower():
                    break

            ActionChains(d).move_to_element(row).perform()
            time.sleep(0.3)

            row.find_element(By.CSS_SELECTOR,
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
        if self.sound_enabled.get() and not self.sound_running:
            self.sound_start()

    def stop_all(self):
        self.hand_stop()
        self.name_stop()
        self.chat_stop()
        self.clean_stop()
        self.sound_stop()
        self.full_btn.config(state=tk.NORMAL)
        self.full_stop_btn.config(state=tk.DISABLED)

    def _on_close(self):
        self.hand_running = False
        self.name_running = False
        self.chat_running = False
        self.clean_running = False
        self.sound_running = False
        self.sound_engine.stop()
        if self.driver:
            try:
                self.driver.quit()
            except Exception:
                pass
        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    ZoomTrollTool(root)
    root.mainloop()
