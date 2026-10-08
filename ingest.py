"""Download free housing-market datasets and load them into data/housing.duckdb.

Sources:
  - Zillow Home Value Index (ZHVI), metro level, monthly
  - Redfin Data Center market tracker (MLS-derived), metro level, monthly
  - Zillow ZHVI by segment: price tier, bedroom count, single-family vs condo
  - Redfin by property type (single-family, condo, townhouse, 2-4 unit)
  - FHFA House Price Index (repeat sales), metro level, quarterly
  - Zillow ZHVI by ZIP code and by neighborhood, within metros
  - Freddie Mac PMMS 30-year fixed mortgage rate, via FRED, weekly
  - Median household income: national from FRED; per-metro from the Census
    ACS 1-year API when CENSUS_API_KEY is set (free key: https://api.census.gov/data/key_signup.html)

Usage:
  python ingest.py            # download anything older than 7 days, rebuild the database
  python ingest.py --refresh  # force re-download of every source

Environment variables:
  LENS_DATA_DIR        where downloads and the database live (default: data/ next to this file)
  LENS_INGEST_MEMORY   DuckDB memory limit while building, e.g. 1GB (default: DuckDB's own)
  CENSUS_API_KEY       optional; enables metro-level income
"""
import argparse
import datetime as dt
import json
import os
import re
import time
import urllib.request
from pathlib import Path

import duckdb

ROOT = Path(__file__).parent
DATA_DIR = Path(os.environ.get("LENS_DATA_DIR", ROOT / "data"))
RAW = DATA_DIR / "raw"
DB_PATH = DATA_DIR / "housing.duckdb"
MAX_AGE_DAYS = 7

SOURCES = {
    "zillow_zhvi_metro.csv": "https://files.zillowstatic.com/research/public_csvs/zhvi/"
                             "Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
    "redfin_metro.tsv.gz": "https://redfin-public-data.s3.us-west-2.amazonaws.com/"
                           "redfin_market_tracker/redfin_metro_market_tracker.tsv000.gz",
    "mortgage30.csv": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=MORTGAGE30US",
    "us_income.csv": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=MEHOINUSA646N",
    "fhfa_hpi_master.csv": "https://www.fhfa.gov/hpi/download/monthly/hpi_master.csv",
}

ZILLOW_BASE = "https://files.zillowstatic.com/research/public_csvs/zhvi/"
# segment id -> Zillow file. The middle tier for all homes is the main ZHVI file above.
ZHVI_SEGMENTS = {
    "tier_bottom": "Metro_zhvi_uc_sfrcondo_tier_0.0_0.33_sm_sa_month.csv",
    "tier_top": "Metro_zhvi_uc_sfrcondo_tier_0.67_1.0_sm_sa_month.csv",
    "sfr": "Metro_zhvi_uc_sfr_tier_0.33_0.67_sm_sa_month.csv",
    "condo": "Metro_zhvi_uc_condo_tier_0.33_0.67_sm_sa_month.csv",
    **{f"bed_{n}": f"Metro_zhvi_bdrmcnt_{n}_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv" for n in range(1, 6)},
}
SOURCES.update({f"zillow_zhvi_{seg}.csv": ZILLOW_BASE + f for seg, f in ZHVI_SEGMENTS.items()})
# Local areas within metros: area type -> Zillow file (middle tier, all homes)
LOCAL_AREAS = {
    "zip": "Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
    "neighborhood": "Neighborhood_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
}
SOURCES.update({f"zillow_zhvi_{kind}.csv": ZILLOW_BASE + f for kind, f in LOCAL_AREAS.items()})

REDFIN_TYPES = {
    "Single Family Residential": "Single-family",
    "Condo/Co-op": "Condo/co-op",
    "Townhouse": "Townhouse",
    "Multi-Family (2-4 Unit)": "2-4 unit",
}

ACS_URL = ("https://api.census.gov/data/{year}/acs/acs1?get=NAME,B19013_001E"
           "&for=metropolitan%20statistical%20area/micropolitan%20statistical%20area:*&key={key}")


