"""Generate a realistic 3,000-row enzyme demand plan (sample data, fictional).

Grain: Material x Customer x Country x Month
Horizon: 6 months of actuals (May-Oct 2026) + 12 months of forecast (Nov 2026 - Oct 2027)
Units: kg and EUR

Output: data/demand_plan.csv, data/seed_comments.json
"""
import csv, json, math, random, datetime as dt, os

random.seed(42)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ACT_MONTHS = [dt.date(2026, m, 1) for m in range(5, 11)]  # May..Oct 2026
FC_MONTHS = [dt.date(2026 + (m > 12), (m - 1) % 12 + 1, 1) for m in range(11, 23)]  # Nov 26..Oct 27
MONTHS = ACT_MONTHS + FC_MONTHS

# ---- Materials: code, name, family, formulation, list price EUR/kg, industries served
MATERIALS = [
    ("ENZ-1010", "AlphaAmylase L 120",        "Alpha-Amylase",    "Liquid",    4.80, ["Starch & Sweeteners", "Bioenergy"]),
    ("ENZ-1020", "AlphaAmylase HT 240",       "Alpha-Amylase",    "Liquid",    5.60, ["Bioenergy", "Starch & Sweeteners", "Brewing"]),
    ("ENZ-1030", "FungAmyl Bake 50 BG",       "Alpha-Amylase",    "Granulate",18.50, ["Baking"]),
    ("ENZ-1110", "GlucoMax 400 L",            "Glucoamylase",     "Liquid",    3.90, ["Bioenergy", "Starch & Sweeteners", "Brewing"]),
    ("ENZ-1210", "ProtaClean Ultra 16 L",     "Protease",         "Liquid",    7.40, ["Household Care"]),
    ("ENZ-1220", "ProtaClean Evity 24 T",     "Protease",         "Granulate", 9.20, ["Household Care"]),
    ("ENZ-1230", "FeedPro 100 G",             "Protease",         "Granulate", 6.80, ["Animal Feed"]),
    ("ENZ-1240", "BrewPro Neutral 1.5 MG",    "Protease",         "Powder",   14.20, ["Brewing", "Food Processing"]),
    ("ENZ-1310", "LipoBright 100 L",          "Lipase",           "Liquid",   11.30, ["Household Care"]),
    ("ENZ-1320", "LipoBake Fresh 25",         "Lipase",           "Powder",   32.00, ["Baking"]),
    ("ENZ-1410", "CelluSoft Textile L",       "Cellulase",        "Liquid",    6.10, ["Textiles", "Household Care"]),
    ("ENZ-1420", "CelluCut 2G Biomass",       "Cellulase",        "Liquid",    3.40, ["Bioenergy"]),
    ("ENZ-1510", "XylaFeed 10000 G",          "Xylanase",         "Granulate", 7.90, ["Animal Feed"]),
    ("ENZ-1520", "XylaBake Crisp 500",        "Xylanase",         "Powder",   21.50, ["Baking"]),
    ("ENZ-1610", "PhytaMax 10000 TPT",        "Phytase",          "Granulate", 8.60, ["Animal Feed"]),
    ("ENZ-1620", "PhytaMax Liquid 5000",      "Phytase",          "Liquid",    7.70, ["Animal Feed"]),
    ("ENZ-1710", "LactaZero 5500 L",          "Lactase",          "Liquid",   42.00, ["Dairy"]),
    ("ENZ-1810", "CoaguPure Chymosin 650",    "Chymosin",         "Liquid",   78.00, ["Dairy"]),
    ("ENZ-1910", "PectaClear Juice XL",       "Pectinase",        "Liquid",   12.40, ["Juice & Wine", "Food Processing"]),
    ("ENZ-1920", "PectaScour Bio 3000",       "Pectinase",        "Liquid",    9.80, ["Textiles"]),
    ("ENZ-2010", "TransGlu Bind TG-K",        "Transglutaminase", "Powder",   26.50, ["Food Processing", "Dairy"]),
    ("ENZ-2110", "BetaGlu Brew 200 L",        "Beta-Glucanase",   "Liquid",   10.60, ["Brewing"]),
    ("ENZ-2210", "MannaWash 4.0 L",           "Mannanase",        "Liquid",    8.90, ["Household Care"]),
    ("ENZ-2310", "CataTex Peroxide Kill L",   "Catalase",         "Liquid",    5.20, ["Textiles"]),
]
LAUNCH = ("ENZ-2420", "ProtaClean ColdWash 30 L", "Protease", "Liquid", 10.50, ["Household Care"])

