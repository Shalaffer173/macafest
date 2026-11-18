// ZoomWar popup. Sends start/stop to the content script in the active Zoom
// tab; the loops themselves live in the content script so they survive the
// popup closing. UI field values persist in storage.

const $ = (id) => document.getElementById(id);
const api = (typeof browser !== "undefined") ? browser : chrome;

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(msg) {
  const tab = await activeTab();
  if (!tab || !/^https:\/\/[^/]*\.zoom\.us\//.test(tab.url || "")) {
    $("warn").style.display = "block";
    return null;
  }
  $("warn").style.display = "none";
  try {
    return await api.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    // Content script not in this tab (page loaded before install, etc.)
    $("warn").textContent = "Обнови вкладку Zoom (F5) и открой снова";
    $("warn").style.display = "block";
    return null;
  }
}

function setHandUI(on) {
  $("handStatus").textContent = on ? "СПАМИМ ✋" : "ВЫКЛ";
  $("handStatus").classList.toggle("on", on);
  $("handStart").disabled = on;
  $("handStop").disabled = !on;
}

function setNameUI(on) {
  $("nameStatus").textContent = on ? "МЕНЯЕМ ИМЯ" : "ВЫКЛ";
  $("nameStatus").classList.toggle("on", on);
  $("nameStart").disabled = on;
  $("nameStop").disabled = !on;
}

function readSettings() {
  return {
    handCd: parseFloat($("handCd").value) || 0.4,
    nameCd: parseFloat($("nameCd").value) || 1.0,
    nmode: document.querySelector('input[name="nmode"]:checked').value,
    names: $("names").value,
  };
}

function saveSettings() {
  api.storage.local.set({ zoomwar: readSettings() });
}

async function loadSettings() {
  const data = await api.storage.local.get("zoomwar");
  const s = data.zoomwar;
  if (!s) return;
  if (s.handCd) $("handCd").value = s.handCd;
  if (s.nameCd) $("nameCd").value = s.nameCd;
  if (s.names != null) $("names").value = s.names;
  if (s.nmode) {
    const r = document.querySelector(`input[name="nmode"][value="${s.nmode}"]`);
    if (r) r.checked = true;
  }
}

$("handStart").onclick = async () => {
  const cd = Math.max(0.1, parseFloat($("handCd").value) || 0.4);
  const res = await send({ type: "hand_start", cooldownMs: cd * 1000 });
  if (res) setHandUI(true);
  saveSettings();
};
$("handStop").onclick = async () => {
  await send({ type: "hand_stop" });
  setHandUI(false);
};

$("nameStart").onclick = async () => {
  const cd = Math.max(0.3, parseFloat($("nameCd").value) || 1.0);
  const mode = document.querySelector('input[name="nmode"]:checked').value;
  const names = $("names").value.split("\n").map((n) => n.trim())
    .filter(Boolean);
  if (mode === "manual" && names.length < 1) {
    $("warn").textContent = "Впиши хотя бы одно имя";
    $("warn").style.display = "block";
    return;
  }
  const res = await send({
    type: "name_start", mode, names, cooldownMs: cd * 1000,
  });
  if (res) setNameUI(true);
  saveSettings();
};
$("nameStop").onclick = async () => {
  await send({ type: "name_stop" });
  setNameUI(false);
};

for (const id of ["handCd", "nameCd", "names"]) {
  $(id).addEventListener("change", saveSettings);
}
for (const r of document.querySelectorAll('input[name="nmode"]')) {
  r.addEventListener("change", saveSettings);
}

(async function init() {
  await loadSettings();
  const st = await send({ type: "status" });
  if (st) {
    setHandUI(!!st.hand);
    setNameUI(!!st.name);
  }
})();
