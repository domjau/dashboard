"""Generate a realistic 3,000-row seafood demand plan (sample data, fictional).

Grain: Product x Customer x Country x Month
Horizon: 6 months of actuals (May-Oct 2026) + 12 months of forecast (Nov 2026 - Oct 2027)
Units: kg and EUR

Output: data/demand_plan.csv, data/seed_comments.json
"""
import csv, json, math, random, datetime as dt, os

random.seed(7)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ACT_MONTHS = [dt.date(2026, m, 1) for m in range(5, 11)]  # May..Oct 2026
FC_MONTHS = [dt.date(2026 + (m > 12), (m - 1) % 12 + 1, 1) for m in range(11, 23)]  # Nov 26..Oct 27
MONTHS = ACT_MONTHS + FC_MONTHS

# ---- Products: code, name, species, format, list price EUR/kg, channels served
PRODUCTS = [
    ("FSH-1010", "Atlantic Salmon Fillet Skin-on",   "Salmon",    "Fresh",  13.80, ["Retail", "Foodservice", "Wholesale"]),
    ("FSH-1020", "Atlantic Salmon Portions 125g",    "Salmon",    "Frozen", 15.20, ["Retail", "E-commerce"]),
    ("FSH-1030", "Cold-Smoked Salmon Sliced 200g",   "Salmon",    "Smoked", 29.50, ["Retail", "E-commerce", "Foodservice"]),
    ("FSH-1040", "Hot-Smoked Salmon Flakes",         "Salmon",    "Smoked", 24.00, ["Food Processing", "Foodservice"]),
    ("FSH-1110", "Atlantic Cod Loins",               "Cod",       "Frozen", 12.40, ["Foodservice", "Retail"]),
    ("FSH-1120", "Cod Fillet Fresh",                 "Cod",       "Fresh",  14.60, ["Retail", "Foodservice"]),
    ("FSH-1130", "Salted Cod (Bacalao)",             "Cod",       "Salted", 11.20, ["Retail", "Wholesale"]),
    ("FSH-1210", "Alaska Pollock Fillet Blocks",     "Pollock",   "Frozen",  4.30, ["Food Processing", "QSR"]),
    ("FSH-1220", "Breaded Fish Fingers 450g",        "Pollock",   "Frozen",  6.10, ["Retail", "Foodservice"]),
    ("FSH-1230", "Battered Fish Portions QSR",       "Pollock",   "Frozen",  5.40, ["QSR"]),
    ("FSH-1310", "Cooked & Peeled Shrimp 90/120",    "Shrimp",    "Frozen", 12.90, ["Retail", "Food Processing"]),
    ("FSH-1320", "Raw Tiger Prawns 16/20",           "Shrimp",    "Frozen", 17.50, ["Foodservice", "Wholesale", "E-commerce"]),
    ("FSH-1330", "Cold-Water Prawns in Brine",       "Shrimp",    "Chilled",14.20, ["Retail"]),
    ("FSH-1410", "Yellowfin Tuna Loins Sashimi",     "Tuna",      "Frozen", 18.90, ["Foodservice", "Wholesale"]),
    ("FSH-1420", "Tuna Chunks in Olive Oil 160g",    "Tuna",      "Canned",  8.40, ["Retail", "E-commerce"]),
    ("FSH-1510", "Mackerel Fillets Smoked Peppered", "Mackerel",  "Smoked",  9.60, ["Retail"]),
    ("FSH-1520", "Whole Mackerel Frozen",            "Mackerel",  "Frozen",  2.90, ["Wholesale", "Food Processing"]),
    ("FSH-1610", "Marinated Herring Fillets",        "Herring",   "Chilled", 6.20, ["Retail"]),
    ("FSH-1620", "Herring Fillets Frozen",           "Herring",   "Frozen",  3.10, ["Food Processing", "Wholesale"]),
    ("FSH-1710", "Rainbow Trout Fillet",             "Trout",     "Fresh",  11.40, ["Retail", "Foodservice"]),
    ("FSH-1810", "Pangasius Fillets IQF",            "Pangasius", "Frozen",  3.60, ["Foodservice", "Wholesale", "QSR"]),
    ("FSH-1910", "Haddock Fillet Smoked",            "Haddock",   "Smoked", 13.10, ["Retail", "Foodservice"]),
    ("FSH-2010", "Seafood Mix Paella",               "Mixed",     "Frozen",  9.80, ["Retail", "Foodservice"]),
    ("FSH-2110", "Fish Cakes Salmon & Dill",         "Mixed",     "Chilled", 8.90, ["Retail", "E-commerce"]),
]
LAUNCH = ("FSH-2210", "Plant-Fed Salmon Poke Cubes", "Salmon", "Fresh", 21.50, ["Retail"])

