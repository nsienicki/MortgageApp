"""Web server for the Homebuyer Market Lens site.

Development:  python server.py   then open http://127.0.0.1:8000 (auto-reload on)
Production:   uvicorn server:app --host 127.0.0.1 --port 8000 --workers 2 --proxy-headers
              behind nginx; see deploy/README.md.

Environment variables:
  LENS_DB_PATH   database file (default: data/housing.duckdb next to this file)
  PORT           port for the development server (default 8000)
"""
import os
from pathlib import Path

import duckdb
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from catalog import TABLES

ROOT = Path(__file__).parent
DB_PATH = Path(os.environ.get("LENS_DB_PATH", ROOT / "data" / "housing.duckdb"))
STATIC = ROOT / "static"
API_CACHE_SECONDS = 3600  # data changes weekly; let browsers and nginx reuse API responses for an hour
US_KEY = "united states"

REDFIN_COLUMNS = ["median_sale_price", "median_list_price", "median_ppsf", "homes_sold", "new_listings",
                  "inventory", "months_of_supply", "median_dom", "sale_to_list", "sold_above_list", "price_drops"]

# Year-over-year price change by quarter, four ways: the mix-sensitive median sale price, price per
# square foot, Zillow's all-homes index and FHFA's repeat-sales index. Quarters need all three
# months of Redfin (and Zillow) data. {where} filters both sources to one metro, or nothing.
MIX_SQL = """
    WITH rq AS (
        SELECT key, CAST(date_trunc('quarter', month) AS DATE) AS quarter,
               avg(median_sale_price) AS price, avg(median_ppsf) AS ppsf
        FROM redfin {where}
        GROUP BY ALL HAVING count(median_sale_price) = 3
    ),
    zq AS (
        SELECT key, CAST(date_trunc('quarter', month) AS DATE) AS quarter, avg(value) AS zhvi
        FROM zhvi {where}
        GROUP BY ALL HAVING count(*) = 3
    ),
    q AS (
        SELECT rq.*, f.index_nsa AS hpi, zq.zhvi
        FROM rq
        LEFT JOIN fhfa f ON f.key = rq.key AND f.month = rq.quarter
        LEFT JOIN zq ON zq.key = rq.key AND zq.quarter = rq.quarter
    )
    SELECT c.key, c.quarter,
           c.price / p.price - 1 AS median_yoy,
           c.ppsf / p.ppsf - 1 AS ppsf_yoy,
           c.zhvi / p.zhvi - 1 AS zhvi_yoy,
           c.hpi / p.hpi - 1 AS hpi_yoy,
           c.price / p.price - c.hpi / p.hpi AS mix_gap
    FROM q c JOIN q p ON p.key = c.key AND p.quarter = CAST(c.quarter - INTERVAL 1 YEAR AS DATE)
"""

MIN_SALES_FOR_SHIFT_SHARE = 50  # per quarter; below this the type medians are too noisy
CSV_MAX_ROWS = 500_000          # larger exports must be filtered first
LOCAL_TYPES = ("zip", "neighborhood")

