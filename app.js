/* Fossils in the Map — FI/SE/VN place-name morpheme story.
   Vanilla D3 v7. One SVG, swapped per world/tab/lens. Glow-bloom point layer
   driven by a click-stepper across three lenses: roots (common name-elements),
   bridge (SE↔FI concept pairs), and unique-by-province (on-demand province affordance + glow). */
const SVG = d3.select("#map");
const CAPTION = d3.select("#map-caption");

/* ---- canvas glow renderer (ported from islands.js) ---------------------- */
const CV  = document.getElementById("glow-canvas");
const CTX = CV.getContext("2d");
let DPR = window.devicePixelRatio || 1;
let COORDS = null;   // Float32Array [x0,y0,x1,y1,...] in CSS px, projected once
let QUAD   = null;   // d3.quadtree over integer point indices

// Size the canvas to the SVG map box, DPR-scaled. Returns [cssW, cssH].
function sizeCanvas() {
  const node = SVG.node();
  const w = node.clientWidth || 800, h = node.clientHeight || 600;
  CV.width  = w * DPR;
  CV.height = h * DPR;
  CV.style.width  = w + "px";
  CV.style.height = h + "px";
  return [w, h];
}

function buildCoordCache(points, proj) {
  const arr = new Float32Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    const xy = proj([points[i][0], points[i][1]]);
    arr[i * 2]     = xy[0];
    arr[i * 2 + 1] = xy[1];
  }
  return arr;
}

// Like buildCoordCache but for items that aren't [lon,lat,...] tuples: getXY(item)
// returns the [lon,lat] to project. Used by the features lens (objects {lon,lat,…}).
function buildCoordCacheXY(items, getXY, proj) {
  const arr = new Float32Array(items.length * 2);
  for (let i = 0; i < items.length; i++) {
    const xy = proj(getXY(items[i]));
    arr[i * 2]     = xy[0];
    arr[i * 2 + 1] = xy[1];
  }
  return arr;
}

function buildQuadtreeFromCache(points, coords) {
  const qt = d3.quadtree().x(i => coords[i * 2]).y(i => coords[i * 2 + 1]);
  qt.addAll(points.map((_, i) => i));
  return qt;
}

// colorFn(point, index) -> CSS color | null  (null = skip this point entirely)
function drawGlowCanvas(points, colorFn) {
  if (!points || !COORDS) return;
  CTX.clearRect(0, 0, CV.width, CV.height);
  CTX.save();
  CTX.scale(DPR, DPR);
  CTX.globalCompositeOperation = "screen";
  for (let i = 0; i < points.length; i++) {
    const color = colorFn(points[i], i);
    if (!color) continue;
    const cx = COORDS[i * 2], cy = COORDS[i * 2 + 1];
    const r = R_GLOW + 1.5;     // match the SVG lit radius (R_GLOW=2.6 -> 4.1)
    const g = CTX.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, color);
    g.addColorStop(0.45, color);
    g.addColorStop(1, "transparent");
    CTX.fillStyle = g;
    CTX.beginPath();
    CTX.arc(cx, cy, r, 0, 2 * Math.PI);
    CTX.fill();
  }
  CTX.restore();
}

/* ---- tooltip: one shared cursor-following div ------------------------------ */
const TIP = d3.select("body").append("div").attr("class", "tip");
function showTip(text, x, y) {
  if (!text) return hideTip();
  TIP.text(text).style("display", "block")
    .style("left", Math.min(x + 14, window.innerWidth - 220) + "px")
    .style("top", Math.min(y + 14, window.innerHeight - 60) + "px");
}
function hideTip() { TIP.style("display", "none"); }
// tapping anything outside the map figure dismisses a pinned tooltip. All glow
// dots are now canvas (pointer-events:none); a dot tap targets the SVG/canvas box,
// so the figure's own pointerdown handler (below) decides pin vs province-drill vs
// dismiss. Any pointerdown inside the figure is therefore left to that handler.
const MAP_FIGURE = CV.parentElement;
d3.select(document).on("pointerdown.tipdismiss", (e) => {
  if (e.target instanceof Node && MAP_FIGURE.contains(e.target)) return;
  hideTip();
});

/* ---- single canvas/container hit-test (roots glow) ----------------------- */
// The container box is NOT CSS-transformed, but the SVG/canvas drawing surface may
// be vertically centered within it (.map-stage is a flex column). The canvas is
// sized to and positioned over the SVG, so the SVG's *untransformed* bounding rect
// is the true origin of projected (pre-zoom) px space. Invert the active canvas
// zoom transform to recover projection px, then ask the quadtree.
function canvasPxFromClient(clientX, clientY) {
  const rect = SVG.node().getBoundingClientRect();   // untransformed drawing origin
  const t = STATE.canvasTransform || d3.zoomIdentity;
  return [
    (clientX - rect.left - t.x) / t.k,
    (clientY - rect.top  - t.y) / t.k,
  ];
}
// Map a clientX/clientY to the nearest VISIBLE glow-point in the ACTIVE lens's hit
// context (STATE.hitCtx), returning that point (not an index). Each lens's draw
// path stashes {points, quad, isVisible?} aligned with the canvas's COORDS/QUAD, so
// this one routine serves every lens. The quad may index ALL points (roots/bridge
// gate visibility via isVisible) or only the lit subset (unique/bridge-unique/
// features build the quad over the visible set, so no gate is needed). When a quad
// indexes the full set, isVisible falls an unlit dot through to the province test.
function hitTestCanvas(clientX, clientY) {
  const ctx = STATE.hitCtx;
  if (!ctx || !ctx.quad) return undefined;
  const t = STATE.canvasTransform || d3.zoomIdentity;
  const [px, py] = canvasPxFromClient(clientX, clientY);
  const idx = ctx.quad.find(px, py, 12 / t.k);   // 12 css-px hit radius, transform-corrected
  if (idx === undefined) return undefined;
  const p = ctx.points?.[idx];
  if (p === undefined) return undefined;
  if (ctx.isVisible && !ctx.isVisible(p)) return undefined;
  return p;
}
// Set true when a glow-dot tap is handled, so the SVG province click that fires
// on the same gesture (canvas is pointer-events:none) is swallowed once.
let SUPPRESS_PROVINCE_CLICK = false;
// Wire the container ONCE: canvas is pointer-events:none, so the .map-stage figure
// is the single event source. Hover→tooltip, tap→pin (+inspector via hitCtx.onTap)
// or roots province drill (miss). The behaviour is data-driven by STATE.hitCtx.
(function bindCanvasHitTest() {
  const HOST = MAP_FIGURE;   // the .map-stage figure; canvas is pointer-events:none
  HOST.addEventListener("pointermove", (e) => {
    const p = hitTestCanvas(e.clientX, e.clientY);
    const text = p === undefined ? undefined : STATE.hitCtx?.tipText?.(p);
    if (text) showTip(text, e.clientX, e.clientY); else hideTip();
  });
  HOST.addEventListener("pointerleave", () => hideTip());
  HOST.addEventListener("pointerdown", (e) => {
    SUPPRESS_PROVINCE_CLICK = false;   // stale-flag guard: only this gesture may set it
    // 1) dot hit → run the lens's onTap (pins the tooltip; opens the inspector where
    //    that lens has one). The canvas is pointer-events:none, so this same gesture
    //    would ALSO trigger the SVG province path's click beneath the dot; suppress
    //    the very next province click so "dot tap = pin/inspect only" holds.
    const p = hitTestCanvas(e.clientX, e.clientY);
    if (p !== undefined) {
      STATE.hitCtx?.onTap?.(p, e);
      SUPPRESS_PROVINCE_CLICK = true;
      return;
    }
    // 2) dot MISS → province fall-through, ONLY for the roots clickable layer and
    //    only when an SVG province path didn't already handle the click (avoids a
    //    double draw, since province paths sit below the pointer-events:none canvas).
    if (e.target.closest && e.target.closest("g.provinces")) return;  // SVG handler covers it
    if (STATE.lens === "roots" && STATE.rootsProvinces && STATE.proj) {
      const lonlat = STATE.proj.invert(canvasPxFromClient(e.clientX, e.clientY));
      const hit = STATE.rootsProvinces.find(
        (d) => d3.geoContains({ type: "Feature", geometry: d.geometry }, lonlat));
      if (hit) { STATE.selectedProvince = hit; showProvincePanel(hit); draw(); return; }
    }
    // 3) true miss inside the map (empty sea, no dot, no province) → dismiss any pin
    hideTip();
  });
})();

/* ---- v2 two-axis nav config: WORLD (Nordic|Vietnam) x LENS (roots|unique) -- */
const WORLDS = {
  nordic: {
    label: "Nordic",
    tabs: [
      { country: "finland", label: "Finland" },
      { country: "sweden",  label: "Sweden"  },
      { country: "bridge",  label: "SE↔FI bridge" },
    ],
    lenses: { roots: "Common roots", unique: "Where names turn local", terrain: "The land beneath the names" },
  },
  vietnam: {
    label: "Vietnam",
    tabs: [{ country: "vietnam", label: "Vietnam" }],
    lenses: { roots: "Common roots", unique: "Where names turn local", terrain: "The land beneath the names" },
  },
};
const FILES = {
  finland: "fi.json", sweden: "se.json", vietnam: "vn.json", bridge: "bridge.json",
  "finland-unique": "fi-unique.json", "sweden-unique": "se-unique.json", "vietnam-unique": "vn-unique.json",
  "finland-features": "fi-features.json", "sweden-features": "se-features.json", "vietnam-features": "vn-features.json",
};

const STATE = {
  world: "nordic",
  country: "finland",
  lens: "roots",
  data: null,            // loaded payload
  features: null,        // features lens payload {features:[...], truthByMorpheme:{...}} (Task 8)
  active: new Set(),     // morpheme ids currently lit (story or explorer)
  colorById: new Map(),
  titleById: new Map(),  // glow-point id -> tooltip text for the shared cursor tooltip (per lens)
  rootsProvinces: null,  // provinces borrowed from {country}-unique.json for the roots clickable layer
  step: 0,
  steps: [],
  familyFilter: null,
  elementFilter: null,
  stockView: true,       // substrate lens defaults to the language-stock stepper
  stockFilter: null,     // Set of isolated stock keys (tap-to-isolate chips)
  stockDrill: null,      // when set: drilled into one stock's families (family view)
  inspected: null,       // {frag, country} while the Name Inspector panel is open
  provinceShade: null,   // fn(name)->opacity|null: inspector province value-ramp / isolate
  isolateFrag: null,     // rawFrag whose sibling cluster the inspector isolates (rare names)
  terrain: null,         // {water,coastline,river} physical-ground geometry, drawn below the dots
  frame: "whole",        // active viewport preset (whole|region|cluster) — stepped semantic zoom (Task 5)
  proj: null,            // the d3 projection that drew the current lens (applyFrame reuses it)
  canvasTransform: d3.zoomIdentity,   // {x,y,k} active canvas zoom; Task 4 hit-test inverts it
  hitCtx: null,          // per-lens canvas hit-test context (Task 5): {points, quad, isVisible?, tipText, onTap}
};

/* ---- stepped-zoom viewport (Task 5) ---------------------------------------
   All data layers live inside ONE persistent g.viewport group; a single
   transform on it animates between named framings (whole/region/cluster). The
   transform is in SCREEN space so it works for either lens's projection — but
   the bbox→screen math (frameTransform) must use the SAME projection that drew
   the current lens (stashed on STATE.proj). The four draw*Layer helpers target
   the module-level LAYER (the viewport group) instead of SVG directly; <defs>
   stay on SVG (not zoomable). */
let LAYER = SVG;
function ensureViewport() {
  let vp = SVG.selectAll("g.viewport").data([0]);
  vp = vp.enter().append("g").attr("class", "viewport").merge(vp);
  LAYER = vp;
  return vp;
}

// Named viewport presets per world. bbox = [[w,s],[e,n]] in lon/lat; null = whole.
const FRAMES = {
  finland: { whole: null, region: [[22, 60], [31, 64]], cluster: [[24.5, 60.0], [26.0, 61.2]] },
  vietnam: { whole: null, region: [[104.5, 19.5], [108.0, 23.0]], cluster: [[105.5, 20.5], [106.5, 21.5]] },
  sweden:  { whole: null, region: [[11, 57], [19, 61]], cluster: [[17.5, 59.0], [18.5, 59.7]] },
};

const FRAME_MAX_SCALE = 8;    // cap so a tiny cluster bbox can't blow the map up
const FRAME_PADDING = 0.9;    // leave a small margin around the framed bbox

