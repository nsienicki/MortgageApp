# Homebuyer Market Lens

A local website for understanding housing markets as a homebuyer: prices, affordability and
competition for each U.S. metro, built only on free public data. The long-term goal is
analyzing price trends by area. The app is served by a local server rather than a notebook or Streamlit.

## Run

```
.venv/Scripts/python.exe ingest.py             # download sources and rebuild data/housing.duckdb (--refresh forces re-download)
.venv/Scripts/python.exe server.py             # http://127.0.0.1:8000, auto-reload on; PORT env var overrides
.venv/Scripts/python.exe -m uvicorn server:app --port 8000   # no reload; use this when running in the background
```
No build step and no tests yet. Check UI changes by screenshotting with headless Edge (see Gotchas).

## Files

- `ingest.py`: downloads to `data/raw/` (reuses copies under 7 days old) and rebuilds the DuckDB file atomically through `.building`
- `catalog.py`: label, source, build notes and column descriptions for every table. **Must stay in sync with `build_db()` in ingest.py.**
- `server.py`: FastAPI app. Routes: `/`, `/neighborhoods`, `/compare`, `/discussion` and `/data` pages;
  `/api/metros`, `/api/metro/{key}`, `/api/metro/{key}/local?type=zip|neighborhood`, `/api/local/{area_id}`,
  `/api/rankings`, `/api/meta`, `/api/tables`, `/api/tables/{name}/rows`, `/api/tables/{name}/csv`.
  `MIX_SQL` (quarterly year-over-year change, four ways, plus the mix gap) and `shift_share()` live here.
- `static/`: plain HTML, CSS and JS; Chart.js 4.4.1 from cdnjs. Five pages, in nav order (Dashboard,
  Neighborhoods, Compare, Discussion, Data):
  - `common.js`: shared by the dashboard and Compare pages: formatters, chart plugins, `renderChart`,
    affordability math, range helpers, `mixVerdict` and thresholds, `getJSON`, and the `settings` object
    (range, down payment, taxes). Load it before the page script.
  - `index.html` + `app.js`: dashboard
  - `neighborhoods.html` + `neighborhoods.js`: ZIP codes or neighborhoods within one metro. Built around
    the data, with no map yet:
    - summary tiles
    - a histogram of 1-year change
    - a scatter of value vs. 5-year change (log x axis)
    - a history chart for the selected area, defaulting to the largest
    - a sortable table with SVG sparklines and a CSV download built in the browser
    - a monthly budget input, which highlights areas and inverts the payment math
    The hash stores `metro`, `type` and `area`.
  - `compare.html` + `compare.js`: up to 4 metros side by side (U.S. allowed as a baseline). Each metro is
    pinned to a color slot (`--series-1` to `--series-4`), so removing one never recolors the others.
    The URL hash stores slots, e.g. `#m=denver%2C%20co~austin%2C%20tx`. It reuses `/api/metro/{key}`; there's
    no compare-specific endpoint.
  - `discussion.html`: static explainer for every measure. Dashboard cards link to its anchors through
    `about-link` (anchor ids must match).
  - `data.html` + `data.js`: public dataset browser
  - shared: `style.css`, `footer.js` (freshness line) and `favicon.svg`. All three pages carry the same
    footer markup (sources with attribution, disclaimer) and nav (Dashboard, Compare, Discussion, Data);
    edit every copy.
- `deploy/`: hosting kit for an IONOS Ubuntu VPS. `deploy/README.md` is the step-by-step guide.
  - `upload.ps1`: run on the PC. Packages only code, scps it, and runs `install_update.sh`, which swaps
    the code in, keeps `app.previous`, restarts and checks `/healthz`.
  - `setup_server.sh`: one-time root setup (packages, `lens` user, venv, env file, first ingest, systemd,
    nginx, ufw, certbot).
  - systemd: `homebuyer-lens.service` (uvicorn, 2 workers, 127.0.0.1:8000) and
    `homebuyer-lens-ingest.service`/`.timer` (Mondays 06:00).
  - `nginx.conf`: static files from disk, rate limits; certbot adds HTTPS.
  - Server paths: code `/opt/homebuyer-lens/app`, data `/var/lib/homebuyer-lens`, settings
    `/etc/homebuyer-lens.env`.
  - Requirements are pinned; a new dependency must be added to `requirements.txt`.
  - Keep shell, systemd and conf files LF (`.gitattributes`; `install_update.sh` also strips CR).
