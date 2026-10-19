// BiteMap — live fishing intelligence app
// Pulls live weather (Open-Meteo), tides (NOAA), sun/moon, Reddit posts,
// and computes a bite score per spot.

const STATE = {
  region: "wilmington",
  userLocation: null,
  weather: null,
  astro: null,
  tides: null,
  score: 0,
  factors: {},
  map: null,
  markerLayer: null,
  userMarker: null,
  selectedSpot: null,
  socialSource: "reddit",
};

// ============================================================
//  UTILITIES
// ============================================================

const fmt = (n, d = 0) => (n == null || isNaN(n)) ? "—" : Number(n).toFixed(d);
const pct = (v, max) => Math.max(0, Math.min(100, (v / max) * 100));
const deg2compass = (d) => {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(d / 22.5) % 16];
};
const timeStr = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const hourDiff = (a, b) => Math.abs(a - b) / 36e5;
const scoreClass = (s) => s >= 80 ? "hot" : s >= 60 ? "good" : s >= 40 ? "ok" : "slow";
const scoreColor = (s) => s >= 80 ? "var(--hot)" : s >= 60 ? "var(--good)" : s >= 40 ? "var(--ok)" : "var(--slow)";
const scoreWord = (s) => s >= 80 ? "FIRE" : s >= 60 ? "GOOD" : s >= 40 ? "AVERAGE" : "SLOW";

// ============================================================
//  LUNAR PHASE (simple astronomical approximation — Conway)
// ============================================================

function moonPhase(date = new Date()) {
  const y = date.getFullYear();
  let m = date.getMonth() + 1;
  const d = date.getDate();
  let r = y % 100;
  r %= 19;
  if (r > 9) r -= 19;
  r = r * 11 % 30 + ((m < 3) ? m + 2 : m) + d;
  if (m < 3) r += 2;
  r -= (y < 2000) ? 4 : 8.3;
  r = Math.floor(r + 0.5) % 30;
  const phase = (r < 0) ? r + 30 : r; // 0-29
  // map to names
  const names = [
    "New Moon","Waxing Crescent","Waxing Crescent","Waxing Crescent",
    "Waxing Crescent","Waxing Crescent","Waxing Crescent","First Quarter",
    "Waxing Gibbous","Waxing Gibbous","Waxing Gibbous","Waxing Gibbous",
    "Waxing Gibbous","Waxing Gibbous","Full Moon","Full Moon",
    "Waning Gibbous","Waning Gibbous","Waning Gibbous","Waning Gibbous",
    "Waning Gibbous","Waning Gibbous","Last Quarter","Waning Crescent",
    "Waning Crescent","Waning Crescent","Waning Crescent","Waning Crescent",
    "Waning Crescent","New Moon"
  ];
  return { day: phase, name: names[phase] };
}

function moonScore(phaseDay) {
  // Full or New = peak activity. Quarters = low. Distance from 0 or 15 in a 30-day cycle.
  const distToNew = Math.min(phaseDay, 30 - phaseDay);
  const distToFull = Math.abs(phaseDay - 15);
  const closest = Math.min(distToNew, distToFull);
  // 0 days away = 100, 7 days away = 40
  return Math.max(30, 100 - closest * 9);
}

function moonEmoji(day) {
  if (day <= 1 || day >= 29) return "🌑";
  if (day < 7) return "🌒";
  if (day < 9) return "🌓";
  if (day < 14) return "🌔";
  if (day < 16) return "🌕";
  if (day < 21) return "🌖";
  if (day < 23) return "🌗";
  return "🌘";
}

// ============================================================
//  LIVE API CALLS
// ============================================================

