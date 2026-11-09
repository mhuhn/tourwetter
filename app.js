/* Tourwetter – Wetter entlang einer GPX-Route für verschiedene Abfahrtszeiten */
'use strict';

/* ---------- Reine Logik (auch in Node testbar) ---------- */

const STEP_MIN = 15;          // ein Wetterpunkt alle 15 Minuten Fahrzeit
const START_COLUMNS = 48;     // Abfahrtszeiten: jetzt … +47 h
const LEVELS = [1, 2, 4, 8];
const HOT_THRESHOLD = 22;     // °C: darüber zählt beim Zusammenfassen das Maximum
const MAX_LOCATIONS_PER_REQUEST = 50;
const WPT_EXCLUSION_MIN = 10; // Regelpunkte näher als 10 min an einem Wegpunkt entfallen

function childText(el, localName) {
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && c.localName === localName) return c.textContent.trim();
  }
  return '';
}

/**
 * GPX-Text aus beliebigem eingefügtem Inhalt herauslösen:
 * Text drumherum, HTML-maskiertes XML oder Base64 (z. B. aus dem Kurzbefehl „Base64-codieren“).
 * Liefert den reinen GPX-Text oder null.
 */
function extractGpxText(raw) {
  if (raw == null) return null;
  let t = String(raw).replace(/^\uFEFF/, '').trim();
  const cut = str => {
    const g = str.indexOf('<gpx');
    if (g < 0) return null;
    const x = str.lastIndexOf('<?xml', g);
    const start = x >= 0 ? x : g;
    const endTag = str.lastIndexOf('</gpx>');
    return endTag > start ? str.slice(start, endTag + 6) : str.slice(start);
  };
  let found = cut(t);
  if (found) return found;
  if (/&lt;gpx/i.test(t)) {
    found = cut(t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&'));
    if (found) return found;
  }
  // Base64 (auch URL-sicher und mit Zeilenumbrüchen)
  const b64 = t.replace(/\s+/g, '');
  if (b64.length >= 40 && /^[A-Za-z0-9+/_-]+=*$/.test(b64)) {
    try {
      const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(norm + '==='.slice((norm.length + 3) % 4));
      const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
      const decoded = new TextDecoder('utf-8').decode(bytes);
      found = cut(decoded.replace(/^\uFEFF/, ''));
      if (found) return found;
    } catch (e) { /* kein Base64 */ }
  }
  return null;
}

/** Kurze, sichere Vorschau des eingefügten Inhalts für Fehlermeldungen. */
function pastePreview(raw) {
  const t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  return '„' + (t.length > 60 ? t.slice(0, 60) + '…' : t) + '“ (' + String(raw || '').length + ' Zeichen)';
}

function parseGpx(text, DOMParserImpl) {
  const Parser = DOMParserImpl || DOMParser;
  const doc = new Parser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Der eingefügte Text ist kein gültiges GPX/XML.');
  }
  const points = [];
  let name = '';
  const trks = doc.getElementsByTagNameNS('*', 'trk');
  for (let i = 0; i < trks.length; i++) {
    const trk = trks[i];
    if (!name) {
      for (let c = trk.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1 && c.localName === 'name') { name = c.textContent.trim(); break; }
      }
    }
    const segs = trk.getElementsByTagNameNS('*', 'trkseg');
    for (let s = 0; s < segs.length; s++) {
      const pts = segs[s].getElementsByTagNameNS('*', 'trkpt');
      for (let p = 0; p < pts.length; p++) {
        const el = pts[p];
        const lat = parseFloat(el.getAttribute('lat'));
        const lon = parseFloat(el.getAttribute('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const eleEl = el.getElementsByTagNameNS('*', 'ele')[0];
        const ele = eleEl ? parseFloat(eleEl.textContent) : NaN;
        const timeEl = el.getElementsByTagNameNS('*', 'time')[0];
        const ms = timeEl ? Date.parse(timeEl.textContent.trim()) : NaN;
        points.push({ lat, lon, ele, time: Number.isFinite(ms) ? ms / 1000 : NaN });
      }
    }
  }
  if (!name) {
    const md = doc.getElementsByTagNameNS('*', 'metadata')[0];
    const n = md && md.getElementsByTagNameNS('*', 'name')[0];
    if (n) name = n.textContent.trim();
  }
  if (points.length < 2) throw new Error('Keine Trackpunkte (trk/trkseg/trkpt) im GPX gefunden.');
  const waypoints = [];
  const wpts = doc.getElementsByTagNameNS('*', 'wpt');
  for (let i = 0; i < wpts.length; i++) {
    const el = wpts[i];
    const lat = parseFloat(el.getAttribute('lat'));
    const lon = parseFloat(el.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // Nur Wegpunkte mit Flaggen-Symbol (<sym>Flag…</sym>)
    if (!/^flag/i.test(childText(el, 'sym'))) continue;
    const ele = parseFloat(childText(el, 'ele'));
    waypoints.push({ lat, lon, ele, name: childText(el, 'name') || 'Wegpunkt ' + (waypoints.length + 1) });
  }
  return { name, points, waypoints };
}

/**
 * Wegpunkte auf die Route abbilden: nächstgelegener Trackpunkt, bei mehreren ähnlich nahen
 * (z. B. Rundtour) der erste ab dem vorigen Wegpunkt, damit die Reihenfolge stimmt.
 */
function locateWaypoints(points, waypoints) {
  let prev = 0;
  return waypoints.map(w => {
    const dists = points.map(p => haversineKm(p, w));
    let best = 0;
    for (let i = 1; i < dists.length; i++) if (dists[i] < dists[best]) best = i;
    const tol = dists[best] + 0.1;
    let idx = best;
    for (let i = prev; i < dists.length; i++) { if (dists[i] <= tol) { idx = i; break; } }
    prev = idx;
    return { ...w, idx, offRouteKm: dists[idx] };
  });
}

/** Kurs von a nach b in Grad (0 = Nord, 90 = Ost). */
function bearingDeg(a, b) {
  const toRad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * toRad) * Math.cos(b.lat * toRad);
  const x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
    Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lon - a.lon) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/** Fahrtrichtung je Punkt: vom vorherigen zum nachfolgenden Punkt (an den Enden zum/vom Nachbarn). */
function withBearings(samples) {
  return samples.map((s, i) => {
    const a = samples[i - 1] || s;
    const b = samples[i + 1] || s;
    const ok = a !== b && (a.lat !== b.lat || a.lon !== b.lon);
    return { ...s, bearing: ok ? bearingDeg(a, b) : null };
  });
}

function haversineKm(a, b) {
  const R = 6371.0088;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function routeStats(points) {
  const cum = [0];
  let ascent = 0;
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + haversineKm(points[i - 1], points[i]));
    const d = points[i].ele - points[i - 1].ele;
    if (d > 0) ascent += d;
  }
  return { cum, totalKm: cum[cum.length - 1], ascent: Math.round(ascent) };
}

/**
 * Wegpunkte, die weniger als 10 min auseinander liegen, zu einer Zeile zusammenfassen:
 * Werte des ersten (bei mehr als zwei: des mittleren), Namen mit „ / “ verbunden.
 */