REGIONS = {
    "EMEA":          {"planner": "Sofie Jensen",   "countries": {"Germany": 1.2, "France": 1.1, "Norway": 0.7, "Netherlands": 0.8, "Spain": 1.2, "Poland": 0.8, "United Kingdom": 1.1, "Italy": 0.9}},
    "North America": {"planner": "Marcus Reed",    "countries": {"United States": 2.4, "Canada": 0.8, "Mexico": 0.6}},
    "LATAM":         {"planner": "Camila Torres",  "countries": {"Brazil": 1.4, "Chile": 0.7, "Argentina": 0.5}},
    "APAC":          {"planner": "Wei Zhang",      "countries": {"China": 1.8, "Japan": 1.4, "South Korea": 0.8, "Singapore": 0.5, "Australia": 0.7}},
}
REGION_PRICE = {"EMEA": 1.05, "North America": 1.08, "LATAM": 0.93, "APAC": 1.02}

# Fictional customers per sales channel
CUSTOMERS = {
    "Retail":          ["NorthMart Supermarkets", "FreshWay Grocers", "Baltic Retail Group", "Coastline Foods Retail", "ValuePlus Discount"],
    "Foodservice":     ["Harbour Catering Co.", "Sea Table Restaurants", "Metro Hospitality Group", "Galley Contract Catering"],
    "Wholesale":       ["Blue Dock Wholesale", "Atlantic Fish Traders", "Pier 9 Distribution"],
    "Food Processing": ["ReadyMeal Kitchens", "Ocean Deli Manufacturing", "SushiPro Prep"],
    "QSR":             ["FishBite Restaurants", "QuickCatch Fast Food"],
    "E-commerce":      ["CrateFresh Online", "SeaBox Meal Kits"],
}
# Base monthly volume (kg) per account by channel, and annual growth
CH_BASE = {"Retail": 7000, "Foodservice": 4200, "Wholesale": 9000, "Food Processing": 11000, "QSR": 8000, "E-commerce": 1600}
CH_GROWTH = {"Retail": 0.03, "Foodservice": 0.04, "Wholesale": 0.01, "Food Processing": 0.03, "QSR": 0.05, "E-commerce": 0.14}


def season(species, fmt, month, region):
    """Seasonality index for a calendar month (1..12)."""
    south = region in ("LATAM",) or False
    m = month
    s = 1.0
    if fmt == "Smoked" and species == "Salmon":
        s += {12: 0.85, 11: 0.25, 1: -0.15, 4: 0.12}.get(m, 0)          # Christmas & Easter peaks
    elif species == "Cod" or fmt == "Salted":
        s += {12: 0.30, 3: 0.35, 4: 0.30, 2: 0.10}.get(m, 0)            # Christmas + Lent/Easter
    elif species == "Shrimp":
        s += 0.22 * math.cos((m - (1 if south else 7)) / 12 * 2 * math.pi) + (0.25 if m == 12 else 0)
    elif species == "Herring":
        s += {6: 0.55, 12: 0.45, 4: 0.15}.get(m, 0)                     # Midsummer & Christmas
    elif species == "Mackerel":
        s += 0.18 * math.cos((m - 9) / 12 * 2 * math.pi)                # autumn season
    elif species == "Tuna" and fmt == "Canned":
        s += {1: 0.12, 9: 0.08}.get(m, 0)                               # promo windows
    elif species == "Pollock":
        s += 0.10 * math.cos((m - 1) / 12 * 2 * math.pi)                # winter comfort food
    else:
        s += 0.06 * math.cos((m - 12) / 12 * 2 * math.pi)
    return max(0.4, s)


def month_idx(d):  # months since Jan 2026
    return (d.year - 2026) * 12 + d.month - 1