async function fetchWeather(lat, lon) {
  // Open-Meteo: no API key needed, free forever
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,weather_code`
    + `&hourly=pressure_msl,wind_speed_10m,temperature_2m,precipitation_probability`
    + `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=auto&forecast_days=2`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Weather fetch failed");
  return r.json();
}

async function fetchSunMoon(lat, lon) {
  // sunrise-sunset.org: free, no key
  const today = new Date().toISOString().slice(0, 10);
  const url = `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&date=${today}&formatted=0`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("Sun/moon fetch failed");
  const data = await r.json();
  return {
    sunrise: new Date(data.results.sunrise),
    sunset: new Date(data.results.sunset),
    solarNoon: new Date(data.results.solar_noon),
    dayLength: data.results.day_length,
    moon: moonPhase(),
  };
}

async function fetchTides(stationId) {
  if (!stationId) return null;
  // NOAA CO-OPS — free, no key. Get predictions for today.
  const d = new Date();
  const today = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?`
    + `product=predictions&application=BiteMap&begin_date=${today}&end_date=${today}`
    + `&datum=MLLW&station=${stationId}&time_zone=lst_ldt&units=english&interval=h&format=json`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.predictions) return null;
    return data.predictions.map(p => ({
      time: new Date(p.t.replace(" ", "T")),
      height: parseFloat(p.v),
    }));
  } catch (e) {
    console.warn("Tide fetch failed", e);
    return null;
  }
}

async function fetchRedditPosts() {
  // Reddit public JSON — no key needed
  const subs = STATE.region === "wilmington"
    ? ["SaltwaterFishing", "Fishing", "Wilmington"]
    : ["bassfishing", "Fishing", "Charlotte"];
  const keywords = STATE.region === "wilmington"
    ? /wilming|wrights|carolina beach|topsail|cape fear|masonboro|surf|inlet|southport|bald head/i
    : /charlotte|lake norman|lake wylie|catawba|mountain island|lknorman/i;
  const all = [];
  for (const sub of subs) {
    try {
      const r = await fetch(`https://www.reddit.com/r/${sub}/search.json?q=${STATE.region}&restrict_sr=1&sort=new&limit=15&t=month`);
      if (!r.ok) continue;
      const d = await r.json();
      for (const p of d.data.children) {
        all.push({
          user: p.data.author,
          title: p.data.title,
          sub: "r/" + p.data.subreddit,
          url: "https://reddit.com" + p.data.permalink,
          ts: new Date(p.data.created_utc * 1000),
          score: p.data.score,
        });
      }
    } catch (e) { console.warn("reddit fetch", sub, e); }
  }
  // also pull hot from regional sub directly
  try {
    const sub = STATE.region === "wilmington" ? "Wilmington" : "Charlotte";
    const r = await fetch(`https://www.reddit.com/r/${sub}/search.json?q=fishing&restrict_sr=1&sort=new&limit=15&t=year`);
    if (r.ok) {
      const d = await r.json();
      for (const p of d.data.children) {
        all.push({
          user: p.data.author,
          title: p.data.title,
          sub: "r/" + p.data.subreddit,
          url: "https://reddit.com" + p.data.permalink,
          ts: new Date(p.data.created_utc * 1000),
          score: p.data.score,
        });
      }
    }
  } catch (e) {}
  // dedupe + sort
  const seen = new Set();
  const out = all.filter(p => {
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  }).sort((a, b) => b.ts - a.ts).slice(0, 20);
  return out;
}

// ============================================================
//  BITE SCORE ALGORITHM
// ============================================================