def download(name, url, refresh):
    path = RAW / name
    if path.exists() and not refresh:
        age_days = (time.time() - path.stat().st_mtime) / 86400
        if age_days < MAX_AGE_DAYS:
            print(f"  {name}: cached ({age_days:.1f} days old)")
            return path
    print(f"  {name}: downloading...")
    tmp = path.with_suffix(path.suffix + ".part")
    # urllib uses the Windows certificate store, so it works behind TLS-scanning antivirus.
    # FRED's CSV endpoint stalls for unrecognized user agents but serves curl's.
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as f:
        while chunk := resp.read(1 << 20):
            f.write(chunk)
    tmp.replace(path)
    return path


def metro_key(city_state):
    """'New York, NY' -> 'new york, ny'. Used to join metros across sources."""
    return city_state.strip().lower()


def fetch_acs_income(api_key, metro_keys, refresh):
    """Per-metro median household income from ACS 1-year, matched to Zillow metro names."""
    cache = RAW / "acs_income.json"
    if cache.exists() and not refresh and (time.time() - cache.stat().st_mtime) / 86400 < 30:
        rows = json.loads(cache.read_text())
        print(f"  ACS income: cached ({len(rows)} rows)")
        return rows
    rows = []
    for year in range(2005, dt.date.today().year):
        if year == 2020:  # ACS 1-year standard tables were not released for 2020
            continue
        try:
            with urllib.request.urlopen(ACS_URL.format(year=year, key=api_key), timeout=60) as resp:
                data = json.load(resp)
        except Exception as e:  # year not yet published, or API error
            print(f"  ACS {year}: skipped ({type(e).__name__})")
            continue
        matched = 0
        for name, income, *_ in data[1:]:
            if income is None or int(income) < 0:
                continue
            key = census_name_to_key(name, metro_keys)
            if key:
                rows.append([key, year, int(income)])
                matched += 1
        print(f"  ACS {year}: {matched} metros matched")
    cache.write_text(json.dumps(rows))
    return rows


def census_name_to_key(name, metro_keys):
    """'Winston-Salem, NC Metro Area' -> 'winston-salem, nc' if Zillow has that metro.

    Also used for FHFA names such as 'New York-Jersey City-White Plains, NY-NJ (MSAD)'.

    Census names list every principal city and state ('Dallas-Fort Worth-Arlington, TX');
    Zillow and Redfin use only the first. City names can contain hyphens themselves,
    so try each hyphen-prefix and keep the one Zillow knows about.
    """
    if "," not in name:
        return None
    cities, rest = name.rsplit(",", 1)
    state = rest.strip().split(" ")[0].split("-")[0]
    parts = re.split(r"[-/]", cities)
    for i in range(len(parts), 0, -1):
        key = metro_key(f"{'-'.join(parts[:i])}, {state}")
        if key in metro_keys:
            return key
    return None


def load_fhfa(con, path):
    """FHFA repeat-sales index, quarterly, one series per Zillow metro plus the U.S.

    Prefers the 'expanded-data' flavor (purchase prices only, including county records) and
    falls back to 'all-transactions' (also counts appraisals from refinances) where FHFA
    doesn't publish the former. Large metros appear as metro divisions (MSAD); a full MSA
    with the same first city wins over a division.
    """
    con.execute(f"""
        CREATE TEMP TABLE fhfa_raw AS
        SELECT hpi_flavor AS flavor, level, place_name,
               make_date(CAST(yr AS INTEGER), (CAST(period AS INTEGER) - 1) * 3 + 1, 1) AS month,
               TRY_CAST(index_nsa AS DOUBLE) AS index_nsa
        FROM read_csv('{path.as_posix()}', header=true, all_varchar=true)
        WHERE hpi_type = 'traditional' AND frequency = 'quarterly'
          AND hpi_flavor IN ('expanded-data', 'all-transactions')
          AND (level = 'MSA' OR (level = 'USA or Census Division' AND place_id = 'USA'))
    """)
    metro_keys = {r[0] for r in con.execute("SELECT key FROM metros").fetchall()}
    matches = {}
    for (name,) in con.execute("SELECT DISTINCT place_name FROM fhfa_raw WHERE level = 'MSA'").fetchall():
        key = census_name_to_key(name.replace(" (MSAD)", ""), metro_keys)
        if not key:
            continue
        is_division = name.endswith("(MSAD)")
        current = matches.get(key)
        if current is None or (current[1] and not is_division):
            matches[key] = (name, is_division)
    con.execute("CREATE TEMP TABLE fhfa_names (place_name VARCHAR, key VARCHAR)")
    con.executemany("INSERT INTO fhfa_names VALUES (?, ?)",
                    [(name, key) for key, (name, _) in matches.items()] + [("United States", "united states")])
    con.execute("""
        CREATE TABLE fhfa AS
        WITH series AS (
            SELECT n.key, r.month, r.flavor, r.index_nsa
            FROM fhfa_raw r JOIN fhfa_names n USING (place_name)
            WHERE r.index_nsa IS NOT NULL
        ),
        best AS (
            SELECT key, CASE WHEN bool_or(flavor = 'expanded-data') THEN 'expanded-data'
                             ELSE 'all-transactions' END AS flavor
            FROM series GROUP BY key
        )
        SELECT s.key, s.month, s.index_nsa, s.flavor
        FROM series s JOIN best b USING (key, flavor)
    """)


