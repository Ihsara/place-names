// heartlands.js — "The line where names change": per-country water/terrain
// naming split + a Finland<->Sweden bridge. Story facts come from
// web/heartlands.json (baked, honesty gate); glow dots from {fi,se,vn}.json.
"use strict";

const COUNTRY_FILE = { finland: "fi.json", sweden: "se.json", vietnam: "vn.json" };
const ID_COLOR = { finland: "#4cc9f0", sweden: "#ff9e4a", vietnam: "#ef476f" };
// Verdict palette (deferred): per-point verdict coloring needs a per-point verdict field in the baked points; the glow currently colors by theme/country identity. Kept for when points carry verdict.
const VERDICT_COLOR = { "on-feature": "#ffd166", "fossil": "#4895ef" };
const GREY_DIM = "#1a2236";

const cv  = document.getElementById("glow-canvas");
const ctx = cv.getContext("2d");
const stage = document.querySelector(".hl-stage");
let FACTS = null;            // heartlands.json
let POINTS = {};             // country -> baked points array
let PROJ = null, COORDS = null, DPR = window.devicePixelRatio || 1;
let ACTIVE = "finland";

function sizeCanvas() {
  const r = stage.getBoundingClientRect();
  cv.width = r.width * DPR; cv.height = r.height * DPR;
  cv.style.width = r.width + "px"; cv.style.height = r.height + "px";
  return [r.width, r.height];
}

function buildProjection(points, w, h) {
  const fc = { type: "FeatureCollection", features: points.map(p => ({
    type: "Feature", geometry: { type: "Point", coordinates: [p[0], p[1]] } })) };
  return d3.geoMercator().fitExtent([[16, 16], [w - 16, h - 16]], fc);
}

function buildCoordCache(points, proj) {
  const arr = new Float32Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    const xy = proj([points[i][0], points[i][1]]);
    arr[i*2] = xy[0]; arr[i*2+1] = xy[1];
  }
  return arr;
}

function drawGlow(colorFn) {
  const pts = POINTS[ACTIVE];
  if (!pts || !COORDS) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.save(); ctx.scale(DPR, DPR);
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < pts.length; i++) {
    const color = colorFn(pts[i], i);
    if (!color) continue;
    const cx = COORDS[i*2], cy = COORDS[i*2+1], r = 2.6;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, color); g.addColorStop(0.45, color); g.addColorStop(1, "transparent");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2*Math.PI); ctx.fill();
  }
  ctx.restore();
}

const overlay = document.getElementById("hl-overlay");
const STATE = { step: 0 };

function fact(country) { return FACTS.countries.find(c => c.country === country); }

// Draw the data-derived latitude line across the stage for `lat`.
function drawLine(lat) {
  overlay.innerHTML = "";
  if (lat == null || !PROJ) return;
  const [w, h] = [stage.getBoundingClientRect().width, stage.getBoundingClientRect().height];
  const y = PROJ([20, lat])[1];   // x is arbitrary; we want the y for this latitude
  overlay.insertAdjacentHTML("beforeend",
    `<line class="hl-line" x1="0" y1="${y}" x2="${w}" y2="${y}"></line>`);
}

// Color the glow by geo-tie verdict for a set of theme ids; others dim.
function cfVerdict(themeIds) {
  const set = new Set(themeIds);
  return (p) => set.has(p[2]) ? (ID_COLOR[ACTIVE]) : GREY_DIM;
}

function setCountry(country) {
  ACTIVE = country;
  const [w, h] = sizeCanvas();
  PROJ = buildProjection(POINTS[country], w, h);
  COORDS = buildCoordCache(POINTS[country], PROJ);
}