def build_series(region, country, cweight, product, customer, channel, start_idx=0, launch=False):
    code, name, species, fmt, price, _ = product
    base = CH_BASE[channel] * cweight * random.uniform(0.35, 1.6)
    growth = CH_GROWTH[channel] + random.uniform(-0.05, 0.05)
    price_kg = round(price * REGION_PRICE[region] * random.uniform(0.92, 1.08), 2)
    bias = random.uniform(-0.06, 0.08)          # stat model bias for this series
    noise = random.uniform(0.06, 0.18)          # demand volatility (fresh fish is volatile)
    if fmt == "Fresh":
        noise += 0.04
    lumpy = channel in ("Wholesale", "Food Processing") and random.random() < 0.35
    rows = []
    for i, d in enumerate(MONTHS):
        if i < start_idx:
            continue
        t = month_idx(d)
        trend = (1 + growth) ** (t / 12)
        seas = season(species, fmt, d.month, region)
        if launch:  # S-curve ramp for the new launch
            trend *= 1 / (1 + math.exp(-(t - 15) / 1.6)) * 1.4
        true_demand = base * trend * seas
        py = 0.0 if launch else base * (1 + growth) ** ((t - 12) / 12) * seas * random.uniform(0.9, 1.1)
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
            consensus = stat * random.uniform(0.94, 1.08)   # sales / market intelligence on top of stat
            ptype = "Forecast"
        rows.append({
            "plan_cycle": "2026-11",
            "product_code": code, "product_name": name, "species": species, "product_format": fmt,
            "channel": channel, "region": region, "country": country, "customer": customer,
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
    region_w = {"EMEA": 0.42, "North America": 0.22, "LATAM": 0.12, "APAC": 0.24}
    while len(combos) < 166:
        region = random.choices(list(region_w), weights=region_w.values())[0]
        countries = REGIONS[region]["countries"]
        country = random.choices(list(countries), weights=countries.values())[0]
        prod = random.choice(PRODUCTS)
        channel = random.choice(prod[5])
        customer = random.choice(CUSTOMERS[channel])
        key = (prod[0], customer, country)
        if key in combos:
            continue
        combos.add(key)
        rows += build_series(region, country, countries[country], prod, customer, channel)
    # New product launch: no history, 12 forecast months only -> 166*18 + 12 = 3,000 rows
    rows += build_series("EMEA", "Germany", 1.2, LAUNCH, "NorthMart Supermarkets", "Retail",
                         start_idx=len(ACT_MONTHS), launch=True)
    rows.sort(key=lambda r: (r["region"], r["country"], r["channel"], r["product_code"], r["customer"], r["period"]))
    assert len(rows) == 3000, len(rows)

    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "demand_plan.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    # Seed comments: business context a demand planner would add
    templates = [
        ("Tender pending", "{c} running a private-label tender for 2027 – award expected end of {m}. Volume included at 50% probability."),
        ("Tender pending", "Annual seafood tender at {c} submitted; decision pending. Upside if we win the frozen range."),
        ("Customer confirmed", "{c} confirmed volumes in writing (PO received) for {m}."),
        ("Customer confirmed", "Call with {c} buyer – Christmas/Easter programme confirmed, weekly call-offs as forecasted."),
        ("New business", "{c} listing our range in 40 new stores from {m}."),
        ("Lost business", "{c} moving part of the volume to a competitor from {m}, reduced by ~30%."),
        ("Price change", "Price increase of 6% effective {m} due to higher raw material cost; customer may pre-buy."),
        ("Promotion / campaign", "{c} running a 2-for-1 promotion in {m}, extra volume for pipeline fill."),
        ("Supply constraint", "Harvest volumes low in {m} – allocation may apply. Check with supply planning."),
        ("Catch / quota", "Quota cut announced for next season; raw material availability at risk around {m}."),
        ("Regulatory", "Import health certificate renewal pending; risk of shipment hold in {m}."),
        ("Phasing / timing", "Customer shifted delivery from {m} to the following month due to cold-store move."),
    ]
    fc = [r for r in rows if r["period_type"] == "Forecast"]
    random.shuffle(fc)
    comments = []
    for r in fc[:48]:
        cat, tpl = random.choice(templates)
        m = dt.date.fromisoformat(r["period"]).strftime("%b %Y")
        comments.append({"key": [r["product_code"], r["customer"], r["country"], r["period"]],
                         "category": cat, "body": tpl.format(c=r["customer"], m=m),
                         "author": REGIONS[r["region"]]["planner"],
                         "status": "Resolved" if random.random() < 0.25 else "Open"})
    overrides = []
    factors = {"Tender pending": 1.25, "New business": 1.4, "Lost business": 0.7, "Promotion / campaign": 1.3,
               "Customer confirmed": 1.05, "Supply constraint": 0.85, "Catch / quota": 0.8}
    for cm, r in zip(comments, fc[:48]):
        if cm["category"] in factors and random.random() < 0.7:
            overrides.append({"key": cm["key"], "override_kg": round(r["consensus_kg"] * factors[cm["category"]], 1),
                              "author": cm["author"], "note": cm["category"]})
    with open(os.path.join(ROOT, "data", "seed_comments.json"), "w", encoding="utf-8") as f:
        json.dump({"comments": comments, "overrides": overrides}, f, indent=1, ensure_ascii=False)
    print(len(rows), "rows;", len(comments), "comments;", len(overrides), "overrides")


if __name__ == "__main__":
    main()
