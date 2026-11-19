"use strict";

const API = "https://api-open.data.gov.sg/v2/real-time/api/";
const REFRESH_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const COLORS = { good: "#2e9e5b", mod: "#e0a100", bad: "#d9534f", vbad: "#8e44ad", none: "#7f8c8d" };

const state = { data: {}, layer: "heat", user: null, trendRegion: "central" };

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// data.gov.sg rate-limits keyless clients. Retry only transient failures (429, timeout, network);
// real API errors (404, bad payload) fail fast. Every request has a timeout so a stall can't wedge load().
async function getJSON(path, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(API + path, { signal: ctrl.signal });
      const body = await res.json().catch(() => null);
      if (res.ok && body && body.code === 0) return body.data;
      if (res.status === 429 || (body && body.name === "TOO_MANY_REQUESTS")) {
        lastErr = new Error("Rate limited");
      } else {
        const fatal = new Error((body && body.errorMsg) || "HTTP " + res.status);
        fatal.fatal = true;
        throw fatal;
      }
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e; // timeout (AbortError) or network failure (TypeError): worth retrying
    } finally {
      clearTimeout(timer);
    }
    if (i < tries - 1) await sleep(3000 * (i + 1));
  }
  throw lastErr;
}

function psiBand(v) {
  if (v == null) return { label: "n/a", c: COLORS.none };
  if (v <= 50) return { label: "Good", c: COLORS.good };
  if (v <= 100) return { label: "Moderate", c: COLORS.mod };
  if (v <= 200) return { label: "Unhealthy", c: COLORS.bad };
  return { label: v <= 300 ? "Very unhealthy" : "Hazardous", c: COLORS.vbad };
}
function uvBand(v) {
  if (v == null) return { label: "n/a", c: COLORS.none };
  if (v <= 2) return { label: "Low", c: COLORS.good };
  if (v <= 5) return { label: "Moderate", c: COLORS.mod };
  if (v <= 7) return { label: "High", c: "#e67e22" };
  if (v <= 10) return { label: "Very high", c: COLORS.bad };
  return { label: "Extreme", c: COLORS.vbad };
}
function heatBand(level) {
  const l = String(level || "").toLowerCase();
  if (l === "low") return { label: "Low", c: COLORS.good, rank: 0 };
  if (l === "moderate") return { label: "Moderate", c: COLORS.mod, rank: 1 };
  if (l === "high") return { label: "High", c: COLORS.bad, rank: 2 };
  return { label: level || "n/a", c: COLORS.none, rank: -1 };
}
function tempBand(t) {
  if (t == null) return { label: "n/a", c: COLORS.none };
  if (t < 28) return { label: "Comfortable", c: COLORS.good };
  if (t < 31) return { label: "Warm", c: COLORS.mod };
  if (t < 34) return { label: "Hot", c: "#e67e22" };
  return { label: "Very hot", c: COLORS.bad };
}
function distKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Singapore" });
}

