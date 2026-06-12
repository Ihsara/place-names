// explore.js — DuckDB-WASM data tier + D3 glow render tier for the explorer.
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

const status = document.getElementById("status");
let conn = null;

async function initDuckDB() {
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
  // Cross-origin Worker workaround: fetch the worker script and create a blob URL.
  const workerResp = await fetch(bundle.mainWorker);
  const workerBlob = await workerResp.blob();
  const workerUrl = URL.createObjectURL(workerBlob);
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();
  // Register + read the Parquet. points.parquet is served alongside explore.html.
  const url = new URL("points.parquet", window.location.href).href;
  await conn.query(`CREATE VIEW points AS SELECT * FROM read_parquet('${url}')`);
  const r = await conn.query("SELECT count(*) AS n FROM points");
  const n = Number(r.toArray()[0].n);
  status.textContent = `${n.toLocaleString()} places loaded`;
  return conn;
}

// ── Projection + glow render ──────────────────────────────────────────────────

const svg = d3.select("#map");
const countEl = document.getElementById("count");
const LIMIT = 20000;
const tip = document.getElementById("tip");
function showTip(ev, d) {
  const fragLine = d.rawFrag ? ` · <i>${d.rawFrag}</i>` : "";
  const famLine = d.family && d.family !== "other" ? ` · ${d.family}` : "";
  tip.innerHTML = `<b>${d.name}</b>${fragLine}${famLine}`;
  tip.style.display = "block";
  const mapArea = document.getElementById("map-area");
  const rect = mapArea.getBoundingClientRect();
  tip.style.left = (ev.clientX - rect.left + 12) + "px";
  tip.style.top  = (ev.clientY - rect.top  + 12) + "px";
}
function hideTip() { tip.style.display = "none"; }
let projection = null, glowG = null;
let queryId = 0;

async function initProjection() {
  const r = (await conn.query(
    "SELECT min(lon) lo, max(lon) hi, min(lat) la, max(lat) ha FROM points"
  )).toArray()[0];
  const w = svg.node().clientWidth, h = svg.node().clientHeight;
  const feature = {
    type: "MultiPoint",
    coordinates: [
      [Number(r.lo), Number(r.la)],
      [Number(r.hi), Number(r.ha)]
    ]
  };
  projection = d3.geoMercator().fitExtent([[10, 10], [w - 10, h - 10]], feature);
  glowG = svg.append("g").attr("id", "glow");
  const defs = svg.append("defs");
  const grad = defs.append("radialGradient").attr("id", "dot-glow");
  grad.append("stop").attr("offset", "0%").attr("stop-color", "#ffd166").attr("stop-opacity", 0.95);
  grad.append("stop").attr("offset", "100%").attr("stop-color", "#ffd166").attr("stop-opacity", 0);
}

// ── SQL composer ──────────────────────────────────────────────────────────────

