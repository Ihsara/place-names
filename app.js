/* Fossils in the Map — FI/VN place-name morpheme story.
   Vanilla D3 v7. One SVG, swapped per tab. Glow-bloom point layer + scroll
   steps + free explorer. */
const SVG = d3.select("#map");
const CAPTION = d3.select("#map-caption");

const STATE = {
  country: "finland",
  data: null,            // loaded payload
  active: new Set(),     // morpheme ids currently lit (story or explorer)
  mode: "story",         // "story" | "explore"
  colorById: new Map(),
};

const FILES = { finland: "fi.json", vietnam: "vn.json" };

function projectionFor(country, points, w, h) {
  // Fit a Mercator to the data extent with padding — no basemap tiles needed.
  const fc = {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p[0], p[1]] },
    })),
  };
  return d3.geoMercator().fitExtent([[24, 24], [w - 24, h - 24]], fc);
}

function ensureDefs() {
  let defs = SVG.select("defs");
  if (!defs.empty()) return defs;
  defs = SVG.append("defs");
  // gooey glow filter
  const f = defs.append("filter").attr("id", "goo")
    .attr("x", "-30%").attr("y", "-30%").attr("width", "160%").attr("height", "160%");
  f.append("feGaussianBlur").attr("in", "SourceGraphic")
    .attr("stdDeviation", 3).attr("result", "blur");
  f.append("feColorMatrix").attr("in", "blur").attr("type", "matrix")
    .attr("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7");
  return defs;
}

function ensureGradient(defs, id, color) {
  const gid = "g-" + id;
  if (!defs.select("#" + gid).empty()) return gid;
  const rg = defs.append("radialGradient").attr("id", gid);
  rg.append("stop").attr("offset", "0%").attr("stop-color", d3.rgb(color).brighter(1.4));
  rg.append("stop").attr("offset", "100%").attr("stop-color", color);
  return gid;
}

function radiusForRank(rank) {
  // city(0) biggest -> suburb(4) smallest
  return [7, 5.5, 4, 3, 2.4][rank] ?? 2.2;
}

function draw() {
  const node = SVG.node();
  const w = node.clientWidth || 800;
  const h = node.clientHeight || 600;
  SVG.attr("viewBox", `0 0 ${w} ${h}`);
  const data = STATE.data;
  const proj = projectionFor(STATE.country, data.points, w, h);
  const defs = ensureDefs();

  // base layer: faint "other"/unlit dots (no glow) for honest density
  let base = SVG.selectAll("g.base").data([0]);
  base = base.enter().append("g").attr("class", "base").merge(base);
  const baseSel = base.selectAll("circle").data(data.points);
  baseSel.join("circle")
    .attr("cx", (p) => proj([p[0], p[1]])[0])
    .attr("cy", (p) => proj([p[0], p[1]])[1])
    .attr("r", 1.1)
    .attr("fill", "#27406e")
    .attr("fill-opacity", 0.5);

  // glow layer: only LIT morphemes, grouped under the goo filter + screen blend
  let glow = SVG.selectAll("g.glow").data([0]);
  glow = glow.enter().append("g").attr("class", "glow")
    .attr("filter", "url(#goo)")
    .style("mix-blend-mode", "screen")
    .merge(glow);

  const lit = data.points.filter((p) => p[2] && STATE.active.has(p[2]));
  lit.forEach((p) => ensureGradient(defs, p[2], STATE.colorById.get(p[2])));

  const sel = glow.selectAll("circle").data(lit, (p) => p[0] + ":" + p[1]);
  sel.join(
    (enter) => enter.append("circle")
      .attr("cx", (p) => proj([p[0], p[1]])[0])
      .attr("cy", (p) => proj([p[0], p[1]])[1])
      .attr("r", 0)
      .attr("fill", (p) => `url(#g-${p[2]})`)
      .call((e) => e.transition().duration(450).attr("r", (p) => radiusForRank(p[3]) + 1.5)),
    (update) => update
      .attr("cx", (p) => proj([p[0], p[1]])[0])
      .attr("cy", (p) => proj([p[0], p[1]])[1])
      .attr("r", (p) => radiusForRank(p[3]) + 1.5),
    (exit) => exit.call((e) => e.transition().duration(250).attr("r", 0).remove())
  );
}

