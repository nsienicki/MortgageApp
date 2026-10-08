"use strict";

const state = {
  metros: [],
  byKey: new Map(),
  byName: new Map(),
  key: null,
  data: null,
  rankings: [],
  sort: { col: "size_rank", dir: 1 },
};

// ---------- page rendering ----------
function renderTiles(d, aff) {
  const tiles = [];
  const add = (label, value, delta, asof) => tiles.push({ label, value, delta, asof });
  const pctChange = (now, then) => (now != null && then ? now / then - 1 : null);
  const diff = (now, then) => (now != null && then != null ? now - then : null);

  const v = lastValid(d.zhvi.month, d.zhvi.value);
  add("Typical home value", fmtMoney(v.value),
    signed(pctChange(v.value, yearAgo(d.zhvi.month, d.zhvi.value)), (x) => fmtPct(x)), v.month);

  const p = lastValid(aff.month, aff.payment);
  add("Est. monthly payment", fmtMoney(p.value),
    signed(diff(p.value, yearAgo(aff.month, aff.payment)), fmtMoney), p.month);

  const b = lastValid(aff.month, aff.burden);
  add("Payment / income", fmtPct(b.value, 0),
    signed(diff(b.value, yearAgo(aff.month, aff.burden)), (x) => (x * 100).toFixed(1) + " pts"), b.month);

  const r = lastValid(d.rates.month, d.rates.rate_30y);
  add("30-yr mortgage rate", fmtRate(r.value),
    signed(diff(r.value, yearAgo(d.rates.month, d.rates.rate_30y)), (x) => x.toFixed(2) + " pts"), r.month);

  const rf = d.redfin;
  if (rf.month.length) {
    const sp = lastValid(rf.month, rf.median_sale_price);
    add("Median sale price", fmtMoney(sp.value),
      signed(pctChange(sp.value, yearAgo(rf.month, rf.median_sale_price)), (x) => fmtPct(x)), sp.month);
    const dom = lastValid(rf.month, rf.median_dom);
    add("Median days on market", fmtDays(dom.value),
      signed(diff(dom.value, yearAgo(rf.month, rf.median_dom)), (x) => Math.round(x) + " days"), dom.month);
    const stl = lastValid(rf.month, rf.sale_to_list);
    add("Sale-to-list ratio", fmtPct(stl.value),
      signed(diff(stl.value, yearAgo(rf.month, rf.sale_to_list)), (x) => (x * 100).toFixed(1) + " pts"), stl.month);
    const inv = lastValid(rf.month, rf.inventory);
    add("Homes for sale", fmtNum(inv.value),
      signed(pctChange(inv.value, yearAgo(rf.month, rf.inventory)), (x) => fmtPct(x, 0)), inv.month);
  }

  document.getElementById("tiles").replaceChildren(...tiles.map((t) => {
    const tile = el("div", { class: "tile" });
    tile.append(el("div", { class: "label" }, t.label), el("div", { class: "value" }, t.value));
    tile.append(el("div", { class: "delta" }, t.delta ? `${t.delta} vs a year ago` : " "));
    tile.append(el("div", { class: "asof" }, t.asof ? `As of ${fmtMonth(t.asof)}` : ""));
    return tile;
  }));
}

