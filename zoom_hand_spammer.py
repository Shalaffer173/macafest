"""
Zoom Troll Tool
---------------
1) Hand Raise Spam: toggles raise/lower hand every 0.2s (Alt+Y)
2) Name Changer: two modes
   - Manual: you type names, it picks randomly
   - Auto: scrapes participant list from browser Zoom, picks randomly

Requirements:
    pip install pyautogui selenium webdriver-manager
"""

import random
import threading
import time
import tkinter as tk
from tkinter import messagebox, scrolledtext

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
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    SELENIUM_AVAILABLE = True
except ImportError:
    pass


class ZoomTrollTool:
    def __init__(self, root):
        self.root = root
        self.root.title("Zoom Troll Tool")
        self.root.geometry("500x680")
        self.root.resizable(False, False)

        self.hand_running = False
        self.name_running = False
        self.driver = None
        self._hand_thread = None
        self._name_thread = None

        tk.Label(root, text="ZOOM TROLL TOOL", font=("Arial", 16, "bold")).pack(pady=8)

        # ===== HAND SPAM =====
        hand_frame = tk.LabelFrame(root, text=" Hand Raise Spam ", font=("Arial", 11, "bold"), padx=10, pady=5)
        hand_frame.pack(fill=tk.X, padx=10, pady=5)

        tk.Label(hand_frame, text="Alt+Y каждые 0.2 сек (фокус на Zoom!)", font=("Arial", 9)).pack()
        self.hand_status = tk.StringVar(value="Выкл")
        tk.Label(hand_frame, textvariable=self.hand_status, font=("Arial", 10, "bold"), fg="red").pack()

        hbtn = tk.Frame(hand_frame)
        hbtn.pack(pady=3)
        self.hand_start_btn = tk.Button(hbtn, text="START", width=10, bg="#4CAF50", fg="white",
                                        font=("Arial", 10, "bold"), command=self.hand_start)
        self.hand_start_btn.pack(side=tk.LEFT, padx=3)
        self.hand_stop_btn = tk.Button(hbtn, text="STOP", width=10, bg="#f44336", fg="white",
                                       font=("Arial", 10, "bold"), command=self.hand_stop, state=tk.DISABLED)
        self.hand_stop_btn.pack(side=tk.LEFT, padx=3)

        # ===== NAME CHANGER =====
        name_frame = tk.LabelFrame(root, text=" Name Changer (Browser Zoom) ", font=("Arial", 11, "bold"),
                                   padx=10, pady=5)
        name_frame.pack(fill=tk.X, padx=10, pady=5)

        # Mode selector
        self.name_mode = tk.StringVar(value="manual")
        mode_frame = tk.Frame(name_frame)
        mode_frame.pack(fill=tk.X, pady=3)
        tk.Radiobutton(mode_frame, text="Ручной список", variable=self.name_mode, value="manual",
                        font=("Arial", 10), command=self._toggle_name_mode).pack(side=tk.LEFT, padx=5)
        tk.Radiobutton(mode_frame, text="Авто (парсить участников)", variable=self.name_mode, value="auto",
                        font=("Arial", 10), command=self._toggle_name_mode).pack(side=tk.LEFT, padx=5)

        # Manual names input
        self.manual_frame = tk.Frame(name_frame)
        self.manual_frame.pack(fill=tk.X)
        tk.Label(self.manual_frame, text="Имена (по одному на строку):", font=("Arial", 9)).pack(anchor=tk.W)
        self.names_text = scrolledtext.ScrolledText(self.manual_frame, width=52, height=5, font=("Arial", 10))
        self.names_text.pack(pady=3)
        self.names_text.insert(tk.END, "Иван Петров\nМария Сидорова\nАлексей Козлов")

        # Auto mode info
        self.auto_frame = tk.Frame(name_frame)
        tk.Label(self.auto_frame, text="Скрипт сам спарсит всех участников из Zoom\n"
                 "и будет менять твоё имя на случайного из них",
                 font=("Arial", 9), fg="#2196F3", justify=tk.LEFT).pack(anchor=tk.W)
        self.participants_var = tk.StringVar(value="Участники: не загружены")
        tk.Label(self.auto_frame, textvariable=self.participants_var, font=("Arial", 9), fg="#666").pack(anchor=tk.W)

        # Chrome port
        port_frame = tk.Frame(name_frame)
        port_frame.pack(fill=tk.X, pady=3)
        tk.Label(port_frame, text="Chrome Debug Port:", font=("Arial", 9)).pack(side=tk.LEFT)
        self.debug_port = tk.Entry(port_frame, width=8, font=("Arial", 10))
        self.debug_port.pack(side=tk.LEFT, padx=5)
        self.debug_port.insert(0, "9222")

        self.name_status = tk.StringVar(value="Выкл")
        self.name_status_label = tk.Label(name_frame, textvariable=self.name_status,
                                          font=("Arial", 10, "bold"), fg="red")
        self.name_status_label.pack()

        nbtn = tk.Frame(name_frame)
        nbtn.pack(pady=3)
        self.name_start_btn = tk.Button(nbtn, text="CONNECT & START", width=16, bg="#2196F3", fg="white",
                                        font=("Arial", 10, "bold"), command=self.name_start)
        self.name_start_btn.pack(side=tk.LEFT, padx=3)
        self.name_stop_btn = tk.Button(nbtn, text="STOP", width=10, bg="#f44336", fg="white",
                                       font=("Arial", 10, "bold"), command=self.name_stop, state=tk.DISABLED)
        self.name_stop_btn.pack(side=tk.LEFT, padx=3)

        # ===== INSTRUCTIONS =====
        info_frame = tk.LabelFrame(root, text=" Инструкция ", font=("Arial", 10), padx=10, pady=5)
        info_frame.pack(fill=tk.X, padx=10, pady=5)
        instructions = (
            "1. Закрой Chrome полностью\n"
            "2. Запусти: chrome.exe --remote-debugging-port=9222\n"
            "3. Зайди на app.zoom.us и войди в конфу\n"
            "4. Выбери режим и жми CONNECT & START\n\n"
            "Ручной: меняет имя на случайное из твоего списка\n"
            "Авто: парсит участников из Zoom и меняет на одного из них"
        )
        tk.Label(info_frame, text=instructions, font=("Arial", 8), justify=tk.LEFT, anchor=tk.W).pack(anchor=tk.W)

        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    def _toggle_name_mode(self):
        if self.name_mode.get() == "manual":
            self.auto_frame.pack_forget()
            self.manual_frame.pack(fill=tk.X, before=self.debug_port.master)
        else:
            self.manual_frame.pack_forget()
            self.auto_frame.pack(fill=tk.X, before=self.debug_port.master)

    # ---- Hand Spam ----
    def hand_start(self):
        self.hand_running = True
        self.hand_status.set("СПАМИМ ✋")
        self.hand_start_btn.config(state=tk.DISABLED)
        self.hand_stop_btn.config(state=tk.NORMAL)
        self._hand_thread = threading.Thread(target=self._hand_loop, daemon=True)
        self._hand_thread.start()

    def hand_stop(self):
        self.hand_running = False
        self.hand_status.set("Выкл")
        self.hand_start_btn.config(state=tk.NORMAL)
        self.hand_stop_btn.config(state=tk.DISABLED)

    def _hand_loop(self):
        while self.hand_running:
            pyautogui.hotkey("alt", "y")
            time.sleep(0.2)

    # ---- Name Changer ----
    def name_start(self):
        if not SELENIUM_AVAILABLE:
            messagebox.showerror("Ошибка", "Selenium не установлен!\npip install selenium webdriver-manager")
            return

        if self.name_mode.get() == "manual":
            names = [n.strip() for n in self.names_text.get("1.0", tk.END).strip().split("\n") if n.strip()]
            if len(names) < 2:
                messagebox.showwarning("Мало имён", "Впиши хотя бы 2 имени")
                return
        else:
            names = None

        port = self.debug_port.get().strip()
        self.name_start_btn.config(state=tk.DISABLED)
        self.name_status.set("Подключаюсь...")
        self.name_status_label.config(fg="orange")
        self._name_thread = threading.Thread(target=self._name_connect_and_loop, args=(names, port), daemon=True)
        self._name_thread.start()

    def _name_connect_and_loop(self, manual_names, port):
        try:
            options = Options()
            options.add_experimental_option("debuggerAddress", f"127.0.0.1:{port}")
            self.driver = webdriver.Chrome(options=options)

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
                                        self.participants_var.set(f"Участники ({c}): {', '.join(p[:5])}{'...' if c > 5 else ''}"))
                        if len(participants) < 2:
                            time.sleep(1.0)
                            continue
                        new_name = random.choice(participants)

                    self._do_rename(new_name)
                except Exception:
                    pass
                time.sleep(1.0)

        except Exception as e:
            self.root.after(0, lambda: messagebox.showerror(
                "Ошибка подключения",
                f"Не могу подключиться к Chrome на порту {port}.\n\n"
                f"Убедись что Chrome запущен с флагом:\n"
                f"chrome.exe --remote-debugging-port={port}\n\n"
                f"{e}"
            ))
            self.root.after(0, lambda: self.name_start_btn.config(state=tk.NORMAL))
            self.root.after(0, lambda: self.name_status.set("Ошибка"))
            self.root.after(0, lambda: self.name_status_label.config(fg="red"))

    def _scrape_participants(self):
        """Parse participant names from the Zoom web participants panel."""
        d = self.driver
        names = []

        # Make sure participants panel is open
        try:
            panel = d.find_elements(By.CSS_SELECTOR,
                '.participants-section-container, [aria-label*="Participants panel"], '
                '#participants-list, .participants-ul, '
                '[class*="participants-list"], [class*="ParticipantsList"]')
            if not panel:
                btn = d.find_element(By.CSS_SELECTOR,
                    '[aria-label*="Participants"], [aria-label*="participant"], '
                    'button[data-testid="participants-button"], '
                    '[aria-label*="участник"]')
                btn.click()
                time.sleep(0.5)
        except Exception:
            pass

        # Scrape names from participant items
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
                elements = d.find_elements(By.CSS_SELECTOR, sel)
                for el in elements:
                    text = el.text.strip()
                    if text and "(Me)" not in text and "(Я)" not in text and "(me)" not in text and len(text) > 1:
                        names.append(text)
                if names:
                    break
            except Exception:
                continue

        # Fallback: grab all text nodes inside participant list area
        if not names:
            try:
                list_el = d.find_element(By.CSS_SELECTOR,
                    '[class*="participants-list"], [class*="ParticipantsList"], '
                    '.participants-ul, #participants-list')
                spans = list_el.find_elements(By.TAG_NAME, 'span')
                for s in spans:
                    text = s.text.strip()
                    if text and "(Me)" not in text and "(Я)" not in text and len(text) > 1:
                        if not any(kw in text.lower() for kw in ['mute', 'unmute', 'more', 'host', 'ещё']):
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
                btn = d.find_element(By.CSS_SELECTOR,
                    '[aria-label*="Participants"], [aria-label*="participant"], '
                    'button[data-testid="participants-button"], '
                    '[aria-label*="участник"]')
                btn.click()
                time.sleep(0.5)
        except Exception:
            pass

        try:
            me_items = d.find_elements(By.XPATH,
                '//*[contains(text(),"(Me)") or contains(text(),"(Я)") or contains(text(),"(me)")]')
            if me_items:
                me_el = me_items[0]
                participant_row = me_el
                for _ in range(5):
                    participant_row = participant_row.find_element(By.XPATH, '..')
                    if 'participant' in (participant_row.get_attribute('class') or '').lower():
                        break

                ActionChains(d).move_to_element(participant_row).perform()
                time.sleep(0.3)

                more_btn = participant_row.find_element(By.CSS_SELECTOR,
                    '[aria-label*="More"], [aria-label*="ещё"], [aria-label*="Ещё"], '
                    'button.more-button, [data-testid="more-button"], '
                    '.participants-item__buttons button')
                more_btn.click()
                time.sleep(0.3)

                rename_btn = wait.until(EC.element_to_be_clickable((By.XPATH,
                    '//a[contains(text(),"Rename")] | //a[contains(text(),"Переименовать")] | '
                    '//span[contains(text(),"Rename")] | //span[contains(text(),"Переименовать")] | '
                    '//*[@role="menuitem"][contains(.,"Rename") or contains(.,"Переименовать")]'
                )))
                rename_btn.click()
                time.sleep(0.3)

                rename_input = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR,
                    'input[aria-label*="name"], input[aria-label*="имя"], '
                    '.zm-modal input[type="text"], '
                    'input.rename-input, input[placeholder*="name"], input[placeholder*="имя"]'
                )))
                rename_input.clear()
                rename_input.send_keys(new_name)
                time.sleep(0.1)

                ok_btn = wait.until(EC.element_to_be_clickable((By.XPATH,
                    '//button[contains(text(),"OK") or contains(text(),"Save") or '
                    'contains(text(),"Сохранить") or contains(text(),"Ок")]'
                )))
                ok_btn.click()
        except Exception:
            pass

    def name_stop(self):
        self.name_running = False
        self.name_status.set("Выкл")
        self.name_status_label.config(fg="red")
        self.name_start_btn.config(state=tk.NORMAL)
        self.name_stop_btn.config(state=tk.DISABLED)

    def _on_close(self):
        self.hand_running = False
        self.name_running = False
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