// Screen-space transform that frames a lon/lat bbox using the active projection.
// null bbox (whole) → identity. Capped at FRAME_MAX_SCALE so a tiny cluster can't blow up.
function frameTransform(bbox, proj, w, h) {
  if (!bbox || !proj) return d3.zoomIdentity;
  const [[x0, y0], [x1, y1]] = [proj(bbox[0]), proj(bbox[1])];
  const [minx, maxx] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [miny, maxy] = [Math.min(y0, y1), Math.max(y0, y1)];
  const k = Math.min(FRAME_MAX_SCALE, FRAME_PADDING / Math.max((maxx - minx) / w, (maxy - miny) / h));
  const tx = w / 2 - k * (minx + maxx) / 2;
  const ty = h / 2 - k * (miny + maxy) / 2;
  return d3.zoomIdentity.translate(tx, ty).scale(k);
}

// Animate the viewport to a named framing. No-ops gracefully when the country has
// no FRAMES (bridge) or the name is undefined → identity (whole). Uses STATE.proj,
// the projection that drew the current lens, so the bbox math is correct per lens.
function applyFrame(name) {
  STATE.frame = name;
  const node = SVG.node();
  const w = node.clientWidth || 800, h = node.clientHeight || 600;
  const t = frameTransform((FRAMES[STATE.country] || {})[name], STATE.proj, w, h);
  // Keep the canvas glow in lockstep with the SVG viewport zoom (screen-space).
  CV.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
  STATE.canvasTransform = t;   // {x, y, k}; identity when whole — Task 4 hit-test inverts this
  const vp = SVG.select("g.viewport");
  if (vp.empty()) return;
  vp.transition().duration(600)
    .attr("transform", `translate(${t.x},${t.y}) scale(${t.k})`);
}

// keep the frame-bar chips' is-active in sync with STATE.frame (stepper may set it)
function syncFrameChips() {
  document.querySelectorAll("#frame-bar .frame-chip").forEach((b) => {
    const isActive = b.dataset.frame === STATE.frame;
    b.classList.toggle("is-active", isActive);
    b.setAttribute("aria-pressed", String(isActive));
  });
}

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
  // key:        { label (legend),                                 short (chip),    color }
  highlands:     { label: "Highlands (Mon-Khmer / Austronesian)",  short: "highlands",  color: "#ffc933" },
  northern:      { label: "Northern uplands (Tai-Kadai)",          short: "Tai north",  color: "#00f5b8" },
  mekong:        { label: "Mekong / Khmer delta",                  short: "Mekong",     color: "#ff3d71" },
  sapmi:         { label: "Sámi / Finnish substrate",              short: "Sámi north", color: "#22d3ff" },
  swedish:       { label: "Swedish substrate in Finland",          short: "Swedish coast", color: "#ff9e4a" },
  karelia:       { label: "Eastern Finnish (Karelia)",             short: "Karelia",    color: "#f15bb5" },
  clearing:      { label: "Clearing era (-ryd/-red/-röd)",         short: "clearings",  color: "#a8e063" },
  danish:        { label: "Danish south (-löv/-arp/-rup)",         short: "Danish south", color: "#ef476f" },
  norrland:      { label: "Norrland rivers (-sele/-ånge)",         short: "rivers",     color: "#c77dff" },
  shieling:      { label: "Interior shielings (-täkt/-arvet)",     short: "shielings",  color: "#ffd166" },
  westcoast:     { label: "West-coast farms (vin-names)",          short: "west coast", color: "#e76f51" },
  gotland:       { label: "Gotland farms (-arve)",                 short: "Gotland",    color: "#80ffdb" },
  other:         { label: "Other confined",                       short: "other",      color: "#9aa3b2" },
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

/* Per-country suffix-fragment -> family curation (substrate lens). Element ids
   are last-4-char proxies, so matching is endsWith, LONGEST fragment first.
   Every fragment is pinned to the baked data by tests/test_family_curation.py —
   if a fragment fails there, REMOVE it (it stays grey) rather than widen the
   expected provinces. */
const SE_LISTS = {
  sapmi:     ["ärvi", "aara", "jaur", "rova", "järv", "iemi", "ngas", "kala", "kola", "okta", "djen"],
  clearing:  ["ered", "ared", "aröd", "rröd", "röd", "sröd", "sred", "rred", "åröd", "äryd", "ruda"],
  danish:    ["slöv", "rlöv", "elöv", "erup", "orup", "vång", "ölla"],
  norrland:  ["sele", "ånge", "åbyn", "ånet", "önet", "vike", "rsel"],
  shieling:  ["rvet", "täkt", "äbod", "ttbo", "orbo", "holn", "olen"],
  westcoast: ["dane", "dene", "tene", "gane", "bön", "bua", "röra", "kene"],
  gotland:   ["arve", "ings", "vide"],
};
const FI_LISTS = {
  sapmi:     ["rova", "aapa", "polo", "osio", "valo", "eppi", "usua"],  // NB: "iemi" (-niemi cape) is intentionally NOT here — the bake found it in 17 FI provinces (unconfined), so it would break the Lappi-confinement curation guard. The explorer (src/taxonomy.py) DOES tag -iemi as sapmi/finnic; the curated stepper keeps it 'other' to stay honest.
  swedish:   ["skog", "bäck", "cken", "lmen", "unda", "land", "ngen", "ppoo", "back",
              "dvik", "kvik", "folk", "vist", "slax", "skat", "järd", "ssen", "llan",
              "ngar", "abba", "öölö", "yöli", "agen"],
  karelia:   ["rkkä", "uuro", "kaja"],
};

// flatten to [fragment, family] sorted longest-first, so e.g. "aröd" wins over "röd"
function buildFragIndex(lists) {
  const idx = [];
  for (const [fam, frags] of Object.entries(lists))
    for (const f of frags) idx.push([f, fam]);
  idx.sort((a, b) => b[0].length - a[0].length);
  return idx;
}
const FRAG_INDEX = { sweden: buildFragIndex(SE_LISTS), finland: buildFragIndex(FI_LISTS) };

/* 2-3 sentence story per family, shown on that family's stepper step. */
const FAMILY_HISTORY = {
  clearing: "Medieval Sweden grew by axe: <b>-ryd</b>, <b>-red</b> and <b>-röd</b> all mean a clearing cut from the forest. The variants are dialect — -red in Västergötland, -röd in Skåne and Bohuslän, -ryd in Småland — and together they trace the great colonisation of the southern woodlands, roughly 1000–1350.",
  danish: "Skåne was Danish until 1658, and its names still are. The <b>-löv</b> names are the oldest layer, coined before the year 1000; <b>-arp</b> and <b>-rup</b> are Danish forms of <i>thorp</i>, a daughter settlement budded off an older village; a <b>vång</b> is a Scanian open field.",
  sapmi: "In the far north the map speaks Sámi and Finnish: <b>-järvi</b> and <b>-jaur(e)</b> are lake, <b>-niemi</b> a cape, <b>-vaara</b> a fell. Administration wrote the villages down in Swedish or Finnish, but the words underneath never translated.",
  norrland: "Norrland's Swedish settlers followed the rivers, naming the calm stretch between rapids <b>-sele</b> and the river-meadow <b>-ånge(r)</b>. These words barely exist south of the timber country.",
  shieling: "Dalarna names its interior in shieling words: a <b>-täkt</b> is an enclosed hay-take, a <b>fäbod</b> a summer farm, and <b>-arvet</b> — 'the inheritance' — survives as a place-name ending only here.",
  westcoast: "Bohuslän and Dalsland keep some of Sweden's oldest farm endings: <b>-ane</b> and <b>-ene</b> descend from prehistoric <i>vin</i>, 'pasture', and local forms like <b>-bön</b> and <b>-bua</b> name single farms and boat-houses along the west coast.",
  gotland: "Gotland is its own name-world: <b>-arve</b> farms — 'the heir's' — exist nowhere else in Sweden, a fossil of the island's separate law and inheritance customs.",
  swedish: "Finland's coast answers in Swedish: <b>-böle</b> a settlement, <b>-bäck</b> a brook, <b>-vik</b> a bay. Österbotten, Åland and the Uusimaa shore were settled from Sweden in the Middle Ages, and their village names never switched languages.",
  karelia: "The eastern border leans Karelian and Savonian — endings like <b>-kkä</b> and <b>-uro</b> that cluster in Pohjois-Karjala and thin out fast toward the west.",
  highlands: "The Central Highlands name water, villages and mountains in Mon-Khmer and Austronesian: <b>Đăk</b> and <b>Ea</b> are water, <b>Buôn</b> and <b>Plei</b> are village — the map's oldest layer, older than Vietnamese settlement.",
  northern: "The northern uplands speak Tai: <b>Nậm</b> is water, <b>Mường</b> a domain — the same words that run on across Laos and Thailand.",
  mekong: "The delta keeps Khmer water-words under Vietnamese spelling: <b>Xẻo</b> a creek, <b>Vàm</b> a river mouth, <b>Sóc</b> a village.",
};

/* ---- language STOCK layer (parent of FAMILY) -------------------------------
   The coarse "whose language" axis. Few bold separable hues. Each existing
   dialect family maps to a parent stock via FAMILY_TO_STOCK; stockOf() resolves
   an element -> family -> stock. Direct-fragment stocks (Slavic) are added by
   STOCK_FRAG in Task 8. */
const STOCK = {
  germanic:  { label: "North Germanic (Norse)",     short: "Germanic",     color: "#ff9e4a" },
  finnic:    { label: "Baltic-Finnic",              short: "Finnic",       color: "#4cc9f0" },
  sami:      { label: "Sámi (Uralic)",              short: "Sámi",         color: "#22d3ff" },
  slavic:    { label: "Slavic",                     short: "Slavic",       color: "#f15bb5" },
  sinitic:   { label: "Sino-Vietnamese",            short: "Sino-Viet",    color: "#ffc933" },
  monkhmer:  { label: "Mon-Khmer",                  short: "Mon-Khmer",    color: "#00f5b8" },
  austro:    { label: "Austronesian (highland)",    short: "Austronesian", color: "#ff3d71" },
  tai:       { label: "Tai-Kadai",                  short: "Tai-Kadai",    color: "#a8e063" },
  khmer:     { label: "Khmer (delta)",              short: "Khmer",        color: "#c77dff" },
  other:     { label: "Other / uncurated",          short: "other",        color: "#9aa3b2" },
};

// existing family key -> parent stock key. Families not listed -> resolved via
// STOCK_FRAG (Task 8) or fall to "other".
const FAMILY_TO_STOCK = {
  // Nordic
  clearing: "germanic", danish: "germanic", norrland: "germanic",
  shieling: "germanic", westcoast: "germanic", gotland: "germanic",
  swedish: "germanic",                 // Swedish substrate in Finland
  karelia: "finnic",                   // eastern Finnish
  sapmi: "sami",                       // NOTE: split refined in Task 7
  // Vietnam
  highlands: "monkhmer",               // NOTE: highlands split (mon-khmer vs austro) in Task 8
  northern: "tai",
  mekong: "khmer",
  other: "other",
};

// element id -> family key. country picks the table; Nordic matches by suffix
// (ids are last-4-char proxies), longest fragment first. Unknown -> "other".
function familyOf(elementId, country) {
  if (!elementId) return "other";
  if (country === "vietnam") return VN_FAMILY[elementId] || "other";
  const idx = FRAG_INDEX[country] || [];
  for (const [frag, fam] of idx) {
    if (elementId === frag || elementId.endsWith(frag)) return fam;
  }
  return "other";
}
// the SE↔FI bridge keeps its 3-entry substrate story (sapmi / swedish / other):
// collapse any other family to "other" there.
const BRIDGE_FAMILIES = new Set(["sapmi", "swedish"]);
function bridgeFamilyOf(elementId, country) {
  const f = familyOf(elementId, country);
  return BRIDGE_FAMILIES.has(f) ? f : "other";
}
function familyColor(elementId, country) { return (FAMILY[familyOf(elementId, country)] ?? FAMILY.other).color; }

/* Baltic-Finnic vs Sámi both surface in the north. The old "sapmi" family
   fused them. These FRAGMENT proxies are the Sámi layer; everything else under
   the Finnish/Finnic tables is Baltic-Finnic. Pinned by test_stock_curation. */
/* Stocks curated directly from raw fragments (no existing family). Slavic is the
   restored Karelian/Ingrian border story. VN highland split + Sino-Viet live here
   too. Pinned by test_stock_curation; a fragment that fails the guard is removed. */
