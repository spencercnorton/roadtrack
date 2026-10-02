/* Self-check for the metrics money math. Run: node tools/test_metrics.mjs
 *
 * On purpose: no framework, no fixtures — plain asserts over the cases that
 * would silently produce a wrong number on the dashboard. Everything here is
 * a real failure mode, not coverage for its own sake.
 */
import assert from 'node:assert/strict';
import {
    CATEGORIES, normalise, parseIsoDate, monthSpan, monthlyByCategory, cumulativeByMonth,
    byCategory, total, distanceCovered, costPerDistance, trend,
    cumulativeCostPerDistance, activeCategories, ownershipSpan, topExpenses,
    yearlyByCategory, systemOf, systemsMentioned, bySystem, usageByMonth, usageByYear,
    MAX_USAGE_MONTHS, latestOdometer,
    readingSpan,
    normaliseReadings, monthlyTotals, trailingMonthlyTotals,
    odometerSeries, odometerAt, anchorOf, anchored,
    anchorReading, unownedLeadMonths, extraField, PURCHASE_ODOMETER_FIELD,
    flatSeries, coverage, estimatedDistance, MIN_ESTIMATE_LIFT,
    typedNumber, amortise, loanOf, paidByMonth, paidAt, valuationsOf, valueAt,
    valueByMonth, round2, CPD_WARMUP, LOAN_FIELDS, VALUATION_FIELD,
    depreciationCurve, RESIDUAL_FLOOR, FLEET_RETENTION_5Y,
} from '../brand/metrics/aggregate.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

check('parseIsoDate keeps the calendar day in a negative-offset timezone', () => {
    // `new Date('2026-03-01')` is UTC midnight — in US timezones that is
    // Feb 28 locally, which would file the record under the wrong month.
    const d = parseIsoDate('2026-03-01');
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 2);
    assert.equal(d.getDate(), 1);
});

check('parseIsoDate rejects junk instead of returning Invalid Date', () => {
    assert.equal(parseIsoDate('not a date'), null);
    assert.equal(parseIsoDate(''), null);
    assert.equal(parseIsoDate(undefined), null);
});

check('parseIsoDate rejects impossible dates instead of rolling them forward', () => {
    // new Date(2026, 1, 31) silently becomes 3 March — that would file the
    // record under the wrong month rather than skipping it.
    assert.equal(parseIsoDate('2026-02-31'), null);
    assert.equal(parseIsoDate('2026-13-01'), null);
    assert.equal(parseIsoDate('2026-04-31'), null);
    // ...but a real leap day still parses.
    assert.equal(parseIsoDate('2024-02-29').getMonth(), 1);
    assert.equal(parseIsoDate('2026-02-29'), null);   // 2026 is not a leap year
});

check('parseIsoDate rejects trailing content after the date', () => {
    assert.equal(parseIsoDate('2026-03-01T00:00:00Z'), null);
    assert.equal(parseIsoDate('2026-03-01 junk'), null);
});

check('normalise drops unparseable rows and counts them', () => {
    const { records, skipped } = normalise('Service', [
        { cost: 100, date: '2026-01-05', vehicleId: '1', odometer: '1000' },
        { cost: 'abc', date: '2026-01-06', vehicleId: '1' },
        { cost: 50, date: 'garbage', vehicleId: '1' },
    ]);
    assert.equal(records.length, 1);
    assert.equal(skipped, 2);
    assert.equal(records[0].cost, 100);
    assert.equal(records[0].vehicleId, 1);
});

check('normalise accepts cost as a JSON number and as a numeric string', () => {
    const { records } = normalise('Service', [
        { cost: 12.34, date: '2026-01-05', vehicleId: '1' },
        { cost: '56.78', date: '2026-01-06', vehicleId: '1' },
    ]);
    assert.deepEqual(records.map((r) => r.cost), [12.34, 56.78]);
});

check('monthSpan fills gap months so an idle month reads as zero', () => {
    const recs = [
        { date: parseIsoDate('2026-01-10'), cost: 1, category: 'Fuel', vehicleId: 1, odometer: null },
        { date: parseIsoDate('2026-04-02'), cost: 1, category: 'Fuel', vehicleId: 1, odometer: null },
    ];
    assert.deepEqual(monthSpan(recs), ['2026-01', '2026-02', '2026-03', '2026-04']);
});

check('monthSpan trims leading/trailing zero-cost months but keeps interior gaps', () => {
    // A second-hand car's shape: odometer-only records years before any
    // spend dragged the axis back and spent most of the plot on a flat zero.
    const recs = normalise('Service', [
        { cost: 0,   date: '2012-03-01', vehicleId: '1', odometer: '9000' },
        { cost: 0,   date: '2020-09-01', vehicleId: '1', odometer: '45000' },
        { cost: 150, date: '2021-05-01', vehicleId: '1' },
        { cost: 900, date: '2021-07-01', vehicleId: '1' },   // June is a real gap
        { cost: 0,   date: '2026-08-01', vehicleId: '1', odometer: '100000' },
    ]).records;
    // Starts at the first month with spend, ends at the last, June kept at zero.
    assert.deepEqual(monthSpan(recs), ['2021-05', '2021-06', '2021-07']);
    const { series } = monthlyByCategory(recs);
    assert.deepEqual(series.Service, [150, 0, 900]);
    // The trimmed records carry no cost, so the total is untouched.
    assert.equal(cumulativeByMonth(recs).values.at(-1), total(recs));
});

check('monthSpan falls back to the full span when nothing carries spend', () => {
    const recs = normalise('Service', [
        { cost: 0, date: '2026-01-01', vehicleId: '1' },
        { cost: 0, date: '2026-03-01', vehicleId: '1' },
    ]).records;
    assert.deepEqual(monthSpan(recs), ['2026-01', '2026-02', '2026-03']);
});

check('monthSpan spans a year boundary', () => {
    const recs = [
        { date: parseIsoDate('2025-11-10'), cost: 1, category: 'Fuel', vehicleId: 1, odometer: null },
        { date: parseIsoDate('2026-02-02'), cost: 1, category: 'Fuel', vehicleId: 1, odometer: null },
    ];
    assert.deepEqual(monthSpan(recs), ['2025-11', '2025-12', '2026-01', '2026-02']);
});

const sample = [
    ...normalise('Fuel', [
        { cost: 50, date: '2026-01-10', vehicleId: '1', odometer: '1000', fuelEconomy: '30', isFillToFull: 'True', missedFuelUp: 'False' },
        { cost: 60, date: '2026-02-10', vehicleId: '1', odometer: '1500', fuelEconomy: '32', isFillToFull: 'True', missedFuelUp: 'False' },
    ]).records,
    ...normalise('Service', [
        { cost: 200, date: '2026-01-20', vehicleId: '1', odometer: '1200' },
    ]).records,
    ...normalise('Repairs', [
        { cost: 400, date: '2026-02-05', vehicleId: '2', odometer: '9000' },
    ]).records,
];

check('monthlyByCategory buckets by month and category', () => {
    const { labels, series } = monthlyByCategory(sample);
    assert.deepEqual(labels, ['2026-01', '2026-02']);
    assert.deepEqual(series.Fuel, [50, 60]);
    assert.deepEqual(series.Service, [200, 0]);
    assert.deepEqual(series.Repairs, [0, 400]);
    assert.deepEqual(series.Taxes, [0, 0]);
});

check('cumulativeByMonth is monotonic and ends at the grand total', () => {
    const { values } = cumulativeByMonth(sample);
    assert.deepEqual(values, [250, 710]);
    assert.equal(values[values.length - 1], total(sample));
});

check('byCategory returns every category, including empty ones', () => {
    const rows = byCategory(sample);
    assert.equal(rows.length, 5);
    assert.equal(rows.find((r) => r.category === 'Repairs').total, 400);
    assert.equal(rows.find((r) => r.category === 'Upgrades').total, 0);
});

check('distanceCovered sums per-vehicle spans, not a fleet-wide max-min', () => {
    // Vehicle 1 covers 1000→1500 (500). Vehicle 2 has one reading, so spans 0.
    // A naive fleet-wide (max-min) would return 9000-1000 = 8000 — nonsense.
    assert.equal(distanceCovered(sample), 500);
});

check('costPerDistance divides total spend by real distance', () => {
    assert.equal(costPerDistance(sample), 710 / 500);
});

check('costPerDistance returns null rather than dividing by zero', () => {
    const noOdo = normalise('Service', [
        { cost: 100, date: '2026-01-05', vehicleId: '1' },
    ]).records;
    assert.equal(distanceCovered(noOdo), null);
    assert.equal(costPerDistance(noOdo), null);
});

check('trend compares trailing windows and reports null with no prior data', () => {
    const now = parseIsoDate('2026-03-31');
    const recs = normalise('Service', [
        { cost: 100, date: '2026-03-15', vehicleId: '1' },  // current 30d
        { cost: 50,  date: '2026-02-15', vehicleId: '1' },  // prior 30d
    ]).records;
    const t = trend(recs, 30, now);
    assert.equal(t.current, 100);
    assert.equal(t.prior, 50);
    assert.equal(Math.round(t.changePct), 100);

    const onlyNew = normalise('Service', [
        { cost: 100, date: '2026-03-15', vehicleId: '1' },
    ]).records;
    assert.equal(trend(onlyNew, 30, now).changePct, null);
});

check('cumulativeCostPerDistance divides everything so far by every mile so far', () => {
    const recs = normalise('Fuel', [
        { cost: 100, date: '2026-01-10', vehicleId: '1', odometer: '1000' },
        { cost: 100, date: '2026-02-10', vehicleId: '1', odometer: '5000' },
    ]).records;
    const { labels, values, opening } = cumulativeCostPerDistance(recs);
    // January holds one reading → no span to divide by → it is left off the
    // front entirely rather than plotted as a null or a fake 0, and counted so
    // the card can say a month is missing.
    assert.deepEqual(labels, ['2026-02']);
    assert.equal(opening, 1);
    // February: 200 spent across 4000 miles of readings.
    assert.equal(values[0], 0.05);
});

check('cumulativeCostPerDistance never gaps once it has started', () => {
    // THE BUG THIS REPLACED. The 12-month rolling version nulled any window
    // whose odometer barely moved, so a car that sat still for a while put
    // holes in the middle of the line — and a line with holes reads as broken
    // data rather than as a measurement declining to be made.
    const parked = normalise('Repairs', [
        { cost: 5000, date: '2026-01-10', vehicleId: '1', odometer: '90000' },
        { cost: 100,  date: '2026-02-10', vehicleId: '1', odometer: '90050' },
        { cost: 100,  date: '2026-03-10', vehicleId: '1', odometer: '90100' },
    ]).records;
    const { values } = cumulativeCostPerDistance(parked);
    assert.equal(values.slice(1).every((v) => v !== null), true);
});

check('the line keeps going after the last receipt, on odometer readings alone', () => {
    // Found the hard way. monthSpan() ends at the last month with SPEND, which
    // is right for a money chart and fatal here: the recovery after a big bill
    // happens entirely in months that have readings and no receipts, so the
    // default span cut the line off at the step up and showed only the bad
    // half. Passing endAtLastRecord is what makes the chart mean anything.
    const recs = normalise('Repairs', [
        { cost: 4000, date: '2026-01-10', vehicleId: '1', odometer: '10000' },
        { cost: 0,    date: '2026-02-10', vehicleId: '1', odometer: '14000' },
        { cost: 0,    date: '2026-03-10', vehicleId: '1', odometer: '18000' },
    ]).records;
    const { labels, values, opening } = cumulativeCostPerDistance(recs);
    // January is off the front: there is only one reading by the end of it, so
    // there is no distance to divide by yet. The span still REACHES March,
    // which is the thing this test was written to protect.
    assert.deepEqual(labels, ['2026-02', '2026-03']);
    assert.equal(opening, 1);
    assert.equal(values[0], 1);              // 4000 over 4000 miles
    assert.equal(values[1], 0.5);            // 4000 over 8000 — the trend down
});

