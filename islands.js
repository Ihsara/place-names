// islands.js — Nordic island toponymy four-act story.
// Point format: [lon, lat, morphemeId|null, size_class|null, osm_name|null]
"use strict";

/* ---- palette constants ---------------------------------------------------- */
const SIZE_COLOR = {
  island: "#ffd166", islet: "#06d6a0", skerry: "#4cc9f0",
  rock: "#bd93f9", shoal: "#5a6988", landform: "#ff8e6e",
};
const STOCK_COLOR = { swedish: "#ff9e4a", finnic: "#4cc9f0" };
const STRATUM_COLOR = { norse: "#c77dff", swedish: "#ff9e4a", finnish: "#4cc9f0" };
// Truthfulness: warm=honest, cool=fossil
function truthColor(t) {
  if (t === undefined || t === null) return "#3a4258";
  if (t >= 0.85) return "#ffd166";
  if (t >= 0.65) return "#f4a261";
  if (t >= 0.45) return "#9aa3b2";
  return "#4895ef";
}
const GREY_DIM = "#1a2236";   // near-invisible on dark bg (uncurated / out-of-step)
const GREY_UNC = "#3a4258";   // uncurated in steps where colour is by morpheme

/* ---- canvas / projection globals ----------------------------------------- */
const cv   = document.getElementById("glow-canvas");
const ctx  = cv.getContext("2d");
const wrap = document.getElementById("map-wrap");
const tipEl = document.getElementById("tip");
let DATA = null;          // loaded JSON
let MORPH_BY_ID = {};     // id -> morpheme object
let TRUTH = {};           // morphemeId -> truthfulness value
let COORDS = null;        // Float32Array [x0,y0, x1,y1, ...] in CSS px
let PROJ = null;
let QUAD = null;
let DPR = window.devicePixelRatio || 1;
let COUNTRY = "se";
let _loadGen = 0;
let _resizeTimer = null;
let BOOTING = true;

/* ---- step state ---------------------------------------------------------- */
const STATE = { step: 0, steps: [], inspected: null };

/* ---- canvas helpers ------------------------------------------------------- */
function sizeCanvas() {
  const r = wrap.getBoundingClientRect();
  cv.width  = r.width  * DPR;
  cv.height = r.height * DPR;
  cv.style.width  = r.width  + "px";
  cv.style.height = r.height + "px";
  return [r.width, r.height];
}

function buildProjection(points, w, h) {
  const fc = {
    type: "FeatureCollection",
    features: points.map(p => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p[0], p[1]] }
    }))
  };
  return d3.geoMercator().fitExtent([[12, 16], [w - 12, h - 16]], fc);
}

// Cache projected [x,y] for every point into a flat Float32Array.
function buildCoordCache(points, proj) {
  const arr = new Float32Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    const xy = proj([points[i][0], points[i][1]]);
    arr[i * 2]     = xy[0];
    arr[i * 2 + 1] = xy[1];
  }
  return arr;
}

// Quadtree over integer indices; x/y read from COORDS to avoid double projection.
function buildQuadtreeFromCache(points, coords) {
  const qt = d3.quadtree()
    .x(i => coords[i * 2])
    .y(i => coords[i * 2 + 1]);
  qt.addAll(points.map((_, i) => i));
  return qt;
}

/* ---- draw ----------------------------------------------------------------- */
// colorFn(point, index) -> CSS color | null  (null = skip this point entirely)
function drawGlowCanvas(colorFn) {
  if (!DATA || !PROJ || !COORDS) return;
  const points = DATA.points;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.save();
  ctx.scale(DPR, DPR);
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < points.length; i++) {
    const color = colorFn(points[i], i);
    if (!color) continue;
    const cx = COORDS[i * 2];
    const cy = COORDS[i * 2 + 1];
    const r = 1.8;   // was 2.8 — islands is the densest view (29k dots); canvas + 12px quadtree hit-test keeps hover intact (2026-06-20)
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, color);
    g.addColorStop(0.45, color);
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.restore();
}