function render() {
  const d = state.data;
  if (!d) return;
  const isUS = d.key === US_KEY;
  const aff = affordability(d);

  document.getElementById("metro-title").textContent = d.name;
  document.title = `${d.name} · Homebuyer Market Lens`;
  renderTiles(d, aff);

  // Prices: metro vs national
  const usByMonth = new Map(d.us_zhvi.month.map((m, i) => [m, d.us_zhvi.value[i]]));
  const [vm, vv] = sliceSeries(d.zhvi.month, d.zhvi.value);
  const valueSets = [{ label: isUS ? "United States" : shortName(d.name), data: vv, colorVar: "--series-1" }];
  if (!isUS) valueSets.push({ label: "United States", data: vm.map((m) => usByMonth.get(m) ?? null), colorVar: "--series-2" });
  renderChart("value", vm, valueSets, { fmt: fmtMoney, axisFmt: fmtMoneyShort });
  renderMix(d);

  // Affordability
  const [am, ap, ab, ar] = sliceSeries(aff.month, aff.payment, aff.burden, aff.rate);
  const downLabel = fmtPct(settings.down, settings.down < 0.1 ? 1 : 0);
  document.getElementById("payment-sub").textContent =
    `30-year fixed, ${downLabel} down, ${settings.taxes ? "principal, interest, taxes & insurance" : "principal & interest only"}`;
  renderChart("payment", am, [{ label: "Monthly payment", data: ap }], { fmt: fmtMoney, axisFmt: fmtMoneyShort });
  renderChart("burden", am, [{ label: "Share of income", data: ab }],
    { fmt: (x) => fmtPct(x), axisFmt: (x) => fmtPct(x, 0), ref: { value: 0.30, label: "30% guideline" }, yMin: 0 });
  renderChart("rate", am, [{ label: "30-yr rate", data: ar }], { fmt: fmtRate, axisFmt: (x) => x + "%", yMin: 0 });

  const cutYear = +cutoffMonth().slice(0, 4);
  const iy = d.income.year.filter((y) => y >= cutYear);
  const iv = d.income.value.slice(d.income.year.length - iy.length);
  renderChart("income", iy.map(String), [{ label: "Median income", data: iv }], { fmt: fmtMoney, axisFmt: fmtMoneyShort });

  const incomeScope = isUS ? "the U.S." : d.income.is_local ? "this metro" : "the U.S. (national figure)";
  document.getElementById("income-sub").textContent = `${d.income.source}, ${incomeScope}`;
  document.getElementById("burden-sub").textContent =
    `Median income for ${incomeScope}` +
    (aff.incomeCarried ? `; months after ${aff.maxIncomeYear} reuse ${aff.maxIncomeYear} income` : "") +
    ". Dashed line: 30% guideline.";

  const notes = [];
  if (!d.income.is_local && !isUS) {
    notes.push("Income figures for this metro aren't available yet, so affordability uses the U.S. median household income. " +
      "Where local incomes are higher than the national median, payments will look less affordable than they are.");
  }
  document.getElementById("metro-note").textContent = notes.join(" ");

  // Competition (Redfin)
  const rf = d.redfin;
  const emptyText = isUS
    ? "Pick a metro to see listing and sales data."
    : "Redfin doesn't publish listing data for this metro.";
  const [rm, dom, stl, inv, drops] = sliceSeries(rf.month, rf.median_dom, rf.sale_to_list, rf.inventory, rf.price_drops);
  renderChart("dom", rm, [{ label: "Days on market", data: dom }], { fmt: fmtDays, axisFmt: (x) => x, yMin: 0, emptyText });
  renderChart("stl", rm, [{ label: "Sale-to-list", data: stl }],
    { fmt: (x) => fmtPct(x), axisFmt: (x) => fmtPct(x, 0), ref: { value: 1, label: "List price" }, emptyText });
  renderChart("inventory", rm, [{ label: "Homes for sale", data: inv }], { fmt: fmtNum, axisFmt: (x) => fmtNum(x), yMin: 0, emptyText });
  renderChart("drops", rm, [{ label: "With a price cut", data: drops }],
    { fmt: (x) => fmtPct(x), axisFmt: (x) => fmtPct(x, 0), yMin: 0, emptyText });
  document.getElementById("redfin-note").textContent = rf.month.length
    ? `Redfin data runs through ${fmtMonth(rf.month[rf.month.length - 1])}. For the largest metros, Redfin may report the core metro division (e.g. the New York division rather than the whole tri-state area).`
    : "";

  markCurrentRow();
}

function shortName(name) {
  return name.length > 18 ? name.split(",")[0] : name;
}

// ---------- "Is it the homes or the mix?" ----------
const SEGMENTS = [
  ["tier_bottom", "Lower-priced third"], ["tier_middle", "Middle third"], ["tier_top", "Higher-priced third"],
  ["bed_1", "1 bedroom"], ["bed_2", "2 bedrooms"], ["bed_3", "3 bedrooms"], ["bed_4", "4 bedrooms"], ["bed_5", "5+ bedrooms"],
  ["sfr", "Single-family"], ["condo", "Condo/co-op"],
];
const TYPE_ORDER = ["Single-family", "Townhouse", "Condo/co-op", "2-4 unit"];
const TYPE_COLORS = { "Single-family": "--series-1", "Townhouse": "--series-2", "Condo/co-op": "--series-3", "2-4 unit": "--series-4" };