function buildSQL() {
  const name = document.getElementById("q-name").value.trim();
  const country = document.getElementById("q-country").value;
  const family = document.getElementById("q-family").value;
  const stock = document.getElementById("q-stock").value;
  const frag = document.getElementById("q-frag").value.trim();
  const lat = +document.getElementById("q-lat").value;
  const esc = (s) => s.replace(/'/g, "''");
  const where = [];
  if (name) where.push(`name ILIKE '%${esc(name)}%'`);
  if (country) where.push(`country = '${esc(country)}'`);
  if (family) where.push(`family = '${esc(family)}'`);
  if (stock) where.push(`stock = '${esc(stock)}'`);
  if (frag) where.push(`rawFrag = '${esc(frag)}'`);
  if (lat > -90) where.push(`lat > ${lat}`);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // ORDER BY random() so the LIMIT sample spans all countries (parquet is FI→SE→VN concatenated).
  return {
    rows: `SELECT lon, lat, name, rawFrag, family FROM points ${clause} ORDER BY random() LIMIT ${LIMIT}`,
    total: `SELECT count(*) AS n FROM points ${clause}`,
  };
}

// ── Query runner (debounced + in-flight guard) ────────────────────────────────

async function runQuery() {
  const myId = ++queryId;
  const { rows, total } = buildSQL();
  const [rowsRes, totalRes] = await Promise.all([conn.query(rows), conn.query(total)]);
  if (myId !== queryId) return; // stale — drop
  const data = rowsRes.toArray();
  const n = Number(totalRes.toArray()[0].n);
  countEl.textContent = n > LIMIT
    ? `showing ${LIMIT.toLocaleString()} of ${n.toLocaleString()} places`
    : `${n.toLocaleString()} places`;
  drawDots(data);
  stateToHash();
}

function drawDots(data) {
  // DuckDB Arrow rows are read-only proxies; map to plain objects so we can attach _px/_py.
  const pts = data.map((d) => {
    const p = projection([Number(d.lon), Number(d.lat)]);
    return { _px: p[0], _py: p[1], name: d.name, rawFrag: d.rawFrag, family: d.family };
  });
  // index key: fine while r/fill are invariant; switch to a stable id if visual encoding becomes data-driven.
  const sel = glowG.selectAll("circle").data(pts, (_d, i) => i);
  sel.join(
    (enter) => enter.append("circle").attr("r", 4).attr("fill", "url(#dot-glow)"),
    (update) => update,
    (exit) => exit.remove()
  )
    .attr("cx", (d) => d._px)
    .attr("cy", (d) => d._py);
  glowG.selectAll("circle")
    .on("pointerenter", (ev, d) => showTip(ev, d))
    .on("pointermove",  (ev, d) => showTip(ev, d))
    .on("pointerleave", hideTip);
}

// ── Controls wiring ───────────────────────────────────────────────────────────

let debounceTimer = null;
function scheduleQuery() {
  document.getElementById("lat-val").textContent = document.getElementById("q-lat").value;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runQuery, 200);
}

function wireControls() {
  for (const id of ["q-name", "q-country", "q-family", "q-stock", "q-frag", "q-lat"]) {
    document.getElementById(id).addEventListener("input", scheduleQuery);
  }
  document.getElementById("q-reset").addEventListener("click", () => {
    for (const id of ["q-name", "q-frag"]) document.getElementById(id).value = "";
    for (const id of ["q-country", "q-family", "q-stock"]) document.getElementById(id).value = "";
    document.getElementById("q-lat").value = -90;
    scheduleQuery();
  });
}

async function populateDropdowns() {
  for (const [col, selId] of [["family", "q-family"], ["stock", "q-stock"]]) {
    const r = (await conn.query(
      `SELECT DISTINCT ${col} AS v FROM points WHERE ${col} IS NOT NULL AND ${col} <> 'other' AND ${col} <> '' ORDER BY v`
    )).toArray();
    const sel = document.getElementById(selId);
    for (const row of r) {
      const o = document.createElement("option");
      o.value = o.textContent = row.v;
      sel.appendChild(o);
    }
  }
}

// ── URL hash round-trip ───────────────────────────────────────────────────────

function stateToHash() {
  const p = new URLSearchParams();
  const g = (id) => document.getElementById(id).value;
  if (g("q-name")) p.set("name", g("q-name"));
  if (g("q-country")) p.set("c", g("q-country"));
  if (g("q-family")) p.set("fam", g("q-family"));
  if (g("q-stock")) p.set("st", g("q-stock"));
  if (g("q-frag")) p.set("frag", g("q-frag"));
  if (+g("q-lat") > -90) p.set("lat", g("q-lat"));
  const s = p.toString();
  history.replaceState(null, "", s ? "#" + s : location.pathname);
}

function hashToState() {
  const p = new URLSearchParams(location.hash.slice(1));
  const set = (id, v) => { if (v != null) document.getElementById(id).value = v; };
  set("q-name", p.get("name")); set("q-country", p.get("c"));
  set("q-family", p.get("fam")); set("q-stock", p.get("st"));
  set("q-frag", p.get("frag")); set("q-lat", p.get("lat"));
  document.getElementById("lat-val").textContent = document.getElementById("q-lat").value;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

initDuckDB()
  .then(async () => {
    await initProjection();
    await populateDropdowns();
    wireControls();
    hashToState();
    await runQuery();
  })
  .catch((e) => { console.error(e); status.textContent = "Failed to load the query engine."; });
