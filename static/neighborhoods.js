"use strict";

const PAGE_ROWS = 100;
const TYPE_WORDS = { zip: ["ZIP code", "ZIP codes"], neighborhood: ["neighborhood", "neighborhoods"] };

const nb = {
  metros: [],
  byKey: new Map(),
  byName: new Map(),
  key: null,
  type: "zip",
  metro: null,      // /api/metro/{key}
  local: null,      // /api/metro/{key}/local
  rows: [],         // areas with derived fields
  sort: { col: "value", dir: -1 },
  q: "",
  budget: null,
  budgetOnly: false,
  showAll: false,
  selected: null,   // area_id
  detailCache: new Map(),
};

const word = (n) => TYPE_WORDS[nb.type][n === 1 ? 0 : 1];

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Price whose estimated monthly payment equals the budget, under current settings. */
function priceForBudget(budget, ratePct) {
  return budget / monthlyPayment(1, ratePct);
}

function latestRate() {
  const r = lastValid(nb.metro.rates.month, nb.metro.rates.rate_30y);
  return r.value;
}

function placeLabel(a) {
  return nb.type === "zip" ? [a.city, a.state].filter(Boolean).join(", ") : [a.city, a.county].filter(Boolean).join(" · ");
}

// ---------- derive and filter ----------
function deriveRows() {
  const rate = latestRate();
  nb.rows = nb.local.areas.map((a) => {
    const payment = monthlyPayment(a.value, rate);
    return { ...a, label: a.name, place: placeLabel(a), payment, within: nb.budget ? payment <= nb.budget : null };
  });
}

