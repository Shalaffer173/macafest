import { ATTRIBUTION, VECTOR_SOURCE, overlayLayers, rasterStyle, vectorStyle } from './map-style.js?v=5';

const MAPLIBRE_URL = 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.11.2/dist/maplibre-gl.mjs';
const STORAGE_KEY = 'dostavka:v1';

// Всё, что написано на панели. Меняется в приложении нажатием на нужную строку.
const DEFAULT_TEXT = {
  etaLabel: 'Доставлено через',
  eta: '22',
  etaUnit: 'хв',
  name: 'Олександр К.',
  code: 'KRWQT',
  itemsLabel: 'Товари',
  itemsCount: '3',
  viewLabel: 'Переглянути',
  addressLabel: 'Адреса',
  address: 'вулиця Набережна Перемоги 32, Дніпро',
  instructionsLabel: 'Інструкції',
  instructions: 'Залиште біля моїх дверей',
  noteLabel: 'Примітка',
  note: 'Під’їзд 2, 5 поверх',
  translate: 'Перекласти',
};

// Стартовый вид карты — Днепр, набережная.
const DEFAULT_VIEW = { center: [35.0745, 48.453], zoom: 14.5 };

const DEFAULT_SHEET_SHARE = 0.44; // сколько экрана занимает панель по умолчанию
const SHEET_MIN = 46; // ниже панель не опускается, чтобы ползунок оставался на экране
const SHEET_TOP_GAP = 12;
const DRAG_THRESHOLD = 6;

// Что открывается при нажатии на каждую часть панели.
const GROUPS = {
  eta: {
    title: 'Время доставки',
    fields: [
      { key: 'eta', label: 'Минуты (это же число будет на зелёной метке)', numeric: true },
      { key: 'etaLabel', label: 'Текст перед временем' },
      { key: 'etaUnit', label: 'Единица времени' },
    ],
  },
  customer: {
    title: 'Заказчик',
    fields: [
      { key: 'name', label: 'Имя' },
      { key: 'code', label: 'Код заказа (без #)', caps: true },
    ],
  },
  items: {
    title: 'Товары',
    fields: [
      { key: 'itemsCount', label: 'Количество', numeric: true },
      { key: 'itemsLabel', label: 'Надпись слева' },
      { key: 'viewLabel', label: 'Надпись справа' },
    ],
  },
  address: {
    title: 'Адрес',
    fields: [
      { key: 'address', label: 'Адрес', multiline: true },
      { key: 'addressLabel', label: 'Заголовок' },
    ],
  },
  instructions: {
    title: 'Инструкции',
    fields: [
      { key: 'instructions', label: 'Текст', multiline: true },
      { key: 'instructionsLabel', label: 'Заголовок' },
    ],
  },
  note: {
    title: 'Примечание',
    fields: [
      { key: 'note', label: 'Текст', multiline: true },
      { key: 'noteLabel', label: 'Заголовок' },
    ],
  },
  translate: {
    title: 'Зелёная надпись внизу',
    fields: [{ key: 'translate', label: 'Текст' }],
  },
};

const PLACE_HINT = {
  blue: 'Нажмите на карту, чтобы поставить синюю метку',
  green: 'Нажмите на карту, чтобы поставить зелёную метку',
};

const PIN_PATH = 'M16.58 46.83A24 24 0 1 1 31.42 46.83C27.8 48 25.2 49.3 25 52H23C22.8 49.3 20.2 48 16.58 46.83Z';

const $ = (id) => document.getElementById(id);
const round6 = (n) => Math.round(n * 1e6) / 1e6;

const state = loadState();

/* ---------- Хранение ---------- */

function loadState() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    // Хранилище недоступно — начинаем с настроек по умолчанию.
  }
  const text = { ...DEFAULT_TEXT };
  for (const key of Object.keys(text)) {
    if (typeof saved.text?.[key] === 'string') text[key] = saved.text[key];
  }
  return {
    text,
    markers: isMarkers(saved.markers) ? saved.markers : null,
    view: isView(saved.view) ? saved.view : DEFAULT_VIEW,
    sheetH: Number.isFinite(saved.sheetH) ? saved.sheetH : null,
  };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Приватный режим или нет места — работаем без сохранения.
  }
}

function isLngLat(p) {
  return Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
}

function isMarkers(m) {
  return Boolean(m) && typeof m === 'object' && ['blue', 'green'].every((k) => m[k] == null || isLngLat(m[k]));
}

function isView(v) {
  return Boolean(v) && isLngLat(v.center) && Number.isFinite(v.zoom);
}

/* ---------- Панель с заказом ---------- */

const pin = document.createElement('div');
pin.className = 'pin';
pin.innerHTML = `<svg viewBox="0 0 48 52" width="48" height="52" aria-hidden="true"><path d="${PIN_PATH}"/></svg><div class="pin__label"><span class="pin__num"></span><span class="pin__unit"></span></div>`;
const pinNum = pin.querySelector('.pin__num');
const pinUnit = pin.querySelector('.pin__unit');

