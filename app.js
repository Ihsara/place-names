/* Fossils in the Map — FI/SE/VN place-name morpheme story.
   Vanilla D3 v7. One SVG, swapped per world/tab/lens. Glow-bloom point layer
   driven by a click-stepper across three lenses: roots (common name-elements),
   bridge (SE↔FI concept pairs), and unique-by-province (on-demand province affordance + glow). */
const SVG = d3.select("#map");
const CAPTION = d3.select("#map-caption");

/* ---- v2 two-axis nav config: WORLD (Nordic|Vietnam) x LENS (roots|unique) -- */
const WORLDS = {
  nordic: {
    label: "Nordic",
    tabs: [
      { country: "finland", label: "Finland" },
      { country: "sweden",  label: "Sweden"  },
      { country: "bridge",  label: "SE↔FI bridge" },
    ],
    lenses: { roots: "Common roots", unique: "Where names turn local" },
  },
  vietnam: {
    label: "Vietnam",
    tabs: [{ country: "vietnam", label: "Vietnam" }],
    lenses: { roots: "Common roots", unique: "Where names turn local" },
  },
};
const FILES = {
  finland: "fi.json", sweden: "se.json", vietnam: "vn.json", bridge: "bridge.json",
  "finland-unique": "fi-unique.json", "sweden-unique": "se-unique.json", "vietnam-unique": "vn-unique.json",
};

const STATE = {
  world: "nordic",
  country: "finland",
  lens: "roots",
  data: null,            // loaded payload
  active: new Set(),     // morpheme ids currently lit (story or explorer)
  colorById: new Map(),
  titleById: new Map(),  // glow-point id -> native <title> hover text (per lens)
  rootsProvinces: null,  // provinces borrowed from {country}-unique.json for the roots clickable layer
  step: 0,
  steps: [],
};

/* ---- color: separable per-element identity --------------------------------
   The baked palette is a good family but it runs cyan→teal→green→amber→pink in
   morpheme-list order, so the FIRST several stepper steps look near-identical.
   Re-space it: an interleaved cool/warm ramp assigned in list order makes every
   consecutive step contrast with its neighbour. Color's job here is IDENTITY
   (one fixed hue per element); dot size is uniform (see R_GLOW). */
const PALETTE = [
  "#4cc9f0", // bright cyan
  "#f4a261", // warm sand
  "#80ffdb", // mint
  "#ef476f", // rose
  "#a8e063", // lime
  "#c77dff", // violet
  "#ffd166", // amber
  "#48bfe3", // sky
  "#f15bb5", // magenta
  "#72efdd", // aqua
  "#e76f51", // terracotta
  "#3a86ff", // blue
  "#d4d452", // chartreuse
  "#d81159", // crimson
  "#56cfe1", // teal
  "#8338ec", // indigo
];
const UNKNOWN_HUE = "#c6c6c6";   // grey tail for any unmatched/unknown element

// Reassign each morpheme a well-separated hue by its position in the list, so
// adjacent stepper steps never share a near-identical color. Mutates in place.
function respaceColors(morphemes) {
  morphemes.forEach((m, i) => { m.color = PALETTE[i % PALETTE.length] || UNKNOWN_HUE; });
  return morphemes;
}

/* ---- language-family palette + element->family curation (substrate lens) ---
   Confined name-elements are colored by the LANGUAGE FAMILY their name comes
   from, not one flat amber. Palette is fixed + separable on the dark/viridis
   ground; curation tables map element ids to a family; unknowns fall to grey. */
const FAMILY = {
  // key:        { label,                         color }
  highlands:     { label: "Highlands (Mon-Khmer / Austronesian)", color: "#ffc933" }, // hotter gold
  northern:      { label: "Northern uplands (Tai-Kadai)",         color: "#00f5b8" }, // vivid mint
  mekong:        { label: "Mekong / Khmer delta",                 color: "#ff3d71" }, // hot rose
  sapmi:         { label: "Sámi / Finnish substrate",             color: "#22d3ff" }, // electric cyan
  swedish:       { label: "Swedish substrate in Finland",         color: "#ff9e4a" }, // warm amber-orange
  other:         { label: "Other confined",                       color: "#9aa3b2" }, // cooler dim grey tail
};