def load_local_areas(con, paths):
    """ZIP codes and neighborhoods inside Zillow metros, with their monthly ZHVI.

    Zillow labels each area's metro with the full Census name ('Houston-The Woodlands-Sugar Land, TX'),
    matched to our metro keys by first city. Areas outside any metro are dropped.
    """
    metro_keys = {r[0] for r in con.execute("SELECT key FROM metros").fetchall()}
    con.execute("""
        CREATE TABLE local_areas (area_id INTEGER, area_type VARCHAR, name VARCHAR, city VARCHAR,
                                  county VARCHAR, state VARCHAR, metro_key VARCHAR, size_rank INTEGER)
    """)
    con.execute("CREATE TABLE zhvi_local (area_id INTEGER, month DATE, value DOUBLE)")
    for kind in LOCAL_AREAS:
        src = f"read_csv('{paths[f'zillow_zhvi_{kind}.csv'].as_posix()}', header=true, auto_detect=true, " \
              f"types={{'RegionName': 'VARCHAR', 'RegionID': 'INTEGER'}})"
        con.execute(f"CREATE TEMP TABLE local_wide AS SELECT * FROM {src}")
        metro_names = [r[0] for r in con.execute(
            "SELECT DISTINCT Metro FROM local_wide WHERE Metro IS NOT NULL").fetchall()]
        con.execute("CREATE TEMP TABLE local_metro (metro VARCHAR, key VARCHAR)")
        con.executemany("INSERT INTO local_metro VALUES (?, ?)",
                        [(m, census_name_to_key(m, metro_keys)) for m in metro_names])
        con.execute(f"""
            INSERT INTO local_areas
            SELECT w.RegionID, '{kind}', w.RegionName, w.City, w.CountyName, w.State, lm.key, w.SizeRank
            FROM local_wide w JOIN local_metro lm ON lm.metro = w.Metro
            WHERE lm.key IS NOT NULL
        """)
        con.execute(f"""
            INSERT INTO zhvi_local
            SELECT RegionID, date_trunc('month', CAST(month AS DATE)), value
            FROM (UNPIVOT (SELECT * EXCLUDE (SizeRank, RegionName, RegionType, StateName, State, City, Metro,
                                             CountyName)
                           FROM local_wide
                           WHERE RegionID IN (SELECT area_id FROM local_areas WHERE area_type = '{kind}'))
                  ON COLUMNS(* EXCLUDE (RegionID)) INTO NAME month VALUE value)
            WHERE value IS NOT NULL
        """)
        con.execute("DROP TABLE local_wide")
        con.execute("DROP TABLE local_metro")


def zhvi_long_sql(path):
    """SELECT turning a wide Zillow file (one column per month) into (key, month, value) rows."""
    return f"""
        SELECT lower(trim(RegionName)) AS key,
               date_trunc('month', CAST(month AS DATE)) AS month,
               value
        FROM (UNPIVOT (SELECT * FROM read_csv_auto('{path.as_posix()}', header=true))
              ON COLUMNS(* EXCLUDE (RegionID, SizeRank, RegionName, RegionType, StateName))
              INTO NAME month VALUE value)
        WHERE value IS NOT NULL
    """