function computeBiteScore(weather, astro, tides, spot = null) {
  const now = new Date();
  const factors = {};

  // 1) MOON (20%)
  const moonS = moonScore(astro.moon.day);
  factors.moon = { value: moonS, label: `${astro.moon.name} ${moonEmoji(astro.moon.day)}` };

  // 2) SOLAR PROXIMITY (25%) — closer to dawn/dusk = better
  const dawnDist = Math.min(
    hourDiff(now, astro.sunrise),
    hourDiff(now, astro.sunset)
  );
  let solarS = 100 - dawnDist * 15;
  // night window still decent for some species
  if (now < astro.sunrise || now > astro.sunset) solarS = Math.max(solarS, 50);
  solarS = Math.max(20, Math.min(100, solarS));
  factors.solar = { value: solarS, label: dawnDist < 1.5 ? "Golden hour" : now < astro.sunrise ? "Pre-dawn" : now > astro.sunset ? "After dark" : "Midday" };

  // 3) BAROMETRIC PRESSURE TREND (20%) — falling pressure = feeding frenzy
  let pressS = 60, pressLabel = "Steady";
  if (weather.hourly && weather.hourly.pressure_msl) {
    const pressures = weather.hourly.pressure_msl.slice(0, 12);
    const first = pressures[0];
    const last = pressures[pressures.length - 1];
    const delta = last - first;
    if (delta < -1.5) { pressS = 95; pressLabel = "Falling fast ⚡"; }
    else if (delta < -0.3) { pressS = 80; pressLabel = "Falling"; }
    else if (delta > 1.5) { pressS = 45; pressLabel = "Rising fast"; }
    else if (delta > 0.3) { pressS = 55; pressLabel = "Rising"; }
    else { pressS = 70; pressLabel = "Steady"; }
  }
  factors.pressure = { value: pressS, label: pressLabel };

  // 4) WIND (15%) — 5-12 mph is ideal, >20 is bad
  const wind = weather.current.wind_speed_10m;
  let windS = 70;
  if (wind < 3) windS = 55;
  else if (wind <= 8) windS = 95;
  else if (wind <= 15) windS = 80;
  else if (wind <= 20) windS = 55;
  else if (wind <= 28) windS = 30;
  else windS = 15;
  factors.wind = { value: windS, label: `${fmt(wind)} mph ${deg2compass(weather.current.wind_direction_10m)}` };

  // 5) PRECIPITATION / CLOUD (10%) — overcast good, heavy rain bad
  const precip = weather.current.precipitation || 0;
  const cloud = weather.current.cloud_cover || 0;
  let skyS = 60;
  if (precip > 0.3) skyS = 35;
  else if (precip > 0.05) skyS = 70;
  else if (cloud > 70) skyS = 85;
  else if (cloud > 30) skyS = 75;
  else skyS = 60;
  factors.sky = { value: skyS, label: precip > 0.05 ? `Rain ${fmt(precip, 2)}"` : cloud > 70 ? "Overcast ☁" : cloud > 30 ? "Partly cloudy" : "Clear ☀" };

  // 6) TIDE MOVEMENT (10%) — only for saltwater
  let tideS = 70, tideLabel = "N/A";
  if (tides && tides.length > 1) {
    // find current tide rate
    const nowH = now.getTime();
    let closest = 0;
    for (let i = 0; i < tides.length - 1; i++) {
      if (tides[i].time.getTime() <= nowH && tides[i + 1].time.getTime() > nowH) {
        closest = i; break;
      }
    }
    const cur = tides[closest];
    const next = tides[closest + 1] || tides[closest];
    const rate = Math.abs(next.height - cur.height);
    const direction = next.height > cur.height ? "incoming" : "outgoing";
    if (rate > 0.4) tideS = 95;
    else if (rate > 0.2) tideS = 80;
    else if (rate > 0.1) tideS = 60;
    else tideS = 40;
    tideLabel = `${direction} · ${fmt(cur.height, 1)}ft`;
  }
  factors.tide = { value: tideS, label: tideLabel };

  // Weighted total — tide only counts if saltwater region
  const isSalt = STATE.region === "wilmington";
  const weights = isSalt
    ? { moon: 0.15, solar: 0.25, pressure: 0.20, wind: 0.15, sky: 0.10, tide: 0.15 }
    : { moon: 0.15, solar: 0.28, pressure: 0.25, wind: 0.17, sky: 0.15, tide: 0.00 };

  let total = 0;
  for (const k of Object.keys(weights)) {
    total += (factors[k]?.value || 0) * weights[k];
  }

  // Per-spot modifier from rating (out of 10) — small nudge
  if (spot?.rating) {
    total = total * 0.85 + spot.rating * 1.5; // a 10-rated spot gets +15, a 5-rated gets +7.5
  }

  return { score: Math.round(Math.max(0, Math.min(100, total))), factors };
}