// Vietnam. Tone-folding handled by listing the real variants seen in the data.
const VN_FAMILY = {
  // Central-Highlands water / village / nature (Mon-Khmer: M'Nông, Ê Đê, Bahnar; Austronesian: Jarai)
  "đăk":"highlands","đắk":"highlands","đak":"highlands","đạ":"highlands","đà":"highlands",
  "ea":"highlands","ia":"highlands","krông":"highlands","kroa":"highlands","krăng":"highlands",
  "kon":"highlands","kô":"highlands","ko":"highlands","ngọk":"highlands","plei":"highlands",
  "bu":"highlands","bù":"highlands","bon":"highlands","cư":"highlands","cuôr":"highlands",
  "yang":"highlands","yông":"highlands","yuk":"highlands","knia":"highlands","drai":"highlands",
  "đrao":"highlands","klong":"highlands","klat":"highlands","mrông":"highlands","kmrơng":"highlands",
  "điek":"highlands","đung":"highlands","dơng":"highlands","dhăm":"highlands","dhung":"highlands",
  "păng":"highlands","pang":"highlands","pêng":"highlands","tơng":"highlands","tring":"highlands",
  "briêng":"highlands","r'chai":"highlands","pró":"highlands","taly":"highlands","alê":"highlands",
  "niêng":"highlands","tul":"highlands","tuôr":"highlands","sah":"highlands","gram":"highlands",
  "kty":"highlands","kà":"highlands","kạch":"highlands","jung":"highlands","mê":"highlands",
  "ya":"highlands","má":"highlands","mã":"highlands","mô":"highlands","mùi":"highlands",
  // Northern uplands (Tai-Kadai: Thái, Tày, Nùng)
  "nậm":"northern","nặm":"northern","khau":"northern","phìn":"northern","lùng":"northern",
  "mù":"northern","sà":"northern","sảng":"northern","sủng":"northern","mương":"northern",
  // Mekong / Khmer delta water & settlement
  "xẻo":"mekong","xèo":"mekong","kinh":"mekong","hòn":"mekong","sóc":"mekong","vàm":"mekong","tràm":"mekong",
  // everything else (khu, tổ, tdp, tu, giao, mễ, numbers, Vietnamese commons) → other (grey, unlit-feel)
};

// Nordic. fi-unique / se-unique element ids are last-4-char proxies, so match on suffix membership.
const NORDIC_FAMILY = {
  // Finnish/Sámi lake & fell words showing through in Swedish Norrland
  "ärvi":"sapmi","arvi":"sapmi","aara":"sapmi","jaur":"sapmi","rova":"sapmi","rvi":"sapmi","aur":"sapmi",
  // Swedish coastal/village words showing through in Finland (Österbotten/Åland/Uusimaa)
  "skog":"swedish","bäck":"swedish","cken":"swedish","lmen":"swedish","unda":"swedish",
  "land":"swedish","ngen":"swedish","ppoo":"swedish",
};

// element id -> family key. country picks the table; Nordic matches by suffix
// because fi/se element ids are last-4-char proxies. Unknown -> "other".
function familyOf(elementId, country) {
  if (!elementId) return "other";
  if (country === "vietnam") return VN_FAMILY[elementId] || "other";
  // nordic (finland/sweden/bridge): direct hit or suffix membership
  if (NORDIC_FAMILY[elementId]) return NORDIC_FAMILY[elementId];
  for (const k in NORDIC_FAMILY) { if (elementId.endsWith(k)) return NORDIC_FAMILY[k]; }
  return "other";
}
function familyColor(elementId, country) { return (FAMILY[familyOf(elementId, country)] ?? FAMILY.other).color; }

function projectionFor(country, points, w, h) {
  // Fit a Mercator to the data extent with padding — no basemap tiles needed.
  const fc = {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p[0], p[1]] },
    })),
  };
  // Tight inset so a tall/narrow country fills its column instead of floating
  // in fat margins (the dead-space the redesign targets).
  return d3.geoMercator().fitExtent([[12, 16], [w - 12, h - 16]], fc);
}

function ensureDefs() {
  let defs = SVG.select("defs");
  if (!defs.empty()) return defs;
  defs = SVG.append("defs");
  return defs;
}

// Per-datum lit-sphere radial gradient (the Bremer glow: a bright gradient-CORE
// on a dark ground, NOT a blur filter). fx offset = highlight; dark rim sits the
// dot on the ground so no stroke is needed.
function ensureGradient(defs, id, color) {
  const gid = "g-" + id;
  if (!defs.select("#" + gid).empty()) return gid;
  const rg = defs.append("radialGradient").attr("id", gid)
    .attr("cx", "50%").attr("cy", "50%").attr("r", "50%").attr("fx", "35%").attr("fy", "35%");
  rg.append("stop").attr("offset", "0%").attr("stop-color", d3.rgb(color).brighter(1.4));
  rg.append("stop").attr("offset", "45%").attr("stop-color", color);
  rg.append("stop").attr("offset", "100%").attr("stop-color", d3.rgb(color).darker(1.75));
  return gid;
}