function mergeCloseWaypoints(wpts) {
  const sorted = wpts.slice().sort((a, b) => a.tMin - b.tMin);
  const groups = [];
  for (const w of sorted) {
    const g = groups[groups.length - 1];
    if (g && w.tMin - g[g.length - 1].tMin < WPT_EXCLUSION_MIN) g.push(w); else groups.push([w]);
  }
  return groups.map(g => {
    const rep = g.length <= 2 ? g[0] : g[Math.floor((g.length - 1) / 2)];
    return { ...rep, name: g.map(w => w.name).join(' / ') };
  });
}

/** Fahrzeit (Minuten seit Start) je Trackpunkt aus den GPX-Zeiten, oder null, wenn unbrauchbar. */
function gpxTimeline(points, totalKm) {
  if (!points.every(p => Number.isFinite(p.time))) return null;
  const t0 = points[0].time;
  const mins = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && points[i].time < points[i - 1].time) return null; // nicht monoton
    mins.push((points[i].time - t0) / 60);
  }
  const durationMin = mins[mins.length - 1];
  if (!(durationMin > 0)) return null;
  const avgKmh = totalKm / (durationMin / 60);
  if (avgKmh < 1 || avgKmh > 80) return null; // unplausibel
  return mins;
}

/**
 * Wetterpunkte alle STEP_MIN Minuten Fahrzeit (plus Zielpunkt).
 * Fahrzeit aus den GPX-Zeiten, falls vorhanden und plausibel, sonst konstante Geschwindigkeit.
 */
function samplePoints(points, speedKmh, stepMin = STEP_MIN, waypoints = []) {
  const { cum, totalKm } = routeStats(points);
  const timeline = gpxTimeline(points, totalKm);
  const usesGpxTime = !!timeline;
  // Fahrzeit je Trackpunkt in Minuten
  const tm = timeline || cum.map(d => d / speedKmh * 60);
  const durationMin = tm[tm.length - 1];
  const offsets = [];
  for (let t = 0; t <= durationMin + 1e-9; t += stepMin) offsets.push(t);
  if (durationMin - offsets[offsets.length - 1] > stepMin / 3) offsets.push(durationMin);
  const hasEle = points.every(p => Number.isFinite(p.ele));
  const out = [];
  let j = 0;
  for (const tMin of offsets) {
    const t = Math.min(durationMin, tMin);
    while (j < tm.length - 2 && tm[j + 1] < t) j++;
    const a = points[j], b = points[j + 1];
    const span = tm[j + 1] - tm[j];
    const f = span > 0 ? Math.min(1, Math.max(0, (t - tm[j]) / span)) : 0;
    out.push({
      lat: a.lat + (b.lat - a.lat) * f,
      lon: a.lon + (b.lon - a.lon) * f,
      ele: hasEle ? a.ele + (b.ele - a.ele) * f : NaN,
      km: cum[j] + (cum[j + 1] - cum[j]) * f,
      tMin
    });
  }
  let samples = out;
  if (waypoints && waypoints.length) {
    const located = locateWaypoints(points, waypoints).map(w => ({
      lat: w.lat,
      lon: w.lon,
      ele: hasEle ? (Number.isFinite(w.ele) ? w.ele : points[w.idx].ele) : NaN,
      km: cum[w.idx],
      tMin: tm[w.idx],
      name: w.name
    }));
    const kept = out.filter(s => located.every(w => Math.abs(s.tMin - w.tMin) >= WPT_EXCLUSION_MIN));
    samples = kept.concat(mergeCloseWaypoints(located)).sort((a, b) => a.tMin - b.tMin || (a.name ? 1 : -1));
  }
  return { samples: withBearings(samples), totalKm, durationMin, hasEle, usesGpxTime };
}

function buildForecastUrls(samples, hoursNeeded) {
  const urls = [];
  for (let i = 0; i < samples.length; i += MAX_LOCATIONS_PER_REQUEST) {
    const chunk = samples.slice(i, i + MAX_LOCATIONS_PER_REQUEST);
    const params = new URLSearchParams({
      latitude: chunk.map(s => s.lat.toFixed(5)).join(','),
      longitude: chunk.map(s => s.lon.toFixed(5)).join(','),
      hourly: 'temperature_2m,precipitation,wind_speed_10m,wind_direction_10m',
      wind_speed_unit: 'kmh',
      timeformat: 'unixtime',
      timezone: 'GMT',
      past_hours: '2',
      forecast_hours: String(hoursNeeded)
    });
    if (chunk.every(s => Number.isFinite(s.ele))) {
      params.set('elevation', chunk.map(s => Math.round(s.ele)).join(','));
    }
    urls.push('https://api.open-meteo.com/v1/forecast?' + params.toString());
  }
  return urls;
}

/** Wert der Stundenreihe zum Zeitpunkt ts (Unix-Sekunden). */
function valueAt(series, ts) {
  const times = series.time;
  if (!times || !times.length) return null;
  const first = times[0];
  const last = times[times.length - 1];
  if (ts < first - 1800 || ts > last + 1800) return null;
  // Temperatur & Wind: nächstgelegene Stunde (Momentanwerte)
  const iNear = Math.max(0, Math.min(times.length - 1, Math.round((ts - first) / 3600)));
  // Niederschlag: Summe der vorangegangenen Stunde → Stunde, die den Zeitpunkt enthält
  const iRain = Math.max(0, Math.min(times.length - 1, Math.ceil((ts - first) / 3600)));
  const t = series.temperature_2m[iNear];
  const w = series.wind_speed_10m[iNear];
  const r = series.precipitation[iRain];
  const dirs = series.wind_direction_10m;
  const d = dirs ? dirs[iNear] : null;
  if (t == null || w == null || r == null) return null;
  return { t, r, w, d: d == null ? null : d };
}

/** Extremwerte der gesamten (ungezoomten) Matrix für die Farb- und Größenskalen. */
function matrixExtremes(matrix) {
  let minT = Infinity, maxT = -Infinity, maxR = 0, maxW = 0;
  for (const row of matrix.rows) for (const c of row) {
    if (!c) continue;
    if (c.t < minT) minT = c.t;
    if (c.t > maxT) maxT = c.t;
    if (c.r > maxR) maxR = c.r;
    if (c.w > maxW) maxW = c.w;
  }
  return { minT, maxT, maxR, maxW };
}

const MIN_TEMP_SPAN = 3; // °C: kleinere Spannen werden nicht weiter aufgespreizt (Rauschen)

/**
 * Skalen: Blau unter 20 °C, Rot-Orange über 25 °C – jeweils auf die tatsächliche Spanne
 * der Matrix aufgespreizt, damit auch kleine Unterschiede (z. B. 5–10 °C) deutlich werden.
 * Regen-Maximum ≥ 4 mm/h, Wind-Maximum ≥ 40 km/h.
 */
