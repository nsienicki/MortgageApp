"use strict";

const MAX_METROS = 4;

const cmp = {
  metros: [],
  byKey: new Map(),
  byName: new Map(),
  slots: Array(MAX_METROS).fill(null),  // metro key per color slot; a metro keeps its color until removed
  cache: new Map(),                     // key -> /api/metro response
};

// ---------- selection ----------
function selected() {
  return cmp.slots
    .map((key, slot) => (key && cmp.cache.has(key) ? { key, slot, d: cmp.cache.get(key), color: `--series-${slot + 1}` } : null))
    .filter(Boolean);
}

function displayName(key, sel) {
  if (key === US_KEY) return "U.S.";
  const name = cmp.byKey.get(key).name;
  const city = name.split(",")[0];
  // Use the full name when two selected metros share a city name (e.g. Portland, OR and Portland, ME).
  const clash = sel.some((s) => s.key !== key && s.key !== US_KEY && cmp.byKey.get(s.key).name.split(",")[0] === city);
  return clash ? name : city;
}

async function addMetro(key) {
  if (!cmp.byKey.has(key) || cmp.slots.includes(key)) return;
  const slot = cmp.slots.indexOf(null);
  if (slot < 0) return;
  cmp.slots[slot] = key;
  renderChips();
  if (!cmp.cache.has(key)) {
    document.querySelectorAll(".plot").forEach((p) => p.classList.add("loading"));
    try {
      cmp.cache.set(key, await getJSON(`/api/metro/${encodeURIComponent(key)}`));
    } catch (e) {
      cmp.slots[slot] = null;
    }
    document.querySelectorAll(".plot").forEach((p) => p.classList.remove("loading"));
  }
  writeHash();
  render();
}

function removeMetro(slot) {
  cmp.slots[slot] = null;
  writeHash();
  render();
}

function writeHash() {
  const keys = cmp.slots.map((k) => (k ? encodeURIComponent(k) : ""));
  while (keys.length && !keys[keys.length - 1]) keys.pop();
  history.replaceState(null, "", keys.length ? `#m=${keys.join("~")}` : "#");
}

function readHash() {
  const m = location.hash.match(/m=([^&]*)/);
  if (!m) return [];
  return m[1].split("~").slice(0, MAX_METROS).map((k) => (k ? decodeURIComponent(k) : null));
}

// ---------- chips and empty state ----------
function renderChips() {
  const sel = cmp.slots.map((key, slot) => (key ? { key, slot } : null)).filter(Boolean);
  const chips = document.getElementById("chips");
  chips.replaceChildren(...sel.map(({ key, slot }) => {
    const chip = el("span", { class: "chip" });
    const swatch = el("span", { class: "key" });
    swatch.style.background = css(`--series-${slot + 1}`);
    const name = cmp.byKey.get(key).name;
    const link = el("a", { href: `/#metro=${encodeURIComponent(key)}`, title: `Open ${name} in the dashboard` }, name);
    const remove = el("button", { type: "button", "aria-label": `Remove ${name}` }, "×");
    remove.addEventListener("click", () => removeMetro(slot));
    chip.append(swatch, link, remove);
    return chip;
  }));
  const left = MAX_METROS - sel.length;
  document.getElementById("slots-left").textContent = left ? `(${left} more)` : "(4 of 4; remove one to add another)";
  document.getElementById("add-input").disabled = left === 0;
}

function renderSuggestions() {
  const picks = cmp.metros.filter((m) => m.region_type === "msa").slice(0, 8);
  picks.push(cmp.byKey.get(US_KEY));
  document.getElementById("suggestions").replaceChildren(...picks.map((m) => {
    const b = el("button", { type: "button", class: "button" }, m.key === US_KEY ? "United States (baseline)" : m.name);
    b.addEventListener("click", () => addMetro(m.key));
    return b;
  }));
}