// Uniform lit-dot radius for the roots + bridge glow (NYC-dotmap look: color
// carries identity, size is constant). Mirrors the unique lens's 2.6 base.
const R_GLOW = 2.6;

// base layer: faint "other"/unlit dots (no glow) for honest density.
// Reusable by later tasks (e.g. Task 14 bridge view).
function drawBaseLayer(points, proj) {
  let base = SVG.selectAll("g.base").data([0]);
  base = base.enter().append("g").attr("class", "base").merge(base);
  base.selectAll("circle").data(points).join("circle")
    .attr("cx", (p) => proj([p[0], p[1]])[0])
    .attr("cy", (p) => proj([p[0], p[1]])[1])
    .attr("r", 1.1)
    .attr("fill", "#27406e")
    .attr("fill-opacity", 0.5);
}

// glow layer: only the LIT morphemes, drawn as lit-sphere gradient cores (no
// blur filter). Lights points whose morphemeId (p[2]) is in STATE.active, colored
// via STATE.colorById. Reusable by later tasks (Task 14 bridge view).
function drawGlowLayer(points, proj) {
  const defs = ensureDefs();
  let glow = SVG.selectAll("g.glow").data([0]);
  glow = glow.enter().append("g").attr("class", "glow")
    .style("isolation", "isolate")
    .merge(glow);

  const lit = points.filter((p) => p[2] && STATE.active.has(p[2]));
  lit.forEach((p) => ensureGradient(defs, p[2], STATE.colorById.get(p[2])));

  // Interrupt any in-flight transitions first: a circle scheduled to fade-and-
  // .remove() from a previous step can be re-matched (by lon:lat key) into this
  // step's update set; without interrupting, its pending .remove() still fires and
  // wrongly deletes a now-kept dot. (Bites the "all" step that re-lights points
  // exiting from the prior single-step.) Cheap and idempotent.
  glow.selectAll("circle").interrupt();

  // Native SVG <title> = a real, zero-JS hover tooltip. Text comes from
  // STATE.titleById (each lens's loader fills it: roots = "element — gloss",
  // bridge = "sv ↔ fi · gloss"). Honest: only points with a known title get one.
  const titleFor = (p) => STATE.titleById?.get(p[2]) ?? "";
  glow.selectAll("circle").data(lit, (p) => p[0] + ":" + p[1]).join(
    (enter) => {
      const c = enter.append("circle")
        .attr("cx", (p) => proj([p[0], p[1]])[0])
        .attr("cy", (p) => proj([p[0], p[1]])[1])
        .attr("r", 0)
        .attr("fill", (p) => `url(#g-${p[2]})`);
      c.append("title").text(titleFor);
      c.call((e) => e.transition().duration(450).attr("r", R_GLOW + 1.5));
      return c;
    },
    (update) => {
      update
        .attr("fill", (p) => `url(#g-${p[2]})`)
        .attr("cx", (p) => proj([p[0], p[1]])[0])
        .attr("cy", (p) => proj([p[0], p[1]])[1])
        .attr("r", R_GLOW + 1.5);
      // keep the <title> in sync (a kept circle may now carry a different id)
      update.selectAll("title").data((p) => [p]).join("title").text(titleFor);
      return update;
    },
    (exit) => exit.call((e) => e.transition().duration(250).attr("r", 0).remove())
  );
}

function draw() {
  const node = SVG.node();
  const w = node.clientWidth || 800;
  const h = node.clientHeight || 600;
  SVG.attr("viewBox", `0 0 ${w} ${h}`);
  const proj = projectionFor(STATE.country, STATE.data.points, w, h);
  drawBaseLayer(STATE.data.points, proj);
  if (STATE.rootsProvinces) {
    drawProvinceLayer(STATE.rootsProvinces, proj, {
      onClick: (d) => { STATE.selectedProvince = d; showProvincePanel(d); draw(); },
    });
  }
  drawGlowLayer(STATE.data.points, proj);
}