- `main.py`: unused PyCharm template (not deployed)
- `data/`: generated, so don't read `data/raw/*`. The Redfin file is 111 MB.

## Data model (DuckDB)

| Table | Source | Grain |
|---|---|---|
| `zhvi` (key, month, value) | Zillow ZHVI, metro, middle tier, seasonally adjusted | metro × month, from 2000 |
| `zhvi_segments` (key, month, segment, value) | Zillow ZHVI by tier (`tier_bottom/middle/top`), `bed_1`–`bed_5`, `sfr`, `condo` | metro × segment × month |
| `redfin` (key, month, 11 metrics incl. `median_ppsf`) | Redfin metro market tracker: All Residential, not seasonally adjusted, 30-day periods | metro × month, from 2012, lags ~3 months |
| `redfin_types` (key, month, property_type, median_sale_price, median_ppsf, homes_sold) | the same Redfin file, per property type (Single-family, Townhouse, Condo/co-op, 2-4 unit) | metro × type × month |
| `local_areas` (area_id, area_type, name, city, county, state, metro_key, size_rank) | Zillow ZIP and neighborhood ZHVI files (the `Metro` column, matched with `census_name_to_key`); only areas inside a metro. ZIP `name` is VARCHAR, so leading zeros stay | 21,048 ZIPs in 894 metros; 21,492 neighborhoods in 339 metros |
| `zhvi_local` (area_id, month, value) | the same files, unpivoted | ~11M rows |
| `fhfa` (key, month, index_nsa, flavor) | FHFA HPI `hpi_master.csv`: traditional, quarterly, expanded-data (purchase-only) preferred over all-transactions; month = first month of the quarter | area × quarter; 378 areas, all of the 100 largest metros |
| `rates` (month, rate_30y) | FRED MORTGAGE30US, weekly averaged to monthly | month |
| `income` (key, year, income, source) | FRED MEHOINUSA646N (national); Census ACS B19013 per metro only if `CENSUS_API_KEY` is set | area × year |
| `metros` (key, name, state, size_rank, region_type) | Zillow region list | area |
| `meta`, `built` | created during ingest | – |

- **Join key:** `key` = lowercase "city, st", e.g. `denver, co`; `united states` is the national row.
  Redfin names drop the " metro area" suffix. Census and FHFA names are matched to Zillow's by their first city
  (`census_name_to_key`; splits on `-` and `/`). For FHFA, a full metro wins over a metro division `(MSAD)`.
- **Months** are stored as the first of the month (Zillow uses month-end dates; ingest converts them).
- Redfin reports the core metro division for big metros (e.g. NY). 876 of 895 Zillow metros match Redfin data.

## Conventions

- **Production behavior lives in `server.py`:**
  - security headers and CSP (scripts only from self and cdnjs, no inline scripts or styles; JS may set
    `element.style`)
  - HSTS when the request came in over HTTPS
  - GZip, and an hour of `Cache-Control` on `/api/`
  - an HTML 404 page for non-API paths, `/healthz` and `/robots.txt`
  - `LENS_DB_PATH` / `LENS_DATA_DIR` / `LENS_INGEST_MEMORY` env vars
  - ingest swaps the database in atomically with `os.replace` (retrying on Windows), so the site
    stays up during a refresh
  - after adding any external script or style, update the CSP in `SECURITY_HEADERS`
- **The site is public-facing.** Visible copy, `catalog.py` text and API error messages must never mention
  scripts, file paths, env vars, DuckDB or other internals. Write in a plain "we" voice.
  Internal problems go to the server console; visitors get a generic message.
  `/docs` and `/openapi.json` are disabled. The internal `built` table isn't in the catalog
  (`/api/meta` exposes only `updated`, a date).
- Keep source attribution in the footer: Zillow Group; "Redfin, a national real estate brokerage";
  FHFA House Price Index; Freddie Mac PMMS via FRED; U.S. Census Bureau via FRED.

- **Affordability is calculated in the browser** (`affordability()` in app.js): 30-year fixed loan at that month's rate, with a down
  payment toggle and taxes plus insurance at 1.5% of value per year. Income for months after the latest survey year reuses that year's figure.