/* ---- step color functions ------------------------------------------------- */
function cfSizeAll() {
  return (p) => p[3] ? (SIZE_COLOR[p[3]] || GREY_UNC) : GREY_DIM;
}
function cfSizeClass(cls) {
  const lit = SIZE_COLOR[cls] || GREY_UNC;
  return (p) => {
    if (!p[3]) return null;
    return p[3] === cls ? lit : null;
  };
}
function cfTruth() {
  return (p) => p[2] ? truthColor(TRUTH[p[2]]) : GREY_DIM;
}
function cfTruthMorpheme(morphId) {
  const col = truthColor(TRUTH[morphId]);
  return (p) => (!p[2] || p[2] !== morphId) ? null : col;
}
function cfStock(stock) {
  if (!stock) {
    return (p) => {
      if (!p[2]) return GREY_DIM;
      const m = MORPH_BY_ID[p[2]];
      return m ? (STOCK_COLOR[m.stock] || GREY_UNC) : GREY_DIM;
    };
  }
  const lit = STOCK_COLOR[stock] || GREY_UNC;
  return (p) => {
    if (!p[2]) return null;
    const m = MORPH_BY_ID[p[2]];
    return (m && m.stock === stock) ? lit : null;
  };
}
function cfStratum(stratum) {
  if (!stratum) {
    return (p) => {
      if (!p[2]) return GREY_DIM;
      const m = MORPH_BY_ID[p[2]];
      return (m && m.stratum) ? (STRATUM_COLOR[m.stratum] || GREY_UNC) : GREY_DIM;
    };
  }
  const lit = STRATUM_COLOR[stratum] || GREY_UNC;
  return (p) => {
    if (!p[2]) return null;
    const m = MORPH_BY_ID[p[2]];
    return (m && m.stratum === stratum) ? lit : null;
  };
}
function cfHumanUse() {
  return (p) => {
    if (!p[2]) return GREY_DIM;
    const m = MORPH_BY_ID[p[2]];
    return (m && m.use_category) ? "#80ffdb" : GREY_DIM;
  };
}
// Light ONLY the uncurated points (no curated morpheme) — the 44% we can't read.
function cfUncurated() {
  return (p) => (p[2] ? GREY_DIM : "#ff8e6e");
}
// Light ONLY the newly-promoted morphemes (the recovered vocabulary).
const PROMOTED_IDS = new Set(["nas", "udden", "berg", "oren", "klobb", "niemi"]);
function cfPromoted() {
  return (p) => {
    if (!p[2] || !PROMOTED_IDS.has(p[2])) return GREY_DIM;
    const m = MORPH_BY_ID[p[2]];
    return m ? (SIZE_COLOR[m.size_class] || GREY_UNC) : GREY_UNC;
  };
}

/* ---- tooltip -------------------------------------------------------------- */
let _tipPinned = false;

function showTip(html, x, y) {
  tipEl.innerHTML = html;
  tipEl.style.display = "block";
  const tw = tipEl.offsetWidth  || 200;
  const th = tipEl.offsetHeight || 40;
  tipEl.style.left = Math.min(x + 14, window.innerWidth  - tw - 8) + "px";
  tipEl.style.top  = Math.min(y + 14, window.innerHeight - th - 8) + "px";
}
function hideTip() {
  if (_tipPinned) return;
  tipEl.style.display = "none";
}

function tipHTMLForPoint(p) {
  if (!p[4]) return null;
  const m = p[2] ? MORPH_BY_ID[p[2]] : null;
  const gloss = m ? m.gloss : "uncurated";
  const sc    = p[3] || "?";
  return `<strong>${p[4]}</strong> — ${gloss} <span style="color:var(--muted)">(${sc})</span>`;
}

cv.addEventListener("pointermove", (e) => {
  if (!QUAD || _tipPinned) return;
  const rect = cv.getBoundingClientRect();
  const idx = QUAD.find(e.clientX - rect.left, e.clientY - rect.top, 12);
  if (idx === undefined) { hideTip(); return; }
  const html = tipHTMLForPoint(DATA.points[idx]);
  if (html) showTip(html, e.clientX, e.clientY);
  else hideTip();
});

cv.addEventListener("pointerdown", (e) => {
  if (!QUAD) return;
  const rect = cv.getBoundingClientRect();
  const idx = QUAD.find(e.clientX - rect.left, e.clientY - rect.top, 12);
  if (idx === undefined) { _tipPinned = false; tipEl.style.display = "none"; return; }
  const p = DATA.points[idx];
  const html = tipHTMLForPoint(p);
  if (html) {
    showTip(html, e.clientX, e.clientY);
    _tipPinned = true;
    showInspector(p);
  }
});

cv.addEventListener("pointerleave", () => {
  if (!_tipPinned) tipEl.style.display = "none";
});

document.addEventListener("pointerdown", (e) => {
  if (e.target !== cv) { _tipPinned = false; tipEl.style.display = "none"; }
}, true);

