// ZoomWar content script.
// Runs inside the Zoom web client and does the DOM work. The popup only
// sends start/stop messages; the loops live here so they keep running
// after the popup closes. Guarded against double-injection into the frame.

if (!window.__zoomwar_loaded) {
  window.__zoomwar_loaded = true;

  const state = {
    handTimer: null,
    nameTimer: null,
    lastParticipants: [],
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").trim();
  const isMe = (t) => /\(\s*(me|я|вы)\s*\)/i.test(t);

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
      } catch (e) {
        /* bad selector, skip */
      }
    }
    return out;
  }

  // ---------------- HAND RAISE ----------------
  function findHandButton() {
    const labels = [
      "raise hand", "lower hand", "raise your hand",
      "поднять руку", "опустить руку", "поднимите руку",
    ];
    const buttons = queryAll(['button', '[role="button"]', '[aria-label]']);
    for (const b of buttons) {
      if (!visible(b)) continue;
      const label = ((b.getAttribute("aria-label") || "") + " " +
                     (b.textContent || "")).toLowerCase();
      if (labels.some((l) => label.includes(l))) return b;
    }
    return null;
  }

  function sendAltY() {
    // Fallback: Zoom web toggles the hand with Alt+Y.
    for (const type of ["keydown", "keyup"]) {
      const ev = new KeyboardEvent(type, {
        key: "y", code: "KeyY", keyCode: 89, which: 89,
        altKey: true, bubbles: true, cancelable: true,
      });
      (document.activeElement || document.body).dispatchEvent(ev);
      document.dispatchEvent(ev);
    }
  }

  function pokeHand() {
    const btn = findHandButton();
    if (btn) btn.click();
    else sendAltY();
  }

  function startHand(cooldownMs) {
    stopHand();
    state.handTimer = setInterval(() => {
      try { pokeHand(); } catch (e) { /* keep looping */ }
    }, cooldownMs);
  }

  function stopHand() {
    if (state.handTimer) clearInterval(state.handTimer);
    state.handTimer = null;
  }

  // ---------------- PARTICIPANTS / RENAME ----------------
  function openParticipantsPanel() {
    const panel = queryAll([
      '.participants-section-container',
      '[aria-label*="Participants panel"]',
      '#participants-list', '.participants-ul',
      '[class*="participants-list"]', '[class*="ParticipantsList"]',
    ]).find(visible);
    if (panel) return true;
    const btn = queryAll([
      '[aria-label*="Participants"]', '[aria-label*="participant"]',
      'button[data-testid="participants-button"]',
      '[aria-label*="частник"]', '[aria-label*="Участник"]',
    ]).find(visible);
    if (btn) { btn.click(); return true; }
    return false;
  }

  function scrapeParticipants() {
    openParticipantsPanel();
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
      const els = queryAll([sel]);
      for (const el of els) {
        const t = norm(el.textContent);
        if (t && t.length > 1 && !isMe(t)) names.push(t);
      }
      if (names.length) break;
    }
    const junk = ["mute", "unmute", "more", "host", "ещё", "еще", "host,",
                  "co-host", "соорганизатор", "организатор"];
    const clean = names.filter(
      (t) => !junk.some((k) => t.toLowerCase().includes(k))
    );
    state.lastParticipants = [...new Set(clean.length ? clean : names)];
    return state.lastParticipants;
  }

  function findMeRow() {
    const nodes = queryAll(['span', 'div', 'li', '[class*="participant"]']);
    for (const n of nodes) {
      if (isMe(norm(n.textContent)) && norm(n.textContent).length < 60) {
        let row = n;
        for (let i = 0; i < 6 && row; i++) {
          const cls = (row.getAttribute && row.getAttribute("class")) || "";
          if (/participant/i.test(cls)) return row;
          row = row.parentElement;
        }
        return n.closest('li') || n.parentElement;
      }
    }
    return null;
  }

  function clickByText(words) {
    const nodes = queryAll(['a', 'span', 'div', 'li', 'button',
                            '[role="menuitem"]']);
    for (const n of nodes) {
      const t = norm(n.textContent).toLowerCase();
      if (t && t.length < 40 && words.some((w) => t === w || t.includes(w))) {
        if (visible(n)) { n.click(); return true; }
      }
    }
    return false;
  }

  async function renameMe(newName) {
    openParticipantsPanel();
    await sleep(150);
    const row = findMeRow();
    if (!row) return;

    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await sleep(200);

    const more = row.querySelector(
      '[aria-label*="More"], [aria-label*="ещё"], [aria-label*="Ещё"], ' +
      'button.more-button, [data-testid="more-button"], ' +
      '.participants-item__buttons button'
    );
    if (more) { more.click(); await sleep(200); }

    if (!clickByText(["rename", "переименовать"])) return;
    await sleep(200);

    const input = queryAll([
      'input[aria-label*="name"]', 'input[aria-label*="имя"]',
      '.zm-modal input[type="text"]', 'input.rename-input',
      'input[placeholder*="name"]', 'input[placeholder*="имя"]',
      '.zmu-modal input', '[role="dialog"] input[type="text"]',
    ]).find(visible);
    if (!input) return;

    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value").set;
    setter.call(input, newName);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(120);

    clickByText(["ok", "save", "сохранить", "ок", "rename", "переименовать"]);
  }

  function startName(mode, manualNames, cooldownMs) {
    stopName();
    const tick = async () => {
      try {
        let pool = manualNames;
        if (mode === "auto") pool = scrapeParticipants();
        if (pool && pool.length) {
          await renameMe(pool[Math.floor(Math.random() * pool.length)]);
        }
      } catch (e) { /* keep looping */ }
    };
    tick();
    state.nameTimer = setInterval(tick, cooldownMs);
  }

  function stopName() {
    if (state.nameTimer) clearInterval(state.nameTimer);
    state.nameTimer = null;
  }

  // ---------------- MESSAGING ----------------
  browser.runtime.onMessage.addListener((msg) => {
    switch (msg && msg.type) {
      case "hand_start": startHand(msg.cooldownMs); break;
      case "hand_stop": stopHand(); break;
      case "name_start":
        startName(msg.mode, msg.names || [], msg.cooldownMs); break;
      case "name_stop": stopName(); break;
      case "status":
        return Promise.resolve({
          hand: !!state.handTimer,
          name: !!state.nameTimer,
          participants: state.lastParticipants,
        });
    }
    return Promise.resolve({ ok: true });
  });
}