// ---------- alignment helpers ----------
/** Union of period labels across series, in time order, limited to the selected range. */
function periodAxis(seriesList, quarterly) {
  const toMonth = quarterly ? quarterMonth : (m) => m;
  const cut = cutoffMonth();
  const all = new Set();
  seriesList.forEach((s) => s.periods.forEach((p) => { if (toMonth(p) >= cut) all.add(p); }));
  return [...all].sort((a, b) => (toMonth(a) < toMonth(b) ? -1 : toMonth(a) > toMonth(b) ? 1 : 0));
}

function align(labels, periods, values) {
  const map = new Map(periods.map((p, i) => [p, values[i]]));
  return labels.map((l) => (map.has(l) ? map.get(l) : null));
}

/** One chart with a line per selected metro. `pick(d, aff)` returns {periods, values}. */
function compareChart(name, sel, pick, opts = {}) {
  const series = sel.map((s) => ({ ...s, ...pick(s.d, s.aff) }));
  const labels = periodAxis(series, opts.quarterly);
  const datasets = series.map((s) => ({
    label: s.label,
    data: opts.transform ? opts.transform(align(labels, s.periods, s.values)) : align(labels, s.periods, s.values),
    colorVar: s.color,
  }));
  renderChart(name, labels, datasets, { ...opts, periodLabel: opts.quarterly ? "Quarter" : "Month" });
}

const rebase = (values) => {
  const base = values.find((v) => v != null);
  return values.map((v) => (v == null || !base ? null : (v / base) * 100));
};

function sameHomeYoY(d) {
  const f = d.fhfa;
  const byMonth = new Map(f.month.map((m, i) => [m, f.value[i]]));
  const periods = [];
  const values = [];
  f.month.forEach((m, i) => {
    const prev = byMonth.get(`${+m.slice(0, 4) - 1}${m.slice(4)}`);
    if (prev) {
      periods.push(`Q${(+m.slice(5) - 1) / 3 + 1} ${m.slice(0, 4)}`);
      values.push(f.value[i] / prev - 1);
    }
  });
  return { periods, values };
}

function monthsBack(month, years) {
  return `${+month.slice(0, 4) - years}${month.slice(4)}`;
}

// ---------- at a glance ----------
function glanceRows() {
  const pctChange = (months, values, years) => {
    const last = lastValid(months, values);
    if (!last.month) return { value: null };
    const i = months.indexOf(monthsBack(last.month, years));
    return { value: i >= 0 && values[i] ? last.value / values[i] - 1 : null, asof: last.month };
  };
  const latest = (months, values) => { const l = lastValid(months, values); return { value: l.value, asof: l.month }; };
  return [
    { group: "Prices" },
    { label: "Typical home value", fmt: fmtMoney, get: (d) => latest(d.zhvi.month, d.zhvi.value) },
    { label: "Change over 1 year", fmt: fmtSignedPct, get: (d) => pctChange(d.zhvi.month, d.zhvi.value, 1) },
    { label: "Change over 5 years", fmt: fmtSignedPct, get: (d) => pctChange(d.zhvi.month, d.zhvi.value, 5) },
    { label: "Median sale price", fmt: fmtMoney, get: (d) => latest(d.redfin.month, d.redfin.median_sale_price) },
    { group: "Is it the homes or the mix?" },
    { label: "Same-home price, change over 1 year", fmt: fmtSignedPct, get: (d) => {
      const s = sameHomeYoY(d);
      return { value: s.values[s.values.length - 1] ?? null, asof: s.periods[s.periods.length - 1] };
    } },
    { label: "Mix gap", fmt: fmtPts, get: (d) => ({ value: d.mix.latest?.mix_gap ?? null, asof: d.mix.latest?.quarter }) },
    { label: "Verdict", fmt: (v) => v, text: true, get: (d) => ({
      value: d.mix.latest ? mixVerdict(d.mix.latest).headline : null, asof: d.mix.latest?.quarter }) },
    { group: "Affordability" },
    { label: "Est. monthly payment", fmt: fmtMoney, get: (d, aff) => latest(aff.month, aff.payment) },
    { label: "Payment / income", fmt: (v) => fmtPct(v, 0), get: (d, aff) => latest(aff.month, aff.burden) },
    { group: "Competition" },
    { label: "Median days on market", fmt: fmtDays, get: (d) => latest(d.redfin.month, d.redfin.median_dom) },
    { label: "Sale-to-list ratio", fmt: (v) => fmtPct(v), get: (d) => latest(d.redfin.month, d.redfin.sale_to_list) },
    { label: "Months of supply", fmt: (v) => (v == null ? "–" : v.toFixed(1)), get: (d) => latest(d.redfin.month, d.redfin.months_of_supply) },
    { label: "Listings with a price cut", fmt: (v) => fmtPct(v, 0), get: (d) => latest(d.redfin.month, d.redfin.price_drops) },
    { label: "Homes for sale vs a year ago", fmt: (v) => fmtSignedPct(v, 0), get: (d) => pctChange(d.redfin.month, d.redfin.inventory, 1) },
  ];
}

