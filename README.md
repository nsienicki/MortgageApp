# Homebuyer Market Lens

A local website for understanding housing markets through a homebuyer's eyes:
prices, affordability and competition for every U.S. metro, from free public data.

## Run it

```
pip install -r requirements.txt
python ingest.py     # downloads data (~115 MB) and builds data/housing.duckdb
python server.py     # http://127.0.0.1:8000
```

Re-run `python ingest.py` to pick up new data. Downloads newer than 7 days are reused; `--refresh` forces new ones.

### Optional: metro-level income
By default, the payment-to-income figures use the **national** median household income.
To use each metro's own income from the Census ACS, get a free key at
https://api.census.gov/data/key_signup.html and run:

```
$env:CENSUS_API_KEY = "your-key"   # PowerShell
python ingest.py
```

## Hosting

See [`deploy/README.md`](deploy/README.md) for putting the site on an IONOS VPS (Ubuntu, nginx, HTTPS,
weekly data refresh).

## Data sources

| Data | Source | Frequency |
|---|---|---|
| Typical home value (ZHVI) | Zillow Research | Monthly |
| Sale price, inventory, days on market, sale-to-list, price cuts (MLS-derived) | Redfin Data Center | Monthly, lags ~3 months |
| 30-year fixed mortgage rate | Freddie Mac PMMS via FRED | Weekly, averaged monthly |
| Median household income | FRED (national) / Census ACS (metro) | Annual |
| Home values by price tier, bedrooms and home type | Zillow Research | Monthly |
| Sales and prices by property type, price per sq ft | Redfin Data Center | Monthly |
| Same-home (repeat-sales) price index | FHFA House Price Index | Quarterly |
| Home values by ZIP code and neighborhood | Zillow Research | Monthly |

Metros are matched across sources by "City, ST" name. For the largest metros,
Redfin reports the core metro division rather than the full metro.

## Layout

- `ingest.py`: downloads the sources and builds the DuckDB database
- `server.py`: FastAPI app serving the JSON API (`/api/metros`, `/api/metro/{key}`, `/api/rankings`, `/api/meta`,
  `/api/tables`, `/api/tables/{name}/rows`, `/api/tables/{name}/csv`) and the site
- `catalog.py`: label, source, build notes and column descriptions for every database table; shown on the Data page.
  **Update it whenever you add or change a table in `ingest.py`.**
- `static/`: the frontend: the dashboard (`index.html`, `app.js`) and the Data page (`data.html`, `data.js`)

## Pages

- **Dashboard** (`/`): prices, affordability and competition for any metro, plus "Is it the homes or the mix?",
  which separates real value changes from shifts in which homes are selling
- **Neighborhoods** (`/neighborhoods`): every ZIP code or neighborhood in a metro, with typical values,
  1- and 5-year change, position relative to the metro, 10-year trends, estimated payments and a monthly-budget filter
- **Compare** (`/compare`): up to four metros (or the U.S.) side by side, with a summary table and charts
- **Discussion** (`/discussion`): what each measure means, how to read it, and its limits
- **Data** (`/data`): browse each DuckDB table with its source, how it was built and what each column means.
  You can filter, sort, page through and download each table as CSV.

## Note for this machine
Norton antivirus intercepts HTTPS, which breaks `pip`'s certificate check. Either
turn off Norton's "Web/Mail Shield" SSL scanning for Python, or export the Windows trusted
certificates to a file and pass it with `pip install --cert <file>`. `ingest.py` isn't affected.