function visibleRows() {
  const q = nb.q.trim().toLowerCase();
  let rows = nb.rows;
  if (q) rows = rows.filter((r) => `${r.name} ${r.city || ""} ${r.county || ""}`.toLowerCase().includes(q));
  if (nb.budget && nb.budgetOnly) rows = rows.filter((r) => r.within);
  const { col, dir } = nb.sort;
  return [...rows].sort((a, b) => {
    const x = a[col];
    const y = b[col];
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

// ---------- tiles ----------
function renderTiles() {
  const rows = nb.rows;
  const values = rows.map((r) => r.value).sort((a, b) => a - b);
  const changes = rows.map((r) => r.change_1y).filter((v) => v != null).sort((a, b) => a - b);
  const falling = changes.filter((v) => v < 0).length;
  const metroValue = lastValid(nb.metro.zhvi.month, nb.metro.zhvi.value);
  const tiles = [
    ["Metro typical value", fmtMoney(metroValue.value), `As of ${fmtMonth(metroValue.month)}`],
    [`${word(2).replace(/^./, (c) => c.toUpperCase())} with estimates`, fmtNum(rows.length),
      nb.local.without_estimate ? `${nb.local.without_estimate} more have no recent estimate` : `As of ${fmtMonth(nb.local.as_of)}`],
    ["Typical values, middle 80%", `${fmtMoneyShort(quantile(values, 0.1))}–${fmtMoneyShort(quantile(values, 0.9))}`,
      `Lowest ${fmtMoneyShort(values[0])}, highest ${fmtMoneyShort(values[values.length - 1])}`],
    ["Values fell over the year", changes.length ? fmtPct(falling / changes.length, 0) : "–",
      `${fmtNum(falling)} of ${fmtNum(changes.length)} ${word(2)}`],
    ["1-year change, middle 80%", changes.length ? `${fmtSignedPct(quantile(changes, 0.1))} to ${fmtSignedPct(quantile(changes, 0.9))}` : "–",
      `Median ${fmtSignedPct(quantile(changes, 0.5))}`],
  ];
  if (nb.budget) {
    const within = rows.filter((r) => r.within).length;
    tiles.push(["Your budget buys up to", fmtMoney(priceForBudget(nb.budget, latestRate())),
      `${fmtNum(within)} of ${fmtNum(rows.length)} ${word(2)} have a typical home within budget`]);
  }
  document.getElementById("tiles").replaceChildren(...tiles.map(([label, value, note]) => {
    const t = el("div", { class: "tile" });
    t.append(el("div", { class: "label" }, label), el("div", { class: "value" }, value), el("div", { class: "asof" }, note));
    return t;
  }));
}

// ---------- charts ----------
function renderDistribution() {
  const changes = nb.rows.map((r) => r.change_1y).filter((v) => v != null);
  if (!changes.length) {
    renderChart("n-dist", [], [], { emptyText: "No year-over-year changes available." });
    return;
  }
  const LIMIT = 10; // percent; changes beyond ±10% go in the end bins
  const lo = Math.max(-LIMIT, Math.floor(Math.min(...changes) * 100));
  const hi = Math.min(LIMIT, Math.ceil(Math.max(...changes) * 100));
  const labels = [];
  const counts = [];
  for (let b = lo; b < hi; b++) {
    const first = b === lo && Math.min(...changes) * 100 < lo;
    const last = b === hi - 1 && Math.max(...changes) * 100 > hi;
    labels.push(first ? `Under ${b + 1}%` : last ? `${b}% or more` : `${b}% to ${b + 1}%`);
    counts.push(changes.filter((v) => {
      const pct = v * 100;
      return (first ? true : pct >= b) && (last ? true : pct < b + 1);
    }).length);
  }
  document.getElementById("dist-sub").textContent =
    `Number of ${word(2)} by change in typical home value, ${fmtMonth(nb.local.as_of)} vs a year earlier`;
  renderChart("n-dist", labels, [{ label: word(2).replace(/^./, (c) => c.toUpperCase()), data: counts }],
    { type: "bar", fmt: fmtNum, axisFmt: (v) => (Number.isInteger(v) ? v : ""), periodLabel: "1-year change", yMin: 0 });
}

function renderScatter() {
  const card = document.querySelector('[data-chart="n-scatter"]');
  const canvas = card.querySelector("canvas");
  if (charts["n-scatter"]) charts["n-scatter"].destroy();
  const rows = nb.rows.filter((r) => r.change_5y != null);
  const point = (r) => ({ x: r.value, y: r.change_5y, row: r });
  const groups = nb.budget
    ? [
      { label: "Within budget", data: rows.filter((r) => r.within).map(point), colorVar: "--series-1" },
      { label: "Above budget", data: rows.filter((r) => !r.within).map(point), colorVar: "--muted" },
    ]
    : [{ label: word(2), data: rows.map(point), colorVar: "--series-1" }];
  renderLegend(card, groups.length > 1 ? groups : []);
  document.getElementById("scatter-sub").textContent =
    `Each dot is one ${word(1)}: typical value now (log scale) and change over 5 years.`;
  const sel = nb.selected;
  charts["n-scatter"] = new Chart(canvas, {
    type: "scatter",
    data: {
      datasets: groups.map((g) => ({
        label: g.label,
        data: g.data,
        backgroundColor: css(g.colorVar),
        borderColor: g.data.map((p) => (p.row.area_id === sel ? css("--text") : css("--surface"))),
        borderWidth: g.data.map((p) => (p.row.area_id === sel ? 2.5 : 1)),
        pointRadius: g.data.map((p) => (p.row.area_id === sel ? 7 : 4)),
        pointHoverRadius: 7,
        pointHitRadius: 10,
      })),
    },
    options: {
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {
          type: "logarithmic",
          grid: { color: css("--grid"), drawTicks: false },
          border: { color: css("--axis") },
          ticks: {
            color: css("--muted"), autoSkip: false, maxRotation: 0,
            // Log axes put a tick at every step; label only round values (100K, 200K, 300K, 500K, 700K, 1M...).
            callback: (v) => {
              const m = v / 10 ** Math.floor(Math.log10(v));
              return [1, 2, 3, 5, 7].some((x) => Math.abs(m - x) < 1e-6) ? fmtMoneyShort(v) : "";
            },
          },
          title: { display: true, text: "Typical home value", color: css("--muted") },
        },
        y: {
          grid: { color: css("--grid"), drawTicks: false },
          border: { display: false },
          ticks: { color: css("--muted"), padding: 8, callback: (v) => fmtPct(v, 0) },
          title: { display: true, text: "5-year change", color: css("--muted") },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: css("--tooltip-bg"), titleColor: css("--text"), bodyColor: css("--text-2"),
          borderColor: css("--border"), borderWidth: 1, padding: 10, displayColors: false,
          callbacks: {
            title: (items) => `${items[0].raw.row.label} · ${items[0].raw.row.place}`,
            label: (item) => [`Typical value ${fmtMoney(item.raw.x)}`, `5-year change ${fmtSignedPct(item.raw.y)}`],
          },
        },
      },
      onClick: (_e, elements) => {
        if (elements.length) {
          const ds = charts["n-scatter"].data.datasets[elements[0].datasetIndex];
          selectArea(ds.data[elements[0].index].row.area_id);
        }
      },
    },
  });
}

async function renderDetail() {
  const title = document.getElementById("detail-title");
  const sub = document.getElementById("detail-sub");
  // With nothing chosen, show the largest area so the card is never empty.
  const chosen = nb.selected != null;
  const id = chosen ? nb.selected : [...nb.rows].sort((a, b) => a.size_rank - b.size_rank)[0]?.area_id;
  if (id == null) {
    renderChart("n-detail", [], [], { emptyText: "No areas to show." });
    return;
  }
  let d = nb.detailCache.get(id);
  if (!d) {
    try {
      d = await getJSON(`/api/local/${id}`);
      nb.detailCache.set(id, d);
    } catch (e) {
      sub.textContent = "This area's history couldn't be loaded.";
      return;
    }
  }
  const row = nb.rows.find((r) => r.area_id === id);
  title.textContent = `${d.name} · ${placeLabel(d)}`;
  sub.textContent = (row
    ? `Typical value ${fmtMoney(row.value)} (${fmtSignedPct(row.vs_metro, 0)} vs the metro). ` +
      `${fmtSignedPct(row.change_1y)} over 1 year, ${fmtSignedPct(row.change_5y)} over 5 years.`
    : "") + (chosen ? "" : ` Showing the largest ${word(1)}; select a row in the table or a dot above to change it.`);
  const metroBy = new Map(nb.metro.zhvi.month.map((m, i) => [m, nb.metro.zhvi.value[i]]));
  renderChart("n-detail", d.month, [
    { label: d.name, data: d.value, colorVar: "--series-1" },
    { label: "Metro", data: d.month.map((m) => metroBy.get(m) ?? null), colorVar: "--series-2" },
  ], { fmt: fmtMoney, axisFmt: fmtMoneyShort, periodLabel: "Month" });
}

// ---------- table ----------
const COLUMNS = [
  { col: "label", label: () => (nb.type === "zip" ? "ZIP code" : "Neighborhood"), text: true },
  { col: "place", label: () => (nb.type === "zip" ? "City" : "City · county"), text: true },
  { col: "value", label: () => "Typical value", fmt: fmtMoney },
  { col: "vs_metro", label: () => "vs metro", fmt: (v) => fmtSignedPct(v, 0), title: "Typical value compared with the metro's" },
  { col: "change_1y", label: () => "1-yr change", fmt: fmtSignedPct },
  { col: "change_5y", label: () => "5-yr change", fmt: fmtSignedPct },
  { col: "spark", label: () => "10-yr trend", spark: true },
  { col: "vs_metro_change_5y", label: () => "Shift vs metro, 5 yrs", fmt: fmtPts,
    title: "Change over 5 years in this area's value relative to the metro. Positive means it gained ground." },
  { col: "payment", label: () => "Est. payment", fmt: fmtMoney },
];

function sparkline(values) {
  const NS = "http://www.w3.org/2000/svg";
  const w = 88;
  const h = 24;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("aria-hidden", "true");
  const pts = (values || []).filter((v) => v != null);
  if (pts.length < 2) return svg;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const x = (i) => 2 + (i / (pts.length - 1)) * (w - 4);
  const y = (v) => (max === min ? h / 2 : h - 3 - ((v - min) / (max - min)) * (h - 6));
  const line = document.createElementNS(NS, "polyline");
  line.setAttribute("points", pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", css("--series-1"));
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-linejoin", "round");
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", x(pts.length - 1));
  dot.setAttribute("cy", y(pts[pts.length - 1]));
  dot.setAttribute("r", "2.5");
  dot.setAttribute("fill", css("--series-1"));
  svg.append(line, dot);
  return svg;
}

function renderTable() {
  const rows = visibleRows();
  const shown = nb.showAll ? rows : rows.slice(0, PAGE_ROWS);
  const table = document.getElementById("area-table");
  const head = el("tr");
  const cols = nb.budget ? [...COLUMNS, { col: "within", label: () => "In budget", budget: true }] : COLUMNS;
  cols.forEach((c) => {
    const th = el("th", { class: c.text || c.budget ? "" : "num", tabindex: c.spark ? "-1" : "0" }, c.label());
    if (c.title) th.title = c.title;
    if (!c.spark) {
      if (nb.sort.col === c.col) th.setAttribute("aria-sort", nb.sort.dir > 0 ? "ascending" : "descending");
      const sortBy = () => {
        nb.sort = { col: c.col, dir: nb.sort.col === c.col ? -nb.sort.dir : (c.text ? 1 : -1) };
        renderTable();
      };
      th.addEventListener("click", sortBy);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter") sortBy(); });
    } else {
      th.classList.add("nosort");
    }
    head.append(th);
  });
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  shown.forEach((r) => {
    const tr = el("tr", { tabindex: "0", "data-id": String(r.area_id) });
    if (r.area_id === nb.selected) tr.classList.add("current");
    cols.forEach((c) => {
      if (c.spark) {
        const td = el("td", { class: "spark" });
        td.append(sparkline(r.spark));
        tr.append(td);
      } else if (c.budget) {
        tr.append(el("td", {}, r.within ? "✓ Yes" : "No"));
      } else {
        tr.append(el("td", { class: c.text ? "" : "num" }, c.text ? (r[c.col] || "") : c.fmt(r[c.col])));
      }
    });
    tbody.append(tr);
  });
  if (!shown.length) {
    const tr = el("tr");
    tr.append(el("td", { colspan: String(cols.length), class: "note" }, "No areas match."));
    tbody.append(tr);
  }
  table.replaceChildren(thead, tbody);

  document.getElementById("table-title").textContent = `All ${word(2)}`;
  document.getElementById("table-info").textContent =
    `Showing ${fmtNum(shown.length)} of ${fmtNum(rows.length)} ${word(rows.length)}` +
    (rows.length < nb.rows.length ? ` (filtered from ${fmtNum(nb.rows.length)})` : "");
  const more = document.getElementById("show-all");
  more.hidden = nb.showAll || rows.length <= PAGE_ROWS;
  more.textContent = `Show all ${fmtNum(rows.length)}`;
}

function downloadCsv() {
  const rows = visibleRows();
  const header = [nb.type === "zip" ? "zip_code" : "neighborhood", "city", "county", "state", "typical_value",
    "vs_metro", "change_1y", "change_5y", "shift_vs_metro_5y", "est_monthly_payment", "history_since"];
  const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const round = (v, d) => (v == null ? "" : +v.toFixed(d));
  const lines = [header.join(",")].concat(rows.map((r) => [
    r.name, r.city, r.county, r.state, round(r.value, 0), round(r.vs_metro, 4), round(r.change_1y, 4),
    round(r.change_5y, 4), round(r.vs_metro_change_5y, 4), round(r.payment, 0), r.since,
  ].map(esc).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `${nb.key.replace(/[^a-z0-9]+/g, "_")}_${nb.type}s.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

// ---------- page ----------
function renderAll() {
  if (!nb.local) return;
  deriveRows();
  const metroName = nb.byKey.get(nb.key).name;
  document.getElementById("title").textContent = `${metroName}: ${word(2)}`;
  document.title = `${metroName} ${word(2)} · Homebuyer Market Lens`;
  document.getElementById("dashboard-link").href = `/#metro=${encodeURIComponent(nb.key)}`;
  document.getElementById("intro").textContent =
    `Typical home values for ${fmtNum(nb.rows.length)} ${word(2)} in the ${metroName} metro, ` +
    `as of ${fmtMonth(nb.local.as_of)}, compared with the metro as a whole.`;
  const counts = nb.local.counts;
  document.getElementById("type-note").textContent = counts.neighborhood
    ? "" : "Neighborhood estimates aren't available for this metro, so this view shows ZIP codes.";
  document.querySelector('[data-type="neighborhood"]').disabled = !counts.neighborhood;
  document.getElementById("budget-only-wrap").hidden = !nb.budget;
  renderTiles();
  renderDistribution();
  renderScatter();
  renderTable();
  renderDetail();
}

async function load(key, type) {
  nb.key = key;
  nb.type = type;
  nb.showAll = false;
  document.getElementById("metro-input").value = nb.byKey.get(key).name;
  document.getElementById("empty-state").hidden = true;
  document.getElementById("content").hidden = false;
  document.querySelectorAll(".plot, .area-wrap").forEach((p) => p.classList.add("loading"));
  try {
    if (!nb.metro || nb.metro.key !== key) nb.metro = await getJSON(`/api/metro/${encodeURIComponent(key)}`);
    nb.local = await getJSON(`/api/metro/${encodeURIComponent(key)}/local?type=${type}`);
    if (type === "neighborhood" && !nb.local.areas.length) {
      nb.type = "zip";
      nb.local = await getJSON(`/api/metro/${encodeURIComponent(key)}/local?type=zip`);
    }
  } catch (e) {
    document.getElementById("intro").textContent = "We couldn't load this metro's areas. Please try again.";
    return;
  } finally {
    document.querySelectorAll(".plot, .area-wrap").forEach((p) => p.classList.remove("loading"));
  }
  if (!nb.local.areas.some((a) => a.area_id === nb.selected)) nb.selected = null;
  syncTypeButtons();
  writeHash();
  renderAll();
}

function selectArea(id) {
  nb.selected = id;
  writeHash();
  renderTable();
  renderScatter();
  renderDetail();
  document.querySelector('[data-chart="n-detail"]').scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function writeHash() {
  const p = new URLSearchParams({ metro: nb.key, type: nb.type });
  if (nb.selected) p.set("area", nb.selected);
  history.replaceState(null, "", `#${p}`);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { metro: p.get("metro"), type: p.get("type") === "neighborhood" ? "neighborhood" : "zip", area: +p.get("area") || null };
}

function syncTypeButtons() {
  document.querySelectorAll("[data-type]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.type === nb.type)));
}

function bindControls() {
  const input = document.getElementById("metro-input");
  const pick = () => {
    const key = nb.byName.get(input.value.trim().toLowerCase());
    if (key && key !== nb.key) { nb.selected = null; load(key, nb.type); }
  };
  input.addEventListener("change", pick);
  input.addEventListener("input", () => { if (nb.byName.has(input.value.trim().toLowerCase())) pick(); });
  document.querySelectorAll("[data-type]").forEach((b) => b.addEventListener("click", () => {
    if (nb.key && b.dataset.type !== nb.type) { nb.selected = null; load(nb.key, b.dataset.type); }
  }));
  document.getElementById("budget-input").addEventListener("input", (e) => {
    const v = +e.target.value;
    nb.budget = v > 0 ? v : null;
    renderAll();
  });
  document.getElementById("down-input").addEventListener("change", (e) => { settings.down = +e.target.value; renderAll(); });
  document.getElementById("taxes-input").addEventListener("change", (e) => { settings.taxes = e.target.checked; renderAll(); });
  document.getElementById("budget-only").addEventListener("change", (e) => { nb.budgetOnly = e.target.checked; renderTable(); });
  document.getElementById("area-filter").addEventListener("input", (e) => { nb.q = e.target.value; nb.showAll = false; renderTable(); });
  document.getElementById("show-all").addEventListener("click", () => { nb.showAll = true; renderTable(); });
  document.getElementById("csv-button").addEventListener("click", downloadCsv);
  document.getElementById("area-table").addEventListener("click", (e) => {
    const tr = e.target.closest("tbody tr[data-id]");
    if (tr) selectArea(+tr.dataset.id);
  });
  document.getElementById("area-table").addEventListener("keydown", (e) => {
    const tr = e.target.closest("tbody tr[data-id]");
    if (tr && e.key === "Enter") selectArea(+tr.dataset.id);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderAll);
}

async function init() {
  bindControls();
  syncTypeButtons();
  try {
    nb.metros = (await getJSON("/api/metros")).filter((m) => m.key !== US_KEY);
  } catch (e) {
    document.getElementById("empty-state").hidden = false;
    document.getElementById("suggestions").replaceChildren(el("p", { class: "note" }, "The metro list couldn't be loaded. Please try again shortly."));
    return;
  }
  const list = document.getElementById("metro-list");
  nb.metros.forEach((m) => {
    nb.byKey.set(m.key, m);
    nb.byName.set(m.name.toLowerCase(), m.key);
    list.append(el("option", { value: m.name }));
  });
  document.getElementById("suggestions").replaceChildren(...nb.metros.slice(0, 8).map((m) => {
    const b = el("button", { type: "button", class: "button" }, m.name);
    b.addEventListener("click", () => load(m.key, nb.type));
    return b;
  }));
  const h = readHash();
  if (h.metro && nb.byKey.has(h.metro)) {
    nb.selected = h.area;
    await load(h.metro, h.type);
  } else {
    document.getElementById("empty-state").hidden = false;
  }
}

init();