REGIONS = {
    "EMEA":          {"planner": "Sofie Jensen",   "countries": {"Germany": 1.3, "France": 1.0, "Denmark": 0.6, "Netherlands": 0.8, "Spain": 0.8, "Poland": 0.7, "United Kingdom": 0.9, "Türkiye": 0.6}},
    "North America": {"planner": "Marcus Reed",    "countries": {"United States": 2.6, "Canada": 0.8, "Mexico": 0.9}},
    "LATAM":         {"planner": "Camila Torres",  "countries": {"Brazil": 1.6, "Argentina": 0.8, "Chile": 0.5}},
    "APAC":          {"planner": "Wei Zhang",      "countries": {"China": 2.2, "India": 1.4, "Japan": 0.8, "Indonesia": 0.8, "Thailand": 0.7, "Australia": 0.5}},
}
REGION_PRICE = {"EMEA": 1.06, "North America": 1.03, "LATAM": 0.94, "APAC": 0.90}

# Fictional customers per industry
CUSTOMERS = {
    "Baking":              ["Golden Crust Bakeries", "Hearthstone Foods", "MillRun Ingredients", "Panaria Group"],
    "Brewing":             ["Northgate Brewing Co.", "Hopfield Breweries", "Copperleaf Beverages"],
    "Dairy":               ["Alpenmilch Cooperative", "Riverdale Dairy", "Lacteo Unidos", "Nordic Creamery"],
    "Starch & Sweeteners": ["Cornerstone Starch", "SweetGrain Processing", "AmyloTech Refiners"],
    "Household Care":      ["BrightHome Consumer", "PureWave Detergents", "Lumen Home Care", "Cleanova Brands"],
    "Animal Feed":         ["AgriNutri Feeds", "Prairie Livestock Nutrition", "AquaGrow Feed", "Harvest Premix"],
    "Bioenergy":           ["GreenField Ethanol", "BioFuel Partners", "Sunbelt Renewables"],
    "Textiles":            ["Indigo Mills", "Loomcraft Textiles", "Saraswati Denim"],
    "Juice & Wine":        ["Orchard Valley Juices", "Vinea Estates"],
    "Food Processing":     ["ProteinWorks Foods", "Meridian Food Systems"],
}
# Base monthly volume (kg) per account by industry, and annual growth
IND_BASE = {"Baking": 2200, "Brewing": 3500, "Dairy": 900, "Starch & Sweeteners": 14000,
            "Household Care": 16000, "Animal Feed": 11000, "Bioenergy": 26000, "Textiles": 4200,
            "Juice & Wine": 1500, "Food Processing": 1300}
IND_GROWTH = {"Baking": 0.03, "Brewing": 0.01, "Dairy": 0.06, "Starch & Sweeteners": 0.02,
              "Household Care": 0.05, "Animal Feed": 0.07, "Bioenergy": 0.04, "Textiles": -0.02,
              "Juice & Wine": 0.02, "Food Processing": 0.05}
# Seasonality index by calendar month (1..12)
def season(ind, month, region):
    south = region == "LATAM" or False
    m = month
    if ind == "Baking":         s = 1 + 0.18 * math.cos((m - 11.5) / 12 * 2 * math.pi)
    elif ind == "Brewing":      s = 1 + 0.22 * math.cos((m - (1 if south else 7)) / 12 * 2 * math.pi)
    elif ind == "Juice & Wine": s = 1 + 0.30 * math.cos((m - (3 if south else 9)) / 12 * 2 * math.pi)
    elif ind == "Bioenergy":    s = 1 + 0.08 * math.cos((m - 10) / 12 * 2 * math.pi)
    elif ind == "Household Care": s = 1 + 0.06 * math.cos((m - 3) / 12 * 2 * math.pi)
    else:                       s = 1 + 0.04 * math.cos((m - 5) / 12 * 2 * math.pi)
    return s


def month_idx(d):  # months since Jan 2026
    return (d.year - 2026) * 12 + d.month - 1


def build_series(region, country, cweight, material, customer, industry, start_idx=0, launch=False):
    code, name, fam, form, price, _ = material
    base = IND_BASE[industry] * cweight * random.uniform(0.35, 1.6)
    growth = IND_GROWTH[industry] + random.uniform(-0.04, 0.05)
    price_kg = round(price * REGION_PRICE[region] * random.uniform(0.92, 1.08), 2)
    bias = random.uniform(-0.06, 0.08)         # stat model bias for this series
    noise = random.uniform(0.05, 0.16)         # demand volatility
    lumpy = industry in ("Bioenergy", "Starch & Sweeteners") and random.random() < 0.35
    rows = []
    for i, d in enumerate(MONTHS):
        if i < start_idx:
            continue
        t = month_idx(d)
        trend = (1 + growth) ** (t / 12)
        seas = season(industry, d.month, region)
        if launch:  # S-curve ramp for the new launch
            ramp = 1 / (1 + math.exp(-(t - 15) / 1.6))
            trend *= ramp * 1.4
        true_demand = base * trend * seas
        py = base * (1 + growth) ** ((t - 12) / 12) * seas * random.uniform(0.9, 1.1)
        if launch:
            py = 0.0
        stat = true_demand * (1 + bias) * random.uniform(0.97, 1.03)
        if d in ACT_MONTHS:
            shock = random.gauss(0, noise)
            if lumpy and random.random() < 0.25:
                shock += random.choice([-0.45, 0.4])
            actual = max(0.0, true_demand * (1 + shock))
            consensus = stat * random.uniform(0.95, 1.06)
            ptype = "Actual"
        else:
            actual = None
            # Sales/market intelligence layer on top of stat forecast
            consensus = stat * random.uniform(0.94, 1.08)
            ptype = "Forecast"
        rows.append({
            "plan_cycle": "2026-11",
            "material_code": code, "material_name": name, "enzyme_family": fam, "formulation": form,
            "industry": industry, "region": region, "country": country, "customer": customer,
            "demand_planner": REGIONS[region]["planner"],
            "period": d.isoformat(), "period_type": ptype,
            "actual_kg": None if actual is None else round(actual, 1),
            "stat_forecast_kg": round(stat, 1), "consensus_kg": round(consensus, 1),
            "prior_year_kg": round(py, 1), "price_eur_per_kg": price_kg,
        })
    return rows