// ============================================================
//  BEST TIMES TODAY
// ============================================================

function computeBestTimes(astro, weather) {
  const times = [];
  const now = new Date();

  // Dawn window: 1hr before sunrise to 1hr after
  const dawnStart = new Date(astro.sunrise.getTime() - 60 * 60e3);
  const dawnEnd = new Date(astro.sunrise.getTime() + 90 * 60e3);
  if (dawnEnd > now) {
    times.push({
      window: `${timeStr(dawnStart)} – ${timeStr(dawnEnd)}`,
      reason: "Sunrise bite · low light · topwater",
      tier: "hot",
    });
  }

  // Dusk window
  const duskStart = new Date(astro.sunset.getTime() - 90 * 60e3);
  const duskEnd = new Date(astro.sunset.getTime() + 60 * 60e3);
  if (duskEnd > now) {
    times.push({
      window: `${timeStr(duskStart)} – ${timeStr(duskEnd)}`,
      reason: "Sunset bite · feeding window",
      tier: "hot",
    });
  }

  // Solunar minor — solar noon +/- 30min
  const noonStart = new Date(astro.solarNoon.getTime() - 30 * 60e3);
  const noonEnd = new Date(astro.solarNoon.getTime() + 30 * 60e3);
  if (noonEnd > now) {
    times.push({
      window: `${timeStr(noonStart)} – ${timeStr(noonEnd)}`,
      reason: "Solunar minor · deep/shade bite",
      tier: "good",
    });
  }

  // Moon peak (new/full = all night)
  if (astro.moon.day <= 2 || astro.moon.day >= 28 || (astro.moon.day >= 14 && astro.moon.day <= 16)) {
    times.push({
      window: "After dark",
      reason: `${astro.moon.name} · bait moves, predators hunt`,
      tier: "hot",
    });
  }

  return times;
}

// ============================================================
//  RENDERING
// ============================================================

