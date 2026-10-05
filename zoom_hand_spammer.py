"""
Zoom Troll Tool
---------------
1) Hand Raise Spam: toggles raise/lower hand every 0.2s (Alt+Y)
2) Name Changer: connects to browser Zoom via Selenium,
   randomly swaps your display name to one of the participants every 1s

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
    from selenium.webdriver.chrome.service import Service
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
        self.root.geometry("480x580")
        self.root.resizable(False, False)

        self.hand_running = False
        self.name_running = False
        self.driver = None
        self._hand_thread = None
        self._name_thread = None

        tk.Label(root, text="ZOOM TROLL TOOL", font=("Arial", 16, "bold")).pack(pady=8)

        # ===== HAND SPAM SECTION =====
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

        # ===== NAME CHANGER SECTION =====
        name_frame = tk.LabelFrame(root, text=" Name Changer (Browser Zoom) ", font=("Arial", 11, "bold"),
                                   padx=10, pady=5)
        name_frame.pack(fill=tk.X, padx=10, pady=5)

        tk.Label(name_frame, text="Вставь имена участников (по одному на строку):", font=("Arial", 9)).pack(anchor=tk.W)
        self.names_text = scrolledtext.ScrolledText(name_frame, width=50, height=6, font=("Arial", 10))
        self.names_text.pack(pady=3)
        self.names_text.insert(tk.END, "Иван Петров\nМария Сидорова\nАлексей Козлов")

        url_frame = tk.Frame(name_frame)
        url_frame.pack(fill=tk.X, pady=3)
        tk.Label(url_frame, text="Chrome Debug Port:", font=("Arial", 9)).pack(side=tk.LEFT)
        self.debug_port = tk.Entry(url_frame, width=8, font=("Arial", 10))
        self.debug_port.pack(side=tk.LEFT, padx=5)
        self.debug_port.insert(0, "9222")

        self.name_status = tk.StringVar(value="Выкл")
        tk.Label(name_frame, textvariable=self.name_status, font=("Arial", 10, "bold"), fg="red").pack()

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
            "Для смены имени через браузерный Zoom:\n"
            "1. Закрой Chrome полностью\n"
            "2. Запусти Chrome с отладкой:\n"
            '   chrome.exe --remote-debugging-port=9222\n'
            "3. Зайди на Zoom Web (app.zoom.us) и войди в конфу\n"
            "4. Нажми CONNECT & START тут\n"
            "\n"
            "Скрипт сам найдёт Participants → твоё имя → Rename"
        )
        tk.Label(info_frame, text=instructions, font=("Arial", 8), justify=tk.LEFT, anchor=tk.W).pack(anchor=tk.W)

        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

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

        names = [n.strip() for n in self.names_text.get("1.0", tk.END).strip().split("\n") if n.strip()]
        if len(names) < 2:
            messagebox.showwarning("Мало имён", "Впиши хотя бы 2 имени, чтобы было между чем чередовать")
            return

        port = self.debug_port.get().strip()
        self.name_start_btn.config(state=tk.DISABLED)
        self.name_status.set("Подключаюсь...")
        self._name_thread = threading.Thread(target=self._name_connect_and_loop, args=(names, port), daemon=True)
        self._name_thread.start()

    def _name_connect_and_loop(self, names, port):
        try:
            options = Options()
            options.add_experimental_option("debuggerAddress", f"127.0.0.1:{port}")
            self.driver = webdriver.Chrome(options=options)

            self.name_running = True
            self.root.after(0, lambda: self.name_status.set("МЕНЯЕМ ИМЕНА"))
            self.root.after(0, lambda: self.name_stop_btn.config(state=tk.NORMAL))

            while self.name_running:
                try:
                    new_name = random.choice(names)
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

    def _do_rename(self, new_name):
        d = self.driver
        wait = WebDriverWait(d, 3)

        # Open participants panel if not open — click Participants button
        try:
            participants_btn = d.find_element(By.CSS_SELECTOR,
                '[aria-label*="Participants"], [aria-label*="participant"], '
                'button[data-testid="participants-button"], '
                '.footer-button__participants-icon, '
                '[aria-label*="участник"]')
            panel = d.find_elements(By.CSS_SELECTOR,
                '.participants-section-container, [aria-label*="Participants panel"], '
                '#participants-list, .participants-ul')
            if not panel:
                participants_btn.click()
                time.sleep(0.5)
        except Exception:
            pass

        # Find own name item and hover to get "More" / "..." button
        # In Zoom web, participant items have hover menus
        try:
            # Look for the "(Me)" or "(Я)" marker
            me_items = d.find_elements(By.XPATH,
                '//*[contains(text(),"(Me)") or contains(text(),"(Я)") or contains(text(),"(me)")]')
            if me_items:
                me_el = me_items[0]
                # Find the parent participant row
                participant_row = me_el
                for _ in range(5):
                    participant_row = participant_row.find_element(By.XPATH, '..')
                    if 'participant' in (participant_row.get_attribute('class') or '').lower():
                        break

                ActionChains(d).move_to_element(participant_row).perform()
                time.sleep(0.3)

                # Click "More" or "..." button that appears on hover
                more_btn = participant_row.find_element(By.CSS_SELECTOR,
                    '[aria-label*="More"], [aria-label*="ещё"], [aria-label*="Ещё"], '
                    'button.more-button, [data-testid="more-button"], '
                    '.participants-item__buttons button')
                more_btn.click()
                time.sleep(0.3)

                # Click "Rename"
                rename_btn = wait.until(EC.element_to_be_clickable((By.XPATH,
                    '//a[contains(text(),"Rename")] | //a[contains(text(),"Переименовать")] | '
                    '//span[contains(text(),"Rename")] | //span[contains(text(),"Переименовать")] | '
                    '//*[@role="menuitem"][contains(.,"Rename") or contains(.,"Переименовать")]'
                )))
                rename_btn.click()
                time.sleep(0.3)

                # Type new name in the dialog input
                rename_input = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR,
                    'input[aria-label*="name"], input[aria-label*="имя"], '
                    '.zm-modal input[type="text"], '
                    'input.rename-input, input[placeholder*="name"], input[placeholder*="имя"]'
                )))
                rename_input.clear()
                rename_input.send_keys(new_name)
                time.sleep(0.1)

                # Click OK / Save
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