check('a big repair steps the line up, then driving walks it back down', () => {
    // The whole reason for the change: the shape should answer "is this
    // car getting more expensive to run, or cheaper".
    //
    // ALSO the reason the opening trim thresholds the DENOMINATOR and not the
    // value. This step is 10x where the line settles, two months into the
    // history — any "drop months more than N times the settled figure" rule
    // deletes exactly the thing the chart is for.
    const recs = normalise('Repairs', [
        { cost: 100,  date: '2026-01-10', vehicleId: '1', odometer: '10000' },
        { cost: 4000, date: '2026-02-10', vehicleId: '1', odometer: '12000' },
        { cost: 0,    date: '2026-03-10', vehicleId: '1', odometer: '20000' },
        { cost: 0,    date: '2026-04-10', vehicleId: '1', odometer: '30000' },
    ]).records;
    const { values } = cumulativeCostPerDistance(recs);
    // January is off the front — one reading, nothing to divide by — so the
    // series starts at February.
    const [feb, mar, apr] = values;
    assert.equal(feb, 2.05);                 // 4100 over 2000 miles
    assert.equal(mar < feb, true);           // same money, 10000 more miles
    assert.equal(apr < mar, true);           // and further down again
    assert.equal(apr, 0.21);                 // 4100 over 20000
});

check('activeCategories drops categories with no spend', () => {
    // A garage that logs no fuel and no tax records should not spend a
    // legend row and a palette slot on those categories to report nothing.
    assert.deepEqual(activeCategories(sample), ['Fuel', 'Service', 'Repairs']);
    assert.deepEqual(activeCategories([]), []);
});

check('ownershipSpan counts EVERY month since the first record, not just spendy ones', () => {
    // The whole point: "cost per month" divided by months-with-spend answers
    // "when I spend, how much" while wearing the label of a running cost. Here
    // that would be $600/mo against a true $200/mo.
    const recs = normalise('Service', [
        { cost: 600, date: '2026-01-15', vehicleId: '1' },
        { cost: 600, date: '2026-06-15', vehicleId: '1' },   // 4 quiet months between
    ]).records;
    const now = new Date(2026, 5, 20);                       // 20 Jun 2026
    const { months, from } = ownershipSpan(recs, now);
    assert.equal(months, 6);                                 // Jan..Jun inclusive
    assert.equal(from.getFullYear(), 2026);
    assert.equal(from.getMonth(), 0);
    assert.equal(total(recs) / months, 200);                 // not 1200/2 = 600
});

check('ownershipSpan counts a zero-cost record as ownership', () => {
    // A warranty job or an odometer entry is still the car being on the books.
    const recs = normalise('Service', [
        { cost: 0, date: '2025-01-10', vehicleId: '1' },
        { cost: 500, date: '2026-01-10', vehicleId: '1' },
    ]).records;
    assert.equal(ownershipSpan(recs, new Date(2026, 0, 31)).months, 13);
});

check('a range filter clips the span but cannot move ownership later', () => {
    // Selecting 12M used to restart "ownership" at the first receipt inside
    // that window: one recent invoice on a 5-year-old car divided a year of
    // spend by one month. The range scopes the numerator, so it has to scope
    // the denominator — but only as a floor, never by re-deriving the start.
    const recs = normalise('Service', [
        { cost: 500, date: '2021-02-10', vehicleId: '1' },
        { cost: 700, date: '2026-06-10', vehicleId: '1' },   // the only recent one
    ]).records;
    const now = new Date(2026, 7, 15);                        // Aug 2026
    // What slice()/since() computes for 12M: (month 7) - 12 + 1 -> Sep 2025.
    const rangeStart = new Date(2026, 7 - 12 + 1, 1);

    // Unclipped: the real ownership span.
    assert.equal(ownershipSpan(recs, now).months, 67);
    // Clipped to the last 12 months — twelve, not "one month since June".
    const clipped = ownershipSpan(recs, now, rangeStart);
    assert.equal(clipped.months, 12);
    assert.equal(clipped.from.getTime(), rangeStart.getTime());
    // A cutoff older than the first record must not back-date ownership.
    const older = new Date(2015, 0, 1);
    assert.equal(ownershipSpan(recs, now, older).from.getFullYear(), 2021);
});

check('odometer-only history counts as ownership evidence', () => {
    // ownershipSpan's contract is "earliest item on record". An odometer entry
    // predating the first receipt is exactly that, and leaving it out started
    // ownership late and inflated the figure.
    const spend = normalise('Service', [
        { cost: 600, date: '2026-01-10', vehicleId: '1' },
    ]).records;
    const readings = normaliseReadings([
        { date: '2025-01-10', odometer: 1000, vehicleId: '1' },
    ]).records;
    const now = new Date(2026, 0, 31);
    assert.equal(ownershipSpan(spend, now).months, 1);
    assert.equal(ownershipSpan(spend.concat(readings), now).months, 13);
    // ...and the money is unchanged, so the rate falls rather than the total.
    assert.equal(total(spend.concat(readings)), total(spend));
});

check('ownershipSpan never divides by zero or a negative span', () => {
    assert.deepEqual(ownershipSpan([]), { months: 0, from: null });
    // A record dated in the future counts as its own month rather than
    // producing a negative denominator.
    const future = normalise('Service', [
        { cost: 100, date: '2027-01-10', vehicleId: '1' },
    ]).records;
    assert.equal(ownershipSpan(future, new Date(2026, 0, 15)).months, 1);
});

check('topExpenses ranks by cost and respects the limit', () => {
    const top = topExpenses(sample, 2);
    assert.deepEqual(top.map((t) => t.cost), [400, 200]);
    assert.equal(top[0].category, 'Repairs');
    assert.equal(topExpenses(sample, 99).length, sample.length);
    assert.deepEqual(topExpenses([], 5), []);
});

check('topExpenses falls back to the category when a description is blank', () => {
    const recs = normalise('Repairs', [
        { cost: 500, date: '2026-01-05', vehicleId: '1', description: '' },
    ]).records;
    assert.equal(topExpenses(recs)[0].description, 'Repairs');
});

check('empty input never throws', () => {
    assert.deepEqual(monthSpan([]), []);
    assert.deepEqual(monthlyByCategory([]).labels, []);
    assert.deepEqual(cumulativeByMonth([]).values, []);
    assert.equal(total([]), 0);
    assert.equal(distanceCovered([]), null);
    assert.equal(costPerDistance([]), null);
});

/* ── Per-vehicle dashboard ─────────────────────────────────────────────
 *
 * Everything below backs brand/metrics/vehicle-dash.js, which replaces
 * upstream's Dashboard tab. The cases are the ones that would put a
 * confidently wrong number in front of someone about to authorise a repair.
 */

check('yearlyByCategory keeps years apart instead of summing month-of-year', () => {
    // The bug this replaces: upstream buckets by calendar month, so a July
    // 2022 tyre bill and a July 2026 tyre bill become one enormous July.
    const recs = normalise('Service', [
        { cost: 100, date: '2022-07-04', vehicleId: '1' },
        { cost: 200, date: '2026-07-04', vehicleId: '1' },
    ]).records;
    const { labels, series } = yearlyByCategory(recs);
    assert.deepEqual(labels, ['2022', '2023', '2024', '2025', '2026']);
    assert.deepEqual(series.Service, [100, 0, 0, 0, 200]);
});

check('yearlyByCategory survives an empty set', () => {
    assert.deepEqual(yearlyByCategory([]), { labels: [], series: {} });
});

check('systemOf takes the FIRST system named, not a fixed priority', () => {
    // Both of these mention oil AND cooling. Which one they are is decided by
    // which the invoice leads with — a fixed priority order gets one wrong
    // whichever way it is ordered.
    const oilFirst = { description: 'Oil service, coolant flush', notes: '' };
    const coolFirst = { description: 'Coolant hose and expansion tank cap; oil service', notes: '' };
    assert.equal(systemOf(oilFirst), 'Oil & filters');
    assert.equal(systemOf(coolFirst), 'Cooling');
});

check('systemOf prefers the longer match when two start at the same place', () => {
    // "wheel hub" is suspension work; a bare "wheel" would file it as tyres.
    assert.equal(
        systemOf({ description: 'Rear wheel hubs replacement (both sides)', notes: '' }),
        'Suspension');
    assert.equal(
        systemOf({ description: 'Wheels refinished (all four)', notes: '' }),
        'Tyres & wheels');
});

check('systemOf reads typical invoice lines correctly', () => {
    const cases = [
        ['Water pump and thermostat replaced, coolant flush', 'Cooling'],
        ['Radiator coolant hose (genuine part)', 'Cooling'],
        ['Heater hose replaced + intake manifold gasket', 'Cooling'],
        ['Oil pan gasket resealed', 'Oil & filters'],
        ['Four tyres - all-season touring 225/55R17', 'Tyres & wheels'],
        ['Front brake pads, rotors and wear sensor + brake fluid flush', 'Brakes'],
        ['Sport suspension conversion (parts not itemized)', 'Suspension'],
        ['CVT transmission fluid change', 'Drivetrain'],
        ['Walnut blast of the intake valves (carbon cleaning)', 'Engine'],
        ['Xenon headlight assembly, right side', 'Electrical'],
        ['A/C system evacuate and recharge', 'Climate'],
        ['Windshield replaced after a stone chip', 'Body & glass'],
        ['Audio upgrade - aftermarket amplifier', 'Interior & tech'],
        ['High pressure fuel pump replaced', 'Fuel system'],
        ['Annual vehicle service check', 'Inspection & admin'],
    ];
    for (const [description, expected] of cases) {
        assert.equal(systemOf({ description, notes: '' }), expected, description);
    }
});

check('systemOf returns null rather than guessing when nothing matches', () => {
    assert.equal(systemOf({ description: 'OBD-II port cap', notes: '' }), null);
    assert.equal(systemOf({ description: '', notes: '' }), null);
});

check('the SYSTEMS regexes are not left mid-scan between calls', () => {
    // Every pattern carries /g, so a stale lastIndex would make the SAME input
    // classify differently on the second call. Silent, and only on some rows.
    const r = { description: 'Coolant flush', notes: '' };
    assert.equal(systemOf(r), 'Cooling');
    assert.equal(systemOf(r), 'Cooling');
    assert.equal(systemsMentioned(r), 1);
    assert.equal(systemsMentioned(r), 1);
});

check('bySystem totals to the whole and files no-match rows under Other', () => {
    const recs = normalise('Repairs', [
        { cost: 1000, date: '2026-01-05', vehicleId: '1', description: 'Water pump' },
        { cost: 500, date: '2026-01-06', vehicleId: '1', description: 'Coolant hose' },
        { cost: 250, date: '2026-01-07', vehicleId: '1', description: 'OBD-II port cap' },
        { cost: 0, date: '2026-01-08', vehicleId: '1', description: 'Warranty coolant work' },
    ]).records;
    const { rows } = bySystem(recs);
    assert.deepEqual(rows, [
        { system: 'Cooling', total: 1500, count: 2 },
        { system: 'Other', total: 250, count: 1 },
    ]);
    // Zero-cost rows carry no money, so they must not inflate a count either.
    assert.equal(rows.reduce((a, r) => a + r.total, 0), total(recs));
});

check('bySystem counts how many records straddle more than one system', () => {
    const recs = normalise('Service', [
        { cost: 100, date: '2026-01-05', vehicleId: '1', description: 'Oil service' },
        { cost: 900, date: '2026-01-06', vehicleId: '1', description: 'Oil service, spark plugs, tyre rotation' },
    ]).records;
    const { mixed } = bySystem(recs);
    assert.equal(mixed, 1);
});