/* ---------- normalise API data ---------- */
function parsePsi(d) {
  // Items for a given date come newest-first; the history powers the trend chart.
  const item = d.items[0];
  const history = d.items
    .map((it) => ({ t: it.timestamp, v: it.readings.psi_twenty_four_hourly }))
    .reverse();
  const regions = d.regionMetadata.map((r) => ({
    name: r.name,
    lat: r.labelLocation.latitude,
    lng: r.labelLocation.longitude,
    psi: item.readings.psi_twenty_four_hourly[r.name],
    pm25: item.readings.pm25_twenty_four_hourly[r.name],
  }));
  return { regions, history, time: item.updatedTimestamp || item.timestamp };
}
function parseHumidity(d) {
  const r = d.readings[d.readings.length - 1];
  return { byId: Object.fromEntries(r.data.filter((x) => x.value != null).map((x) => [x.stationId, x.value])), time: r.timestamp };
}
function parseRain(d) {
  const meta = Object.fromEntries(d.stations.map((s) => [s.id, s]));
  const r = d.readings[d.readings.length - 1];
  const stations = r.data
    .filter((x) => meta[x.stationId] && x.value != null)
    .map((x) => ({ id: x.stationId, name: meta[x.stationId].name, lat: meta[x.stationId].location.latitude, lng: meta[x.stationId].location.longitude, mm: x.value }));
  return { stations, time: r.timestamp };
}
// NOAA/Rothfusz heat index ("feels like"), inputs °C and %RH, output °C.
function feelsLike(tC, rh) {
  const T = tC * 9 / 5 + 32;
  let hi = 0.5 * (T + 61 + (T - 68) * 1.2 + rh * 0.094);
  if ((hi + T) / 2 >= 80) {
    hi = -42.379 + 2.04901523 * T + 10.14333127 * rh - 0.22475541 * T * rh - 0.00683783 * T * T
      - 0.05481717 * rh * rh + 0.00122874 * T * T * rh + 0.00085282 * T * rh * rh - 0.00000199 * T * T * rh * rh;
    if (rh < 13 && T >= 80 && T <= 112) hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
    else if (rh > 85 && T >= 80 && T <= 87) hi += ((rh - 85) / 10) * ((87 - T) / 5);
  }
  return (hi - 32) * 5 / 9;
}
function rainBand(mm) {
  if (mm <= 0) return { label: "Dry", c: COLORS.none };
  if (mm < 0.5) return { label: "Light rain", c: "#5dade2" };
  if (mm < 2) return { label: "Moderate rain", c: "#2e86c1" };
  return { label: "Heavy rain", c: "#1b4f9c" };
}
function parseTemp(d) {
  const meta = Object.fromEntries(d.stations.map((s) => [s.id, s]));
  const r = d.readings[d.readings.length - 1];
  const stations = r.data
    .filter((x) => meta[x.stationId] && x.value != null)
    .map((x) => ({
      id: x.stationId,
      name: meta[x.stationId].name,
      lat: meta[x.stationId].location.latitude,
      lng: meta[x.stationId].location.longitude,
      temp: x.value,
    }));
  return { stations, time: r.timestamp };
}
function parseWbgt(d) {
  const rec = d.records[0];
  const stations = rec.item.readings
    .filter((x) => x.wbgt != null && x.wbgt !== "")
    .map((x) => ({
      id: x.station.id,
      name: x.station.name,
      lat: parseFloat(x.location.latitude),
      lng: parseFloat(x.location.longitude),
      wbgt: parseFloat(x.wbgt),
      level: x.heatStress,
    }));
  return { stations, time: rec.datetime };
}
function parseUv(d) {
  const rec = d.records[0];
  // Before sunrise the index list can be empty: keep the dataset but with no current value.
  const hours = rec.index.map((h) => ({ hour: h.hour, value: h.value })).reverse();
  return { hours, now: rec.index.length ? rec.index[0].value : null, time: rec.updatedTimestamp || rec.timestamp };
}

/* ---------- rendering ---------- */
function setCard(id, big, band, note) {
  const el = $(id);
  el.querySelector(".big").textContent = big;
  const tag = el.querySelector(".tag");
  tag.textContent = band ? band.label : "";
  tag.style.background = band ? band.c : "";
  tag.hidden = !band;
  el.querySelector(".note").textContent = note || "";
}

