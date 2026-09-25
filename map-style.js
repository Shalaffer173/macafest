// Тёмная схема карты в духе Mapbox Dark — цвета сняты с реальных скриншотов.
// Векторные тайлы OpenFreeMap (схема OpenMapTiles): бесплатно и без API-ключа.

export const VECTOR_SOURCE = 'omt';

// Язык подписей на карте. Если перевода нет — берётся местное название.
const LABEL_LANG = 'ru';

export const COLORS = {
  land: '#272727',
  park: '#272425',
  water: '#1e1e1e',
  building: '#232323',
  roadMajor: '#3d3d3d',
  roadMid: '#3b3b3b',
  roadMinor: '#393939',
  roadService: '#333333',
  path: '#303030',
  rail: '#3a3a3a',
  labelStreet: '#acacac',
  labelArea: '#878787',
  labelWater: '#6c6c6c',
  labelCity: '#9a9a9a',
  halo: '#000000',
};

// Метки поверх карты: синяя точка курьера и зелёная линия маршрута.
export const COURIER_BLUE = '#36b4e4';
export const ROUTE_GREEN = '#2d8c5f';

export const ATTRIBUTION = {
  vector: 'OpenFreeMap © OpenMapTiles © OpenStreetMap',
  raster: '© CARTO © OpenStreetMap',
};

const NAME = ['coalesce', ['get', `name:${LABEL_LANG}`], ['get', 'name']];
const classIn = (...classes) => ['match', ['get', 'class'], classes, true, false];
const byZoom = (...stops) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops.flat()];
const roundLine = { 'line-cap': 'round', 'line-join': 'round' };
const halo = { 'text-halo-color': COLORS.halo, 'text-halo-width': 1.4 };

function road(id, classes, minzoom, color, width) {
  return {
    id,
    type: 'line',
    source: VECTOR_SOURCE,
    'source-layer': 'transportation',
    minzoom,
    filter: classIn(...classes),
    layout: roundLine,
    paint: { 'line-color': color, 'line-width': width },
  };
}