function renderConditions(w, astro) {
  const el = document.getElementById("conditionsGrid");
  const c = w.current;
  el.innerHTML = `
    <div class="cond">
      <div class="cond-label">Air Temp</div>
      <div class="cond-value">${fmt(c.temperature_2m)}°F</div>
      <div class="cond-sub">feels ${fmt(c.apparent_temperature)}°</div>
    </div>
    <div class="cond">
      <div class="cond-label">Wind</div>
      <div class="cond-value">${fmt(c.wind_speed_10m)} <span style="font-size:11px">mph</span></div>
      <div class="cond-sub">${deg2compass(c.wind_direction_10m)} · gust ${fmt(c.wind_gusts_10m)}</div>
    </div>
    <div class="cond">
      <div class="cond-label">Pressure</div>
      <div class="cond-value">${fmt(c.pressure_msl, 1)}</div>
      <div class="cond-sub">hPa</div>
    </div>
    <div class="cond">
      <div class="cond-label">Cloud</div>
      <div class="cond-value">${fmt(c.cloud_cover)}%</div>
      <div class="cond-sub">${c.precipitation > 0 ? `Rain ${fmt(c.precipitation,2)}"` : "No rain"}</div>
    </div>
    <div class="cond">
      <div class="cond-label">Sunrise</div>
      <div class="cond-value" style="font-size:15px">${timeStr(astro.sunrise)}</div>
      <div class="cond-sub">↑</div>
    </div>
    <div class="cond">
      <div class="cond-label">Sunset</div>
      <div class="cond-value" style="font-size:15px">${timeStr(astro.sunset)}</div>
      <div class="cond-sub">↓</div>
    </div>
    <div class="cond" style="grid-column: 1/-1">
      <div class="cond-label">Moon</div>
      <div class="cond-value" style="font-size:16px">${moonEmoji(astro.moon.day)} ${astro.moon.name}</div>
      <div class="cond-sub">Day ${astro.moon.day} of lunar cycle</div>
    </div>
  `;
}

function renderScore(score, factors) {
  document.getElementById("scoreNum").textContent = score;
  document.getElementById("scoreLabel").textContent = scoreWord(score);
  const ring = document.getElementById("scoreRing");
  const deg = (score / 100) * 360;
  ring.style.background = `conic-gradient(${scoreColor(score)} 0deg, ${scoreColor(score)} ${deg}deg, var(--border) ${deg}deg)`;

  const factorsEl = document.getElementById("scoreFactors");
  factorsEl.innerHTML = Object.entries(factors)
    .filter(([k]) => STATE.region === "wilmington" || k !== "tide")
    .map(([k, f]) => `
      <div class="factor">
        <div style="flex:1">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span class="factor-name">${k.charAt(0).toUpperCase() + k.slice(1)} · ${f.label}</span>
            <span class="factor-val" style="color:${scoreColor(f.value)}">${Math.round(f.value)}</span>
          </div>
          <div class="factor-bar"><div class="factor-bar-fill" style="width:${f.value}%; background:${scoreColor(f.value)}"></div></div>
        </div>
      </div>
    `).join("");
}

function renderBestTimes(times) {
  const el = document.getElementById("timesList");
  if (!times.length) {
    el.innerHTML = `<div style="color:var(--text-dim); font-size:12px; text-align:center; padding:10px">No prime windows left today — check tomorrow's dawn.</div>`;
    return;
  }
  el.innerHTML = times.map(t => `
    <div class="time-row ${t.tier}">
      <div>
        <div class="time-window">${t.window}</div>
        <div class="time-reason">${t.reason}</div>
      </div>
    </div>
  `).join("");
}

function renderFish() {
  const el = document.getElementById("fishList");
  const month = new Date().getMonth();
  const regionType = window.FISHING_SPOTS[STATE.region].type;

  // Find which species exist in this region (aggregate across spots)
  const regionSpecies = new Set();
  for (const s of window.FISHING_SPOTS[STATE.region].spots) {
    s.species.forEach(sp => regionSpecies.add(sp));
  }

  const list = Array.from(regionSpecies)
    .map(id => ({ id, ...window.FISH[id], activityNow: window.FISH[id]?.activity[month] }))
    .filter(f => f.name)
    .sort((a, b) => b.activityNow - a.activityNow);

  el.innerHTML = list.map(f => {
    const tier = f.activityNow >= 8 ? "" : f.activityNow >= 5 ? "good" : "slow";
    const label = f.activityNow >= 8 ? "PEAK" : f.activityNow >= 5 ? "ACTIVE" : "SLOW";
    return `
      <div class="fish-item" data-fish="${f.id}">
        <div class="fish-emoji">${f.emoji}</div>
        <div class="fish-info">
          <div class="fish-name">${f.name}</div>
          <div class="fish-bait">${f.baits[0]}</div>
        </div>
        <div class="fish-active ${tier}">${label} ${f.activityNow}/10</div>
      </div>
    `;
  }).join("");

  el.querySelectorAll(".fish-item").forEach(item => {
    item.addEventListener("click", () => showFishDetail(item.dataset.fish));
  });
}