function renderCards() {
  const { psi, uv, wbgt, temp } = state.data;
  if (psi) {
    const worst = psi.regions.reduce((a, b) => (b.psi > a.psi ? b : a));
    setCard("card-psi", worst.psi, psiBand(worst.psi), `Highest: ${worst.name} · PM2.5 ${worst.pm25} µg/m³`);
  } else setCard("card-psi", "–", null, "Unavailable");
  if (uv && uv.now != null) setCard("card-uv", uv.now, uvBand(uv.now), "Latest hourly reading");
  else if (uv) setCard("card-uv", "–", null, "No UV reading yet (before sunrise)");
  else setCard("card-uv", "–", null, "Unavailable");
  if (wbgt && wbgt.stations.length) {
    const worst = wbgt.stations.reduce((a, b) => (b.wbgt > a.wbgt ? b : a));
    setCard("card-heat", worst.wbgt.toFixed(1) + "°", heatBand(worst.level), `Hottest: ${worst.name}`);
  } else setCard("card-heat", "–", null, "Unavailable");
  if (temp && temp.stations.length) {
    const avg = temp.stations.reduce((s, x) => s + x.temp, 0) / temp.stations.length;
    const max = temp.stations.reduce((a, b) => (b.temp > a.temp ? b : a));
    setCard("card-temp", avg.toFixed(1) + "°C", tempBand(avg), `Island average · max ${max.temp}° at ${max.name}`);
  } else setCard("card-temp", "–", null, "Unavailable");

  const withFeel = temp ? temp.stations.filter((s) => s.feels != null) : [];
  if (withFeel.length) {
    const avgF = withFeel.reduce((s, x) => s + x.feels, 0) / withFeel.length;
    const avgH = withFeel.reduce((s, x) => s + x.rh, 0) / withFeel.length;
    setCard("card-feels", avgF.toFixed(1) + "°C", tempBand(avgF), `Heat index · avg humidity ${avgH.toFixed(0)}%`);
  } else setCard("card-feels", "–", null, "Unavailable");

  const rain = state.data.rain;
  if (rain) {
    const wet = rain.stations.filter((s) => s.mm > 0);
    const heaviest = wet.reduce((a, b) => (!a || b.mm > a.mm ? b : a), null);
    setCard("card-rain", `${wet.length}/${rain.stations.length}`, heaviest ? rainBand(heaviest.mm) : { label: "Dry", c: COLORS.good },
      heaviest ? `stations with rain · heaviest ${heaviest.mm} mm at ${heaviest.name}` : "stations with rain in the last 5 min");
  } else setCard("card-rain", "–", null, "Unavailable");
}

// Join humidity onto temperature stations and compute "feels like".
function enrichTemp() {
  const { temp, hum } = state.data;
  if (!temp || !hum) return;
  temp.stations.forEach((s) => {
    const rh = hum.byId[s.id];
    s.rh = rh != null ? rh : null;
    s.feels = rh != null ? feelsLike(s.temp, rh) : null;
  });
}

function renderTrend() {
  const box = $("trend");
  box.replaceChildren();
  const psi = state.data.psi;
  if (!psi || psi.history.length < 2) { box.textContent = "Not enough PSI history yet today."; return; }
  const region = state.trendRegion;
  const pts = psi.history.map((h) => ({ t: new Date(h.t), v: h.v[region] })).filter((p) => p.v != null);
  if (pts.length < 2) { box.textContent = "Not enough PSI history yet today."; return; }
  const W = 600, H = 180, P = { l: 34, r: 22, t: 10, b: 24 };
  const max = Math.max(60, ...pts.map((p) => p.v));
  // Position by timestamp (not array index) so gaps in the data show up as gaps.
  const t0 = pts[0].t.getTime(), span = pts[pts.length - 1].t.getTime() - t0 || 1;
  const x = (i) => P.l + ((pts[i].t.getTime() - t0) / span) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - v / max) * (H - P.t - P.b);
  const ns = "http://www.w3.org/2000/svg";
  const el = (n, a, txt) => { const e = document.createElementNS(ns, n); for (const k in a) e.setAttribute(k, a[k]); if (txt != null) e.textContent = txt; return e; };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `PSI trend today, ${region} region` });
  [50, 100].filter((v) => v <= max).forEach((v) => {
    svg.append(el("line", { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v), stroke: "currentColor", "stroke-opacity": ".2", "stroke-dasharray": "4 4" }));
    svg.append(el("text", { x: P.l - 4, y: y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "currentColor", "fill-opacity": ".6" }, v));
  });
  svg.append(el("polyline", { points: pts.map((p, i) => `${x(i)},${y(p.v)}`).join(" "), fill: "none", style: "stroke:var(--blue)", "stroke-width": 2.5, "stroke-linejoin": "round" }));
  pts.forEach((p, i) => {
    const c = el("circle", { cx: x(i), cy: y(p.v), r: 4, fill: psiBand(p.v).c });
    c.append(el("title", {}, `${fmtTime(p.t)}: PSI ${p.v}`));
    svg.append(c);
  });
  const step = Math.ceil(pts.length / 6);
  pts.forEach((p, i) => {
    if (i % step === 0 || i === pts.length - 1) {
      svg.append(el("text", { x: x(i), y: H - 6, "text-anchor": "middle", "font-size": 11, fill: "currentColor", "fill-opacity": ".6" },
        p.t.toLocaleTimeString("en-SG", { hour: "numeric", timeZone: "Asia/Singapore" })));
    }
  });
  box.append(svg);
}