- **Mix analysis ("Is it the homes or the mix?").**
  - The mix gap is the median sale price change minus the same-home (FHFA) change, year over year, for the
    latest quarter that has both.
  - Verdict thresholds are in app.js (`FLAT_THRESHOLD` 1%, `GAP_THRESHOLD` 1.5 points) and are documented in
    the discussion page's `#verdict` table; keep the two in sync.
  - The shift-share split covers only the mix *between* property types. The card flags when it points the
    opposite way from the mix gap.
- **Data page limits:**
  - CSV export refuses more than `CSV_MAX_ROWS` (500k) rows, so `zhvi_local` needs a filter first.
  - `filter_column` in `catalog.py` can be a list (OR'd together, cast to text).
- **Neighborhood lens rules:** show market measures only (values, changes, payments). No neighborhood
  ratings, no demographics (fair-housing steering risk). Redfin ZIP data (1.5 GB) and FHFA ZIP/tract
  indexes are the planned next phases; a map comes after the data.
- **SQL safety:** table and column names come only from `catalog.TABLES` and `DESCRIBE`; user input is passed as parameters.
- **Charts** follow the dataviz skill rules:
  - one y-axis per chart (never two)
  - colors from CSS tokens on `:root` (light and dark): `--series-1` to `--series-4` (blue, orange, green, yellow);
    at most 4 series per chart
  - `renderChart(name, labels, datasets, opts)` draws line charts, or bar charts with `opts.type = "bar"`
    (plus `horizontal` and `barLabels`). Labels in `YYYY-MM` form are shown as months; anything else is shown as-is.
  - legend plus end-of-line labels for two or more series; crosshair tooltip
  - tooltip backgrounds use `--tooltip-bg` (75% opaque surface, defined for light and dark)
  - a "Data table" under every chart
  - insert data into the DOM with `textContent`, never `innerHTML`
- New data source checklist:
  1. download in `SOURCES`
  2. table in `build_db()`
  3. entry in `catalog.py`
  4. `meta` row
  5. API and UI

## Environment gotchas (Windows 11, Python 3.9 venv)

- Python 3.9: no `match` statements and no `X | Y` type hints.
- **Norton antivirus intercepts HTTPS**, so pip and `requests` fail certificate checks. Use `urllib` (it trusts the Windows certificate store).
  For pip, export the Windows certificates to a PEM file and run `pip install --cert <pem>`:
  `ssl.enum_certificates("ROOT"/"CA")` → `ssl.DER_cert_to_PEM_cert`.
- **FRED's `fredgraph.csv` hangs unless the User-Agent is curl's.** ingest sends `curl/8.0`.
- The Census API now requires a key (it returns an HTML "Missing Key" page without one).
- When run as a background task, uvicorn auto-reload stalls on file changes and leaves orphaned processes.
  Run without reload, and kill whatever owns port 8000 before restarting. **Stop any background server
  before handing back to the user**: a leftover one makes their `python server.py` fail with WinError 10013.
  With reload on, the socket is held by a `multiprocessing.spawn` worker that outlives its parent. Kill the
  process that `Get-NetTCPConnection -LocalPort 8000` reports, and its `spawn_main(parent_pid=...)` worker.
  Don't kill the PyCharm `pydevconsole.py` process; that's the user's.
- Long Python patches piped through a bash heredoc can fail to parse in the Bash tool. Write them to a file
  in the scratchpad and run that instead.
- Node.js isn't installed, so the dataviz palette validator can't run from the shell.
- Console printing of DuckDB output fails with cp1252 errors: set `PYTHONIOENCODING=utf-8`.
- **Phone-width checks:** a page overflows if `document.documentElement.scrollWidth` exceeds 375 inside a
  390px iframe. To find the culprit, list elements whose `getBoundingClientRect().right` exceeds the
  viewport. Grid children need `min-width: 0` or `minmax(0, 1fr)`.
- **Screenshots:**
  `"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --hide-scrollbars --window-size=1300,2400 --virtual-time-budget=8000 --screenshot=<png> <url>`.
  Headless Edge has a minimum window width of about 500px, so test phone widths by loading the page in a 390px iframe on a temporary page.
  Add `--blink-settings=preferredColorScheme=1` for light mode.

## Ideas not built yet

HMDA loan approvals and denials by area; ZIP-level shift-share for geographic mix (Redfin ZIP file); Realtor.com inventory; Fannie Mae/Freddie Mac loan-level data;
ZIP-level drill-down; a map view; scheduled weekly refresh; add-to-compare checkboxes in the dashboard's rankings table.