function renderGlance(sel) {
  const table = document.getElementById("glance");
  const head = el("tr");
  head.append(el("th", { scope: "col" }, "Measure"));
  sel.forEach((s) => {
    const th = el("th", { scope: "col" });
    const key = el("span", { class: "key" });
    key.style.background = css(s.color);
    th.append(key, document.createTextNode(s.key === US_KEY ? "United States" : cmp.byKey.get(s.key).name));
    head.append(th);
  });
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  glanceRows().forEach((row) => {
    const tr = el("tr");
    if (row.group) {
      tr.className = "group-row";
      tr.append(el("th", { scope: "rowgroup", colspan: String(sel.length + 1) }, row.group));
      tbody.append(tr);
      return;
    }
    const cells = sel.map((s) => row.get(s.d, s.aff));
    const asofs = [...new Set(cells.map((c) => c.asof).filter(Boolean))];
    const th = el("th", { scope: "row" });
    th.append(document.createTextNode(row.label));
    if (asofs.length) th.append(el("span", { class: "asof" }, asofs.length === 1 ? fmtMonth(asofs[0]) : "Latest available"));
    tr.append(th);
    cells.forEach((c) => {
      const td = el("td", { class: row.text ? "verdict-cell" : "val" }, c.value == null ? "–" : row.fmt(c.value));
      if (asofs.length > 1 && c.asof) td.append(el("span", { class: "asof" }, fmtMonth(c.asof)));
      tr.append(td);
    });
    tbody.append(tr);
  });
  table.replaceChildren(thead, tbody);
}