function renderAdvice() {
  const { psi, uv, wbgt } = state.data;
  const tips = [];
  let sev = 0;
  if (psi) {
    const m = Math.max(...psi.regions.map((r) => r.psi));
    if (m > 100) { sev = 2; tips.push("Air quality is unhealthy: limit prolonged outdoor exertion, especially if you have asthma or heart conditions."); }
    else if (m > 50) { sev = Math.max(sev, 1); tips.push("Air quality is moderate: fine for most people; sensitive groups may want lighter outdoor activity."); }
  }
  if (wbgt) {
    const r = Math.max(...wbgt.stations.map((s) => heatBand(s.level).rank));
    if (r >= 2) { sev = 2; tips.push("High heat stress: avoid strenuous outdoor activity, rest in shade and hydrate often."); }
    else if (r === 1) { sev = Math.max(sev, 1); tips.push("Moderate heat stress: take regular breaks and drink water if you're exercising outdoors."); }
  }
  if (uv && uv.now != null && uv.now >= 6) { sev = Math.max(sev, 1); tips.push(`UV is ${uvBand(uv.now).label.toLowerCase()} (${uv.now}): sunscreen, hat and shade.`); }
  const el = $("advice");
  el.className = "advice " + ["good", "mod", "bad"][sev];
  if (!psi && !uv && !wbgt) { el.className = "advice"; el.textContent = "Couldn't load live data. Try Refresh in a moment."; return; }
  el.textContent = tips.length ? tips.join(" ") : "All clear: good air, low heat stress and moderate-to-low UV. Enjoy the outdoors!";
}

function renderUv() {
  const box = $("uvchart");
  box.replaceChildren();
  const uv = state.data.uv;
  if (!uv) { box.textContent = "UV data unavailable."; return; }
  if (!uv.hours.length) { box.textContent = "No UV readings yet today."; return; }
  const max = Math.max(11, ...uv.hours.map((h) => h.value));
  for (const h of uv.hours) {
    const bar = document.createElement("div");
    bar.className = "bar";
    const val = document.createElement("div");
    val.className = "val";
    val.textContent = h.value;
    const fill = document.createElement("div");
    fill.className = "fill";
    fill.style.height = (h.value / max) * 100 + "px";
    fill.style.background = uvBand(h.value).c;
    const t = document.createElement("div");
    t.textContent = new Date(h.hour).toLocaleTimeString("en-SG", { hour: "numeric", timeZone: "Asia/Singapore" });
    bar.append(val, fill, t);
    box.append(bar);
  }
}

/* ---------- map ---------- */
let map, markerLayer;
function initMap() {
  map = L.map("map", { zoomControl: true }).setView([1.3521, 103.8198], 11);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}

function pin(lat, lng, color, text, size, popup) {
  const icon = L.divIcon({
    className: "",
    html: `<div class="pin" style="width:${size}px;height:${size}px;background:${color}"></div>`,
    iconSize: [size, size],
  });
  const m = L.marker([lat, lng], { icon });
  m.bindTooltip(String(text), { permanent: true, direction: "center", className: "pin-label", opacity: 1 });
  m.bindPopup(popup);
  return m;
}