# The site is public-facing: no auto-generated API docs, and errors never mention internals.
app = FastAPI(title="Homebuyer Market Lens", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(GZipMiddleware, minimum_size=1000)


# Pages load scripts only from this site and cdnjs (Chart.js), and talk only to this site's API.
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self'; "
        "img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


@app.middleware("http")
async def response_headers(request: Request, call_next):
    response = await call_next(request)
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    if request.url.scheme == "https":  # set by nginx's X-Forwarded-Proto via --proxy-headers
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
    if request.url.path.startswith("/api/") and response.status_code == 200:
        response.headers.setdefault("Cache-Control", f"public, max-age={API_CACHE_SECONDS}")
    return response


@app.exception_handler(StarletteHTTPException)
async def http_errors(request: Request, exc: StarletteHTTPException):
    """API errors stay JSON; a missing page gets the site's own 404 page."""
    if exc.status_code == 404 and not request.url.path.startswith("/api/"):
        return FileResponse(STATIC / "404.html", status_code=404)
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_errors(request: Request, exc: RequestValidationError):
    return JSONResponse({"detail": "That request isn't valid."}, status_code=422)


def query(sql, params=None):
    if not DB_PATH.exists():
        print(f"ERROR: {DB_PATH} is missing. Build it with: python ingest.py")
        raise HTTPException(503, "Data is temporarily unavailable. Please try again shortly.")
    with duckdb.connect(str(DB_PATH), read_only=True) as con:
        cur = con.execute(sql, params or [])
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def series(rows, *fields):
    """Rows -> {'month': [...], field: [...]}, with dates as 'YYYY-MM'."""
    out = {"month": [r["month"].strftime("%Y-%m") for r in rows]}
    for f in fields:
        out[f] = [None if r[f] is None else round(r[f], 4) for r in rows]
    return out


@app.get("/api/metros")
def metros():
    return query("""
        SELECT m.key, m.name, m.size_rank, m.region_type,
               m.key IN (SELECT DISTINCT key FROM redfin) AS has_redfin
        FROM metros m ORDER BY m.size_rank
    """)


@app.get("/api/metro/{key}")
def metro(key: str):
    key = key.lower()
    info = query("SELECT key, name, size_rank, region_type FROM metros WHERE key = ?", [key])
    if not info:
        raise HTTPException(404, f"Unknown metro: {key}")

    zhvi = query("""
        SELECT month, value FROM zhvi WHERE key = ? ORDER BY month
    """, [key])
    us = query("SELECT month, value FROM zhvi WHERE key = ? ORDER BY month", [US_KEY])
    redfin = query(f"""
        SELECT month, {", ".join(REDFIN_COLUMNS)} FROM redfin WHERE key = ? ORDER BY month
    """, [key])
    rates = query("SELECT month, rate_30y FROM rates ORDER BY month")

    # Prefer the metro's own income series (ACS); otherwise fall back to the national figure.
    income = query("SELECT year, income, source FROM income WHERE key = ? ORDER BY year", [key])
    income_is_local = bool(income)
    if not income:
        income = query("SELECT year, income, source FROM income WHERE key = ? ORDER BY year", [US_KEY])

    mix_rows = query(MIX_SQL.format(where="WHERE key = ?") + " ORDER BY c.quarter", [key, key])
    mix_history = {
        "quarter": [quarter_label(r["quarter"]) for r in mix_rows],
        **{f: [None if r[f] is None else round(r[f], 5) for r in mix_rows]
           for f in ("median_yoy", "ppsf_yoy", "zhvi_yoy", "hpi_yoy", "mix_gap")},
    }
    latest_mix = next((r for r in reversed(mix_rows) if r["hpi_yoy"] is not None), None)

    segments = {}
    for r in query("SELECT segment, month, value FROM zhvi_segments WHERE key = ? ORDER BY segment, month", [key]):
        seg = segments.setdefault(r["segment"], {"month": [], "value": []})
        seg["month"].append(r["month"].strftime("%Y-%m"))
        seg["value"].append(round(r["value"], 2))

    types = {}
    for r in query("""
        SELECT property_type, month, median_sale_price, median_ppsf, homes_sold
        FROM redfin_types WHERE key = ? ORDER BY property_type, month
    """, [key]):
        t = types.setdefault(r["property_type"], {"month": [], "median_sale_price": [], "median_ppsf": [],
                                                   "homes_sold": []})
        t["month"].append(r["month"].strftime("%Y-%m"))
        for f in ("median_sale_price", "median_ppsf", "homes_sold"):
            t[f].append(None if r[f] is None else round(r[f], 2))

    fhfa = query("SELECT month, index_nsa, flavor FROM fhfa WHERE key = ? ORDER BY month", [key])

    return {
        **info[0],
        "mix": {
            "history": mix_history,
            "latest": None if latest_mix is None else {
                "quarter": quarter_label(latest_mix["quarter"]),
                **{f: latest_mix[f] for f in ("median_yoy", "ppsf_yoy", "zhvi_yoy", "hpi_yoy", "mix_gap")},
            },
            "shift_share": shift_share(key, latest_mix["quarter"]) if latest_mix else None,
        },
        "segments": segments,
        "types": types,
        "fhfa": {
            "month": [r["month"].strftime("%Y-%m") for r in fhfa],
            "value": [r["index_nsa"] for r in fhfa],
            "flavor": fhfa[0]["flavor"] if fhfa else None,
        },
        "zhvi": series(zhvi, "value"),
        "us_zhvi": series(us, "value"),
        "redfin": series(redfin, *REDFIN_COLUMNS),
        "rates": series(rates, "rate_30y"),
        "income": {
            "year": [r["year"] for r in income],
            "value": [r["income"] for r in income],
            "source": income[-1]["source"] if income else None,
            "is_local": income_is_local,
        },
    }


def quarter_label(d):
    return f"Q{(d.month - 1) // 3 + 1} {d.year}"


def shift_share(key, quarter):
    """Split the year-over-year change in a sales-weighted price into value and mix effects.

    Composite price P = sum over property types of (share of sales x type's median price).
    P1 - P0 = sum(w0 * (p1 - p0))   value effect: the same mix of homes, repriced
            + sum((w1 - w0) * p1)   mix effect: a different mix of homes selling
    """
    rows = query("""
        SELECT property_type,
               CAST(date_trunc('quarter', month) AS DATE) = ? AS is_now,
               sum(homes_sold) AS sold,
               sum(median_sale_price * homes_sold) / sum(homes_sold) AS price
        FROM redfin_types
        WHERE key = ?
          AND CAST(date_trunc('quarter', month) AS DATE) IN (?, CAST(? - INTERVAL 1 YEAR AS DATE))
          AND median_sale_price IS NOT NULL AND homes_sold > 0
        GROUP BY ALL
    """, [quarter, key, quarter, quarter])
    now = {r["property_type"]: r for r in rows if r["is_now"]}
    then = {r["property_type"]: r for r in rows if not r["is_now"]}
    common = sorted(set(now) & set(then))
    sold_now = sum(now[t]["sold"] for t in common)
    sold_then = sum(then[t]["sold"] for t in common)
    if sold_now < MIN_SALES_FOR_SHIFT_SHARE or sold_then < MIN_SALES_FOR_SHIFT_SHARE:
        return None

    detail, value_effect, mix_effect, p0, p1 = [], 0.0, 0.0, 0.0, 0.0
    for t in common:
        w0, w1 = then[t]["sold"] / sold_then, now[t]["sold"] / sold_now
        pr0, pr1 = then[t]["price"], now[t]["price"]
        value_effect += w0 * (pr1 - pr0)
        mix_effect += (w1 - w0) * pr1
        p0 += w0 * pr0
        p1 += w1 * pr1
        detail.append({"type": t, "share_then": w0, "share_now": w1, "price_then": pr0, "price_now": pr1})

    medians = query("""
        SELECT CAST(date_trunc('quarter', month) AS DATE) = ? AS is_now, avg(median_sale_price) AS price
        FROM redfin
        WHERE key = ? AND CAST(date_trunc('quarter', month) AS DATE) IN (?, CAST(? - INTERVAL 1 YEAR AS DATE))
        GROUP BY ALL
    """, [quarter, key, quarter, quarter])
    median = {("now" if r["is_now"] else "then"): r["price"] for r in medians}
    return {
        "quarter": quarter_label(quarter),
        "value_effect": value_effect,
        "mix_effect": mix_effect,
        "composite_then": p0,
        "composite_now": p1,
        "median_then": median.get("then"),
        "median_now": median.get("now"),
        "sales_then": sold_then,
        "sales_now": sold_now,
        "types": detail,
    }


@app.get("/api/metro/{key}/local")
def metro_local(key: str, type: str = "zip"):
    """ZIP codes or neighborhoods in a metro: value, changes, position relative to the metro, and a
    10-year quarterly sparkline."""
    key = key.lower()
    if type not in LOCAL_TYPES:
        raise HTTPException(404, "Unknown area type")
    if not query("SELECT 1 FROM metros WHERE key = ?", [key]):
        raise HTTPException(404, f"Unknown metro: {key}")
    rows = query("""
        WITH latest AS (SELECT max(month) AS m FROM zhvi_local),
        metro AS (
            SELECT max(value) FILTER (WHERE month = (SELECT m FROM latest)) AS now,
                   max(value) FILTER (WHERE month = (SELECT m FROM latest) - INTERVAL 5 YEAR) AS y5
            FROM zhvi WHERE key = ?
        ),
        v AS (
            SELECT z.area_id,
                   max(value) FILTER (WHERE month = (SELECT m FROM latest)) AS value,
                   max(value) FILTER (WHERE month = (SELECT m FROM latest) - INTERVAL 1 YEAR) AS y1,
                   max(value) FILTER (WHERE month = (SELECT m FROM latest) - INTERVAL 5 YEAR) AS y5,
                   min(month) AS since,
                   list(round(value) ORDER BY month) FILTER (
                       WHERE month > (SELECT m FROM latest) - INTERVAL 10 YEAR
                         AND (month(month) - month((SELECT m FROM latest)) + 12) % 3 = 0) AS spark
            FROM zhvi_local z
            WHERE z.area_id IN (SELECT area_id FROM local_areas WHERE metro_key = ? AND area_type = ?)
            GROUP BY z.area_id
        )
        SELECT a.area_id, a.name, a.city, a.county, a.state, a.size_rank,
               v.value, v.value / v.y1 - 1 AS change_1y, v.value / v.y5 - 1 AS change_5y,
               v.value / metro.now - 1 AS vs_metro,
               (v.value / metro.now) - (v.y5 / metro.y5) AS vs_metro_change_5y,
               strftime(v.since, '%Y-%m') AS since, v.spark
        FROM local_areas a JOIN v USING (area_id), metro
        WHERE a.metro_key = ? AND a.area_type = ?
        ORDER BY a.size_rank
    """, [key, key, type, key, type])
    latest = query("SELECT strftime(max(month), '%Y-%m') AS m FROM zhvi_local")[0]["m"]
    counts = {r["area_type"]: r["n"] for r in query(
        "SELECT area_type, count(*) AS n FROM local_areas WHERE metro_key = ? GROUP BY 1", [key])}
    return {
        "type": type,
        "as_of": latest,
        "counts": {t: counts.get(t, 0) for t in LOCAL_TYPES},
        "areas": [r for r in rows if r["value"] is not None],
        "without_estimate": sum(1 for r in rows if r["value"] is None),
    }


@app.get("/api/local/{area_id}")
def local_area(area_id: int):
    info = query("""
        SELECT area_id, area_type, name, city, county, state, metro_key FROM local_areas WHERE area_id = ?
    """, [area_id])
    if not info:
        raise HTTPException(404, "Unknown area")
    rows = query("SELECT month, value FROM zhvi_local WHERE area_id = ? ORDER BY month", [area_id])
    return {**info[0], **series(rows, "value")}


@app.get("/api/rankings")
def rankings(limit: int = 100):
    """Largest metros with price momentum and competitiveness, for the comparison table."""
    return query(f"""
        WITH latest AS (SELECT max(month) AS m FROM zhvi),
        z AS (
            SELECT key,
                   max(value) FILTER (WHERE month = (SELECT m FROM latest)) AS value,
                   max(value) FILTER (WHERE month = (SELECT m FROM latest) - INTERVAL 1 YEAR) AS value_1y,
                   max(value) FILTER (WHERE month = (SELECT m FROM latest) - INTERVAL 5 YEAR) AS value_5y
            FROM zhvi GROUP BY key
        ),
        mix AS (
            SELECT key, mix_gap, row_number() OVER (PARTITION BY key ORDER BY quarter DESC) AS rn
            FROM ({MIX_SQL.format(where='')}) WHERE mix_gap IS NOT NULL
        ),
        r AS (
            SELECT key, median_dom, sale_to_list, inventory, months_of_supply,
                   lag(inventory, 12) OVER (PARTITION BY key ORDER BY month) AS inventory_1y,
                   row_number() OVER (PARTITION BY key ORDER BY month DESC) AS rn
            FROM redfin
        )
        SELECT m.key, m.name, m.size_rank, z.value,
               z.value / z.value_1y - 1 AS change_1y,
               z.value / z.value_5y - 1 AS change_5y,
               r.median_dom, r.sale_to_list, r.months_of_supply,
               r.inventory / r.inventory_1y - 1 AS inventory_change_1y,
               mix.mix_gap
        FROM metros m
        JOIN z USING (key)
        LEFT JOIN r ON r.key = m.key AND r.rn = 1
        LEFT JOIN mix ON mix.key = m.key AND mix.rn = 1
        WHERE m.region_type = 'msa'
        ORDER BY m.size_rank
        LIMIT ?
    """, [limit])

@app.get("/api/meta")
def meta():
    sources = query("""
        SELECT source,
               CASE WHEN source = 'Median household income' THEN strftime(latest, '%Y')
                    WHEN source = 'FHFA House Price Index' THEN 'Q' || quarter(latest) || ' ' || year(latest)
                    ELSE strftime(latest, '%Y-%m') END AS latest
        FROM meta
    """)
    updated = query("SELECT strftime(built_at, '%Y-%m-%d') AS updated FROM built")[0]["updated"]
    return {"sources": sources, "updated": updated}


# ---------- Data page: browse the tables listed in catalog.py ----------

def table_columns(name):
    """[(column, type)] for a catalogued table, as DuckDB reports them."""
    return [(r["column_name"], r["column_type"]) for r in query(f'DESCRIBE "{name}"')]


def table_filter(name, q, sort, direction):
    """WHERE and ORDER BY clauses for a table view.

    Table and column names come only from the catalog and DESCRIBE output, never
    from the request, so they're safe to put into SQL; the search text is a parameter.
    """
    if name not in TABLES:
        raise HTTPException(404, f"Unknown table: {name}")
    entry = TABLES[name]
    columns = [c for c, _ in table_columns(name)]
    where, params = "", []
    filter_columns = entry["filter_column"]
    if isinstance(filter_columns, str):
        filter_columns = [filter_columns]
    if q and filter_columns:
        where = "WHERE " + " OR ".join(f'CAST("{c}" AS VARCHAR) ILIKE ?' for c in filter_columns)
        params.extend([f"%{q.strip()}%"] * len(filter_columns))
    if sort in columns:
        order = [(sort, "desc" if direction == "desc" else "asc")]
    else:
        order = entry["default_sort"]
    order_sql = "ORDER BY " + ", ".join(f'"{c}" {d.upper()}' for c, d in order)
    return where, order_sql, params


@app.get("/api/tables")
def tables():
    out = []
    for name, entry in TABLES.items():
        cols = table_columns(name)
        names = [c for c, _ in cols]
        stats = query(f'SELECT count(*) AS n FROM "{name}"')[0]
        coverage = None
        for period in ("month", "year"):
            if period in names:
                c = query(f'SELECT min("{period}") AS lo, max("{period}") AS hi FROM "{name}"')[0]
                fmt = (lambda v: v.strftime("%Y-%m")) if period == "month" else str
                coverage = {"from": fmt(c["lo"]), "to": fmt(c["hi"]), "period": period}
                break
        areas = None
        if entry["filter_column"] == "key":
            areas = query(f'SELECT count(DISTINCT key) AS n FROM "{name}"')[0]["n"]
        out.append({
            "name": name,
            "csv_max_rows": CSV_MAX_ROWS,
            **{k: entry[k] for k in ("label", "group", "source", "dataset", "description", "transform", "grain",
                                     "filter_column")},
            "rows": stats["n"],
            "areas": areas,
            "coverage": coverage,
            "columns": [{"name": c, "type": t, "description": entry["columns"].get(c, "")} for c, t in cols],
        })
    return out


@app.get("/api/tables/{name}/rows")
def table_rows(name: str, q: str = "", sort: str = "", dir: str = "asc",
               offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=500)):
    where, order_sql, params = table_filter(name, q, sort, dir)
    total = query(f'SELECT count(*) AS n FROM "{name}" {where}', params)[0]["n"]
    rows = query(f'SELECT * FROM "{name}" {where} {order_sql} LIMIT ? OFFSET ?', params + [limit, offset])
    return {"total": total, "offset": offset, "rows": rows}