/* ---- inspector ------------------------------------------------------------ */
function showInspector(p) {
  STATE.inspected = p;
  const m    = p[2] ? MORPH_BY_ID[p[2]] : null;
  const name = p[4] || "(unnamed)";
  const sc   = p[3] || "?";

  let html = `<div class="inspector">
    <h3 class="insp-name">${name}</h3>
    <p class="insp-sc">OSM size class: <strong>${sc}</strong></p>`;

  if (!m) {
    html += `<p class="insp-verdict uncurated">No curated morpheme found — we don't guess at etymologies outside our word list.</p>`;
  } else {
    const t = TRUTH[p[2]];
    const tPct = t !== undefined ? Math.round(t * 100) : null;
    const morphClaims = m.size_class;
    const isTruthful  = sc === morphClaims;
    let verdictClass, verdictText;
    if (tPct === null) {
      verdictClass = ""; verdictText = "No truthfulness data available.";
    } else if (t >= 0.75) {
      verdictClass = "truthful";
      verdictText  = `<strong>Truthful.</strong> <em>${m.element}</em> (${m.gloss}) claims "${morphClaims}" — and ${tPct}% of features carrying it are indeed that size.`;
    } else if (t >= 0.45) {
      verdictClass = "mixed";
      verdictText  = `<strong>Mixed.</strong> <em>${m.element}</em> (${m.gloss}) claims "${morphClaims}" — but only ${tPct}% of features match that size.`;
    } else {
      verdictClass = "fossil";
      verdictText  = `<strong>Fossil.</strong> <em>${m.element}</em> (${m.gloss}) claims "${morphClaims}" — only ${tPct}% of features carrying it match. The name has outlived its original meaning.`;
    }
    verdictText += isTruthful
      ? " This feature is one that does match."
      : ` This feature (${sc}) does <em>not</em> match what the name claims.`;
    html += `<p class="insp-morph">Morpheme: <em>${m.element}</em> — ${m.gloss}</p>
      <p class="insp-verdict ${verdictClass}">${verdictText}</p>`;
  }
  html += `<button class="insp-back" id="insp-back">‹ back to step</button></div>`;
  document.getElementById("step-body").innerHTML = html;
  document.getElementById("insp-back").addEventListener("click", () => {
    STATE.inspected = null;
    renderStep();
  });
}