/* ---- v2 data load + step build + render ---------------------------------- */
async function loadCurrent() {
  // Switching world/tab/lens swaps the whole view: drop every data layer (g.base,
  // g.glow, g.provinces, g.glow-unique) so no ghost layer from the prior renderer
  // survives under/over the new one. Keep <defs> (gradients) intact.
  SVG.selectAll("g").remove();
  STATE.rootsProvinces = null;  // cleared on every (re)load; only the roots branch repopulates it
  // Bridge view — lens-aware: unique lens shows substrate view, roots shows concept-pairs.
  if (STATE.country === "bridge") {
    if (STATE.lens === "unique") return loadBridgeUnique();
    return loadBridge();
  }
  // Unique-by-province lens (Task 15) — graceful stub-guard until that task lands.
  if (STATE.lens === "unique") {
    if (typeof loadUnique === "function") return loadUnique();
    d3.select("#step-body").html('<div class="card"><p class="history">Unique-by-province view coming up.</p></div>');
    return;
  }
  const uniqueKey = STATE.country + "-unique";
  const [rootsData, uniqueData] = await Promise.all([
    d3.json(FILES[STATE.country]),
    FILES[uniqueKey] ? d3.json(FILES[uniqueKey]).catch(() => null) : Promise.resolve(null),
  ]);
  STATE.data = rootsData;
  STATE.rootsProvinces = uniqueData?.provinces ? dropForeignProvinces(uniqueData.provinces) : null;
  respaceColors(STATE.data.morphemes);   // separable per-element hues (D4)
  STATE.colorById = new Map(STATE.data.morphemes.map((m) => [m.id, m.color]));
  STATE.titleById = new Map(STATE.data.morphemes.map((m) => [m.id, `${m.element} — ${m.gloss}`]));
  buildRootSteps();
  STATE.step = 0;
  renderRootStep();
  draw();
}

/* ---- common-roots story: intro → one step per morpheme → all → explore ---- */
function buildRootSteps() {
  const m = STATE.data.morphemes.filter((x) => x.count > 0); // skip dead
  STATE.steps = [{ kind: "intro" }]
    .concat(m.map((mo) => ({ kind: "morpheme", mo })))
    .concat([{ kind: "all" }, { kind: "explore" }]);
}

function renderRootStep() {
  const s = STATE.steps[STATE.step];
  STATE.selectedProvince = null;  // stepping is authoritative — a prior province click is cleared
  const ids = STATE.data.morphemes.filter((m) => m.count > 0).map((m) => m.id);
  const body = d3.select("#step-body");
  if (s.kind === "intro") {
    STATE.active = new Set();
    CAPTION.text("");
    body.html(`<div class="card"><p class="element">Place names are fossils.</p>
      <p class="history">Step through each name-element to see where it clusters.</p></div>`);
  } else if (s.kind === "morpheme") {
    STATE.active = new Set([s.mo.id]);
    CAPTION.text(`${s.mo.element} — ${s.mo.meaning}`);
    body.html(`<div class="card" style="border-color:${s.mo.color}55">
      <p class="element" style="color:${s.mo.color}">${s.mo.element}</p>
      <p class="gloss">${s.mo.gloss} · ${s.mo.count.toLocaleString()} places</p>
      <p class="history">${s.mo.history}</p></div>`);
  } else if (s.kind === "all") {
    STATE.active = new Set(ids);
    CAPTION.text("");
    body.html(`<div class="card"><p class="element">All at once</p>
      <p class="history">The whole naming fabric together.</p></div>`);
  } else {
    STATE.active = new Set(ids);
    CAPTION.text("");
    body.html(`<div class="card"><p class="element">Explore</p>
      <p class="history">Hover a glowing dot to name its element.</p></div>`);
  }
  d3.select("#step-count").text(`${STATE.step + 1} / ${STATE.steps.length}`);
  d3.select("#prev").property("disabled", STATE.step === 0);
  d3.select("#next").property("disabled", STATE.step === STATE.steps.length - 1);
  draw();
}

// Single dispatcher — Tasks 14/15 add bridge/unique branches.
function renderStep() {
  if (STATE.country === "bridge" && STATE.lens === "unique") return renderBridgeUniqueStep();
  if (STATE.country === "bridge" && typeof renderBridgeStep === "function") return renderBridgeStep();
  if (STATE.lens === "unique" && typeof renderUniqueStep === "function") return renderUniqueStep();
  return renderRootStep();
}

