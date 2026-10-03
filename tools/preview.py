#!/usr/bin/env python3
"""Local preview harness for the injected UI and the vehicle dashboard.

Serves the brand layer with a mock LubeLogger API so the dashboard can be
rendered and eyeballed without real vehicle data. Upstream's own bundles
(bootstrap, jQuery, chart.js, the themed site.css) are pulled once from a
running Road Track container and cached under /tmp/rt-preview-cache — delete
that directory to fetch them again.

    docker run --rm -p 8080:8080 ghcr.io/spencercnorton/roadtrack:latest
    python3 tools/preview.py [port]      → http://127.0.0.1:8899/

An image built from this repository (`docker build -t roadtrack-local .`)
works just as well. RT_UPSTREAM points the harness at any other instance
(default http://127.0.0.1:8080); only anonymous static files are fetched, so
it needs no login and no data.

Not shipped in the image; a development tool only.
"""
import http.server
import json
import os
import pathlib
import random
import socketserver
import sys
import urllib.request
from datetime import date, timedelta

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = pathlib.Path("/tmp/rt-preview-cache")
UPSTREAM = os.environ.get("RT_UPSTREAM", "http://127.0.0.1:8080").rstrip("/")
VERSION = (ROOT / "VERSION").read_text().strip()

# Anonymous static bundles, fetched from UPSTREAM and cached.
PASSTHROUGH = (
    "/lib/bootstrap/dist/css/bootstrap.min.css",
    "/lib/bootstrap/dist/css/bootstrap-icons.css",
    "/lib/chart-js/chart.umd.js",
    "/css/site.css",
    # jQuery and Bootstrap's bundle are here so the Collaborators tab is
    # actually EXERCISABLE in the harness: without Bootstrap's JS the
    # data-bs-toggle never fires shown.bs.tab, and without jQuery the panel
    # never loads. A fixture that can only prove the button was added would
    # certify half the feature.
    "/lib/jquery/dist/jquery.min.js",
    "/lib/bootstrap/dist/js/bootstrap.bundle.min.js",
)

VEHICLES = [
    {"id": 1, "year": 2019, "make": "Subaru", "model": "Forester",
     "licensePlate": "ABC-1234", "useHours": False, "isElectric": False},
    {"id": 2, "year": 2023, "make": "Ford", "model": "F-150",
     "licensePlate": "XYZ-9876", "useHours": False, "isElectric": False},
    # Hours-based equipment, so the mixed-unit suppression path is reachable
    # in the preview harness rather than only in production.
    {"id": 3, "year": 2021, "make": "Kubota", "model": "L2501",
     "licensePlate": "", "useHours": True, "isElectric": False},
]


def generate():
    """Three years of plausible records, deterministic so screenshots are stable."""
    rng = random.Random(20260807)
    today = date.today()
    start = today - timedelta(days=365 * 3)
    out = {k: [] for k in ("service", "repair", "upgrade", "tax", "gas", "odometer")}
    odo = {1: 41000, 2: 3000}

    day = start
    while day <= today:
        for vid in (1, 2):
            # Fuel roughly every 10 days per vehicle.
            if rng.random() < 0.10:
                odo[vid] += rng.randint(180, 420)
                gallons = round(rng.uniform(9, 19), 2)
                out["gas"].append({
                    "vehicleId": vid, "id": len(out["gas"]) + 1,
                    "date": day.isoformat(), "odometer": odo[vid],
                    "cost": round(gallons * rng.uniform(3.1, 4.4), 2),
                    "fuelConsumed": gallons,
                    "fuelEconomy": round(rng.uniform(21, 31), 2),
                    "isFillToFull": True, "missedFuelUp": False,
                    "description": "Fuel", "notes": "", "tags": "",
                })
            if rng.random() < 0.012:
                out["service"].append(_rec("service", vid, day, odo[vid],
                                           round(rng.uniform(45, 480), 2),
                                           rng.choice(["Oil change", "Tire rotation",
                                                       "Brake pads", "Air filter",
                                                       "Transmission service"])))
            if rng.random() < 0.004:
                out["repair"].append(_rec("repair", vid, day, odo[vid],
                                          round(rng.uniform(180, 1900), 2),
                                          rng.choice(["Alternator", "Water pump",
                                                      "AC compressor", "Wheel bearing"])))
            if rng.random() < 0.003:
                out["upgrade"].append(_rec("upgrade", vid, day, odo[vid],
                                           round(rng.uniform(120, 1400), 2),
                                           rng.choice(["Roof rack", "Tow hitch",
                                                       "Winter tires", "Head unit"])))
        # Registration once a year per vehicle.
        if day.month == 6 and day.day == 15:
            for vid in (1, 2):
                out["tax"].append(_rec("tax", vid, day, odo[vid],
                                       round(rng.uniform(90, 320), 2), "Registration"))
        day += timedelta(days=1)
    return out