check('usageByMonth spreads a reading gap across the months it spans', () => {
    // 3,100 miles between 1 Jan and 1 Apr — 90 days, so each month gets its
    // own days' share rather than April getting the lot.
    const recs = normalise('Service', [
        { cost: 10, date: '2026-01-01', vehicleId: '1', odometer: 1000 },
        { cost: 10, date: '2026-04-01', vehicleId: '1', odometer: 4100 },
    ]).records;
    const { labels, values } = usageByMonth(recs);
    assert.deepEqual(labels, ['2026-01', '2026-02', '2026-03', '2026-04']);
    const perDay = 3100 / 90;
    assert.equal(values[0], Math.round(perDay * 31 * 100) / 100);   // January
    assert.equal(values[1], Math.round(perDay * 28 * 100) / 100);   // February
    assert.equal(values[2], Math.round(perDay * 31 * 100) / 100);   // March
    // April is covered for zero of its 30 days — the interval ends on the 1st.
    assert.equal(values[3], null);
    const sum = values.filter((v) => v !== null).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 3100) < 1, `spread lost distance: ${sum}`);
});

check('usageByMonth reports only months the readings cover end to end', () => {
    // The first and last month of any history are partial by construction: the
    // earliest reading lands mid-month. Crediting them with the days that
    // happen to follow draws a cliff at both ends of the line and reads as a
    // car that barely moved the month you are looking at it.
    const recs = normalise('Service', [
        { cost: 10, date: '2026-01-20', vehicleId: '1', odometer: 1000 },
        { cost: 10, date: '2026-03-10', vehicleId: '1', odometer: 3000 },
    ]).records;
    const { labels, values } = usageByMonth(recs);
    assert.deepEqual(labels, ['2026-01', '2026-02', '2026-03']);
    assert.equal(values[0], null);            // covered from the 20th only
    assert.ok(values[1] > 0);                 // February is covered in full
    assert.equal(values[2], null);            // covered to the 10th only
});

check('usageByMonth reports an unmeasurable month as null, never as zero', () => {
    // "we don't know" and "the car did not move" are different claims. Only
    // one of them is supportable, and a 0 on the chart asserts the other.
    const recs = normalise('Service', [
        { cost: 10, date: '2026-01-01', vehicleId: '1', odometer: 1000 },
        { cost: 10, date: '2026-02-01', vehicleId: '1', odometer: 1500 },
        { cost: 10, date: '2026-03-01', vehicleId: '1', odometer: 1500 },  // no travel
        { cost: 10, date: '2026-05-01', vehicleId: '1', odometer: 3000 },
    ]).records;
    const { labels, values } = usageByMonth(recs);
    assert.deepEqual(labels, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);
    assert.equal(values[0], 500);        // January, covered end to end
    assert.equal(values[1], 0);          // February IS measured, and it is zero
    assert.ok(values[2] > 0);            // March, part of the Mar->May run
    assert.equal(values[4], null);       // May is covered to the 1st only
});

check('usageByYear sums the measurable months and flags the partial years', () => {
    // A year summed from ten covered months reads as a quiet year rather than
    // an incompletely recorded one, so the flag is what makes the bar honest.
    const recs = normaliseReadings([
        { date: '2025-02-10', odometer: 1000, vehicleId: '1' },
        { date: '2025-06-10', odometer: 5000, vehicleId: '1' },
        { date: '2026-03-10', odometer: 14000, vehicleId: '1' },
        { date: '2026-11-20', odometer: 23000, vehicleId: '1' },
    ]).records;                                   // 22,000 miles of real travel
    const { labels, values, partial } = usageByYear(recs);
    assert.deepEqual(labels, ['2025', '2026']);
    // Both ends of the history land mid-month, so the first and last month of
    // each year are covered from/to the reading day only and are not summed.
    assert.deepEqual(partial, [true, true]);
    assert.ok(values[0] > 0 && values[1] > 0);
    // Each year is the sum of its OWN measured months, so dropping the partial
    // ones puts the pair strictly under the distance actually travelled —
    // which is why `partial` has to be shown rather than inferred from a total.
    assert.ok(values[0] + values[1] < 22000);
});

check('usageByYear reports a year with no measurable month as null, not zero', () => {
    const recs = normaliseReadings([
        { date: '2025-06-10', odometer: 1000, vehicleId: '1' },
        { date: '2025-07-20', odometer: 1400, vehicleId: '1' },
    ]).records;
    // Neither month is covered end to end, so there is nothing to sum.
    assert.deepEqual(usageByYear(recs).values, [null]);
});

check('MAX_USAGE_MONTHS is the month/year switch the dashboard reads', () => {
    // Pinned because vehicle-dash.js branches on it: a history longer than
    // this is drawn as yearly bars, and a car with five or six years of
    // readings is on the yearly side of it.
    assert.equal(MAX_USAGE_MONTHS, 36);
});

check('usageByMonth spans the READINGS, not the spend records', () => {
    // A vehicle tracked through the Odometer tab with one paid record in the
    // middle used to get its span from monthSpan(), which prefers records
    // carrying spend — a one-month span, no fully covered month inside it, and
    // a chart that hid itself while the KPI beside it reported real mileage.
    const spend = normalise('Service', [
        { cost: 250, date: '2026-04-10', vehicleId: '1' },
    ]).records;
    const readings = normaliseReadings([
        { date: '2026-01-01', odometer: 1000, vehicleId: '1' },
        { date: '2026-07-01', odometer: 7000, vehicleId: '1' },
    ]).records;

    assert.deepEqual(monthlyByCategory(spend).labels, ['2026-04']);
    const { labels, values } = usageByMonth(spend.concat(readings));
    assert.deepEqual(labels,
        ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
    // Every month between the two readings is covered end to end but the last.
    assert.ok(values.slice(0, 6).every((v) => v > 0));
    assert.equal(values[6], null);
});

check('readingSpan ignores records that carry no odometer', () => {
    const recs = normalise('Service', [
        { cost: 10, date: '2026-01-01', vehicleId: '1', odometer: 1000 },
        { cost: 10, date: '2026-09-01', vehicleId: '1' },     // no odometer
    ]).records;
    assert.deepEqual(readingSpan(recs), ['2026-01']);
    assert.deepEqual(readingSpan([]), []);
});

check('a parked month is measured as zero, not drawn as a gap', () => {
    // Two readings on different days with the same mileage is a measurement,
    // and what it measures is a car that did not move. Skipping it alongside
    // genuine rollbacks would draw a hole over a month we know the answer for.
    const recs = normalise('Service', [
        { cost: 10, date: '2026-01-01', vehicleId: '1', odometer: 1500 },
        { cost: 10, date: '2026-02-01', vehicleId: '1', odometer: 1500 },
    ]).records;
    assert.deepEqual(usageByMonth(recs).values, [0, null]);
});

check('usageByMonth ignores odometer rollbacks and same-day pairs', () => {
    // Batch-entered invoice lines repeat a date, sometimes with a lower
    // reading. Counting those as travel invents miles; dividing by a zero-day
    // span produces Infinity.
    const recs = normalise('Service', [
        { cost: 10, date: '2026-01-01', vehicleId: '1', odometer: 5000 },
        { cost: 10, date: '2026-01-01', vehicleId: '1', odometer: 4000 },
        { cost: 10, date: '2026-02-01', vehicleId: '1', odometer: 4500 },
    ]).records;
    const { values } = usageByMonth(recs);
    // Highest reading wins per day, so the series is 5000 then 4500 — a
    // rollback, which contributes nothing rather than -500 or +500.
    assert.ok(values.every((v) => v === null || Number.isFinite(v)));
    assert.ok(values.every((v) => v === null || v >= 0));
});

check('usageByMonth never mixes two vehicles into one delta', () => {
    // Fleet-wide, the "gap" between one car at 140k and another at 60k is a
    // meaningless number that happens to look plausible.
    const recs = normalise('Service', [
        { cost: 10, date: '2026-01-01', vehicleId: '1', odometer: 140000 },
        { cost: 10, date: '2026-02-01', vehicleId: '2', odometer: 60000 },
        { cost: 10, date: '2026-03-01', vehicleId: '1', odometer: 141000 },
    ]).records;
    const sum = usageByMonth(recs).values
        .filter((v) => v !== null).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1000) < 1, `expected ~1000 miles, got ${sum}`);
});

check('latestOdometer takes the most recently DATED reading, not the highest', () => {
    // The tile says "Odometer now". The highest reading is only the current one
    // until something corrects it — a mis-keyed digit fixed later, an
    // instrument swap. usageByMonth() already treats a negative delta as a
    // correction, so this is a case the file expects.
    const recs = normalise('Service', [
        { cost: 10, date: '2026-03-01', vehicleId: '1', odometer: 130000 },
        { cost: 10, date: '2026-01-01', vehicleId: '1', odometer: 120000 },
        { cost: 10, date: '2026-04-01', vehicleId: '1' },        // no reading
    ]).records;
    assert.equal(latestOdometer(recs), 130000);

    const corrected = normalise('Service', [
        { cost: 10, date: '2026-03-01', vehicleId: '1', odometer: 999999 },  // typo
        { cost: 10, date: '2026-04-01', vehicleId: '1', odometer: 131000 },  // fixed
    ]).records;
    assert.equal(latestOdometer(corrected), 131000);

    // Same-day readings resolve to the lower median, so batch-entered invoice
    // lines are deterministic rather than dependent on array order. It used to
    // be the HIGHEST, which is what let a single mis-keyed 48,000 in a batch
    // reading 40,000 become eight thousand miles of travel (see below).
    const sameDay = normalise('Service', [
        { cost: 10, date: '2026-04-01', vehicleId: '1', odometer: 500 },
        { cost: 10, date: '2026-04-01', vehicleId: '1', odometer: 900 },
    ]).records;
    assert.equal(latestOdometer(sameDay), 500);
    assert.equal(latestOdometer(sameDay.slice().reverse()), 500);
    assert.equal(latestOdometer([]), null);
});

check('the sparkline window ends now, not at the last record', () => {
    // The sparkline sits inside the "Last 12 months" tile. Taking the last 12
    // entries of monthlyTotals() takes the last 12 months OF THE RECORD SPAN,
    // so a vehicle with nothing spent recently showed $0.00 on the tile beside
    // a sparkline of activity from years earlier.
    const now = new Date(2026, 7, 15);            // Aug 2026
    const recs = normalise('Service', [
        { cost: 900, date: '2022-05-10', vehicleId: '1' },   // long past
        { cost: 100, date: '2026-03-10', vehicleId: '1' },   // inside the window
    ]).records;

    const { labels, values } = trailingMonthlyTotals(recs, 12, now);
    assert.equal(labels.length, 12);
    assert.equal(labels[0], '2025-09');
    assert.equal(labels[11], '2026-08');
    assert.equal(values.reduce((a, b) => a + b, 0), 100);   // the 2022 spend is out
    assert.equal(values[labels.indexOf('2026-03')], 100);

    // A window with nothing in it is twelve zeroes, not a view of older months.
    const stale = normalise('Service', [
        { cost: 900, date: '2022-05-10', vehicleId: '1' },
    ]).records;
    assert.deepEqual(trailingMonthlyTotals(stale, 12, now).values, new Array(12).fill(0));
    // ...whereas the old approach would have shown the 2022 activity:
    assert.ok(monthlyTotals(stale).values.some((v) => v > 0));
});

check('the new aggregates never throw on an empty set', () => {
    assert.deepEqual(usageByMonth([]).values, []);
    assert.deepEqual(bySystem([]).rows, []);
    assert.equal(bySystem([]).mixed, 0);
    assert.equal(latestOdometer([]), null);
});

