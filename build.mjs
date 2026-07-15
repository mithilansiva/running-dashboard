// build.mjs — runs in GitHub Actions. Fetches your Strava + weather, bakes the data into the
// dashboard template, and writes public/index.html for GitHub Pages. No always-on server needed.
// Node 20+ (uses global fetch). Secrets come from env (set as GitHub Actions secrets).
import { readFile, writeFile, mkdir } from "node:fs/promises";

const {
  STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN,
  WEATHER_CITY = "London",
  DETAIL_BUDGET = "40",           // how many activities to pull full detail for (best-efforts/routes)
} = process.env;

if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET || !STRAVA_REFRESH_TOKEN) {
  console.error("Missing Strava secrets (STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET / STRAVA_REFRESH_TOKEN).");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function stravaToken() {
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token", refresh_token: STRAVA_REFRESH_TOKEN }),
  });
  if (!r.ok) throw new Error("Token refresh failed: " + r.status + " " + await r.text());
  return (await r.json()).access_token;
}

async function getJSON(url, token) {
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (r.status === 429) throw new Error("RATE_LIMIT");
  if (!r.ok) throw new Error(url + " → " + r.status);
  return r.json();
}

// --- Strava ---------------------------------------------------------------------------------
async function fetchActivities(token) {
  const after = Math.floor((Date.now() - 365 * 86400000) / 1000);
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await getJSON(`https://www.strava.com/api/v3/athlete/activities?per_page=100&page=${page}&after=${after}`, token);
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
    await sleep(300);
  }
  // map to the shape the dashboard expects, runs only
  return out.filter(a => /run/i.test(a.sport_type || a.type || "")).map(a => ({
    id: a.id, name: a.name, type: a.sport_type || a.type, date: a.start_date,
    distance_km: (a.distance || 0) / 1000, moving_time_min: (a.moving_time || 0) / 60,
    avg_hr: a.average_heartrate || null, max_hr: a.max_heartrate || null,
    elevation_gain_m: a.total_elevation_gain || 0,
  }));
}

async function fetchShoes(token) {
  try { const me = await getJSON("https://www.strava.com/api/v3/athlete", token); return me.shoes || []; }
  catch { return []; }
}

// Full detail → best efforts, grade-adjusted factor, route polyline (mirrors the dashboard's ingestDetail)
async function fetchDetails(token, activities, budget) {
  const be = {}, gap = {}, routes = {}, routeMeta = {};
  const byPace = [...activities].filter(a => a.distance_km >= 1.6 && a.moving_time_min > 0)
    .sort((x, y) => x.moving_time_min / x.distance_km - y.moving_time_min / y.distance_km);
  const recent = [...activities].sort((a, b) => new Date(b.date) - new Date(a.date));
  const pick = new Map();
  byPace.slice(0, 25).forEach(a => pick.set(a.id, a));   // fastest → best efforts
  recent.slice(0, 30).forEach(a => pick.set(a.id, a));   // recent → route thumbnails
  const ids = [...pick.keys()].slice(0, +budget);
  for (const id of ids) {
    try {
      const d = await getJSON(`https://www.strava.com/api/v3/activities/${id}?include_all_efforts=true`, token);
      const line = d.map && (d.map.polyline || d.map.summary_polyline);
      if (line) routes[id] = line;
      else routeMeta[id] = (d.trainer || d.manual || /virtual|treadmill/i.test(d.sport_type || d.type || "")) ? "indoor" : "nogps";
      if (Array.isArray(d.best_efforts)) {
        const m = {}; for (const b of d.best_efforts) if (b && b.name && b.moving_time) m[b.name] = b.moving_time;
        be[id] = m;
      }
      if (Array.isArray(d.splits_metric) && d.splits_metric.length) {
        let raw = 0, g = 0;
        for (const s of d.splits_metric) {
          const dist = s.distance || 0, rs = s.average_speed || 0, gs = s.average_grade_adjusted_speed || rs;
          if (dist && rs && gs) { raw += dist / rs; g += dist / gs; }
        }
        if (raw > 0 && g > 0) gap[id] = +(g / raw).toFixed(4);
      }
      await sleep(400);
    } catch (e) { if (String(e.message).includes("RATE_LIMIT")) { console.warn("Rate limited — stopping detail pass"); break; } }
  }
  return { be, gap, routes, routeMeta };
}

// --- Weather (Open-Meteo, no key) -----------------------------------------------------------
const WMO = { 0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 80: "Rain showers", 81: "Rain showers", 82: "Violent showers",
  95: "Thunderstorm", 96: "Thunderstorm + hail", 99: "Thunderstorm + hail" };
async function fetchWeatherText(city) {
  try {
    const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`)).json();
    const loc = g.results && g.results[0]; if (!loc) return null;
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
      `&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m` +
      `&wind_speed_unit=kmh&timezone=auto`;
    const w = (await (await fetch(u)).json()).current; if (!w) return null;
    const place = [loc.name, loc.admin1, loc.country].filter(Boolean).join(", ");
    return `**Current Weather for ${place}** (${loc.timezone})\n` +
      `**Condition**: ${WMO[w.weather_code] || "—"}\n` +
      `**Temperature**: ${w.temperature_2m}°C\n` +
      `**Feels Like**: ${w.apparent_temperature}°C\n` +
      `**Wind**: ${w.wind_speed_10m}km/h\n` +
      `**Wind Gusts**: ${w.wind_gusts_10m}km/h\n` +
      `**Precipitation**: ${w.precipitation}mm\n`;
  } catch { return null; }
}

// --- Build ----------------------------------------------------------------------------------
(async () => {
  const token = await stravaToken();
  const activities = await fetchActivities(token);
  console.log(`Fetched ${activities.length} runs`);
  const shoes = await fetchShoes(token);
  const { be, gap, routes, routeMeta } = await fetchDetails(token, activities, DETAIL_BUDGET);
  const weatherText = await fetchWeatherText(WEATHER_CITY);

  // Optional: plan adaptations exported from the desktop app (plan-state.json in the repo root)
  let planState = null;
  try { planState = JSON.parse(await readFile("plan-state.json", "utf8")); console.log("Loaded plan-state.json"); }
  catch { console.log("No plan-state.json — using base plan with auto-matching"); }

  const snapshot = { activities, shoes, weatherText, be, gap, routes, routeMeta, planState, builtAt: new Date().toISOString() };
  const json = JSON.stringify(snapshot).replace(/</g, "\\u003c"); // safe to embed in HTML

  let html = await readFile("template.html", "utf8");
  const inject = `<script>window.SNAPSHOT=${json};</script>`;
  html = html.includes("</head>") ? html.replace("</head>", inject + "\n</head>") : inject + html;

  await mkdir("public", { recursive: true });
  await writeFile("public/index.html", html);
  console.log("Wrote public/index.html — runs:", activities.length, "details:", Object.keys(be).length);
})().catch(e => { console.error(e); process.exit(1); });