function render() {
  const t = state.text;
  const values = {
    etaLabel: t.etaLabel,
    etaValue: [t.eta, t.etaUnit].filter(Boolean).join(' '),
    customer: [t.name, t.code && `#${t.code}`].filter(Boolean).join(' '),
    items: t.itemsCount ? `${t.itemsLabel} (${t.itemsCount})` : t.itemsLabel,
    viewLabel: t.viewLabel,
    addressLabel: t.addressLabel,
    address: t.address,
    instructionsLabel: t.instructionsLabel,
    instructions: t.instructions,
    noteLabel: t.noteLabel,
    note: t.note,
    translate: t.translate,
  };
  for (const el of document.querySelectorAll('[data-bind]')) {
    el.textContent = values[el.dataset.bind] ?? '';
  }

  // Время из «Доставлено через» показывается и на зелёной метке.
  pinNum.textContent = t.eta;
  pinUnit.textContent = t.etaUnit;
  const length = [...t.eta].length;
  pin.dataset.size = length >= 4 ? 's' : length === 3 ? 'm' : '';
}

const sheet = $('sheet');
let drag = null;
let suppressClickUntil = 0;

function sheetHeight() {
  const h = state.sheetH ?? Math.round(window.innerHeight * DEFAULT_SHEET_SHARE);
  return Math.min(Math.max(h, SHEET_MIN), window.innerHeight - SHEET_TOP_GAP);
}

function layoutSheet() {
  document.documentElement.style.setProperty('--sheet-h', `${sheetHeight()}px`);
}

// Панель двигается вверх-вниз, если потянуть за ползунок (или за любое место панели).
// Короткое нажатие без движения открывает редактирование строки.
sheet.addEventListener('pointerdown', (e) => {
  if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
  drag = { id: e.pointerId, startY: e.clientY, startH: sheetHeight(), moving: false };
});

sheet.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dy = e.clientY - drag.startY;
  if (!drag.moving) {
    if (Math.abs(dy) < DRAG_THRESHOLD) return;
    drag.moving = true;
    sheet.setPointerCapture(e.pointerId);
    sheet.classList.add('is-dragging');
  }
  state.sheetH = drag.startH - dy;
  layoutSheet();
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  if (drag.moving) {
    state.sheetH = sheetHeight();
    saveState();
    sheet.classList.remove('is-dragging');
    suppressClickUntil = performance.now() + 350;
  }
  drag = null;
}

sheet.addEventListener('pointerup', endDrag);
sheet.addEventListener('pointercancel', endDrag);

sheet.addEventListener('click', (e) => {
  if (performance.now() < suppressClickUntil) return;
  const target = e.target.closest('[data-edit]');
  if (target) openEditor(target.dataset.edit);
});

window.addEventListener('resize', layoutSheet);

/* ---------- Окно редактирования ---------- */

const editor = $('editor');
const editorForm = $('editor-form');

function openEditor(groupId) {
  const group = GROUPS[groupId];
  if (!group) return;
  setPlacing(null);
  $('editor-title').textContent = group.title;
  $('editor-fields').replaceChildren(...group.fields.map(fieldRow));
  editor.hidden = false;

  const first = editorForm.querySelector('.fld__input');
  first.focus();
  if (first.tagName === 'INPUT') first.select();
  else first.setSelectionRange(first.value.length, first.value.length);
}

function fieldRow(field) {
  const row = document.createElement('label');
  row.className = 'fld';

  const caption = document.createElement('span');
  caption.className = 'fld__label';
  caption.textContent = field.label;

  const input = document.createElement(field.multiline ? 'textarea' : 'input');
  input.className = 'fld__input';
  input.name = field.key;
  input.value = state.text[field.key];
  input.autocomplete = 'off';
  input.spellcheck = false;
  if (field.multiline) {
    input.rows = 3;
  } else {
    input.type = 'text';
    input.enterKeyHint = 'done';
  }
  if (field.numeric) input.inputMode = 'numeric';
  if (field.caps) input.autocapitalize = 'characters';

  row.append(caption, input);
  return row;
}

function closeEditor() {
  editor.hidden = true;
  document.activeElement?.blur();
}

function cleanValue(key, value) {
  const v = value.replace(/\r\n?/g, '\n').trim();
  return key === 'code' ? v.replace(/^#+\s*/, '') : v;
}

editorForm.addEventListener('submit', (e) => {
  e.preventDefault();
  for (const input of editorForm.querySelectorAll('.fld__input')) {
    state.text[input.name] = cleanValue(input.name, input.value);
  }
  saveState();
  render();
  closeEditor();
});

editor.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeEditor();
});

/* ---------- Установка меток ---------- */

const hint = $('hint');
const placeButtons = { blue: $('place-blue'), green: $('place-green') };
let placing = null;

