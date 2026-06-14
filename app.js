/* Fossils in the Map — FI/SE/VN place-name morpheme story.
   Vanilla D3 v7. One SVG, swapped per world/tab/lens. Glow-bloom point layer
   driven by a click-stepper across three lenses: roots (common name-elements),
   bridge (SE↔FI concept pairs), and unique-by-province (on-demand province affordance + glow). */
const SVG = d3.select("#map");
const CAPTION = d3.select("#map-caption");

/* ---- tooltip: one shared cursor-following div ------------------------------ */
const TIP = d3.select("body").append("div").attr("class", "tip");
function showTip(text, x, y) {
  if (!text) return hideTip();
  TIP.text(text).style("display", "block")
    .style("left", Math.min(x + 14, window.innerWidth - 220) + "px")
    .style("top", Math.min(y + 14, window.innerHeight - 60) + "px");
}
function hideTip() { TIP.style("display", "none"); }
// hover follows the cursor; pointerdown pins it so touch users get it too
function bindTip(sel, textOf) {
  sel.on("pointermove.tip", (e, p) => showTip(textOf(p), e.clientX, e.clientY))
     .on("pointerdown.tip", (e, p) => showTip(textOf(p), e.clientX, e.clientY))
     .on("pointerleave.tip", () => hideTip());
}
// tapping anything that isn't a dot dismisses a pinned tooltip
d3.select(document).on("pointerdown.tipdismiss", (e) => {
  if (e.target.tagName !== "circle") hideTip();
});

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

