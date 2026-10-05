"""
Zoom Hand Raise Spammer
-----------------------
Toggles "Raise Hand" in Zoom every 0.2 seconds using the Alt+Y hotkey.
Press START to begin the chaos, STOP to end it.

Requirements:
    pip install pyautogui

Works on Windows/macOS/Linux (Zoom must be the focused window
or Alt+Y must be globally bound in Zoom settings).
"""

import threading
import time
import tkinter as tk

try:
    import pyautogui
except ImportError:
    print("Установи pyautogui: pip install pyautogui")
    raise SystemExit(1)

pyautogui.FAILSAFE = True  # move mouse to corner to emergency-stop


class ZoomHandSpammer:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Zoom Hand Spammer")
        self.root.geometry("320x200")
        self.root.resizable(False, False)

        self.running = False
        self._thread: threading.Thread | None = None

        self.status_var = tk.StringVar(value="Остановлен")

        tk.Label(root, text="Zoom Hand Raise Spammer", font=("Arial", 14, "bold")).pack(pady=10)
        tk.Label(root, text="Alt+Y каждые 0.2 сек", font=("Arial", 10)).pack()

        self.status_label = tk.Label(root, textvariable=self.status_var, font=("Arial", 12), fg="red")
        self.status_label.pack(pady=5)

        btn_frame = tk.Frame(root)
        btn_frame.pack(pady=10)

        self.start_btn = tk.Button(btn_frame, text="START", width=10, bg="#4CAF50", fg="white",
                                   font=("Arial", 11, "bold"), command=self.start)
        self.start_btn.pack(side=tk.LEFT, padx=5)

        self.stop_btn = tk.Button(btn_frame, text="STOP", width=10, bg="#f44336", fg="white",
                                  font=("Arial", 11, "bold"), command=self.stop, state=tk.DISABLED)
        self.stop_btn.pack(side=tk.LEFT, padx=5)

        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    def start(self):
        self.running = True
        self.status_var.set("СПАМИМ РУКУ ✋")
        self.status_label.config(fg="green")
        self.start_btn.config(state=tk.DISABLED)
        self.stop_btn.config(state=tk.NORMAL)
        self._thread = threading.Thread(target=self._spam_loop, daemon=True)
        self._thread.start()

    def stop(self):
        self.running = False
        self.status_var.set("Остановлен")
        self.status_label.config(fg="red")
        self.start_btn.config(state=tk.NORMAL)
        self.stop_btn.config(state=tk.DISABLED)

    def _spam_loop(self):
        while self.running:
            pyautogui.hotkey("alt", "y")
            time.sleep(0.2)

    def _on_close(self):
        self.running = False
        self.root.destroy()


if __name__ == "__main__":
    root = tk.Tk()
    ZoomHandSpammer(root)
    root.mainloop()