/* ---- step definitions ----------------------------------------------------- */
function buildSteps() {
  const C = COUNTRY;

  // Baked counts — written against the data, never inferred from JSON
  const FI = { saari:9214, kari:1752, skar:1729, holmen:1458, luoto:1230,
    holm:674, o:413, grund:403, badan:238, on:151, landet:124, letto:98, kallio:87, hamn:9 };
  const SE = { holmen:4866, on:1892, skar:1748, o:1366, holm:161, saari:160,
    grund:147, badan:121, kari:32, hamn:12, landet:10, letto:5, luoto:2, munk:1 };
  const CNT = C === "fi" ? FI : SE;

  const total    = C === "fi" ? "29,150" : "18,689";
  const curated  = C === "fi" ? "18,638 (63.9%)" : "10,981 (58.8%)";
  const country  = C === "fi" ? "Finland" : "Sweden";

  // Per-country truthfulness from bake (hard-coded so copy never drifts from data)
  const T_FI = { saari:0.148, kari:0.621, skar:0.773, holmen:0.991, luoto:0.916,
    holm:0.986, o:0.750, grund:0.487, badan:0.575, on:0.846, landet:0.193, letto:0.835, kallio:0.871, hamn:0.444 };
  const T_SE = { holmen:0.939, on:0.263, skar:0.906, o:0.305, holm:0.950, saari:0.371,
    grund:0.725, badan:0.353, kari:0.156, hamn:0.417, landet:0.200, letto:1.0, luoto:0.5, munk:1.0 };
  const pct = (id) => {
    const v = C === "fi" ? T_FI[id] : T_SE[id];
    return v !== undefined ? Math.round(v * 100) + "%" : "—";
  };

  const SwedishStockFI = FI.holmen + FI.skar + FI.holm + FI.o + FI.on + FI.landet + FI.grund + FI.badan;
  const FinnicStockFI  = FI.saari + FI.luoto + FI.kari + FI.letto + FI.kallio;
  const SwedishStockSE = SE.holmen + SE.skar + SE.on + SE.o + SE.holm + SE.grund + SE.badan + SE.landet;
  const FinnicStockSE  = SE.saari + SE.luoto + SE.kari + SE.letto;

  const steps = [];

  // ── ACT I ──────────────────────────────────────────────────────────────────
  steps.push({
    actId:"act1", actLabel:"I · The water's taxonomy",
    title:"Act I — The water's taxonomy",
    body:`<p>The Nordic archipelago has <strong>${total}</strong> named water features. Cartographers here needed words for <em>everything</em> — from full islands you could farm, down to exposed rocks you might wreck on.</p>
<p>Of those ${total} features, <strong>${curated}</strong> carry a name-ending our word list recognises. Step through to see each size class.</p>
<div class="legend-grid">
  <span class="dot" style="background:${SIZE_COLOR.island}"></span><span>island</span>
  <span class="dot" style="background:${SIZE_COLOR.islet}"></span><span>islet</span>
  <span class="dot" style="background:${SIZE_COLOR.skerry}"></span><span>skerry</span>
  <span class="dot" style="background:${SIZE_COLOR.rock}"></span><span>rock</span>
  <span class="dot" style="background:${SIZE_COLOR.shoal}"></span><span>shoal</span>
  <span class="dot" style="background:${SIZE_COLOR.landform}"></span><span>landform (names land, not water)</span>
</div>`,
    colorFn: cfSizeAll(),
  });

  steps.push({
    actId:"act1", actLabel:"I · The water's taxonomy",
    title:"Islands",
    body:`<p>The biggest features. The island words in ${country}:
${C==="fi"
  ? `<em>saari</em> (${FI.saari.toLocaleString()}), <em>ö/ön</em> (${(FI.o+FI.on).toLocaleString()}), <em>landet</em> (${FI.landet.toLocaleString()})`
  : `<em>ön</em> (${SE.on.toLocaleString()}), <em>ö</em> (${SE.o.toLocaleString()}), <em>landet</em> (${SE.landet.toLocaleString()}), <em>saari</em> (${SE.saari.toLocaleString()})`
}.</p>
<p>These names claim to mark real islands — large enough to walk on, distinct enough to farm. We'll test that claim later.</p>`,
    colorFn: cfSizeClass("island"),
  });

  steps.push({
    actId:"act1", actLabel:"I · The water's taxonomy",
    title:"Islets",
    body:`<p>Smaller than an island — too small to farm, large enough to anchor by. The islet words: <em>holmen</em> (${CNT.holmen.toLocaleString()}) and <em>holm</em> (${(CNT.holm||0).toLocaleString()}).</p>
<p>These Norse words are ancient, spread by Viking-era settlement along every navigable coast.</p>`,
    colorFn: cfSizeClass("islet"),
  });

  steps.push({
    actId:"act1", actLabel:"I · The water's taxonomy",
    title:"Skerries",
    body:`<p>A skerry is a small, rocky islet — above water at low tide, dangerous to ships. The words: <em>skär</em> (${CNT.skar.toLocaleString()})${C==="fi" ? ` and <em>luoto</em> (${FI.luoto.toLocaleString()})` : ""}.</p>
${C==="fi" ? "<p><em>Luoto</em> is the Finnish equivalent of <em>skär</em>. You can read the language boundary in their distributions.</p>" : ""}`,
    colorFn: cfSizeClass("skerry"),
  });

  steps.push({
    actId:"act1", actLabel:"I · The water's taxonomy",
    title:"Rocks",
    body:`<p>Rocks barely break the surface — hazards more than land. The rock words: <em>kari</em> (${CNT.kari.toLocaleString()}), <em>bådan</em> (${(CNT.badan||0).toLocaleString()})${C==="fi" ? `, <em>kallio</em> (${FI.kallio.toLocaleString()})` : ""}.</p>
<p>${C==="fi" ? `Finland has ${FI.kari.toLocaleString()} <em>kari</em> — almost 55× more than Sweden's ${SE.kari}. The western archipelago is dense with them.` : `Sweden has ${SE.kari} <em>kari</em> — a borrowed Finnish word clinging to border waters.`}</p>`,
    colorFn: cfSizeClass("rock"),
  });

  steps.push({
    actId:"act1", actLabel:"I · The water's taxonomy",
    title:"Shoals",
    body:`<p>Shoals are submerged or barely emergent — you can't stand on them, only ground on them. The key word: <em>grund</em> (${CNT.grund.toLocaleString()}).</p>
<p>The Nordic word list names the full depth-gradient of the sea. Now for the twist.</p>`,
    colorFn: cfSizeClass("shoal"),
  });

  steps.push({
    actId:"act1", actLabel:"I · The water's taxonomy",
    title:"The truth twist — do names keep their promise?",
    body:`<p>Each morpheme <em>claims</em> a size. A name saying "island" should sit on a real island. We checked: does the feature's OSM size class match the size the name promises?</p>
<p>Recoloured now by <strong>truthfulness</strong>:</p>
<div class="legend-grid">
  <span class="dot" style="background:#ffd166"></span><span>truthful ≥ 85%</span>
  <span class="dot" style="background:#f4a261"></span><span>mixed 65–85%</span>
  <span class="dot" style="background:#9aa3b2"></span><span>murky 45–65%</span>
  <span class="dot" style="background:#4895ef"></span><span>fossil &lt; 45%</span>
</div>
<p>Warm gold = keeps its promise. Cold blue = fossil.</p>`,
    colorFn: cfTruth(),
  });

  // Fossil step — key morpheme per country
  const fossilId   = C === "fi" ? "saari" : "o";
  const fossilEl   = C === "fi" ? "<em>saari</em>" : "<em>ö</em>";
  const fossilPct  = pct(fossilId);
  const fossilCnt  = C === "fi" ? FI.saari.toLocaleString() : SE.o.toLocaleString();
  const fossilBody = C === "fi"
    ? `<p>${fossilEl} means "island" — but only <strong>${fossilPct}</strong> of Finland's ${fossilCnt} <em>saari</em> features are actually island-sized. The other 85% are too small: islets, rocks, skerries.</p>
<p>The word spread so widely it detached from its original size. <em>Saari</em> is one of the most dramatically fossilised toponymic suffixes in the Nordic world.</p>`
    : `<p>${fossilEl} means "island" — but only <strong>${fossilPct}</strong> of Sweden's ${fossilCnt} <em>ö</em> features match that size. <em>Ön</em> is even more fossil at ${pct("on")}. <em>Landet</em> ("the land") keeps its claim only ${pct("landet")} of the time.</p>
<p>The large-scale words have all drifted — applied to smaller things over centuries of casual naming.</p>`;

  steps.push({
    actId:"act1", actLabel:"I · The water's taxonomy",
    title:`The fossil: ${C==="fi" ? "saari" : "ö/ön"}`,
    body: fossilBody,
    colorFn: cfTruthMorpheme(fossilId),
  });

  steps.push({
    actId:"act1", actLabel:"I · The water's taxonomy",
    title:"The promise-keepers: holm / holmen",
    body:`<p>Not all names drift. <em>Holmen</em> is truthful <strong>${pct("holmen")}</strong> of the time in ${country}; <em>holm</em> <strong>${pct("holm")}</strong>.</p>
<p>These small-scale words stayed honest — perhaps because namers never needed to stretch them upward. An islet is an islet; there was no ambition in the label.</p>
<p class="aside">The lesson: the bigger the thing a name claims to be, the more likely it has been applied to smaller things over time.</p>`,
    colorFn: cfTruthMorpheme("holmen"),
  });

  // ── ACT II ─────────────────────────────────────────────────────────────────
  steps.push({
    actId:"act2", actLabel:"II · The language frontier",
    title:"Act II — The language frontier",
    body:`<p>The Nordic island vocabulary is not one language — it is two: <strong>Swedish</strong> (Norse-rooted) and <strong>Finnic</strong> (Finnish-rooted).</p>
<p>Each morpheme belongs to one stock. Colour them and you can read the boundary between these naming traditions directly in the dots.</p>
<div class="legend-grid">
  <span class="dot" style="background:${STOCK_COLOR.swedish}"></span><span>Swedish stock</span>
  <span class="dot" style="background:${STOCK_COLOR.finnic}"></span><span>Finnic stock</span>
</div>`,
    colorFn: cfStock(null),
  });

  steps.push({
    actId:"act2", actLabel:"II · The language frontier",
    title:"Swedish names",
    body: C==="fi"
      ? `<p>In Finland, Swedish island-names (<em>holmen, skär, holm, ö, ön, landet, grund, bådan</em>) concentrate along the western and southern coast — the historic Swedish-speaking littoral.</p>
<p><strong>${SwedishStockFI.toLocaleString()}</strong> Swedish-stock features in all — a living archive of coastal settlement.</p>`
      : `<p>In Sweden, almost all island-names are Swedish-stock: <strong>${SwedishStockSE.toLocaleString()}</strong> features. The Finnic words appear only sparsely, near border communities.</p>`,
    colorFn: cfStock("swedish"),
  });

  steps.push({
    actId:"act2", actLabel:"II · The language frontier",
    title:"Finnish names",
    body: C==="fi"
      ? `<p>The Finnic words (<em>saari, luoto, kari, letto, kallio</em>) blanket the interior lake district and eastern archipelago — <strong>${FinnicStockFI.toLocaleString()}</strong> features in all.</p>
<p>Where orange dots give way to blue, you cross the boundary that shaped Finnish settlement history.</p>`
      : `<p>Swedish Finnic-stock names are sparse — <strong>${FinnicStockSE.toLocaleString()}</strong> features — a linguistic memory of Finnish-speaking communities near the border.</p>
<p>Switch to Finland to see the full extent of the Finnic naming tradition.</p>`,
    colorFn: cfStock("finnic"),
  });

  // ── ACT III (option a — scarcity-honest) ───────────────────────────────────
  const hamnCnt = C === "fi" ? FI.hamn : SE.hamn;
  const munkCnt = C === "se" ? SE.munk || 0 : 0;

  steps.push({
    actId:"act3", actLabel:"III · What the namers did",
    title:"Act III — What the namers did",
    body:`<p>Did the namers ever encode <em>human use</em> in island names — harbours, monasteries, grazing grounds?</p>
<p>Mostly, no. Our curation guard tested dozens of candidates: bird-names (<em>fågel</em>), sheep-names (<em>får</em>), church-names (<em>kyrkö</em>). None matched enough real island features to count. The data pruned them.</p>
<p>What survived: <em>hamn</em> (harbour)${munkCnt > 0 ? " and <em>munkö</em> (monk-isle)" : ""}.</p>`,
    colorFn: cfHumanUse(),
  });

  steps.push({
    actId:"act3", actLabel:"III · What the namers did",
    title:"Harbour islands — hamn",
    body:`<p><em>Hamn</em> means harbour. In ${country} just <strong>${hamnCnt}</strong> island${hamnCnt !== 1 ? "s" : ""} carry the word — a handful of dots scattered along the coast.
${munkCnt > 0 ? ` And a single <em>munkö</em> — one monastery island, once outside time.` : ""}</p>
<p>The scarcity is the finding. The namers overwhelmingly described the water itself (size, depth, danger) — not what people did there. Harbours were built on islands; the islands kept their water-names anyway.</p>
<p class="aside">Only <strong>${hamnCnt + munkCnt}</strong> feature${(hamnCnt + munkCnt) !== 1 ? "s" : ""} in ${country} encode human use. The sea's vocabulary belongs to the sea.</p>`,
    colorFn: cfHumanUse(),
  });

  // ── ACT IV ─────────────────────────────────────────────────────────────────
  steps.push({
    actId:"act4", actLabel:"IV · The naming strata",
    title:"Act IV — The naming strata",
    body:`<p>Island names weren't coined in one moment — they accumulated across centuries. Three naming strata survive in the morphemes:</p>
<div class="legend-grid">
  <span class="dot" style="background:${STRATUM_COLOR.norse}"></span><span>Norse (Viking-age)</span>
  <span class="dot" style="background:${STRATUM_COLOR.swedish}"></span><span>Swedish (medieval–modern)</span>
  <span class="dot" style="background:${STRATUM_COLOR.finnish}"></span><span>Finnish (parallel tradition)</span>
</div>`,
    colorFn: cfStratum(null),
  });

  steps.push({
    actId:"act4", actLabel:"IV · The naming strata",
    title:"The Norse layer",
    body:`<p><em>Holm</em> and <em>holmen</em> are the oldest surviving layer — Old Norse words planted by Viking-era settlers along every navigable coast.</p>
<p>In ${country}: <em>holmen</em> (${CNT.holmen.toLocaleString()}) + <em>holm</em> (${(CNT.holm||0).toLocaleString()}) = <strong>${((CNT.holmen||0)+(CNT.holm||0)).toLocaleString()}</strong> Norse-layer names.</p>
<p>These are also the most truthful: ${pct("holmen")} for <em>holmen</em>, ${pct("holm")} for <em>holm</em>. Old names for islets stayed islets.</p>`,
    colorFn: cfStratum("norse"),
  });

  steps.push({
    actId:"act4", actLabel:"IV · The naming strata",
    title:"The Swedish layer",
    body:`<p>The Swedish stratum — <em>skär, grund, bådan, ö, ön, landet</em> — expanded with medieval and early-modern settlement and systematic chart-making.</p>
<p>These words cover the full size spectrum, including the large "island" words that later fossilised. Swedish-stratum names dominate the outer archipelago where chart-makers worked methodically.</p>`,
    colorFn: cfStratum("swedish"),
  });

  steps.push({
    actId:"act4", actLabel:"IV · The naming strata",
    title:"The Finnish layer",
    body:`<p>The Finnish stratum — <em>saari, luoto, kari, letto, kallio</em> — is a parallel naming tradition, entirely independent of the Norse/Swedish track.</p>
<p>${C==="fi"
  ? `In Finland these names dominate the interior and eastern coasts. <em>Saari</em> alone (${FI.saari.toLocaleString()}) outnumbers all Swedish-stock island names combined.`
  : `In Sweden this layer is thin — ${FinnicStockSE.toLocaleString()} features — a linguistic memory of Finnish-speaking communities.`}</p>
<p>Three strata; one archipelago. The names are a geological record of who named what, and when.</p>`,
    colorFn: cfStratum("finnish"),
  });

  // ── ACT V ──────────────────────────────────────────────────────────────────
  const uncuratedCnt = DATA.points.filter(p => !p[2]).length;
  const endings = DATA.endings || [];
  const unreadable = DATA.unreadable_count ?? 0;
  const promoted = DATA.morphemes.filter(m => PROMOTED_IDS.has(m.id));

  steps.push({
    actId:"act5", actLabel:"V · What we can't read",
    title:"Act V — What we can't read",
    body:`<p>Our word list recognised ${curated} of the ${total} features. The rest — <strong>${uncuratedCnt.toLocaleString()}</strong> names — lit up here in coral, were invisible until now. Every one is tappable; each carries a real name we simply could not parse.</p>
<p>The point of this project is what names mean. So the half we couldn't read is not a footnote — it is the frontier.</p>`,
    colorFn: cfUncurated(),
  });

  steps.push({
    actId:"act5", actLabel:"V · What we can't read",
    title:"The hidden vocabulary",
    body:`<p>The unknowns were not random. Mining the endings surfaced recurring toponymic words we had never curated — and we have now added <strong>${promoted.length}</strong> of them to the dictionary:</p>
<div class="legend-grid">
${promoted.map(m => `  <span class="dot" style="background:${SIZE_COLOR[m.size_class] || GREY_UNC}"></span><span><em>${m.element}</em> — ${m.gloss} (${m.count.toLocaleString()})</span>`).join("\n")}
</div>
<p>These weren't water-words at all. <em>näs</em>, <em>udden</em>, <em>niemi</em> name the <strong>land</strong> — a headland, a point, a cape — not the size of the island. The frontier is where names stop describing the sea and start describing the shore.</p>`,
    colorFn: cfPromoted(),
  });

  steps.push({
    actId:"act5", actLabel:"V · What we can't read",
    title:"The honest tail",
    body:`<p>What's left we still won't guess at — the house rule. After growing the dictionary, <strong>${unreadable.toLocaleString()}</strong> names remain unparsed. The most common remaining endings:</p>
<table class="endings-table"><thead><tr><th>ending</th><th>count</th><th>example</th></tr></thead><tbody>
${endings.map(e => `<tr><td>-${e.ending}</td><td>${e.count.toLocaleString()}</td><td>${(e.examples[0]||"")}</td></tr>`).join("\n")}
</tbody></table>
<p class="aside">These are the next words to attest — personal names, farm names, languages and tails our net still misses. The map is bigger than our dictionary, and now we can see exactly where.</p>`,
    colorFn: cfUncurated(),
  });

  return steps;
}