// RARE: isolate the confined province + its sibling cluster; the glow layer dims
// every dot whose rawFrag !== the inspected one (handled in drawUnique).
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
  let base = LAYER.selectAll("g.base").data([0]);
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
  let glow = LAYER.selectAll("g.glow").data([0]);
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

  // Tooltip text comes from STATE.titleById (each lens's loader fills it:
  // roots = "element — gloss", bridge = "sv ↔ fi · gloss").
  const titleFor = (p) => STATE.titleById?.get(p[2]) ?? "";
  glow.selectAll("circle").data(lit, (p) => p[0] + ":" + p[1]).join(
    (enter) => {
      const c = enter.append("circle")
        .attr("cx", (p) => proj([p[0], p[1]])[0])
        .attr("cy", (p) => proj([p[0], p[1]])[1])
        .attr("r", 0)
        .attr("fill", (p) => `url(#g-${p[2]})`);
      c.call((e) => e.transition().duration(450).attr("r", R_GLOW + 1.5));
      return c;
    },
    (update) => {
      update
        .attr("fill", (p) => `url(#g-${p[2]})`)
        .attr("cx", (p) => proj([p[0], p[1]])[0])
        .attr("cy", (p) => proj([p[0], p[1]])[1])
        .attr("r", R_GLOW + 1.5);
      return update;
    },
    (exit) => exit.on(".tip", null).call((e) => e.transition().duration(250).attr("r", 0).remove())
  );
  bindTip(glow.selectAll("circle"), titleFor);
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
  ensureViewport();             // all layers below route through LAYER (the viewport group)
  drawTerrainLayer(STATE.terrain, proj);
  drawBaseLayer(STATE.data.points, proj);
  if (STATE.rootsProvinces) {
    drawProvinceLayer(STATE.rootsProvinces, proj, {
      onClick: (d) => { STATE.selectedProvince = d; showProvincePanel(d); draw(); },
    });
  }
  drawGlowLayer(STATE.data.points, proj);
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
  // Switching world/tab/lens swaps the whole view: drop every data layer (g.base,
  // g.glow, g.provinces, g.glow-unique) so no ghost layer from the prior renderer
  // survives under/over the new one. Keep <defs> (gradients) intact.
  SVG.selectAll("g").remove();
  STATE.rootsProvinces = null;  // cleared on every (re)load; only the roots branch repopulates it
  STATE.selectedProvince = null;
  STATE.inspected = null; STATE.provinceShade = null; STATE.isolateFrag = null;
  STATE.terrain = null;  // bridge has none; roots/unique branches refetch per country
  STATE.frame = "whole"; // a fresh country/lens always opens un-zoomed
  syncFrameChips();
  d3.select("#step-body").html('<div class="card"><p class="history">Loading…</p></div>');
  try {
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
  STATE.lens = seg[2] === "unique" ? "unique" : "roots";
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
    case "all": case "all-bridge": case "all-unique": case "all-stock": return "all";
    case "explore": case "explore-unique": case "explore-stock": case "show-bru": return "explore";
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
  ensureViewport();             // helpers route through LAYER; bridge has no FRAMES (applyFrame no-ops)
  STATE.active = activePairs;   // drawGlowLayer lights points whose p[2] ∈ active
  drawBaseLayer(all, proj);
  drawGlowLayer(all, proj);
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
  // family-colored glow
  const defs = ensureDefs();
  Object.entries(FAMILY).forEach(([k, f]) => ensureGradient(defs, "fam-" + k, f.color));
  let glow = LAYER.selectAll("g.glow-bru").data([0]);
  glow = glow.enter().append("g").attr("class", "glow-bru").style("isolation", "isolate").merge(glow);
  glow.selectAll("circle").data(all, (p) => p[0] + ":" + p[1]).join((enter) => {
    const c = enter.append("circle")
      .attr("cx", (p) => proj([p[0], p[1]])[0]).attr("cy", (p) => proj([p[0], p[1]])[1])
      .attr("r", 2.6).attr("fill", (p) => `url(#g-fam-${bridgeFamilyOf(p[2], p[3])})`);
    return c;
  }, (update) => {
    update.attr("cx", (p) => proj([p[0], p[1]])[0]).attr("cy", (p) => proj([p[0], p[1]])[1])
      .attr("fill", (p) => `url(#g-fam-${bridgeFamilyOf(p[2], p[3])})`);
    return update;
  });
  bindTip(glow.selectAll("circle"),
    (p) => p[2] ? `${p[2]} · ${FAMILY[bridgeFamilyOf(p[2], p[3])].label}` : "");
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
    onClick: (d) => { STATE.selectedProvince = d; showProvincePanel(d); drawUnique(d.name); },
  });

  // confined points glow in family colours (highlands amber, northern teal, mekong
  // rose, sámi cyan, swedish sand, other grey) — lit-sphere gradient core
  // (consistent with the roots/bridge glow), NOT a blur filter.
  const defs = ensureDefs();
  Object.entries(FAMILY).forEach(([k, f]) => ensureGradient(defs, "fam-" + k, f.color));
  Object.entries(STOCK).forEach(([k, s]) => ensureGradient(defs, "stock-" + k, s.color));
  const ctry = STATE.country;                 // "vietnam" | "finland" | "sweden"
  const lit = STATE.data.points.filter((p) => {
    if (!p[2]) return false;
    if (STATE.elementFilter) return p[2] === STATE.elementFilter;
    if (STATE.stockView && STATE.stockFilter) return STATE.stockFilter.has(stockOf(p[2], ctry));
    if (STATE.familyFilter) return STATE.familyFilter.has(familyOf(p[2], ctry));
    return true;
  });
  let glow = LAYER.selectAll("g.glow-unique").data([0]);
  glow = glow.enter().append("g").attr("class", "glow-unique").style("isolation", "isolate").merge(glow);
  const fillFor = (p) => STATE.stockView
    ? `url(#g-stock-${stockOf(p[2], ctry)})`
    : `url(#g-fam-${familyOf(p[2], ctry)})`;
  // Inspector isolate: while a rare fragment is held, dots whose rawFrag (p[4])
  // isn't the inspected one fade right back so the sibling cluster stands out.
  const dotOpacity = (p) => STATE.isolateFrag ? (p[4] === STATE.isolateFrag ? 1 : 0.12) : 1;
  glow.selectAll("circle").data(lit, (p) => p[0] + ":" + p[1]).join((enter) => {
    const c = enter.append("circle")
      .attr("cx", (p) => proj([p[0], p[1]])[0])
      .attr("cy", (p) => proj([p[0], p[1]])[1])
      .attr("r", 2.6)
      .attr("fill", fillFor)
      .attr("fill-opacity", dotOpacity);
    return c;
  }, (update) => {
    update.attr("cx", (p) => proj([p[0], p[1]])[0]).attr("cy", (p) => proj([p[0], p[1]])[1])
      .attr("fill", fillFor)
      .attr("fill-opacity", dotOpacity);
    return update;
  });
  bindTip(glow.selectAll("circle"), (p) => p[2]
    ? (STATE.stockView
        ? `${p[2]} · ${STOCK[stockOf(p[2], ctry)].label}`
        : `${p[2]} · ${FAMILY[familyOf(p[2], ctry)].label}`)
    : "");
  // Click a glow dot → inspect its rawFrag (p[4]). Added ALONGSIDE bindTip so the
  // existing cursor-tooltip / tap behaviour stays intact; stopPropagation keeps the
  // click from falling through to a province click underneath.
  glow.selectAll("circle").on("click", (e, p) => {
    e.stopPropagation();
    if (p[4]) inspectFragment(p[4], ctry);
  });
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
window.addEventListener("resize", () => {
  if (!STATE.data) return;
  if (STATE.country === "bridge" && STATE.lens === "unique") return renderBridgeUniqueStep();
  if (STATE.country === "bridge") return renderBridgeStep();
  if (STATE.lens === "unique") return (STATE.stockView && !STATE.stockDrill) ? renderStockStep() : renderUniqueStep();
  draw();
});
