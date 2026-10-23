# Homebuyer Market Lens

See any U.S. housing market the way a homebuyer does: what homes cost, what the monthly payment
would be, and how competitive buying is. It covers every U.S. metro and the ZIP codes and
neighborhoods inside them, using only free public data.

## What you can do

- **Dashboard:** prices, affordability and competition for any metro, with a toggle for the down
  payment and taxes. Includes *"Is it the homes or the mix?"*, which separates real changes in home
  values from shifts in which kinds of homes happen to be selling.
- **Neighborhoods:** every ZIP code or neighborhood in a metro: typical values, 1- and 5-year change,
  10-year trends and estimated payments. Enter a monthly budget to see which areas fit it.
- **Compare:** up to four metros (or the U.S. as a whole) side by side.
- **Discussion:** what each measure means, how to read it, and where it falls short.
- **Data:** browse every underlying table, with its source and column definitions. Filter, sort and
  download it as CSV.

Every chart has a data table under it, and the site works on phones and in light or dark mode.

## Quick start

Requires Python 3.9 or newer.

```
python -m venv .venv
.venv\Scripts\activate            # Windows
source .venv/bin/activate         # macOS / Linux
pip install -r requirements.txt

python ingest.py                  # download the public data and build the local database
python server.py                  # open http://127.0.0.1:8000
```

The first `ingest.py` run downloads about 380 MB and builds a database of about 140 MB in `data/`.
Neither is checked into the repository. Run `ingest.py` again to pick up new data: files less than
7 days old are reused, and `python ingest.py --refresh` downloads everything again.

### Optional: income for each metro (Census API key)

By default, payment-to-income figures use the **national** median household income for every metro.
To use each metro's own median income from the Census American Community Survey:

1. Get a free key at https://api.census.gov/data/key_signup.html.
2. Set it as an environment variable before running the ingest:

   ```
   $env:CENSUS_API_KEY = "your-key"      # Windows PowerShell
   export CENSUS_API_KEY="your-key"      # macOS / Linux
   python ingest.py
   ```

The key is read only from the environment. Don't put it in code or commit it. Census results are
cached for 30 days, so later runs don't call the API again.

None of the other sources need a key or an account.

## Data sources

| Data | Source | Frequency |
|---|---|---|
| Typical home value (ZHVI), by metro, ZIP code and neighborhood | Zillow Research | Monthly |
| Home values by price tier, bedroom count and home type | Zillow Research | Monthly |
| Sale price, price per sq ft, inventory, days on market, sale-to-list, price cuts | Redfin Data Center (MLS-derived) | Monthly, about 3 months behind |
| Sales and prices by property type | Redfin Data Center | Monthly |
| Same-home (repeat-sales) price index | FHFA House Price Index | Quarterly |
| 30-year fixed mortgage rate | Freddie Mac PMMS via FRED | Weekly, averaged by month |
| Median household income | U.S. Census Bureau via FRED (national), Census ACS (metro, optional) | Annual |

Data © Zillow Group; Redfin, a national real estate brokerage; FHFA; Freddie Mac; U.S. Census Bureau.
Each source's terms of use apply to its data. Metros are matched across sources by their "City, ST"
name. For the largest metros, Redfin reports the core metro division rather than the full metro.

## How it works

- `ingest.py` downloads each source and loads it into a single local DuckDB database.
- `server.py` is a small FastAPI app that serves the pages and a JSON API built on that database.
- `static/` holds the front end: plain HTML, CSS and JavaScript with Chart.js. There is no build step.
- `catalog.py` describes every table and column; the Data page shows these descriptions.

Affordability math runs in the browser. It assumes a 30-year fixed loan at that month's average rate,
plus taxes and insurance at 1.5% of the home's value per year.

## Hosting

[`deploy/README.md`](deploy/README.md) explains how to run the site on an Ubuntu server with nginx,
HTTPS and a weekly data refresh.

## Troubleshooting

- **`pip` fails with a certificate error:** antivirus or corporate proxies that scan HTTPS traffic
  break `pip`'s certificate check. Turn off HTTPS scanning for Python, or export your system's trusted
  certificates to a file and run `pip install --cert <file> -r requirements.txt`. `ingest.py` isn't
  affected because it uses the operating system's certificate store.
- **Port 8000 is already in use:** set a different port with the `PORT` environment variable.

## Disclaimer

Homebuyer Market Lens is an independent project and isn't affiliated with Zillow, Redfin, the FHFA,
Freddie Mac or the Census Bureau. Figures are estimates for general information. They aren't financial
advice or a loan quote.