function popupEl(title, line) {
  const d = document.createElement("div");
  const b = document.createElement("b");
  b.textContent = title;
  d.append(b, document.createElement("br"), document.createTextNode(line));
  return d;
}

function renderMap() {
  markerLayer.clearLayers();
  const { psi, temp, wbgt, rain } = state.data;
  let legend = [];
  if (state.layer === "heat" && wbgt) {
    wbgt.stations.forEach((s) => {
      const b = heatBand(s.level);
      markerLayer.addLayer(pin(s.lat, s.lng, b.c, s.wbgt.toFixed(0), 30, popupEl(s.name, `WBGT ${s.wbgt}°C · ${b.label} heat stress`)));
    });
    legend = [["Low (<31°)", COLORS.good], ["Moderate (31–32°)", COLORS.mod], ["High (≥33°)", COLORS.bad]];
  } else if (state.layer === "temp" && temp) {
    temp.stations.forEach((s) => {
      const extra = s.feels != null ? ` · feels like ${s.feels.toFixed(1)}°C · humidity ${s.rh}%` : "";
      markerLayer.addLayer(pin(s.lat, s.lng, tempBand(s.temp).c, s.temp.toFixed(0), 30, popupEl(s.name, `${s.temp}°C · ${tempBand(s.temp).label}${extra}`)));
    });
    legend = [["<28°", COLORS.good], ["28–31°", COLORS.mod], ["31–34°", "#e67e22"], ["34°+", COLORS.bad]];
  } else if (state.layer === "rain" && rain) {
    // Dry stations are small grey dots; wet ones are larger and labelled in mm.
    rain.stations.forEach((s) => {
      const b = rainBand(s.mm);
      if (s.mm > 0) {
        markerLayer.addLayer(pin(s.lat, s.lng, b.c, s.mm.toFixed(1), 34, popupEl(s.name, `${s.mm} mm in last 5 min · ${b.label}`)));
      } else {
        markerLayer.addLayer(L.circleMarker([s.lat, s.lng], { radius: 4, color: "#fff", weight: 1, fillColor: b.c, fillOpacity: 0.8 }).bindPopup(popupEl(s.name, "No rain in last 5 min")));
      }
    });
    legend = [["Dry", COLORS.none], ["Light (<0.5 mm)", "#5dade2"], ["Moderate (<2 mm)", "#2e86c1"], ["Heavy (2+ mm)", "#1b4f9c"]];
  } else if (state.layer === "psi" && psi) {
    psi.regions.forEach((r) => {
      const b = psiBand(r.psi);
      markerLayer.addLayer(pin(r.lat, r.lng, b.c, r.psi, 44, popupEl(cap(r.name), `PSI ${r.psi} · ${b.label} · PM2.5 ${r.pm25} µg/m³`)));
    });
    legend = [["Good (0–50)", COLORS.good], ["Moderate (51–100)", COLORS.mod], ["Unhealthy (101–200)", COLORS.bad], ["Very unhealthy (201+)", COLORS.vbad]];
  }
  if (state.user) {
    markerLayer.addLayer(L.circleMarker([state.user.lat, state.user.lng], { radius: 8, color: "#fff", weight: 3, fillColor: "#1e6fff", fillOpacity: 1 }).bindTooltip("You are here"));
  }
  const lg = $("legend");
  lg.replaceChildren();
  legend.forEach(([label, color]) => {
    const s = document.createElement("span");
    const i = document.createElement("i");
    i.style.background = color;
    s.append(i, document.createTextNode(label));
    lg.append(s);
  });
}

