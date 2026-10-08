"use strict";
// Shared by every page with charts: formatting, chart drawing, payment math and range helpers.

const US_KEY = "united states";
const LOAN_MONTHS = 360;
const TAX_INSURANCE_RATE = 0.015; // annual, as a share of home value

// Page-wide settings, changed by the filter controls.
const settings = {
  range: 120,   // months; 0 = all
  down: 0.10,   // down payment, share of price
  taxes: true,  // include property taxes and insurance in payments
};
const charts = {};

// ---------- formatting ----------
const fmtMoney = (v) => v == null ? "–" : "$" + Math.round(v).toLocaleString("en-US");
const fmtMoneyShort = (v) => {
  if (v == null) return "–";
  const a = Math.abs(v);
  if (a >= 1e6) return "$" + (v / 1e6).toFixed(a >= 1e7 ? 0 : 2).replace(/\.?0+$/, "") + "M";
  if (a >= 1e4) return "$" + Math.round(v / 1e3) + "K";
  if (a >= 1e3) return "$" + (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return "$" + Math.round(v);
};
const fmtPct = (v, d = 1) => v == null ? "–" : (v * 100).toFixed(d) + "%";
const fmtRate = (v) => v == null ? "–" : v.toFixed(2) + "%";
const fmtNum = (v) => v == null ? "–" : Math.round(v).toLocaleString("en-US");
const fmtDays = (v) => v == null ? "–" : Math.round(v) + " days";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const isMonth = (m) => /^\d{4}-\d{2}$/.test(m);
const fmtMonth = (m) => !isMonth(m) ? (m || "") : MONTHS[+m.slice(5, 7) - 1] + " " + m.slice(0, 4);
/** Signed number text; values that round to zero get no sign (never "−0.0"). */
function signedText(v, shown) {
  const sign = +shown === 0 ? "" : v > 0 ? "+" : "−";
  return sign + shown;
}
const fmtPts = (v) => v == null ? "–" : signedText(v, Math.abs(v * 100).toFixed(1)) + " pts";
const fmtSignedPct = (v, d = 1) => v == null ? "–" : signedText(v, Math.abs(v * 100).toFixed(d)) + "%";
const fmtSignedMoney = (v) => v == null ? "–" : signedText(v, String(Math.round(Math.abs(v)))).replace(/\d+/, (n) => "$" + (+n).toLocaleString("en-US"));

function signed(v, fmt) {
  if (v == null || !isFinite(v)) return null;
  const text = fmt(Math.abs(v));
  const isZero = !/[1-9]/.test(text);  // rounds to zero, e.g. "0.0 pts"
  const arrow = isZero ? "■" : v > 0 ? "▲" : "▼";
  return `${arrow} ${text}`;
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

// ---------- chart plugins ----------
// Vertical hairline at the hovered month.
const crosshair = {
  id: "crosshair",
  afterDatasetsDraw(chart) {
    const active = chart.tooltip && chart.tooltip.getActiveElements();
    if (!active || !active.length) return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;
    ctx.save();
    ctx.strokeStyle = css("--muted");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// Dashed horizontal reference line, e.g. the 30% affordability guideline.
const refLine = {
  id: "refLine",
  beforeDatasetsDraw(chart, _args, opts) {
    if (opts == null || opts.value == null) return;
    const { ctx, chartArea, scales } = chart;
    const y = scales.y.getPixelForValue(opts.value);
    if (y < chartArea.top || y > chartArea.bottom) return;
    ctx.save();
    ctx.strokeStyle = css("--ref");
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = css("--text-2");
    ctx.font = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
    ctx.textBaseline = "bottom";
    ctx.fillText(opts.label, chartArea.left + 6, y - 3);
    ctx.restore();
  },
};

// Name each series at its last point when there is more than one.
const endLabels = {
  id: "endLabels",
  afterDatasetsDraw(chart) {
    const sets = chart.data.datasets;
    if (sets.length < 2 || chart.config.type !== "line") return;
    const { ctx } = chart;
    const labels = [];
    sets.forEach((ds, i) => {
      const pts = chart.getDatasetMeta(i).data;
      let j = ds.data.length - 1;
      while (j >= 0 && ds.data[j] == null) j--;
      if (j >= 0) labels.push({ text: ds.label, x: pts[j].x + 8, y: pts[j].y });
    });
    labels.sort((a, b) => a.y - b.y);
    for (let k = 1; k < labels.length; k++) labels[k].y = Math.max(labels[k].y, labels[k - 1].y + 14);
    // If the stack ran past the bottom of the plot, shift it back up.
    const overflow = labels.length ? labels[labels.length - 1].y - chart.chartArea.bottom : 0;
    if (overflow > 0) labels.forEach((l) => { l.y -= overflow; });
    ctx.save();
    ctx.font = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
    ctx.fillStyle = css("--text-2");
    ctx.textBaseline = "middle";
    labels.forEach((l) => ctx.fillText(l.text, l.x, l.y));
    ctx.restore();
  },
};

// Value at the end of each bar; small bars get it outside.
const barLabels = {
  id: "barLabels",
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.fmt || chart.config.type !== "bar") return;
    const { ctx } = chart;
    const horizontal = chart.options.indexAxis === "y";
    ctx.save();
    ctx.font = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
    ctx.fillStyle = css("--text-2");
    chart.data.datasets.forEach((ds, i) => {
      chart.getDatasetMeta(i).data.forEach((bar, j) => {
        const v = ds.data[j];
        if (v == null) return;
        const text = opts.fmt(v);
        if (horizontal) {
          ctx.textBaseline = "middle";
          ctx.textAlign = v < 0 ? "right" : "left";
          ctx.fillText(text, bar.x + (v < 0 ? -6 : 6), bar.y);
        } else {
          ctx.textAlign = "center";
          ctx.textBaseline = v < 0 ? "top" : "bottom";
          ctx.fillText(text, bar.x, bar.y + (v < 0 ? 4 : -4));
        }
      });
    });
    ctx.restore();
  },
};

Chart.register(crosshair, refLine, endLabels, barLabels);

// ---------- chart rendering ----------
/**
 * Draw (or redraw) a chart in the card named `name`.
 * datasets: [{label, data, colorVar}]
 * opts: {type: "line"|"bar", horizontal, barLabels, fmt, axisFmt, ref, yMin, tableFmt, periodLabel, emptyText}
 */
function renderChart(name, labels, datasets, opts = {}) {
  const card = document.querySelector(`[data-chart="${name}"]`);
  const plot = card.querySelector(".plot");
  const canvas = plot.querySelector("canvas");
  plot.querySelector(".empty-msg")?.remove();
  if (charts[name]) { charts[name].destroy(); delete charts[name]; }

  const hasData = labels.length && datasets.some((d) => d.data.some((v) => v != null));
  if (!hasData) {
    plot.append(el("div", { class: "empty-msg" }, opts.emptyText || "No data for this area."));
    card.querySelector(".table-wrap").replaceChildren();
    renderLegend(card, []);
    return;
  }

  const fmt = opts.fmt || fmtNum;
  const axisFmt = opts.axisFmt || fmt;
  const muted = css("--muted");
  const grid = css("--grid");
  const multi = datasets.length > 1;
  const type = opts.type || "line";
  const horizontal = type === "bar" && opts.horizontal;
  const categoryScale = {
    grid: { display: false },
    border: { color: css("--axis") },
    ticks: {
      color: horizontal ? css("--text-2") : muted, maxRotation: 0, autoSkip: !horizontal,
      maxTicksLimit: horizontal ? undefined : Math.max(3, Math.min(7, Math.floor(plot.clientWidth / 95))),
      callback(v) { return fmtMonth(this.getLabelForValue(v)); },
    },
  };
  const valueScale = {
    min: opts.yMin,
    grid: { color: grid, drawTicks: false },
    border: { display: false },
    grace: horizontal ? "30%" : type === "bar" ? "12%" : 0,
    ticks: { color: muted, padding: 8, maxTicksLimit: 6, callback: (v) => axisFmt(v) },
  };

  charts[name] = new Chart(canvas, {
    type,
    data: {
      labels,
      datasets: datasets.map((d) => (type === "bar" ? {
        label: d.label,
        data: d.data,
        backgroundColor: css(d.colorVar || "--series-1"),
        hoverBackgroundColor: css(d.colorVar || "--series-1"),
        borderRadius: 4,
        borderSkipped: false,
        maxBarThickness: horizontal ? 18 : 28,
        categoryPercentage: 0.8,
        barPercentage: 0.9,
      } : {
        label: d.label,
        data: d.data,
        borderColor: css(d.colorVar || "--series-1"),
        backgroundColor: css(d.colorVar || "--series-1"),
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: css("--surface"),
        tension: 0,
        spanGaps: true,
      })),
    },
    options: {
      maintainAspectRatio: false,
      animation: false,
      indexAxis: horizontal ? "y" : "x",
      interaction: { mode: "index", intersect: false },
      layout: { padding: { right: multi && type === "line" ? 96 : horizontal ? 56 : 8, top: 4 } },
      scales: horizontal ? { y: categoryScale, x: valueScale } : { x: categoryScale, y: valueScale },
      plugins: {
        legend: { display: false },
        refLine: opts.ref || null,
        barLabels: opts.barLabels ? { fmt: opts.barLabels } : null,
        tooltip: {
          backgroundColor: css("--tooltip-bg"),
          titleColor: css("--text-2"),
          bodyColor: css("--text"),
          borderColor: css("--border"),
          borderWidth: 1,
          padding: 10,
          boxWidth: 12,
          boxHeight: 2,
          titleFont: { weight: "normal" },
          bodyFont: { weight: "600" },
          callbacks: {
            title: (items) => fmtMonth(items[0].label),
            label: (item) => `${fmt(item.raw)}  ${multi ? item.dataset.label : ""}`.trim(),
          },
        },
      },
    },
  });

  renderLegend(card, multi ? datasets : []);
  renderTable(card, labels, datasets, opts.tableFmt || fmt, opts.periodLabel);
}

function renderLegend(card, datasets) {
  const legend = card.querySelector(".legend");
  if (!legend) return;
  legend.replaceChildren(...datasets.map((d) => {
    const item = el("span");
    const key = el("span", { class: "key" });
    key.style.background = css(d.colorVar || "--series-1");
    item.append(key, document.createTextNode(d.label));
    return item;
  }));
}

function renderTable(card, labels, datasets, fmt, periodLabel = "Period") {
  const table = el("table");
  const head = el("tr");
  head.append(el("th", {}, periodLabel), ...datasets.map((d) => el("th", { class: "num" }, d.label)));
  const thead = el("thead");
  thead.append(head);
  table.append(thead);
  const body = el("tbody");
  for (let i = labels.length - 1; i >= 0; i--) {
    const tr = el("tr");
    tr.append(el("td", {}, fmtMonth(labels[i])));
    datasets.forEach((d) => tr.append(el("td", { class: "num" }, fmt(d.data[i]))));
    body.append(tr);
  }
  table.append(body);
  card.querySelector(".table-wrap").replaceChildren(table);
}

// ---------- derived metrics ----------
function monthlyPayment(price, ratePct) {
  const loan = price * (1 - settings.down);
  const r = ratePct / 100 / 12;
  const pi = r === 0 ? loan / LOAN_MONTHS : (loan * r) / (1 - Math.pow(1 + r, -LOAN_MONTHS));
  return pi + (settings.taxes ? (price * TAX_INSURANCE_RATE) / 12 : 0);
}

/** Align ZHVI, mortgage rates and income by month and compute payment and payment-to-income. */
function affordability(d) {
  const rateByMonth = new Map(d.rates.month.map((m, i) => [m, d.rates.rate_30y[i]]));
  const incomeByYear = new Map(d.income.year.map((y, i) => [y, d.income.value[i]]));
  const maxIncomeYear = Math.max(...d.income.year);
  const minIncomeYear = Math.min(...d.income.year);
  let lastRate = null;
  const out = { month: [], value: [], rate: [], payment: [], income: [], burden: [], incomeCarried: false };
  d.zhvi.month.forEach((m, i) => {
    if (rateByMonth.has(m)) lastRate = rateByMonth.get(m);
    const year = +m.slice(0, 4);
    if (year < minIncomeYear || lastRate == null) return;
    const incYear = Math.min(year, maxIncomeYear);
    if (year > maxIncomeYear) out.incomeCarried = true;
    const income = incomeByYear.get(incYear) ?? null;
    const value = d.zhvi.value[i];
    const payment = monthlyPayment(value, lastRate);
    out.month.push(m);
    out.value.push(value);
    out.rate.push(lastRate);
    out.payment.push(payment);
    out.income.push(income);
    out.burden.push(income ? payment / (income / 12) : null);
  });
  out.maxIncomeYear = maxIncomeYear;
  return out;
}

// ---------- range helpers ----------
function cutoffMonth() {
  if (!settings.range) return "0000-00";
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - settings.range, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function sliceSeries(months, ...arrays) {
  const cut = cutoffMonth();
  const start = months.findIndex((m) => m >= cut);
  const s = start < 0 ? months.length : start;
  return [months.slice(s), ...arrays.map((a) => a.slice(s))];
}

/** Value one year before the last entry of a monthly series. */
function yearAgo(months, values) {
  const last = months[months.length - 1];
  if (!last) return null;
  const target = `${+last.slice(0, 4) - 1}${last.slice(4)}`;
  const i = months.indexOf(target);
  return i < 0 ? null : values[i];
}

function lastValid(months, values) {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return { month: months[i], value: values[i], i };
  return { month: null, value: null, i: -1 };
}

// ---------- "Is it the homes or the mix?" ----------
// Thresholds for the verdict; the Discussion page explains them.
const FLAT_THRESHOLD = 0.01;   // same-home change within ±1% counts as "about steady"
const GAP_THRESHOLD = 0.015;   // a mix gap within ±1.5 points counts as "no meaningful mix effect"

function quarterMonth(q) {
  const [qq, y] = q.split(" ");
  return `${y}-${String((+qq.slice(1) - 1) * 3 + 1).padStart(2, "0")}`;
}

function mixVerdict(m) {
  const c = m.hpi_yoy;
  const gap = m.mix_gap;
  const steady = Math.abs(c) < FLAT_THRESHOLD;
  const valueText = steady ? `held about steady (${fmtSignedPct(c)})` : `${c > 0 ? "rose" : "fell"} ${fmtPct(Math.abs(c))}`;
  const medianText = `${m.median_yoy < 0 ? "fell" : "rose"} ${fmtPct(Math.abs(m.median_yoy))}`;
  if (Math.abs(gap) < GAP_THRESHOLD) {
    return {
      kind: "value",
      headline: steady ? "Stable: values and the median both held steady"
        : c > 0 ? "A genuine rise in value" : "A genuine decline in value",
      detail: `Comparable homes ${valueText}, and the median sale price ${medianText}. ` +
        "Changes in which homes sold made little difference.",
    };
  }
  const cheaper = gap < 0;
  const pts = `${Math.abs(gap * 100).toFixed(1)}-point`;
  return {
    kind: "mix",
    headline: steady
      ? `Mostly mix: ${cheaper ? "cheaper" : "pricier"} homes are selling, while values held`
      : `Both: values ${c > 0 ? "rose" : "fell"}, and the mix of sales ${cheaper ? "pulled the median down" : "pushed the median up"}`,
    detail: `The median sale price ${medianText}, but comparable homes ${valueText}. ` +
      `The ${pts} gap comes from ${cheaper ? "a cheaper" : "a pricier"} mix of homes selling than a year earlier.`,
  };
}

// ---------- data loading ----------
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
  return res.json();
}
