/* Tourwetter – Wetter entlang einer GPX-Route für verschiedene Abfahrtszeiten */
'use strict';

/* ---------- Reine Logik (auch in Node testbar) ---------- */

const STEP_MIN = 15;          // ein Wetterpunkt alle 15 Minuten Fahrzeit
const START_COLUMNS = 24;     // Abfahrtszeiten: jetzt … +23 h
const LEVELS = [1, 2, 4, 8];
const HOT_THRESHOLD = 22;     // °C: darüber zählt beim Zusammenfassen das Maximum
const MAX_LOCATIONS_PER_REQUEST = 50;

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
  return { name, points };
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
function samplePoints(points, speedKmh, stepMin = STEP_MIN) {
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
  return { samples: out, totalKm, durationMin, hasEle, usesGpxTime };
}

function buildForecastUrls(samples, hoursNeeded) {
  const urls = [];
  for (let i = 0; i < samples.length; i += MAX_LOCATIONS_PER_REQUEST) {
    const chunk = samples.slice(i, i + MAX_LOCATIONS_PER_REQUEST);
    const params = new URLSearchParams({
      latitude: chunk.map(s => s.lat.toFixed(5)).join(','),
      longitude: chunk.map(s => s.lon.toFixed(5)).join(','),
      hourly: 'temperature_2m,precipitation,wind_speed_10m',
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
  if (t == null || w == null || r == null) return null;
  return { t, r, w };
}

/** Rohmatrix: Zeilen = Tourpunkte, Spalten = Abfahrtszeiten (jetzt + h Stunden). */
function buildMatrix(samples, weather, nowSec, columns = START_COLUMNS) {
  const starts = [];
  for (let h = 0; h < columns; h++) starts.push(nowSec + h * 3600);
  const rows = samples.map((s, i) => starts.map(st => valueAt(weather[i], st + s.tMin * 60)));
  return { starts, rows };
}

function aggregate(cells) {
  const v = cells.filter(Boolean);
  if (!v.length) return null;
  const temps = v.map(c => c.t);
  const max = Math.max(...temps);
  const min = Math.min(...temps);
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  return {
    t: max > HOT_THRESHOLD ? max : min,
    r: mean(v.map(c => c.r)),
    w: mean(v.map(c => c.w))
  };
}

/** Matrix zusammenfassen: je zy Zeilen und zx Spalten zu einer Zelle. */
function zoomMatrix(samples, matrix, zy, zx) {
  const rowGroups = [];
  for (let i = 0; i < samples.length; i += zy) {
    rowGroups.push({ sample: samples[i], last: samples[Math.min(samples.length, i + zy) - 1], from: i, to: Math.min(samples.length, i + zy) });
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

function roundTo30(sec) { return Math.round(sec / 1800) * 1800; }

if (typeof module !== 'undefined') {
  module.exports = { parseGpx, haversineKm, routeStats, gpxTimeline, samplePoints, buildForecastUrls, valueAt, buildMatrix, aggregate, zoomMatrix, roundTo30 };
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
    loading: false
  };

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

  async function pasteFromClipboard() {
    let text = '';
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('no clipboard');
      text = await navigator.clipboard.readText();
    } catch (e) {
      openPasteDialog();
      return;
    }
    if (!text || !text.trim()) {
      setStatus('Die Zwischenablage ist leer. Kopiere zuerst den GPX-Inhalt.', true);
      return;
    }
    loadGpxText(text);
  }

  function openPasteDialog() {
    const dlg = $('pasteDialog');
    $('pasteArea').value = '';
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
      const route = parseGpx(text.trim());
      state.gpxText = text.trim();
      store.set('tw.gpx', state.gpxText);
      state.route = route;
      computeSamples();
      fetchWeather();
    } catch (e) {
      setStatus(e.message || String(e), true);
    }
  }

  function computeSamples() {
    state.sampled = samplePoints(state.route.points, state.speed);
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

  async function fetchWeather() {
    if (!state.sampled) return;
    const { samples, durationMin } = state.sampled;
    const hoursNeeded = START_COLUMNS + Math.ceil(durationMin / 60) + 2;
    const urls = buildForecastUrls(samples, hoursNeeded);
    state.loading = true;
    setStatus('Lade Wetter für ' + samples.length + ' Punkte …');
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
      state.weather = results;
      state.fetchedAt = Date.now();
      setStatus('');
      render();
    } catch (e) {
      const offline = !navigator.onLine;
      setStatus(offline ? 'Keine Internetverbindung – Wetter konnte nicht geladen werden.' : (e.message || String(e)), true);
    } finally {
      state.loading = false;
    }
  }

  /* ---- Darstellung ---- */

  function tempColor(t) {
    // −10 °C (blau) … 35 °C (rot), immer helle Töne → dunkler Text bleibt lesbar
    const f = Math.max(0, Math.min(1, (t + 10) / 45));
    const hue = 225 - f * 225;
    return 'hsl(' + hue.toFixed(0) + ', 75%, ' + (88 - Math.abs(f - 0.5) * 6).toFixed(0) + '%)';
  }

  function render() {
    const hasData = !!(state.sampled && state.weather);
    $('empty').hidden = hasData || !!state.gpxText;
    $('matrixWrap').hidden = !hasData;
    $('toolbar').hidden = !hasData;
    updateZoomButtons();
    if (!hasData) return;

    const nowSec = Date.now() / 1000;
    const { samples } = state.sampled;
    const matrix = buildMatrix(samples, state.weather, nowSec);
    const z = zoomMatrix(samples, matrix, state.zy, state.zx);

    let html = '<thead><tr><th class="corner" scope="col">Fahrzeit · km · Höhe<br>Abfahrt →</th>';
    let lastDay = fmtDay.format(new Date(nowSec * 1000));
    z.colGroups.forEach((cg, idx) => {
      const d = new Date(roundTo30(cg.start) * 1000);
      const day = fmtDay.format(d);
      const dayLabel = idx === 0 ? 'jetzt' : (day !== lastDay ? day : '');
      lastDay = day;
      html += '<th scope="col"' + (idx === 0 ? ' class="now"' : '') + '><span class="day">' + esc(dayLabel || ' ') + '</span>' + fmtTime.format(d) + '</th>';
    });
    html += '</tr></thead><tbody>';

    z.rowGroups.forEach((rg, r) => {
      const s = rg.sample;
      const meta = [fmtNum1.format(s.km) + ' km'];
      if (Number.isFinite(s.ele)) meta.push(Math.round(s.ele) + ' m');
      html += '<tr><th scope="row"><span class="rh-time">+' + fmtDuration(s.tMin) + '</span><span class="rh-meta">' + meta.join(' · ') + '</span></th>';
      z.cells[r].forEach(c => {
        if (!c) { html += '<td class="na"><span class="c-t">–</span></td>'; return; }
        const rain = c.r;
        const bar = rain >= 0.05 ? Math.min(7, 2 + rain * 2) : 0;
        const style = 'background:' + tempColor(c.t) + (bar ? ';box-shadow:inset 0 -' + bar.toFixed(0) + 'px 0 rgba(47,111,208,.55)' : '');
        const rainTxt = rain < 0.05 ? '0' : fmtNum1.format(rain);
        html += '<td style="' + style + '"><span class="c-t">' + Math.round(c.t) + '°</span>' +
          '<span class="c-r' + (rain >= 0.05 ? ' wet' : '') + '">' + rainTxt + '</span>' +
          '<span class="c-w' + (c.w >= 30 ? ' strong' : '') + '">' + Math.round(c.w) + '</span></td>';
      });
      html += '</tr>';
    });
    html += '</tbody>';
    $('matrix').innerHTML = html;
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
      if (t && t.includes('<')) { e.preventDefault(); loadGpxText(t); }
    });

    document.querySelectorAll('.zoom button').forEach(b => {
      b.addEventListener('click', () => setZoom(b.dataset.axis, parseInt(b.dataset.level, 10)));
    });

    // Beim Zurückkehren: Spalten neu ausrichten, nach 30 min Wetter neu laden
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !state.route) return;
      if (Date.now() - state.fetchedAt > 30 * 60 * 1000) fetchWeather(); else render();
    });
    setInterval(() => { if (document.visibilityState === 'visible' && state.weather && !state.loading) render(); }, 5 * 60 * 1000);

    setupPinch();

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
