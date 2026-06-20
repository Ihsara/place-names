/* web/hotspots.js — frequency & cluster page. Reuses islands.js canvas-glow +
   d3-quadtree patterns. Scatter points from {c}.json [lon,lat,morphId,rank,frag];
   list/clusters from {c}-freq.json. */
const R_GLOW = 2.1;
const GREY_UNC = "#9aa3b2";
const GREY_DIM = "rgba(154,163,178,0.18)";
const FILES = { fi: "fi", se: "se", vn: "vn" };

let DATA = null;     // {c}.json
let FREQ = null;     // {c}-freq.json
let PROJ = null, COORDS = null, QUAD = null;
let COUNTRY = "fi";
let MORPH_COLOR = {};   // id -> hue (from FREQ.morphemes)

const cv = document.getElementById("glow-canvas");
const ctx = cv.getContext("2d");
let DPR = Math.max(1, window.devicePixelRatio || 1);

const STATE = { step: 0, steps: [], active: null /* morpheme id isolated */ };

function sizeCanvas() {
  const r = cv.getBoundingClientRect();
  DPR = Math.max(1, window.devicePixelRatio || 1);
  cv.width = r.width * DPR; cv.height = r.height * DPR;
}

function projection() {
  const r = cv.getBoundingClientRect();
  const fc = { type: "FeatureCollection",
    features: DATA.points.map(p => ({ type: "Feature",
      geometry: { type: "Point", coordinates: [p[0], p[1]] } })) };
  return d3.geoMercator().fitExtent([[12, 16], [r.width - 12, r.height - 16]], fc);
}

function buildCoordCache() {
  const pts = DATA.points, arr = new Float32Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    const xy = PROJ([pts[i][0], pts[i][1]]);
    arr[i*2] = xy[0]; arr[i*2+1] = xy[1];
  }
  return arr;
}
function buildQuad() {
  const qt = d3.quadtree().x(i => COORDS[i*2]).y(i => COORDS[i*2+1]);
  qt.addAll(DATA.points.map((_, i) => i));
  return qt;
}

// colorFn(point,i) -> css color | null (null = skip)
function drawGlowCanvas(colorFn) {
  if (!DATA || !PROJ || !COORDS) return;
  const pts = DATA.points;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.save(); ctx.scale(DPR, DPR); ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < pts.length; i++) {
    const color = colorFn(pts[i], i);
    if (!color) continue;
    const cx = COORDS[i*2], cy = COORDS[i*2+1];
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R_GLOW);
    g.addColorStop(0, color); g.addColorStop(0.45, color); g.addColorStop(1, "transparent");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R_GLOW, 0, 2*Math.PI); ctx.fill();
  }
  ctx.restore();
}

/* colour functions */
function cfAll() { return (p) => p[2] ? (MORPH_COLOR[p[2]] || GREY_UNC) : GREY_DIM; }
function cfMorpheme(id) { const col = MORPH_COLOR[id] || GREY_UNC;
  return (p) => (p[2] === id ? col : (p[2] ? GREY_DIM : null)); }
function cfUncurated() { return (p) => (p[2] ? GREY_DIM : GREY_UNC); }

/* frequency list */
function renderFreqList() {
  const ol = document.getElementById("freq-list");
  const max = FREQ.morphemes.length ? FREQ.morphemes[0].count : 1;
  ol.innerHTML = "";
  FREQ.morphemes.forEach(m => {
    const li = document.createElement("li");
    li.dataset.id = m.id;
    li.classList.toggle("active", STATE.active === m.id);
    li.innerHTML =
      `<span class="name" style="color:${m.color}">${m.element}</span>` +
      `<span class="meta">${m.count} · ${m.n_clusters} clusters</span>` +
      `<span class="gloss">${m.gloss}</span>` +
      `<span class="bar" style="width:${Math.max(6, 100*m.count/max)}%;background:${m.color}"></span>`;
    li.addEventListener("mouseenter", () => isolate(m.id));
    li.addEventListener("click", () => isolate(m.id));
    ol.appendChild(li);
  });
}

async function loadCountry(c) {
  COUNTRY = c;
  [DATA, FREQ] = await Promise.all([d3.json(`${FILES[c]}.json`), d3.json(`${FILES[c]}-freq.json`)]);
  MORPH_COLOR = {}; FREQ.morphemes.forEach(m => MORPH_COLOR[m.id] = m.color);
  sizeCanvas();
  PROJ = projection();
  COORDS = buildCoordCache();
  QUAD = buildQuad();
  renderFreqList();
}