function renderSocial(posts) {
  const el = document.getElementById("socialFeed");
  if (STATE.socialSource === "twitter") {
    el.innerHTML = `
      <div class="post-empty">
        X/Twitter's API now requires a paid plan ($100+/mo) to fetch live posts, so we can't stream them here for free.<br><br>
        Reddit gives us real, live fishing reports with no auth — switch to the Reddit tab for current posts.
      </div>`;
    return;
  }
  if (!posts || !posts.length) {
    el.innerHTML = `<div class="post-empty">No recent reports found.</div>`;
    return;
  }
  el.innerHTML = posts.map(p => {
    const ago = (Date.now() - p.ts) / 36e5;
    const agoStr = ago < 1 ? `${Math.round(ago * 60)}m ago` : ago < 24 ? `${Math.round(ago)}h ago` : `${Math.round(ago / 24)}d ago`;
    return `
      <div class="post">
        <div class="post-header">
          <span class="post-user">u/${p.user}</span>
          <span>${agoStr}</span>
        </div>
        <div class="post-title"><a href="${p.url}" target="_blank" rel="noopener">${p.title}</a></div>
        <div class="post-sub">${p.sub} · ${p.score} upvotes</div>
      </div>
    `;
  }).join("");
}

// ============================================================
//  MAP
// ============================================================

function initMap() {
  const cfg = window.FISHING_SPOTS[STATE.region];
  if (STATE.map) {
    STATE.map.remove();
  }
  STATE.map = L.map("map", { zoomControl: true, attributionControl: false }).setView(cfg.center, cfg.zoom);

  // Dark map tiles (CartoDB)
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    subdomains: "abcd",
  }).addTo(STATE.map);

  L.control.attribution({ prefix: false })
    .addAttribution("&copy; OpenStreetMap · CARTO")
    .addTo(STATE.map);

  STATE.markerLayer = L.layerGroup().addTo(STATE.map);
}