/* ---- stepper render ------------------------------------------------------- */
function renderStep() {
  if (STATE.inspected) return;
  const steps = STATE.steps;
  const s = steps[STATE.step];
  if (!s) return;

  drawGlowCanvas(s.colorFn);

  document.getElementById("step-body").innerHTML =
    `<h2 class="step-title">${s.title}</h2>${s.body}`;

  const countEl = document.getElementById("count");
  const stepNum = STATE.step + 1;
  countEl.textContent = `${stepNum} / ${steps.length}`;
  countEl.setAttribute("aria-label", `Step ${stepNum} of ${steps.length}`);

  document.getElementById("prev").disabled = STATE.step === 0;
  document.getElementById("next").disabled = STATE.step === steps.length - 1;

  document.querySelectorAll("#acts .act-chip").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.act === s.actId);
  });

  syncHash();
}

/* ---- act chips ------------------------------------------------------------ */
function buildActChips() {
  const actsEl = document.getElementById("acts");
  actsEl.innerHTML = "";
  const seen = new Set();
  STATE.steps.forEach((s, i) => {
    if (seen.has(s.actId)) return;
    seen.add(s.actId);
    const btn = document.createElement("button");
    btn.className = "act-chip";
    btn.dataset.act  = s.actId;
    btn.dataset.step = i;
    btn.textContent  = s.actLabel;
    btn.addEventListener("click", () => {
      STATE.step = parseInt(btn.dataset.step, 10);
      STATE.inspected = null;
      renderStep();
    });
    actsEl.appendChild(btn);
  });
}