async function loadCountry(country) {
  STATE.country = country;
  STATE.data = await d3.json(FILES[country]);
  STATE.colorById = new Map(STATE.data.morphemes.map((m) => [m.id, m.color]));
  STATE.active = new Set();
  buildSteps();          // Task 9
  draw();
}

window.addEventListener("resize", () => STATE.data && draw());

/* ---- scroll steps: one per morpheme, then a "turn" + explorer ------------ */
const STEPS = d3.select("#steps");

function buildSteps() {
  const m = STATE.data.morphemes.filter((x) => x.count > 0); // skip dead
  STEPS.html("");

  // intro step
  STEPS.append("section").attr("class", "step").attr("data-act", "intro")
    .html(`<div class="card">
      <p class="gloss">${STATE.country}</p>
      <p class="element">Place names are fossils.</p>
      <p class="history">Read them by where they cluster. Scroll to light up each name-element.</p>
    </div>`);

  // one step per morpheme
  m.forEach((mo) => {
    STEPS.append("section").attr("class", "step")
      .attr("data-act", "morpheme").attr("data-id", mo.id)
      .html(`<div class="card" style="border-color:${mo.color}55">
        <p class="element" style="color:${mo.color}">${mo.element}</p>
        <p class="gloss">${mo.gloss} · ${mo.count.toLocaleString()} places</p>
        <p class="history">${mo.history}</p>
      </div>`);
  });

  // the turn: all lit
  STEPS.append("section").attr("class", "step").attr("data-act", "all")
    .html(`<div class="card"><p class="element">All at once</p>
      <p class="history">Every element together — the whole naming fabric of ${STATE.country}.</p></div>`);

  // explorer
  const legend = STATE.data.morphemes
    .filter((x) => x.count > 0)
    .map((mo) => `<span class="chip on" data-id="${mo.id}">
        <span class="dot" style="background:${mo.color}"></span>${mo.element}</span>`)
    .join("");
  STEPS.append("section").attr("class", "step").attr("data-act", "explore")
    .html(`<div class="card"><p class="element">Explore</p>
      <p class="history">Toggle elements; hover a glowing dot for its name.</p>
      <div class="legend">${legend}</div></div>`);

  wireScroll();
  wireLegend();
}

function setActiveForStep(step) {
  const act = step.getAttribute("data-act");
  const ids = STATE.data.morphemes.filter((m) => m.count > 0).map((m) => m.id);
  if (act === "intro") STATE.active = new Set();
  else if (act === "morpheme") STATE.active = new Set([step.getAttribute("data-id")]);
  else STATE.active = new Set(ids); // all / explore
  STATE.mode = act === "explore" ? "explore" : "story";
  const mo = STATE.data.morphemes.find((m) => m.id === step.getAttribute("data-id"));
  CAPTION.text(mo ? `${mo.element} — ${mo.meaning}` : "");
  draw();
}

let _io;
function wireScroll() {
  if (_io) _io.disconnect();
  _io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting && e.intersectionRatio > 0.5) {
        d3.selectAll(".step").classed("is-active", false);
        e.target.classList.add("is-active");
        setActiveForStep(e.target);
      }
    });
  }, { threshold: [0.5] });
  document.querySelectorAll(".step").forEach((s) => _io.observe(s));
}

function wireLegend() {
  STEPS.selectAll(".chip").on("click", function () {
    const id = this.getAttribute("data-id");
    if (STATE.mode !== "explore") return;
    if (STATE.active.has(id)) { STATE.active.delete(id); this.classList.remove("on"); }
    else { STATE.active.add(id); this.classList.add("on"); }
    draw();
  });
}

/* ---- tab switching -------------------------------------------------------- */
d3.selectAll(".tab").on("click", function () {
  d3.selectAll(".tab").classed("is-active", false);
  this.classList.add("is-active");
  window.scrollTo({ top: 0 });
  loadCountry(this.getAttribute("data-country"));
});

/* ---- boot ----------------------------------------------------------------- */
loadCountry("finland");
