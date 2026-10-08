"use strict";

const view = {
  tables: [],
  name: null,
  q: "",
  sort: "",
  dir: "asc",
  offset: 0,
  limit: 50,
};
let searchTimer = null;

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

const fmtCount = (n) => n.toLocaleString("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtPeriod = (p) => (/^\d{4}-\d{2}$/.test(p) ? `${MONTHS[+p.slice(5) - 1]} ${p.slice(0, 4)}` : p);

function fmtCell(v, type, column) {
  if (v == null) return "";
  if (typeof v === "number") {
    if (column === "year") return String(v);
    return v.toLocaleString("en-US", { maximumFractionDigits: /INT/.test(type) ? 0 : 4 });
  }
  return String(v);
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  return res.json();
}

// ---------- table list ----------
function renderList() {
  const nav = document.getElementById("table-list");
  const groups = [...new Set(view.tables.map((t) => t.group))];
  nav.replaceChildren(...groups.map((g) => {
    const section = el("div", { class: "table-group" });
    section.append(el("h2", {}, g));
    view.tables.filter((t) => t.group === g).forEach((t) => {
      const btn = el("button", { type: "button", "data-name": t.name });
      if (t.name === view.name) btn.setAttribute("aria-current", "true");
      const top = el("span", { class: "tl-label" }, t.label);
      const sub = el("span", { class: "tl-sub" });
      sub.append(el("code", {}, t.name), document.createTextNode(` · ${fmtCount(t.rows)} ${t.rows === 1 ? "row" : "rows"}`));
      btn.append(top, sub);
      btn.addEventListener("click", () => selectTable(t.name));
      section.append(btn);
    });
    return section;
  }));
}

// ---------- detail ----------
function renderDetail() {
  const t = view.tables.find((x) => x.name === view.name);
  const root = document.getElementById("detail");
  if (!t) { root.replaceChildren(el("p", { class: "note" }, "Choose a dataset.")); return; }

  const head = el("header", { class: "detail-head" });
  const title = el("h2");
  title.textContent = t.label;
  head.append(title);

  const src = el("p", { class: "source-line" });
  src.append(el("span", { class: "source-tag" }, "Source"));
  if (t.source.url) {
    src.append(el("a", { href: t.source.url, target: "_blank", rel: "noopener" }, t.source.name));
  } else {
    src.append(document.createTextNode(t.source.name));
  }
  head.append(src, el("p", { class: "dataset" }, t.dataset));

  const stats = el("dl", { class: "stats" });
  const stat = (k, v) => { const d = el("div"); d.append(el("dt", {}, k), el("dd", {}, v)); stats.append(d); };
  const idCell = el("div");
  const idValue = el("dd");
  idValue.append(el("code", {}, t.name));
  idCell.append(el("dt", {}, "Dataset ID"), idValue);
  stats.append(idCell);
  stat("Rows", fmtCount(t.rows));
  if (t.areas != null) stat("Areas", fmtCount(t.areas));
  if (t.coverage) stat("Covers", `${fmtPeriod(t.coverage.from)} – ${fmtPeriod(t.coverage.to)}`);
  stat("Each row is", t.grain.replace(/^One row/, "one row"));

  const about = el("section", { class: "about" });
  about.append(el("h3", {}, "What it is"), el("p", {}, t.description));
  about.append(el("h3", {}, "How we prepared it"), el("p", {}, t.transform));

  const dict = el("section");
  dict.append(el("h3", {}, "Columns"));
  const dt = el("table", { class: "dict" });
  const dh = el("thead");
  const dhr = el("tr");
  dhr.append(el("th", {}, "Column"), el("th", {}, "Type"), el("th", {}, "Meaning"));
  dh.append(dhr);
  const db = el("tbody");
  t.columns.forEach((c) => {
    const tr = el("tr");
    const name = el("td");
    name.append(el("code", {}, c.name));
    tr.append(name, el("td", { class: "type" }, c.type.toLowerCase()), el("td", { class: "wrap-cell" }, c.description));
    db.append(tr);
  });
  dt.append(dh, db);
  const dictWrap = el("div", { class: "table-wrap card flush dict-wrap" });
  dictWrap.append(dt);
  dict.append(dictWrap);

  const browser = el("section", { class: "browser" });
  browser.append(el("h3", {}, "Rows"));
  const bar = el("div", { class: "toolbar" });
  if (t.filter_column) {
    const lab = el("label", { class: "field grow" });
    const cols = Array.isArray(t.filter_column) ? t.filter_column : [t.filter_column];
    lab.append(el("span", {}, `Filter by ${cols.length > 1 ? cols.slice(0, -1).join(", ") + " or " + cols[cols.length - 1] : cols[0]}`));
    const input = el("input", { type: "search", id: "row-filter", placeholder: "e.g. denver", autocomplete: "off" });
    input.value = view.q;
    input.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { view.q = input.value; view.offset = 0; loadRows(); }, 250);
    });
    lab.append(input);
    bar.append(lab);
  }
  const sizeLab = el("label", { class: "field" });
  sizeLab.append(el("span", {}, "Rows per page"));
  const size = el("select", { id: "page-size" });
  [25, 50, 100, 250].forEach((n) => {
    const o = el("option", { value: String(n) }, String(n));
    if (n === view.limit) o.selected = true;
    size.append(o);
  });
  size.addEventListener("change", () => { view.limit = +size.value; view.offset = 0; loadRows(); });
  sizeLab.append(size);
  const dl = el("a", { class: "button", id: "csv-link" }, "Download CSV");
  bar.append(sizeLab, dl);

  const wrap = el("div", { class: "table-wrap card flush rows-wrap" });
  wrap.append(el("table", { class: "rows", id: "rows-table" }));
  const pager = el("div", { class: "pager" });
  const prev = el("button", { type: "button", id: "prev" }, "← Previous");
  const next = el("button", { type: "button", id: "next" }, "Next →");
  prev.addEventListener("click", () => { view.offset = Math.max(0, view.offset - view.limit); loadRows(); });
  next.addEventListener("click", () => { view.offset += view.limit; loadRows(); });
  pager.append(el("span", { id: "page-info", class: "note" }), prev, next);
  browser.append(bar, wrap, pager);

  root.replaceChildren(head, stats, about, dict, browser);
  document.title = `${t.label} · Data · Homebuyer Market Lens`;
}