/* ---- country toggle ------------------------------------------------------- */
function buildCountryToggle() {
  if (document.getElementById("country-toggle")) return;
  const toggle = document.createElement("div");
  toggle.id = "country-toggle";
  toggle.setAttribute("role", "group");
  toggle.setAttribute("aria-label", "Country");
  toggle.innerHTML = `
    <button class="ctry-btn is-active" data-country="se">Sweden</button>
    <button class="ctry-btn" data-country="fi">Finland</button>`;
  document.querySelector(".hdr").appendChild(toggle);
  toggle.querySelectorAll(".ctry-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = btn.dataset.country;
      if (c === COUNTRY) return;
      COUNTRY = c;
      toggle.querySelectorAll(".ctry-btn").forEach((b) =>
        b.classList.toggle("is-active", b.dataset.country === c));
      STATE.inspected = null;
      STATE.step = 0;
      loadAndDraw();
    });
  });
}

/* ---- hash ----------------------------------------------------------------- */
function parseHash() {
  const h = location.hash.replace(/^#/, "");
  if (!h.startsWith("islands/")) return null;
  const parts = h.split("/");
  const country  = parts[1];
  const stepIdx  = parseInt(parts[3], 10);
  if (!country || isNaN(stepIdx)) return null;
  return { country, actId: parts[2], stepIdx };
}

function syncHash() {
  if (BOOTING) return;
  const s = STATE.steps[STATE.step];
  if (!s) return;
  history.replaceState(null, "", `#islands/${COUNTRY}/${s.actId}/${STATE.step}`);
}

/* ---- boot ----------------------------------------------------------------- */
async function loadAndDraw() {
  const myGen = ++_loadGen;

  const file = COUNTRY === "fi" ? "fi-islands.json" : "se-islands.json";
  document.getElementById("step-body").innerHTML =
    `<p class="loading">Loading ${COUNTRY.toUpperCase()} data…</p>`;

  let json;
  try {
    json = await d3.json(file);
  } catch (err) {
    if (myGen !== _loadGen) return;
    document.getElementById("step-body").innerHTML =
      `<p class="error">Failed to load ${file}. Please refresh and try again.<br><small>${err.message || err}</small></p>`;
    return;
  }

  // A newer load superseded this one — discard stale result.
  if (myGen !== _loadGen) return;

  DATA = json;
  MORPH_BY_ID = Object.fromEntries(DATA.morphemes.map(m => [m.id, m]));
  TRUTH = DATA.truthfulness || {};

  const [w, h] = sizeCanvas();
  PROJ   = buildProjection(DATA.points, w, h);
  COORDS = buildCoordCache(DATA.points, PROJ);
  QUAD   = buildQuadtreeFromCache(DATA.points, COORDS);

  STATE.steps = buildSteps();
  buildActChips();
  renderStep();
}

async function boot() {
  buildCountryToggle();

  const restore = parseHash();
  if (restore && (restore.country === "fi" || restore.country === "se")) {
    COUNTRY = restore.country;
    document.querySelectorAll(".ctry-btn").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.country === COUNTRY));
  }

  await loadAndDraw();

  if (restore && STATE.steps.length && restore.stepIdx >= 0) {
    STATE.step = Math.min(restore.stepIdx, STATE.steps.length - 1);
    renderStep();
  }

  BOOTING = false;
  syncHash();
}