function renderVerdict(d) {
  const root = document.getElementById("verdict");
  const m = d.mix.latest;
  if (!m) {
    root.replaceChildren(el("p", { class: "note" }, d.key === US_KEY
      ? "Choose a metro to see whether price changes come from values or from the mix of homes selling."
      : "There isn't enough sales and repeat-sales data for this area to separate value from mix."));
    return;
  }
  const v = mixVerdict(m);
  const head = el("div", { class: "verdict-head" });
  head.append(el("span", { class: `verdict-icon ${v.kind}`, "aria-hidden": "true" }, v.kind === "mix" ? "⇄" : "≡"));
  const text = el("div");
  text.append(el("p", { class: "verdict-period" }, `${m.quarter} compared with a year earlier`));
  text.append(el("h4", {}, v.headline));
  text.append(el("p", { class: "verdict-detail" }, v.detail));
  head.append(text);

  const stats = el("dl", { class: "verdict-stats" });
  const stat = (label, value, hint) => {
    const div = el("div");
    div.append(el("dt", {}, label), el("dd", {}, value));
    if (hint) div.append(el("p", { class: "hint" }, hint));
    stats.append(div);
  };
  stat("Median sale price", fmtSignedPct(m.median_yoy), "Whatever sold");
  stat("Same home", fmtSignedPct(m.hpi_yoy), "Repeat sales (FHFA)");
  stat("Mix gap", fmtPts(m.mix_gap), "Median minus same home");
  stat("Price per sq ft", fmtSignedPct(m.ppsf_yoy), "Adjusts for size");
  stat("Zillow index", fmtSignedPct(m.zhvi_yoy), "All homes, sold or not");

  const more = el("p", { class: "note" });
  more.append(document.createTextNode("How we reach this verdict, and its limits: "),
    el("a", { href: "/discussion#mix" }, "Reading the mix analysis"));
  root.replaceChildren(head, stats, more);
}

function renderMix(d) {
  renderVerdict(d);
  const cut = cutoffMonth();
  const h = d.mix.history;
  const idx = h.quarter.map((q, i) => i).filter((i) => quarterMonth(h.quarter[i]) >= cut);
  const pick = (arr) => idx.map((i) => arr[i]);
  const quarters = pick(h.quarter);
  const emptyText = d.key === US_KEY ? "Choose a metro to see this analysis." : "Not enough data for this area.";

  renderChart("yoy4", quarters, [
    { label: "Median price", data: pick(h.median_yoy), colorVar: "--series-1" },
    { label: "Same home", data: pick(h.hpi_yoy), colorVar: "--series-2" },
    { label: "Per sq ft", data: pick(h.ppsf_yoy), colorVar: "--series-3" },
    { label: "Zillow index", data: pick(h.zhvi_yoy), colorVar: "--series-4" },
  ], { fmt: fmtSignedPct, axisFmt: (x) => fmtPct(x, 0), ref: { value: 0, label: "No change" }, periodLabel: "Quarter", emptyText });

  renderChart("gap", quarters, [{ label: "Mix gap", data: pick(h.mix_gap) }],
    { type: "bar", fmt: fmtPts, axisFmt: (x) => (x * 100).toFixed(0) + " pts", periodLabel: "Quarter", emptyText });

  // Segment changes: latest Zillow month vs 12 months earlier.
  let asOf = null;
  const segRows = SEGMENTS.map(([id, label]) => {
    const sgm = d.segments[id];
    if (!sgm || !sgm.month.length) return null;
    const last = sgm.month[sgm.month.length - 1];
    asOf = asOf && asOf > last ? asOf : last;
    const prev = yearAgo(sgm.month, sgm.value);
    return prev ? [label, sgm.value[sgm.value.length - 1] / prev - 1] : null;
  }).filter(Boolean);
  document.getElementById("segments-sub").textContent =
    `Zillow Home Value Index, change over the year to ${fmtMonth(asOf)}`;
  renderChart("segments", segRows.map((r) => r[0]), [{ label: "Change over the year", data: segRows.map((r) => r[1]) }],
    { type: "bar", horizontal: true, barLabels: fmtSignedPct, fmt: fmtSignedPct, axisFmt: (x) => fmtPct(x, 0), periodLabel: "Segment" });

  // Share of sales by property type, 3-month rolling to smooth monthly noise.
  const types = TYPE_ORDER.filter((t) => d.types[t]);
  const months = [...new Set(types.flatMap((t) => d.types[t].month))].sort();
  const soldBy = Object.fromEntries(types.map((t) => [t, new Map(d.types[t].month.map((m, i) => [m, d.types[t].homes_sold[i] || 0]))]));
  const rolling = (t, i) => [0, 1, 2].reduce((sum, k) => sum + (i - k >= 0 ? soldBy[t].get(months[i - k]) || 0 : 0), 0);
  const shareSeries = types.map((t) => months.map((m, i) => {
    if (i < 2) return null;
    const total = types.reduce((sum, u) => sum + rolling(u, i), 0);
    return total ? rolling(t, i) / total : null;
  }));
  const [sm, ...shares] = sliceSeries(months, ...shareSeries);
  renderChart("shares", sm, types.map((t, i) => ({ label: t, data: shares[i], colorVar: TYPE_COLORS[t] })),
    { fmt: (x) => fmtPct(x), axisFmt: (x) => fmtPct(x, 0), yMin: 0, emptyText });

  renderShiftShare(d.mix.shift_share, d.key === US_KEY, d.mix.latest);
}