def _rec(kind, vid, day, odometer, cost, description):
    return {"vehicleId": vid, "id": abs(hash((kind, vid, day.toordinal()))) % 100000,
            "date": day.isoformat(), "odometer": odometer, "cost": cost,
            "description": description, "notes": "", "tags": "",
            "extraFields": [], "files": []}


DATA = generate()

# A garage can log ZERO fuel and ZERO tax records, and plenty do. The default
# generator's tidy every-ten-days fill-up is exactly why two bugs once survived
# into a release (the "¤" currency placeholder and a three-figure cost-per-mile
# spike) — a harness kinder than reality certifies the bugs it invents.
# REALISTIC=1 reproduces that shape: no fuel, no tax, so only sparse odometer
# readings remain.
if os.environ.get("REALISTIC"):
    DATA["gas"] = []
    DATA["tax"] = []
    # ...and zero-cost records from before the purchase: the PREVIOUS OWNER's
    # service history, which comes with a car bought second-hand. They carry no
    # spend, so they cannot move a money total — but they are the oldest
    # records on file, which is what every lifetime figure used to measure
    # from. Mileages ascend, because a flat reading would hide the half of the
    # problem that is distance: unanchored, this vehicle has "covered" every
    # mile since its first service.
    # Dated inside the car's own life — after a 2019 model year went on sale
    # and before the purchase the fixtures below record — and climbing to just
    # under the 41,000 the generator's own history starts at, so the series
    # stays consistent: an owner-era reading LOWER than a previous-owner one is
    # a different bug's test case, not this one's.
    for when, odometer in ((date(2018, 11, 1), 6500), (date(2019, 3, 1), 18400),
                           (date(2019, 8, 1), 31200), (date(2019, 11, 1), 36900)):
        DATA["service"].append(_rec("service", 1, when, odometer, 0.0,
                                    "Odometer reading"))
    # SPARSE=1 is the CASUAL-USER shape, and it is the one the harness was
    # missing. A meticulously kept garage has a mileage on every record; most
    # garages will not. A casual user files a few receipts a year, most without
    # an odometer on them, and never opens the Odometer tab.
    #
    # Every per-distance figure then divides a whole history's money by part of
    # its distance, which reads HIGH and does it silently. Strip the odometer
    # off everything outside the first quarter to reproduce it.
    if os.environ.get("SPARSE"):
        _owned = [r for b in ("service", "repair", "upgrade") for r in DATA[b]
                  if float(r["cost"] or 0) > 0]
        if _owned:
            _first = min(r["date"] for r in _owned)
            _cutoff = (date.fromisoformat(_first) + timedelta(days=90)).isoformat()
            for bucket in ("service", "repair", "upgrade"):
                for r in DATA[bucket]:
                    # Readings survive only in the first quarter of the history.
                    # "0" and not None: that is what LubeLogger stores for a
                    # record whose odometer box was left empty, so this
                    # exercises the same parse the real data does.
                    if r["date"] > _cutoff:
                        r["odometer"] = "0"

    # ODOMETER=1 puts the mileage where LubeLogger's own Odometer tab puts it:
    # in odometer records, with NOT ONE receipt carrying a reading.
    #
    # This harness had no such fixture, and could not have had one —
    # /api/vehicle/odometerrecords/all was not a route here at all, so
    # `api(ODOMETER_SOURCE).catch(() => [])` in vehicle-dash.js swallowed a 404
    # and every odometer-record path on the page was, from this harness's point
    # of view, dead code. That is how the dashboard shipped with its cost-per-
    # distance tile reading "estimated" while the footnote beneath it decided
    # nothing had been estimated and dropped the caveat: the tile divides by
    # spend PLUS readings, the footnote described spend alone, and no fixture
    # here could tell the two sets apart.
    #
    # The readings STOP two thirds of the way through the history, deliberately.
    # A vehicle whose readings cover every month it has receipts for needs no
    # estimate, so a fixture like that cannot reach the branch under test.
    if os.environ.get("ODOMETER"):
        _spend = [r for b in ("service", "repair", "upgrade", "gas", "tax")
                  for r in DATA[b] if int(float(r["odometer"] or 0))]
        _spend.sort(key=lambda r: r["date"])
        _cutoff = _spend[len(_spend) * 2 // 3]["date"] if _spend else ""
        DATA["odometer"] = [
            {"vehicleId": r["vehicleId"], "id": i + 1, "date": r["date"],
             "odometer": r["odometer"], "notes": "", "tags": "",
             "extraFields": [], "files": []}
            for i, r in enumerate(r for r in _spend if r["date"] <= _cutoff)
        ]
        for bucket in ("service", "repair", "upgrade", "gas", "tax"):
            for r in DATA[bucket]:
                # "0", not None: that is what LubeLogger stores for a record
                # whose odometer box was left empty, so this runs the same parse
                # the real data does.
                r["odometer"] = "0"

    # ANCHORED=1 fills in what the owner would type into the vehicle form, so
    # the anchored and unanchored renderings can be compared side by side.
    if os.environ.get("ANCHORED"):
        VEHICLES[0]["purchaseDate"] = "2020-01-30"
        VEHICLES[0]["extraFields"] = [
            {"name": "Odometer at purchase", "value": "38400", "isRequired": False},
        ]
        # THE SPIKE. The first thing anybody does with a used car is service
        # it, so the biggest early bill lands two days after the purchase and
        # twelve miles later — and "running cost per mile" opens at $166.67.
        # That one point set the y-axis for every year that followed and
        # flattened the few tens of cents the line actually lives at into a
        # smear along the bottom, which is what made the chart unusable.
        #
        # This block's whole job is to be the shape real data takes, and for a
        # while it did not carry this: the comment above claimed the fixture
        # reproduced the spike while the data could not produce one.
        #
        # Bought on the 30th so those two days cross into the next month: a
        # chart that starts at the purchase opens in January, one that starts
        # at the first receipt in February, and check_vehicle_tabs.py can tell
        # the two apart. Bought mid-month, both opened in January.
        DATA["service"].append(
            _rec("service", 1, date(2020, 2, 1), 38412, 2000.0,
                 "Post-purchase inspection and service"))

    # FINANCED=1 is the Finance tab's fixture: a car bought on a loan, with a
    # couple of valuations since. Layered ON TOP of ANCHORED rather than
    # instead of it — the purchase anchor is what places the loan on a
    # calendar, and a financed vehicle with no purchase date exercises a
    # different (also real) branch that the tab reports rather than draws.
    # VALUED=1 is a common shape for a car that has been owned a while: a
    # worth typed in, and NO purchase price at all. There is nothing to anchor
    # a ratio to, so the curve has to run backwards off that single figure or
    # the vehicle charts one dot. Deliberately on vehicle 1 rather than 0 so it
    # never collides with FINANCED, and deliberately with no purchaseDate: the
    # bug this reproduces is invisible on any car that has one.
    if os.environ.get("VALUED"):
        VEHICLES[1].pop("purchaseDate", None)
        VEHICLES[1]["purchasePrice"] = 0
        # Dated INSIDE the chart's own range, not after it. A valuation later
        # than every label makes the whole line backward-modelled, which hides
        # the boundary: the segment ENDING at the first real point starts one
        # index earlier and an off-by-one there drew it solid while every
        # sampled segment around it was dashed.
        VEHICLES[1].setdefault("extraFields", []).append(
            {"name": "Estimated values", "value": "2025-06 = 20000",
             "isRequired": False})

    if os.environ.get("FINANCED"):
        VEHICLES[0]["purchaseDate"] = VEHICLES[0].get("purchaseDate") or "2020-01-30"
        VEHICLES[0]["purchasePrice"] = 20000
        fields = VEHICLES[0].setdefault("extraFields", [])
        # FINANCED=cash is a car bought OUTRIGHT — price, no loan terms. It is
        # a common shape, and it is where the first version of this feature
        # was worst wrong: with no term there was no schedule, so everything
        # paid came out as the deposit, and a $20,000 cash car reported $0
        # paid on the chart and added nothing to the toggle.
        cash = os.environ["FINANCED"] == "cash"
        for name, value in (("Odometer at purchase", "38400"),
                            ("Down payment", "" if cash else "2,000"),
                            ("Loan APR", "" if cash else "5.9"),
                            ("Loan term (months)", "" if cash else "60"),
                            # Deliberately carrying a thousands separator: the
                            # first parser here split on the comma and filed
                            # "500" as a second valuation dated today.
                            ("Estimated values", "2022-06 = 14,500, 2024-06 = 11000, "
                                                 "2026-01 = 9200")):
            if not any(f["name"] == name for f in fields):
                fields.append({"name": name, "value": value, "isRequired": False})

# A cut-down copy of upstream's real markup — the <title>/<meta> from
# Views/Shared/_Layout.cshtml (lines 35, 44) and the navbar <ul> from
# Views/Home/Index.cshtml, with the Razor expanded. Served at /fixture so
# roadtrack-ui.js can be checked against the DOM it actually has to modify:
# if upstream restructures the navbar, the Metrics tab silently disappears and
# nothing else would catch it.
#
# THE MOBILE LIST IS PART OF THE FIXTURE ON PURPOSE. Upstream ships two
# separate navigations — the tab bar above, and `.lubelogger-mobile-nav`,
# a full-screen list opened by the hamburger — and nothing copies between
# them. This fixture carried only the first one, which is exactly why the
# Metrics tab was once missing from every phone, release after release, with
# no test, no error and no way to notice short of opening the menu. A fixture
# that only contains the surface you already got right cannot catch anything.
#
# `a[href="/Admin"]` is here because isAdmin() reads it: upstream renders that
# link only inside `@if (User.IsInRole(IsAdmin))`, so its presence is the
# server's own answer and the Access tab is gated on it.
FIXTURE = """<!DOCTYPE html>
<html lang="en"><head>
<meta name="apple-mobile-web-app-title" content="LubeLogger" />
<title>Home - LubeLogger</title>
<script>function getGlobalConfig(){return {useDarkMode:false, useMPG:true};}</script>
<script src="/brand/roadtrack-ui.js"></script>
</head><body>
<div class="container-fluid lubelogger-navbar-container frosted hideOnPrint">
 <div class="row mt-2"><div class="d-flex lubelogger-navbar">
  <ul class="nav nav-tabs lubelogger-tab flex-grow-1" id="homeTab" role="tablist">
   <li class="nav-item" role="presentation">
    <button class="nav-link resizable-nav-link" id="garage-tab" type="button" role="tab">
     <i class="bi bi-car-front"></i><span class="ms-2">Garage</span></button></li>
   <li class="nav-item dropdown nav-item-persist nav-item-more me-5" role="presentation" style="display:none;">
    <a class="nav-link resizable-nav-link" data-bs-toggle="dropdown" href="#" role="button"><i class="bi bi-three-dots"></i></a>
    <ul class="dropdown-menu">
     <li class="nav-item text-truncate" role="presentation">
      <button class="nav-link resizable-nav-link" id="garage-tab" type="button" role="tab">
       <i class="bi bi-car-front"></i><span class="ms-2">Garage</span></button></li>
    </ul></li>
   <li class="nav-item ms-auto" role="presentation">
    <button class="nav-link resizable-nav-link" id="settings-tab" type="button" role="tab">
     <i class="bi bi-gear"></i><span class="ms-2">Settings</span></button></li>
  </ul>
  <button class="btn btn-adaptive" onclick="showMobileNav()">
   <i class="bi bi-list lubelogger-menu-icon"></i></button>
 </div></div></div>
<div class="lubelogger-mobile-nav">
 <ul class="nav navbar-nav">
  <li class="nav-item d-flex" role="presentation">
   <button class="nav-link flex-grow-1 text-start" onclick="returnToGarage()">
    <span class="ms-2 display-3"><i class="bi bi-car-front me-2"></i>Garage</span></button></li>
  <li class="nav-item d-flex" role="presentation">
   <button class="nav-link flex-grow-1 text-start" id="settings-tab" type="button" role="tab">
    <span class="ms-2 display-3"><i class="bi bi-gear me-2"></i>Settings</span></button></li>
  <li class="nav-item d-flex" role="presentation">
   <button class="nav-link flex-grow-1 text-start" onclick="goToAdminPanel()">
    <span class="display-3 ms-2"><i class="bi bi-people me-2"></i>Admin Panel</span></button></li>
 </ul>
</div>
<div id="settings-tab-pane">
 LubeLogger utilizes open-source dependencies to serve you the best possible
 user experience, those dependencies are:
 <a href="https://www.patreon.com/LubeLogger">Support LubeLogger on Patreon</a>
 <a href="/Admin">Admin Panel</a>
</div>
</body></html>
"""

# The VEHICLE page, which is a different DOM from the garage: its own tab bar,
# its own `#vehicleTabContent`, and a mobile nav with id="vehicleTab". The
# Collaborators tab is injected into all of it, so all of it has to be here —
# the Metrics tab was once invisible on phones, release after release,
# precisely because the fixture held only the surface that already worked.
#
# The Household entries are in this fixture even though the feature is being
# REMOVED, and that is the point: roadtrack.css hides them, and a fixture with
# nothing to hide cannot show that the selector still matches. They are copied
# from what upstream renders for a non-root user, onclick and all, because the
# rule keys on that onclick — these buttons carry no id.
FIXTURE_VEHICLE = """<!DOCTYPE html>
<html lang="en"><head>
<meta name="apple-mobile-web-app-title" content="LubeLogger" />
<!-- _Layout.cshtml:34. Without it a phone-sized window lays the page out at
     980px and every "measured at 390px" number is a desktop number. -->
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Vehicle - LubeLogger</title>
<link rel="stylesheet" href="/lib/bootstrap/dist/css/bootstrap.min.css" />
<link rel="stylesheet" href="/lib/bootstrap/dist/css/bootstrap-icons.css" />
<link rel="stylesheet" href="/brand/roadtrack.css" />
<script>function getGlobalConfig(){return {useDarkMode:false, useMPG:true};}</script>
<script src="/lib/jquery/dist/jquery.min.js"></script>
<script src="/lib/bootstrap/dist/js/bootstrap.bundle.min.js"></script>
<!-- Upstream vendors this on every page and both Road Track chart surfaces
     read `Chart` off the global rather than shipping a second copy. Without it
     applyChartDefaults() throws, installVehicleDashboard()'s catch swallows it,
     and the fixture silently serves upstream's fallback partial instead of the
     dashboard -- which looks like a rendered page and is not the one under
     test. -->
<script src="/lib/chart-js/chart.umd.js"></script>
<script>
  /* Upstream's print helper, which reports.js reuses rather than
     reimplementing. Stubbed to record its argument instead of opening a print
     dialog — a real window.print() would hang a headless check forever. */
  window.printContainer = function (html) { window.__rtPrinted = html; };
  /* Upstream's vehicle.js declares this at parse time and calls it from a
     jQuery ready handler; roadtrack-ui.js REPLACES it, and bails out if it is
     not already a function. Without a stub here the fixture served the tab bar
     and a permanently empty Dashboard pane -- so the one surface this file
     exists to preview was the one surface it could not draw, and every check
     against it certified the navbars alone. */
  window.getVehicleReport = function () {};
</script>
<script src="/brand/roadtrack-ui.js"></script>
</head><body>
<div class="container-fluid lubelogger-navbar-container frosted hideOnPrint">
 <div class="row mt-2"><div class="d-flex lubelogger-navbar">
  <ul class="nav nav-tabs lubelogger-tab flex-grow-1" id="vehicleTabDesktop" role="tablist">
   <li class="nav-item" role="presentation" style="order: 1">
    <button class="nav-link resizable-nav-link active" id="report-tab" data-bs-toggle="tab"
     data-bs-target="#report-tab-pane" type="button" role="tab" aria-selected="true">
     <i class="bi bi-graph-up"></i><span class="ms-2">Dashboard</span></button></li>
   <li class="nav-item" role="presentation" style="order: 2">
    <button class="nav-link resizable-nav-link" id="odometer-tab" data-bs-toggle="tab"
     data-bs-target="#odometer-tab-pane" type="button" role="tab" aria-selected="false">
     <i class="bi bi-speedometer"></i><span class="ms-2">Odometer</span></button></li>
   <!-- Upstream's overflow dropdown. checkNavBarOverflow() hides tab items
        from the highest css order down when the bar wraps and reveals a
        counterpart in HERE, matched by `#${hiddenButtonId}`. Ours carry the
        highest order, so without an entry they vanished with no way back at
        widths where the phone menu is still display:none. -->
   <li class="nav-item dropdown nav-item-persist nav-item-more me-5" role="presentation"
       style="display:none; order: 98">
    <ul class="dropdown-menu"></ul></li>
   <li class="nav-item ms-auto" role="presentation" style="order: 99">
    <button class="nav-link resizable-nav-link" id="settings-tab" type="button" role="tab">
     <i class="bi bi-gear"></i><span class="ms-2">Settings</span></button></li>
  </ul>
  <!-- Views/Vehicle/Index.cshtml:134 -- the vehicle's name in the header,
       first text node of span.lead, small holds the plate. addReceiptButton()
       reads it for the menu heading and the mailto subject. -->
  <span style="cursor:pointer;" onclick="editVehicle(1)" class="text-truncate"><span class="lead">2019 Subaru Forester<small class="text-body-secondary">(#ABC-1234)</small></span><span class="ms-2 lubelogger-tab"><i class="bi bi-pencil-square"></i></span></span>
  <button class="btn btn-adaptive" onclick="showMobileNav()">
   <i class="bi bi-list lubelogger-menu-icon"></i></button>
 </div></div></div>
<div class="lubelogger-mobile-nav">
 <ul class="nav navbar-nav" id="vehicleTab" role="tablist">
  <li class="nav-item d-flex" role="presentation" style="order: -3">
   <button class="nav-link flex-grow-1 text-start" onclick="returnToGarage()">
    <span class="display-3 ms-2"><i class="bi bi-arrow-left-square me-2"></i>Garage</span></button></li>
  <li class="nav-item d-flex" role="presentation" style="order: 1">
   <button class="nav-link flex-grow-1 text-start active" id="report-tab" data-bs-toggle="tab"
    data-bs-target="#report-tab-pane" type="button" role="tab">
    <span class="display-3 ms-2"><i class="bi bi-graph-up me-2"></i>Dashboard</span></button></li>
  <li class="nav-item d-flex" role="presentation">
   <button class="nav-link flex-grow-1 text-start" onclick="showHouseholdModal()">
    <span class="display-3 ms-2"><i class="bi bi-house me-2"></i>Household</span></button></li>
 </ul>
</div>
<ul class="dropdown-menu">
 <li><button class="dropdown-item" onclick="showAccountInformationModal()">Profile</button></li>
 <li><button class="dropdown-item" onclick="showHouseholdModal()">
  <i class="bi bi-house me-2"></i>Household</button></li>
</ul>
<div class="tab-content" id="vehicleTabContent">
 <div class="tab-pane fade show active" id="report-tab-pane" role="tabpanel" tabindex="0"></div>
 <div class="tab-pane fade" id="odometer-tab-pane" role="tabpanel" tabindex="0"></div>
</div>

<!-- THE VEHICLE MODAL, cut down from Views/Vehicle/_VehicleModal.cshtml (the
     accordion at lines 80-103) with the Razor expanded.

     Absent from this harness at first, which is why fitPurchasePanel() had
     never been under test here at all: it is where every purchase, anchor and
     loan figure is TYPED, and a field that renders in the wrong place or gets
     harvested twice is invisible from the dashboard side. One extra field was
     survivable to eyeball; five is not.

     An extra field upstream has already saved is rendered by upstream at the
     TOP of the form, outside this accordion — reproduced here on purpose, so
     the "move it, do not duplicate it" path is what runs. -->
<button type="button" class="btn" id="rt-open-vehicle-modal"
        data-bs-toggle="modal" data-bs-target="#vehicleModal">Edit vehicle</button>
<div class="modal fade" id="vehicleModal" tabindex="-1"><div class="modal-dialog">
 <div class="modal-content"><div class="modal-body">
  <!-- DELIBERATELY EMPTY, and outside the panel. Upstream renders a record's
       extra fields through AddExtraFields(), which returns nothing when no
       vehicle extra-field TEMPLATE is configured and strips any field not in
       it. Our five are injected, never templates, so the real edit form draws
       them blank however much is stored — and saveVehicle() then harvests the
       blanks over the real values. Reproducing the blank is the whole point. -->
  <div class="extra-field">
   <label>Odometer at purchase</label>
   <input type="number" class="form-control" value="">
  </div>
  <div class="accordion accordion-flush" id="vehicleModalAccordion">
   <div class="accordion-item">
    <div class="accordion-header">
     <button class="accordion-button skinny collapsed" type="button"
             data-bs-toggle="collapse" data-bs-target="#collapsePurchaseInfo">
      Purchase/Sold Information(optional)</button>
    </div>
    <div id="collapsePurchaseInfo" class="accordion-collapse collapse"
         data-bs-parent="#vehicleModalAccordion">
     <label for="inputPurchaseDate">Purchased Date(optional)</label>
     <div class="input-group">
      <input type="text" id="inputPurchaseDate" class="form-control" value="2020-01-30">
     </div>
     <label for="inputPurchasePrice">Purchased Price(optional)</label>
     <input type="text" inputmode="decimal" id="inputPurchasePrice"
            class="form-control" value="20000">
    </div>
   </div>
  </div>
 </div></div>
</div></div>

<script>
  /* Upstream's harvester, verbatim from shared.js getAndValidateExtraFields()
     -- the label text is the storage key and it reads ONE input per
     .extra-field. Exposed so a check can assert what would actually be saved
     rather than what the DOM looks like. */
  /* Defined by an inline <script> inside upstream's _VehicleModal partial
     (line 162-164). It is the only thing in the modal that names the vehicle,
     and repopulating the purchase fields depends on it. */
  window.getVehicleModelData = function () { return { id: 1 }; };

  window.__rtHarvest = function () {
      return $(".modal.fade.show").find(".extra-field").map((i, el) => ({
          name: $(el).children("label").text(),
          value: $(el).find("input").val(),
      })).get();
  };
</script>
<script>
  /* And upstream's call site: vehicle.js fires this from a jQuery ready
     handler, which is AFTER roadtrack-ui.js has swapped the global in its own
     DOMContentLoaded listener. Reproducing that ordering is the point — it is
     the whole reason the replacement is safe. */
  $(function () { window.getVehicleReport(GetVehicleId()); });

  /* UPSTREAM'S TAB BINDING, from wwwroot/js/vehicle.js lines 5 and 46-47, kept
     verbatim because its exact text is the hazard.

     It binds `button[data-bs-toggle="tab"]` — EVERY tab button on the page,
     including the ones roadtrack-ui.js injects, because those are added on
     DOMContentLoaded and this runs later on jQuery ready. It then interpolates
     `e.target.id` straight into a selector. A button with no id makes that
     `.lubelogger-tab #`, jQuery throws "unrecognized expression", and the
     exception unwinds through Bootstrap's dispatch of `show.bs.tab` so the pane
     is never activated and `shown.bs.tab` never fires.

     Absent from this fixture at first, and its absence is why the
     Collaborators, Reports and Finance tabs all shipped DEAD while every check
     in tools/check_vehicle_tabs.py passed. Do not "simplify" this away: the
     bug it reproduces is invisible without it. */
  $(function () {
      $('button[data-bs-toggle="tab"]').on('show.bs.tab', function (e) {
          $(`.lubelogger-tab #${e.target.id}`).addClass('active');
          $(`.lubelogger-mobile-nav #${e.target.id}`).addClass('active');
      });
  });
  function GetVehicleId() {
      return new URLSearchParams(location.search).get('vehicleId');
  }
</script>
</body></html>
"""

COLLAB_PARTIAL = """
<div class="row"><div class="col-md-2 flex-grow-1 col-12 chartContainer border rounded" id="collaboratorContent">
 <div class="d-flex justify-content-between align-items-center">
  <span class="lead text-truncate">Collaborators</span>
  <button onclick="addCollaborator()" class="btn btn-primary btn-sm">
   <i class="bi bi-person-add"></i></button>
 </div><hr />
 <div class="d-flex flex-column gap-2">
  <div class="d-flex justify-content-between align-items-center report-collaborator border rounded">
   <span class="text-truncate">alex</span>
   <button onclick="deleteCollaborator(3, 1)" class="btn btn-danger btn-sm">
    <i class="bi bi-trash"></i></button>
  </div>
 </div>
 <script>function addCollaborator(){ alert('add'); }</script>
</div></div>
"""

# Upstream's login page. With OpenIDConfig__DisableRegularLogin set, an
# instance never renders this — LoginController.Index 302s straight into the
# OIDC flow server-side. Kept so the branding rewrites can still be checked
# against the real markup, and for every instance that signs in with
# LubeLogger's own accounts.
FIXTURE_LOGIN = """<!DOCTYPE html>
<html lang="en"><head>
<meta name="apple-mobile-web-app-title" content="LubeLogger" />
<title>Login - LubeLogger</title>
<script>
  function getGlobalConfig(){ return {useDarkMode:false, useMPG:true}; }
</script>
<script src="/brand/roadtrack-ui.js"></script>
</head><body>
<!-- The real wrapper from Views/Shared/_Layout.cshtml, so the login page is
     tested against the markup upstream actually renders. -->
<div class="container lubelogger-body-container">
  <main role="main">
    <div class="border rounded shadow p-5">
      <input type="text" id="inputUserName"><input type="password" id="inputUserPassword">
      <button type="button" onclick="performLogin()">Login</button>
      <button type="button" onclick="remoteLogin()">Login via SSO</button>
    </div>
  </main>
</div>
</body></html>
"""

# DARK=1 renders every page the way upstream renders it for a user with dark
# mode on: `data-bs-theme="dark"` on <html> (_Layout.cshtml:31) and the flag
# getGlobalConfig() reports. Everything here has to be looked at in both.
DARK = bool(os.environ.get("DARK"))


def page(html):
    if DARK:
        html = (html.replace('<html lang="en">', '<html lang="en" data-bs-theme="dark">', 1)
                    .replace("useDarkMode:false", "useDarkMode:true"))
    return html.encode()


ROUTES = {
    "/api/info": lambda: {"locale": "en-US", "currentVersion": "1.7.3",
                          "currencySymbol": "$", "decimalSeparator": ".",
                          "dateFormat": "M/d/yyyy"},
    "/api/vehicles": lambda: VEHICLES,
    "/api/vehicle/servicerecords/all": lambda: DATA["service"],
    "/api/vehicle/repairrecords/all": lambda: DATA["repair"],
    "/api/vehicle/upgraderecords/all": lambda: DATA["upgrade"],
    "/api/vehicle/taxrecords/all": lambda: DATA["tax"],
    "/api/vehicle/gasrecords/all": lambda: DATA["gas"],
    # Empty unless ODOMETER=1, but SERVED either way. Absent, this 404'd into
    # vehicle-dash.js's `.catch(() => [])` — indistinguishable from a garage
    # that has no readings, which is how the odometer-only path went untested.
    "/api/vehicle/odometerrecords/all": lambda: DATA["odometer"],
}


def cached(path):
    CACHE.mkdir(parents=True, exist_ok=True)
    blob = CACHE / path.strip("/").replace("/", "_")
    if not blob.exists():
        with urllib.request.urlopen(UPSTREAM + path, timeout=30) as r:
            blob.write_bytes(r.read())
    return blob.read_bytes()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]

        if path in ROUTES:
            return self._send(json.dumps(ROUTES[path]()).encode(),
                              "application/json")

        if path in PASSTHROUGH:
            ctype = "text/css" if path.endswith(".css") else "application/javascript"
            try:
                return self._send(cached(path), ctype)
            except Exception as exc:               # noqa: BLE001 - dev tool
                # Said on the console as well: without upstream's bundles the
                # pages still load, just undrawn, which looks like a bug in
                # the code under test rather than a missing container.
                print(f"cannot fetch {UPSTREAM}{path}: {exc}", file=sys.stderr)
                return self._send(f"/* {exc} */".encode(), ctype)

        # `/fixture` is not a path the real app has, so isLandingPage() is
        # false there and it exercises the METRICS branch. Serving the same
        # markup at /Home exercises the ACCESS branch, which is the landing
        # page one — without this, half of inject() has no fixture at all.
        # "/" lands on the fixture because that IS the surface now: the
        # standalone metrics page it used to alias was deleted in an earlier
        # release, and what is left to preview is the injected navbars and the
        # vehicle dashboard the fixture hosts.
        if path in ("/", "/fixture", "/Home", "/Home/Index"):
            return self._send(page(FIXTURE), "text/html")

        # The vehicle page, at the real route so roadtrack-ui.js's own
        # isLandingPage() test decides which tabs to inject rather than the
        # harness deciding for it.
        if path in ("/Vehicle", "/Vehicle/Index"):
            return self._send(page(FIXTURE_VEHICLE), "text/html")

        # Only the one element the Collaborators tab carves out. Upstream's
        # real response is the whole dashboard; this is the shape that matters,
        # inline <script> and all, because injecting it is what defines
        # addCollaborator() for the button that calls it.
        if path == "/Vehicle/GetReportPartialView":
            return self._send(page(COLLAB_PARTIAL), "text/html")

        # Served at the real path so roadtrack-ui.js's /Login route test applies.
        if path in ("/Login", "/Login/", "/Login/Index"):
            return self._send(page(FIXTURE_LOGIN), "text/html")

        # No directory aliases. LubeLogger serves wwwroot with UseStaticFiles
        # and no UseDefaultFiles, so a bare directory 404s in production. The
        # harness mirrored the wrong behaviour once and a broken nav link
        # shipped because of it.
        local = ROOT / path.lstrip("/")
        if local.is_file() and ROOT in local.resolve().parents:
            # Images matter: the report header carries the icon, and served as
            # text/plain it renders as a broken-image box. Production gets this
            # right, so a harness that does not will quietly certify a broken
            # logo — which is exactly what happened the first time.
            ctype = {".html": "text/html", ".css": "text/css",
                     ".js": "application/javascript", ".svg": "image/svg+xml",
                     ".png": "image/png", ".ico": "image/x-icon",
                     ".json": "application/json"}.get(local.suffix, "text/plain")
            body = local.read_bytes()
            # Same substitution the Dockerfile does at build time.
            body = body.replace(b"__RT_VERSION__", VERSION.encode())
            return self._send(body, ctype)

        self._send(b"not found", "text/plain", 404)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    counts = {k: len(v) for k, v in DATA.items()}
    print(f"records: {counts}  (total {sum(counts.values())})")
    print(f"upstream bundles from {UPSTREAM}")
    print(f"→ http://127.0.0.1:{port}/")
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", port), Handler) as httpd:
        httpd.serve_forever()
