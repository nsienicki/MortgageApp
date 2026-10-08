"""Descriptions of every table in data/housing.duckdb, shown on the site's public Data page.

Keep this in sync with build_db() in ingest.py: each entry names the table's source,
explains how the data was prepared, and describes every column.

All text here is shown to site visitors, so write it for the public: no script names,
file paths, environment variables or other internals.
"""

ZILLOW = {"name": "Zillow Research", "url": "https://www.zillow.com/research/data/"}
REDFIN = {"name": "Redfin Data Center", "url": "https://www.redfin.com/news/data-center/"}
FHFA = {"name": "Federal Housing Finance Agency (FHFA)", "url": "https://www.fhfa.gov/data/hpi"}
FRED_PMMS = {"name": "Freddie Mac PMMS via FRED", "url": "https://fred.stlouisfed.org/series/MORTGAGE30US"}
INCOME_SOURCES = {"name": "FRED (Census CPS) and Census ACS",
                  "url": "https://fred.stlouisfed.org/series/MEHOINUSA646N"}
SITE = {"name": "Homebuyer Market Lens (calculated)", "url": None}

METRO_KEY = "Metro identifier: the area's name in lowercase, e.g. 'denver, co'. Use it to combine datasets."
MONTH = "First day of the month the row describes."

TABLES = {
    "zhvi": {
        "label": "Home values",
        "group": "Source data",
        "source": ZILLOW,
        "dataset": "Zillow Home Value Index (ZHVI): all homes (single-family and condo), "
                   "middle tier, smoothed and seasonally adjusted, metro level",
        "description": "Zillow's estimate of the typical home value in each metro, every month since 2000. "
                       "It covers all homes, not just those that sold, so it moves more smoothly than sale prices. "
                       "Middle tier means homes valued between the 33rd and 67th percentile of values.",
        "transform": "Zillow publishes one column per month; we reshape it into one row per metro per month and "
                     "drop months with no value. Zillow dates each month by its last day; we use the first day so "
                     "it lines up with the other datasets.",
        "grain": "One row per metro per month",
        "filter_column": "key",
        "default_sort": [("key", "asc"), ("month", "desc")],
        "columns": {
            "key": METRO_KEY,
            "month": MONTH,
            "value": "Typical home value in dollars (ZHVI).",
        },
    },
    "redfin": {
        "label": "Market activity (MLS)",
        "group": "Source data",
        "source": REDFIN,
        "dataset": "Redfin Market Tracker, metro level, monthly",
        "description": "Monthly listing and sales activity from MLS (multiple listing service) data that Redfin "
                       "compiles. It shows how competitive buying is: how fast homes sell, how many are for sale, "
                       "and whether buyers pay over asking. It runs about three months behind.",
        "transform": "We use Redfin's 'All Residential' figures for monthly periods, not seasonally adjusted, "
                     "so expect regular seasonal swings. We drop the ' metro area' suffix from names to match Zillow's. "
                     "For the largest metros, Redfin reports the core metro division (e.g. New York) rather than "
                     "the whole metro. Redfin also covers some areas Zillow doesn't list; those rows are kept here but "
                     "don't appear on the dashboard yet.",
        "grain": "One row per metro per month",
        "filter_column": "key",
        "default_sort": [("key", "asc"), ("month", "desc")],
        "columns": {
            "key": METRO_KEY,
            "month": MONTH,
            "median_sale_price": "Median price of homes that sold that month, in dollars.",
            "median_list_price": "Median asking price of homes listed that month, in dollars.",
            "median_ppsf": "Median sale price per square foot of living area, in dollars.",
            "homes_sold": "Number of homes that sold.",
            "new_listings": "Number of homes newly listed for sale.",
            "inventory": "Active listings at the end of the month.",
            "months_of_supply": "Months it would take to sell all current inventory at the current sales pace. "
                                "Under about 4 favors sellers; over about 6 favors buyers.",
            "median_dom": "Median days on market: days from listing to accepted offer.",
            "sale_to_list": "Average sale price divided by the final list price. 1.02 means 2% over asking.",
            "sold_above_list": "Share of sales that closed above list price (0 to 1).",
            "price_drops": "Share of active listings that had a price cut (0 to 1).",
        },
    },
    "zhvi_segments": {
        "label": "Home values by segment",
        "group": "Source data",
        "source": ZILLOW,
        "dataset": "Zillow Home Value Index by price tier, bedroom count and home type, metro level",
        "description": "Zillow's typical home value for parts of the market: lower-, middle- and higher-priced homes; "
                       "homes with 1 to 5+ bedrooms; and single-family homes and condos. If a price change shows up "
                       "across every segment, it's broad; if only one segment moves, it's specific to that segment.",
        "transform": "Each segment comes from its own Zillow file. We reshape them the same way as the main home "
                     "value dataset and stack them, labeling each row with its segment. The middle-tier rows "
                     "repeat the main home value dataset.",
        "grain": "One row per metro per segment per month",
        "filter_column": "key",
        "default_sort": [("key", "asc"), ("segment", "asc"), ("month", "desc")],
        "columns": {
            "key": METRO_KEY,
            "month": MONTH,
            "segment": "tier_bottom, tier_middle or tier_top (lower, middle or higher third of values); "
                       "bed_1 to bed_5 (bedrooms; 5 means five or more); sfr (single-family) or condo. "
                       "Bedroom and home-type indexes cover the middle third of values.",
            "value": "Typical home value for that segment, in dollars.",
        },
    },
    "redfin_types": {
        "label": "Sales by property type (MLS)",
        "group": "Source data",
        "source": REDFIN,
        "dataset": "Redfin Market Tracker by property type, metro level, monthly",
        "description": "Sales and prices for each kind of home: single-family, townhouse, condo/co-op and 2-4 unit "
                       "buildings. Shows whether a change in the overall median comes from a change in which kinds "
                       "of homes are selling.",
        "transform": "Taken from the same Redfin release as the market activity dataset, keeping each property "
                     "type separately, for monthly periods, not seasonally adjusted.",
        "grain": "One row per metro per property type per month",
        "filter_column": "key",
        "default_sort": [("key", "asc"), ("month", "desc"), ("property_type", "asc")],
        "columns": {
            "key": METRO_KEY,
            "month": MONTH,
            "property_type": "Single-family, Townhouse, Condo/co-op or 2-4 unit.",
            "median_sale_price": "Median sale price for that property type, in dollars.",
            "median_ppsf": "Median sale price per square foot, in dollars.",
            "homes_sold": "Number of homes of that type that sold.",
        },
    },
    "fhfa": {
        "label": "Same-home prices",
        "group": "Source data",
        "source": FHFA,
        "dataset": "FHFA House Price Index, expanded-data (purchase-only) version, metro and national, quarterly",
        "description": "A repeat-sales index: it tracks homes that sold more than once and measures how much the "
                       "same house rose or fell in value. Because it compares each house with itself, a change in "
                       "which homes are selling doesn't move it. The index has no units; only its changes over "
                       "time are meaningful.",
        "transform": "We keep FHFA's purchase-only 'expanded-data' series, which combines mortgages backed by "
                     "Fannie Mae, Freddie Mac and the FHA with county sale records. Quarters are dated by their "
                     "first month. FHFA names metros by all their principal cities, so we match them to Zillow's "
                     "names by the first city. For the largest metros FHFA reports metro divisions; we use the "
                     "division named for the main city.",
        "grain": "One row per area per quarter",
        "filter_column": "key",
        "default_sort": [("key", "asc"), ("month", "desc")],
        "columns": {
            "key": METRO_KEY + " 'united states' holds the national series.",
            "month": "First day of the quarter the row describes (January, April, July or October).",
            "index_nsa": "Index value, not seasonally adjusted. Compare quarters a year apart to see price change.",
            "flavor": "Which FHFA series the row comes from ('expanded-data' = purchase prices only).",
        },
    },
    "local_areas": {
        "label": "ZIP codes and neighborhoods",
        "group": "Reference",
        "source": ZILLOW,
        "dataset": "Region lists from Zillow's ZIP code and neighborhood home value files",
        "description": "Every ZIP code and neighborhood inside a metro that Zillow publishes home values for, "
                       "with its city, county and metro. ZIP codes are postal routes, not true neighborhoods, so "
                       "they can cross city and school-district lines. Neighborhoods use Zillow's own boundaries "
                       "and mostly cover larger cities.",
        "transform": "Zillow names each area's metro in full ('Houston-The Woodlands-Sugar Land, TX'); we match "
                     "it to our metro list by its first city. Areas outside any metro are left out.",
        "grain": "One row per ZIP code or neighborhood",
        "filter_column": ["name", "city", "metro_key"],
        "default_sort": [("metro_key", "asc"), ("area_type", "asc"), ("size_rank", "asc")],
        "columns": {
            "area_id": "Zillow's identifier for the area. Use it to look up values in the ZIP and neighborhood "
                       "home values dataset.",
            "area_type": "'zip' or 'neighborhood'.",
            "name": "ZIP code (kept as text, so leading zeros stay) or neighborhood name.",
            "city": "City the area is in.",
            "county": "County the area is in.",
            "state": "State abbreviation.",
            "metro_key": METRO_KEY,
            "size_rank": "Zillow's size ranking among areas of the same type; 1 is the largest.",
        },
    },
    "zhvi_local": {
        "label": "ZIP and neighborhood home values",
        "group": "Source data",
        "source": ZILLOW,
        "dataset": "Zillow Home Value Index by ZIP code and neighborhood: all homes, middle tier, smoothed and "
                   "seasonally adjusted",
        "description": "Zillow's typical home value for each ZIP code and neighborhood, every month since 2000 where "
                       "available. These are model estimates, so they're steadier than sale prices in small areas, "
                       "but less certain where few homes sell.",
        "transform": "Reshaped from Zillow's one-column-per-month files into one row per area per month, "
                     "keeping only areas inside a metro. Months are dated by their first day.",
        "grain": "One row per area per month",
        "filter_column": "area_id",
        "default_sort": [("area_id", "asc"), ("month", "desc")],
        "columns": {
            "area_id": "Area identifier; see the ZIP codes and neighborhoods dataset for names.",
            "month": MONTH,
            "value": "Typical home value in dollars.",
        },
    },
    "rates": {
        "label": "Mortgage rates",
        "group": "Source data",
        "source": FRED_PMMS,
        "dataset": "30-Year Fixed Rate Mortgage Average in the United States (MORTGAGE30US)",
        "description": "Freddie Mac's weekly Primary Mortgage Market Survey (PMMS) rate for a 30-year fixed mortgage, "
                       "national, since 1971. The rate assumes a borrower with strong credit and 20% down, so many "
                       "buyers pay somewhat more.",
        "transform": "We average the weekly survey results into one rate per month.",
        "grain": "One row per month (national)",
        "filter_column": None,
        "default_sort": [("month", "desc")],
        "columns": {
            "month": MONTH,
            "rate_30y": "Average 30-year fixed rate that month, in percent (6.5 = 6.5%).",
        },
    },
    "income": {
        "label": "Household income",
        "group": "Source data",
        "source": INCOME_SOURCES,
        "dataset": "Median household income: national (FRED series MEHOINUSA646N, from the Census Current "
                   "Population Survey); metro level from American Community Survey (ACS) 1-year table B19013 where available",
        "description": "Median annual household income in current dollars (not adjusted for inflation). "
                       "The dashboard compares the monthly payment with one-twelfth of this to get the "
                       "payment-to-income share.",
        "transform": "We use metro-level figures from the Census American Community Survey where they're "
                     "available, and the national median otherwise. Census metro names list every principal city "
                     "('Dallas-Fort Worth-Arlington, TX'), so we match them to Zillow's shorter names by their "
                     "first city.",
        "grain": "One row per area per year",
        "filter_column": "key",
        "default_sort": [("key", "asc"), ("year", "desc")],
        "columns": {
            "key": METRO_KEY + " 'united states' holds the national series.",
            "year": "Survey year.",
            "income": "Median household income in dollars.",
            "source": "Which survey the figure came from.",
        },
    },
    "metros": {
        "label": "Metro areas",
        "group": "Reference",
        "source": ZILLOW,
        "dataset": "Region list from the Zillow ZHVI file",
        "description": "Every area the site knows about: the United States plus about 900 metropolitan and "
                       "micropolitan areas. This list drives the metro search box.",
        "transform": "Taken from Zillow's list of regions. Its key column is the identifier every other dataset "
                     "uses, so you can combine downloads.",
        "grain": "One row per area",
        "filter_column": "key",
        "default_sort": [("size_rank", "asc")],
        "columns": {
            "key": METRO_KEY,
            "name": "Display name, e.g. 'Denver, CO'.",
            "state": "State abbreviation (blank for the United States).",
            "size_rank": "Zillow's size ranking; 1 is the largest metro (0 is the U.S.).",
            "region_type": "'country' or 'msa' (metropolitan or micropolitan statistical area).",
        },
    },
    "meta": {
        "label": "Data freshness",
        "group": "About this data",
        "source": SITE,
        "dataset": "Calculated from the datasets above each time the site's data is updated",
        "description": "The most recent period each source covers. Sources publish on different schedules, "
                       "so their latest months differ.",
        "transform": "Calculated from the maximum month (or year) in each source table.",
        "grain": "One row per source",
        "filter_column": None,
        "default_sort": [("source", "asc")],
        "columns": {
            "source": "Data source.",
            "latest": "Latest period with data. For income this is January 1 of the latest survey year.",
        },
    },
}
