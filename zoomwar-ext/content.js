// ZoomWar content script.
// Runs inside the Zoom web client and does the DOM work. The popup only
// sends start/stop messages; the loops live here so they keep running
// after the popup closes. Guarded against double-injection into the frame.

if (!window.__zoomwar_loaded) {
  window.__zoomwar_loaded = true;

  const state = {
    handTimer: null,
    nameTimer: null,
    handBusy: false,
    nameBusy: false,
    lastParticipants: [],
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").trim();
  const isMe = (t) => /\(\s*(me|я|ви|вы)\s*\)/i.test(t);
  const log = (...a) => console.log("[ZoomWar]", ...a);

  // On-page toast so the user sees what the extension is doing.
  let toastEl = null;
  let toastHide = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText =
        "position:fixed;z-index:2147483647;left:50%;bottom:90px;" +
        "transform:translateX(-50%);background:#141418;color:#ececf1;" +
        "border:1px solid #ff2d55;border-radius:8px;padding:8px 14px;" +
        "font:13px/1.3 'Segoe UI',sans-serif;pointer-events:none;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.5);max-width:80vw;";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = "ZoomWar: " + msg;
    toastEl.style.display = "block";
    clearTimeout(toastHide);
    toastHide = setTimeout(() => { if (toastEl) toastEl.style.display = "none"; },
                           2500);
    log(msg);
  }

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function queryAll(selectors) {
    const out = [];
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach((e) => out.push(e));
      } catch (e) { /* bad selector, skip */ }
    }
    return out;
  }

  function labelOf(el) {
    return ((el.getAttribute && el.getAttribute("aria-label") || "") + " " +
            (el.textContent || "")).toLowerCase();
  }

  // Click a menu/button whose visible text or label equals/contains a word.
  // `root` limits the search; `exact` avoids matching long containers.
  function clickByText(words, root = document, exact = false) {
    const nodes = root.querySelectorAll(
      'a,span,div,li,button,[role="menuitem"],[role="button"]');
    for (const n of nodes) {
      if (!visible(n)) continue;
      const t = norm(n.textContent).toLowerCase();
      if (!t || t.length > 40) continue;
      const hit = words.some((w) => exact ? t === w : t.includes(w));
      if (hit) { n.click(); return true; }
    }
    return false;
  }

  // ---------------- HAND RAISE ----------------
  const HAND_WORDS = [
    "raise hand", "lower hand", "raise your hand", "lower your hand",
    "поднять руку", "опустить руку", "поднимите руку",
    "підняти руку", "опустити руку", "прибрати руку", "підніміть руку",
  ];

  // Match a control by its aria-label, title, OR visible text.
  function hay(el) {
    return (
      (el.getAttribute && el.getAttribute("aria-label") || "") + " " +
      (el.getAttribute && el.getAttribute("title") || "") + " " +
      (el.textContent || "")
    ).toLowerCase();
  }

  function findHandEl() {
    const cands = queryAll([
      'button', '[role="button"]', '[role="menuitem"]',
      '[role="menuitemcheckbox"]', '[aria-label]',
    ]);
    for (const el of cands) {
      if (!visible(el)) continue;
      if (HAND_WORDS.some((w) => hay(el).includes(w))) return el;
    }
    return null;
  }

  function findReactionsButton() {
    const words = ["reaction", "react", "реакц", "реакці",
                   "эмодзи", "емодзі"];
    for (const b of queryAll(['button', '[role="button"]', '[aria-label]'])) {
      if (!visible(b)) continue;
      if (words.some((l) => hay(b).includes(l))) return b;
    }
    return null;
  }

  // Dump every visible clickable control to the console so the exact
  // hand-raise label can be identified when matching fails.
  function dumpButtons(where) {
    const list = [];
    for (const el of queryAll(['button', '[role="button"]',
                               '[role="menuitem"]', '[aria-label]'])) {
      if (!visible(el)) continue;
      list.push({
        label: (el.getAttribute("aria-label") || "").trim(),
        title: (el.getAttribute("title") || "").trim(),
        text: norm(el.textContent).slice(0, 40),
      });
    }
    console.log("[ZoomWar] buttons @ " + where + ":", list.length);
    console.table(list);
    window.__zoomwar_buttons = list;
  }

  function labelText(el) {
    return (el.getAttribute("aria-label") || norm(el.textContent) ||
            el.getAttribute("title") || "?").trim().slice(0, 30);
  }

  async function pokeHand() {
    // 1. A control already on screen (toolbar button or open popup).
    let el = findHandEl();
    if (el) { el.click(); toast("рука: " + labelText(el)); return; }

    // 2. Open the Reactions popup and look again.
    const react = findReactionsButton();
    if (react) {
      react.click();
      await sleep(400);
      el = findHandEl();
      if (el) { el.click(); toast("рука: " + labelText(el)); return; }
      dumpButtons("reactions open");
      react.click(); // close the popup
      toast("руки нет в меню — открой F12, смотри [ZoomWar]");
      return;
    }

    // 3. Nothing matched at all — dump what is on screen.
    dumpButtons("no reactions button");
    sendAltY();
    toast("кнопка не найдена — открой F12, смотри [ZoomWar]");
  }

  function sendAltY() {
    for (const type of ["keydown", "keyup"]) {
      const ev = new KeyboardEvent(type, {
        key: "y", code: "KeyY", keyCode: 89, which: 89,
        altKey: true, bubbles: true, cancelable: true,
      });
      (document.activeElement || document.body).dispatchEvent(ev);
      document.dispatchEvent(ev);
    }
  }

  function startHand(cooldownMs) {
    stopHand();
    toast("рука ВКЛ");
    const tick = async () => {
      if (state.handBusy) return;
      state.handBusy = true;
      try { await pokeHand(); } catch (e) { log("hand error", e); }
      finally { state.handBusy = false; }
    };
    tick();
    state.handTimer = setInterval(tick, cooldownMs);
  }

  function stopHand() {
    if (state.handTimer) clearInterval(state.handTimer);
    state.handTimer = null;
  }

  // ---------------- PARTICIPANTS / RENAME ----------------
  function findParticipantsPanel() {
    return queryAll([
      '.participants-section-container',
      '[aria-label*="Participants"]',
      '[aria-label*="частник"]', '[aria-label*="часник"]',
      '#participants-list', '.participants-ul',
      '[class*="participants-list"]', '[class*="ParticipantsList"]',
      '[class*="participants-panel"]', '[class*="ParticipantsPanel"]',
    ]).find(visible);
  }

  function openParticipantsPanel() {
    if (findParticipantsPanel()) return true;
    const btn = queryAll([
      'button[aria-label*="Participants"]',
      'button[aria-label*="частник"]', 'button[aria-label*="часник"]',
      'button[data-testid="participants-button"]',
    ]).find(visible);
    if (btn) { btn.click(); return true; }
    return false;
  }

  function scrapeParticipants() {
    openParticipantsPanel();
    const panel = findParticipantsPanel() || document;
    const names = [];
    const selectors = [
      '.participants-item__name-section span',
      '[class*="participant"] [class*="name"]',
      '[class*="ParticipantItem"] span',
      '.participants-li .participants-item__display-name',
      '[data-testid*="participant"] span',
      'li[class*="participant"] span',
    ];
    for (const sel of selectors) {
      panel.querySelectorAll(sel).forEach((el) => {
        const t = norm(el.textContent);
        if (t && t.length > 1 && t.length < 50 && !isMe(t)) names.push(t);
      });
      if (names.length) break;
    }
    const junk = ["mute", "unmute", "more", "host", "ещё", "еще", "ще",
                  "co-host", "соорганизатор", "организатор", "організатор"];
    const clean = names.filter(
      (t) => !junk.some((k) => t.toLowerCase().includes(k)));
    state.lastParticipants = [...new Set(clean.length ? clean : names)];
    return state.lastParticipants;
  }

  // Find the list row for yourself (the one tagged "(Me)"/"(Я)"/"(Ви)").
  function findMyRow() {
    const panel = findParticipantsPanel();
    if (!panel) return null;
    const rows = panel.querySelectorAll(
      'li,[class*="participants-item"],[class*="ParticipantItem"]');
    for (const row of rows) {
      const t = norm(row.textContent);
      if (isMe(t) && t.length < 80) return row;
    }
    return null;
  }

  async function renameMe(newName) {
    if (!openParticipantsPanel()) { toast("нет кнопки участников"); return; }
    await sleep(250);
    const row = findMyRow();
    if (!row) { toast("не нашёл себя в списке"); return; }

    row.scrollIntoView({ block: "center" });
    for (const ev of ["mouseover", "mouseenter", "mousemove"]) {
      row.dispatchEvent(new MouseEvent(ev, { bubbles: true }));
    }
    await sleep(250);

    // The row-level "More" button — scoped to this row, not the panel.
    const more = row.querySelector(
      'button[aria-label*="More"], button[aria-label*="ещё"], ' +
      'button[aria-label*="Ещё"], button[aria-label*="ще"], ' +
      'button.more-button, [data-testid="more-button"]');
    if (more && visible(more)) {
      more.click();
      await sleep(250);
    } else {
      // Some layouts rename on a direct double-click of the name.
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await sleep(250);
    }

    // The Rename item lives in a popup menu at document level.
    if (!clickByText(["rename", "переименовать", "перейменувати"])) {
      toast("нет пункта «Переименовать»");
      return;
    }
    await sleep(250);

    const input = queryAll([
      '[role="dialog"] input[type="text"]',
      '.zm-modal input[type="text"]', '.zmu-modal input',
      'input[aria-label*="name"]', 'input[aria-label*="имя"]',
      'input[aria-label*="ім"]',
      'input[placeholder*="name"]', 'input[placeholder*="имя"]',
      'input[placeholder*="ім"]',
    ]).find(visible);
    if (!input) { toast("нет поля ввода имени"); return; }

    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value").set;
    setter.call(input, newName);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(150);

    clickByText(["save", "сохранить", "зберегти", "ok", "ок", "rename",
                 "переименовать", "перейменувати"]);
    toast("ник → " + newName);
  }

  function startName(mode, manualNames, cooldownMs) {
    stopName();
    toast("ник ВКЛ (" + (mode === "auto" ? "из конфы" : "свои") + ")");
    const tick = async () => {
      if (state.nameBusy) return;
      state.nameBusy = true;
      try {
        let pool = manualNames;
        if (mode === "auto") pool = scrapeParticipants();
        if (pool && pool.length) {
          await renameMe(pool[Math.floor(Math.random() * pool.length)]);
        } else {
          toast("нет имён для смены");
        }
      } catch (e) { log("name error", e); }
      finally { state.nameBusy = false; }
    };
    tick();
    state.nameTimer = setInterval(tick, cooldownMs);
  }

  function stopName() {
    if (state.nameTimer) clearInterval(state.nameTimer);
    state.nameTimer = null;
  }

  // ---------------- MESSAGING ----------------
  const runtime = (typeof browser !== "undefined") ? browser : chrome;
  runtime.runtime.onMessage.addListener((msg) => {
    switch (msg && msg.type) {
      case "hand_start": startHand(msg.cooldownMs); break;
      case "hand_stop": stopHand(); toast("рука ВЫКЛ"); break;
      case "name_start":
        startName(msg.mode, msg.names || [], msg.cooldownMs); break;
      case "name_stop": stopName(); toast("ник ВЫКЛ"); break;
      case "status":
        return Promise.resolve({
          hand: !!state.handTimer,
          name: !!state.nameTimer,
          participants: state.lastParticipants,
        });
    }
    return Promise.resolve({ ok: true });
  });

  log("loaded in", location.href);
}