check('normaliseReadings keeps only usable readings and never invents cost', () => {
    const { records, skipped } = normaliseReadings([
        { date: '2026-01-05', odometer: '1000', vehicleId: '3' },
        { date: '2026-01-06', odometer: '0', vehicleId: '3' },      // no reading
        { date: 'nonsense', odometer: '1200', vehicleId: '3' },     // bad date
        { date: '2026-01-07', odometer: 'abc', vehicleId: '3' },    // bad reading
    ]);
    assert.equal(records.length, 1);
    assert.equal(skipped, 3);
    assert.equal(records[0].cost, 0);
    assert.equal(records[0].odometer, 1000);
    // Deliberately NOT one of CATEGORIES — these are not spend.
    assert.ok(!CATEGORIES.includes(records[0].category));
});

check('odometer readings move distance figures but never money', () => {
    // The point of fetching them at all: LubeLogger's Odometer tab is the one
    // place in the app built for recording distance, and every distance figure
    // ignored it. The risk of fetching them: they quietly become spend.
    const spend = normalise('Service', [
        { cost: 500, date: '2026-01-15', vehicleId: '3', odometer: 1000 },
        { cost: 700, date: '2026-04-15', vehicleId: '3', odometer: 2000 },
    ]).records;
    const readings = normaliseReadings([
        { date: '2026-02-01', odometer: 1400, vehicleId: '3' },
        { date: '2026-07-01', odometer: 5000, vehicleId: '3' },
    ]).records;
    const both = spend.concat(readings);

    // Distance grows: the July reading extends the span well past the records.
    assert.equal(distanceCovered(spend), 1000);
    assert.equal(distanceCovered(both), 4000);
    assert.equal(latestOdometer(spend), 2000);
    assert.equal(latestOdometer(both), 5000);

    // Money does not move, at all, anywhere.
    assert.equal(total(both), total(spend));
    assert.deepEqual(activeCategories(both), activeCategories(spend));
    assert.deepEqual(byCategory(both), byCategory(spend));
    assert.deepEqual(monthlyTotals(both).values, monthlyTotals(spend).values);
    assert.deepEqual(cumulativeByMonth(both).values, cumulativeByMonth(spend).values);
    // ...and cost per distance falls, because the denominator grew.
    assert.ok(costPerDistance(both) < costPerDistance(spend));
});

check('a stray non-spend category is ignored, not thrown on', () => {
    // monthlyByCategory indexes series[r.category]; an unknown one used to be
    // an undefined array and a TypeError one line later.
    const mixed = normalise('Service', [
        { cost: 100, date: '2026-01-05', vehicleId: '3' },
    ]).records.concat(normaliseReadings([
        { date: '2026-01-06', odometer: 900, vehicleId: '3' },
    ]).records);
    assert.doesNotThrow(() => monthlyByCategory(mixed));
    assert.deepEqual(monthlyByCategory(mixed).series.Service, [100]);
});

check('usage labels really can differ from spend labels', () => {
    // Why the figures table looks distance up BY MONTH rather than by array
    // index. monthSpan() bases itself on records carrying spend, so normally
    // the two spans coincide and an index lookup happens to work. When every
    // spend record is zero-cost — an all-warranty history — the fallback kicks
    // in, the readings widen the span, and index alignment silently shifts
    // every distance into a neighbouring month.
    const spend = normalise('Service', [
        { cost: 0, date: '2026-06-10', vehicleId: '3', odometer: 5000 },
    ]).records;
    const readings = normaliseReadings([
        { date: '2026-01-10', odometer: 1000, vehicleId: '3' },
        { date: '2026-08-10', odometer: 9000, vehicleId: '3' },
    ]).records;

    const spendLabels = monthlyByCategory(spend).labels;
    const usageLabels = usageByMonth(spend.concat(readings)).labels;
    assert.deepEqual(spendLabels, ['2026-06']);
    assert.notDeepEqual(usageLabels, spendLabels);
    assert.equal(usageLabels[0], '2026-01');

    // Index 0 of the usage series is January; the table's row 0 is June. A
    // lookup keyed by label gets June's value or nothing — never January's.
    const byLabel = new Map(usageLabels.map((l, i) =>
        [l, usageByMonth(spend.concat(readings)).values[i]]));
    assert.ok(byLabel.has('2026-06'));
    assert.notEqual(byLabel.get('2026-06'), usageByMonth(spend.concat(readings)).values[0]);
});

/* ── Odometer cleanup and the purchase anchor ───────────────────────── */

check('one wild same-day reading does not become eight thousand miles', () => {
    // A batch-entered invoice: four records dated 2022-03-01 reading
    // 40,000 / 40,000 / 41,000 / 48,000, then 40,100 the next day. Taking the
    // highest per day made the 48,000 the reading for that day, invented a
    // jump of nearly 8,000 miles into it, and then discarded the drop out of
    // it as a "correction" — so the same miles were counted once and never
    // given back.
    const recs = normalise('Service', [
        { cost: 0, date: '2022-02-01', vehicleId: '1', odometer: 40100 },
        { cost: 100, date: '2022-03-01', vehicleId: '1', odometer: 48000 },
        { cost: 1000, date: '2022-03-01', vehicleId: '1', odometer: 41000 },
        { cost: 400, date: '2022-03-01', vehicleId: '1', odometer: 40000 },
        { cost: 50, date: '2022-03-01', vehicleId: '1', odometer: 40000 },
        { cost: 100, date: '2022-03-02', vehicleId: '1', odometer: 40100 },
        { cost: 900, date: '2022-06-01', vehicleId: '1', odometer: 42000 },
    ]).records;
    const { series, dropped } = odometerSeries(recs);
    const readings = flatSeries(series.get(1)).map((r) => r.odometer);
    assert.ok(!readings.includes(48000), `48,000 survived: ${readings}`);
    assert.deepEqual(readings, [...readings].sort((a, b) => a - b));
    // The 40,100 on 1 February and the 40,000 on 1 March contradict each
    // other and both sit in a run of the same length, so one of them has to
    // go; the run keeps the later reading. Either choice leaves a span of
    // about 2,000 miles. The point is that it is not the 8,000 that
    // min-to-max across the raw records used to report.
    assert.equal(dropped, 1);
    assert.equal(distanceCovered(recs), 42000 - 40000);
});

check('a spurious HIGH reading does not swallow the honest ones after it', () => {
    // The reason this is a longest-non-decreasing-run and not a running
    // maximum: a running maximum keeps the typo and drops the four real
    // readings that follow, which is the majority of the series.
    const recs = normalise('Service', [
        { cost: 1, date: '2026-01-01', vehicleId: '1', odometer: 1000 },
        { cost: 1, date: '2026-02-01', vehicleId: '1', odometer: 90000 },   // typo
        { cost: 1, date: '2026-03-01', vehicleId: '1', odometer: 1200 },
        { cost: 1, date: '2026-04-01', vehicleId: '1', odometer: 1400 },
        { cost: 1, date: '2026-05-01', vehicleId: '1', odometer: 1600 },
    ]).records;
    const { series, dropped } = odometerSeries(recs);
    assert.deepEqual(flatSeries(series.get(1)).map((r) => r.odometer), [1000, 1200, 1400, 1600]);
    assert.equal(dropped, 1);
    assert.equal(distanceCovered(recs), 600);
});

check('odometerAt interpolates between readings and clamps outside them', () => {
    const series = flatSeries(odometerSeries(normalise('Service', [
        { cost: 1, date: '2026-01-01', vehicleId: '1', odometer: 10000 },
        { cost: 1, date: '2026-03-02', vehicleId: '1', odometer: 16000 },
    ]).records).series.get(1));
    // 2026-01-31 is 30 of the 60 days between them.
    assert.equal(odometerAt(series, parseIsoDate('2026-01-31')), 13000);
    // Never extrapolated: running the line back past the first reading is how
    // you get a car that left the factory on negative miles.
    assert.equal(odometerAt(series, parseIsoDate('2020-01-01')), 10000);
    assert.equal(odometerAt(series, parseIsoDate('2030-01-01')), 16000);
    assert.equal(odometerAt([], parseIsoDate('2026-01-01')), null);
    assert.equal(odometerAt(series, null), null);
});

check('extraField matches the name a person typed, not an exact string', () => {
    const v = { extraFields: [{ name: ' odometer AT purchase ', value: '40,000 mi' }] };
    assert.equal(extraField(v, PURCHASE_ODOMETER_FIELD), '40,000 mi');
    assert.equal(extraField(v, 'nothing'), null);
    assert.equal(extraField(null, PURCHASE_ODOMETER_FIELD), null);
    assert.equal(extraField({}, PURCHASE_ODOMETER_FIELD), null);
});

check('anchorOf reads both fields, and infers whichever is missing', () => {
    const segments = odometerSeries(normalise('Service', [
        { cost: 1, date: '2026-01-01', vehicleId: '1', odometer: 10000 },
        { cost: 1, date: '2026-03-02', vehicleId: '1', odometer: 16000 },
    ]).records).series.get(1);

    const both = anchorOf({
        purchaseDate: '2026-01-31',
        extraFields: [{ name: PURCHASE_ODOMETER_FIELD, value: '12,500' }],
    }, segments);
    assert.equal(both.odometer, 12500);          // typed wins over interpolated
    assert.ok(both.dateSet && both.odometerSet);

    // A date with no reading takes the reading off the series.
    const dateOnly = anchorOf({ purchaseDate: '2026-01-31' }, segments);
    assert.equal(dateOnly.odometer, 13000);
    assert.equal(dateOnly.odometerSet, false);

    // The DATE is what anchors. A mileage on its own places nothing: it is not
    // an answer to "when", and after an instrument swap one number can name two
    // different days on the clock.
    assert.equal(anchorOf({
        extraFields: [{ name: PURCHASE_ODOMETER_FIELD, value: '13000' }],
    }, segments), null);

    // Nothing set is no anchor at all — never a guessed start date.
    assert.equal(anchorOf({}, segments), null);
    assert.equal(anchorOf(null, segments), null);
    assert.equal(anchorOf({ purchaseDate: 'not a date' }, segments), null);
    assert.equal(anchorOf({ purchaseDate: '2026-01-31' }, []).odometer, null);
});

check('a purchase on the day a new cluster went in reads the new cluster', () => {
    // odometerAt() refuses to interpolate DOWN across a reset, but an exact
    // date match is a recorded reading, not a gap to clamp over — otherwise a
    // car bought the day its instrument was replaced anchors to the old one.
    const segments = odometerSeries(normalise('Service', [
        { cost: 1, date: '2025-06-01', vehicleId: '1', odometer: 150000 },
        { cost: 1, date: '2026-01-01', vehicleId: '1', odometer: 160000 },
        { cost: 1, date: '2026-06-01', vehicleId: '1', odometer: 100 },
        { cost: 1, date: '2026-08-01', vehicleId: '1', odometer: 3000 },
    ]).records).series.get(1);
    assert.equal(anchorOf({ purchaseDate: '2026-06-01' }, segments).odometer, 100);
    // ...and one dated in the gap still reads the last of the old cluster.
    assert.equal(anchorOf({ purchaseDate: '2026-03-01' }, segments).odometer, 160000);
});

check('a reset after the purchase is not a contradicted odometer', () => {
    // "conflicts" means the typed figure is higher than something recorded
    // after it. Across an instrument swap EVERY later reading is lower by
    // construction, and flagging that would tell the owner their perfectly
    // good number is wrong — so it is judged inside one segment.
    const segments = odometerSeries(normalise('Service', [
        { cost: 1, date: '2025-06-01', vehicleId: '1', odometer: 150000 },
        { cost: 1, date: '2026-01-01', vehicleId: '1', odometer: 160000 },
        { cost: 1, date: '2026-06-01', vehicleId: '1', odometer: 100 },
        { cost: 1, date: '2026-08-01', vehicleId: '1', odometer: 3000 },
    ]).records).series.get(1);
    const bought = anchorOf({
        purchaseDate: '2025-06-01',
        extraFields: [{ name: PURCHASE_ODOMETER_FIELD, value: '150000' }],
    }, segments);
    assert.equal(bought.conflicts, false);
    // A figure genuinely above a later reading in the SAME segment still is.
    const wrong = anchorOf({
        purchaseDate: '2025-06-01',
        extraFields: [{ name: PURCHASE_ODOMETER_FIELD, value: '170000' }],
    }, segments);
    assert.equal(wrong.conflicts, true);
});