export function vectorStyle() {
  return {
    version: 8,
    name: 'Courier dark',
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      [VECTOR_SOURCE]: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': COLORS.land } },
      {
        id: 'landcover-green',
        type: 'fill',
        source: VECTOR_SOURCE,
        'source-layer': 'landcover',
        filter: classIn('wood', 'grass', 'wetland'),
        paint: { 'fill-color': COLORS.park },
      },
      {
        id: 'landuse-green',
        type: 'fill',
        source: VECTOR_SOURCE,
        'source-layer': 'landuse',
        filter: classIn('cemetery', 'stadium', 'pitch', 'playground', 'zoo', 'theme_park'),
        paint: { 'fill-color': COLORS.park },
      },
      {
        id: 'park',
        type: 'fill',
        source: VECTOR_SOURCE,
        'source-layer': 'park',
        paint: { 'fill-color': COLORS.park },
      },
      {
        id: 'water',
        type: 'fill',
        source: VECTOR_SOURCE,
        'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': COLORS.water },
      },
      {
        id: 'waterway',
        type: 'line',
        source: VECTOR_SOURCE,
        'source-layer': 'waterway',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        layout: roundLine,
        paint: { 'line-color': COLORS.water, 'line-width': byZoom([11, 0.5], [16, 2], [19, 6]) },
      },
      {
        id: 'building',
        type: 'fill',
        source: VECTOR_SOURCE,
        'source-layer': 'building',
        minzoom: 13,
        paint: { 'fill-color': COLORS.building },
      },

      road('road-path', ['path'], 14, COLORS.path, byZoom([14, 0.4], [15.5, 0.8], [18, 1.8])),
      road('road-service', ['service', 'track'], 13, COLORS.roadService, byZoom([13, 0.3], [15.5, 1.1], [18, 3.2])),
      road('road-minor', ['minor', 'busway'], 12, COLORS.roadMinor, byZoom([12, 0.4], [14, 0.9], [15.5, 1.8], [18, 5.5])),
      road('road-mid', ['secondary', 'tertiary'], 9, COLORS.roadMid, byZoom([9, 0.4], [13, 1.4], [15.5, 3.8], [18, 11])),
      road('road-major', ['primary', 'trunk', 'motorway'], 5, COLORS.roadMajor, byZoom([5, 0.4], [10, 0.9], [13, 2], [15.5, 5.8], [18, 16])),
      {
        id: 'rail',
        type: 'line',
        source: VECTOR_SOURCE,
        'source-layer': 'transportation',
        minzoom: 12,
        filter: classIn('rail', 'transit'),
        paint: {
          'line-color': COLORS.rail,
          'line-width': byZoom([12, 0.6], [16, 1.6], [19, 3]),
          'line-dasharray': [2, 2],
        },
      },

      {
        id: 'waterway-label',
        type: 'symbol',
        source: VECTOR_SOURCE,
        'source-layer': 'waterway',
        minzoom: 11,
        filter: ['has', 'name'],
        layout: {
          'symbol-placement': 'line',
          'text-field': NAME,
          'text-font': ['Noto Sans Italic'],
          'text-size': 12,
          'text-letter-spacing': 0.1,
          'symbol-spacing': 400,
        },
        paint: { 'text-color': COLORS.labelWater, ...halo },
      },
      {
        id: 'road-label',
        type: 'symbol',
        source: VECTOR_SOURCE,
        'source-layer': 'transportation_name',
        minzoom: 13,
        filter: ['all', ['has', 'name'], ['!', classIn('rail', 'transit', 'ferry', 'aerialway')]],
        layout: {
          'symbol-placement': 'line',
          'text-field': NAME,
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 12.5, 19, 15],
          'text-max-angle': 30,
          'text-letter-spacing': 0.02,
          'text-padding': 2,
          'symbol-spacing': 350,
        },
        paint: { 'text-color': COLORS.labelStreet, ...halo },
      },
      {
        id: 'poi-label',
        type: 'symbol',
        source: VECTOR_SOURCE,
        'source-layer': 'poi',
        minzoom: 15,
        filter: ['all', ['has', 'name'], ['<=', ['number', ['get', 'rank'], 99], 12]],
        layout: {
          'text-field': NAME,
          'text-font': ['Noto Sans Italic'],
          'text-size': 12.5,
          'text-max-width': 9,
          'text-padding': 4,
        },
        paint: { 'text-color': COLORS.labelArea, ...halo },
      },
      {
        id: 'place-area',
        type: 'symbol',
        source: VECTOR_SOURCE,
        'source-layer': 'place',
        minzoom: 11,
        filter: classIn('suburb', 'quarter', 'neighbourhood'),
        layout: {
          'text-field': NAME,
          'text-font': ['Noto Sans Italic'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 16, 13.5],
          'text-max-width': 8,
        },
        paint: { 'text-color': COLORS.labelArea, ...halo },
      },
      {
        id: 'place-city',
        type: 'symbol',
        source: VECTOR_SOURCE,
        'source-layer': 'place',
        maxzoom: 13,
        filter: classIn('city', 'town', 'village'),
        layout: {
          'text-field': NAME,
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 12, 17],
          'text-max-width': 8,
        },
        paint: { 'text-color': COLORS.labelCity, ...halo },
      },
    ],
  };
}

// Запасной вариант, если векторные тайлы недоступны: растровая тёмная карта CARTO.
export function rasterStyle() {
  return {
    version: 8,
    name: 'Courier dark (raster)',
    sources: {
      carto: {
        type: 'raster',
        tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png`),
        tileSize: 256,
        maxzoom: 20,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': COLORS.land } },
      {
        id: 'carto',
        type: 'raster',
        source: 'carto',
        paint: { 'raster-brightness-min': 0.12, 'raster-saturation': -1 },
      },
    ],
  };
}

// Слои меток: подложка-ореол, белое кольцо и синяя точка курьера, сверху — линия маршрута
// (как на оригинале, линия заходит в центр синей точки).
export const overlayLayers = [
  {
    id: 'courier-halo',
    type: 'circle',
    source: 'courier',
    paint: { 'circle-radius': 15, 'circle-color': COURIER_BLUE, 'circle-opacity': 0.2 },
  },
  {
    id: 'courier-ring',
    type: 'circle',
    source: 'courier',
    paint: { 'circle-radius': 8.6, 'circle-color': '#fbfdff' },
  },
  {
    id: 'courier-dot',
    type: 'circle',
    source: 'courier',
    paint: { 'circle-radius': 5.6, 'circle-color': COURIER_BLUE },
  },
  {
    id: 'route',
    type: 'line',
    source: 'route',
    layout: roundLine,
    paint: { 'line-color': ROUTE_GREEN, 'line-width': 2 },
  },
];