function renderShiftShare(ss, isUS, latest) {
  const sub = document.getElementById("shiftshare-sub");
  const detail = document.getElementById("shiftshare-detail");
  if (!ss) {
    sub.textContent = "Change in a sales-weighted price, split by cause";
    renderChart("shiftshare", [], [], { emptyText: isUS ? "Choose a metro to see this analysis." : "Too few sales by property type to split the change reliably." });
    detail.replaceChildren();
    return;
  }
  sub.textContent = `${ss.quarter} vs a year earlier. Value effect: the same mix of property types, repriced. ` +
    "Mix effect: the change from a different mix of single-family homes, townhouses, condos and 2–4 unit buildings selling.";
  renderChart("shiftshare", ["Value effect", "Mix effect", "Total change"],
    [{ label: "Dollars", data: [ss.value_effect, ss.mix_effect, ss.value_effect + ss.mix_effect] }],
    { type: "bar", horizontal: true, barLabels: (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmtMoneyShort(Math.abs(v)),
      fmt: fmtSignedMoney, axisFmt: fmtMoneyShort, periodLabel: "Part" });

  const table = el("table", { class: "ss-table" });
  const hr = el("tr");
  hr.append(el("th", {}, "Property type"), el("th", { class: "num" }, "Share of sales"), el("th", { class: "num" }, "Median price"));
  const thead = el("thead");
  thead.append(hr);
  const tbody = el("tbody");
  [...ss.types].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)).forEach((t) => {
    const tr = el("tr");
    tr.append(el("td", {}, t.type),
      el("td", { class: "num" }, `${fmtPct(t.share_then)} → ${fmtPct(t.share_now)}`),
      el("td", { class: "num" }, `${fmtMoneyShort(t.price_then)} → ${fmtMoneyShort(t.price_now)}`));
    tbody.append(tr);
  });
  table.append(thead, tbody);
  const notes = [
    `Sales-weighted price: ${fmtMoney(ss.composite_then)} → ${fmtMoney(ss.composite_now)}.`,
    ss.median_then && ss.median_now ? `Overall median: ${fmtMoney(ss.median_then)} → ${fmtMoney(ss.median_now)}.` : "",
    `Based on ${fmtNum(ss.sales_now)} sales this quarter.`,
    ss.sales_now < 500 ? "With this few sales, treat the split as a rough guide." : "",
  ].filter(Boolean).join(" ");
  const wrap = el("div", { class: "table-wrap" });
  wrap.append(table);
  const parts = [wrap, el("p", { class: "note" }, notes)];
  // The type split only sees mix between property types; flag when the overall mix gap points the other way.
  if (latest && Math.abs(latest.mix_gap) >= GAP_THRESHOLD && Math.sign(ss.mix_effect) !== Math.sign(latest.mix_gap)) {
    const cheaper = latest.mix_gap < 0;
    const p = el("p", { class: "callout" });
    p.append(document.createTextNode(
      `Between property types, the mix ${ss.mix_effect > 0 ? "pushed prices up" : "pulled prices down"}, ` +
      `yet the overall mix gap shows a ${cheaper ? "cheaper" : "pricier"} mix of homes selling. ` +
      `So the shift is happening within property types: for example, ${cheaper ? "smaller homes or homes in less expensive areas" : "larger homes or homes in pricier areas"}. `),
      el("a", { href: "/discussion#shift-share" }, "Why the two can disagree"));
    parts.push(p);
  }
  detail.replaceChildren(...parts);
}