check('the anchor drops the previous owner and rebases the distance', () => {
    // A second-hand car in miniature: two records from before it was bought,
    // three after.
    const rows = [
        { cost: 0, date: '2012-03-01', vehicleId: '1', odometer: 9000 },
        { cost: 0, date: '2020-10-01', vehicleId: '1', odometer: 52000 },
        { cost: 100, date: '2021-07-01', vehicleId: '1', odometer: 56000 },
        { cost: 100, date: '2023-10-01', vehicleId: '1', odometer: 74000 },
        { cost: 100, date: '2026-01-01', vehicleId: '1', odometer: 88000 },
    ];
    const recs = normalise('Service', rows).records;
    const anchor = anchorOf({
        purchaseDate: '2021-05-01',
        extraFields: [{ name: PURCHASE_ODOMETER_FIELD, value: '54000' }],
    }, odometerSeries(recs).series.get(1));

    const mine = anchored(recs, anchor);
    assert.equal(mine.length, 3);
    assert.equal(total(mine), 300);              // unchanged: the old rows cost nothing
    const measured = mine.concat(anchorReading(anchor, 1));

    // Distance now runs from what it read when bought, not from the first
    // receipt after — and not from the previous owner's first receipt at all.
    assert.equal(distanceCovered(recs), 88000 - 9000);
    assert.equal(distanceCovered(measured), 88000 - 54000);

    // ...and ownership is 64 months from May 2021, not 174 from Mar 2012.
    const now = new Date(2026, 7, 7);
    assert.equal(ownershipSpan(recs, now).months, 174);
    const own = ownershipSpan(measured, now);
    assert.equal(own.months, 64);
    assert.equal(own.from.getFullYear(), 2021);
    assert.equal(own.from.getMonth(), 4);
});

check('anchored and anchorReading are inert without an anchor', () => {
    const recs = normalise('Service', [
        { cost: 10, date: '2026-01-01', vehicleId: '1', odometer: 100 },
    ]).records;
    assert.equal(anchored(recs, null), recs);
    assert.deepEqual(anchorReading(null, 1), []);
    // A date with no odometer places no synthetic reading — there is nothing
    // to place. The date still clips the records.
    assert.deepEqual(anchorReading({ date: new Date(2026, 0, 1), odometer: null }, 1), []);
});

check('the synthetic purchase reading never moves a money figure', () => {
    const recs = normalise('Service', [
        { cost: 250, date: '2026-02-01', vehicleId: '1', odometer: 1000 },
    ]).records;
    const anchor = { date: parseIsoDate('2026-01-01'), odometer: 500,
                     dateSet: true, odometerSet: true };
    const measured = recs.concat(anchorReading(anchor, 1));
    assert.equal(total(measured), total(recs));
    assert.deepEqual(byCategory(measured), byCategory(recs));
    assert.deepEqual(activeCategories(measured), activeCategories(recs));
    assert.equal(distanceCovered(measured), 500);
});

check('unownedLeadMonths only fires when the lead-in is real', () => {
    // Eight years of previous-owner receipts before the first one that cost
    // anything — the case the prompt exists for.
    const stale = normalise('Service', [
        { cost: 0, date: '2013-06-01', vehicleId: '1', odometer: 9000 },
        { cost: 100, date: '2021-06-01', vehicleId: '1', odometer: 55000 },
    ]).records;
    assert.equal(unownedLeadMonths(stale), 96);

    // A vehicle whose history starts where its spending starts needs no prompt.
    const clean = normalise('Service', [
        { cost: 100, date: '2021-06-01', vehicleId: '3', odometer: 30000 },
        { cost: 100, date: '2026-07-01', vehicleId: '3', odometer: 95000 },
    ]).records;
    assert.equal(unownedLeadMonths(clean), 0);
    assert.equal(unownedLeadMonths([]), 0);
});

check('a typed odometer at purchase outranks a receipt from the same day', () => {
    // A service record dated the day of purchase reads 41,000. Once the owner
    // states what it read the day they bought it, that is the figure —
    // otherwise filling the field in changes nothing and looks broken.
    const recs = normalise('Service', [
        { cost: 0, date: '2021-06-01', vehicleId: '1', odometer: 41000 },
        { cost: 100, date: '2022-06-01', vehicleId: '1', odometer: 50000 },
    ]).records;
    const anchor = anchorOf({
        purchaseDate: '2021-06-01',
        extraFields: [{ name: PURCHASE_ODOMETER_FIELD, value: '40000' }],
    }, odometerSeries(recs).series.get(1));
    assert.equal(anchor.odometer, 40000);
    assert.equal(anchor.conflicts, false);
    assert.equal(distanceCovered(anchored(recs, anchor)
        .concat(anchorReading(anchor, 1))), 10000);
});

check('a typed odometer that contradicts later readings is flagged, not obeyed', () => {
    // "I bought it at about 60k" against a receipt three months later reading
    // 50,000. Both cannot be true; the single stated point loses to the history
    // and the page says so rather than reporting a shrinking odometer.
    const recs = normalise('Service', [
        { cost: 100, date: '2021-09-01', vehicleId: '1', odometer: 50000 },
        { cost: 100, date: '2026-01-01', vehicleId: '1', odometer: 90000 },
    ]).records;
    const anchor = anchorOf({
        purchaseDate: '2021-06-01',
        extraFields: [{ name: PURCHASE_ODOMETER_FIELD, value: '60000' }],
    }, odometerSeries(recs).series.get(1));
    assert.equal(anchor.conflicts, true);
    const measured = anchored(recs, anchor).concat(anchorReading(anchor, 1));
    assert.equal(distanceCovered(measured), 90000 - 50000);
    assert.deepEqual(
        odometerSeries(measured).series.get(1).flat().map((r) => r.odometer),
        [50000, 90000]);
});

check('an instrument swap keeps both sides, and reports the NEW cluster', () => {
    // The regression the monotonic pass introduced: forcing a whole history
    // into one non-decreasing run throws away whichever side of a reset has
    // fewer readings. A cluster fitted last month loses every mile since; an
    // old one loses the years before it. Both are silent and both still look
    // plausible.
    const recs = normalise('Service', [
        { cost: 1, date: '2023-01-01', vehicleId: '1', odometer: 120000 },
        { cost: 1, date: '2024-01-01', vehicleId: '1', odometer: 140000 },
        { cost: 1, date: '2025-01-01', vehicleId: '1', odometer: 160000 },
        // New cluster fitted. Reads from 12 and climbs.
        { cost: 900, date: '2025-06-01', vehicleId: '1', odometer: 12 },
        { cost: 1, date: '2026-01-01', vehicleId: '1', odometer: 6000 },
        { cost: 1, date: '2026-08-01', vehicleId: '1', odometer: 11000 },
    ]).records;

    const segments = odometerSeries(recs).series.get(1);
    assert.equal(segments.length, 2);
    assert.deepEqual(segments[0].map((r) => r.odometer), [120000, 140000, 160000]);
    assert.deepEqual(segments[1].map((r) => r.odometer), [12, 6000, 11000]);
    assert.equal(odometerSeries(recs).dropped, 0);   // nothing here is a typo

    // 40,000 on the old cluster plus 10,988 on the new one. Never the step
    // across the swap, which is not travel and is negative besides.
    assert.equal(distanceCovered(recs), 40000 + 10988);
    // "Odometer now" is what the car reads now, not what the old one finished on.
    assert.equal(latestOdometer(recs), 11000);
    // The miles after the swap are on the chart, not silently discarded.
    const after = usageByMonth(recs).labels
        .map((l, i) => [l, usageByMonth(recs).values[i]])
        .filter(([l, v]) => l > '2025-06' && v);
    assert.ok(after.length, 'no distance reported after the swap');
});

check('a typo near the end of a history is still a typo, not a reset', () => {
    // Rule (1) alone — "the odometer never gets back to that level" — passes
    // for a stray high reading with nothing after it left to overtake it. Rule
    // (2) is what tells them apart: deleting the one bad point restores order,
    // which is never true of a real reset.
    const recs = normalise('Service', [
        { cost: 1, date: '2026-01-01', vehicleId: '1', odometer: 1000 },
        { cost: 1, date: '2026-02-01', vehicleId: '1', odometer: 90000 },   // typo
        { cost: 1, date: '2026-03-01', vehicleId: '1', odometer: 1200 },
        { cost: 1, date: '2026-04-01', vehicleId: '1', odometer: 1400 },
    ]).records;
    const { series, dropped } = odometerSeries(recs);
    assert.equal(series.get(1).length, 1, 'split a typo into two segments');
    assert.equal(dropped, 1);
    assert.equal(distanceCovered(recs), 400);
    assert.equal(latestOdometer(recs), 1400);
});

check('odometerAt does not interpolate down across a reset', () => {
    // Two readings before the swap, because a drop in the very first pair is
    // read as a typo — there is no earlier reading to judge it against.
    const series = flatSeries(odometerSeries(normalise('Service', [
        { cost: 1, date: '2025-06-01', vehicleId: '1', odometer: 150000 },
        { cost: 1, date: '2026-01-01', vehicleId: '1', odometer: 160000 },
        { cost: 1, date: '2026-06-01', vehicleId: '1', odometer: 100 },
        { cost: 1, date: '2026-08-01', vehicleId: '1', odometer: 3000 },
    ]).records).series.get(1));
    // Between the last reading on the old cluster and the first on the new one
    // there is no line to read; a straight interpolation would invent a
    // steadily falling odometer through the spring.
    assert.equal(odometerAt(series, parseIsoDate('2026-03-01')), 160000);
    assert.equal(odometerAt(series, parseIsoDate('2026-07-01')), 1526);
});

// ── Measuring honestly on incomplete data ──────────────────────────────

/* Two years of receipts, but odometer readings only across the first three
 * months. This is the casual owner's shape: receipts get filed, the Odometer
 * tab does not get maintained. */
const sparse = normalise('Service', [
    { cost: 100, date: '2026-01-15', odometer: 10000, vehicleId: '1' },
    { cost: 100, date: '2026-02-15', odometer: 11000, vehicleId: '1' },
    { cost: 100, date: '2026-03-15', odometer: 12000, vehicleId: '1' },
    { cost: 100, date: '2026-11-15', vehicleId: '1' },
    { cost: 100, date: '2027-06-15', vehicleId: '1' },
]).records;

check('coverage reports what the figures rest on rather than withholding them', () => {
    const c = coverage(sparse);
    assert.equal(c.records, 5);
    assert.equal(c.withOdometer, 3);
    // Readings span Jan-Mar 2026 (3 months); spend spans Jan 2026 - Jun 2027 (18).
    assert.equal(c.readingMonths, 3);
    assert.equal(c.spendMonths, 18);
    assert.ok(c.distanceCoverage > 0.16 && c.distanceCoverage < 0.17, c.distanceCoverage);
});

check('coverage never claims more than full coverage', () => {
    // Zero-cost odometer entries can extend readings BEYOND the spend window,
    // which is coverage of 1, not of 1.4.
    const wide = normalise('Service', [
        { cost: 100, date: '2026-06-15', odometer: 500, vehicleId: '1' },
        { cost: 0, date: '2026-01-15', odometer: 100, vehicleId: '1' },
        { cost: 0, date: '2026-12-15', odometer: 900, vehicleId: '1' },
    ]).records;
    assert.equal(coverage(wide).distanceCoverage, 1);
});