function scalesFor(ext) {
  const coldTop = Math.min(20, ext.maxT);                         // wärmster „kalter“ Wert → hellstes Blau
  const coldBottom = Math.min(ext.minT, coldTop - MIN_TEMP_SPAN); // kältester Wert → kräftigstes Blau
  const hotBottom = Math.max(25, ext.minT);                       // kühlster „warmer“ Wert → hellstes Orange
  const hotTop = Math.max(ext.maxT, hotBottom + MIN_TEMP_SPAN);   // wärmster Wert → dunkelstes Rot-Orange
  return {
    coldTop, coldBottom, hotBottom, hotTop,
    rainRef: Math.max(4, ext.maxR),
    windRef: Math.max(40, ext.maxW)
  };
}

function cellStyle(c, sc) {
  const clamp01 = x => Math.max(0, Math.min(1, x));
  let tone = null, f = 0;
  if (c.t < 20) { tone = 'cold'; f = clamp01((sc.coldTop - c.t) / Math.max(0.1, sc.coldTop - sc.coldBottom)); }
  else if (c.t > 25) { tone = 'hot'; f = clamp01((c.t - sc.hotBottom) / Math.max(0.1, sc.hotTop - sc.hotBottom)); }
  const rainF = c.r >= 0.05 ? clamp01(c.r / sc.rainRef) : 0;
  const windF = c.w >= 3 ? clamp01(c.w / sc.windRef) : 0;
  return { tone, f, rainF, windF };
}

// Mehrstufige Farbverläufe mit klaren Helligkeitsschritten (hell → kräftig)
const COLD_STOPS = [[226, 238, 250], [160, 196, 238], [96, 146, 222], [46, 92, 186], [22, 44, 120]];
const HOT_STOPS = [[253, 232, 214], [249, 186, 140], [238, 128, 74], [214, 78, 30], [150, 36, 12]];