/* ---- events --------------------------------------------------------------- */
document.getElementById("prev").addEventListener("click", () => {
  if (STATE.step > 0) { STATE.step--; STATE.inspected = null; renderStep(); }
});
document.getElementById("next").addEventListener("click", () => {
  if (STATE.step < STATE.steps.length - 1) { STATE.step++; STATE.inspected = null; renderStep(); }
});

window.addEventListener("keydown", (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.key === "ArrowRight") document.getElementById("next").click();
  else if (e.key === "ArrowLeft") document.getElementById("prev").click();
});

// Swipe paging (mirror app.js)
let swipeX = null, swipeY = null;
const storyEl = document.querySelector("main.story");
storyEl.addEventListener("touchstart", (e) => {
  if (e.touches.length > 1) { swipeX = null; return; }
  if (e.target.closest(".act-chip, #country-toggle, button")) { swipeX = null; return; }
  swipeX = e.touches[0].clientX;
  swipeY = e.touches[0].clientY;
}, { passive: true });
storyEl.addEventListener("touchend", (e) => {
  if (swipeX === null) return;
  const dx = e.changedTouches[0].clientX - swipeX;
  const dy = e.changedTouches[0].clientY - swipeY;
  swipeX = null;
  if (Math.abs(dx) > 48 && Math.abs(dx) > 2 * Math.abs(dy))
    document.getElementById(dx < 0 ? "next" : "prev").click();
}, { passive: true });
storyEl.addEventListener("touchcancel", () => { swipeX = null; }, { passive: true });

// Resize: debounced, rebuilds coord cache + quadtree
window.addEventListener("resize", () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (!DATA) return;
    const [w, h] = sizeCanvas();
    PROJ   = buildProjection(DATA.points, w, h);
    COORDS = buildCoordCache(DATA.points, PROJ);
    QUAD   = buildQuadtreeFromCache(DATA.points, COORDS);
    renderStep();
  }, 150);
});

boot();