check('distance is filled at the measured rate when readings stop early', () => {
    // Measured: 2,000 miles across 3 months of readings — which is TWO
    // month-to-month intervals, so 1,000/month, not 667. Ownership runs 18
    // months (17 intervals), so the honest estimate is ~17,000, not 2,000.
    const now = parseIsoDate('2027-06-20');
    const est = estimatedDistance(sparse, null, now);
    assert.equal(est.measured, 2000);
    assert.equal(est.estimated, true);
    assert.equal(est.readingMonths, 3);
    assert.equal(est.months, 18);
    assert.equal(est.ratePerMonth, 1000);
    // Rounded ONCE at the end. Rounding the rate first and then multiplying
    // would compound the error by the number of intervals.
    assert.equal(est.distance, 17000);

    // And the point of the exercise: cost per mile stops reading 6x too high.
    assert.ok(total(sparse) / est.measured > 0.2);          // 500/2000  = $0.25
    assert.ok(total(sparse) / est.distance < 0.04);         // 500/17000 = $0.03
});

check('spend alone and spend-plus-readings are not interchangeable', () => {
    /* THE PAIR the vehicle dashboard's tile and footnote disagreed over.
     *
     * A garage that keeps its mileage in the Odometer tab has no reading on any
     * receipt, so the spend records answer "nothing measured, nothing
     * estimated" while the same history with its readings folded in answers
     * "2,000 measured, 17,000 estimated". vehicle-dash.js divided by the second
     * and described the first, so the tile wore the estimate mark while the
     * footnote below it decided no estimate had been made and dropped the
     * caveat — on the one page whose footnote is its honesty channel.
     *
     * render() computes it ONCE now and hands the one object to both. This pins
     * why that has to stay true: the two sets do not agree and cannot, so
     * passing the wrong one back in is a contradiction on screen, not a
     * rounding difference. */
    const now = parseIsoDate('2027-06-20');
    const spend = normalise('Service', [
        { cost: 100, date: '2026-01-15', vehicleId: '1' },
        { cost: 100, date: '2026-11-15', vehicleId: '1' },
        { cost: 100, date: '2027-06-15', vehicleId: '1' },
    ]).records;
    const readings = normaliseReadings([
        { date: '2026-01-15', odometer: 10000, vehicleId: '1' },
        { date: '2026-02-15', odometer: 11000, vehicleId: '1' },
        { date: '2026-03-15', odometer: 12000, vehicleId: '1' },
    ]).records;

    const spendOnly = estimatedDistance(spend, null, now);
    assert.equal(spendOnly.measured, null, 'not one receipt carries a reading');
    assert.equal(spendOnly.estimated, false, 'what the footnote used to describe');

    const withReadings = estimatedDistance(spend.concat(readings), null, now);
    assert.equal(withReadings.measured, 2000);
    assert.equal(withReadings.estimated, true, 'what the tile actually divides by');
    assert.equal(withReadings.readingMonths, 3);
    assert.equal(withReadings.months, 18);

    /* coverage() stays on the SPEND records, and that is not the same slip: it
     * answers "how many receipts carry a reading", which is a fact about
     * receipts. It is only wrong when its answer is used to decide whether to
     * mention the estimate — a different question that now has its own test. */
    assert.equal(coverage(spend).records, 3);
    assert.equal(coverage(spend).withOdometer, 0);
});

check('a complete history is never turned into an estimate', () => {
    // Readings cover every month that saw spend: there is nothing to fill, and
    // silently replacing a measured figure with a modelled one would be worse
    // than the gap it fixes.
    const now = parseIsoDate('2026-03-20');
    const full = normalise('Service', [
        { cost: 100, date: '2026-01-15', odometer: 10000, vehicleId: '1' },
        { cost: 100, date: '2026-02-15', odometer: 11000, vehicleId: '1' },
        { cost: 100, date: '2026-03-15', odometer: 12000, vehicleId: '1' },
    ]).records;
    const est = estimatedDistance(full, null, now);
    assert.equal(est.estimated, false);
    assert.equal(est.distance, est.measured);
    assert.equal(est.distance, 2000);
});

check('one month of readings establishes no rate, so nothing is invented', () => {
    const now = parseIsoDate('2027-06-20');
    const single = normalise('Service', [
        { cost: 100, date: '2026-01-05', odometer: 10000, vehicleId: '1' },
        { cost: 100, date: '2026-01-25', odometer: 10500, vehicleId: '1' },
        { cost: 100, date: '2027-06-15', vehicleId: '1' },
    ]).records;
    const est = estimatedDistance(single, null, now);
    assert.equal(est.estimated, false, 'a single month is not a rate');
    assert.equal(est.distance, 500);
});

check('no odometer anywhere estimates nothing at all', () => {
    const none = normalise('Service', [
        { cost: 100, date: '2026-01-05', vehicleId: '1' },
        { cost: 100, date: '2027-01-05', vehicleId: '1' },
    ]).records;
    const est = estimatedDistance(none, null, parseIsoDate('2027-06-20'));
    assert.equal(est.distance, null);
    assert.equal(est.estimated, false);
});

check('the estimate measures from the purchase anchor, not the oldest record', () => {
    // The previous owner's records must not lengthen the denominator, exactly
    // as they do not for cost per month.
    const now = parseIsoDate('2027-06-20');
    const bought = parseIsoDate('2027-01-01');
    const est = estimatedDistance(sparse, bought, now);
    assert.equal(est.months, 6, 'Jan-Jun 2027 inclusive');
    assert.ok(est.distance < 5100, est.distance);
});

check('a gap too small to move the number is not called an estimate', () => {
    /* A history covered in all but a month or two — 178 of 180 months, say —
     * fills to 1.1% more distance. Marking that estimated teaches the reader
     * the marker means nothing, so it stops being seen on the garage where it
     * means a fifth of the mileage. */
    const rows = [];
    for (let m = 0; m < 24; m++) {
        const month = String((m % 12) + 1).padStart(2, '0');
        const year = 2025 + Math.floor(m / 12);
        rows.push({ cost: 50, date: `${year}-${month}-10`,
                    odometer: 10000 + m * 1000, vehicleId: '1' });
    }
    // One extra month of spend past the last reading: a 1/24 gap.
    rows.push({ cost: 50, date: '2027-01-10', vehicleId: '1' });
    const est = estimatedDistance(normalise('Service', rows).records, null,
                                  parseIsoDate('2027-01-20'));
    assert.equal(est.estimated, false, 'a one-month tail is not an estimate');
    assert.equal(est.distance, est.measured);
    assert.ok(MIN_ESTIMATE_LIFT > 0 && MIN_ESTIMATE_LIFT < 0.5);
});

check('the rate divides by intervals, not by the count of reading months', () => {
    // The minimum supported case, where the error was largest: two reading
    // months is ONE interval. Dividing by 2 halved the rate and so nearly
    // doubled cost per distance — the very error this function corrects.
    const now = parseIsoDate('2026-12-20');
    const rows = normalise('Service', [
        { cost: 100, date: '2026-01-10', odometer: 10000, vehicleId: '1' },
        { cost: 100, date: '2026-02-10', odometer: 11000, vehicleId: '1' },
        { cost: 100, date: '2026-12-10', vehicleId: '1' },
    ]).records;
    const est = estimatedDistance(rows, null, now);
    assert.equal(est.measured, 1000);
    assert.equal(est.readingMonths, 2);
    assert.equal(est.ratePerMonth, 1000, 'one interval covered 1,000 miles');
    assert.equal(est.months, 12);
    assert.equal(est.distance, 11000, '11 intervals at 1,000');
});

/* ── Buying the car ─────────────────────────────────────────────────── */

const vehicleWith = (fields, extra = {}) => ({
    id: 1, year: 2010, make: 'BMW', model: '3 Series',
    purchaseDate: '2021-05-01', purchasePrice: 20000,
    extraFields: Object.entries(fields).map(([name, value]) => ({ name, value })),
    ...extra,
});

check('typedNumber survives what people type into a form box', () => {
    assert.equal(typedNumber('$2,000'), 2000);
    assert.equal(typedNumber('4.9%'), 4.9);
    assert.equal(typedNumber('72 months'), 72);
    assert.equal(typedNumber(''), null);
    assert.equal(typedNumber(undefined), null);
    assert.equal(typedNumber('none'), null);
});

check('amortise matches a hand-computed loan and lands exactly on zero', () => {
    // $18,000 at 5.9% over 60 months. The standard formula gives $347.15/mo.
    const rows = amortise(18000, 5.9, 60);
    assert.equal(rows.length, 60);
    assert.equal(rows[0].payment, 347.15);
    // First month's interest is one month of 5.9% on the whole balance.
    assert.equal(rows[0].interest, round2(18000 * 0.059 / 12));
    // THE THING THAT MATTERS: the balance ends at zero, not at $0.03 of
    // accumulated rounding — this is the number people check.
    assert.equal(rows[59].balance, 0);
    const principal = round2(rows.reduce((a, r) => a + r.principal, 0));
    assert.equal(principal, 18000, 'every dollar borrowed is repaid exactly once');
});

check('a 0% loan divides evenly instead of dividing by zero', () => {
    const rows = amortise(12000, 0, 24);
    assert.equal(rows.length, 24);
    assert.equal(rows[0].payment, 500);
    assert.equal(rows[0].interest, 0);
    assert.equal(rows[23].balance, 0);
});

check('amortise declines the impossible rather than looping', () => {
    assert.deepEqual(amortise(0, 5, 60), []);
    assert.deepEqual(amortise(18000, 5, 0), []);
    assert.deepEqual(amortise(-100, 5, 60), []);
});

check('loanOf derives payment, interest and payoff from APR + term + deposit', () => {
    const loan = loanOf(vehicleWith({
        [LOAN_FIELDS.down]: '$2,000',
        [LOAN_FIELDS.apr]: '5.9',
        [LOAN_FIELDS.term]: '60',
    }));
    assert.equal(loan.price, 20000);
    assert.equal(loan.down, 2000);
    assert.equal(loan.financed, 18000);
    assert.equal(loan.payment, 347.15);
    // Total cost is the sticker plus interest — NOT price + down + payments,
    // which would count the deposit twice.
    assert.equal(loan.totalCost, round2(20000 + loan.interest));
    assert.ok(loan.interest > 2700 && loan.interest < 2900, `interest ${loan.interest}`);
    // 60 instalments from May 2021, the first in June → paid off May 2026.
    assert.equal(loan.payoff.getFullYear(), 2026);
    assert.equal(loan.payoff.getMonth(), 4);
});

check('a cash purchase is a loan with no schedule, not a null', () => {
    const loan = loanOf(vehicleWith({}));
    assert.equal(loan.financedFully, false);
    assert.equal(loan.interest, 0);
    assert.equal(loan.totalCost, 20000);
    assert.equal(loan.payoff, null);
});

check('a car bought outright counts the WHOLE price as paid, on the day', () => {
    // The bug this file failed to catch first time round: the check above
    // asserted totalCost and never once asked what had been PAID. With no term
    // there is no schedule, so everything came out as the deposit — which on a
    // cash purchase is zero, and a $20,000 car reported $0 on the chart and
    // added nothing when the toggle went on.
    const loan = loanOf(vehicleWith({}));
    assert.equal(loan.financed, 0, 'nothing is financed without a term');
    assert.equal(loan.upfront, 20000);
    assert.equal(paidAt(loan, parseIsoDate('2021-05-31')), 20000);
    assert.equal(paidAt(loan, parseIsoDate('2026-08-01')), 20000, 'and stays there');
    assert.equal(paidAt(loan, parseIsoDate('2021-04-30')), 0, 'nothing before the day');
    assert.deepEqual(paidByMonth(loan, ['2021-04', '2021-05', '2021-06']),
                     [null, 20000, 20000]);
});

