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
  // Self tag: "(Me)", "(Я)", and combined forms like "(Host, me)" / "(Хост, я)".
  const isMe = (t) => /\((?:[^)]*[,\s])?(?:me|я|ви|вы)\s*\)/i.test(t);
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

  // Other participants' bare names: read the name element rather than the
  // whole row (which also carries button text), and strip the role tag in
  // brackets ("Кирило (Хост)" -> "Кирило") instead of dropping the person.
  function scrapeParticipants() {
    const names = [];
    for (const row of participantRows()) {
      const nameEl = row.querySelector(
        '[class*="display-name"], [class*="name-label"], [class*="__name"]');
      const raw = norm((nameEl || row).textContent);
      if (!raw || isMe(raw)) continue;
      const name = raw.replace(/\s*\([^)]*\)\s*$/, "").replace(/\.{3}$/, "").trim();
      if (name.length > 1 && name.length < 50) names.push(name);
    }
    state.lastParticipants = [...new Set(names)];
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


  // Dump every visible menu/popup item so the exact wording can be read.
  // Logs one compact line (easy to screenshot) plus a table.
  function dumpMenu(where) {
    let items = deepQueryAll([
      '[role="menuitem"]', '[role="menu"] li', '[role="menu"] button',
      '[role="menu"] a', '[class*="dropdown"] li', '[class*="dropdown"] a',
      '[class*="menu"] li', '[class*="menu"] a', '[class*="menu"] button',
      '[class*="popover"] li', '[class*="popover"] button',
      '[class*="context"] li', '[class*="context"] button',
    ]).filter(visible);

    // Fallback: if the menu selectors matched nothing, sweep every short
    // visible label on the page so the real wording still shows up.
    if (items.length === 0) {
      items = deepQueryAll(['a', 'li', 'button', 'span', 'div',
                            '[role="menuitem"]'])
        .filter((el) => {
          if (!visible(el)) return false;
          const t = norm(el.textContent);
          return t.length >= 2 && t.length <= 30 && el.children.length <= 1;
        });
    }

    const seen = new Set();
    const rows = [];
    for (const el of items) {
      const text = norm(el.textContent).slice(0, 50);
      const aria = el.getAttribute("aria-label") || "";
      const key = text + "|" + aria;
      if ((text || aria) && !seen.has(key)) {
        seen.add(key);
        rows.push({ text, aria });
      }
    }
    const line = rows.map((r) => r.text || "[" + r.aria + "]").join(" | ");
    console.log("[ZoomWar] MENU @ " + where + " (" + rows.length + "): " + line);
    console.table(rows);
  }

  async function waitFor(fn, timeoutMs, stepMs = 100) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  }

  const RENAME_WORDS = ["rename", "переименовать", "перейменувати",
                        "изменить имя", "змінити ім"];

  // The Rename entry of the participant menu: a short label that starts
  // with one of the words, so long containers and unrelated text don't match.
  // Returns the deepest such element: the item is <li><a>Rename</a></li> and
  // a click on the outer <li> never reaches a handler on the inner <a>,
  // while a click on the <a> bubbles up to the <li> either way.
  function findRenameItem() {
    const portal = document.getElementById("zmu-portal-dropdown--participant-list");
    const pools = [];
    if (portal) pools.push([...portal.querySelectorAll(
      'a,li,button,[role="menuitem"],span,div')]);
    pools.push(deepQueryAll(['[role="menuitem"]', '.dropdown-menu a',
                             '.dropdown-menu li', '.dropdown-menu button']));
    for (const pool of pools) {
      const hits = pool.filter((n) => {
        if (!visible(n)) return false;
        const t = norm(n.textContent).toLowerCase();
        return t && t.length <= 30 && RENAME_WORDS.some((w) => t.startsWith(w));
      });
      const deepest = hits.find((n) => !hits.some((o) => o !== n && n.contains(o)));
      if (deepest) return deepest;
    }
    return null;
  }

  // Only inputs inside a modal: a bare input[type=text] could be the chat box.
  function findDialogInput() {
    return deepQueryAll([
      '.ReactModalPortal input', '[role="dialog"] input',
      '.zm-modal input', '.zmu-modal input',
      '[class*="modal"] input', '[class*="dialog"] input',
    ]).find((i) => visible(i) && (!i.type || i.type === "text"));
  }

  function dialogOf(input) {
    return input.closest('[role="dialog"], .ReactModal__Content, ' +
                         '[class*="modal"], [class*="dialog"]') || document;
  }

  function clickInDialog(root, words) {
    for (const b of root.querySelectorAll('button, [role="button"]')) {
      if (!visible(b)) continue;
      const t = norm(b.textContent).toLowerCase();
      if (t && words.some((w) => t === w || t.startsWith(w))) {
        b.click();
        return true;
      }
    }
    return false;
  }

  function pressEscape() {
    for (const type of ["keydown", "keyup"]) {
      const ev = new KeyboardEvent(type, {
        key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true,
      });
      (document.activeElement || document.body).dispatchEvent(ev);
    }
    return true;
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
    await sleep(300);

    // Only the row's "More options" dropdown toggle. Never fall back to
    // other row buttons: those are Mute and Start Video.
    const more = [...row.querySelectorAll("button")].filter(visible).find((b) => {
      const h = hay(b);
      return /dropdown-toggle/i.test(b.className || "") ||
             h.includes("more") || h.includes("ещё") || h.includes("больше") ||
             h.includes("подробнее") || h.includes("більше");
    });
    if (!more) {
      toast("нет кнопки «More options» в строке");
      return;
    }

    // A menu left open by an earlier tick would be closed by clicking the
    // toggle again, so only click it when the Rename item is not already up.
    let item = findRenameItem();
    if (!item) {
      more.click();
      item = await waitFor(findRenameItem, 1500);
    }
    if (!item) {
      const portal = document.getElementById("zmu-portal-dropdown--participant-list");
      console.log("[ZoomWar] portal html: " +
        (portal ? portal.outerHTML.slice(0, 2500) : "NO PORTAL"));
      dumpMenu("after More options");
      pressEscape();
      toast("нет «Переименовать» — F12, смотри [ZoomWar]");
      return;
    }
    item.click();

    const input = await waitFor(findDialogInput, 2000);
    if (!input) {
      dumpMenu("rename dialog");
      toast("окно переименования не открылось — F12, смотри [ZoomWar]");
      return;
    }

    // STOP pressed while this rename was in flight: back out of the dialog
    // instead of saving one last name after the user turned it off.
    const dialog = dialogOf(input);
    if (!state.nameTimer) {
      clickInDialog(dialog, ["cancel", "отмена", "скасувати"]) || pressEscape();
      return;
    }

    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value").set;
    input.focus();
    setter.call(input, newName);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(150);

    const saved = clickInDialog(dialog, [
      "save", "rename", "change", "ok",
      "сохранить", "переименовать", "изменить", "ок",
      "зберегти", "перейменувати", "змінити",
    ]);
    if (!saved) {
      for (const type of ["keydown", "keyup"]) {
        input.dispatchEvent(new KeyboardEvent(type, {
          key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
        }));
      }
    }
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