/* ---- cluster rings (SVG over the canvas) ------------------------------- */
const ringSvg = d3.select("#ring-layer");
// project a km radius to px: project centroid + a point offset in latitude.
function radiusPx(lon, lat, km) {
  const a = PROJ([lon, lat]);
  const dLat = km / 111.0;                       // ~111 km per degree latitude
  const b = PROJ([lon, lat + dLat]);
  return Math.hypot(b[0]-a[0], b[1]-a[1]);
}
function drawRings(hubs, color) {
  const r = cv.getBoundingClientRect();
  ringSvg.attr("viewBox", `0 0 ${r.width} ${r.height}`);
  ringSvg.selectAll("*").remove();
  hubs.forEach(h => {
    const [x, y] = PROJ(h.centroid);
    const rad = Math.max(6, radiusPx(h.centroid[0], h.centroid[1], h.radius_km));
    ringSvg.append("circle").attr("cx", x).attr("cy", y).attr("r", rad)
      .attr("fill", "none").attr("stroke", color).attr("stroke-opacity", 0.7).attr("stroke-width", 1.4);
    ringSvg.append("text").attr("x", x).attr("y", y - rad - 4).attr("text-anchor", "middle")
      .attr("fill", color).attr("font-size", 11).attr("font-family", "Inter,sans-serif")
      .text(`${h.nearest_town} · ${h.count}`);
  });
}
function clearRings() { ringSvg.selectAll("*").remove(); }

function isolate(id) {
  STATE.active = id;
  const m = FREQ.morphemes.find(x => x.id === id);
  if (!m) return;
  drawGlowCanvas(cfMorpheme(id));
  drawRings(m ? m.hubs : [], (m && m.color) || GREY_UNC);
  renderFreqList();
  const note = COUNTRY === "vn"
    ? ` <span class="callout">VN clusters mark where the admin word concentrates — not a land-feature claim.</span>` : "";
  setCard(`<h2>${m.element} — ${m.gloss}</h2><p>${m.count} names in ${m.n_clusters} clusters. Rings show each cluster's spread; the label names the nearest town and how many names it gathers.${note}</p>`);
  syncHash();
}

/* ---- co-locations ------------------------------------------------------ */
function drawCoLocations() {
  STATE.active = null; clearRings();
  drawGlowCanvas(cfAll());
  const r = cv.getBoundingClientRect();
  ringSvg.attr("viewBox", `0 0 ${r.width} ${r.height}`);
  // skip the giant "everything" co-location (themes covering most of the country)
  const pairs = FREQ.co_locations.filter(c => c.themes.length <= 4);
  pairs.forEach(c => {
    const [x, y] = PROJ(c.centroid);
    const rad = Math.max(6, radiusPx(c.centroid[0], c.centroid[1], c.radius_km));
    ringSvg.append("circle").attr("cx", x).attr("cy", y).attr("r", rad)
      .attr("fill", "none").attr("stroke", "#ffd166").attr("stroke-opacity", 0.8).attr("stroke-width", 1.4);
    ringSvg.append("text").attr("x", x).attr("y", y - rad - 4).attr("text-anchor", "middle")
      .attr("fill", "#ffd166").attr("font-size", 11).text(c.themes.join(" + "));
  });
  setCard(`<h2>Words that sit together</h2><p>Where different naming words cluster in the same place — coastal twins and shared valleys.</p>`);
}

/* ---- uncurated tail ---------------------------------------------------- */
function drawUncurated() {
  STATE.active = null; clearRings();
  drawGlowCanvas(cfUncurated());
  const rows = FREQ.uncurated_tail.map(t => `<li><b>${t.fragment}</b> · ${t.count}</li>`).join("");
  const callout = COUNTRY === "fi" ? `<div class="callout">kirkko (church) is hidden inside -kylä: kirkonkylä, "church-village", counts as kylä, so kirkko never appears on its own. This is what an uncurated gap looks like.</div>` : "";
  setCard(`<h2>What we can't read yet</h2><p>The top fragments the map cannot explain — raw last-4-char fragments, <em>not</em> morphemes.</p><ul style="margin:6px 0 0;padding-left:18px;color:var(--muted)">${rows}</ul>${callout}`);
}