const STOCK_FRAG = {
  slavic:   [],  // no Slavic fragments survive current data — needs border-province re-fetch (deferred)
  austro:   ["plei", "cư", "cuôr", "yang", "yông", "knia", "drai", "buôn", "bon"], // Jarai/Ê Đê highland villages
  // (Sino-Vietnamese is the roots dict; in substrate it only shows when SV element confined)
};
// Slavic fragments were cut (all dead in current data — Karelian/Ingrian border provinces not fetched).
// Task 9's guard pins every entry here; a failing fragment must be removed.
function buildStockFragIndex(table) {
  const idx = [];
  for (const [st, frags] of Object.entries(table))
    for (const f of frags) idx.push([f, st]);
  idx.sort((a, b) => b[0].length - a[0].length);
  return idx;
}
const STOCK_FRAG_INDEX = buildStockFragIndex(STOCK_FRAG);

const STOCK_HISTORY = {
  germanic: "These names are North Germanic — Old Norse and its Swedish descendants. The Vikings' word for a farm, <b>-by</b>, and the medieval clearings <b>-ryd/-red/-röd</b> spread the same tongue from the coast deep into the forest.",
  finnic: "Baltic-Finnic names the water and the land: <b>-järvi</b> a lake, <b>-niemi</b> a cape, <b>-vaara</b> a wooded fell. This is the oldest living layer across most of Finland.",
  sami: "In the far north the map keeps Sámi words — <b>-jaure</b> a lake, <b>-aapa</b> an open mire — a separate Uralic tongue that administration wrote down but never translated.",
  slavic: "Along Finland's eastern edge the names lean Slavic — the Russian and Ingrian border country of Karelia, a layer the earlier map dropped as 'foreign' but which is part of the same substrate story.",
  sinitic: "Vietnam's administrative names are Sino-Vietnamese — Chinese-derived wishes stamped on geography: <b>An</b> peace, <b>Bình</b> calm, <b>Phú</b> wealth, <b>Long</b> dragon. This is the dominant naming stock of the densely-settled north and centre.",
  monkhmer: "The Central Highlands name water and villages in Mon-Khmer: <b>Đăk</b> and <b>Ea</b> are water, the oldest layer, older than Vietnamese settlement.",
  austro: "Among the highlands the Jarai and Ê Đê speak Austronesian: <b>Plei</b> a village, <b>Cư</b> a mountain — the same family as Malay and Malagasy, stranded inland.",
  tai: "The northern uplands speak Tai-Kadai: <b>Nậm</b> is water, <b>Mường</b> a domain — words that run on across Laos and Thailand.",
  khmer: "The delta keeps Khmer water-words under Vietnamese spelling: <b>Xẻo</b> a creek, <b>Vàm</b> a river-mouth, <b>Sóc</b> a village.",
};

const SAMI_FRAGS = new Set(["jaur", "aapa", "rova", "aara", "polo", "osio"]);

// element id -> stock key. country picks family table; family -> stock via map,
// with the finnic/sámi refinement applied for Nordic.
function stockOf(elementId, country) {
  if (!elementId) return "other";
  // direct-fragment stocks first (Slavic etc. added in Task 8 via STOCK_FRAG)
  for (const [frag, st] of STOCK_FRAG_INDEX) {
    if (elementId === frag || elementId.endsWith(frag)) return st;
  }
  const fam = familyOf(elementId, country);
  if (fam === "sapmi") {
    // split: true Sámi fragment -> sami, else Baltic-Finnic
    for (const f of SAMI_FRAGS) if (elementId.endsWith(f)) return "sami";
    return "finnic";
  }
  return FAMILY_TO_STOCK[fam] || "other";
}
function stockColor(elementId, country) {
  return (STOCK[stockOf(elementId, country)] ?? STOCK.other).color;
}

// families present in this country's confined set, desc. by dot count, no "other"
function familiesPresent(points, country) {
  const counts = new Map();
  (points || []).forEach((p) => {
    if (!p[2]) return;
    const f = familyOf(p[2], country);
    counts.set(f, (counts.get(f) || 0) + 1);
  });
  counts.delete("other");
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([fam, n]) => ({ fam, n }));
}
function familyStats(points, country, fam) {
  let dots = 0; const els = new Set();
  (points || []).forEach((p) => {
    if (p[2] && familyOf(p[2], country) === fam) { dots++; els.add(p[2]); }
  });
  return { dots, els: els.size };
}