function renderSpotMarkers() {
  STATE.markerLayer.clearLayers();
  const cfg = window.FISHING_SPOTS[STATE.region];

  for (const spot of cfg.spots) {
    const { score } = computeBiteScore(STATE.weather, STATE.astro, STATE.tides, spot);
    spot.liveScore = score;
    const cls = scoreClass(score);

    const icon = L.divIcon({
      className: "",
      html: `<div class="spot-marker ${cls}">${score}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    const marker = L.marker([spot.lat, spot.lon], { icon }).addTo(STATE.markerLayer);
    marker.on("click", () => showSpotDetail(spot));
  }
}

function placeUserMarker(lat, lon) {
  if (STATE.userMarker) STATE.userMarker.remove();
  const icon = L.divIcon({ className: "", html: `<div class="you-marker"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
  STATE.userMarker = L.marker([lat, lon], { icon }).addTo(STATE.map);
  STATE.userMarker.bindTooltip("You are here", { permanent: false, direction: "top", offset: [0, -10] });
}

// ============================================================
//  DETAIL PANEL
// ============================================================

function showSpotDetail(spot) {
  const panel = document.getElementById("detailPanel");
  const content = document.getElementById("detailContent");
  const { score, factors } = computeBiteScore(STATE.weather, STATE.astro, STATE.tides, spot);
  const species = spot.species.map(id => window.FISH[id]).filter(Boolean);
  const month = new Date().getMonth();
  const topSpecies = species.sort((a, b) => b.activity[month] - a.activity[month]).slice(0, 5);

  const tideHTML = STATE.tides && STATE.region === "wilmington" ? renderTideChart() : "";

  content.innerHTML = `
    <h2>${spot.name}</h2>
    <div class="detail-sub">${spot.structure}</div>

    <div class="detail-score-big">
      <div class="num" style="color:${scoreColor(score)}">${score}</div>
      <div>
        <div style="font-size:11px; color:var(--text-dim); text-transform:uppercase; letter-spacing:1px">Bite score</div>
        <div style="font-weight:700">${scoreWord(score)}</div>
      </div>
    </div>

    <div class="detail-section">
      <h3>Spot Notes</h3>
      <p>${spot.notes}</p>
      ${spot.bestTide ? `<p style="margin-top:6px; color:var(--accent)"><strong>Best tide:</strong> ${spot.bestTide}</p>` : ""}
    </div>

    ${tideHTML}

    <div class="detail-section">
      <h3>What to Target Now</h3>
      ${topSpecies.map(f => `
        <div class="fish-item" style="margin-bottom:8px">
          <div class="fish-emoji">${f.emoji}</div>
          <div class="fish-info">
            <div class="fish-name">${f.name}</div>
            <div class="fish-bait">${f.baits[0]}</div>
            <div class="fish-bait" style="margin-top:3px; color:var(--accent)">💡 ${f.tip}</div>
          </div>
          <div class="fish-active ${f.activity[month] >= 8 ? "" : f.activity[month] >= 5 ? "good" : "slow"}">${f.activity[month]}/10</div>
        </div>
      `).join("")}
    </div>

    <div class="detail-section">
      <h3>Live Factors</h3>
      ${Object.entries(factors).filter(([k]) => STATE.region === "wilmington" || k !== "tide").map(([k, f]) => `
        <div class="factor">
          <span class="factor-name">${k} · ${f.label}</span>
          <span class="factor-val" style="color:${scoreColor(f.value)}">${Math.round(f.value)}</span>
        </div>
      `).join("")}
    </div>

    <div class="detail-section">
      <h3>Get Directions</h3>
      <p><a href="https://maps.apple.com/?ll=${spot.lat},${spot.lon}&q=${encodeURIComponent(spot.name)}" target="_blank" style="color:var(--accent)">Apple Maps</a> · <a href="https://www.google.com/maps/search/?api=1&query=${spot.lat},${spot.lon}" target="_blank" style="color:var(--accent)">Google Maps</a></p>
    </div>
  `;
  panel.classList.add("open");
}

function renderTideChart() {
  if (!STATE.tides) return "";
  const now = Date.now();
  const visible = STATE.tides.slice(0, 24);
  const max = Math.max(...visible.map(t => t.height));
  const min = Math.min(...visible.map(t => t.height));
  const range = max - min || 1;

  let nearestIdx = 0;
  let nearestDiff = Infinity;
  for (let i = 0; i < visible.length; i++) {
    const diff = Math.abs(visible[i].time.getTime() - now);
    if (diff < nearestDiff) { nearestDiff = diff; nearestIdx = i; }
  }

  return `
    <div class="detail-section">
      <h3>Today's Tide</h3>
      <div class="tide-chart">
        ${visible.map((t, i) => {
          const h = ((t.height - min) / range) * 100;
          return `<div class="tide-bar ${i === nearestIdx ? "now" : ""}" style="height:${Math.max(6, h)}%" title="${timeStr(t.time)} · ${fmt(t.height, 1)}ft"></div>`;
        }).join("")}
      </div>
      <p style="font-size:11px; color:var(--text-dim); margin-top:4px">Now: ${fmt(visible[nearestIdx].height, 1)}ft @ ${timeStr(visible[nearestIdx].time)}</p>
    </div>
  `;
}

function showFishDetail(fishId) {
  const f = window.FISH[fishId];
  if (!f) return;
  const panel = document.getElementById("detailPanel");
  const content = document.getElementById("detailContent");
  const month = new Date().getMonth();
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  content.innerHTML = `
    <h2>${f.emoji} ${f.name}</h2>
    <div class="detail-sub">${f.type === "saltwater" ? "Saltwater" : f.type === "freshwater" ? "Freshwater" : "Both"} · Current activity: ${f.activity[month]}/10</div>

    <div class="detail-section">
      <h3>Year-round activity</h3>
      <div style="display:flex; gap:3px; align-items:flex-end; height:60px; margin-top:8px">
        ${f.activity.map((a, i) => `
          <div style="flex:1; text-align:center">
            <div style="height:${a * 5}px; background:${scoreColor(a * 10)}; border-radius:3px 3px 0 0; margin-bottom:3px; ${i === month ? "box-shadow:0 0 8px "+scoreColor(a*10) : ""}"></div>
            <div style="font-size:9px; color:${i === month ? "var(--accent)" : "var(--text-dim)"}; font-weight:${i === month ? 700 : 400}">${months[i][0]}</div>
          </div>
        `).join("")}
      </div>
    </div>

    <div class="detail-section">
      <h3>Best Baits & Lures</h3>
      <ul>${f.baits.map(b => `<li>${b}</li>`).join("")}</ul>
    </div>

    <div class="detail-section">
      <h3>Pro Tip</h3>
      <p>${f.tip}</p>
    </div>
  `;
  panel.classList.add("open");
}

// ============================================================
//  MAIN PIPELINE
// ============================================================

async function refreshAll() {
  const cfg = window.FISHING_SPOTS[STATE.region];
  const [lat, lon] = cfg.center;
  try {
    const [weather, astro, tides] = await Promise.all([
      fetchWeather(lat, lon),
      fetchSunMoon(lat, lon),
      fetchTides(cfg.noaaStationId),
    ]);
    STATE.weather = weather;
    STATE.astro = astro;
    STATE.tides = tides;

    const { score, factors } = computeBiteScore(weather, astro, tides);
    STATE.score = score;
    STATE.factors = factors;

    renderConditions(weather, astro);
    renderScore(score, factors);
    renderBestTimes(computeBestTimes(astro, weather));
    renderFish();
    renderSpotMarkers();

    document.getElementById("lastUpdate").textContent = `Updated ${timeStr(new Date())}`;
  } catch (e) {
    console.error(e);
    document.getElementById("conditionsGrid").innerHTML = `<div class="cond-loading" style="color:var(--hot)">Live data fetch failed: ${e.message}. Check internet connection.</div>`;
  }

  // Social feed (separate try — not fatal)
  try {
    const posts = await fetchRedditPosts();
    STATE.posts = posts;
    renderSocial(posts);
  } catch (e) {
    console.warn("reddit", e);
    renderSocial([]);
  }
}

// ============================================================
//  EVENT HANDLERS
// ============================================================

document.getElementById("regionSwitch").addEventListener("click", (e) => {
  if (e.target.tagName !== "BUTTON") return;
  document.querySelectorAll("#regionSwitch button").forEach(b => b.classList.remove("active"));
  e.target.classList.add("active");
  STATE.region = e.target.dataset.region;
  initMap();
  refreshAll();
});

document.getElementById("locateBtn").addEventListener("click", () => {
  if (!navigator.geolocation) {
    alert("Geolocation not supported by your browser.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      STATE.userLocation = { lat: latitude, lon: longitude };
      // auto-pick nearest region
      const distWilm = Math.hypot(latitude - 34.224, longitude + 77.882);
      const distClt = Math.hypot(latitude - 35.422, longitude + 80.920);
      const near = distWilm < distClt ? "wilmington" : "charlotte";
      if (near !== STATE.region) {
        STATE.region = near;
        document.querySelectorAll("#regionSwitch button").forEach(b => {
          b.classList.toggle("active", b.dataset.region === near);
        });
        initMap();
        refreshAll();
      }
      placeUserMarker(latitude, longitude);
      STATE.map.setView([latitude, longitude], 11);
    },
    (err) => {
      alert("GPS error: " + err.message + "\n\nYou can still browse the curated spots.");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

document.getElementById("closeDetail").addEventListener("click", () => {
  document.getElementById("detailPanel").classList.remove("open");
});

document.querySelectorAll(".social-tabs button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".social-tabs button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    STATE.socialSource = btn.dataset.src;
    renderSocial(STATE.posts);
  });
});

// ============================================================
//  START
// ============================================================

initMap();
refreshAll();
// refresh every 10 minutes
setInterval(refreshAll, 10 * 60 * 1000);