function rampColor(stops, f) {
  const x = Math.max(0, Math.min(1, f)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const k = x - i;
  return stops[i].map((v, j) => Math.round(v + (stops[i + 1][j] - v) * k));
}

/** Hintergrundfarbe für eine Temperatur-Zelle oder null (neutral 20–25 °C). */
function tempFill(st) {
  if (!st.tone) return null;
  const rgb = rampColor(st.tone === 'cold' ? COLD_STOPS : HOT_STOPS, st.f);
  return { css: 'rgb(' + rgb.join(',') + ')', dark: st.f > 0.55 };
}

/** Rohmatrix: Zeilen = Tourpunkte, Spalten = Abfahrtszeiten (jetzt + h Stunden). */
/**
 * Ankunftszeit eines Punkts bei Abfahrt st: Fahrzeit inkl. Zeilen-Pausen (tEff),
 * plus Uhrzeit-Pausen [{ at, h }]: Startet die Fahrt vor `at` und wäre man nach `at` dort,
 * verschiebt sich die Ankunft um h Stunden.
 */
function arrivalTime(st, tMinEff, clockPauses) {
  let arr = st + tMinEff * 60;
  const startRounded = roundTo30(st);
  for (const cp of clockPauses || []) {
    if (startRounded < cp.at && arr > cp.at) arr += cp.h * 3600;
  }
  return arr;
}

/** Wind relativ zur Fahrtrichtung ergänzen (rd: woher, 0 = von vorn, 90 = von rechts) und in Anteile zerlegen. */
function withWind(v, bearing) {
  if (!v) return v;
  v.rd = (v.d != null && bearing != null) ? ((v.d - bearing) % 360 + 360) % 360 : null;
  // Anteile in km/h: hw > 0 Gegenwind, < 0 Rückenwind; cw > 0 von rechts, < 0 von links
  const rad = v.rd == null ? null : v.rd * Math.PI / 180;
  v.hw = rad == null ? null : v.w * Math.cos(rad);
  v.cw = rad == null ? null : v.w * Math.sin(rad);
  return v;
}

/** Stundenwerte während eines Zeitfensters (jeweils zur Mitte jeder Stunde). */
function windowValues(series, t0, hours, bearing) {
  const out = [];
  for (let k = 0; k < hours; k++) out.push(withWind(valueAt(series, t0 + (k + 0.5) * 3600), bearing));
  return out;
}

/**
 * Wetter während der Pausen (Rohwerte, je Zelle später zusammengefasst):
 *  row[i][c] – Zeilenpause nach Punkt i bei Abfahrt c: am Ort von i ab Ankunft für die Pausendauer
 *  col[k][r] – Uhrzeit-Pause k: an Punkt r während des Pausenzeitraums
 */
function pauseData(samples, weather, starts, rowPauses, clockPauses) {
  const cps = clockPauses.slice().sort((a, b) => a.at - b.at);
  const row = {};
  for (const key of Object.keys(rowPauses || {})) {
    const i = +key, h = rowPauses[key];
    const s = samples[i];
    if (!h || !s || !weather[i]) continue;
    row[i] = starts.map(st => windowValues(weather[i], arrivalTime(st, s.tEff != null ? s.tEff : s.tMin, cps), h, s.bearing));
  }
  const col = cps.map(cp => samples.map((s, r) => windowValues(weather[r], cp.at, cp.h, s.bearing)));
  return { row, col, cps };
}

function buildMatrix(samples, weather, nowSec, columns = START_COLUMNS, clockPauses = []) {
  const starts = [];
  for (let h = 0; h < columns; h++) starts.push(nowSec + h * 3600);
  const cps = clockPauses.slice().sort((a, b) => a.at - b.at);
  // tEff = Fahrzeit inkl. vorher eingelegter Zeilen-Pausen
  const rows = samples.map((s, i) => starts.map(st =>
    withWind(valueAt(weather[i], arrivalTime(st, s.tEff != null ? s.tEff : s.tMin, cps)), s.bearing)));
  return { starts, rows };
}

function aggregate(cells) {
  const v = cells.filter(Boolean);
  if (!v.length) return null;
  const temps = v.map(c => c.t);
  const max = Math.max(...temps);
  const min = Math.min(...temps);
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const meanOf = key => {
    const xs = v.map(c => c[key]).filter(x => x != null);
    return xs.length ? mean(xs) : null;
  };
  // Richtungen: nach Windstärke gewichtetes Vektormittel
  const meanDir = key => {
    let u = 0, n = 0;
    for (const c of v) {
      if (c[key] == null) continue;
      const rad = c[key] * Math.PI / 180;
      u += Math.sin(rad) * c.w; n += Math.cos(rad) * c.w;
    }
    if (u === 0 && n === 0) { const f = v.find(c => c[key] != null); return f ? f[key] : null; }
    return (Math.atan2(u, n) * 180 / Math.PI + 360) % 360;
  };
  return {
    t: max > HOT_THRESHOLD ? max : min,
    r: mean(v.map(c => c.r)),
    w: mean(v.map(c => c.w)),
    d: meanDir('d'),
    rd: meanDir('rd'),
    hw: meanOf('hw'),
    cw: meanOf('cw')
  };
}

/** Matrix zusammenfassen: je zy Zeilen und zx Spalten zu einer Zelle. */
function zoomMatrix(samples, matrix, zy, zx) {
  const rowGroups = [];
  for (let i = 0; i < samples.length; i += zy) {
    const to = Math.min(samples.length, i + zy);
    const wpt = samples.slice(i, to).find(s => s.name) || null;
    rowGroups.push({ sample: samples[i], wpt, from: i, to });
  }
  const colGroups = [];
  for (let c = 0; c < matrix.starts.length; c += zx) {
    colGroups.push({ start: matrix.starts[c], from: c, to: Math.min(matrix.starts.length, c + zx) });
  }
  const cells = rowGroups.map(rg => colGroups.map(cg => {
    const bucket = [];
    for (let r = rg.from; r < rg.to; r++) {
      for (let c = cg.from; c < cg.to; c++) bucket.push(matrix.rows[r][c]);
    }
    return aggregate(bucket);
  }));
  return { rowGroups, colGroups, cells };
}

/** Relative Windrichtung → einer von 8 Sektoren (0 = von vorn/oben, 2 = von rechts, 4 = von hinten/unten, 6 = von links). */
function windSector(rd) {
  if (rd == null) return null;
  return Math.round(rd / 45) % 8;
}

function roundTo30(sec) { return Math.round(sec / 1800) * 1800; }

/** Pausen (Stunden nach Punkt i) aufsummieren: liefert Samples mit tEff (Minuten inkl. Pausen). */
function applyPauses(samples, pauses) {
  let extra = 0;
  return samples.map((s, i) => {
    const out = { ...s, tEff: s.tMin + extra * 60 };
    extra += (pauses && pauses[i]) || 0;
    return out;
  });
}

/** Demo-Regen: wandernde Schauerbänder, unabhängig von der echten Prognose. */
function demoRain(pointIndex, timeSec) {
  const hour = Math.floor(timeSec / 3600);
  const x = ((hour + pointIndex * 0.35) % 11 + 11) % 11;
  if (x < 1) return 0.3;
  if (x < 2) return 1.6;
  if (x < 3) return 4.5 + (pointIndex % 3);
  if (x < 4) return 0.8;
  return 0;
}

if (typeof module !== 'undefined') {
  module.exports = { withWind, windowValues, pauseData, extractGpxText, pastePreview, mergeCloseWaypoints, bearingDeg, withBearings, windSector, parseGpx, haversineKm, routeStats, gpxTimeline, locateWaypoints, applyPauses, demoRain, samplePoints, buildForecastUrls, valueAt, arrivalTime, buildMatrix, matrixExtremes, scalesFor, cellStyle, rampColor, tempFill, aggregate, zoomMatrix, roundTo30 };
}

/* ---------- Browser-App ---------- */

if (typeof document !== 'undefined') (function () {
  const $ = id => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  };

  const state = {
    gpxText: store.get('tw.gpx', ''),
    speed: parseFloat(store.get('tw.speed', '20')) || 20,
    route: null,       // { name, points }
    sampled: null,     // { samples, totalKm, durationMin }
    weather: null,     // pro Sample: { time, temperature_2m, precipitation, wind_speed_10m }
    fetchedAt: 0,
    zy: parseInt(store.get('tw.zy', '1'), 10) || 1,
    zx: parseInt(store.get('tw.zx', '1'), 10) || 1,
    loading: false,
    fetchedHours: 0,
    pauses: (() => { try { return JSON.parse(store.get('tw.pauses', '{}')) || {}; } catch (e) { return {}; } })(),
    pp: null,          // offener Pausen-Editor { kind: 'row' | 'col', key }
    // Uhrzeit-Pausen: { <Unix-Sekunden der Pause>: Stunden }
    clockPauses: (() => { try { return JSON.parse(store.get('tw.clockPauses', '{}')) || {}; } catch (e) { return {}; } })(),
    demo: new URLSearchParams(location.search).has('demo')
  };

  function totalPauseHours() {
    const sum = o => Object.values(o).reduce((a, b) => a + (b || 0), 0);
    return sum(state.pauses) + sum(state.clockPauses);
  }
  function savePauses() {
    store.set('tw.pauses', JSON.stringify(state.pauses));
    store.set('tw.clockPauses', JSON.stringify(state.clockPauses));
  }

  const fmtTime = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });
  const fmtNum1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  function esc(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function fmtDuration(min) {
    const m = Math.round(min);
    return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
  }

  function setStatus(text, isError) {
    const el = $('status');
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle('error', !!isError);
  }

  /* ---- GPX laden ---- */

  // Zwischenablage lesen: erst als Text, sonst alle angebotenen Formate durchprobieren
  async function readClipboardAny() {
    const tried = [];
    if (navigator.clipboard && navigator.clipboard.readText) {
      try {
        const t = await navigator.clipboard.readText();
        if (t && t.trim()) return { text: t, tried };
        tried.push('text/plain (leer)');
      } catch (e) { tried.push('readText: ' + (e && e.name || e)); }
    }
    if (navigator.clipboard && navigator.clipboard.read) {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            try {
              const blob = await item.getType(type);
              const t = await blob.text();
              tried.push(type + ' (' + t.length + ')');
              if (t && extractGpxText(t)) return { text: t, tried };
            } catch (e) { tried.push(type + ': ' + (e && e.name || e)); }
          }
        }
      } catch (e) { tried.push('read: ' + (e && e.name || e)); }
    }
    return { text: '', tried };
  }

  async function pasteFromClipboard() {
    const { text, tried } = await readClipboardAny();
    if (text && text.trim()) { loadGpxText(text); return; }
    // Nichts Lesbares: Einfügefeld öffnen (natives Einsetzen kann mehr Formate als die Web-API)
    openPasteDialog('Die Zwischenablage konnte nicht als Text gelesen werden' + (tried.length ? ' (' + tried.join(', ') + ')' : '') + '. Tippe lange in das Feld und wähle „Einsetzen“.');
  }

  function openPasteDialog(hint) {
    const dlg = $('pasteDialog');
    $('pasteArea').value = '';
    if (hint) $('pasteHint').textContent = hint;
    if (typeof dlg.showModal === 'function') {
      dlg.showModal();
      setTimeout(() => $('pasteArea').focus(), 50);
    } else {
      const t = window.prompt('GPX-Inhalt einfügen:');
      if (t) loadGpxText(t);
    }
  }

  function loadGpxText(text) {
    try {
      const gpx = extractGpxText(text);
      if (!gpx) throw new Error('Kein GPX erkannt. Eingefügt wurde ' + pastePreview(text) + '.');
      const route = parseGpx(gpx);
      if (gpx !== state.gpxText) { state.pauses = {}; savePauses(); }
      state.gpxText = gpx;
      store.set('tw.gpx', state.gpxText);
      state.route = route;
      computeSamples();
      fetchWeather();
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  }

  function computeSamples() {
    state.sampled = samplePoints(state.route.points, state.speed, STEP_MIN, state.route.waypoints || []);
    const { totalKm, durationMin, usesGpxTime } = state.sampled;
    const stats = routeStats(state.route.points);
    const parts = [];
    if (state.route.name) parts.push(state.route.name);
    parts.push(fmtNum1.format(totalKm) + ' km');
    if (Number.isFinite(stats.ascent) && stats.ascent > 0) parts.push(stats.ascent + ' hm');
    parts.push(fmtDuration(durationMin) + ' h');
    $('routeInfo').textContent = parts.join(' · ');
    $('routeInfo').title = parts.join(' · ');
    const speedTxt = String(state.speed).replace('.', ',');
    $('estNote').hidden = usesGpxTime;
    $('estNote').textContent = 'Fahrzeiten geschätzt (Ø ' + speedTxt + ' km/h)';
  }

  /* ---- Wetter laden ---- */

  const PAUSE_HEADROOM_H = 12; // Reserve, damit neue Pausen meist ohne Nachladen auskommen

  function hoursRequired() {
    return START_COLUMNS + Math.ceil(state.sampled.durationMin / 60) + totalPauseHours() + 2;
  }

  // silent: ohne Statuszeile (kein Verrutschen der Matrix bei Hintergrund-Aktualisierung)
  async function fetchWeather(opts) {
    if (!state.sampled) return;
    const silent = !!(opts && opts.silent) && !!state.weather;
    const { samples } = state.sampled;
    const hoursNeeded = hoursRequired() + PAUSE_HEADROOM_H;
    const urls = buildForecastUrls(samples, hoursNeeded);
    state.loading = true;
    if (!silent) setStatus('Lade Wetter für ' + samples.length + ' Punkte …');
    try {
      const results = [];
      for (const url of urls) {
        const res = await fetch(url);
        if (!res.ok) {
          let reason = res.status + ' ' + res.statusText;
          try { const j = await res.json(); if (j && j.reason) reason = j.reason; } catch (e) { /* ignore */ }
          throw new Error('Open-Meteo: ' + reason);
        }
        const data = await res.json();
        const arr = Array.isArray(data) ? data : [data];
        for (const d of arr) results.push(d.hourly);
      }
      if (results.length !== samples.length) throw new Error('Unerwartete Antwort von Open-Meteo.');
      if (state.demo) {
        results.forEach((h, i) => {
          h.precipitation = h.precipitation.map((r, k) => Math.max(r || 0, demoRain(i, h.time[k])));
        });
      }
      state.weather = results;
      state.fetchedAt = Date.now();
      state.fetchedHours = hoursNeeded;
      if (!silent) setStatus('');
      if (silent) rerenderKeepScroll(); else render();
    } catch (e) {
      const offline = !navigator.onLine;
      setStatus(offline ? 'Keine Internetverbindung – Wetter konnte nicht geladen werden.' : (e.message || String(e)), true);
    } finally {
      state.loading = false;
    }
  }

  /* ---- Darstellung ---- */

  // Wind relativ zur Fahrtrichtung in zwei Keilen:
  // oben = Gegenwind, unten = Rückenwind, rechts/links = Seitenwind von rechts/links.
  // Größe je Anteil (km/h) bis zum Maximum; Anteile unter 3 km/h werden nicht gezeigt.
  const HEAD_WEAK = [150, 95, 88], HEAD_STRONG = [222, 30, 20];
  const TAIL_WEAK = [84, 130, 96], TAIL_STRONG = [20, 165, 70];
  function mixRgb(a, b, f) {
    return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(',') + ')';
  }

  function windWedges(c, sc) {
    if (c.hw == null || c.cw == null) return '';
    const wedge = (comp, sideA, sideB) => {
      const mag = Math.abs(comp);
      if (mag < 3) return '';
      const f = Math.max(0, Math.min(1, mag / sc.windRef));
      const half = 4 + 18 * f, len = 6 + 25 * f;
      const rot = comp > 0 ? sideA : sideB;
      // Gegenwind rötlich, Rückenwind grünlich (kräftiger bei mehr Wind), Seitenwind schwarz
      let fill = '#111';
      if (sideA === 0) fill = comp > 0 ? mixRgb(HEAD_WEAK, HEAD_STRONG, f) : mixRgb(TAIL_WEAK, TAIL_STRONG, f);
      return '<polygon points="' + (-half).toFixed(1) + ',-34 ' + half.toFixed(1) + ',-34 0,' + (-34 + len).toFixed(1) +
        '" transform="rotate(' + rot + ')" fill="' + fill + '" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" paint-order="stroke"/>';
    };
    const shapes = wedge(c.hw, 0, 180) + wedge(c.cw, 90, 270);
    if (!shapes) return '';
    return '<svg class="wind" viewBox="-34 -34 68 68" preserveAspectRatio="none" aria-hidden="true">' + shapes + '</svg>';
  }

  // opts: cls (zusätzliche Klassen), attrs (zusätzliche Attribute), wrap (Inhalt in .pw für Pausen-Animation)
  function cellHtml(c, sc, r, col, opts) {
    const o = opts || {};
    const extra = o.cls ? ' ' + o.cls : '';
    const attrs = ' data-r="' + r + '" data-c="' + col + '"' + (o.attrs || '');
    const wrapIn = inner => o.wrap ? '<div class="pw">' + inner + '</div>' : inner;
    if (!c) return '<td class="na' + extra + '"' + attrs + '>' + wrapIn('<span class="vals"><b>–</b></span>') + '</td>';
    const st = cellStyle(c, sc);
    const layers = [];
    if (st.rainF > 0) {
      const op = (0.35 + 0.65 * st.rainF).toFixed(2);
      const w = (1.5 + 3 * st.rainF).toFixed(1);
      const gap = (Number(w) + 5).toFixed(1);
      layers.push('repeating-linear-gradient(135deg, rgba(255,255,255,' + op + ') 0 1px, rgba(28,86,196,' + op + ') 1px ' + w + 'px, transparent ' + w + 'px ' + gap + 'px)');
    }
    const fill = tempFill(st);
    if (fill) layers.push('linear-gradient(' + fill.css + ',' + fill.css + ')');
    const style = layers.length ? ' style="background-image:' + layers.join(',') + '"' : '';
    const dark = fill && fill.dark ? ' dark' : '';
    const rainTxt = c.r < 0.05 ? '0' : fmtNum1.format(c.r);
    return '<td class="cell' + dark + extra + '"' + attrs + style + '>' + windWedges(c, sc) +
      wrapIn('<span class="vals"><b>' + Math.round(c.t) + '°</b><i class="vr">' + rainTxt + '</i><i class="vw">' + Math.round(c.w) + '</i></span>') + '</td>';
  }


  function render() {
    const hasData = !!(state.sampled && state.weather);
    $('empty').hidden = hasData || !!state.gpxText;
    $('matrixWrap').hidden = !hasData;
    $('toolbar').hidden = !hasData;
    document.body.classList.toggle('has-data', hasData);
    updateZoomButtons();
    if (!hasData) return;

    const nowSec = Date.now() / 1000;
    const samples = applyPauses(state.sampled.samples, state.pauses);
    // Abgelaufene Uhrzeit-Pausen (keine Abfahrt mehr davor möglich) entfernen
    const firstRounded = roundTo30(nowSec);
    for (const k of Object.keys(state.clockPauses)) if (+k <= firstRounded) { delete state.clockPauses[k]; savePauses(); }
    const cps = Object.entries(state.clockPauses).map(([at, h]) => ({ at: +at, h }));
    const matrix = buildMatrix(samples, state.weather, nowSec, START_COLUMNS, cps);
    $('demoNote').hidden = !state.demo;
    const z = zoomMatrix(samples, matrix, state.zy, state.zx);

    // Anzeigespalten: Datenspalten, danach ggf. eine Pausenspalte
    // (Uhrzeit-Pausen zwischen dieser und der nächsten Abfahrtszeit)
    const pd = pauseData(samples, state.weather, matrix.starts, state.pauses, cps);
    const display = [];
    z.colGroups.forEach((cg, idx) => {
      const at = roundTo30(cg.start);
      display.push({ kind: 'col', idx, cg, at });
      const next = z.colGroups[idx + 1];
      const nextAt = next ? roundTo30(next.start) : at + 3600 * state.zx;
      const ks = pd.cps.map((p, k) => (p.at > at && p.at <= nextAt ? k : -1)).filter(k => k >= 0);
      const h = ks.reduce((a, k) => a + pd.cps[k].h, 0);
      if (h > 0) display.push({ kind: 'pause', at: nextAt, h, ks, editable: state.zx === 1, after: at });
    });

    let html = '<thead><tr><th class="corner" scope="col">Fahrzeit · km · Höhe<br>' +
      '<button type="button" class="info-btn" aria-label="Legende anzeigen" aria-haspopup="dialog">i</button>Abfahrt →</th>';
    let lastDay = fmtDay.format(new Date(nowSec * 1000));
    display.forEach(dc => {
      if (dc.kind === 'pause') {
        html += '<th scope="col" class="pause-col-h" data-pcol="' + dc.at + '" data-col="pc' + dc.at + '"' + (dc.editable ? ' data-pcedit="' + dc.at + '" data-after="' + dc.after + '"' : '') +
          '><div class="pw"><span class="pc-txt"><span class="day">Pause</span>' + dc.h + ' h</span></div></th>';
        return;
      }
      const d = new Date(dc.at * 1000);
      const day = fmtDay.format(d);
      const dayLabel = dc.idx === 0 ? 'jetzt' : (day !== lastDay ? day : '');
      lastDay = day;
      const canEdit = state.zx === 1;
      html += '<th scope="col" data-col="' + dc.idx + '"' + (canEdit ? ' data-colat="' + (dc.at + 3600) + '" data-after="' + dc.at + '"' : '') + (dc.idx === 0 ? ' class="now"' : '') +
        '><span class="day">' + esc(dayLabel || ' ') + '</span>' + fmtTime.format(d) + '</th>';
    });
    html += '</tr></thead><tbody>';

    // Farb-/Größenskalen nur aus den Fahrtzellen, damit Pausen die Entscheidungsfarben nicht verschieben
    const sc = scalesFor(matrixExtremes(matrix));
    const lastIdx = samples.length - 1;
    const range = (a, b) => Array.from({ length: b - a }, (_, k) => a + k);

    z.rowGroups.forEach((rg, r) => {
      const s = rg.sample;
      const meta = [fmtNum1.format(s.km) + ' km'];
      if (Number.isFinite(s.ele)) meta.push(Math.round(s.ele) + ' m');
      const editable = state.zy === 1 && rg.from < lastIdx;
      const rowAttr = ' data-row="' + r + '"' + (editable ? ' data-point="' + rg.from + '"' : '');
      if (rg.wpt) {
        const w = rg.wpt;
        const len = w.name.length;
        const nameCls = len > 44 ? ' xlong' : len > 22 ? ' long' : '';
        html += '<tr class="wpt-row"><th scope="row"' + rowAttr + ' title="' + esc(w.name) + '"><span class="rh-name' + nameCls + '" lang="de">' + esc(w.name) + '</span>' +
          '<span class="rh-meta">+' + fmtDuration(w.tEff) + ' · ' + fmtNum1.format(w.km) + ' km</span></th>';
      } else {
        html += '<tr><th scope="row"' + rowAttr + '><span class="rh-time">+' + fmtDuration(s.tEff) + '</span><span class="rh-meta">' + meta.join(' · ') + '</span></th>';
      }
      const rowIdx = range(rg.from, rg.to);
      display.forEach(dc => {
        if (dc.kind === 'pause') {
          // Uhrzeit-Pause: Wetter an diesen Punkten während des Pausenzeitraums
          const vals = dc.ks.flatMap(k => rowIdx.flatMap(i => pd.col[k][i]));
          html += cellHtml(aggregate(vals), sc, r, 'pc' + dc.at, { cls: 'pause-col pz', attrs: ' data-pcol="' + dc.at + '"', wrap: true });
          return;
        }
        html += cellHtml(z.cells[r][dc.idx], sc, r, dc.idx);
      });
      html += '</tr>';

      // Zeilen-Pause nach diesem Punkt (bzw. Punkten der Gruppe): Wetter am Pausenort
      const pts = rowIdx.filter(i => i < lastIdx && state.pauses[i] > 0 && pd.row[i]);
      const h = pts.reduce((a, i) => a + state.pauses[i], 0);
      if (h > 0) {
        const pr = 'p' + rg.from;
        html += '<tr class="pause-row" data-prow="' + rg.from + '"><th scope="row" data-row="' + pr + '"' + (editable ? ' data-prowedit="' + rg.from + '"' : '') +
          '><div class="pw"><span class="pr-txt"><span class="rh-time">Pause ' + h + ' h</span><span class="rh-meta">am Ort darüber</span></span></div></th>';
        display.forEach(dc => {
          let vals;
          if (dc.kind === 'pause') {
            vals = dc.ks.flatMap(k => pts.flatMap(i => pd.col[k][i]));
            html += cellHtml(aggregate(vals), sc, pr, 'pc' + dc.at, { cls: 'pause-col pz', attrs: ' data-pcol="' + dc.at + '"', wrap: true });
          } else {
            vals = pts.flatMap(i => range(dc.cg.from, dc.cg.to).flatMap(c => pd.row[i][c]));
            html += cellHtml(aggregate(vals), sc, pr, dc.idx, { cls: 'pz', wrap: true });
          }
        });
        html += '</tr>';
      }
    });
    html += '</tbody>';
    $('matrix').innerHTML = html;
    state.sel = null;
    state.hover = null;
    if (state.anim) { const a = state.anim; state.anim = null; playEnter(a); }
    // Höhe des Tabellenkopfs für die mitlaufende Pausen-Bedienung (erst nach Animationsstart messen)
    const thead = $('matrix').tHead;
    if (thead) $('matrixWrap').style.setProperty('--head-h', thead.offsetHeight + 'px');
    const rowHead = $('matrix').querySelector('tbody th');
    if (rowHead) $('matrixWrap').style.setProperty('--rowhead-w', rowHead.offsetWidth + 'px');
  }

  /* ---- Werte für Zeile + Spalte einblenden (Hover / Tippen) ---- */

  function applySelection() {
    const table = $('matrix');
    table.querySelectorAll('.show').forEach(el => el.classList.remove('show'));
    const cur = state.sel || state.hover;
    if (!cur) return;
    table.querySelectorAll('td[data-r="' + cur.r + '"], th[data-row="' + cur.r + '"]').forEach(el => el.classList.add('show'));
    table.querySelectorAll('td[data-c="' + cur.c + '"]').forEach(el => el.classList.add('show'));
    const head = table.querySelector('th[data-col="' + cur.c + '"]');
    if (head) head.classList.add('show');
  }

  function setupSelection() {
    const table = $('matrix');
    const cellOf = e => {
      const td = e.target.closest && e.target.closest('td[data-r]');
      return td ? { r: td.dataset.r, c: td.dataset.c } : null;
    };
    table.addEventListener('click', e => {
      const info = e.target.closest && e.target.closest('.info-btn');
      if (info) { e.stopPropagation(); toggleLegend(info); return; }
      const t = e.target.closest ? e.target : null;
      const colHead = t && (t.closest('th[data-colat]') || t.closest('th[data-pcedit]'));
      if (colHead) {
        e.stopPropagation();
        const at = +(colHead.dataset.colat || colHead.dataset.pcedit);
        openPausePop('col', at, colHead, +colHead.dataset.after);
        return;
      }
      const rowHead = t && (t.closest('th[data-point]') || t.closest('th[data-prowedit]'));
      if (rowHead) {
        e.stopPropagation();
        openPausePop('row', +(rowHead.dataset.point || rowHead.dataset.prowedit), rowHead);
        return;
      }
      const p = cellOf(e);
      if (!p) return;
      state.sel = (state.sel && state.sel.r === p.r && state.sel.c === p.c) ? null : p;
      applySelection();
    });
    table.addEventListener('pointerover', e => {
      if (e.pointerType !== 'mouse') return;
      const p = cellOf(e);
      if (!p || (state.hover && state.hover.r === p.r && state.hover.c === p.c)) return;
      state.hover = p;
      if (!state.sel) applySelection();
    });
    table.addEventListener('pointerleave', e => {
      if (e.pointerType !== 'mouse') return;
      state.hover = null;
      if (!state.sel) applySelection();
    });
  }

  /* ---- Legende (Infofeld) ---- */

  function toggleLegend(anchor) {
    const pop = $('legendPop');
    if (!pop.hidden) { pop.hidden = true; return; }
    // Hinweise (geschätzte Zeiten, Demo) auch hier zeigen – im Querformat ist die Werkzeugleiste ausgeblendet
    const notes = [$('estNote'), $('demoNote')].filter(n => !n.hidden).map(n => n.textContent);
    $('lpNotes').textContent = notes.join(' · ');
    $('lpNotes').hidden = !notes.length;
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, hgt = pop.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + hgt > window.innerHeight - 8) top = Math.max(8, window.innerHeight - hgt - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function setupLegend() {
    $('legendClose').addEventListener('click', () => { $('legendPop').hidden = true; });
    document.addEventListener('click', e => {
      const pop = $('legendPop');
      if (!pop.hidden && !pop.contains(e.target) && !(e.target.closest && e.target.closest('.info-btn'))) pop.hidden = true;
    });
    window.addEventListener('resize', () => { $('legendPop').hidden = true; });
  }

  /* ---- Pausen ---- */

  function rerenderKeepScroll() {
    const wrap = $('matrixWrap');
    const top = wrap.scrollTop, left = wrap.scrollLeft;
    render();
    wrap.scrollTop = top; wrap.scrollLeft = left;
  }

  /* Animation: neue Pausenzeile/-spalte wächst in 0,5 s auf, entfernte schrumpft */
  const ANIM_MS = 500;
  function animSelector(a) {
    return a.kind === 'row' ? '[data-prow="' + a.key + '"]' : '[data-pcol="' + a.key + '"]';
  }
  function playEnter(a) {
    const els = $('matrix').querySelectorAll(animSelector(a));
    els.forEach(el => el.classList.add('enter'));
    void $('matrix').offsetHeight; // Startzustand festschreiben
    requestAnimationFrame(() => els.forEach(el => el.classList.remove('enter')));
  }
  function playLeave(a, done) {
    const els = $('matrix').querySelectorAll(animSelector(a));
    if (!els.length) { done(); return; }
    els.forEach(el => el.classList.add('leave'));
    setTimeout(done, ANIM_MS);
  }

  // Pausen-Editor: kleines Infofeld am angetippten Kopf, Matrixzellen zeigen weiter das Wetter
  function openPausePop(kind, key, anchor, after) {
    const pop = $('pausePop');
    if (!pop.hidden && state.pp && state.pp.kind === kind && state.pp.key === key) { closePausePop(); return; }
    $('legendPop').hidden = true;
    state.pp = { kind, key };
    if (kind === 'row') {
      const s = applyPauses(state.sampled.samples, state.pauses)[key];
      $('ppTitle').textContent = 'Pause nach diesem Punkt';
      $('ppSub').textContent = (s && s.name ? s.name + ' · ' : '') + 'Fahrzeit +' + fmtDuration(s ? s.tEff : 0) +
        ' · ' + fmtNum1.format(s ? s.km : 0) + ' km. Alle folgenden Punkte werden entsprechend später erreicht.';
    } else {
      $('ppTitle').textContent = 'Pause um ' + fmtTime.format(new Date(key * 1000));
      $('ppSub').textContent = 'Gilt für alle Abfahrten bis ' + fmtTime.format(new Date((Number.isFinite(after) ? after : key - 3600) * 1000)) +
        ': Wer um ' + fmtTime.format(new Date(key * 1000)) + ' noch unterwegs ist, pausiert dort.';
    }
    updatePausePop();
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, hgt = pop.offsetHeight;
    const left = Math.max(8, Math.min(kind === 'row' ? r.right + 6 : r.left, window.innerWidth - w - 8));
    let top = kind === 'row' ? r.top : r.bottom + 6;
    if (top + hgt > window.innerHeight - 8) top = Math.max(8, window.innerHeight - hgt - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function updatePausePop() {
    if (!state.pp) return;
    const h = (state.pp.kind === 'row' ? state.pauses : state.clockPauses)[state.pp.key] || 0;
    $('ppVal').textContent = h + ' h';
    $('ppMinus').disabled = h <= 0;
    $('ppPlus').disabled = h >= 24;
  }

  function closePausePop() {
    $('pausePop').hidden = true;
    state.pp = null;
  }

  function stepPausePop(delta) {
    if (!state.pp) return;
    if (state.pp.kind === 'row') changePause(state.pp.key, delta); else changeClockPause(state.pp.key, delta);
  }

  function setupPausePop() {
    $('ppMinus').addEventListener('click', () => stepPausePop(-1));
    $('ppPlus').addEventListener('click', () => stepPausePop(1));
    $('ppClose').addEventListener('click', closePausePop);
    document.addEventListener('click', e => {
      const pop = $('pausePop');
      if (!pop.hidden && !pop.contains(e.target)) closePausePop();
    });
    window.addEventListener('resize', closePausePop);
  }

  function changePause(i, delta) {
    const cur = state.pauses[i] || 0;
    const next = Math.max(0, Math.min(24, cur + delta));
    if (next === cur) return;
    if (next === 0) {
      state.pauses[i] = 0; updatePausePop();
      playLeave({ kind: 'row', key: i }, () => { delete state.pauses[i]; afterPauseChange(); });
      return;
    }
    if (!cur) state.anim = { kind: 'row', key: i };
    state.pauses[i] = next;
    afterPauseChange();
  }

  function changeClockPause(at, delta) {
    const cur = state.clockPauses[at] || 0;
    const next = Math.max(0, Math.min(24, cur + delta));
    if (next === cur) return;
    if (next === 0) {
      state.clockPauses[at] = 0; updatePausePop();
      playLeave({ kind: 'col', key: at }, () => { delete state.clockPauses[at]; afterPauseChange(); });
      return;
    }
    if (!cur) state.anim = { kind: 'col', key: at };
    state.clockPauses[at] = next;
    afterPauseChange();
  }

  function afterPauseChange() {
    savePauses();
    updatePausePop();
    rerenderKeepScroll(); // sofort anzeigen; fehlende Stunden ggf. still nachladen
    if (hoursRequired() > state.fetchedHours && !state.loading) fetchWeather({ silent: true });
  }

  /* ---- Zoom ---- */

  function updateZoomButtons() {
    document.querySelectorAll('.zoom button').forEach(b => {
      const lvl = parseInt(b.dataset.level, 10);
      const cur = b.dataset.axis === 'y' ? state.zy : state.zx;
      b.setAttribute('aria-pressed', String(lvl === cur));
    });
  }

  function setZoom(axis, level) {
    level = Math.max(1, Math.min(8, level));
    if (!LEVELS.includes(level)) return;
    const cur = axis === 'y' ? state.zy : state.zx;
    if (cur === level) return;
    const wrap = $('matrixWrap');
    const fy = wrap.scrollHeight > wrap.clientHeight ? wrap.scrollTop / (wrap.scrollHeight - wrap.clientHeight) : 0;
    const fx = wrap.scrollWidth > wrap.clientWidth ? wrap.scrollLeft / (wrap.scrollWidth - wrap.clientWidth) : 0;
    if (axis === 'y') { state.zy = level; store.set('tw.zy', String(level)); }
    else { state.zx = level; store.set('tw.zx', String(level)); }
    render();
    wrap.scrollTop = fy * Math.max(0, wrap.scrollHeight - wrap.clientHeight);
    wrap.scrollLeft = fx * Math.max(0, wrap.scrollWidth - wrap.clientWidth);
  }

  // Pinch: Finger übereinander → Zeilen zoomen, Finger nebeneinander → Stunden zoomen
  function setupPinch() {
    const wrap = $('matrixWrap');
    let pinch = null;
    const span = (t1, t2) => ({ dx: Math.abs(t1.clientX - t2.clientX), dy: Math.abs(t1.clientY - t2.clientY) });

    wrap.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        const s = span(e.touches[0], e.touches[1]);
        const axis = s.dy > s.dx ? 'y' : 'x';
        pinch = { axis, start: Math.max(40, axis === 'y' ? s.dy : s.dx), level: axis === 'y' ? state.zy : state.zx };
        e.preventDefault();
      }
    }, { passive: false });

    wrap.addEventListener('touchmove', e => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const s = span(e.touches[0], e.touches[1]);
      const cur = Math.max(1, pinch.axis === 'y' ? s.dy : s.dx);
      const ratio = cur / pinch.start;
      // Finger zusammen (ratio < 1) → rauszoomen → größere Schrittweite
      const steps = Math.round(-Math.log2(ratio) * 1.4);
      const idx = Math.max(0, Math.min(LEVELS.length - 1, LEVELS.indexOf(pinch.level) + steps));
      const target = LEVELS[idx];
      if (target !== (pinch.axis === 'y' ? state.zy : state.zx)) {
        requestAnimationFrame(() => setZoom(pinch ? pinch.axis : 'y', target));
      }
    }, { passive: false });

    const end = e => { if (!e.touches || e.touches.length < 2) pinch = null; };
    wrap.addEventListener('touchend', end);
    wrap.addEventListener('touchcancel', end);
    // iOS Safari: eigene Pinch-Gesten unterdrücken
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));
  }

  /* ---- Alter des Code-Stands ---- */

  function formatAge(minutes) {
    if (minutes < 1) return 'vor weniger als 1 min';
    if (minutes < 120) return 'vor ' + minutes + ' min';
    const h = Math.floor(minutes / 60);
    if (h < 48) return 'vor ' + h + ' h ' + (minutes % 60) + ' min';
    return 'vor ' + Math.floor(h / 24) + ' Tagen';
  }

  function updateVersionInfo() {
    const el = $('versionInfo');
    const v = window.TW_VERSION;
    const ms = v && Date.parse(v.committed);
    if (!Number.isFinite(ms)) { el.textContent = 'Stand unbekannt'; return; }
    const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000));
    const d = new Date(ms);
    el.innerHTML = 'Letzter Commit <span' + (minutes < 60 ? ' class="fresh"' : '') + '>' + formatAge(minutes) + '</span> · ' +
      d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ' + fmtTime.format(d);
  }

  /* ---- Ereignisse ---- */

  function init() {
    $('speedInput').value = state.speed;
    $('pasteBtn').addEventListener('click', pasteFromClipboard);
    $('pasteBtn2').addEventListener('click', pasteFromClipboard);

    $('menuBtn').addEventListener('click', () => {
      const s = $('settings');
      s.hidden = !s.hidden;
      $('menuBtn').setAttribute('aria-expanded', String(!s.hidden));
    });

    let speedTimer = null;
    $('speedInput').addEventListener('input', () => {
      const v = parseFloat(String($('speedInput').value).replace(',', '.'));
      if (!Number.isFinite(v) || v < 3 || v > 60) return;
      state.speed = v;
      store.set('tw.speed', String(v));
      clearTimeout(speedTimer);
      speedTimer = setTimeout(() => { if (state.route) { computeSamples(); fetchWeather(); } }, 600);
    });

    $('fileInput').addEventListener('change', async e => {
      const f = e.target.files && e.target.files[0];
      if (f) loadGpxText(await f.text());
      e.target.value = '';
    });

    $('reloadBtn').addEventListener('click', () => { if (state.route) fetchWeather(); });

    $('pasteDialog').addEventListener('close', () => {
      if ($('pasteDialog').returnValue === 'ok') {
        const t = $('pasteArea').value;
        if (t.trim()) loadGpxText(t);
      }
    });

    // Desktop: Strg/Cmd+V überall
    document.addEventListener('paste', e => {
      if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) return;
      const t = e.clipboardData && e.clipboardData.getData('text');
      if (t && extractGpxText(t)) { e.preventDefault(); loadGpxText(t); }
    });

    document.querySelectorAll('.zoom button').forEach(b => {
      b.addEventListener('click', () => setZoom(b.dataset.axis, parseInt(b.dataset.level, 10)));
    });

    // Beim Zurückkehren: Spalten neu ausrichten, nach 30 min Wetter neu laden
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !state.route) return;
      if (Date.now() - state.fetchedAt > 30 * 60 * 1000) fetchWeather({ silent: true }); else render();
    });
    setInterval(() => { if (document.visibilityState === 'visible' && state.weather && !state.loading) render(); }, 5 * 60 * 1000);

    setupPinch();
    setupSelection();
    setupLegend();
    setupPausePop();

    updateVersionInfo();
    setInterval(updateVersionInfo, 30 * 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateVersionInfo(); });

    if (state.gpxText) loadGpxText(state.gpxText);
    else render();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ });
    }
  }

  init();
})();