// stocks present in this country's confined set, by dot count desc, no "other"
function stocksPresent(points, country) {
  const counts = new Map();
  (points || []).forEach((p) => {
    if (!p[2]) return;
    const st = stockOf(p[2], country);
    if (st === "other") return;
    counts.set(st, (counts.get(st) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map((e) => e[0]);
}
// stock stepper: intro → one step per stock → all → explore
function buildStockSteps() {
  const stocks = stocksPresent(STATE.data.points, STATE.country);
  STATE.steps = [{ kind: "intro-stock" }]
    .concat(stocks.map((st) => ({ kind: "stock", st })))
    .concat([{ kind: "all-stock" }, { kind: "explore-stock" }]);
}
// the family-level unique stepper, extracted so the stock drill can rebuild it
// filtered to one stock's families.
function buildUniqueSteps() {
  STATE.steps = [{ kind: "intro-unique" }]
    .concat(familiesPresent(STATE.data.points, STATE.country)
      .filter((f) => !STATE.stockDrill || familiesOfStock(STATE.stockDrill, STATE.country).includes(f.fam))
      .map((f) => ({ kind: "family", f })))
    .concat([{ kind: "all-unique" }, { kind: "explore-unique" }]);
}
// families whose parent stock == stockKey (via FAMILY_TO_STOCK + sapmi split)
function familiesOfStock(stockKey, country) {
  return Object.keys(FAMILY).filter((fam) => {
    if (fam === "sapmi") return stockKey === "sami" || stockKey === "finnic";
    return (FAMILY_TO_STOCK[fam] || "other") === stockKey;
  });
}

/* ---- Name Inspector (Task 6): click a confined glow dot to read its rawFrag --
   A fragment is COMMON if it spans many provinces (imposed names spread) and RARE
   if confined to one or two (substrate stays put). inspectFragment() dispatches to
   the right panel + drives the map. Both indexes (fragmentSpread / confinedTheory)
   are baked into each *-unique.json by the data layer; we read them defensively so
   an un-rebuilt JSON simply yields the "too rare / unknown" fallbacks rather than
   crashing. The panel reuses the SAME #step-body element the stepper writes into. */

// A fragment is COMMON if it spans >= this many provinces; else RARE/confined.
// "by province spread" — matches the thesis (imposed names spread; substrate stays put).
const COMMON_PROVINCE_THRESHOLD = 6;

function isCommonFragment(frag) {
  const s = STATE.data?.fragmentSpread?.[frag];
  return !!s && s.provinces.length >= COMMON_PROVINCE_THRESHOLD;
}

// honest gloss: the family LABEL only when the frag resolves to a known (non-"other")
// family; otherwise "" — never invent a meaning the curation can't back.
function glossFor(frag, country) {
  const fam = familyOf(frag, country);
  return fam && fam !== "other" ? (FAMILY[fam]?.label ?? "") : "";
}

// write into the existing story panel (same element the stepper/province panel use)
function panelHTML(html) { d3.select("#step-body").html(html); }

function inspectFragment(frag, country) {
  if (!frag) return;
  STATE.inspected = { frag, country };
  // an inspector view governs the whole map: clear the stepper's layer filters so the
  // full confined point-set draws and the inspector's own opacity rules take over.
  STATE.familyFilter = null;
  STATE.elementFilter = null;
  STATE.stockFilter = null;
  if (isCommonFragment(frag)) renderCommonInspector(frag, country);
  else renderRareInspector(frag, country);
}

function renderCommonInspector(frag, country) {
  const s = STATE.data.fragmentSpread[frag];
  const top = s.provinces.slice(0, 5);
  const maxN = top.length ? top[0].count : 1;
  const gloss = glossFor(frag, country);   // family label, or "" when unknown
  const bars = top.map((p) =>
    `<div class="dens-row"><span>${p.id}</span>
       <span class="dens-bar" style="width:${Math.round(100 * p.count / maxN)}%"></span>
       <span class="dens-n">${p.count}</span></div>`).join("");
  panelHTML(`
    <div class="insp">
      <div class="label">Common name-element</div>
      <h3 class="insp-frag">${frag}${gloss ? ` <span class="insp-gloss">${gloss}</span>` : ""}</h3>
      <p class="insp-lead">Found in <b>${s.totalPlaces} places</b> across
        <b>${s.provinces.length} provinces</b> — a name that spread.</p>
      <div class="label">Where it's densest</div>
      <div class="dens">${bars}</div>
      <button class="insp-back">‹ back to the story</button>
    </div>`);
  lightProvincesByFragment(frag);   // map: value ramp + dim the rest
  bindInspectorBack();
}

function renderRareInspector(frag, country) {
  const t = STATE.data?.confinedTheory?.[frag];
  const fam = (FAMILY[t?.family] || FAMILY.other);
  if (!t) {
    panelHTML(`<div class="insp"><div class="label">Rare name-element</div>
      <h3 class="insp-frag">${frag}</h3>
      <p class="insp-lead">Too rare to place — it appears in only a province or two,
        with no confined neighbours to triangulate from.</p>
      <button class="insp-back">‹ back to the story</button></div>`);
  } else {
    // honest gate (mirrors glossFor): only a KNOWN, curated family earns the
    // substrate/fossil theory. "other"/unknown frags include modern admin tokens
    // (ward/block numbers, tổ/khu/tdp) — we must NOT call those ancient fossils.
    const known = t.family && t.family !== "other";
    const headColor = known ? fam.color : FAMILY.other.color;
    const nb = t.neighbours.slice(0, 4);
    let theoryHTML;
    if (known) {
      const nbHTML = nb.length
        ? `Its cluster-mates here are ${nb.map((n) => `<b>${n}</b>`).join(", ")} — all
           <b style="color:${fam.color}">${fam.label}</b> words.`
        : `It stands alone in this cluster.`;
      theoryHTML = `${nbHTML} So it is most likely a
          <b>${fam.label} substrate name</b> the state mapped over but never renamed —
          a fossil, not an import.`;
    } else {
      const matesHTML = nb.length
        ? `Its cluster-mates here are ${nb.map((n) => `<b>${n}</b>`).join(", ")} — but this `
        : `This `;
      theoryHTML = `${matesHTML}element is uncurated: it may be an administrative label
          (ward or block numbers), an ordinary word, or a substrate fossil we haven't yet
          classified. We don't guess.`;
    }
    panelHTML(`
      <div class="insp">
        <div class="label">Rare name-element</div>
        <h3 class="insp-frag" style="color:${headColor}">${frag}</h3>
        <p class="insp-lead">Appears in just <b>${t.count} places</b>, confined to
          <b>${t.province}</b> — it never spread.</p>
        <div class="label">${known ? "A theory of where it comes from" : "Where it comes from"}</div>
        <p class="insp-theory">${theoryHTML}</p>
        <button class="insp-back">‹ back to the story</button>
      </div>`);
    isolateCluster(frag, t.province);  // map: isolate point + sibling cluster, dim rest
  }
  bindInspectorBack();
}

// .insp-back → clear inspector state, restore the current stepper card + normal map.
function bindInspectorBack() {
  d3.select("#step-body").selectAll(".insp-back").on("click", () => {
    STATE.inspected = null;
    STATE.provinceShade = null;
    STATE.isolateFrag = null;
    renderStep();   // re-renders the current step's card AND redraws the normal map
  });
}

// COMMON: single-hue value ramp over the provinces that contain the fragment —
// densest brightest, non-matches dim to a faint outline (handled in drawProvinceLayer).
function lightProvincesByFragment(frag) {
  const s = STATE.data.fragmentSpread[frag];
  const counts = new Map(s.provinces.map((p) => [p.id, p.count]));
  const max = s.provinces.length ? s.provinces[0].count : 1;
  STATE.provinceShade = (name) => {
    const c = counts.get(name);
    return c == null ? null : 0.25 + 0.75 * (c / max);   // opacity 0.25..1.0
  };
  drawUnique(null);   // drawProvinceLayer + glow layer consult the inspector state
}

// RARE: isolate the confined province + its sibling cluster; the canvas glow layer
// SKIPS every dot whose rawFrag !== the inspected one (handled in drawUnique — the
// Task 5 skip-to-null replacement for the old SVG 0.12-opacity dim).
function isolateCluster(frag, province) {
  STATE.provinceShade = (name) => (name === province ? 0.9 : null);
  STATE.isolateFrag = frag;
  drawUnique(null);
}

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

// Uniform lit-dot radius for the roots + bridge glow (NYC-dotmap look: color
// carries identity, size is constant). Mirrors the unique lens's 2.6 base.
const R_GLOW = 2.1;   // was 2.6 — tighter dots, dense SE roots read cleaner (2026-06-20)

// base layer: faint "other"/unlit dots (no glow) for honest density.
// Reusable by later tasks (e.g. Task 14 bridge view).
function drawBaseLayer(points, proj) {
  let base = LAYER.selectAll("g.base").data([0]);
  base = base.enter().append("g").attr("class", "base").merge(base);
  base.selectAll("circle").data(points).join("circle")
    .attr("cx", (p) => proj([p[0], p[1]])[0])
    .attr("cy", (p) => proj([p[0], p[1]])[1])
    .attr("r", 1.1)
    .attr("fill", "#27406e")
    .attr("fill-opacity", 0.5);
}

// Roots/bridge glow: light points whose id (p[2]) is in STATE.active, colored via
// STATE.colorById. Drawn to the canvas (was 44k SVG circles for SE). Shared by the
// roots lens (draw) and the SE↔FI concept-bridge (drawBridge) — both seed
// STATE.active/colorById/titleById the same way. The COORDS/QUAD globals must be
// built over `points` by the caller BEFORE this runs; we set STATE.hitCtx here so
// the single container hit-test serves both. The quad indexes ALL points, so the
// isVisible gate (lit ∈ STATE.active) lets an unlit dot fall through to the
// province test (roots) and prevents hovering dim base dots.
function drawGlowLayer(points) {
  const active = STATE.active, colorById = STATE.colorById;
  const colorFn = (p) => (p[2] && active.has(p[2])) ? colorById.get(p[2]) : null;
  drawGlowCanvas(points, colorFn);
  STATE.hitCtx = {
    points,
    quad: QUAD,
    isVisible: (p) => !!(p && p[2] && STATE.active?.has(p[2])),
    tipText: (p) => (p && p[2]) ? STATE.titleById?.get(p[2]) : undefined,
    // roots/bridge have no inspector — a dot tap pins the tooltip only.
    onTap: (p, e) => { const t = STATE.titleById?.get(p[2]); if (t) showTip(t, e.clientX, e.clientY); },
  };
}

// Draw the quiet physical-terrain ground (water/coastline/river) BELOW everything
// else. terrain = {water:[Feature], coastline:[Feature], river:[Feature]} or null.
// Re-created each draw; always the lowest data layer so dots/provinces sit on top.
// terrain never takes pointer events (the v2.5 lesson — the dots carry the tooltips).
function drawTerrainLayer(terrain, proj) {
  LAYER.selectAll("g.terrain").remove();
  if (!terrain) return;
  const g = LAYER.append("g").attr("class", "terrain");
  // Force terrain to be the lowest data layer WITHIN the viewport: move it to be
  // the first child of LAYER, so re-renders never stack it above dots/provinces.
  // A direct DOM insertBefore is deterministic regardless of which groups exist.
  // (defs live on SVG root, outside the viewport, so terrain's reference point is
  // simply LAYER's current first child.)
  const layerNode = LAYER.node();
  const ref = layerNode.firstChild;
  if (g.node() !== ref) layerNode.insertBefore(g.node(), ref);
  const path = d3.geoPath(proj);
  const add = (feats, cls) => g.selectAll(`path.${cls}`)
    .data(feats || []).enter().append("path")
    .attr("class", cls).attr("d", path);
  add(terrain.water, "tr-water");
  add(terrain.coastline, "tr-coast");
  add(terrain.river, "tr-river");
}

function draw() {
  const node = SVG.node();
  const w = node.clientWidth || 800;
  const h = node.clientHeight || 600;
  SVG.attr("viewBox", `0 0 ${w} ${h}`);
  const proj = projectionFor(STATE.country, STATE.data.points, w, h);
  STATE.proj = proj;            // applyFrame frames against the lens's own projection
  sizeCanvas();
  COORDS = buildCoordCache(STATE.data.points, proj);
  QUAD   = buildQuadtreeFromCache(STATE.data.points, COORDS);
  ensureViewport();             // all layers below route through LAYER (the viewport group)
  drawTerrainLayer(STATE.terrain, proj);
  drawBaseLayer(STATE.data.points, proj);
  if (STATE.rootsProvinces) {
    drawProvinceLayer(STATE.rootsProvinces, proj, {
      onClick: (d) => {
        if (SUPPRESS_PROVINCE_CLICK) { SUPPRESS_PROVINCE_CLICK = false; return; }
        STATE.selectedProvince = d; showProvincePanel(d); draw();
      },
    });
  }
  drawGlowLayer(STATE.data.points);
  applyFrame(STATE.frame || "whole");
}

// Terrain filename is derived from the per-country data file (fi.json -> fi-terrain.json).
// Graceful null on any failure (bridge has no terrain file; a missing file must not break the view).
async function loadTerrain() {
  const f = FILES[STATE.country];
  if (!f) return null;
  return d3.json(f.replace(".json", "-terrain.json")).catch(() => null);
}

/* ---- v2 data load + step build + render ---------------------------------- */
async function loadCurrent() {
  // Switching world/tab/lens swaps the whole view: drop every SVG data layer
  // (g.base, g.provinces, g.terrain, g.spread, g.feat-era leftovers) so no ghost
  // layer from the prior renderer survives. All glow dots now live on the canvas,
  // which is cleared just below.
  SVG.selectAll("g").remove();
  // The glow canvas is position:absolute + never hidden, so its roots glow pixels
  // would linger over the next lens. Clear it on every switch; the roots draw()
  // immediately repaints when roots is the active lens, so this is safe.
  CTX.clearRect(0, 0, CV.width, CV.height);
  STATE.hitCtx = null;          // a half-loaded lens must not hit-test stale data; each draw repopulates it
  STATE.rootsProvinces = null;  // cleared on every (re)load; only the roots branch repopulates it
  STATE.selectedProvince = null;
  STATE.inspected = null; STATE.provinceShade = null; STATE.isolateFrag = null;
  STATE.terrain = null;  // bridge has none; roots/unique branches refetch per country
  STATE.frame = "whole"; // a fresh country/lens always opens un-zoomed
  syncFrameChips();
  STATE.features = null;
  d3.select("#step-body").html('<div class="card"><p class="history">Loading…</p></div>');
  try {
    // Terrain lens — "the land beneath the names". Rides Plan A terrain + zoom and
    // reuses the features render code. Bridge has no terrain file; fall through to the
    // bridge branch below so the terrain button is a no-op there rather than a crash.
    if (STATE.lens === "terrain" && STATE.country !== "bridge") return await loadTerrainLens();
    // Bridge view — lens-aware: unique lens shows substrate view, roots shows concept-pairs.
    if (STATE.country === "bridge") {
      if (STATE.lens === "unique") return await loadBridgeUnique();
      return await loadBridge();
    }
    // Unique-by-province lens (Task 15) — graceful stub-guard until that task lands.
    if (STATE.lens === "unique") {
      if (typeof loadUnique === "function") return await loadUnique();
      d3.select("#step-body").html('<div class="card"><p class="history">Unique-by-province view coming up.</p></div>');
      return;
    }
    const uniqueKey = STATE.country + "-unique";
    const [rootsData, uniqueData] = await Promise.all([
      d3.json(FILES[STATE.country]),
      FILES[uniqueKey] ? d3.json(FILES[uniqueKey]).catch(() => null) : Promise.resolve(null),
    ]);
    STATE.data = rootsData;
    STATE.terrain = await loadTerrain();
    STATE.rootsProvinces = uniqueData?.provinces ? dropForeignProvinces(uniqueData.provinces) : null;
    respaceColors(STATE.data.morphemes);   // separable per-element hues (D4)
    STATE.colorById = new Map(STATE.data.morphemes.map((m) => [m.id, m.color]));
    STATE.titleById = new Map(STATE.data.morphemes.map((m) => [m.id, `${m.element} — ${m.gloss}`]));
    buildRootSteps();
    STATE.step = 0;
    renderRootStep();
    draw();
  } catch (err) {
    console.error("load failed", err);
    d3.select("#step-body").html(
      '<div class="card"><p class="history">Data failed to load — check your connection and reload.</p></div>');
  }
}

/* ---- URL hash state: #world/country/lens/step[/p:provinceId] ---------------
   replaceState (no history spam); read once at boot, so any view — including
   a clicked province in either lens — is shareable. */
let BOOTING = true; // suppress hash writes until the boot restore has applied
function syncHash() {
  if (BOOTING) return;
  const parts = [STATE.world, STATE.country, STATE.lens, STATE.step];
  if (STATE.selectedProvince) parts.push("p:" + encodeURIComponent(STATE.selectedProvince.id));
  if (STATE.familyFilter?.size) parts.push("f:" + [...STATE.familyFilter].join("+"));
  if (STATE.stockFilter?.size) parts.push("s:" + [...STATE.stockFilter].join("+"));
  history.replaceState(null, "", "#" + parts.join("/"));
}
function parseHash() {
  const seg = location.hash.replace(/^#/, "").split("/");
  if (!WORLDS[seg[0]]) return null;
  STATE.world = seg[0];
  const tabs = WORLDS[STATE.world].tabs.map((t) => t.country);
  STATE.country = tabs.includes(seg[1]) ? seg[1] : tabs[0];
  STATE.lens = (seg[2] === "unique" || seg[2] === "terrain") ? seg[2] : "roots";
  const extras = seg.slice(4);
  const pSeg = extras.find((s) => s.startsWith("p:"));
  const fSeg = extras.find((s) => s.startsWith("f:"));
  const sSeg = extras.find((s) => s.startsWith("s:"));
  return {
    step: Math.max(0, parseInt(seg[3], 10) || 0),
    prov: pSeg ? decodeURIComponent(pSeg.slice(2)) : null,
    fams: fSeg ? fSeg.slice(2).split("+").filter((k) => FAMILY[k]) : null,
    stocks: sSeg ? sSeg.slice(2).split("+").filter((k) => STOCK[k]) : null,
  };
}

/* ---- step chips: the story's clickable table of contents ----------------------------
   One chip per step, dot-colored by the step's own hue where it has one.
   Fixes the "N-step corridor with no map of the corridor": every morpheme is
   visible and one click away. */
function chipLabel(s) {
  switch (s.kind) {
    case "morpheme": return s.mo.element;
    case "pair":     return `${s.p.sv}↔${s.p.fi}`;
    case "family": return FAMILY[s.f.fam].short;
    case "stock": return STOCK[s.st].short;
    case "truth": return "truth";
    case "intro-spread": return "spread?";
    case "spread": return "spread";
    case "water": return "water";
    case "names-hug-water": return "names";
    case "all": case "all-bridge": case "all-unique": case "all-stock": return "all";
    case "explore": case "explore-unique": case "explore-stock": case "show-bru": case "explore-terrain": return "explore";
    default: return "intro";
  }
}
function chipColor(s) {
  if (s.kind === "morpheme") return s.mo.color;
  if (s.kind === "pair") return s.p.color;
  if (s.kind === "family") return FAMILY[s.f.fam].color;
  if (s.kind === "stock") return STOCK[s.st].color;
  return null;
}
function renderChips() {
  // the html() rebuild destroys a clicked chip — remember + restore keyboard focus
  const focusedStep = document.activeElement?.dataset?.step;
  const wrap = d3.select("#step-chips");
  wrap.html(STATE.steps.map((s, i) => {
    const c = chipColor(s);
    const dot = c ? `<span class="chip-dot" style="background:${c}"></span>` : "";
    const active = i === STATE.step ? " is-active" : "";
    const cur = i === STATE.step ? ' aria-current="step"' : "";
    return `<button class="chip${active}"${cur} data-step="${i}">${dot}${chipLabel(s)}</button>`;
  }).join(""));
  wrap.selectAll(".chip").on("click", function () {
    STATE.step = +this.getAttribute("data-step");
    renderStep();
  });
  if (focusedStep !== undefined) {
    const btn = wrap.select(`[data-step="${focusedStep}"]`).node();
    if (btn) btn.focus({ preventScroll: true });
  }
  // mobile: the chip row scrolls horizontally — keep the active chip visible
  const activeChip = wrap.select(".chip.is-active").node();
  if (activeChip && window.matchMedia("(max-width: 780px)").matches)
    activeChip.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
}

/* Shared stepper chrome: count + prev/next disabled state. Every lens's
   render*Step ends here, so chips / hash-sync / tooltip-hide have one seam. */
function updateStepNav() {
  hideTip();
  d3.select("#step-count").text(`${STATE.step + 1} / ${STATE.steps.length}`);
  d3.select("#prev").property("disabled", STATE.step === 0);
  d3.select("#next").property("disabled", STATE.step === STATE.steps.length - 1);
  renderChips();
  // Additive stepper→frame seam: if the current step declares a frame, drive the
  // map to it and sync the chips. No current step defines `frame`, so this is a
  // pure no-op for today's content — it's a forward hook for stepped-zoom stories.
  const step = STATE.steps[STATE.step];
  if (step && step.frame) { applyFrame(step.frame); syncFrameChips(); }
  syncHash();
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
  updateStepNav();
  draw();
}

// Single dispatcher — Tasks 14/15 add bridge/unique branches.
function renderStep() {
  if (STATE.lens === "terrain" && STATE.country !== "bridge") return renderTerrainStep();
  if (STATE.lens === "features" && STATE.country !== "bridge") return renderFeatureStep();
  if (STATE.country === "bridge" && STATE.lens === "unique") return renderBridgeUniqueStep();
  if (STATE.country === "bridge" && typeof renderBridgeStep === "function") return renderBridgeStep();
  if (STATE.lens === "unique" && typeof renderUniqueStep === "function")
    return (STATE.stockView && !STATE.stockDrill) ? renderStockStep() : renderUniqueStep();
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
  STATE.proj = proj;
  sizeCanvas();
  COORDS = buildCoordCache(all, proj);   // canvas glow + hit-test read these globals
  QUAD   = buildQuadtreeFromCache(all, COORDS);
  ensureViewport();             // helpers route through LAYER; bridge has no FRAMES (applyFrame no-ops)
  STATE.active = activePairs;   // drawGlowLayer lights points whose p[2] ∈ active
  drawBaseLayer(all, proj);
  drawGlowLayer(all);           // canvas glow; reuses STATE.active/colorById/titleById (set by loadBridge)
  applyFrame(STATE.frame || "whole");
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
  updateStepNav();
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
  STATE.proj = proj;
  ensureViewport();             // helpers route through LAYER; bridge has no FRAMES (applyFrame no-ops)
  // faint base of ALL settlements for honest density (both lands, unfiltered)
  const baseAll = (STATE.data.fi.points || []).concat(STATE.data.se.points || []);
  drawBaseLayer(baseAll, proj);
  // family-colored glow → canvas (was SVG g.glow-bru circles). Every point in `all`
  // is a confined dot and visible, so the quad needs no visibility gate.
  sizeCanvas();
  COORDS = buildCoordCache(all, proj);
  QUAD   = buildQuadtreeFromCache(all, COORDS);
  drawGlowCanvas(all, (p) => FAMILY[bridgeFamilyOf(p[2], p[3])].color);
  const bruTip = (p) => p[2] ? `${p[2]} · ${FAMILY[bridgeFamilyOf(p[2], p[3])].label}` : "";
  STATE.hitCtx = {
    points: all, quad: QUAD,
    tipText: bruTip,
    onTap: (p, e) => { const t = bruTip(p); if (t) showTip(t, e.clientX, e.clientY); },  // no inspector — pin only
  };
  applyFrame(STATE.frame || "whole");
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
    CTX.clearRect(0, 0, CV.width, CV.height);
    STATE.hitCtx = null;
  } else {
    body.html(`<div class="card"><p class="element">Two substrates, one shore</p>
      <p class="history">Cyan = Finnish/Sámi names inside Sweden's north. Sand = Swedish names inside Finland. The colors cross the border the languages did.</p>
      ${bruLegendHTML()}</div>`);
    drawBridgeUnique();
  }
  updateStepNav();
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
  STATE.terrain = await loadTerrain();
  STATE.data.provinces = dropForeignProvinces(STATE.data.provinces);
  STATE.titleById = new Map();  // confined dots carry their element id as tooltip text
  (u.points || []).forEach((p) => { if (p[2]) STATE.titleById.set(p[2], p[2]); });
  // The substrate lens defaults to the bold language-STOCK stepper; drilling into a
  // stock switches to the family-level stepper (renderUniqueStep).
  STATE.stockDrill = null;
  STATE.stockView = true;
  STATE.stockFilter = null;
  STATE.familyFilter = null; STATE.elementFilter = null;
  STATE.inspected = null; STATE.provinceShade = null; STATE.isolateFrag = null;
  STATE.step = 0;
  STATE.selectedProvince = null;
  buildStockSteps();
  renderStockStep();
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
  // Inspector value-ramp takes precedence while a fragment is inspected: each
  // matching province fills on a single-hue ramp (densest brightest); non-matches
  // drop to a faint outline with no fill. The normal hover/select path is suspended
  // so the ramp isn't fought by the grey-blue highlight.
  const shade = STATE.inspected ? STATE.provinceShade : null;
  let pg = LAYER.selectAll("g.provinces").data([0]);
  pg = pg.enter().append("g").attr("class", "provinces").merge(pg);
  pg.selectAll("path").data(provinces, (d) => d.id).join("path")
    .attr("d", (d) => path({ type: "Feature", geometry: d.geometry }))
    .attr("fill", (d) => shade
      ? (shade(d.name) == null ? "transparent" : "#22d3ff")
      : (d.name === selName ? "#34466e" : "transparent"))
    .attr("fill-opacity", (d) => shade
      ? (shade(d.name) ?? 0)
      : (d.name === selName ? 0.9 : 0))
    .attr("stroke", (d) => shade
      ? (shade(d.name) == null ? "#1c2944" : "#6f8fd8")
      : (d.name === selName ? "#6f8fd8" : "#243355"))
    .attr("stroke-width", (d) => shade
      ? (shade(d.name) == null ? 0.4 : 1.0)
      : (d.name === selName ? 1.4 : 0.5))
    .style("cursor", "pointer")
    .on("mouseenter", function (e, d) {
      if (shade || d.name === selName) return;
      d3.select(this).attr("fill", "#2a3a5e").attr("fill-opacity", 0.6);
    })
    .on("mouseleave", function (e, d) {
      if (shade || d.name === selName) return;
      d3.select(this).attr("fill", "transparent").attr("fill-opacity", 0);
    })
    .on("click", (e, d) => { if (opts.onClick) opts.onClick(d); });
  // the selected outline must not be half-covered by its neighbours' strokes
  pg.selectAll("path").filter((d) => d.name === selName).raise();
  // name the selection ON the map — the panel alone made the click feel unanswered
  let lg = LAYER.selectAll("g.prov-label").data([0]);
  lg = lg.enter().append("g").attr("class", "prov-label").merge(lg);
  const sel = provinces.find((d) => d.name === selName);
  lg.selectAll("text").data(sel ? [sel] : []).join("text")
    .attr("transform", (d) =>
      `translate(${path.centroid({ type: "Feature", geometry: d.geometry })})`)
    .text((d) => d.name);
  lg.raise(); // above the glow dots (provinces are drawn before the glow layer)
}

function drawUnique(focusName) {
  const node = SVG.node(), w = node.clientWidth || 800, h = node.clientHeight || 600;
  SVG.attr("viewBox", `0 0 ${w} ${h}`);
  const proj = projectionForGeo(STATE.data.provinces, w, h);
  STATE.proj = proj;            // applyFrame frames against the province-fitted projection
  ensureViewport();             // all layers below route through LAYER (the viewport group)

  drawTerrainLayer(STATE.terrain, proj);
  drawProvinceLayer(STATE.data.provinces, proj, {
    focusName: focusName,
    // A canvas dot tap (pointer-events:none) falls through to the province path
    // beneath it; SUPPRESS_PROVINCE_CLICK (set by the dot's hitCtx.onTap) swallows
    // that one province click so a dot tap inspects without also drilling the province.
    onClick: (d) => {
      if (SUPPRESS_PROVINCE_CLICK) { SUPPRESS_PROVINCE_CLICK = false; return; }
      STATE.selectedProvince = d; showProvincePanel(d); drawUnique(d.name);
    },
  });

  // confined points glow in family/stock colours — lit-sphere gradient core on the
  // canvas (consistent with the roots/bridge glow), NOT a blur filter.
  const ctry = STATE.country;                 // "vietnam" | "finland" | "sweden"
  let lit = STATE.data.points.filter((p) => {
    if (!p[2]) return false;
    if (STATE.elementFilter) return p[2] === STATE.elementFilter;
    if (STATE.stockView && STATE.stockFilter) return STATE.stockFilter.has(stockOf(p[2], ctry));
    if (STATE.familyFilter) return STATE.familyFilter.has(familyOf(p[2], ctry));
    return true;
  });
  // Inspector isolate: while a rare fragment is held, the SVG dimmed non-matching
  // dots to 0.12 opacity. Canvas screen-blend can't cheaply do per-dot alpha in one
  // pass, so we SKIP non-matching dots entirely — only the isolated sibling cluster
  // lights. This is an intentional behaviour change (skip vs dim) that preserves the
  // isolate intent; documented in the Task 5 report.
  if (STATE.isolateFrag) lit = lit.filter((p) => p[4] === STATE.isolateFrag);
  // color the SAME hue the gradient used: STOCK/FAMILY .color
  const colorForUniquePoint = (p) => STATE.stockView
    ? (STOCK[stockOf(p[2], ctry)] ?? STOCK.other).color
    : (FAMILY[familyOf(p[2], ctry)] ?? FAMILY.other).color;
  sizeCanvas();
  COORDS = buildCoordCache(lit, proj);
  QUAD   = buildQuadtreeFromCache(lit, COORDS);
  drawGlowCanvas(lit, colorForUniquePoint);
  // `lit` is already the visible set, so the quad needs no extra visibility gate.
  const uniqTip = (p) => p[2]
    ? (STATE.stockView
        ? `${p[2]} · ${(STOCK[stockOf(p[2], ctry)] ?? STOCK.other).label}`
        : `${p[2]} · ${(FAMILY[familyOf(p[2], ctry)] ?? FAMILY.other).label}`)
    : "";
  STATE.hitCtx = {
    points: lit, quad: QUAD,
    tipText: uniqTip,
    onTap: (p, e) => {
      const t = uniqTip(p); if (t) showTip(t, e.clientX, e.clientY);
      if (p[4]) inspectFragment(p[4], ctry);   // dot tap → inspect its rawFrag
    },
  };
  applyFrame(STATE.frame || "whole");
}

// which families actually appear in this country's confined set, as TAP-TO-ISOLATE chips
function familyLegendHTML(country) {
  const present = new Set((STATE.data.points || []).filter((p) => p[2]).map((p) => familyOf(p[2], country)));
  const order = ["highlands", "northern", "mekong", "sapmi", "swedish", "karelia",
                 "clearing", "danish", "norrland", "shieling", "westcoast", "gotland", "other"];
  const chips = order.filter((k) => present.has(k)).map((k) => {
    const on = STATE.familyFilter?.has(k) ? " is-on" : "";
    return `<button class="fam-chip${on}" data-fam="${k}"><span class="fam-dot" style="background:${FAMILY[k].color}"></span>${FAMILY[k].label}</button>`;
  }).join("");
  return `<div class="fam-legend">${chips}</div>`;
}
function provinceDrillHTML(d) {
  const els = d.elements.slice(0, 6).map((e) => {
    const c = familyColor(e.element, STATE.country);
    const on = STATE.elementFilter === e.element ? " is-on" : "";
    return `<li><button class="drill-el${on}" data-el="${e.element}">
      <span class="fam-dot" style="background:${c}"></span>
      <b style="color:${c}">${e.element}</b> · ${e.count}× · ${Math.round(e.pct * 100)}% here</button></li>`;
  }).join("");
  return `<ul class="drill">${els || "<li>none</li>"}</ul>`;
}

function showProvincePanel(d) {
  d3.select("#step-body").html(`<div class="card">
    <p class="element">${d.name}</p>
    <p class="gloss">${d.score} confined elements</p>
    ${provinceDrillHTML(d)}
    ${familyLegendHTML(STATE.country)}</div>`);
  CAPTION.html("");   // never duplicate into the bottom-left caption
  bindCardControls();
  syncHash();
}

function renderUniqueStep() {
  STATE.selectedProvince = null;  // stepping is authoritative — clears click state
  STATE.inspected = null; STATE.provinceShade = null; STATE.isolateFrag = null;
  STATE.elementFilter = null;
  if (STATE.stockDrill) STATE.stockView = false;  // drilled view colors by family
  const backBtn = STATE.stockDrill ? '<button class="back-stocks">‹ all stocks</button>' : "";
  const s = STATE.steps[STATE.step];
  const body = d3.select("#step-body");
  if (s.kind === "intro-unique") {
    STATE.familyFilter = null;
    CAPTION.html("");
    body.html(`<div class="card">${backBtn}<p class="element">Where names turn local</p>
      <p class="history">Brighter provinces hold more name-elements found almost nowhere else — dialect, substrate, another tongue. Each glowing dot is colored by the naming layer it belongs to. Step through the layers, or tap a legend chip to isolate one.</p>
      ${familyLegendHTML(STATE.country)}</div>`);
  } else if (s.kind === "family") {
    const f = FAMILY[s.f.fam];
    STATE.familyFilter = new Set([s.f.fam]);
    const st = familyStats(STATE.data.points, STATE.country, s.f.fam);
    CAPTION.text(f.label);
    body.html(`<div class="card" style="border-color:${f.color}55">${backBtn}
      <p class="element" style="color:${f.color}">${f.label}</p>
      <p class="gloss">${st.dots.toLocaleString()} places · ${st.els} name-elements</p>
      <p class="history">${FAMILY_HISTORY[s.f.fam] || ""}</p>
      ${familyLegendHTML(STATE.country)}</div>`);
  } else if (s.kind === "all-unique") {
    STATE.familyFilter = null;
    CAPTION.html("");
    body.html(`<div class="card">${backBtn}<p class="element">All the layers at once</p>
      <p class="history">Every confined name-element, colored by its naming layer. Tap a legend chip to isolate one layer.</p>
      ${familyLegendHTML(STATE.country)}</div>`);
  } else {
    STATE.familyFilter = null;
    CAPTION.html("");
    body.html(`<div class="card">${backBtn}<p class="element">Explore</p>
      <p class="history">Click any province to see which elements make it distinctive; tap a legend chip to isolate a layer.</p>
      ${familyLegendHTML(STATE.country)}</div>`);
  }
  bindCardControls();
  d3.select("#step-body").selectAll(".back-stocks").on("click", backToStocks);
  updateStepNav();
  drawUnique(null);
}
// one redraw seam for in-card controls (legend chips now; drill rows in Task 5)
function redrawUnique() { drawUnique(STATE.selectedProvince?.name ?? null); }
function bindCardControls() {
  const body = d3.select("#step-body");
  body.selectAll(".fam-chip").on("click", function () {
    const k = this.getAttribute("data-fam");
    if (!STATE.familyFilter) STATE.familyFilter = new Set([k]);
    else if (STATE.familyFilter.has(k)) {
      STATE.familyFilter.delete(k);
      if (!STATE.familyFilter.size) STATE.familyFilter = null;
    } else STATE.familyFilter.add(k);
    body.selectAll(".fam-chip").classed("is-on", function () {
      return !!STATE.familyFilter && STATE.familyFilter.has(this.getAttribute("data-fam"));
    });
    redrawUnique();
    syncHash();
  });
  body.selectAll(".drill-el").on("click", function () {
    const el = this.getAttribute("data-el");
    STATE.elementFilter = STATE.elementFilter === el ? null : el;
    body.selectAll(".drill-el").classed("is-on", function () {
      return this.getAttribute("data-el") === STATE.elementFilter;
    });
    redrawUnique();
  });
}

/* ---- language-stock view (Tasks 10-12): the default substrate stepper ------ */
// which stocks actually appear, as TAP-TO-ISOLATE chips
function stockLegendHTML(country) {
  const present = stocksPresent(STATE.data.points, country);
  const chips = present.map((k) => {
    const on = STATE.stockFilter?.has(k) ? " is-on" : "";
    return `<button class="stock-chip${on}" data-stock="${k}"><span class="fam-dot" style="background:${STOCK[k].color}"></span>${STOCK[k].label}</button>`;
  }).join("");
  return `<div class="fam-legend">${chips}</div>`;
}
function bindStockChips() {
  d3.select("#step-body").selectAll(".stock-chip").on("click", function () {
    const k = this.getAttribute("data-stock");
    if (!STATE.stockFilter) STATE.stockFilter = new Set();
    if (STATE.stockFilter.has(k)) STATE.stockFilter.delete(k); else STATE.stockFilter.add(k);
    if (!STATE.stockFilter.size) STATE.stockFilter = null;
    redrawUnique();
    d3.select("#step-body").selectAll(".stock-chip").classed("is-on", function () {
      return STATE.stockFilter?.has(this.getAttribute("data-stock"));
    });
    syncHash();
  });
}

function renderStockStep() {
  STATE.selectedProvince = null;
  STATE.inspected = null; STATE.provinceShade = null; STATE.isolateFrag = null;
  STATE.elementFilter = null;
  STATE.familyFilter = null;
  STATE.stockView = true;
  const s = STATE.steps[STATE.step];
  const body = d3.select("#step-body");
  if (s.kind === "intro-stock") {
    STATE.stockFilter = null;
    const pts = STATE.data.points;
    const named = pts.filter((p) => p[2] && stockOf(p[2], STATE.country) !== "other").length;
    CAPTION.html("");
    body.html(`<div class="card"><p class="element">Whose language?</p>
      <p class="history">Every place name was laid down by some tongue. We can name the language stock behind ${named.toLocaleString()} of these names; the rest still await curation. Step through the stocks, or tap a chip to isolate one.</p>
      ${stockLegendHTML(STATE.country)}</div>`);
  } else if (s.kind === "stock") {
    const st = STOCK[s.st];
    STATE.stockFilter = new Set([s.st]);
    CAPTION.text(st.label);
    body.html(`<div class="card" style="border-color:${st.color}55">
      <p class="element" style="color:${st.color}">${st.label}</p>
      <p class="history">${STOCK_HISTORY[s.st] || ""}</p>
      <button class="drill-into" data-stock="${s.st}">explore its dialects ›</button>
      ${stockLegendHTML(STATE.country)}</div>`);
  } else { // all-stock / explore-stock
    STATE.stockFilter = null;
    CAPTION.html("");
    body.html(`<div class="card"><p class="element">${s.kind === "all-stock" ? "All stocks at once" : "Explore"}</p>
      <p class="history">${s.kind === "all-stock" ? "Every named name-element, colored by the language stock behind it." : "Tap a chip to isolate a stock, click 'explore its dialects' to drill into one, or click a province."}</p>
      ${stockLegendHTML(STATE.country)}</div>`);
  }
  drawUnique();
  bindCardControls();
  bindStockChips();
  bindDrillInto();
  updateStepNav();
}

function bindDrillInto() {
  d3.select("#step-body").selectAll(".drill-into").on("click", function () {
    STATE.stockDrill = this.getAttribute("data-stock");
    STATE.stockView = false;
    STATE.stockFilter = null;   // drilled view colors by family; don't leak s: into the hash
    buildUniqueSteps();
    STATE.step = 0;
    renderUniqueStep();
  });
}
function backToStocks() {
  STATE.stockDrill = null;
  STATE.stockView = true;
  buildStockSteps();
  STATE.step = 0;
  renderStockStep();
}

/* ---- features lens (Task 8): "do names tell the truth?" --------------------
   A name keeps its promise when it sits on the feature its morpheme denotes
   (a -järvi ON a lake), and lies — a transplant/fossil — when it sits on the
   wrong feature class (a -mäki name on a settlement, not a hill). Each feature
   is colored by CATEGORICAL LIGHTNESS (truthful is true/false/null, not a value
   ramp): warm/bright = truthful, dim grey = transplant, faint neutral =
   uncurated (never invented). The lens rides Plan
   A's terrain + the stepped-zoom viewport. Step-1 ("truth") is built here;
   Task 9 will append a "spread" step — buildFeatureSteps leaves the seam. */

// morpheme id -> readable label for the inspector / copy (diacritics restored)
const MORPHEME_LABEL = {
  jarvi: "järvi", joki: "joki", maki: "mäki", vaara: "vaara",
  sjo: "sjö", berg: "berg", thuy: "thủy",
};
// morpheme id -> the natural-feature CLASS its word promises (mirrors the backend
// feature_types map). Used to phrase "expected vs actual" honestly.
const MORPHEME_EXPECTED = {
  jarvi: "water", joki: "river", maki: "hill", vaara: "hill",
  sjo: "water", berg: "peak", thuy: "water",
};
// feature_type / class -> readable phrase for the inspector
const FEATURE_LABEL = {
  water: "lake/water body", river: "river", peak: "peak", hill: "hill",
};
function morphemeLabel(id) { return MORPHEME_LABEL[id] || id || "—"; }
function featureLabel(t) { return FEATURE_LABEL[t] || t || "feature"; }

// VN (1 feature) or any tiny/empty country: the analysis genuinely doesn't apply.
function featuresInapplicable() {
  return STATE.country === "vietnam" || (STATE.features?.features?.length ?? 0) <= 1;
}
const VN_CAVEAT =
  "Vietnamese feature-names lead with topographic generics — Núi (mountain), " +
  "Hồ (lake), Sông (river) — which our administrative-morpheme set doesn't read. " +
  "The honest answer here is: we can't tell, and we won't pretend.";

// Terrain lens loader — "the land beneath the names". Fetches the three pieces it
// needs in PARALLEL: the physical terrain geometry (water/coast/river), the
// feature-names payload (Task 8, reused later), and the settlement payload (points
// + terrainMorphemes baked by Task 2). Each catches to null so a missing file
// degrades the view instead of crashing. This task renders ONLY the terrain
// geometry + an intro card; name-dots/toggles/full-stepper land in Tasks 5-6.
async function loadTerrainLens() {
  const base = FILES[STATE.country];                       // fi.json
  const [terrain, features, settle] = await Promise.all([
    d3.json(base.replace(".json", "-terrain.json")).catch(() => null),
    d3.json(base.replace(".json", "-features.json")).catch(() => null),
    d3.json(base).catch(() => null),
  ]);
  STATE.terrain  = terrain;                                // {water,coastline,river} or null
  STATE.features = features;                               // {features:[...], ...} or null
  STATE.data     = settle;                                 // {points:[...], terrainMorphemes:[...]} or null
  STATE.terrainLayers = { water: true, coast: true, river: true };  // toggle state (Task 5 uses)
  STATE.inspected = null; STATE.provinceShade = null; STATE.isolateFrag = null;
  STATE.selectedProvince = null;
  if (!STATE.data || !Array.isArray(STATE.data.points)) {
    d3.select("#step-body").html('<div class="card"><p class="history">No terrain data for this place yet.</p></div>');
    return;
  }
  // Name-dot color/title maps (Task 6): mirror the roots loader so terrainNameColorFn
  // + the name-dot tooltip ("element — gloss") can read STATE.colorById/titleById.
  if (Array.isArray(STATE.data.morphemes)) {
    respaceColors(STATE.data.morphemes);   // separable per-element hues (same as roots)
    STATE.colorById = new Map(STATE.data.morphemes.map((m) => [m.id, m.color]));
    STATE.titleById = new Map(STATE.data.morphemes.map((m) => [m.id, `${m.element} — ${m.gloss}`]));
  } else {
    STATE.colorById = new Map(); STATE.titleById = new Map();
  }
  STATE.step = 0;
  buildTerrainSteps();
  renderTerrainStep();
}

// Terrain stepper (Task 6): intro → water → names-hug-water → truth → explore.
function buildTerrainSteps() {
  STATE.steps = [
    { kind: "intro-terrain" },      // geometry faint, no dots
    { kind: "water" },              // geometry emphasized, no name-dots yet
    { kind: "names-hug-water" },    // name-dot overlay on the geometry
    { kind: "truth" },              // absorbed feature-truth coloring + inspector
    { kind: "explore-terrain" },    // everything on, toggles free
  ];
}

// Name-dot colorFn (Task 6): light a settlement dot only when its morpheme id is in
// the country's curated water/terrain set (STATE.data.terrainMorphemes), colored by
// the shared per-element hue. Everything else returns null (drawn dark).
function terrainNameColorFn() {
  const set = new Set(STATE.data.terrainMorphemes || []);
  const colorById = STATE.colorById;
  return (p) => (p[2] && set.has(p[2])) ? colorById.get(p[2]) : null;
}

// Layer-toggle chips (Water / Coastline / Rivers). data-layer keys match
// STATE.terrainLayers (water/coast/river); the geometry object keys differ
// (water/coastline/river) — drawTerrainLayerFiltered does the mapping. Swatch
// colors are brighter representatives than the faint fill/stroke (tr-water is
// near-black) so the chip is legible.
const TERRAIN_TOGGLES = [
  { key: "water", label: "Water",     swatch: "#3a6df0" },
  { key: "coast", label: "Coastline", swatch: "#6f8fd8" },
  { key: "river", label: "Rivers",    swatch: "#2f4a6b" },
];
function terrainTogglesHTML() {
  const vis = STATE.terrainLayers || { water: true, coast: true, river: true };
  const chips = TERRAIN_TOGGLES.map((t) => {
    const off = vis[t.key] ? "" : " is-off";
    return `<button class="terrain-toggle${off}" data-layer="${t.key}"><span class="fam-dot" style="background:${t.swatch}"></span>${t.label}</button>`;
  }).join("");
  return `<div class="terrain-toggles">${chips}</div>`;
}

// Filtered terrain draw: hand drawTerrainLayer an empty array for any layer the
// user has toggled off, mapping the toggle keys (water/coast/river) onto the
// geometry keys (water/coastline/river).
function drawTerrainLayerFiltered(terrain, proj) {
  const vis = STATE.terrainLayers || { water: true, coast: true, river: true };
  drawTerrainLayer({
    water:     vis.water ? terrain.water : [],
    coastline: vis.coast ? terrain.coastline : [],
    river:     vis.river ? terrain.river : [],
  }, proj);
}

// Flip a layer's visibility, dim its chip, redraw the map only (no card rebuild
// — that would reset chip focus). Mirrors how the unique chips redraw without
// re-rendering the card.
function bindTerrainToggles() {
  const body = d3.select("#step-body");
  body.selectAll(".terrain-toggle").on("click", function () {
    const k = this.getAttribute("data-layer");
    if (!STATE.terrainLayers) STATE.terrainLayers = { water: true, coast: true, river: true };
    STATE.terrainLayers[k] = !STATE.terrainLayers[k];
    body.selectAll(".terrain-toggle").classed("is-off", function () {
      return !STATE.terrainLayers[this.getAttribute("data-layer")];
    });
    drawTerrainLens();   // re-runs drawTerrainLayerFiltered with the new visibility
  });
}

// 5-step terrain render (Task 6): switch on the active step kind, write a per-step
// card + drive the map. intro/water/explore + names-hug-water show the SVG geometry
// (toggle chips bound); names-hug-water + explore overlay the curated name-dots; the
// truth step absorbs the feature-truth render (drawFeatures + inspectFeature). Mirrors
// renderFeatureStep: ends with updateStepNav. VN keeps the honest-null truth copy.
function renderTerrainStep() {
  STATE.selectedProvince = null; STATE.inspected = null;
  STATE.provinceShade = null; STATE.isolateFrag = null;
  const s = STATE.steps[STATE.step];
  const body = d3.select("#step-body");
  CAPTION.html("");
  if (s.kind === "intro-terrain") {
    body.html(`<div class="card">
      <p class="element">The land beneath the names</p>
      <p class="history">Strip away the names and look at the ground itself — the water, the coast, the rivers the place-names will turn out to sit on.</p>
      ${terrainTogglesHTML()}</div>`);
    bindTerrainToggles();
    drawTerrainLens(false);
  } else if (s.kind === "water") {
    body.html(`<div class="card">
      <p class="element">Where the water is</p>
      <p class="history">Lakes, the coastline, and the rivers — the wet geometry of this place. Toggle each layer to see how much of the land is shaped by water.</p>
      ${terrainTogglesHTML()}</div>`);
    bindTerrainToggles();
    drawTerrainLens(false);
  } else if (s.kind === "names-hug-water") {
    body.html(`<div class="card">
      <p class="element">Names that hug the water</p>
      <p class="history">Now light up only the settlements whose names carry a water- or terrain-word. Watch them cluster along the lakes, the coast and the rivers — the names remember the ground.</p>
      <p class="gloss">Hover a lit dot to read its word; tap to pin it.</p>
      ${terrainTogglesHTML()}</div>`);
    bindTerrainToggles();
    drawTerrainLens(true);
  } else if (s.kind === "truth") {
    const inapplicable = featuresInapplicable();
    if (inapplicable) {
      body.html(`<div class="card"><p class="element">The honest null</p>
        <p class="history">${VN_CAVEAT}</p>
        <p class="gloss">${(STATE.features?.features?.length ?? 0)} feature${
          (STATE.features?.features?.length ?? 0) === 1 ? "" : "s"} matched — too few to judge.</p></div>`);
    } else {
      body.html(`<div class="card"><p class="element">Does the name tell the truth?</p>
        <p class="history">Each dot is a named feature. <span class="f-key f-true-key">Bright</span> = the name sits on the feature it promises. <span class="f-key f-transplant-key">Dim</span> = a transplant: the word means one thing, the ground is another.</p>
        <div class="label">Truth rate by name-word</div>
        <div class="dens">${truthRateRows()}</div>
        <p class="gloss">Tap a dot to read its verdict.</p></div>`);
    }
    drawFeatures();   // re-fits to features + draws feature-truth dots + sets the feature hitCtx
  } else { // explore-terrain
    body.html(`<div class="card">
      <p class="element">Explore the ground</p>
      <p class="history">Geometry and the water/terrain name-dots together. Toggle the layers freely; hover or tap a lit dot to read its word.</p>
      ${terrainTogglesHTML()}</div>`);
    bindTerrainToggles();
    drawTerrainLens(true);
  }
  updateStepNav();
}

// Map render for the terrain lens. Mirrors draw()'s setup (viewBox, projection fit to
// the settlement points, viewport, canvas cache), draws the water/coast/river SVG
// geometry honoring the toggles. When withNameDots, overlay the curated name-dots on
// the canvas + set their hit-test context (hover = "element — gloss", tap = pin);
// otherwise clear the canvas (no stale dots). COORDS/QUAD index ALL settlement points;
// the hit is gated to the curated set via isVisible (mirrors the roots path).
function drawTerrainLens(withNameDots) {
  const node = SVG.node();
  const w = node.clientWidth || 800;
  const h = node.clientHeight || 600;
  SVG.attr("viewBox", `0 0 ${w} ${h}`);
  const proj = projectionFor(STATE.country, STATE.data.points, w, h);
  STATE.proj = proj;
  ensureViewport();
  LAYER.selectAll("g.spread").remove();   // clear any feature-spread ring/echoes from the truth step
  sizeCanvas();
  COORDS = buildCoordCache(STATE.data.points, proj);
  QUAD   = buildQuadtreeFromCache(STATE.data.points, COORDS);
  if (STATE.terrain) drawTerrainLayerFiltered(STATE.terrain, proj);  // honors toggle visibility
  else drawTerrainLayer(null, proj);                                 // null -> early-return (clears geometry)
  if (withNameDots) {
    drawGlowCanvas(STATE.data.points, terrainNameColorFn());
    const set = new Set(STATE.data.terrainMorphemes || []);
    STATE.hitCtx = {
      points: STATE.data.points, quad: QUAD,
      isVisible: (p) => !!(p && p[2] && set.has(p[2])),
      tipText: (p) => (p && p[2] && set.has(p[2])) ? STATE.titleById?.get(p[2]) : undefined,
      onTap: (p, e) => { const t = (p && p[2]) ? STATE.titleById?.get(p[2]) : undefined; if (t) showTip(t, e.clientX, e.clientY); },
    };
  } else {
    CTX.clearRect(0, 0, CV.width, CV.height);  // no name-dots on intro/water
    STATE.hitCtx = null;
  }
  applyFrame(STATE.frame || "whole");
}

async function loadFeatures() {
  STATE.features = await d3.json(FILES[STATE.country + "-features"]).catch(() => null);
  if (!STATE.features) STATE.features = { features: [], truthByMorpheme: {} };
  if (!Array.isArray(STATE.features.features)) STATE.features.features = [];
  STATE.terrain = await loadTerrain();   // ride Plan A's terrain + zoom
  STATE.inspected = null; STATE.provinceShade = null; STATE.isolateFrag = null;
  STATE.selectedProvince = null;
  buildFeatureSteps();
  STATE.step = 0;
  renderFeatureStep();
}

// stepper: intro → truth (per-feature payoff) → intro-spread → spread (Task 9).
// House rule: an intro step precedes each data step. Spread is the HONEST,
// modest secondary layer — the per-feature truth view stays the primary payoff.
function buildFeatureSteps() {
  STATE.steps = [
    { kind: "intro-features" }, { kind: "truth" },
    { kind: "intro-spread" }, { kind: "spread" },
  ];
}


// feature glow colored by CATEGORICAL hue (warm=truthful, dim grey=transplant,
// faint=uncurated — truthful is true/false/null, not a value ramp), drawn on the
// canvas ABOVE terrain (the spread ring/echo stay SVG; see showSpread). All feature
// dots are visible, so the quad needs no visibility gate.
function featureColor(d) {
  return d.truthful === true ? "#ffd27a"   // f-true:       warm/bright
       : d.truthful === false ? "#5b6680"  // f-transplant: dim grey
       : "#39414f";                        // f-unknown:    faint neutral (never invented)
}
function drawFeatureLayer(features, proj) {
  const feats = features || [];
  sizeCanvas();
  COORDS = buildCoordCacheXY(feats, (d) => [d.lon, d.lat], proj);
  QUAD   = buildQuadtreeFromCache(feats, COORDS);
  drawGlowCanvas(feats, featureColor);   // guards an empty/one-feature list internally
  const featTip = (d) =>
    `${d.name} · -${morphemeLabel(d.morpheme)} · ${
      d.truthful === true ? "truthful" : d.truthful === false ? "transplant" : "uncurated"}`;
  STATE.hitCtx = {
    points: feats, quad: QUAD,
    tipText: featTip,
    // Click meaning is gated by the current step kind: on the "spread" step a tap
    // opens the radius/echo view (showSpread); everywhere else the truth verdict.
    onTap: (d, e) => {
      const t = featTip(d); if (t) showTip(t, e.clientX, e.clientY);
      if (STATE.steps[STATE.step]?.kind === "spread") showSpread(d);
      else inspectFeature(d);
    },
  };
}

// Project the planar radius (radiusDeg, in degrees) into screen pixels using the
// active projection: project the center and a point offset by radiusDeg, measure
// the pixel distance. radiusDeg is degree-space so this is the robust way.
function radiusPx(lon, lat, proj) {
  const deg = STATE.features?.radiusDeg ?? 0.1;
  const c = proj([lon, lat]);
  const e = proj([lon + deg, lat]);
  const n = proj([lon, lat + deg]);
  // average the lon- and lat-offset pixel distances (Mercator stretches lon vs lat)
  const dx = Math.hypot(e[0] - c[0], e[1] - c[1]);
  const dy = Math.hypot(n[0] - c[0], n[1] - c[1]);
  return (dx + dy) / 2;
}

// Spread view for one feature: a radius ring + lit echoing settlements, in a
// dedicated g.spread group inside the viewport (so it rides zoom + clears between
// selections). Non-echoing nearby towns are NOT drawn (their coords aren't baked) —
// they're represented honestly by the count in the panel.
function showSpread(feature) {
  if (!feature) return;
  const proj = STATE.proj;
  let g = LAYER.selectAll("g.spread").data([0]);
  g = g.enter().append("g").attr("class", "spread").merge(g);
  g.selectAll("*").remove();   // clear the prior selection's ring/echoes

  const [cx, cy] = proj([feature.lon, feature.lat]);
  const r = radiusPx(feature.lon, feature.lat, proj);
  g.append("circle").attr("class", "spread-ring")
    .attr("cx", cx).attr("cy", cy).attr("r", r);
  // g.spread is cleared just above (selectAll("*").remove()), so a plain
  // .enter().append() — no keyed join / exit — is safe here.
  g.selectAll("circle.s-echo").data(feature.echo || []).enter().append("circle")
    .attr("class", "s-echo")
    .attr("cx", (p) => proj([p[0], p[1]])[0])
    .attr("cy", (p) => proj([p[0], p[1]])[1])
    .attr("r", 2.5);

  const morph = morphemeLabel(feature.morpheme);
  const N = feature.nearby ?? 0, E = feature.echoing ?? 0;
  let lead;
  if (N === 0) lead = `No towns within ~11 km — nothing to echo here.`;
  else if (E === 0) lead = `None of the <b>${N}</b> nearby towns echo this name — the name stayed put.`;
  else lead = `<b>${E}</b> of <b>${N}</b> nearby towns echo this name.`;
  panelHTML(`
    <div class="insp">
      <div class="label">Does the name spread?</div>
      <h3 class="insp-frag" style="color:#ffd27a">${feature.name}</h3>
      <p class="insp-lead"><b>-${morph}</b> · ${lead}</p>
      <p class="insp-theory">A truthful name rarely floods the towns around it. Across this country the echo is faint — most names stay where they are.</p>
      <button class="insp-back">‹ back to the story</button>
    </div>`);
  CAPTION.html("");
  d3.select("#step-body").selectAll(".insp-back").on("click", () => {
    renderStep();   // route to the ACTIVE lens's current step (features OR terrain truth)
  });
}

function drawFeatures() {
  const node = SVG.node(), w = node.clientWidth || 800, h = node.clientHeight || 600;
  SVG.attr("viewBox", `0 0 ${w} ${h}`);
  const feats = STATE.features?.features || [];
  // features carry {lon,lat}; projectionFor wants [lon,lat,...] tuples. Fall back
  // to the country's whole-frame bbox when there's nothing (or one point) to fit.
  let proj;
  if (feats.length >= 2) {
    proj = projectionFor(STATE.country, feats.map((d) => [d.lon, d.lat]), w, h);
  } else {
    const fb = (FRAMES[STATE.country] && FRAMES[STATE.country].region) || [[100, 8], [110, 24]];
    proj = d3.geoMercator().fitExtent([[12, 16], [w - 12, h - 16]],
      { type: "FeatureCollection", features: [{ type: "Feature",
        geometry: { type: "LineString", coordinates: fb } }] });
  }
  STATE.proj = proj;
  ensureViewport();
  LAYER.selectAll("g.spread").remove();   // a fresh draw clears any prior spread ring/echoes
  drawTerrainLayer(STATE.terrain, proj);
  drawFeatureLayer(feats, proj);
  applyFrame(STATE.frame || "whole");
}

// honest, sorted-desc list of per-morpheme truth rates for the truth-step card
function truthRateRows() {
  const tbm = STATE.features?.truthByMorpheme || {};
  const rows = Object.entries(tbm).sort((a, b) => b[1] - a[1]);
  return rows.map(([id, frac]) => {
    const pct = Math.round(frac * 1000) / 10;
    const verdict = frac >= 0.5 ? "keeps its promise" : "a fossil/transplant";
    return `<div class="dens-row" title="-${morphemeLabel(id)}: ${verdict} (${pct}%)"><span>-${morphemeLabel(id)}</span>
       <span class="dens-bar" style="width:${Math.max(2, Math.round(frac * 100))}%"></span>
       <span class="dens-n">${pct}%</span></div>`;
  }).join("") + (rows.length
    ? `<p class="gloss">Bright = the word keeps its promise; dim = a fossil carried onto the wrong feature.</p>`
    : "");
}

function renderFeatureStep() {
  STATE.selectedProvince = null;
  STATE.inspected = null; STATE.provinceShade = null; STATE.isolateFrag = null;
  const s = STATE.steps[STATE.step];
  const body = d3.select("#step-body");
  const inapplicable = featuresInapplicable();
  if (s.kind === "intro-features") {
    CAPTION.html("");
    if (inapplicable) {
      body.html(`<div class="card"><p class="element">Do names tell the truth?</p>
        <p class="history">A feature-name keeps its promise when it sits on the very thing its word means — a <b>-järvi</b> on a lake, a <b>-joki</b> on a river. When it doesn't, the name is a fossil carried onto the wrong ground.</p>
        <p class="history"><b>Not here, though.</b> ${VN_CAVEAT}</p></div>`);
    } else {
      body.html(`<div class="card"><p class="element">Do names tell the truth?</p>
        <p class="history">A feature-name keeps its promise when it sits on the very thing its word means — a <b>-järvi</b> on a lake, a <b>-joki</b> on a river. When it sits on the wrong feature type, the name is a transplant: a fossil carried onto a settlement or a hill it doesn't match.</p>
        <p class="history">Step forward to see which words tell the truth — and which only remember it.</p></div>`);
    }
  } else if (s.kind === "truth") {
    CAPTION.html("");
    if (inapplicable) {
      body.html(`<div class="card"><p class="element">The honest null</p>
        <p class="history">${VN_CAVEAT}</p>
        <p class="gloss">${(STATE.features?.features?.length ?? 0)} feature${
          (STATE.features?.features?.length ?? 0) === 1 ? "" : "s"} matched — too few to judge.</p></div>`);
    } else {
      body.html(`<div class="card"><p class="element">The name on the ground</p>
        <p class="history">Each dot is a named feature. <span class="f-key f-true-key">Bright</span> = the name sits on the feature it promises. <span class="f-key f-transplant-key">Dim</span> = a transplant: the word means one thing, the ground is another.</p>
        <div class="label">Truth rate by name-word</div>
        <div class="dens">${truthRateRows()}</div>
        <p class="gloss">Tap a dot to read its verdict.</p></div>`);
    }
  } else if (s.kind === "intro-spread") {
    CAPTION.html("");
    if (inapplicable) {
      body.html(`<div class="card"><p class="element">Does a truthful name spread?</p>
        <p class="history">The next question: when a name truly sits on its feature, do the towns nearby borrow the same word?</p>
        <p class="history"><b>Not here, though.</b> ${VN_CAVEAT}</p></div>`);
    } else {
      body.html(`<div class="card"><p class="element">Does a truthful name spread?</p>
        <p class="history">When a name truly sits on its feature, do the towns around it borrow the same word? You might expect a strong lake-name to seed lake-named villages.</p>
        <p class="history"><b>Mostly, no.</b> The echo is weak almost everywhere — most names stay put. This is a modest, honest layer under the per-feature truth above, not a sweeping pattern.</p></div>`);
    }
  } else { // spread (the interactive data step)
    CAPTION.html("");
    if (inapplicable) {
      body.html(`<div class="card"><p class="element">Nothing to spread</p>
        <p class="history">${VN_CAVEAT}</p>
        <p class="gloss">The spread question is moot when the truth question already doesn't apply.</p></div>`);
    } else {
      body.html(`<div class="card"><p class="element">Tap a name to test its echo</p>
        <p class="history">Click any dot to draw a ~11 km ring around it and light up the nearby towns that echo its name-word. Most rings come up nearly empty — a truthful name rarely floods the towns around it.</p>
        <p class="gloss"><span class="f-key" style="background:#ffd27a"></span> = a town that echoes the name.</p></div>`);
    }
  }
  drawFeatures();
  updateStepNav();
}

// Name Inspector for a single feature: name, morpheme, expected vs actual, verdict.
function inspectFeature(d) {
  if (!d) return;
  const morph = morphemeLabel(d.morpheme);
  const actual = featureLabel(d.feature_type);
  const expected = featureLabel(MORPHEME_EXPECTED[d.morpheme]);
  let label, verdict, color;
  if (d.truthful === true) {
    label = "The name tells the truth";
    color = "#ffd27a";
    verdict = `This <b>-${morph}</b> name sits on the ${actual} it promises. The name tells the truth.`;
  } else if (d.truthful === false) {
    label = "A transplanted name";
    color = "#9aa3b2";
    verdict = `This <b>-${morph}</b> name sits on a ${actual}, not the ${expected} its word means — a transplanted, fossil name.`;
  } else {
    label = "Uncurated";
    color = "#7f8aa3";
    verdict = `Uncurated element — we don't guess.`;
  }
  panelHTML(`
    <div class="insp">
      <div class="label">${label}</div>
      <h3 class="insp-frag" style="color:${color}">${d.name}</h3>
      <p class="insp-lead"><b>-${morph}</b> · on a <b>${actual}</b></p>
      <p class="insp-theory">${verdict}</p>
      <button class="insp-back">‹ back to the story</button>
    </div>`);
  CAPTION.html("");
  d3.select("#step-body").selectAll(".insp-back").on("click", () => {
    renderStep();   // route to the ACTIVE lens's current step (features OR terrain truth)
  });
}

/* ---- v2 two-axis nav: render tabs + lens toggle from WORLDS[STATE.world] --- */
function renderSubnav() {
  const w = WORLDS[STATE.world];
  const tabs = d3.select("#country-tabs");
  tabs.html(w.tabs.map((t) =>
    `<button class="tab ${t.country === STATE.country ? "is-active" : ""}" data-country="${t.country}">${t.label}</button>`).join(""));
  // a single lonely tab (Vietnam world) is dead chrome — hide the row
  tabs.style("display", w.tabs.length > 1 ? "flex" : "none");
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

// Frame-bar: click a preset to animate the viewport (stepped semantic zoom).
document.querySelectorAll("#frame-bar .frame-chip").forEach((b) =>
  b.addEventListener("click", () => {
    applyFrame(b.dataset.frame);   // sets STATE.frame
    syncFrameChips();              // single source of truth for chip is-active + aria-pressed
  }));

// Arrow keys drive the stepper — the page is 90% "press next". Disabled
// buttons no-op on .click(), so bounds need no re-check here.
window.addEventListener("keydown", (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.key === "ArrowRight") d3.select("#next").node().click();
  else if (e.key === "ArrowLeft") d3.select("#prev").node().click();
});

// Swipe left/right pages the stepper on touch screens. Decisively horizontal
// only (|dx| > 48px and > 2|dy|), and never when the gesture starts on a
// chip row, button, or province path (those have their own tap meanings).
let swipeX = null, swipeY = null;
const storyEl = document.querySelector("main.story");
storyEl.addEventListener("touchstart", (e) => {
  if (e.touches.length > 1) { swipeX = null; return; }  // multi-touch: kill tracking
  if (e.target.closest(".step-chips, button, .provinces path")) { swipeX = null; return; }
  swipeX = e.touches[0].clientX; swipeY = e.touches[0].clientY;
}, { passive: true });
storyEl.addEventListener("touchend", (e) => {
  if (swipeX === null) return;
  const dx = e.changedTouches[0].clientX - swipeX;
  const dy = e.changedTouches[0].clientY - swipeY;
  swipeX = null;
  if (Math.abs(dx) > 48 && Math.abs(dx) > 2 * Math.abs(dy))
    d3.select(dx < 0 ? "#next" : "#prev").node().click();
}, { passive: true });
storyEl.addEventListener("touchcancel", () => { swipeX = null; }, { passive: true });

/* ---- boot ----------------------------------------------------------------- */
(async () => {
  const restore = parseHash();   // mutates STATE.world/country/lens if hash is valid
  d3.selectAll(".world").classed("is-active", function () {
    return this.getAttribute("data-world") === STATE.world;
  });
  renderSubnav();
  await loadCurrent();
  if (restore && STATE.steps.length) {
    STATE.step = Math.min(restore.step, STATE.steps.length - 1);
    renderStep();
    if (restore.prov) {
      // bridge-unique has STATE.data = {fi, se} (no .provinces) — the || [] guards it
      const provs = STATE.lens === "unique" ? STATE.data.provinces : STATE.rootsProvinces;
      const d = (provs || []).find((p) => p.id === restore.prov);
      if (d) {
        STATE.selectedProvince = d;
        showProvincePanel(d);
        if (STATE.lens === "unique") drawUnique(d.name); else draw();
      }
    }
    if (restore.fams?.length && STATE.lens === "unique" && STATE.country !== "bridge" && !STATE.stockView) {
      STATE.familyFilter = new Set(restore.fams);
      d3.select("#step-body").selectAll(".fam-chip").classed("is-on", function () {
        return STATE.familyFilter.has(this.getAttribute("data-fam"));
      });
      redrawUnique();
    }
    if (restore.stocks?.length && STATE.lens === "unique" && STATE.country !== "bridge" && STATE.stockView) {
      STATE.stockFilter = new Set(restore.stocks);
      d3.select("#step-body").selectAll(".stock-chip").classed("is-on", function () {
        return STATE.stockFilter.has(this.getAttribute("data-stock"));
      });
      redrawUnique();
    }
  }
  BOOTING = false;
  syncHash(); // write the settled boot state once
})();
let _resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    DPR = window.devicePixelRatio || 1;
    if (STATE.data) renderStep();   // re-run the active per-lens render (rebuilds COORDS+QUAD)
  }, 150);
});