/* ---- SE↔FI concept-bridge (Task 14): both lands, one projection ----------- */
// Sweden and Finland are adjacent — a SINGLE Mercator fit to BOTH countries'
// combined points places them side by side. A lit concept glows on BOTH lands in
// ONE shared color (points carry the PAIR id, not a per-country morpheme id).
async function loadBridge() {
  const b = await d3.json(FILES.bridge);
  STATE.data = b;
  STATE.colorById = new Map(b.pairs.map((p) => [p.id, p.color]));
  STATE.titleById = new Map(b.pairs.map((p) => [p.id, `${p.sv} ↔ ${p.fi} · ${p.gloss}`]));
  STATE.steps = [{ kind: "intro-bridge" }]
    .concat(b.pairs.map((p) => ({ kind: "pair", p })))
    .concat([{ kind: "all-bridge" }]);
  STATE.step = 0;
  renderBridgeStep();
}

function drawBridge(activePairs) {
  const node = SVG.node();
  const w = node.clientWidth || 800;
  const h = node.clientHeight || 600;
  SVG.attr("viewBox", `0 0 ${w} ${h}`);
  // ONE projection fit to the COMBINED FI+SE extent (projectionFor builds a
  // FeatureCollection of every point and fitExtent's to it — handles both lands).
  const all = STATE.data.fi_points.concat(STATE.data.se_points);
  const proj = projectionFor("bridge", all, w, h);
  STATE.active = activePairs;   // drawGlowLayer lights points whose p[2] ∈ active
  drawBaseLayer(all, proj);
  drawGlowLayer(all, proj);
}

function renderBridgeStep() {
  const s = STATE.steps[STATE.step];
  const allIds = STATE.data.pairs.map((p) => p.id);
  const body = d3.select("#step-body");
  let active;
  if (s.kind === "intro-bridge") {
    active = new Set();
    CAPTION.text("");
    body.html(`<div class="card"><p class="element">Two tongues, one landscape</p>
      <p class="history">Sweden and Finland share a sea and a terrain — but not a language. Step through a concept to see how each renders it.</p></div>`);
  } else if (s.kind === "pair") {
    active = new Set([s.p.id]);
    CAPTION.text(`${s.p.sv} ↔ ${s.p.fi} — ${s.p.gloss}`);
    body.html(`<div class="card" style="border-color:${s.p.color}55">
      <p class="element" style="color:${s.p.color}">${s.p.sv} ↔ ${s.p.fi}</p>
      <p class="gloss">${s.p.gloss}</p>
      <p class="history">Swedish <b>-${s.p.sv}</b> (${s.p.sv_count.toLocaleString()}) · Finnish <b>-${s.p.fi}</b> (${s.p.fi_count.toLocaleString()})</p></div>`);
  } else {
    active = new Set(allIds);
    CAPTION.text("");
    body.html(`<div class="card"><p class="element">Every equivalent</p>
      <p class="history">All concept-pairs lit across both lands.</p></div>`);
  }
  d3.select("#step-count").text(`${STATE.step + 1} / ${STATE.steps.length}`);
  d3.select("#prev").property("disabled", STATE.step === 0);
  d3.select("#next").property("disabled", STATE.step === STATE.steps.length - 1);
  drawBridge(active);
}