// ---------- rankings ----------
function renderRankings() {
  const { col, dir } = state.sort;
  const rows = [...state.rankings].sort((a, b) => {
    const x = a[col], y = b[col];
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  const pct = (v) => (v == null ? "–" : (v > 0 ? "+" : "") + fmtPct(v));
  const tbody = document.querySelector("#rank-table tbody");
  tbody.replaceChildren(...rows.map((r) => {
    const tr = el("tr", { tabindex: "0", "data-key": r.key });
    tr.append(
      el("td", { class: "num" }, String(r.size_rank)),
      el("td", {}, r.name),
      el("td", { class: "num" }, fmtMoney(r.value)),
      el("td", { class: "num" }, pct(r.change_1y)),
      el("td", { class: "num" }, pct(r.change_5y)),
      el("td", { class: "num" }, r.median_dom == null ? "–" : String(Math.round(r.median_dom))),
      el("td", { class: "num" }, fmtPct(r.sale_to_list)),
      el("td", { class: "num" }, pct(r.inventory_change_1y)),
      el("td", { class: "num" }, fmtPts(r.mix_gap)),
    );
    return tr;
  }));
  document.querySelectorAll("#rank-table th").forEach((th) => {
    if (th.dataset.sort === col) th.setAttribute("aria-sort", dir > 0 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });
  markCurrentRow();
}

function markCurrentRow() {
  document.querySelectorAll("#rank-table tbody tr").forEach((tr) =>
    tr.classList.toggle("current", tr.dataset.key === state.key));
}

// ---------- data loading ----------
async function selectMetro(key, { push = true } = {}) {
  if (!state.byKey.has(key)) key = US_KEY;
  state.key = key;
  document.getElementById("metro-input").value = key === US_KEY ? "" : state.byKey.get(key).name;
  document.querySelectorAll(".plot").forEach((p) => p.classList.add("loading"));
  try {
    state.data = await getJSON(`/api/metro/${encodeURIComponent(key)}`);
    render();
  } catch (e) {
    document.getElementById("metro-note").textContent = "We couldn't load this area's data. Please try again.";
  } finally {
    document.querySelectorAll(".plot").forEach((p) => p.classList.remove("loading"));
  }
  if (push) history.replaceState(null, "", key === US_KEY ? "#" : `#metro=${encodeURIComponent(key)}`);
  document.getElementById("compare-link").href = key === US_KEY ? "/compare" : `/compare#m=${encodeURIComponent(key)}`;
  const local = document.getElementById("local-link");
  local.hidden = key === US_KEY;
  local.href = `/neighborhoods#metro=${encodeURIComponent(key)}`;
}

function keyFromHash() {
  const m = location.hash.match(/metro=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : US_KEY;
}

function bindControls() {
  const input = document.getElementById("metro-input");
  const pick = () => {
    const key = state.byName.get(input.value.trim().toLowerCase());
    if (key && key !== state.key) selectMetro(key);
    if (!input.value.trim() && state.key !== US_KEY) selectMetro(US_KEY);
  };
  input.addEventListener("change", pick);
  input.addEventListener("input", () => { if (state.byName.has(input.value.trim().toLowerCase())) pick(); });

  document.querySelectorAll(".segmented button").forEach((btn) => {
    btn.addEventListener("click", () => {
      settings.range = +btn.dataset.range;
      syncRangeButtons();
      render();
    });
  });
  document.getElementById("down-input").addEventListener("change", (e) => { settings.down = +e.target.value; render(); });
  document.getElementById("taxes-input").addEventListener("change", (e) => { settings.taxes = e.target.checked; render(); });

  document.querySelectorAll("#rank-table th").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      state.sort = { col, dir: state.sort.col === col ? -state.sort.dir : (col === "name" || col === "size_rank" ? 1 : -1) };
      renderRankings();
    });
  });
  const tbody = document.querySelector("#rank-table tbody");
  const choose = (tr) => { if (tr) { selectMetro(tr.dataset.key); window.scrollTo({ top: 0, behavior: "smooth" }); } };
  tbody.addEventListener("click", (e) => choose(e.target.closest("tr")));
  tbody.addEventListener("keydown", (e) => { if (e.key === "Enter") choose(e.target.closest("tr")); });

  window.addEventListener("hashchange", () => { const k = keyFromHash(); if (k !== state.key) selectMetro(k, { push: false }); });
  // Charts read colors from CSS variables, so redraw when the OS theme changes.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
}

function syncRangeButtons() {
  document.querySelectorAll(".segmented button").forEach((b) =>
    b.setAttribute("aria-checked", String(+b.dataset.range === settings.range)));
}

async function init() {
  bindControls();
  syncRangeButtons();
  try {
    state.metros = await getJSON("/api/metros");
  } catch (e) {
    document.getElementById("metro-title").textContent = "Data not available";
    document.getElementById("metro-note").textContent = e.message;
    return;
  }
  const list = document.getElementById("metro-list");
  state.metros.forEach((m) => {
    state.byKey.set(m.key, m);
    state.byName.set(m.name.toLowerCase(), m.key);
    list.append(el("option", { value: m.name }));
  });

  await selectMetro(keyFromHash(), { push: false });

  getJSON("/api/rankings?limit=100").then((rows) => { state.rankings = rows; renderRankings(); });
}

init();