@app.get("/api/tables/{name}/csv")
def table_csv(name: str, q: str = "", sort: str = "", dir: str = "asc"):
    where, order_sql, params = table_filter(name, q, sort, dir)
    total = query(f'SELECT count(*) AS n FROM "{name}" {where}', params)[0]["n"]
    if total > CSV_MAX_ROWS:
        raise HTTPException(413, f"That's {total:,} rows. Filter the table to {CSV_MAX_ROWS:,} rows or fewer "
                                 f"to download it.")
    with duckdb.connect(str(DB_PATH), read_only=True) as con:
        df = con.execute(f'SELECT * FROM "{name}" {where} {order_sql}', params).df()
    suffix = f"_{q.strip().replace(' ', '_').replace(',', '')}" if q.strip() else ""
    return Response(df.to_csv(index=False), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}{suffix}.csv"'})


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/data")
def data_page():
    return FileResponse(STATIC / "data.html")


@app.get("/neighborhoods")
def neighborhoods_page():
    return FileResponse(STATIC / "neighborhoods.html")


@app.get("/compare")
def compare_page():
    return FileResponse(STATIC / "compare.html")


@app.get("/discussion")
def discussion_page():
    return FileResponse(STATIC / "discussion.html")


@app.get("/healthz", include_in_schema=False)
def healthz():
    """For uptime monitoring: 200 when the database answers, 503 otherwise."""
    try:
        updated = query("SELECT strftime(built_at, '%Y-%m-%d') AS d FROM built")[0]["d"]
    except Exception:
        return JSONResponse({"ok": False}, status_code=503, headers={"Cache-Control": "no-store"})
    return JSONResponse({"ok": True, "data_updated": updated}, headers={"Cache-Control": "no-store"})


@app.get("/robots.txt", include_in_schema=False)
def robots():
    return PlainTextResponse("User-agent: *\nDisallow: /api/\n")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(STATIC / "favicon.svg", media_type="image/svg+xml")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import os
    import socket
    import sys

    import uvicorn

    port = int(os.environ.get("PORT", 8000))
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            sys.exit(f"Port {port} is already in use, probably by another copy of this server. "
                     f"Stop it, or pick another port:  $env:PORT = 8001; python server.py")
    uvicorn.run("server:app", host="127.0.0.1", port=port, reload=True)