/* ---- stepper ----------------------------------------------------------- */
function setCard(html) { document.getElementById("step-card").innerHTML = html; }
function buildSteps() {
  const top = FREQ.morphemes[0];
  return [
    { id: "intro", run: () => { STATE.active=null; clearRings(); drawGlowCanvas(cfAll());
        setCard(`<h2>The words we curated</h2><p>How common is each place-word, and do they cluster? The list on the left is ranked by frequency — hover any row to light it on the map with its clusters.</p>`); } },
    { id: "overview", run: () => { STATE.active=null; clearRings(); drawGlowCanvas(cfAll());
        setCard(`<h2>Frequency overview</h2><p>Every curated word at once. ${top.element} leads with ${top.count} names.</p>`); } },
    { id: "colocations", run: drawCoLocations },
    { id: "uncurated", run: drawUncurated },
    { id: "explore", run: () => { STATE.active=null; clearRings(); drawGlowCanvas(cfAll());
        setCard(`<h2>Explore</h2><p>Click any word in the list to isolate it and draw its clusters. The frequency list is your index into the map.</p>`); } },
  ];
}
function renderStep() {
  const s = STATE.steps[STATE.step];
  s.run();
  document.getElementById("step-count").textContent = `${STATE.step+1} / ${STATE.steps.length}`;
  document.getElementById("prev").disabled = STATE.step === 0;
  document.getElementById("next").disabled = STATE.step === STATE.steps.length - 1;
  syncHash();
}

/* ---- hover tooltip ----------------------------------------------------- */
const tip = document.getElementById("tip");
cv.parentElement.addEventListener("pointermove", (e) => {
  if (!QUAD) return;
  const r = cv.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  const i = QUAD.find(px, py, 10);
  if (i == null) { tip.style.display = "none"; return; }
  const p = DATA.points[i];
  tip.textContent = p[4] || "(unnamed)";
  tip.style.display = "block";
  tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 250) + "px";
  tip.style.top = (e.clientY + 12) + "px";
});
cv.parentElement.addEventListener("pointerleave", () => { tip.style.display = "none"; });

/* ---- hash -------------------------------------------------------------- */
function parseHash() {
  const m = location.hash.match(/^#hotspots\/(fi|se|vn)(?:\/([\w-]+))?$/);
  if (!m) return null;
  return { country: m[1], target: m[2] || null };
}
function syncHash() {
  const s = STATE.steps[STATE.step];
  const tgt = STATE.active ? STATE.active : (s.id === "uncurated" ? "uncurated" : s.id);
  history.replaceState(null, "", `#hotspots/${COUNTRY}/${tgt}`);
}

/* ---- nav + country toggle + boot --------------------------------------- */
document.getElementById("prev").addEventListener("click", () => { if (STATE.step>0){STATE.step--;renderStep();} });
document.getElementById("next").addEventListener("click", () => { if (STATE.step<STATE.steps.length-1){STATE.step++;renderStep();} });
document.addEventListener("keydown", (e) => {
  if (e.altKey||e.ctrlKey||e.metaKey||e.shiftKey) return;
  if (e.key === "ArrowLeft" && STATE.step>0){STATE.step--;renderStep();}
  if (e.key === "ArrowRight" && STATE.step<STATE.steps.length-1){STATE.step++;renderStep();}
});
document.querySelectorAll(".country-toggle button").forEach(b =>
  b.addEventListener("click", async () => {
    document.querySelectorAll(".country-toggle button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    await loadCountry(b.dataset.country);
    STATE.steps = buildSteps(); STATE.step = 0; STATE.active = null; renderStep();
  }));

let RESIZE;
window.addEventListener("resize", () => { clearTimeout(RESIZE); RESIZE = setTimeout(() => {
  if (!DATA) return; sizeCanvas(); PROJ = projection(); COORDS = buildCoordCache(); QUAD = buildQuad(); renderStep();
}, 150); });

(async function boot() {
  try {
    const restore = parseHash();
    const c = restore ? restore.country : "fi";
    document.querySelectorAll(".country-toggle button").forEach(x =>
      x.classList.toggle("active", x.dataset.country === c));
    await loadCountry(c);
    STATE.steps = buildSteps();
    STATE.step = 0;
    renderStep();
    if (restore && restore.target) {
      if (restore.target === "uncurated") { STATE.step = STATE.steps.findIndex(s=>s.id==="uncurated"); renderStep(); }
      else if (FREQ.morphemes.some(m => m.id === restore.target)) { STATE.step = STATE.steps.length-1; renderStep(); isolate(restore.target); }
      else { const si = STATE.steps.findIndex(s=>s.id===restore.target); if (si>=0){STATE.step=si;renderStep();} }
    }
  } catch (err) {
    document.getElementById("step-card").innerHTML = `<h2>Couldn't load</h2><p>${err}</p>`;
    console.error(err);
  }
})();