const STEPS = [
  { title: "Finland", country: "finland", line: null,
    html: (f) => `<h2>Finland names what it sees</h2>
      <p>Finnish places are named for water in the south and for high ground in the north. There is a latitude where the names change.</p>` },
  { title: "Water, south", country: "finland",
    line: (f) => fact("finland").water_line,
    themes: () => fact("finland").water.themes,
    html: (f) => { const s = fact("finland").water.split;
      return `<h2>Lakes, in the south</h2>
      <p>Of the lake-named heartlands south of the line, <strong>${s.south.on_feature}/${s.south.tested}</strong> sit on real water. The biggest lake-named heartland, near <strong>${fact("finland").top_water_hub.nearest_town}</strong>, has not yet been geo-tied.</p>`; } },
  { title: "Fells, north", country: "finland",
    line: (f) => fact("finland").terrain_line,
    themes: () => fact("finland").terrain.themes,
    html: (f) => { const s = fact("finland").terrain.split;
      return `<h2>Fells, in the northeast</h2>
      <p>North of the line the names turn to high ground. Of the terrain-named heartlands there, <strong>${s.north.fossil}/${s.north.tested}</strong> read as fossils against the water layer — they are named for the land, not the lake.</p>`; } },
  { title: "Sweden", country: "sweden",
    line: (f) => fact("sweden").terrain_line,
    themes: () => fact("sweden").terrain.themes,
    html: (f) => { const s = fact("sweden").terrain.split;
      return `<h2>Sweden, the same law in another language</h2>
      <p>Swedish lakes (<em>sjö</em>) cluster south; mountains (<em>berg</em>) reach north, where <strong>${s.north.fossil}/${s.north.tested}</strong> of the tested hill-heartlands are fossils — the same south-real, north-fossil gradient as Finland.</p>`; } },
  { title: "Vietnam", country: "vietnam", line: (f) => fact("vietnam").water_line,
    themes: () => fact("vietnam").water.themes,
    html: (f) => `<h2>Vietnam: the line is history, not terrain</h2>
      <p>Vietnam's split runs north–south by settlement age: delta-water names in the old north, the frontier word <em>tân</em> ("new") blooming across the late-settled south near <strong>${fact("vietnam").top_terrain_hub ? fact("vietnam").top_terrain_hub.nearest_town : fact("vietnam").top_water_hub.nearest_town}</strong>.</p>` },
  { title: "Finland ↔ Sweden", country: "finland", bridge: true,
    html: (f) => `<h2>The border the names can't see</h2>
      <p>The same naming-law crosses the Gulf. Each thread links a Finnish heartland to its Swedish cognate — <em>${FACTS.bridge.map(p => p.meaning).join(", ")}</em> — one landscape, two tongues, one older grammar of place.</p>` },
];

function drawBridge() {
  overlay.innerHTML = "";
  // Project FI and SE largest-hub centroids in the SAME Nordic frame and thread them.
  const nordic = POINTS.finland.concat(POINTS.sweden);
  const [w, h] = sizeCanvas();
  PROJ = buildProjection(nordic, w, h);
  // redraw both countries' dots dim, then threads
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.save(); ctx.scale(DPR, DPR); ctx.globalCompositeOperation = "screen";
  for (const country of ["finland", "sweden"]) {
    for (const p of POINTS[country]) {
      const xy = PROJ([p[0], p[1]]);
      const g = ctx.createRadialGradient(xy[0], xy[1], 0, xy[0], xy[1], 2.2);
      g.addColorStop(0, ID_COLOR[country]); g.addColorStop(0.45, ID_COLOR[country]); g.addColorStop(1, "transparent");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(xy[0], xy[1], 2.2, 0, 2*Math.PI); ctx.fill();
    }
  }
  ctx.restore();
  for (const p of FACTS.bridge) {
    const a = PROJ(p.fi_centroid), b = PROJ(p.se_centroid);
    const mx = (a[0]+b[0])/2, my = Math.min(a[1], b[1]) - 30;
    overlay.insertAdjacentHTML("beforeend",
      `<path class="hl-thread" d="M${a[0]},${a[1]} Q${mx},${my} ${b[0]},${b[1]}"></path>`);
  }
  PROJ = null;
}

function renderStep() {
  const s = STEPS[STATE.step];
  document.getElementById("step-body").innerHTML = s.html(FACTS);
  document.getElementById("step-count").textContent = `${STATE.step + 1} / ${STEPS.length}`;
  document.getElementById("step-chips").innerHTML = STEPS.map((st, i) =>
    `<button class="step-chip${i === STATE.step ? " is-active" : ""}" data-i="${i}">${st.title}</button>`).join("");
  document.querySelectorAll(".step-chip").forEach(el =>
    el.addEventListener("click", () => { STATE.step = +el.dataset.i; renderStep(); }));
  if (s.bridge) { drawBridge(); return; }
  if (ACTIVE !== s.country || PROJ === null) setCountry(s.country);
  const themes = s.themes ? s.themes() : null;
  drawGlow(themes ? cfVerdict(themes) : (() => ID_COLOR[s.country]));
  drawLine(s.line ? s.line(FACTS) : null);
}

document.getElementById("next").addEventListener("click", () => {
  STATE.step = Math.min(STEPS.length - 1, STATE.step + 1); renderStep(); });
document.getElementById("prev").addEventListener("click", () => {
  STATE.step = Math.max(0, STATE.step - 1); renderStep(); });

async function boot() {
  try {
    FACTS = await (await fetch("heartlands.json")).json();
    const entries = await Promise.all(Object.entries(COUNTRY_FILE).map(
      async ([c, f]) => [c, (await (await fetch(f)).json()).points]));
    for (const [c, pts] of entries) POINTS[c] = pts;
    setCountry("finland");
    renderStep();
    window.addEventListener("resize", () => renderStep());
  } catch (err) {
    console.error("heartlands: failed to load story data", err);
    document.getElementById("step-body").innerHTML = "<p>Sorry — the story data could not be loaded.</p>";
  }
}

boot();