/* ---- SE↔FI bridge substrate lens (Task 4): both lands, family-colored ------- */
async function loadBridgeUnique() {
  const [fi, se] = await Promise.all([d3.json(FILES["finland-unique"]), d3.json(FILES["sweden-unique"])]);
  STATE.data = { fi, se };
  // keep the bridge substrate view consistent with loadUnique's foreign-province guard
  if (STATE.data.fi.provinces) STATE.data.fi.provinces = dropForeignProvinces(STATE.data.fi.provinces);
  if (STATE.data.se.provinces) STATE.data.se.provinces = dropForeignProvinces(STATE.data.se.provinces);
  STATE.steps = [{ kind: "intro-bru" }, { kind: "show-bru" }];
  STATE.step = 0;
  renderBridgeUniqueStep();
}
function drawBridgeUnique() {
  const node = SVG.node(), w = node.clientWidth || 800, h = node.clientHeight || 600;
  SVG.attr("viewBox", `0 0 ${w} ${h}`);
  // union extent of both lands' confined points
  const fiPts = (STATE.data.fi.points || []).filter((p) => p[2]).map((p) => [p[0], p[1], p[2], "finland"]);
  const sePts = (STATE.data.se.points || []).filter((p) => p[2]).map((p) => [p[0], p[1], p[2], "sweden"]);
  const all = fiPts.concat(sePts);
  const proj = projectionFor("bridge", all, w, h);
  // faint base of ALL settlements for honest density (both lands, unfiltered)
  const baseAll = (STATE.data.fi.points || []).concat(STATE.data.se.points || []);
  drawBaseLayer(baseAll, proj);
  // family-colored glow
  const defs = ensureDefs();
  Object.entries(FAMILY).forEach(([k, f]) => ensureGradient(defs, "fam-" + k, f.color));
  let glow = SVG.selectAll("g.glow-bru").data([0]);
  glow = glow.enter().append("g").attr("class", "glow-bru").style("isolation", "isolate").merge(glow);
  glow.selectAll("circle").data(all, (p) => p[0] + ":" + p[1]).join((enter) => {
    const c = enter.append("circle")
      .attr("cx", (p) => proj([p[0], p[1]])[0]).attr("cy", (p) => proj([p[0], p[1]])[1])
      .attr("r", 2.6).attr("fill", (p) => `url(#g-fam-${familyOf(p[2], p[3])})`);
    c.append("title").text((p) => p[2] || "");
    return c;
  }, (update) => {
    update.attr("cx", (p) => proj([p[0], p[1]])[0]).attr("cy", (p) => proj([p[0], p[1]])[1])
      .attr("fill", (p) => `url(#g-fam-${familyOf(p[2], p[3])})`);
    update.selectAll("title").data((p) => [p]).join("title").text((p) => p[2] || "");
    return update;
  });
}
function renderBridgeUniqueStep() {
  const s = STATE.steps[STATE.step];
  const body = d3.select("#step-body");
  CAPTION.html("");
  if (s.kind === "intro-bru") {
    body.html(`<div class="card"><p class="element">Substrate across the sea</p>
      <p class="history">Sweden and Finland trade more than concepts. In the far north, Finnish & Sámi water-words (-järvi, -jaur) surface inside Sweden; along Finland's coast, Swedish village-words surface inside Finland. Each dot is colored by the tongue its name comes from.</p>
      ${bruLegendHTML()}</div>`);
    SVG.selectAll("g").remove();
  } else {
    body.html(`<div class="card"><p class="element">Two substrates, one shore</p>
      <p class="history">Cyan = Finnish/Sámi names inside Sweden's north. Sand = Swedish names inside Finland. The colors cross the border the languages did.</p>
      ${bruLegendHTML()}</div>`);
    drawBridgeUnique();
  }
  d3.select("#step-count").text(`${STATE.step + 1} / ${STATE.steps.length}`);
  d3.select("#prev").property("disabled", STATE.step === 0);
  d3.select("#next").property("disabled", STATE.step === STATE.steps.length - 1);
}
// only the two Nordic substrate families + other, for the bridge legend
function bruLegendHTML() {
  const order = ["sapmi","swedish","other"];
  const chips = order.map((k) =>
    `<span class="fam-chip"><span class="fam-dot" style="background:${FAMILY[k].color}"></span>${FAMILY[k].label}</span>`).join("");
  return `<div class="fam-legend">${chips}</div>`;
}

/* ---- unique-by-province lens (on-demand affordance) ----------------------- */
// Provinces are transparent outlines by default; hover lightens them to a neutral
// grey-blue and a clicked/stepped province holds a brighter neutral highlight (no
// score-encoded hue — meaning lives in the family-colored glow dots). Score still
// drives step ordering + the drill panel. Stepping walks the most distinctive
// provinces; clicking any province drills its top elements into the panel.
// Drop bordering FOREIGN provinces the admin fetch caught across the border
// (Chinese Han-script names for VN; Cyrillic names for FI). Only ever removes a
// province that is BOTH score 0 AND foreign-script, so a real zero-score domestic
// province is never dropped. After this, projectionForGeo re-fits to the kept
// provinces and the target country fills the frame.
function dropForeignProvinces(provinces) {
  const foreign = /[Ѐ-ӿ一-鿿]/; // Cyrillic or CJK Han
  return provinces.filter((p) => !(p.score === 0 && foreign.test(p.name || p.id || "")));
}

async function loadUnique() {
  const u = await d3.json(FILES[STATE.country + "-unique"]);
  STATE.data = u;
  STATE.data.provinces = dropForeignProvinces(STATE.data.provinces);
  STATE.titleById = new Map();  // this lens hovers via province click, not glow <title>
  // confined glow points carry an element id in p[2] — give them a name-only title
  (u.points || []).forEach((p) => { if (p[2]) STATE.titleById.set(p[2], p[2]); });
  STATE.steps = [{ kind: "intro-unique" }]
    .concat(STATE.data.provinces.filter((p) => p.score > 0).slice(0, 8).map((p) => ({ kind: "province", p })))
    .concat([{ kind: "explore-unique" }]);
  STATE.step = 0;
  STATE.selectedProvince = null;
  renderUniqueStep();
}