// ---------- page ----------
function render() {
  renderChips();
  const sel = selected();
  document.getElementById("empty-state").hidden = sel.length > 0;
  document.getElementById("compare-content").hidden = sel.length === 0;
  if (!sel.length) return;

  sel.forEach((s) => { s.aff = affordability(s.d); s.label = displayName(s.key, sel); });
  document.title = `${sel.map((s) => s.label).join(" vs ")} · Compare · Homebuyer Market Lens`;
  renderGlance(sel);

  const noRedfin = "No listing data for the selected areas.";
  compareChart("c-value", sel, (d) => ({ periods: d.zhvi.month, values: d.zhvi.value }),
    { fmt: fmtMoney, axisFmt: fmtMoneyShort });
  compareChart("c-growth", sel, (d) => ({ periods: d.zhvi.month, values: d.zhvi.value }),
    { transform: rebase, fmt: (v) => (v == null ? "–" : v.toFixed(1)), axisFmt: (v) => v, ref: { value: 100, label: "Start of range" } });
  compareChart("c-samehome", sel, (d) => sameHomeYoY(d),
    { quarterly: true, fmt: fmtSignedPct, axisFmt: (x) => fmtPct(x, 0), ref: { value: 0, label: "No change" } });
  compareChart("c-gap", sel, (d) => ({ periods: d.mix.history.quarter, values: d.mix.history.mix_gap }),
    { quarterly: true, fmt: fmtPts, axisFmt: (x) => (x * 100).toFixed(0) + " pts", ref: { value: 0, label: "No mix effect" },
      emptyText: "Not enough sales data for the selected areas." });

  const downLabel = fmtPct(settings.down, settings.down < 0.1 ? 1 : 0);
  document.getElementById("c-payment-sub").textContent =
    `30-year fixed, ${downLabel} down, ${settings.taxes ? "principal, interest, taxes & insurance" : "principal & interest only"}`;
  compareChart("c-payment", sel, (d, aff) => ({ periods: aff.month, values: aff.payment }),
    { fmt: fmtMoney, axisFmt: fmtMoneyShort });
  compareChart("c-burden", sel, (d, aff) => ({ periods: aff.month, values: aff.burden }),
    { fmt: (x) => fmtPct(x), axisFmt: (x) => fmtPct(x, 0), ref: { value: 0.30, label: "30% guideline" }, yMin: 0 });
  const national = sel.filter((s) => s.key !== US_KEY && !s.d.income.is_local).map((s) => s.label);
  document.getElementById("c-burden-sub").textContent = national.length
    ? `Uses the U.S. median income for ${national.join(", ")}, so differences here reflect prices, not local incomes. Dashed line: 30% guideline.`
    : "Each area's own median household income. Dashed line: 30% guideline.";

  compareChart("c-dom", sel, (d) => ({ periods: d.redfin.month, values: d.redfin.median_dom }),
    { fmt: fmtDays, axisFmt: (x) => x, yMin: 0, emptyText: noRedfin });
  compareChart("c-stl", sel, (d) => ({ periods: d.redfin.month, values: d.redfin.sale_to_list }),
    { fmt: (x) => fmtPct(x), axisFmt: (x) => fmtPct(x, 0), ref: { value: 1, label: "List price" }, emptyText: noRedfin });
  compareChart("c-supply", sel, (d) => ({ periods: d.redfin.month, values: d.redfin.months_of_supply }),
    { fmt: (x) => (x == null ? "–" : x.toFixed(1) + " months"), axisFmt: (x) => x, yMin: 0, emptyText: noRedfin });
  compareChart("c-drops", sel, (d) => ({ periods: d.redfin.month, values: d.redfin.price_drops }),
    { fmt: (x) => fmtPct(x), axisFmt: (x) => fmtPct(x, 0), yMin: 0, emptyText: noRedfin });
}

function syncRangeButtons() {
  document.querySelectorAll(".segmented button").forEach((b) =>
    b.setAttribute("aria-checked", String(+b.dataset.range === settings.range)));
}

function bindControls() {
  const input = document.getElementById("add-input");
  const pick = () => {
    const key = cmp.byName.get(input.value.trim().toLowerCase());
    if (key) { input.value = ""; addMetro(key); }
  };
  input.addEventListener("change", pick);
  input.addEventListener("input", () => { if (cmp.byName.has(input.value.trim().toLowerCase())) pick(); });
  document.querySelectorAll(".segmented button").forEach((btn) => btn.addEventListener("click", () => {
    settings.range = +btn.dataset.range;
    syncRangeButtons();
    render();
  }));
  document.getElementById("down-input").addEventListener("change", (e) => { settings.down = +e.target.value; render(); });
  document.getElementById("taxes-input").addEventListener("change", (e) => { settings.taxes = e.target.checked; render(); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
}

async function init() {
  bindControls();
  syncRangeButtons();
  try {
    cmp.metros = await getJSON("/api/metros");
  } catch (e) {
    document.getElementById("empty-state").hidden = false;
    document.getElementById("suggestions").replaceChildren(el("p", { class: "note" }, "The metro list couldn't be loaded. Please try again shortly."));
    return;
  }
  const list = document.getElementById("metro-list");
  cmp.metros.forEach((m) => {
    cmp.byKey.set(m.key, m);
    cmp.byName.set(m.name.toLowerCase(), m.key);
    list.append(el("option", { value: m.name }));
  });
  renderSuggestions();

  const wanted = readHash().map((k) => (k && cmp.byKey.has(k) ? k : null));
  wanted.forEach((k, i) => { cmp.slots[i] = k; });
  await Promise.all(wanted.filter(Boolean).map(async (k) => {
    try { cmp.cache.set(k, await getJSON(`/api/metro/${encodeURIComponent(k)}`)); } catch (e) { /* dropped below */ }
  }));
  cmp.slots = cmp.slots.map((k) => (k && cmp.cache.has(k) ? k : null));
  writeHash();
  render();
}

init();