check('an APR with no term still buys the car outright rather than for free', () => {
    // Half-filled form: somebody typed the rate and stopped. There is no
    // schedule, so there is no loan — and the price was still paid.
    const loan = loanOf(vehicleWith({ [LOAN_FIELDS.apr]: '5.9' }));
    assert.equal(loan.financedFully, false);
    assert.equal(loan.upfront, 20000);
    assert.equal(loan.totalCost, 20000);
});

check('a deposit recorded with no price is money paid, not a free car', () => {
    const loan = loanOf({ purchaseDate: '2021-05-01', purchasePrice: 0,
        extraFields: [{ name: LOAN_FIELDS.down, value: '5000' }] });
    assert.equal(loan.upfront, 5000);
    assert.equal(loan.totalCost, 5000, 'price + interest would have said $0');
    assert.equal(paidAt(loan, parseIsoDate('2022-01-01')), 5000);
});

check('what you pay over the whole loan IS the total cost, every shape', () => {
    // One invariant across all three shapes, rather than three spot figures:
    // whatever the paperwork looks like, the last point of the paid line has
    // to equal the "what it ends up costing" tile. They are the same claim
    // rendered twice and a reader will check them against each other.
    for (const fields of [
        {},                                                            // cash
        { [LOAN_FIELDS.down]: '2000', [LOAN_FIELDS.apr]: '5.9',
          [LOAN_FIELDS.term]: '60' },                                  // financed
        { [LOAN_FIELDS.apr]: '0', [LOAN_FIELDS.term]: '24' },          // 0% deal
    ]) {
        const loan = loanOf(vehicleWith(fields));
        assert.equal(paidAt(loan, parseIsoDate('2040-01-01')), loan.totalCost,
                     `paid-in-full matches totalCost for ${JSON.stringify(fields)}`);
    }
});

check('no price and no deposit means there is nothing to say', () => {
    assert.equal(loanOf({ purchasePrice: 0, purchaseDate: '2021-05-01' }), null);
    assert.equal(loanOf(null), null);
});

check('a price with no purchase date still totals, it just cannot be plotted', () => {
    const loan = loanOf(vehicleWith({ [LOAN_FIELDS.apr]: '5.9', [LOAN_FIELDS.term]: '60' },
                                    { purchaseDate: '' }));
    assert.equal(loan.start, null);
    assert.equal(loan.price, 20000);
    assert.deepEqual(paidByMonth(loan, ['2021-05', '2021-06']), [null, null]);
});

check('paidByMonth puts the deposit at the purchase and the first instalment after', () => {
    const loan = loanOf(vehicleWith({
        [LOAN_FIELDS.down]: '2000',
        [LOAN_FIELDS.apr]: '5.9',
        [LOAN_FIELDS.term]: '60',
    }));
    const paid = paidByMonth(loan, ['2021-04', '2021-05', '2021-06', '2021-07']);
    assert.equal(paid[0], null, 'nothing was paid before it was bought');
    assert.equal(paid[1], 2000, 'the purchase month is the deposit alone');
    assert.equal(paid[2], round2(2000 + loan.payment));
    assert.equal(paid[3], round2(2000 + loan.payment * 2));
});

check('paid stops growing once the loan is paid off', () => {
    const loan = loanOf(vehicleWith({
        [LOAN_FIELDS.down]: '2000',
        [LOAN_FIELDS.apr]: '5.9',
        [LOAN_FIELDS.term]: '60',
    }));
    const settled = round2(2000 + loan.schedule.reduce((a, r) => a + r.payment, 0));
    assert.equal(paidAt(loan, parseIsoDate('2026-05-15')), settled);
    assert.equal(paidAt(loan, parseIsoDate('2030-01-15')), settled,
                 'five years later it is still the same total');
    assert.equal(settled, round2(loan.totalCost), 'what you paid IS what it cost');
    assert.equal(paidAt(loan, parseIsoDate('2019-01-01')), 0, 'zero before purchase');
});

check('valuations bracket the typed figures with the purchase and the sale', () => {
    const points = valuationsOf(vehicleWith(
        { [VALUATION_FIELD]: '2023-06 = 12,000; 2026-01=10000' },
        { soldDate: '2026-06-30', soldPrice: 6800 }));
    assert.deepEqual(points.map((p) => p.value), [20000, 12000, 10000, 6800]);
    assert.deepEqual(points.map((p) => p.source),
                     ['bought', 'stated', 'stated', 'sold']);
    assert.equal(points[1].date.getMonth(), 5);
    assert.equal(points[1].date.getDate(), 1, 'a bare month means its first day');
});

check('a bare number in the valuations box means "worth this now"', () => {
    const points = valuationsOf(vehicleWith({ [VALUATION_FIELD]: '10000' }));
    assert.equal(points.length, 2);
    assert.equal(points[1].value, 10000);
    assert.ok(points[1].date >= points[0].date);
});

check('junk in the valuations box is dropped, not turned into a number', () => {
    const points = valuationsOf(vehicleWith(
        { [VALUATION_FIELD]: 'about twelve grand, 2023-13 = 500, 2023-06 = 12000' }));
    assert.deepEqual(points.map((p) => p.value), [20000, 12000],
                     'the impossible month and the prose are both gone');
});

check('valueAt interpolates between points, holds after, and is null before', () => {
    const points = valuationsOf(vehicleWith({ [VALUATION_FIELD]: '2023-05 = 10000' }));
    assert.equal(valueAt(points, parseIsoDate('2019-01-01')), null);
    assert.equal(valueAt(points, parseIsoDate('2021-05-01')), 20000);
    // Two years, $10,000 down: the halfway point is $15,000.
    const mid = valueAt(points, parseIsoDate('2022-05-01'));
    assert.ok(Math.abs(mid - 15000) < 30, `halfway is about $15,000, got ${mid}`);
    assert.equal(valueAt(points, parseIsoDate('2026-08-01')), 10000,
                 'flat after the last figure you gave it');
});

check('valueByMonth reads the END of the month, so it lines up with cumulatives', () => {
    const points = valuationsOf(vehicleWith({ [VALUATION_FIELD]: '2023-05 = 10000' }));
    const values = valueByMonth(points, ['2021-04', '2021-05', '2023-06']);
    assert.equal(values[0], null);
    assert.ok(values[1] < 20000 && values[1] > 19000,
              'the purchase month has already depreciated a little by its end');
    assert.equal(values[2], 10000);
});

check('the running cost per distance drops the receipt-over-twelve-miles opening', () => {
    // The shape that made this chart unusable: a first service two days after
    // the purchase and twelve miles later puts the opening point at well over
    // $150/mile against a lifetime of about fifty cents. That single point
    // owned the y-axis and flattened six years into a smear.
    const rows = [
        { cost: 2000, date: '2019-05-01', odometer: 40000, vehicleId: '1' },
        { cost: 0,    date: '2019-05-03', odometer: 40012, vehicleId: '1' },
    ];
    for (let m = 1; m <= 72; m++) {
        const year = 2019 + Math.floor((4 + m) / 12);
        const month = ((4 + m) % 12) + 1;
        rows.push({ cost: 300, date: `${year}-${String(month).padStart(2, '0')}-10`,
                    odometer: 40012 + m * 600, vehicleId: '1' });
    }
    const records = normalise('Service', rows).records;

    // Unsuppressed, the opening point really is that bad — assert it, so this
    // test fails if the fixture ever stops reproducing the bug it was written
    // for rather than silently certifying a chart that was never broken.
    const raw = round2(2000 / 12);
    assert.ok(raw > 150, `the fixture reproduces the spike: $${raw}/mile`);

    const out = cumulativeCostPerDistance(records);
    assert.ok(out.opening > 0, 'the opening months were dropped');
    const shown = out.values.filter((v) => v !== null);
    const settled = shown[shown.length - 1];
    assert.ok(Math.max(...shown) < settled * 3,
              `nothing left towers over the settled ${settled}: peak ${Math.max(...shown)}`);
    // Labels and values are cut together, so the axis holds no empty room for
    // the months that were dropped.
    assert.equal(out.labels.length, out.values.length);
    assert.ok(out.values[0] !== null, 'the series starts where the line does');
    assert.ok(out.values.every((v) => v !== null), 'and never breaks after that');
    assert.equal(out.labels.length + out.opening, monthSpan(records,
        { endAtLastRecord: true }).length, 'every dropped month is accounted for');
    assert.ok(CPD_WARMUP > 0 && CPD_WARMUP < 0.5);
});

check('including the purchase raises cost per distance without breaking the line', () => {
    const records = normalise('Service', [
        { cost: 1000, date: '2024-01-10', odometer: 10000, vehicleId: '1' },
        { cost: 1000, date: '2024-06-10', odometer: 20000, vehicleId: '1' },
        { cost: 1000, date: '2025-01-10', odometer: 30000, vehicleId: '1' },
    ]).records;
    const plain = cumulativeCostPerDistance(records);
    const withCar = cumulativeCostPerDistance(records,
                                              { paidByLabel: () => 20000 });
    plain.values.forEach((v, i) => {
        if (v === null) return assert.equal(withCar.values[i], null);
        assert.ok(withCar.values[i] > v, 'the car itself is not free');
    });
});

/* ── The depreciation curve ─────────────────────────────────────────────
 *
 * The whole point of the table is that it is NOT one curve, so the checks
 * that matter are the ones asserting two vehicles get different answers.
 */

check('the curve prefers the model, then the make, then the fleet', () => {
    const of = (extra) => depreciationCurve(vehicleWith({}, extra));

    assert.equal(of({ make: 'BMW', model: '7 Series' }).retain5, 0.384);
    // A BMW with neither a measured table nor a study row of its own gets the
    // BMW rate — not the 7 Series' number, and not the 3 Series' table.
    assert.equal(of({ make: 'BMW', model: '540i' }).retain5, 0.45);
    assert.equal(of({ make: 'BMW', model: '540i' }).basis, 'make');
    assert.equal(of({ make: 'Cletus Motors', model: 'Thing' }).retain5,
                 FLEET_RETENTION_5Y);
    assert.equal(of({ year: 'nope' }), null, 'no model year, no curve');

    // A trim lands on its model rather than falling through to the make.
    assert.equal(of({ make: 'Toyota', model: 'RAV4 Hybrid' }).retain5, 0.748);
    assert.equal(of({ make: 'Toyota', model: '4Runner TRD Pro' }).retain5, 0.745);

    // The one the prefix ordering exists for: a Mach-E is not a Mustang, and
    // matching the shorter key first would price it 34 points too high.
    assert.equal(of({ make: 'Ford', model: 'Mustang' }).retain5, 0.732);
    assert.equal(of({ make: 'Ford', model: 'Mustang Mach-E' }).retain5, 0.392);

    // An unlisted EV follows the EV segment rather than its badge — the same
    // Hyundai loses a third more of its value with a battery in it.
    assert.equal(of({ make: 'Hyundai', model: 'Kona' }).retain5, 0.57);
    assert.equal(of({ make: 'Hyundai', model: 'Ioniq 6', isElectric: true })
                 .retain5, 0.428);
    // ...but a model the study measured by name keeps its own number.
    assert.equal(of({ make: 'Tesla', model: 'Model Y', isElectric: true })
                 .retain5, 0.422);
});

check('a car bought new lands exactly on the study’s five-year figure', () => {
    const v = vehicleWith({}, {
        year: 2020, make: 'Toyota', model: 'Corolla',
        purchaseDate: '2020-01-01', purchasePrice: 25000,
    });
    const points = valuationsOf(v);
    const curve = depreciationCurve(v);
    assert.equal(curve.retain5, 0.724);
    assert.equal(valueAt(points, parseIsoDate('2025-01-01'), curve),
                 round2(25000 * 0.724),
                 'five years old is the one age the table actually measured');
});