def build_db(paths, acs_rows):
    tmp_db = DB_PATH.with_suffix(".building")
    tmp_db.unlink(missing_ok=True)
    con = duckdb.connect(str(tmp_db))
    # Spill to disk instead of failing on a small server.
    con.execute(f"SET temp_directory = '{(DATA_DIR / 'tmp').as_posix()}'")
    if os.environ.get("LENS_INGEST_MEMORY"):
        con.execute(f"SET memory_limit = '{os.environ['LENS_INGEST_MEMORY']}'")

    print("  loading Zillow ZHVI...")
    con.execute(f"""
        CREATE TABLE zhvi_wide AS SELECT * FROM read_csv_auto('{paths["zillow_zhvi_metro.csv"].as_posix()}', header=true)
    """)
    con.execute("""
        CREATE TABLE metros AS
        SELECT lower(trim(RegionName)) AS key, RegionName AS name, StateName AS state,
               SizeRank AS size_rank, RegionType AS region_type
        FROM zhvi_wide
    """)
    con.execute("DROP TABLE zhvi_wide")
    con.execute(f"CREATE TABLE zhvi AS {zhvi_long_sql(paths['zillow_zhvi_metro.csv'])}")

    print("  loading Zillow segments...")
    con.execute("""
        CREATE TABLE zhvi_segments AS
        SELECT key, month, 'tier_middle' AS segment, value FROM zhvi
    """)
    for seg in ZHVI_SEGMENTS:
        con.execute(f"""
            INSERT INTO zhvi_segments
            SELECT key, month, '{seg}', value FROM ({zhvi_long_sql(paths[f"zillow_zhvi_{seg}.csv"])})
        """)

    print("  loading Redfin market tracker...")
    con.execute(f"""
        CREATE TEMP TABLE redfin_all AS
        SELECT lower(trim(regexp_replace(REGION, ' metro area$', ''))) AS key,
               CAST(PERIOD_BEGIN AS DATE) AS month,
               PROPERTY_TYPE AS property_type,
               avg(TRY_CAST(MEDIAN_SALE_PRICE AS DOUBLE)) AS median_sale_price,
               avg(TRY_CAST(MEDIAN_LIST_PRICE AS DOUBLE)) AS median_list_price,
               avg(TRY_CAST(MEDIAN_PPSF AS DOUBLE)) AS median_ppsf,
               avg(TRY_CAST(HOMES_SOLD AS DOUBLE)) AS homes_sold,
               avg(TRY_CAST(NEW_LISTINGS AS DOUBLE)) AS new_listings,
               avg(TRY_CAST(INVENTORY AS DOUBLE)) AS inventory,
               avg(TRY_CAST(MONTHS_OF_SUPPLY AS DOUBLE)) AS months_of_supply,
               avg(TRY_CAST(MEDIAN_DOM AS DOUBLE)) AS median_dom,
               avg(TRY_CAST(AVG_SALE_TO_LIST AS DOUBLE)) AS sale_to_list,
               avg(TRY_CAST(SOLD_ABOVE_LIST AS DOUBLE)) AS sold_above_list,
               avg(TRY_CAST(PRICE_DROPS AS DOUBLE)) AS price_drops
        FROM read_csv('{paths["redfin_metro.tsv.gz"].as_posix()}', delim='\t', header=true, quote='"',
                      all_varchar=true)
        WHERE REGION_TYPE = 'metro'
          AND lower(CAST(IS_SEASONALLY_ADJUSTED AS VARCHAR)) = 'false'
          AND CAST(PERIOD_DURATION AS VARCHAR) = '30'
        GROUP BY ALL
    """)
    con.execute("""
        CREATE TABLE redfin AS
        SELECT * EXCLUDE (property_type) FROM redfin_all WHERE property_type = 'All Residential'
    """)
    type_case = " ".join(f"WHEN '{src}' THEN '{label}'" for src, label in REDFIN_TYPES.items())
    con.execute(f"""
        CREATE TABLE redfin_types AS
        SELECT key, month, CASE property_type {type_case} END AS property_type,
               median_sale_price, median_ppsf, homes_sold
        FROM redfin_all
        WHERE property_type IN ({", ".join(f"'{t}'" for t in REDFIN_TYPES)})
    """)

    print("  loading FHFA house price index...")
    load_fhfa(con, paths["fhfa_hpi_master.csv"])

    print("  loading ZIP codes and neighborhoods...")
    load_local_areas(con, paths)

    print("  loading mortgage rates and income...")
    con.execute(f"""
        CREATE TABLE rates AS
        SELECT date_trunc('month', observation_date) AS month, avg(MORTGAGE30US) AS rate_30y
        FROM read_csv_auto('{paths["mortgage30.csv"].as_posix()}', nullstr='.')
        WHERE MORTGAGE30US IS NOT NULL
        GROUP BY 1
    """)
    con.execute("CREATE TABLE income (key VARCHAR, year INTEGER, income DOUBLE, source VARCHAR)")
    con.execute(f"""
        INSERT INTO income
        SELECT 'united states', year(observation_date), MEHOINUSA646N, 'FRED (Census CPS)'
        FROM read_csv_auto('{paths["us_income.csv"].as_posix()}', nullstr='.')
        WHERE MEHOINUSA646N IS NOT NULL
    """)
    if acs_rows:
        con.executemany("INSERT INTO income VALUES (?, ?, ?, 'Census ACS 1-year')", acs_rows)

    con.execute("""
        CREATE TABLE meta AS
        SELECT 'Zillow ZHVI' AS source, max(month) AS latest FROM zhvi
        UNION ALL SELECT 'Redfin market tracker', max(month) FROM redfin
        UNION ALL SELECT 'Zillow ZHVI by ZIP and neighborhood', max(month) FROM zhvi_local
        UNION ALL SELECT 'FHFA House Price Index', max(month) FROM fhfa WHERE key = 'united states'
        UNION ALL SELECT 'Freddie Mac PMMS', max(month) FROM rates
        UNION ALL SELECT 'Median household income', make_date(max(year), 1, 1) FROM income
    """)
    con.execute("CREATE TABLE built AS SELECT now() AS built_at")

    for t in ("metros", "zhvi", "zhvi_segments", "redfin", "redfin_types", "fhfa", "local_areas", "zhvi_local",
              "rates", "income"):
        print(f"    {t}: {con.execute(f'SELECT count(*) FROM {t}').fetchone()[0]:,} rows")
    matched = con.execute("SELECT count(*) FROM metros WHERE key IN (SELECT DISTINCT key FROM redfin)").fetchone()[0]
    print(f"    metros with Redfin data: {matched}")
    matched = con.execute("SELECT count(DISTINCT key) FROM fhfa").fetchone()[0]
    print(f"    areas with FHFA data: {matched}")
    for kind, n, metros in con.execute(
            "SELECT area_type, count(*), count(DISTINCT metro_key) FROM local_areas GROUP BY 1 ORDER BY 1").fetchall():
        print(f"    {kind}: {n:,} areas in {metros} metros")
    con.close()
    swap_in(tmp_db)


def swap_in(tmp_db):
    """Replace the live database in one step, so the site never sees a missing or half-built file.

    On Linux the rename is atomic, even while the web server has the old file open. On Windows it can
    fail briefly while a request holds the file, so retry.
    """
    for attempt in range(10):
        try:
            os.replace(tmp_db, DB_PATH)
            return
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--refresh", action="store_true", help="force re-download of all sources")
    args = parser.parse_args()

    RAW.mkdir(parents=True, exist_ok=True)
    print("Downloading sources:")
    paths = {name: download(name, url, args.refresh) for name, url in SOURCES.items()}

    acs_rows = []
    api_key = os.environ.get("CENSUS_API_KEY")
    if api_key:
        con = duckdb.connect()
        keys = {r[0] for r in con.execute(
            f"SELECT lower(trim(RegionName)) FROM read_csv_auto('{paths['zillow_zhvi_metro.csv'].as_posix()}')"
        ).fetchall()}
        con.close()
        acs_rows = fetch_acs_income(api_key, keys, args.refresh)
    else:
        print("  CENSUS_API_KEY not set: using national median income for every metro")

    print("Building database:")
    build_db(paths, acs_rows)
    print(f"Done: {DB_PATH}")


if __name__ == "__main__":
    main()