function setPlacing(kind) {
  placing = kind;
  for (const [k, button] of Object.entries(placeButtons)) {
    button.classList.toggle('is-active', k === kind);
  }
  document.body.classList.toggle('is-placing', Boolean(kind));
  hint.hidden = !kind;
  if (kind) {
    hint.dataset.kind = kind;
    $('hint-text').textContent = PLACE_HINT[kind];
  }
}

// Верхняя правая кнопка — синяя метка, кнопка под ней — зелёная.
for (const [kind, button] of Object.entries(placeButtons)) {
  button.addEventListener('click', () => setPlacing(placing === kind ? null : kind));
}
hint.addEventListener('click', () => setPlacing(null));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!editor.hidden) closeEditor();
  else setPlacing(null);
});

document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('input, textarea')) e.preventDefault();
});

/* ---------- Карта ---------- */

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
}

function setAttribution(text) {
  $('attribution').textContent = text;
}

function featureCollection(features) {
  return { type: 'FeatureCollection', features };
}

function courierData() {
  const { blue } = state.markers ?? {};
  return featureCollection(blue ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: blue } }] : []);
}

function routeData() {
  const { blue, green } = state.markers ?? {};
  return featureCollection(
    blue && green ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [blue, green] } }] : [],
  );
}

function withOverlays(style) {
  return {
    ...style,
    sources: {
      ...style.sources,
      courier: { type: 'geojson', data: courierData() },
      route: { type: 'geojson', data: routeData() },
    },
    layers: [...style.layers, ...overlayLayers],
  };
}

// Точка, смещённая на (dx, dy) пикселей от центра карты (Web Mercator, как у MapLibre).
function offsetLngLat([lng, lat], zoom, dx, dy) {
  const world = 512 * 2 ** zoom;
  const x = ((lng + 180) / 360) * world + dx;
  const y = (0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI)) * world + dy;
  return [
    round6((x / world) * 360 - 180),
    round6((Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / world))) * 180) / Math.PI),
  ];
}

// Где стоят метки при первом запуске — примерно как на скриншоте:
// зелёная слева от кнопок справа вверху, синяя над панелью.
function defaultMarkers() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const at = (x, y) => offsetLngLat(state.view.center, state.view.zoom, x - w / 2, y - h / 2);
  return { blue: at(w * 0.26, h * 0.53), green: at(w - 103, h * 0.106) };
}

async function initMap() {
  let maplibregl;
  try {
    maplibregl = await import(MAPLIBRE_URL);
  } catch (err) {
    console.error(err);
    toast('Не удалось загрузить карту — проверьте интернет');
    return;
  }

  if (!state.markers) {
    state.markers = defaultMarkers();
    saveState();
  }

  let map;
  try {
    map = new maplibregl.Map({
      container: 'map',
      style: withOverlays(vectorStyle()),
      center: state.view.center,
      zoom: state.view.zoom,
      minZoom: 3,
      maxZoom: 19,
      maxPitch: 0,
      attributionControl: false,
      // Карту можно двигать и масштабировать, но не поворачивать и не наклонять.
      dragPan: true,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      keyboard: false,
      boxZoom: false,
      touchZoomRotate: true,
      scrollZoom: true,
      doubleClickZoom: true,
    });
  } catch (err) {
    console.error(err);
    toast('Этот браузер не может показать карту');
    return;
  }
  map.touchZoomRotate.disableRotation();

  const pinMarker = new maplibregl.Marker({ element: pin, anchor: 'bottom' });

  function sync() {
    map.getSource('courier')?.setData(courierData());
    map.getSource('route')?.setData(routeData());
    if (state.markers.green) pinMarker.setLngLat(state.markers.green).addTo(map);
    else pinMarker.remove();
  }

  sync();
  map.on('style.load', sync);

  map.on('click', (e) => {
    if (!placing) return;
    state.markers = { ...state.markers, [placing]: [round6(e.lngLat.lng), round6(e.lngLat.lat)] };
    saveState();
    sync();
    setPlacing(null);
  });

  map.on('moveend', () => {
    const { lng, lat } = map.getCenter();
    state.view = { center: [round6(lng), round6(lat)], zoom: Math.round(map.getZoom() * 1000) / 1000 };
    saveState();
  });

  // Если векторные тайлы недоступны, переключаемся на растровую тёмную карту.
  let vectorTilesLoaded = false;
  let usingFallback = false;
  map.on('sourcedata', (e) => {
    if (e.sourceId === VECTOR_SOURCE && e.tile) vectorTilesLoaded = true;
  });
  map.on('error', (e) => {
    console.warn(e.error ?? e);
    if (usingFallback || vectorTilesLoaded || e.sourceId !== VECTOR_SOURCE) return;
    usingFallback = true;
    map.setStyle(withOverlays(rasterStyle()), { diff: false });
    setAttribution(ATTRIBUTION.raster);
  });
}

render();
layoutSheet();
setAttribution(ATTRIBUTION.vector);
initMap();