function projectionForGeo(provinces, w, h) {
  return d3.geoMercator().fitExtent([[12, 16], [w - 12, h - 16]],
    { type: "FeatureCollection", features: provinces.map((p) => ({ type: "Feature", geometry: p.geometry })) });
}

// Shared province affordance: transparent outline by default, neutral grey-blue
// on hover, brighter neutral on select. NO score-encoded hue (meaning lives in the
// dots). Used by BOTH the unique lens (province-fitted proj) and the roots lens
// (points-fitted proj). onClick(d) fires on province click.
function drawProvinceLayer(provinces, proj, opts) {
  opts = opts || {};
  const path = d3.geoPath(proj);
  const selName = STATE.selectedProvince?.name ?? opts.focusName;
  let pg = SVG.selectAll("g.provinces").data([0]);
  pg = pg.enter().append("g").attr("class", "provinces").merge(pg);
  pg.selectAll("path").data(provinces, (d) => d.id).join("path")
    .attr("d", (d) => path({ type: "Feature", geometry: d.geometry }))
    .attr("fill", (d) => d.name === selName ? "#34466e" : "transparent")
    .attr("fill-opacity", (d) => d.name === selName ? 0.9 : 0)
    .attr("stroke", "#243355").attr("stroke-width", (d) => d.name === selName ? 1 : 0.5)
    .style("cursor", "pointer")
    .on("mouseenter", function (e, d) {
      if (d.name === selName) return;
      d3.select(this).attr("fill", "#2a3a5e").attr("fill-opacity", 0.6);
    })
    .on("mouseleave", function (e, d) {
      if (d.name === selName) return;
      d3.select(this).attr("fill", "transparent").attr("fill-opacity", 0);
    })
    .on("click", (e, d) => { if (opts.onClick) opts.onClick(d); });
}

function drawUnique(focusName) {
  const node = SVG.node(), w = node.clientWidth || 800, h = node.clientHeight || 600;
  SVG.attr("viewBox", `0 0 ${w} ${h}`);
  const proj = projectionForGeo(STATE.data.provinces, w, h);

  drawProvinceLayer(STATE.data.provinces, proj, {
    focusName: focusName,
    onClick: (d) => { STATE.selectedProvince = d; showProvincePanel(d); drawUnique(d.name); },
  });

  // confined points glow in family colours (highlands amber, northern teal, mekong
  // rose, sámi cyan, swedish sand, other grey) — lit-sphere gradient core
  // (consistent with the roots/bridge glow), NOT a blur filter.
  const defs = ensureDefs();
  Object.entries(FAMILY).forEach(([k, f]) => ensureGradient(defs, "fam-" + k, f.color));
  const ctry = STATE.country;                 // "vietnam" | "finland" | "sweden"
  const lit = STATE.data.points.filter((p) => p[2]);
  let glow = SVG.selectAll("g.glow-unique").data([0]);
  glow = glow.enter().append("g").attr("class", "glow-unique").style("isolation", "isolate").merge(glow);
  glow.selectAll("circle").data(lit, (p) => p[0] + ":" + p[1]).join((enter) => {
    const c = enter.append("circle")
      .attr("cx", (p) => proj([p[0], p[1]])[0])
      .attr("cy", (p) => proj([p[0], p[1]])[1])
      .attr("r", 2.6)
      .attr("fill", (p) => `url(#g-fam-${familyOf(p[2], ctry)})`);
    // native hover: the confined element this rare dot carries (p[2])
    c.append("title").text((p) => p[2] || "");
    return c;
  }, (update) => {
    update.attr("cx", (p) => proj([p[0], p[1]])[0]).attr("cy", (p) => proj([p[0], p[1]])[1])
      .attr("fill", (p) => `url(#g-fam-${familyOf(p[2], ctry)})`);
    update.selectAll("title").data((p) => [p]).join("title").text((p) => p[2] || "");
    return update;
  });
}