check('the same five years costs a BMW far more than a Toyota', () => {
    const worth = (make, model) => {
        const v = vehicleWith({}, {
            year: 2020, make, model,
            purchaseDate: '2020-01-01', purchasePrice: 40000,
        });
        return valueAt(valuationsOf(v), parseIsoDate('2025-01-01'),
                       depreciationCurve(v));
    };
    const bmw = worth('BMW', 'X5');
    const toyota = worth('Toyota', '4Runner');
    assert.ok(toyota > bmw * 1.6,
              `a 4Runner should hold far more than an X5, got ${toyota} vs ${bmw}`);
});

/* The models the measured tables exist for, so they are the ones worth
 * asserting against — plus one that has no table of its own. */
check('the measured models each get their own measured curve', () => {
    const of = (make, model, year) =>
        depreciationCurve(vehicleWith({}, { make, model, year }));

    for (const [make, model] of [['BMW', '3 Series'], ['BMW', 'X3'],
                                 ['Subaru', 'Forester'], ['Honda', 'CR-V']]) {
        assert.equal(of(make, model, 2020).basis, 'measured',
                     `${make} ${model} should have a measured table`);
    }
    // A trim suffix must still find the platform's table, and so must a
    // model typed the way people type it rather than as its platform.
    assert.deepEqual(of('BMW', 'X3 Some Trim', 2020).table, of('BMW', 'X3', 2020).table);
    assert.deepEqual(of('BMW', '330i', 2020).table, of('BMW', '3 Series', 2020).table);
    // A model with no table falls back to its make, and that is fine, not a bug.
    assert.equal(of('Ford', 'Focus', 2020).basis, 'make');
});

check('the measured curves disagree with each other, which is the point', () => {
    // At eight years old these four are nothing like one another. A single
    // fitted rate cannot produce this spread, which is why the tables exist.
    const at8 = (make, model) => {
        const v = vehicleWith({}, {
            make, model, year: 2018,
            purchaseDate: '2018-01-01', purchasePrice: 40000,
        });
        return valueAt(valuationsOf(v), parseIsoDate('2026-01-01'),
                       depreciationCurve(v));
    };
    const x3 = at8('BMW', 'X3'), crv = at8('Honda', 'CR-V');
    const forester = at8('Subaru', 'Forester');
    assert.ok(crv > forester && forester > x3,
              `CR-V > Forester > X3 at eight years, got ${crv}/${forester}/${x3}`);
    // 54.6% vs 31.1% of the same $40,000 — a 1.75x spread.
    assert.ok(crv > x3 * 1.6, `got ${crv} vs ${x3}`);
});

check('the measured table reproduces its own published rows', () => {
    // Bought new in 2018, valued at exactly eight years old: the answer must
    // be the row itself (31.1% for the X3), not something near it.
    const v = vehicleWith({}, {
        make: 'BMW', model: 'X3', year: 2018,
        purchaseDate: '2018-01-01', purchasePrice: 60000,
    });
    const worth = valueAt(valuationsOf(v), parseIsoDate('2026-01-01'),
                          depreciationCurve(v));
    assert.ok(Math.abs(worth - 60000 * 0.311) < 10,
              `eight years is the table's 31.1%, got ${worth}`);
});

check('a car older than its table keeps falling, gently, toward the floor', () => {
    // An 18-year-old 3 Series, and the table stops at 12. Off the end it
    // continues at the rate the last two rows imply — and the answer has to
    // stay plausible, not collapse towards zero: a made-up $10,000 purchase
    // in June 2019, at eleven years old, should still be modelled at around
    // $5,700 seven years on.
    const v = vehicleWith({}, {
        make: 'BMW', model: '3 Series', year: 2008,
        purchaseDate: '2019-06-01', purchasePrice: 10000,
    });
    const curve = depreciationCurve(v);
    const now = valueAt(valuationsOf(v), parseIsoDate('2026-08-01'), curve);
    assert.ok(now > 4800 && now < 6600,
              `should stay near a plausible ~$5,700, got ${now}`);
    // ...and never off a cliff at the table's edge.
    const at12 = valueAt(valuationsOf(v), parseIsoDate('2020-07-01'), curve);
    const at13 = valueAt(valuationsOf(v), parseIsoDate('2021-07-01'), curve);
    assert.ok(at12 > at13 && at13 > at12 * 0.85,
              `no step at the end of the table, got ${at12} -> ${at13}`);
});

check('one typed figure is enough to chart a car with no purchase price', () => {
    // A car with no purchase price on file has no anchor, so valueAt()
    // returned null everywhere — the line did not exist. Running the curve
    // BACKWARDS off a single stated figure is what makes "type what it is
    // worth today" enough.
    const v = vehicleWith({ [VALUATION_FIELD]: '2026-08 = 20000' },
                          { year: 2020, make: 'BMW', model: 'X3',
                            purchaseDate: '', purchasePrice: 0 });
    const points = valuationsOf(v);
    const curve = depreciationCurve(v);
    assert.equal(points.length, 1, 'one stated figure, no purchase to bracket it');

    const then = valueAt(points, parseIsoDate('2023-03-01'), curve);
    assert.ok(then > 27500 && then < 36500,
              `at three years old it comes out around $32,000, got ${then}`);
    assert.ok(then > valueAt(points, parseIsoDate('2025-08-01'), curve));
    assert.equal(valueAt(points, parseIsoDate('2026-08-01'), curve), 20000);

    // Nothing before it was built.
    assert.equal(valueAt(points, parseIsoDate('2019-01-01'), curve), null);
});

check('a purchase price still ends the line, never extended backwards', () => {
    // The rule above must not reach back past a purchase: what it was worth
    // before you owned it is not this chart, and that was true before.
    const v = vehicleWith({});          // 2010 3 Series, bought 2021-05-01
    const points = valuationsOf(v);
    assert.equal(points[0].source, 'bought');
    assert.equal(valueAt(points, parseIsoDate('2019-01-01'),
                         depreciationCurve(v)), null);
});

check('the curves run backwards to a plausible purchase price', () => {
    /* Anchor ONLY on a value typed for Aug 2026, run the curve backwards, and
     * see whether it lands on the purchase price — a number the curve is never
     * given. A round trip on made-up figures: the older-than-its-table check
     * above models a $10,000 purchase in June 2019 at about $5,700 now, so
     * starting from $5,700 has to come back within 2% of $10,000, through both
     * regimes of the curve (the tail past the table, then the table itself).
     * Two different curves (measured table for the BMW, fitted make rate for
     * the Ford). If a table is ever re-read wrong, this is what catches it. */
    const predict = (v, when, worthNow) => {
        const veh = { ...v, purchaseDate: '', purchasePrice: 0,
                      extraFields: [{ name: VALUATION_FIELD,
                                      value: `2026-08 = ${worthNow}` }] };
        return valueAt(valuationsOf(veh), parseIsoDate(when),
                       depreciationCurve(veh));
    };

    // A made-up 2008 3 Series typed at $5,700 for Aug 2026, run back to June 2019.
    const bmw = predict({ year: 2008, make: 'BMW', model: '3 Series' },
                        '2019-06-01', 5700);
    assert.ok(Math.abs(bmw - 10000) / 10000 < 0.02,
              `3 Series: predicted ${bmw}, expected about $10,000`);

    /* The Ford is the counter-example. It has no measured table, so it falls
     * back to the fitted make rate for Ford — one five-year figure for the
     * whole make, which knows nothing about the particular model (an old
     * hybrid's battery, say). On a model the make does not represent well it
     * will be further out than a measured table would be: that is the limit
     * of the fallback, and the reason the measured tables exist. Improving it
     * needs a table for the model or a typed valuation, not a tweak to a
     * constant. Assert the BAND so a silent drift still fails. */
    const ford = predict({ year: 2010, make: 'Ford', model: 'Focus' },
                         '2023-01-01', 3000);
    assert.ok(ford > 3550 && ford < 4250,
              `the make-rate fallback stays inside its band, got ${ford}`);
});

check('a sale is the last word — the curve never depreciates past it', () => {
    // What somebody actually paid on the day is a transaction, not an
    // estimate. Modelling past it rewrites a settled fact, and the sold price
    // is the one figure on this chart that is not an opinion.
    const v = vehicleWith({}, { soldDate: '2026-06-30', soldPrice: 6789 });
    const points = valuationsOf(v);
    const curve = depreciationCurve(v);
    assert.equal(points[points.length - 1].source, 'sold');
    assert.equal(valueAt(points, parseIsoDate('2026-06-30'), curve), 6789);
    assert.equal(valueAt(points, parseIsoDate('2030-01-01'), curve), 6789,
                 'four years on, it still sold for what it sold for');
});

check('an old car is priced off its own age, not off how long you have had it', () => {
    // The default fixture: a 2010 car bought in 2021 at eleven years old. The
    // fixture's whole point is that a curve run from the PURCHASE date would
    // charge it a new car's first five years all over again.
    const v = vehicleWith({});
    const points = valuationsOf(v);          // bought 2021-05-01 for $20,000
    const curve = depreciationCurve(v);
    const now = valueAt(points, parseIsoDate('2026-08-01'), curve);

    assert.ok(now > 11000 && now < 16000,
              `five more years on an already-old car is a gentle slope, got ${now}`);

    // The same car bought nearly new — five years takes about half. Not
    // QUITE half of the price paid, and the difference is the point: the
    // table says 47.4% of MSRP at five years, but this one was bought three
    // months old with ~10% already gone, so it keeps a little more of what
    // was actually paid than the headline figure suggests.
    const fresh = vehicleWith({}, { year: 2021, purchaseDate: '2021-04-01' });
    const freshNow = valueAt(valuationsOf(fresh), parseIsoDate('2026-04-01'),
                             depreciationCurve(fresh));
    assert.ok(freshNow > 20000 * 0.45 && freshNow < 20000 * 0.55,
              `about half of what was paid, got ${freshNow}`);
});

check('a figure you type in supersedes the curve and re-anchors the tail', () => {
    // Deliberately NOT a round number. An earlier version rounded the modelled
    // value to the nearest ten and applied that on the last real point too,
    // where the ratio is 1 — so a typed 9,234 came back as 9,230 and the
    // promise that the line passes through what you entered was false. A
    // fixture ending in a clean 9000 could never have shown it.
    const v = vehicleWith({ [VALUATION_FIELD]: '2025-05 = 9234' });
    const points = valuationsOf(v);
    const curve = depreciationCurve(v);

    assert.equal(valueAt(points, parseIsoDate('2025-05-01'), curve), 9234,
                 'the figure you typed, to the dollar');
    // ...and interpolates between real points rather than modelling there.
    const mid = valueAt(points, parseIsoDate('2023-05-01'), curve);
    assert.ok(Math.abs(mid - 14500) < 200,
              `halfway between $20,000 and $9,000 is about $14,500, got ${mid}`);
    // Past it, the curve carries on from 9000 — below it, not from the price.
    const later = valueAt(points, parseIsoDate('2026-08-01'), curve);
    assert.ok(later < 9000 && later > 7000, `got ${later}`);
});

check('the curve only ever falls, and never past the floor', () => {
    const v = vehicleWith({}, { year: 2000, purchaseDate: '2000-01-01' });
    const points = valuationsOf(v);
    const curve = depreciationCurve(v);
    let prev = Infinity;
    for (let y = 2000; y <= 2060; y++) {
        const n = valueAt(points, parseIsoDate(`${y}-01-01`), curve);
        assert.ok(n <= prev + 0.01, `value rose in ${y}: ${prev} -> ${n}`);
        assert.ok(n >= 20000 * RESIDUAL_FLOOR - 0.01,
                  `a running car is never worthless, got ${n} in ${y}`);
        prev = n;
    }
});

check('without a curve the value line holds flat, exactly as it used to', () => {
    const points = valuationsOf(vehicleWith({ [VALUATION_FIELD]: '2022-04 = 10000' }));
    assert.equal(valueAt(points, parseIsoDate('2030-01-01')), 10000);
    assert.equal(valueByMonth(points, ['2030-01'])[0], 10000);
});

console.log(`\n${passed} checks passed.`);
