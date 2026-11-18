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
    // The raise-hand button is one of several .nonverbal-feedback buttons
    // (yes / no / slower / faster / coffee / hand), all sharing that class,
    // so it must be singled out by the ✋ icon (unicode 270B) or its label —
    // never by the shared class, which would grab the green "yes" check.
    for (const svg of queryAll(['svg[class*="270b"]', 'svg[class*="270B"]'])) {
      const btn = svg.closest("button");
      if (btn && visible(btn)) return btn;
    }
    for (const el of queryAll(['button', '[role="button"]',
                               '[role="menuitem"]', '[aria-label]'])) {
      if (visible(el) && HAND_WORDS.some((w) => hay(el).includes(w))) return el;
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
    // Fast path: the hand button is already on screen (the Reactions
    // flyout stays open between ticks once opened), so just click it.
    let el = findHandEl();
    if (el) { el.click(); return; }

    // Otherwise open the Reactions flyout once; next ticks hit the fast
    // path above. The flyout is left open on purpose — reopening it every
    // tick was what made the old version lag.
    const react = findReactionsButton();
    if (react) {
      react.click();
      await sleep(250);
      el = findHandEl();
      if (el) { el.click(); return; }
      dumpButtons("reactions open");
      toast("руки нет в меню — F12, смотри [ZoomWar]");
      return;
    }

    dumpButtons("no reactions button");
    toast("кнопка не найдена — F12, смотри [ZoomWar]");
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
  // Zoom hides parts of its UI in Shadow DOM, which document.querySelectorAll
  // cannot see, so participant queries must walk open shadow roots too.
  function deepQueryAll(selectors, root = document) {
    const out = [];
    const seen = new Set();
    const visit = (node) => {
      for (const sel of selectors) {
        let found;
        try { found = node.querySelectorAll(sel); } catch (e) { continue; }
        found.forEach((e) => { if (!seen.has(e)) { seen.add(e); out.push(e); } });
      }
      let all;
      try { all = node.querySelectorAll("*"); } catch (e) { return; }
      for (const el of all) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(root);
    return out;
  }

  function participantRows() {
    return deepQueryAll([
      '[class*="participants-item"]', '[class*="ParticipantItem"]',
      '.participants-li', 'li[class*="participant"]',
      '[class*="participants-ul"] li', '[class*="participants-list"] li',
      '[role="listitem"]',
    ]).filter((el) => visible(el) && norm(el.textContent).length > 0);
  }

  // The panel is open when it actually has participant rows — matching a
  // button that merely mentions "Participants" (its settings chevron) was
  // what made the old code think an unopened panel was already open.
  function isPanelOpen() {
    return participantRows().length > 0;
  }

  // Click the main Participants toggle in the footer, not its settings
  // chevron (aria-label "Participants Settings") or anything else.
  function clickParticipantsButton() {
    const btns = deepQueryAll(['button', '[role="button"]']).filter(visible);
    const main = btns.find((b) => {
      const h = hay(b);
      const yes = h.includes("participant") || h.includes("частник") ||
                  h.includes("часник");
      const no = h.includes("setting") || h.includes("chevron") ||
                 h.includes("настрой") || h.includes("налаштув");
      return yes && !no;
    });
    if (main) { main.click(); return true; }
    const wrap = deepQueryAll(['#participant',
                               '[data-feature-type="participant"]'])[0];
    if (wrap) {
      const b = wrap.querySelector("button") || wrap;
      b.click();
      return true;
    }
    return false;
  }

  async function openParticipants() {
    if (isPanelOpen()) return true;
    if (!clickParticipantsButton()) {
      dumpButtons("no participants button");
      return false;
    }
    await sleep(450);
    return isPanelOpen();
  }

  function dumpParticipantsArea(where) {
    const cand = deepQueryAll(['[class*="participant"]'])
      .filter((el) => visible(el) && !/footer/i.test(el.className || ""));
    console.log("[ZoomWar] participant-ish els @ " + where + ":", cand.length);
    cand.slice(0, 8).forEach((el, i) =>
      console.log(`[${i}] ${el.className || ""} :: ` +
                  norm(el.textContent).slice(0, 80)));
    const sample = cand.find((el) => norm(el.textContent).length > 1);
    if (sample) {
      console.log("[ZoomWar] sample row outerHTML:\n" +
                  sample.outerHTML.slice(0, 3000));
    }
  }

  function scrapeParticipants() {
    const names = [];
    for (const row of participantRows()) {
      const t = norm(row.textContent);
      if (t && t.length > 1 && t.length < 50 && !isMe(t)) names.push(t);
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
    const rows = participantRows();
    for (const row of rows) {
      const t = norm(row.textContent);
      if (isMe(t) && t.length < 120) return row;
    }
    // Your own row is normally first in the list.
    return rows[0] || null;
  }


  // Click a menu item by text, piercing shadow DOM.
  function deepClickByText(words) {
    for (const n of deepQueryAll(['a', 'span', 'div', 'li', 'button',
                                  '[role="menuitem"]', '[role="button"]'])) {
      if (!visible(n)) continue;
      const t = norm(n.textContent).toLowerCase();
      if (t && t.length < 40 && words.some((w) => t.includes(w))) {
        n.click();
        return true;
      }
    }
    return false;
  }

  async function renameMe(newName) {
    if (!(await openParticipants())) {
      toast("панель участников не открылась — F12, смотри [ZoomWar]");
      return;
    }
    await sleep(200);
    const row = findMyRow();
    if (!row) {
      dumpParticipantsArea("no self row");
      toast("не нашёл себя — F12, смотри [ZoomWar]");
      return;
    }

    row.scrollIntoView({ block: "center" });
    for (const ev of ["mouseover", "mouseenter", "mousemove", "pointerover"]) {
      row.dispatchEvent(new MouseEvent(ev, { bubbles: true }));
    }
    await sleep(350);

    // The row-level "More" button — scoped to this row, not the panel.
    let more = row.querySelector(
      'button[aria-label*="More"], button[aria-label*="ещё"], ' +
      'button[aria-label*="Ещё"], button[aria-label*="ще"], ' +
      'button[aria-label*="More options"], button[aria-label*="Подробнее"], ' +
      'button[aria-label*="Больше"], button.more-button, ' +
      '[data-testid="more-button"]');
    if (!more || !visible(more)) {
      const btns = [...row.querySelectorAll("button")].filter(visible);
      more = btns[btns.length - 1] || null;
    }
    if (more) {
      more.click();
      await sleep(350);
    } else {
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await sleep(350);
    }

    // The Rename item lives in a popup menu (possibly in shadow DOM).
    if (!deepClickByText(["rename", "переименовать", "перейменувати"])) {
      console.log("[ZoomWar] self row html:\n" + row.outerHTML.slice(0, 3000));
      dumpParticipantsArea("after More click");
      toast("нет «Переименовать» — F12, смотри [ZoomWar]");
      return;
    }
    await sleep(350);

    const input = deepQueryAll([
      '[role="dialog"] input[type="text"]',
      '.zm-modal input[type="text"]', '.zmu-modal input',
      'input[aria-label*="name"]', 'input[aria-label*="имя"]',
      'input[aria-label*="ім"]',
      'input[placeholder*="name"]', 'input[placeholder*="имя"]',
      'input[placeholder*="ім"]', 'input[type="text"]',
    ]).find(visible);
    if (!input) { toast("нет поля ввода имени"); return; }

    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value").set;
    setter.call(input, newName);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(150);

    deepClickByText(["save", "сохранить", "зберегти", "ok", "ок", "rename",
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
        if (mode === "auto") {
          await openParticipants();
          pool = scrapeParticipants();
        }
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

  // The Zoom page is split across frames (meeting, whiteboard, ...). The
  // script loads in all of them, so only the frame that actually holds the
  // meeting controls should act — otherwise the whiteboard frame grabs the
  // commands and reports no participants.
  function hasMeetingUI() {
    return deepQueryAll([
      '#react', '#participant',
      '[data-feature-type="react"]', '[data-feature-type="participant"]',
      'svg[class*="270b"]', 'button[class*="nonverbal-feedback"]',
    ]).some(visible) || !!findReactionsButton();
  }

  // ---------------- MESSAGING ----------------
  const runtime = (typeof browser !== "undefined") ? browser : chrome;
  runtime.runtime.onMessage.addListener((msg) => {
    const t = msg && msg.type;

    if (t === "status") {
      return Promise.resolve({
        hand: !!state.handTimer,
        name: !!state.nameTimer,
        meeting: hasMeetingUI(),
        participants: state.lastParticipants,
      });
    }

    // Only the meeting frame runs the actions; other frames stay silent.
    if ((t === "hand_start" || t === "name_start") && !hasMeetingUI()) {
      return Promise.resolve({ ok: true, skipped: true });
    }

    switch (t) {
      case "hand_start": startHand(msg.cooldownMs); break;
      case "hand_stop": stopHand(); toast("рука ВЫКЛ"); break;
      case "name_start":
        startName(msg.mode, msg.names || [], msg.cooldownMs); break;
      case "name_stop": stopName(); toast("ник ВЫКЛ"); break;
    }
    return Promise.resolve({ ok: true });
  });

  log("loaded in", location.href);
}