/* ---------- near me ---------- */
function nearest(list, u) {
  return list.reduce((best, s) => {
    const d = distKm(u, s);
    return !best || d < best.d ? { s, d } : best;
  }, null);
}
function renderNear() {
  const box = $("near");
  if (!state.user) { box.hidden = true; return; }
  const u = state.user;
  const { psi, temp, wbgt } = state.data;
  box.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = "Near you";
  const ul = document.createElement("ul");
  const add = (txt) => { const li = document.createElement("li"); li.textContent = txt; ul.append(li); };
  // nearest() returns null for an empty list, so guard each lookup.
  const nW = wbgt && nearest(wbgt.stations, u);
  if (nW) add(`Heat stress: ${heatBand(nW.s.level).label} (WBGT ${nW.s.wbgt}°C) at ${nW.s.name}, ${nW.d.toFixed(1)} km away`);
  const nT = temp && nearest(temp.stations, u);
  if (nT) add(`Temperature: ${nT.s.temp}°C at ${nT.s.name}, ${nT.d.toFixed(1)} km away`);
  const nP = psi && nearest(psi.regions, u);
  if (nP) add(`Air quality (${nP.s.name} region): PSI ${nP.s.psi}, ${psiBand(nP.s.psi).label}`);
  if (!ul.children.length) add("No nearby readings available yet.");
  box.append(h, ul);
  box.hidden = false;
}

/* ---------- data loading ---------- */
let loading = false;
async function load() {
  if (loading) return;
  loading = true;
  $("refresh").disabled = true;
  $("updated").textContent = "updating…";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });
  const jobs = [
    ["psi", "psi?date=" + today, parsePsi],
    ["uv", "uv", parseUv],
    ["wbgt", "weather?api=wbgt", parseWbgt],
    ["temp", "air-temperature", parseTemp],
    ["hum", "relative-humidity", parseHumidity],
    ["rain", "rainfall", parseRain],
  ];
  const errors = [];
  for (const [key, path, parse] of jobs) {
    try {
      let raw = await getJSON(path);
      // Just after midnight SG time the day's PSI history can be empty; fall back to the latest reading.
      if (key === "psi" && !raw.items.length) raw = await getJSON("psi");
      state.data[key] = parse(raw);
    } catch (e) {
      console.warn(key, e);
      errors.push(key);
    }
    renderFor(key);
    await sleep(600); // be gentle with the keyless rate limit
  }
  const times = ["psi", "uv", "wbgt", "temp", "hum", "rain"].map((k) => state.data[k] && state.data[k].time).filter(Boolean);
  const latest = times.sort().pop();
  $("updated").textContent = latest
    ? "data as of " + fmtTime(latest) + (errors.length ? ` (missing: ${errors.join(", ")})` : "")
    : "no data";
  $("refresh").disabled = false;
  loading = false;
}

// Re-render only what the dataset that just arrived can change.
const LAYER_KEYS = { heat: ["wbgt"], temp: ["temp", "hum"], rain: ["rain"], psi: ["psi"] };
function renderFor(key) {
  if (key === "temp" || key === "hum") enrichTemp();
  renderCards();
  renderAdvice();
  if (key === "psi") renderTrend();
  if (key === "uv") renderUv();
  if (LAYER_KEYS[state.layer].includes(key)) renderMap();
  if (["psi", "wbgt", "temp"].includes(key)) renderNear();
}

/* ---------- wire up ---------- */
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    state.layer = b.dataset.layer;
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    renderMap();
  })
);
$("refresh").addEventListener("click", load);
$("trend-region").addEventListener("change", (e) => { state.trendRegion = e.target.value; renderTrend(); });
$("locate").addEventListener("click", () => {
  if (!navigator.geolocation) { alert("Geolocation isn't supported in this browser."); return; }
  navigator.geolocation.getCurrentPosition(
    (p) => {
      state.user = { lat: p.coords.latitude, lng: p.coords.longitude };
      map.setView([state.user.lat, state.user.lng], 12);
      renderMap();
      renderNear();
    },
    () => alert("Couldn't get your location. Check browser permissions.")
  );
});

initMap();
load();
setInterval(load, REFRESH_MS);