// which families actually appear in this country's confined set, as chips
function familyLegendHTML(country) {
  const present = new Set((STATE.data.points || []).filter((p) => p[2]).map((p) => familyOf(p[2], country)));
  const order = ["highlands","northern","mekong","sapmi","swedish","other"];
  const chips = order.filter((k) => present.has(k)).map((k) =>
    `<span class="fam-chip"><span class="fam-dot" style="background:${FAMILY[k].color}"></span>${FAMILY[k].label}</span>`).join("");
  return `<div class="fam-legend">${chips}</div>`;
}
function provinceDrillHTML(d) {
  const els = d.elements.slice(0, 6).map((e) =>
    `<li><b>${e.element}</b> · ${e.count}× · ${Math.round(e.pct * 100)}% here</li>`).join("");
  return `<ul class="drill">${els || "<li>none</li>"}</ul>`;
}

function showProvincePanel(d) {
  d3.select("#step-body").html(`<div class="card">
    <p class="element">${d.name}</p>
    <p class="gloss">${d.score} confined elements</p>
    ${provinceDrillHTML(d)}
    ${familyLegendHTML(STATE.country)}</div>`);
  CAPTION.html("");   // never duplicate into the bottom-left caption
}

function renderUniqueStep() {
  const s = STATE.steps[STATE.step];
  const body = d3.select("#step-body");
  let focus = null;
  if (s.kind === "intro-unique") {
    CAPTION.html("");
    body.html(`<div class="card"><p class="element">Where names turn local</p>
      <p class="history">Brighter provinces hold more name-elements found almost nowhere else — dialect, substrate, another tongue. Each glowing dot is colored by the language family its name comes from.</p>
      ${familyLegendHTML(STATE.country)}</div>`);
  } else if (s.kind === "province") {
    focus = s.p.name;
    showProvincePanel(s.p);
  } else {
    CAPTION.html("");
    body.html(`<div class="card"><p class="element">Explore</p>
      <p class="history">Click any province to see which elements make it distinctive.</p>
      ${familyLegendHTML(STATE.country)}</div>`);
  }
  d3.select("#step-count").text(`${STATE.step + 1} / ${STATE.steps.length}`);
  d3.select("#prev").property("disabled", STATE.step === 0);
  d3.select("#next").property("disabled", STATE.step === STATE.steps.length - 1);
  STATE.selectedProvince = null;  // stepping is authoritative — clear any prior click so focus wins
  drawUnique(focus);
}

/* ---- v2 two-axis nav: render tabs + lens toggle from WORLDS[STATE.world] --- */
function renderSubnav() {
  const w = WORLDS[STATE.world];
  const tabs = d3.select("#country-tabs");
  tabs.html(w.tabs.map((t) =>
    `<button class="tab ${t.country === STATE.country ? "is-active" : ""}" data-country="${t.country}">${t.label}</button>`).join(""));
  const showLens = true;
  const lt = d3.select("#lens-toggle").style("display", showLens ? "flex" : "none");
  if (showLens) {
    lt.html(Object.entries(w.lenses).map(([k, label]) =>
      `<button class="lens ${k === STATE.lens ? "is-active" : ""}" data-lens="${k}">${label}</button>`).join(""));
  }
  tabs.selectAll(".tab").on("click", function () {
    STATE.country = this.getAttribute("data-country");
    renderSubnav(); loadCurrent();
  });
  lt.selectAll(".lens").on("click", function () {
    STATE.lens = this.getAttribute("data-lens");
    renderSubnav(); loadCurrent();
  });
}

d3.selectAll(".world").on("click", function () {
  d3.selectAll(".world").classed("is-active", false);
  this.classList.add("is-active");
  STATE.world = this.getAttribute("data-world");
  STATE.country = WORLDS[STATE.world].tabs[0].country;
  STATE.lens = "roots";
  renderSubnav(); loadCurrent();
});

/* ---- click-stepper (replaces v1 scroll-jack) — renderStep is Task 13 ------- */
d3.select("#prev").on("click", () => {
  if (typeof renderStep === "function" && STATE.step > 0) { STATE.step--; renderStep(); }
});
d3.select("#next").on("click", () => {
  if (typeof renderStep === "function" && STATE.step < STATE.steps.length - 1) { STATE.step++; renderStep(); }
});

/* ---- boot ----------------------------------------------------------------- */
renderSubnav();
loadCurrent();
window.addEventListener("resize", () => {
  if (!STATE.data) return;
  if (STATE.country === "bridge" && STATE.lens === "unique") return renderBridgeUniqueStep();
  if (STATE.country === "bridge") return renderBridgeStep();
  if (STATE.lens === "unique") return renderUniqueStep();
  draw();
});