def main():
    combos = set()
    rows = []
    region_w = {"EMEA": 0.36, "North America": 0.24, "LATAM": 0.14, "APAC": 0.26}
    while len(combos) < 166:
        region = random.choices(list(region_w), weights=region_w.values())[0]
        countries = REGIONS[region]["countries"]
        country = random.choices(list(countries), weights=countries.values())[0]
        mat = random.choice(MATERIALS)
        industry = random.choice(mat[5])
        customer = random.choice(CUSTOMERS[industry])
        key = (mat[0], customer, country)
        if key in combos:
            continue
        combos.add(key)
        rows += build_series(region, country, countries[country], mat, customer, industry)
    # New product launch: no history, 12 forecast months only -> 166*18 + 12 = 3,000 rows
    rows += build_series("EMEA", "Germany", 1.3, LAUNCH, "BrightHome Consumer", "Household Care",
                         start_idx=len(ACT_MONTHS), launch=True)
    rows.sort(key=lambda r: (r["region"], r["country"], r["industry"], r["material_code"], r["customer"], r["period"]))
    assert len(rows) == 3000, len(rows)

    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "demand_plan.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    # Seed comments: business context a planner would add
    templates = [
        ("Tender pending", "National tender for {c} submitted, decision expected end of {m}. Volume included at 50% probability."),
        ("Tender pending", "{c} running a supplier tender for 2027 volumes – award pending. Upside if we win."),
        ("Customer confirmed", "{c} confirmed volumes in writing (PO received) for {m}."),
        ("Customer confirmed", "Call with {c} procurement – annual contract confirmed, monthly call-offs as forecasted."),
        ("New business", "New plant start-up at {c} – first commercial orders from {m}."),
        ("Lost business", "{c} moving part of volume to competitor from {m}, reduced by ~30%."),
        ("Price change", "Price increase of 4% effective {m}; customer may pre-buy the month before."),
        ("Promotion / campaign", "{c} launching a new product line, extra volume for pipeline fill in {m}."),
        ("Supply constraint", "Fermentation capacity tight in {m} – allocation may apply. Check with supply planning."),
        ("Regulatory", "Registration renewal pending in market; risk of shipment hold in {m}."),
        ("Phasing / timing", "Customer shifted delivery from {m} to the following month due to warehouse move."),
    ]
    fc = [r for r in rows if r["period_type"] == "Forecast"]
    random.shuffle(fc)
    comments = []
    for r in fc[:48]:
        cat, tpl = random.choice(templates)
        m = dt.date.fromisoformat(r["period"]).strftime("%b %Y")
        comments.append({"key": [r["material_code"], r["customer"], r["country"], r["period"]],
                         "category": cat, "body": tpl.format(c=r["customer"], m=m),
                         "author": REGIONS[r["region"]]["planner"],
                         "status": "Resolved" if random.random() < 0.25 else "Open"})
    # Seed overrides that accompany some comments
    overrides = []
    for cm, r in zip(comments, fc[:48]):
        if cm["category"] in ("Tender pending", "New business", "Lost business", "Promotion / campaign", "Customer confirmed") and random.random() < 0.7:
            f = {"Tender pending": 1.25, "New business": 1.4, "Lost business": 0.7,
                 "Promotion / campaign": 1.2, "Customer confirmed": 1.05}[cm["category"]]
            overrides.append({"key": cm["key"], "override_kg": round(r["consensus_kg"] * f, 1), "author": cm["author"],
                              "note": cm["category"]})
    with open(os.path.join(ROOT, "data", "seed_comments.json"), "w", encoding="utf-8") as f:
        json.dump({"comments": comments, "overrides": overrides}, f, indent=1, ensure_ascii=False)
    print(len(rows), "rows;", len(comments), "comments;", len(overrides), "overrides")


if __name__ == "__main__":
    main()