function rowsQuery() {
  const p = new URLSearchParams();
  if (view.q.trim()) p.set("q", view.q.trim());
  if (view.sort) { p.set("sort", view.sort); p.set("dir", view.dir); }
  return p;
}

async function loadRows() {
  const t = view.tables.find((x) => x.name === view.name);
  if (!t) return;
  const wrap = document.querySelector(".rows-wrap");
  wrap.classList.add("loading");
  const p = rowsQuery();
  p.set("offset", view.offset);
  p.set("limit", view.limit);
  let data;
  try {
    data = await getJSON(`/api/tables/${t.name}/rows?${p}`);
  } catch (e) {
    document.getElementById("page-info").textContent = "These rows couldn't be loaded. Please try again.";
    wrap.classList.remove("loading");
    return;
  }
  wrap.classList.remove("loading");
  const csv = document.getElementById("csv-link");
  if (data.total > t.csv_max_rows) {
    csv.removeAttribute("href");
    csv.setAttribute("aria-disabled", "true");
    csv.title = `Filter to ${fmtCount(t.csv_max_rows)} rows or fewer to download`;
  } else {
    csv.href = `/api/tables/${t.name}/csv?${rowsQuery()}`;
    csv.removeAttribute("aria-disabled");
    csv.title = "";
  }

  const table = document.getElementById("rows-table");
  const thead = el("thead");
  const hr = el("tr");
  t.columns.forEach((c) => {
    const numeric = /INT|DOUBLE|DECIMAL|FLOAT/.test(c.type);
    const th = el("th", { class: numeric ? "num" : "", title: c.description, tabindex: "0" }, c.name);
    if (view.sort === c.name) th.setAttribute("aria-sort", view.dir === "asc" ? "ascending" : "descending");
    const sortBy = () => {
      view.dir = view.sort === c.name && view.dir === "asc" ? "desc" : "asc";
      view.sort = c.name;
      view.offset = 0;
      loadRows();
    };
    th.addEventListener("click", sortBy);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter") sortBy(); });
    hr.append(th);
  });
  thead.append(hr);
  const tbody = el("tbody");
  data.rows.forEach((r) => {
    const tr = el("tr");
    t.columns.forEach((c) => {
      const numeric = /INT|DOUBLE|DECIMAL|FLOAT/.test(c.type);
      tr.append(el("td", { class: numeric ? "num" : "" }, fmtCell(r[c.name], c.type, c.name)));
    });
    tbody.append(tr);
  });
  if (!data.rows.length) {
    const tr = el("tr");
    tr.append(el("td", { colspan: String(t.columns.length), class: "note" }, "No rows match that filter."));
    tbody.append(tr);
  }
  table.replaceChildren(thead, tbody);

  const from = data.total ? data.offset + 1 : 0;
  const to = data.offset + data.rows.length;
  document.getElementById("page-info").textContent =
    `${fmtCount(from)}–${fmtCount(to)} of ${fmtCount(data.total)} rows` + (view.q.trim() ? ` matching “${view.q.trim()}”` : "");
  if (data.total > t.csv_max_rows) {
    document.getElementById("page-info").textContent +=
      `. Filter to ${fmtCount(t.csv_max_rows)} rows or fewer to download as CSV.`;
  }
  document.getElementById("prev").disabled = data.offset === 0;
  document.getElementById("next").disabled = to >= data.total;
  writeHash();
}

// ---------- navigation ----------
function selectTable(name) {
  if (name !== view.name) {
    view.name = name;
    view.q = "";
    view.sort = "";
    view.dir = "asc";
    view.offset = 0;
  }
  renderList();
  renderDetail();
  loadRows();
}

function writeHash() {
  const p = new URLSearchParams({ table: view.name });
  if (view.q.trim()) p.set("q", view.q.trim());
  history.replaceState(null, "", `#${p}`);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { table: p.get("table"), q: p.get("q") || "" };
}

async function init() {
  try {
    view.tables = await getJSON("/api/tables");
  } catch (e) {
    document.getElementById("detail").replaceChildren(el("p", { class: "note" }, "The datasets couldn't be loaded. Please try again shortly."));
    return;
  }
  const h = readHash();
  const start = view.tables.some((t) => t.name === h.table) ? h.table : view.tables[0].name;
  view.name = start;
  view.q = h.q;
  renderList();
  renderDetail();
  loadRows();
}

init();
