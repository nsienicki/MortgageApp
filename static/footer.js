"use strict";
// Fills the shared footer's freshness line on every page.
(async () => {
  const target = document.getElementById("freshness");
  if (!target) return;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const period = (p) => (/^\d{4}-\d{2}$/.test(p) ? `${MONTHS[+p.slice(5) - 1]} ${p.slice(0, 4)}` : p);
  const LABELS = {
    "Zillow ZHVI": "home values",
    "Redfin market tracker": "listings and sales",
    "Zillow ZHVI by ZIP and neighborhood": "ZIP and neighborhood values",
    "FHFA House Price Index": "same-home prices",
    "Freddie Mac PMMS": "mortgage rates",
    "Median household income": "income",
  };
  try {
    const res = await fetch("/api/meta");
    if (!res.ok) return;
    const meta = await res.json();
    const [y, m, d] = meta.updated.split("-").map(Number);
    const updated = new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const latest = meta.sources.map((s) => `${LABELS[s.source] || s.source} through ${period(s.latest)}`);
    target.textContent = `Updated ${updated}. Latest data: ${latest.join(", ")}.`;
  } catch (e) {
    // The footer line is optional; leave it empty if the request fails.
  }
})();
