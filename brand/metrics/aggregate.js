/* Road Track — metrics aggregation.
 *
 * Pure functions only: they take already-fetched LubeLogger records and return
 * plain arrays/objects. No DOM, no fetch, no Chart.js — so tools/test_metrics.mjs
 * can run the money math under node without a browser.
 *
 * Every record here has already been through normalise(), which is the ONLY
 * place that knows about LubeLogger's wire format.
 */

/* Spend categories, in fixed slot order. The order is the palette's CVD-safety
 * mechanism (see metrics.css) — reordering these silently reassigns colours. */
export const CATEGORIES = ['Fuel', 'Service', 'Repairs', 'Upgrades', 'Taxes'];

/* LubeLogger endpoint → our category. Fuel is last because gas records carry
 * extra fields (fuelEconomy) the generic shape doesn't have. */
export const SOURCES = [
    { category: 'Service',  path: '/api/vehicle/servicerecords/all' },
    { category: 'Repairs',  path: '/api/vehicle/repairrecords/all' },
    { category: 'Upgrades', path: '/api/vehicle/upgraderecords/all' },
    { category: 'Taxes',    path: '/api/vehicle/taxrecords/all' },
    { category: 'Fuel',     path: '/api/vehicle/gasrecords/all' },
];

/* Odometer records are LubeLogger's dedicated mileage store — a reading with a
 * date and no money attached, entered from the Odometer tab.
 *
 * They are fetched separately from SOURCES because they are not spend: folding
 * them in would inflate the record count, give bySystem() rows with no
 * description to read, and put an empty slice in the category chart. Left out
 * entirely, though, every distance figure on the page silently ignores the one
 * place in the app built for recording distance — which is the same class of
 * bug as upstream's "Distance Traveled 0", just ours.
 *
 * So: normaliseReadings() gives them cost 0 and a category that is deliberately
 * NOT one of CATEGORIES, and callers concat them into the DISTANCE aggregators
 * only. A zero cost means total() and activeCategories() cannot be moved by
 * them even if one leaks. */
export const ODOMETER_SOURCE = '/api/vehicle/odometerrecords/all';

export function normaliseReadings(rows) {
    const out = [];
    let skipped = 0;
    for (const r of rows || []) {
        const date = parseIsoDate(r.date);
        const odometer = Number.parseFloat(r.odometer);
        if (date === null || !Number.isFinite(odometer) || odometer <= 0) {
            skipped++;
            continue;
        }
        out.push({
            category: 'Odometer',   // intentionally not in CATEGORIES
            date,
            cost: 0,
            vehicleId: Number.parseInt(r.vehicleId, 10),
            odometer,
            description: '',
            notes: '',
        });
    }
    return { records: out, skipped };
}

/* With the `culture-invariant` request header LubeLogger serialises cost as a
 * JSON number and date as "yyyy-MM-dd" (Models/API/TypeConverter.cs). Without
 * it both come back locale-formatted, which is unparseable without knowing the
 * server's culture — so metrics.js always sends the header and this parser
 * stays strict rather than guessing at separators.
 *
 * Deliberately strict. A silently-coerced NaN would understate spend, which is
 * worse than a visibly missing record — so bad rows are dropped and counted,
 * and the page reports the count.
 */
export function normalise(category, rows) {
    const out = [];
    const skipped = [];
    for (const r of rows || []) {
        const cost = typeof r.cost === 'number' ? r.cost : Number.parseFloat(r.cost);
        const date = parseIsoDate(r.date);
        if (!Number.isFinite(cost) || date === null) {
            skipped.push(r);
            continue;
        }
        const odometer = Number.parseFloat(r.odometer);
        out.push({
            category,
            date,
            cost,
            vehicleId: Number.parseInt(r.vehicleId, 10),
            odometer: Number.isFinite(odometer) && odometer > 0 ? odometer : null,
            description: r.description || '',
            /* Kept for systemOf() only. The description carries the headline
             * job, but the part number and shop notes are where "coolant" or
             * "thermostat" often actually appear. */
            notes: r.notes || '',
        });
    }
    return { records: out, skipped: skipped.length };
}

/* "yyyy-MM-dd" → Date at local midnight. Deliberately NOT `new Date(s)`: that
 * parses a bare yyyy-MM-dd as UTC, so in any negative-offset timezone every
 * record lands on the previous day and month boundaries drift. */
export function parseIsoDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
    if (!m) return null;
    const [, y, mo, d] = m.map(Number);
    const date = new Date(y, mo - 1, d);
    /* new Date(2026, 1, 31) does not throw — it rolls forward to 3 March. An
     * impossible date would then be silently counted in the WRONG month
     * instead of being skipped, so round-trip the components and reject any
     * that moved. */
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1
        || date.getDate() !== d) {
        return null;
    }
    return date;
}

export const monthKey = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** Inclusive lower bound. A null/0 `vehicleId` skips the vehicle filter — used
 *  by callers that have already scoped their records to one vehicle. */
export function filterRecords(records, { vehicleId = null, since = null } = {}) {
    return records.filter((r) =>
        (!vehicleId || r.vehicleId === vehicleId) &&
        (!since || r.date >= since));
}

/* Every month from the first to the last month that carries SPEND.
 *
 * Interior gaps are kept — a quiet month is real information, and collapsing
 * it would lie about spending rhythm. Leading and trailing empties are not:
 * a zero-cost record (an odometer reading, warranty work) at the far end drags
 * the axis back with a flat line that says nothing. On a car bought
 * second-hand, a handful of such records from the previous owner's years can
 * leave more than half of every time-series plot drawing a line along zero.
 *
 * Falls back to the full record span when nothing carries spend, so a garage
 * of purely zero-cost entries still renders instead of going blank.
 */
/* `endAtLastRecord` extends the TAIL to the last record of any kind, including
 * the zero-cost odometer readings. It moves the end only, never the start, and
 * that asymmetry is deliberate on both halves.
 *
 * The end: cumulativeCostPerDistance needs those months. Its line is supposed
 * to keep moving after the last receipt — the cost is fixed and the miles keep
 * accruing, so a big repair walks back down precisely in the months that have
 * readings and no bills. Stopping at the last spend would cut the recovery off
 * at the moment of the bill and show only the step up.
 *
 * The start: it must NOT move back, and this was measured, not assumed. A
 * second-hand car carries the previous owner's service history as zero-cost
 * records, often going back a decade or more. Spanning from any record
 * stretched such a car's chart across years of somebody else's paperwork and
 * squeezed the part that matters into the right-hand fifth.
 */
export function monthSpan(records, { endAtLastRecord = false } = {}) {
    if (!records.length) return [];
    const withSpend = records.filter((r) => r.cost !== 0);
    const basis = withSpend.length ? withSpend : records;

    let lo = basis[0].date, hi = basis[0].date;
    for (const r of basis) {
        if (r.date < lo) lo = r.date;
        if (r.date > hi) hi = r.date;
    }
    if (endAtLastRecord) {
        for (const r of records) if (r.date > hi) hi = r.date;
    }
    const out = [];
    const cur = new Date(lo.getFullYear(), lo.getMonth(), 1);
    const end = new Date(hi.getFullYear(), hi.getMonth(), 1);
    while (cur <= end) {
        out.push(monthKey(cur));
        cur.setMonth(cur.getMonth() + 1);
    }
    return out;
}

/** → { labels: ['2026-01', …], series: { Fuel: [n, …], … } } */
export function monthlyByCategory(records) {
    const labels = monthSpan(records);
    const index = new Map(labels.map((l, i) => [l, i]));
    const series = Object.fromEntries(
        CATEGORIES.map((c) => [c, new Array(labels.length).fill(0)]));
    for (const r of records) {
        const i = index.get(monthKey(r.date));
        /* Guarded on the category too: odometer readings carry a category that
         * is deliberately not one of CATEGORIES, and if one ever reaches here
         * it should be ignored rather than throw on an undefined series. */
        if (i !== undefined && series[r.category]) series[r.category][i] += r.cost;
    }
    return { labels, series };
}

/** Running total, one point per month (not per record) so the line reads as a
 *  trend rather than a staircase of individual receipts. */
export function cumulativeByMonth(records) {
    const { labels, series } = monthlyByCategory(records);
    let running = 0;
    const values = labels.map((_, i) => {
        for (const c of CATEGORIES) running += series[c][i];
        return round2(running);
    });
    return { labels, values };
}

export function byCategory(records) {
    const totals = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
    for (const r of records) totals[r.category] += r.cost;
    return CATEGORIES.map((c) => ({ category: c, total: round2(totals[c]) }));
}

export const total = (records) =>
    round2(records.reduce((a, r) => a + r.cost, 0));

/** Categories that actually carry spend, in fixed slot order.
 *  A category with nothing in it costs a legend row, a zero-length bar and a
 *  palette slot to say "nothing happened". */
export function activeCategories(records) {
    const seen = new Set(records.filter((r) => r.cost !== 0).map((r) => r.category));
    return CATEGORIES.filter((c) => seen.has(c));
}

/* Calendar months from the earliest record on file to now, inclusive — the
 * denominator for "what does this cost me a month".
 *
 * Deliberately EVERY month since ownership began, not just the months that saw
 * spend. Dividing by active months answers a different and much flatterier
 * question — "when I spend, how much" — and reads as a running cost when it is
 * nothing of the sort: $6,000 spent across 12 active months is $500/mo, where
 * the same money over the 60 months the car has been on the books is $100/mo.
 * The quiet months are the point. A car you did not spend on in March still
 * cost you nothing in March, and averaging that away inflates the figure by
 * however lumpy your maintenance happens to be.
 *
 * Zero-cost records count as evidence of ownership — a warranty job or an
 * odometer entry is still the car being on the books that month.
 *
 * Returns `from` alongside the count so the caller can print the denominator
 * rather than leave the reader to guess what it divided by.
 */
export function ownershipSpan(records, now = new Date(), notBefore = null) {
    if (!records.length) return { months: 0, from: null };
    let from = records[0].date;
    for (const r of records) if (r.date < from) from = r.date;
    /* `notBefore` is the range filter's cutoff. Without it, selecting 12M made
     * the denominator "months since the first record inside the last 12
     * months" while the label still said ownership — so a vehicle with one
     * recent receipt divided a year of spend by one month. The numerator is
     * scoped by the range, so the denominator has to be too; what the range
     * must NOT do is move the ownership start later than it really is. */
    if (notBefore && notBefore > from) from = notBefore;
    const months = (now.getFullYear() - from.getFullYear()) * 12
        + (now.getMonth() - from.getMonth()) + 1;
    /* A record dated in the future would give a zero or negative span; count
     * the month it is in rather than dividing by nothing. */
    return { months: Math.max(1, months), from };
}

/* ── The purchase anchor ────────────────────────────────────────────────
 *
 * When you bought the vehicle, and what its odometer read that day.
 *
 * Without one, every lifetime figure is measured from the OLDEST RECORD ON
 * FILE — which, for a car bought second-hand with its service history, is the
 * previous owner's first receipt. Take one with ten years of those records on
 * file. Measured from them it has been on the books 180 months and "covered"
 * 90,000 miles, so $18,000 of running costs reads $100/month and $0.20/mile.
 * Anchored at its purchase five years ago, the same spend is $300/month over
 * 30,000 miles. These are not two roundings of one number; only one of them
 * is a figure about this owner.
 *
 * Sources, in order:
 *   1. `purchaseDate` — upstream's own field, in the vehicle edit form under
 *      "Purchase/Sold Information", and already what upstream's reports use to
 *      cap ownership (VehicleLogic.GetOwnershipDays). Serialised yyyy-MM-dd
 *      under the culture-invariant header these pages already send.
 *   2. An "Odometer at purchase" extra field on the vehicle, which Road Track
 *      adds to that same panel — see roadtrack-ui.js.
 *
 * THE DATE IS LOAD-BEARING; the mileage is a convenience. Given a date, what
 * the odometer read that day is read off the series — nobody should have to go
 * and look it up. The reverse is not offered: which receipts are yours is a
 * fact about you and not about the data, the nearest available signal ("the
 * first record that carries a cost") is right for some garages and wrong for
 * anyone who logs what a warranty covered, and after an instrument swap a
 * mileage does not identify a date at all. With no date there is no anchor —
 * every figure behaves as it did before and the page says so.
 */
export const PURCHASE_ODOMETER_FIELD = 'Odometer at purchase';

/** A vehicle extra field by name, matched on a trimmed case-insensitive name
 *  because it is a label a person typed into a form. */
export function extraField(vehicle, name) {
    const want = String(name).trim().toLowerCase();
    for (const f of (vehicle && vehicle.extraFields) || []) {
        if (String((f && f.name) || '').trim().toLowerCase() === want) {
            return f.value;
        }
    }
    return null;
}

/** → { date, odometer, dateSet, odometerSet, conflicts } or null when the
 *  vehicle carries no purchase date. `segments` is this vehicle's cleaned
 *  odometer series as returned by odometerSeries().series.get(id). */
export function anchorOf(vehicle, segments = []) {
    const setDate = parseIsoDate((vehicle && vehicle.purchaseDate) || '');
    /* The value arrives as whatever the user typed into a text input — strip
     * thousands separators and a trailing "mi" rather than NaN on them. */
    const typed = Number.parseFloat(
        String(extraField(vehicle, PURCHASE_ODOMETER_FIELD) ?? '')
            .replace(/[^\d.-]/g, ''));
    const setOdometer = Number.isFinite(typed) && typed >= 0 ? typed : null;
    /* A mileage with no date places nothing — see above. */
    if (!setDate) return null;

    const date = setDate;
    const flat = flatSeries(segments);
    const odometer = setOdometer !== null ? setOdometer : odometerAt(flat, date);
    /* Contradiction is judged INSIDE the segment the purchase falls in. Across
     * an instrument swap every later reading is lower by construction, and
     * flagging that would tell the owner their perfectly good figure is wrong. */
    const run = segments.find((r) => r.length && date <= r[r.length - 1].date)
             || segments[segments.length - 1] || [];
    return {
        date,
        odometer: odometer === null ? null : odometer,
        dateSet: !!setDate,
        odometerSet: setOdometer !== null,
        /* A typed reading higher than one recorded AFTER it cannot both be
         * true. The series arbitrates and will discard whichever leaves the
         * shorter consistent run — which is the typed one, since it is a single
         * point against a whole history. Flagged rather than silently ignored:
         * a field the owner filled in and that then changes nothing is a bug
         * report waiting to happen, and the number in it is usually a
         * misremembered one worth correcting. */
        conflicts: setOdometer !== null
            && run.some((r) => r.date > date && r.odometer < setOdometer),
    };
}

/** Everything from the anchor date onward. What is older belongs to whoever
 *  owned the vehicle before you, and is left in the app but out of the maths. */
export function anchored(records, anchor) {
    if (!anchor || !anchor.date) return records;
    return records.filter((r) => r.date >= anchor.date);
}

/* A synthetic odometer reading at the moment of purchase, to be concatenated
 * into the DISTANCE aggregators exactly like a real one.
 *
 * Without it, distance is measured from the first receipt AFTER the purchase,
 * so a car driven 3,000 miles before its first oil change has those 3,000 miles
 * missing from every per-distance figure. Cost 0 and a category outside
 * CATEGORIES, so no money figure can be moved by it. */
export function anchorReading(anchor, vehicleId) {
    if (!anchor || !anchor.date || anchor.odometer === null) return [];
    return [{
        category: 'Odometer',
        date: anchor.date,
        cost: 0,
        vehicleId,
        odometer: anchor.odometer,
        /* Marks this as stated rather than read off a receipt — odometerSeries
         * lets it win its own day. It still has to survive the monotonic pass
         * like everything else. */
        anchor: true,
        description: '',
        notes: '',
    }];
}

/* How badly an unanchored vehicle needs an anchor: the gap between the first
 * record on file and the first one that cost anything.
 *
 * The prompt to set a purchase date is only worth showing when it would move a
 * number. A vehicle whose history starts where its spending starts is already
 * measured correctly and does not need nagging; a second-hand car's years-long
 * lead-in of previous-owner receipts does. Returns 0 when there is nothing to
 * say.
 */
export function unownedLeadMonths(records) {
    const withSpend = records.filter((r) => r.cost !== 0);
    if (!withSpend.length || !records.length) return 0;
    let first = records[0].date, firstPaid = withSpend[0].date;
    for (const r of records) if (r.date < first) first = r.date;
    for (const r of withSpend) if (r.date < firstPaid) firstPaid = r.date;
    return Math.max(0, (firstPaid.getFullYear() - first.getFullYear()) * 12
        + (firstPaid.getMonth() - first.getMonth()));
}

/** The largest individual line items — what the money actually went on. */
export function topExpenses(records, limit = 8) {
    return [...records]
        .sort((a, b) => b.cost - a.cost)
        .slice(0, limit)
        .map((r) => ({
            date: r.date,
            cost: round2(r.cost),
            category: r.category,
            vehicleId: r.vehicleId,
            description: r.description || r.category,
        }));
}

/* Distance covered in the window, from the odometer readings attached to
 * records. Needs two distinct readings for the vehicle to mean anything.
 *
 * Measured across the CLEANED series (odometerSeries), not raw min-to-max: one
 * mis-keyed 70,000 sitting between two readings of 60,000 makes min-to-max
 * report 10,000 miles the car never travelled.
 *
 * Deliberately simple: summing per-vehicle spans, not (max - min) across the
 * fleet — with two vehicles the fleet-wide span is the difference between two
 * unrelated odometers, which is a meaningless number that happens to look
 * plausible. Returns null rather than a wrong figure when it can't be known.
 */
export function distanceCovered(records) {
    let sum = 0;
    for (const segments of odometerSeries(records).series.values()) {
        /* Per SEGMENT. The step across an instrument swap is not travel, and
         * on a reset it is negative — summing across it would subtract the
         * miles the old cluster showed from the ones the new one has counted. */
        for (const series of segments) {
            if (series.length < 2) continue;
            sum += series[series.length - 1].odometer - series[0].odometer;
        }
    }
    return sum > 0 ? sum : null;
}

/** Cost per distance unit, or null when distance is unknown/zero. */
export function costPerDistance(records) {
    const distance = distanceCovered(records);
    if (!distance) return null;
    return total(records) / distance;
}

/* ── Measuring honestly on incomplete data ──────────────────────────────
 *
 * A carefully kept garage has a mileage on every record. Most will not.
 * Somebody who files four receipts a year, two of which have no odometer on
 * them, and never touches the Odometer tab has every figure that divides by
 * distance computed from a window narrower than the spend it is dividing.
 *
 * That does not make the number unavailable. It makes it an estimate, and the
 * job here is to say which it is rather than to print both the same way.
 */

/** What the figures on this page are actually resting on.
 *
 *  Reported rather than acted on: a page that quietly withholds a metric
 *  because coverage is "too low" is a page that looks broken. Print the number
 *  and print what it is based on.
 */
export function coverage(records) {
    const withOdometer = records.filter(
        (r) => r.odometer !== null && r.odometer !== undefined).length;
    const withDescription = records.filter(
        (r) => (r.description || '').trim().length > 0).length;
    const readingMonths = readingSpan(records).length;
    const spendMonths = monthSpan(records).length;
    return {
        records: records.length,
        withOdometer,
        withDescription,
        readingMonths,
        spendMonths,
        /* 1 when the odometer readings span every month that saw spend. Below
         * that, any per-distance figure is dividing a whole history's money by
         * part of its distance — which reads HIGH, not low. */
        distanceCoverage: spendMonths ? Math.min(1, readingMonths / spendMonths) : 0,
    };
}

/* Distance is measured only across months that carry odometer readings, so a
 * vehicle whose readings stop two years before its receipts do has its cost
 * per mile inflated by exactly that gap — silently, and in the direction that
 * makes the car look more expensive than it is.
 *
 * Given at least two months of readings, the months without them are filled at
 * the rate the readings themselves establish. Marked `estimated`, always, and
 * never substituted for the measured figure without the caller saying so.
 *
 * Deliberately simple: one flat rate over the whole span, not a fitted curve.
 * Driving habits do change, but a straight line drawn from real readings is
 * honest about being a straight line; a smarter model would be harder to
 * explain and no more true. Revisit if anyone has enough readings for it to
 * matter.
 */
/* How much the fill has to move the number before it is worth calling an
 * estimate. Almost every history is short a month or two at one end — 178 of
 * 180 months covered, say, which "fills" to a 1.1% larger distance. Marking
 * that as estimated is worse than not marking it: the reader learns the
 * marker means nothing and stops seeing it on the garage where it means a
 * fifth of the mileage.
 *
 * Deliberately a flat 5%. Tune it if a garage lands awkwardly on the line —
 * this is a legibility threshold, not a statistical one. */
export const MIN_ESTIMATE_LIFT = 0.05;

export function estimatedDistance(records, notBefore = null, now = new Date()) {
    const measured = distanceCovered(records);
    const readingMonths = readingSpan(records).length;
    const base = {
        distance: measured, measured, estimated: false,
        readingMonths, months: readingMonths, ratePerMonth: null,
    };
    if (!measured || readingMonths < 2) return base;
    const own = ownershipSpan(records, now, notBefore);
    /* Nothing to fill: the readings already cover the whole span. `<=` and not
     * `<` because equal spans need no estimate either. */
    if (own.months <= readingMonths) return base;
    /* INTERVALS, not months. Readings in January, February and March span two
     * month-to-month gaps, not three -- dividing 2,000 miles by 3 understates
     * the rate by a third, and at the supported minimum of two reading months
     * it HALVES it. The estimate then comes out low, which pushes cost per
     * distance HIGH: the exact error this whole function exists to correct,
     * reintroduced by the correction. An earlier release shipped with exactly
     * that. */
    const ratePerMonth = measured / (readingMonths - 1);
    const distance = Math.round(ratePerMonth * (own.months - 1));
    /* Only when it moves the figure. Judged on the CORRECTION, not on how many
     * months lack a reading: a garage can be missing a third of its months and
     * still have them fall where nothing was driven. */
    if ((distance - measured) / measured < MIN_ESTIMATE_LIFT) return base;
    return {
        distance,
        measured,
        estimated: true,
        readingMonths,
        months: own.months,
        ratePerMonth: Math.round(ratePerMonth),
    };
}

/* How much of the vehicle's own distance has to be on the clock before its
 * running cost per distance is a running cost rather than a division by almost
 * nothing.
 *
 * The bill you pay the week you buy a car lands before you have driven it. A
 * first service two days after the purchase and twelve miles later puts the
 * opening point of this line in the hundreds of dollars a mile. It is
 * arithmetically exact and it is not a measurement of anything: it is one
 * receipt divided by a rounding error. What it does do is set the y-axis for
 * years afterwards, flattening the cents-a-mile figure the line spends its life
 * at into a horizontal smear across the bottom of the plot.
 *
 * An earlier version of this comment argued the early months "damp themselves as
 * the denominator grows rather than needing to be suppressed". They do damp;
 * what they do not do is stop owning the axis, because a maximum is a maximum
 * however briefly it is held.
 *
 * THE THRESHOLD IS ON THE DENOMINATOR, NOT ON THE VALUE, and the difference
 * matters. Capping the value instead — drop any month more than N times the
 * settled figure — bounds the axis perfectly and deletes the thing the chart is
 * FOR: a big repair is supposed to step this line up and then be walked back
 * down by the miles that follow, and early in a history that step legitimately
 * clears any multiple you pick. A tiny denominator is the artefact; a large
 * numerator is the news.
 *
 * Only a PREFIX is ever removed — cumulative distance never shrinks, so the
 * first month over the floor ends the scan and the line can never come back with
 * a hole in it. The count is returned so the card can say how many months it
 * dropped rather than quietly starting late.
 *
 * Deliberately a fraction of the vehicle's own distance, not a fixed mileage.
 * A flat "1,000 miles" is wrong for a car driven 3,000 a year and wrong again
 * for anything logged in kilometres or engine hours. Tune the fraction if a
 * garage lands awkwardly — it is a legibility threshold, not a statistical one.
 */
export const CPD_WARMUP = 0.05;

/* Lifetime cost per distance unit as it stood at the end of each month:
 * everything spent up to that point over every mile driven up to that point.
 *
 * This replaced a 12-month trailing window in an earlier release. The window
 * answered "what did the last year cost per mile", which sounds like the more
 * current figure and in practice was mostly unanswerable: it needed enough
 * odometer movement INSIDE each window to divide by, so any window that fell
 * under the floor reported null and the line broke. That left a chart with
 * holes in it, and a chart with holes reads as broken data rather than as
 * a measurement declining to be made.
 *
 * Cumulative cannot gap. The numerator and the denominator both only grow, so
 * once there are two readings to span, every later month has a value —
 * including months with no records at all, which is the point: a quiet month
 * still lowers your running cost, because you drove and spent nothing.
 *
 * It reads differently and it reads better. A big repair steps the line UP,
 * and the months after it slope DOWN as the miles accumulate against a fixed
 * cost. So the shape answers "is this car getting more expensive to run, or
 * cheaper" — which is the question — rather than "what did an arbitrary
 * 12-month box cost".
 *
 * The opening months are suppressed rather than plotted — see CPD_WARMUP.
 *
 * `paidByLabel` folds the money spent BUYING the vehicle into the numerator: a
 * function from a "yyyy-MM" key to everything paid on the purchase and its
 * finance by the end of that month. Passed as a function rather than an array
 * because the caller cannot know the labels until this has picked them.
 */
export function cumulativeCostPerDistance(records, { paidByLabel = null } = {}) {
    const labels = monthSpan(records, { endAtLastRecord: true });
    const rows = labels.map((label) => {
        const [y, m] = label.split('-').map(Number);
        const end = new Date(y, m, 1);                       // exclusive
        const sofar = records.filter((r) => r.date < end);
        const distance = distanceCovered(sofar);
        /* Null only until two readings exist to span. Cumulative distance
         * never shrinks, so this cannot re-null once it has a value. */
        if (!distance) return { distance: 0, value: null };
        const bought = paidByLabel ? (paidByLabel(label) || 0) : 0;
        return { distance, value: round2((total(sofar) + bought) / distance) };
    });

    const covered = rows.length ? rows[rows.length - 1].distance : 0;
    const floor = covered * CPD_WARMUP;
    let start = rows.length;
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].value !== null && rows[i].distance >= floor) {
            start = i;
            break;
        }
    }
    /* Counts EVERY month left off the front, not just the ones the warm-up
     * floor rejected. The months before there were two readings to divide by
     * are dropped for the same reason and are just as absent from the axis, so
     * a note that counted only one kind would undercount what the reader can
     * see is missing. */
    const opening = start;
    /* The LABELS go with them, not just the values. Blanking the values alone
     * leaves the axis spanning months the line does not reach, so on a history
     * with a long unmeasured opening the plot is half empty and the line is
     * squeezed into the right of it — which is the same legibility problem the
     * trim exists to fix, arrived at from the other direction. The note says
     * how many months are missing; the axis does not have to hold space for
     * them. */
    return {
        labels: labels.slice(start),
        values: rows.slice(start).map((r) => r.value),
        opening,
    };
}

/* The trailing `months` calendar months ending with the month `now` falls in.
 *
 * The sparkline sits inside the "Last 12 months" tile, so it has to cover that
 * window and no other. Taking the last 12 entries of monthlyTotals() instead
 * takes the last 12 months OF THE RECORD SPAN, which ends at the newest record
 * — so a vehicle with nothing spent recently showed $0.00 on the tile beside a
 * sparkline of activity from years earlier, implying the two were the same
 * period. Months with no spend are 0 here, not gaps: this window is fully
 * observed, and a zero month genuinely means nothing was spent.
 */
export function trailingMonthlyTotals(records, months = 12, now = new Date()) {
    const labels = [];
    const cur = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
    for (let i = 0; i < months; i++) {
        labels.push(monthKey(cur));
        cur.setMonth(cur.getMonth() + 1);
    }
    const index = new Map(labels.map((l, i) => [l, i]));
    const values = new Array(months).fill(0);
    for (const r of records) {
        const i = index.get(monthKey(r.date));
        if (i !== undefined) values[i] += r.cost;
    }
    return { labels, values: values.map(round2) };
}

/** Spend per month as a flat series — the stat-tile sparkline. */
export function monthlyTotals(records) {
    const { labels, series } = monthlyByCategory(records);
    return {
        labels,
        values: labels.map((_, i) =>
            round2(CATEGORIES.reduce((a, c) => a + series[c][i], 0))),
    };
}

/* Trailing-window comparison for the stat-tile delta: the N days ending now
 * against the N days before that. Returns null when there is no prior window
 * to compare against — an unqualified "+100%" against no history is noise. */
export function trend(records, days, now = new Date()) {
    const msPerDay = 86400000;
    const start = new Date(now.getTime() - days * msPerDay);
    const prevStart = new Date(now.getTime() - 2 * days * msPerDay);
    const current = total(records.filter((r) => r.date >= start && r.date <= now));
    const prior = total(records.filter((r) => r.date >= prevStart && r.date < start));
    if (!prior) return { current, prior: 0, changePct: null };
    return { current, prior, changePct: ((current - prior) / prior) * 100 };
}

/** → { labels: ['2021', …], series: { Fuel: [n, …], … } }
 *
 *  Upstream's vehicle dashboard plots "expenses by month" as twelve calendar
 *  months with every year summed into them, so a car with a 2022 tyre bill and
 *  a 2026 tyre bill reports one enormous July. Years are the axis that answers
 *  "is this getting worse"; month-of-year answers nothing. */
export function yearlyByCategory(records) {
    const withSpend = records.filter((r) => r.cost !== 0);
    const basis = withSpend.length ? withSpend : records;
    if (!basis.length) return { labels: [], series: {} };

    let lo = basis[0].date.getFullYear(), hi = lo;
    for (const r of basis) {
        const y = r.date.getFullYear();
        if (y < lo) lo = y;
        if (y > hi) hi = y;
    }
    const labels = [];
    for (let y = lo; y <= hi; y++) labels.push(String(y));

    const index = new Map(labels.map((l, i) => [l, i]));
    const series = Object.fromEntries(
        CATEGORIES.map((c) => [c, new Array(labels.length).fill(0)]));
    for (const r of records) {
        const i = index.get(String(r.date.getFullYear()));
        if (i !== undefined) series[r.category][i] += r.cost;
    }
    for (const c of CATEGORIES) series[c] = series[c].map(round2);
    return { labels, series };
}

/* ── Vehicle systems ────────────────────────────────────────────────────
 *
 * What actually broke, rather than which LubeLogger tab the receipt was filed
 * under. "Service $5,000 / Repairs $7,000" says nothing a bill doesn't; "the
 * cooling system has cost $3,000 across five visits" is the sentence that
 * changes what you do next.
 *
 * Matching is EARLIEST MENTION WINS, not a fixed priority order. Invoice lines
 * lead with the headline job and trail with the extras bundled onto it —
 * "Oil service, spark plugs, cabin filter, tyre rotate" is an oil service, and
 * "Coolant hose and expansion tank cap; oil service" is a cooling job. A fixed
 * priority list gets one of those two wrong whichever way it is ordered.
 * Ties at the same offset go to the LONGEST match, so "rear wheel hubs" is
 * drivetrain rather than wheels.
 *
 * Deliberately simple: single-label, keyword, first-mention. It is a reading of
 * free text, not a parts taxonomy — bundled invoices are attributed whole to
 * their headline system, and bySystem() reports how many records mentioned
 * more than one so the number is never quoted as if it were exact. The upgrade
 * path is a dedicated per-record system field (LubeLogger extraFields) and a
 * backfill.
 */
export const SYSTEMS = [
    ['Cooling',            /coolant|radiator|water pump|thermostat|expansion tank|heater hose|cooling fan/gi],
    ['Oil & filters',      /oil service|oil change|oil filter|oil pan|oil cooler|oil &? ?filter|engine oil|drain plug/gi],
    ['Brakes',             /brake|rotor|caliper|brake pad/gi],
    ['Tyres & wheels',     /tyre|tire|wheel alignment|wheel balance|wheels? refinish|\bwheels\b|\brim\b|tpms/gi],
    ['Suspension',         /suspension|shock absorber|coilover|control arm|sway bar|tie rod|ball joint|bushing|wheel hub|strut assembly|motor mount/gi],
    ['Steering',           /steering|power steering|steering rack/gi],
    ['Drivetrain',         /transmission|gearbox|\bcvt\b|clutch|differential|\bdiff\b|driveshaft|cv axle|axle shaft|transfer case|shift assembly/gi],
    ['Engine',             /spark plug|ignition coil|valve cover|timing chain|turbo|intercooler|intake|walnut blast|carbon clean|belt|tensioner|pulley|boost|misfire|air filter|engine mount|manifold/gi],
    ['Fuel system',        /fuel pump|fuel injector|fuel filter|fuel filler|injector|fuel system/gi],
    ['Electrical',         /battery|alternator|starter|headlight|tail lamp|turn signal|\bbulb\b|\bxenon\b|wiring|\bfuse\b|high-beam|fog light|light assembly/gi],
    ['Climate',            /\ba\/c\b|air conditioning|refrigerant|heater core|blower|cabin filter|\bvent\b|air flap|air quality sensor/gi],
    ['Body & glass',       /windshield|windscreen|glass|bumper|body panel|paint|collision|\bdoor\b|mirror|wiper|washer pump|trunk|lift gate|sunroof|sun roof|trim/gi],
    ['Interior & tech',    /audio|speaker|amplifier|stereo|infotainment|cup holder|\bseat\b|carpet|charger|navigation/gi],
    ['Inspection & admin', /inspection|registration|emissions|smog|service check|shop supplies|shop service charge|diagnos/gi],
];

/** The system a single record's text belongs to, or null when nothing matches. */
export function systemOf(record) {
    const text = `${record.description || ''} ${record.notes || ''}`;
    let best = null;
    for (const [name, pattern] of SYSTEMS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(text)) !== null) {
            if (!best || m.index < best.at
                || (m.index === best.at && m[0].length > best.len)) {
                best = { name, at: m.index, len: m[0].length };
            }
            /* A zero-length match would spin forever; none of the patterns can
             * produce one, but exec-in-a-loop is not a place to assume that. */
            if (m.index === pattern.lastIndex) pattern.lastIndex++;
        }
    }
    return best ? best.name : null;
}

/** How many distinct systems a record's text mentions — the honesty counter
 *  behind "N records covered more than one system". */
export function systemsMentioned(record) {
    const text = `${record.description || ''} ${record.notes || ''}`;
    let n = 0;
    for (const [, pattern] of SYSTEMS) {
        pattern.lastIndex = 0;
        if (pattern.test(text)) n++;
    }
    return n;
}

/** → [{ system, total, count }] descending by spend. Records matching nothing
 *  land in "Other" rather than being dropped, so the parts sum to the whole. */
export function bySystem(records) {
    const buckets = new Map();
    let mixed = 0;
    for (const r of records) {
        if (r.cost === 0) continue;
        const name = systemOf(r) || 'Other';
        if (systemsMentioned(r) > 1) mixed++;
        const b = buckets.get(name) || { system: name, total: 0, count: 0 };
        b.total += r.cost;
        b.count += 1;
        buckets.set(name, b);
    }
    const rows = [...buckets.values()]
        .map((b) => ({ ...b, total: round2(b.total) }))
        .sort((a, b) => b.total - a.total);
    return { rows, mixed };
}

/* ── Usage ──────────────────────────────────────────────────────────────
 *
 * Distance covered per month, read out of the odometer numbers attached to
 * records. Upstream's dashboard plots a "distance travelled" axis derived from
 * fuel records only, so a vehicle with no fill-ups logged — common in a garage
 * that logs servicing but not fuel — gets a second y-axis pinned at 0 to 1
 * with a flat line on it.
 *
 * Readings are sparse and irregular, so a reading-to-reading delta is spread
 * across the months it spans PRO-RATA BY DAYS rather than dumped on the month
 * the later reading happens to fall in. Months no interval covers are null (a
 * gap), never 0 — "we don't know" and "the car didn't move" are different
 * claims and only one of them is supportable.
 */
export function usageByMonth(records) {
    /* Spanned by the READINGS, not by monthSpan().
     *
     * monthSpan() prefers records carrying non-zero spend, which is right for
     * every money chart on the page and wrong for this one: a vehicle tracked
     * mainly through the Odometer tab, with one paid record in the middle of a
     * long mileage history, would get a one-month span and no fully covered
     * month in it — so the chart hid itself while the KPI beside it happily
     * reported thousands of miles. Distance is spanned by where the odometer
     * readings are. */
    const labels = readingSpan(records);
    if (!labels.length) return { labels, values: [] };
    const index = new Map(labels.map((l, i) => [l, i]));
    const size = labels.length;
    const totals = new Array(size).fill(0);
    const anyFull = new Array(size).fill(false);

    for (const readings of allSegments(records)) {
        const miles = new Array(size).fill(0);
        const covered = new Array(size).fill(0);

        for (let i = 1; i < readings.length; i++) {
            const from = readings[i - 1], to = readings[i];
            const delta = to.odometer - from.odometer;
            const days = dayIndex(to.date) - dayIndex(from.date);
            /* A NEGATIVE delta is an odometer correction or a duplicate
             * batch-entered line, not travel — skip it. A delta of exactly
             * zero is different: two readings on different days showing the
             * same mileage is a measurement, and what it measures is a car
             * that did not move. Dropping it too would draw a gap over a month
             * we know the answer for. Same-day pairs have no span to
             * distribute across and would divide by zero. */
            if (delta < 0 || days <= 0) continue;
            const perDay = delta / days;

            /* Walk the calendar months the interval touches, crediting each
             * with the days of it that fall inside that month. */
            let cursor = new Date(from.date);
            while (cursor < to.date) {
                const monthEnd = new Date(
                    cursor.getFullYear(), cursor.getMonth() + 1, 1);
                const segEnd = monthEnd < to.date ? monthEnd : to.date;
                const segDays = dayIndex(segEnd) - dayIndex(cursor);
                const i2 = index.get(monthKey(cursor));
                if (i2 !== undefined) {
                    miles[i2] += perDay * segDays;
                    covered[i2] += segDays;
                }
                cursor = segEnd;
            }
        }

        /* Only months the readings cover END TO END are reported.
         *
         * The first and last month of any history are partial by construction:
         * the earliest reading lands mid-month, so that month is credited with
         * however many days happen to follow it. Plotted, that is a cliff at
         * both ends of the line — a car that "barely moved" in the month it was
         * bought and again in the month you are looking at it. Both are
         * artefacts of where the readings stop, not of how the car was driven.
         */
        for (let i = 0; i < size; i++) {
            if (covered[i] >= daysInMonth(labels[i])) {
                totals[i] += miles[i];
                anyFull[i] = true;
            }
        }
    }
    return {
        labels,
        values: labels.map((_, i) => (anyFull[i] ? round2(totals[i]) : null)),
    };
}

/* Above this many months, "Distance driven" is plotted by year instead.
 *
 * Six years of monthly points in the 300px a phone gives a chart is a spike
 * field, not a line — individual months land under two pixels wide and the
 * only thing legible is the noise. Years answer the question the monthly line
 * was being asked (is this being driven more or less) at a density a screen
 * can show. Short histories stay monthly, where the months are still
 * distinguishable.
 *
 * Deliberately one threshold, no toggle. The monthly figures are all still in
 * the "All figures" table, which is where someone who wants them will look. */
export const MAX_USAGE_MONTHS = 36;

/* usageByMonth() regrouped into calendar years.
 *
 * `partial` marks a year the readings do not cover end to end. It matters
 * because the total is a SUM of the measurable months: a year with three
 * uncovered months reports low, and reads as a quiet year rather than an
 * incompletely recorded one. The first and last year of any history are
 * partial by construction, so the flag is a caption, not a warning.
 */
export function usageByYear(records) {
    const { labels, values } = usageByMonth(records);
    const years = new Map();
    labels.forEach((label, i) => {
        const year = label.slice(0, 4);
        const row = years.get(year) || { total: 0, measured: 0, spanned: 0 };
        row.spanned += 1;
        if (values[i] !== null) {
            row.total += values[i];
            row.measured += 1;
        }
        years.set(year, row);
    });
    const out = [...years.keys()];
    return {
        labels: out,
        values: out.map((y) => (years.get(y).measured ? round2(years.get(y).total) : null)),
        partial: out.map((y) => years.get(y).measured < years.get(y).spanned),
    };
}

/* Every month from the first to the last record that carries an odometer
 * reading. Zero-cost rows count here — an odometer record IS the data. */
export function readingSpan(records) {
    const dated = records.filter((r) => r.odometer !== null && r.odometer !== undefined);
    if (!dated.length) return [];
    let lo = dated[0].date, hi = dated[0].date;
    for (const r of dated) {
        if (r.date < lo) lo = r.date;
        if (r.date > hi) hi = r.date;
    }
    const out = [];
    const cur = new Date(lo.getFullYear(), lo.getMonth(), 1);
    const end = new Date(hi.getFullYear(), hi.getMonth(), 1);
    while (cur <= end) {
        out.push(monthKey(cur));
        cur.setMonth(cur.getMonth() + 1);
    }
    return out;
}

/** Days in the calendar month a "yyyy-MM" key names. */
function daysInMonth(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m, 0).getDate();
}

/* Whole days since the epoch, counted off the calendar rather than off the
 * clock. `(a - b) / 86400000` is fifteen characters shorter and wrong twice a
 * year: a span crossing a DST boundary is 89.958 days, not 90, so the same
 * records would split across months differently for a reader in New York than
 * for one in London. These dates are already local midnights — only their
 * Y/M/D matters. */
const dayIndex = (d) =>
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;

/* ── Reading the odometer off a pile of receipts ────────────────────────
 *
 * One sorted, cleaned odometer series per vehicle. Two passes, because real
 * receipts are wrong in two different ways.
 *
 * PER DAY, TAKE THE MEDIAN. A batch-entered invoice repeats a date across many
 * lines and the mileage is re-keyed on each one. Four records on one day can
 * read 50,000, 50,000, 51,500 and 60,000. Taking the highest — which this
 * did — picks the one that is wrong by ten thousand miles; the median is
 * unmoved by a single wild entry in either direction.
 *
 * THEN KEEP THE LONGEST NON-DECREASING RUN. An odometer does not go backwards,
 * so a day that contradicts the days around it holds a typo — but which day is
 * the typo is not decidable one pair at a time. A running-maximum filter
 * answers it the wrong way round: one spuriously HIGH reading swallows every
 * honest reading after it until the car catches up, which is exactly what the
 * 60,000 above did to the months that followed it. Keeping the longest
 * non-decreasing subsequence drops the FEWEST days needed to make the series
 * consistent, so the outlier goes and the twenty good readings stay.
 *
 * `dropped` is returned rather than swallowed: a distance chart quietly
 * computed from 46 of 50 readings should say so, and renderUsage() prints it.
 *
 * Deliberately simple: median per day, then one non-decreasing run. It is a
 * cleanup, not a sensor-fusion model — the upgrade path, if a day's readings
 * ever disagree by more than re-keying noise, is a per-day candidate DP that
 * picks the value from each day that best fits its neighbours instead of the
 * median.
 */
export function odometerSeries(records) {
    const perVehicle = new Map();
    for (const r of records) {
        if (r.odometer === null || r.odometer === undefined) continue;
        if (!perVehicle.has(r.vehicleId)) perVehicle.set(r.vehicleId, new Map());
        const byDay = perVehicle.get(r.vehicleId);
        const key = r.date.getTime();
        if (!byDay.has(key)) byDay.set(key, { date: r.date, values: [] });
        /* A reading the owner typed into the vehicle form outranks whatever a
         * receipt from the same day happens to say. Without this, a service
         * record dated the day of purchase out-voted the figure entered as
         * the odometer at purchase and the field did nothing. */
        if (r.anchor) byDay.get(key).stated = r.odometer;
        else byDay.get(key).values.push(r.odometer);
    }
    const out = new Map();
    let dropped = 0;
    for (const [id, byDay] of perVehicle) {
        const days = [...byDay.values()]
            .sort((a, b) => a.date - b.date)
            .map((d) => ({
                date: d.date,
                odometer: d.stated !== undefined ? d.stated : median(d.values),
            }));
        const segments = [];
        for (const run of splitAtResets(days)) {
            const keep = longestNonDecreasing(run.map((d) => d.odometer));
            dropped += run.length - keep.length;
            if (keep.length) segments.push(keep.map((i) => run[i]));
        }
        out.set(id, segments);
    }
    return { series: out, dropped };
}

/* Split a day series where the odometer legitimately STARTS OVER.
 *
 * An instrument swap or a rollover is not a typo, and the difference matters:
 * cleaning the whole history down to one non-decreasing run throws away
 * whichever side of the reset has fewer readings. A fresh cluster fitted last
 * month loses every mile driven since; an old one loses the years before it.
 * Both are silent, and the surviving side still looks perfectly plausible.
 *
 * A drop only counts as a reset if BOTH hold:
 *
 *   1. The odometer never gets back to the level it fell from. A mis-keyed high
 *      reading is passed by the actual mileage soon enough — a stray 70,000
 *      among readings near 60,000 is overtaken after a year or so of
 *      driving — so the drop after it is noise.
 *   2. Removing the single reading it fell from would NOT restore order. That
 *      is what a lone typo is: one point sticking up between two that agree
 *      with each other. A reset is a whole history continuing from a new base,
 *      so deleting one reading cannot reconcile it.
 *
 * Test 1 alone is not enough — a typo near the end of a history is never
 * overtaken, because there is nothing after it left to overtake it with.
 *
 * Deliberately simple: two rules, no rollover arithmetic, and a drop in the
 * FIRST pair is always read as a typo because there is no earlier reading to
 * judge it against. A swap on a vehicle that then covers the whole old reading
 * again reads as a typo — that needs a second lifetime on the clock, and
 * upstream's answer for a permanently offset odometer is the vehicle's
 * OdometerDifference field, not this.
 */
function splitAtResets(days) {
    const runs = [];
    let start = 0;
    for (let i = 1; i < days.length; i++) {
        const fell = days[i - 1].odometer;
        if (days[i].odometer >= fell) continue;
        if (days.slice(i).some((d) => d.odometer >= fell)) continue;   // (1)
        if (i - 1 <= start || days[i].odometer >= days[i - 2].odometer) continue;  // (2)
        runs.push(days.slice(start, i));
        start = i;
    }
    runs.push(days.slice(start));
    return runs.filter((r) => r.length);
}

/** Every cleaned reading for one vehicle in date order, across resets. Callers
 *  that only need "what did it read around then" want this; callers measuring
 *  DISTANCE must stay inside a segment, because the step across a reset is not
 *  travel. */
export const flatSeries = (segments) => (segments || []).flat();

/* The LOWER median — s[(n-1)/2] rather than the mean of the middle pair.
 *
 * Every value this returns is a reading that was actually recorded. The true
 * median of two readings is their midpoint, which is a number the odometer
 * never showed, and this series is not only arithmetic: its last entry is
 * printed as "Odometer now". Robustness against one wild entry is unchanged in
 * either direction; all that is given up is a half-mile of accuracy on an
 * even-sized day. */
function median(values) {
    const s = [...values].sort((a, b) => a - b);
    return s[(s.length - 1) >> 1];
}

/* Indices of a longest non-decreasing subsequence, by patience sorting.
 * `tail[k]` holds the index of the smallest value that can end a run of length
 * k+1, and `prev` threads each element back to its predecessor so the run can
 * be walked out at the end. O(n log n) — the binary search is what makes it
 * that rather than O(n²), which would also be fine at this size but is not
 * shorter to write. */
function longestNonDecreasing(values) {
    const tail = [];
    const prev = new Array(values.length).fill(-1);
    for (let i = 0; i < values.length; i++) {
        let lo = 0, hi = tail.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (values[tail[mid]] <= values[i]) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0) prev[i] = tail[lo - 1];
        tail[lo] = i;
    }
    const out = [];
    for (let i = tail.length ? tail[tail.length - 1] : -1; i >= 0; i = prev[i]) {
        out.push(i);
    }
    return out.reverse();
}

/* Every monotonic segment across every vehicle, flat. usageByMonth measures
 * distance INSIDE a segment and must never see two of them joined, whether the
 * join is a reset on one vehicle or the gap between two different cars. */
function allSegments(records) {
    const out = [];
    for (const segments of odometerSeries(records).series.values()) {
        out.push(...segments);
    }
    return out;
}

/* Where the odometer stood on an arbitrary date, read off the cleaned series.
 *
 * This is the gap-filler. Readings land wherever a receipt happened to land, so
 * asking "what did it read the day I bought it" almost never hits one — the
 * answer is a straight-line read between the readings either side.
 *
 * Outside the series it CLAMPS rather than extrapolating. Running the line back
 * past the first reading implies the car left the factory at whatever mileage
 * the trend says, which for a sparse early history is routinely negative.
 */
export function odometerAt(series, date) {
    if (!series || !series.length || !date) return null;
    if (date <= series[0].date) return series[0].odometer;
    const last = series[series.length - 1];
    if (date >= last.date) return last.odometer;
    for (let i = 1; i < series.length; i++) {
        const a = series[i - 1], b = series[i];
        if (date <= b.date) {
            /* An exact hit is a reading, not a gap. Checked before the reset
             * guard below, or a purchase dated on the day the new cluster went
             * in would be answered with the old cluster's final mileage. */
            if (date.getTime() === b.date.getTime()) return b.odometer;
            /* Never interpolate down across a reset — between the last reading
             * on an old cluster and the first on a new one there is no line to
             * read, so the honest answer is the reading before. */
            if (b.odometer < a.odometer) return a.odometer;
            const span = dayIndex(b.date) - dayIndex(a.date);
            if (span <= 0) return b.odometer;
            const t = (dayIndex(date) - dayIndex(a.date)) / span;
            return Math.round(a.odometer + t * (b.odometer - a.odometer));
        }
    }
    return last.odometer;
}

/* The current odometer, or null when nothing carries one.
 *
 * The most recently DATED cleaned reading — not the highest, and not the end of
 * the longest run. The label on this figure is "Odometer now", and after an
 * instrument swap the current reading is the low one on the new cluster; taking
 * the end of the longest run would report the old cluster's final mileage
 * indefinitely. Typos are already gone by this point, which is the whole reason
 * this can go back to reading the newest reading and trusting it. */
export function latestOdometer(records) {
    let best = null;
    for (const segments of odometerSeries(records).series.values()) {
        for (const r of flatSeries(segments)) {
            if (best === null || r.date > best.date) best = r;
        }
    }
    return best ? best.odometer : null;
}

/* ── Buying the car ─────────────────────────────────────────────────────
 *
 * Everything above this line measures what a vehicle has cost to RUN. The
 * largest cheque most people write for a car is the one that bought it, and
 * until now it appeared nowhere: "cost per mile" meant cost per mile of
 * servicing, which is a real figure and is not what the phrase sounds like.
 *
 * WHERE THE NUMBERS LIVE. `purchasePrice`, `soldPrice`, `purchaseDate` and
 * `soldDate` are upstream's own vehicle fields, already on the edit form under
 * "Purchase/Sold Information". The loan terms are LubeLogger EXTRA FIELDS —
 * the same mechanism "Odometer at purchase" uses, persisted by upstream's own
 * save path with nothing forked and nothing patched (see roadtrack-ui.js).
 *
 * WHY APR AND A TERM rather than the monthly payment. Both parameterise the
 * same loan, and the payment is the number people remember — but it is the
 * ROUNDED one. Rebuilding a schedule from it means solving for the rate and
 * then reporting an interest total that disagrees with the lender's by a few
 * dollars, on a page whose whole claim is that its figures are checkable. APR
 * and term are on the loan agreement, and from them the payment, the split and
 * the payoff date are derived exactly.
 *
 * NOTHING HERE IS ON BY DEFAULT. Two requirements pull against each other: the
 * purchase price must stay out of cost of ownership unless asked for, and it
 * must be available and toggleable. Both hold: the dashboard opens on running
 * costs exactly as it did, and the toggle folds these figures in. A vehicle
 * with no purchase price on it behaves as though this section does not exist.
 */

export const LOAN_FIELDS = {
    down: 'Down payment',
    apr: 'Loan APR',
    term: 'Loan term (months)',
};

export const VALUATION_FIELD = 'Estimated values';

/** A number out of a box somebody typed into. Strips currency symbols,
 *  thousands separators and trailing units ("4.9%", "$2,000", "72 months"). */
export function typedNumber(value) {
    const n = Number.parseFloat(String(value ?? '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
}

/** Whole calendar months from a Date to a "yyyy-MM" key. Negative before it. */
function monthsFrom(from, label) {
    const [y, m] = label.split('-').map(Number);
    return (y - from.getFullYear()) * 12 + (m - 1 - from.getMonth());
}

/* The amortisation schedule of a level-payment loan: one row per instalment,
 * each carrying how much of it was interest and how much came off the balance.
 *
 * The LAST instalment settles whatever is left rather than repeating the level
 * payment. Interest is rounded to cents every month, as a lender's is, and the
 * few cents of drift that leaves would otherwise end the schedule owing $0.03 —
 * which is wrong in the one place anybody checks it.
 *
 * A 0% loan is not a special case worth a branch elsewhere: the payment formula
 * divides by zero at r = 0, so it is handled here and only here.
 */
export function amortise(principal, annualRatePct, months) {
    if (!(principal > 0) || !(months > 0)) return [];
    const r = (annualRatePct || 0) / 100 / 12;
    const payment = r > 0
        ? principal * r / (1 - Math.pow(1 + r, -months))
        : principal / months;
    const rows = [];
    let balance = principal;
    for (let i = 0; i < months; i++) {
        const interest = round2(balance * r);
        let paidOff = round2(payment - interest);
        if (i === months - 1 || paidOff > balance) paidOff = balance;
        balance = round2(balance - paidOff);
        rows.push({
            interest,
            principal: round2(paidOff),
            payment: round2(paidOff + interest),
            balance,
        });
        /* A rate high enough that the level payment never covers the interest
         * would run forever adding nothing. Stop rather than emit a schedule
         * whose balance is not falling. */
        if (balance <= 0) break;
    }
    return rows;
}

/** → what the car cost to buy, or null when no price and no deposit is on file.
 *
 *  `start` may be null: a price with no Purchased Date still totals correctly,
 *  it just cannot be placed on a timeline. Callers that plot check for it. */
export function loanOf(vehicle) {
    if (!vehicle) return null;
    const price = Math.max(typedNumber(vehicle.purchasePrice) || 0, 0);
    const down = Math.max(typedNumber(extraField(vehicle, LOAN_FIELDS.down)) || 0, 0);
    if (!(price > 0) && !(down > 0)) return null;

    const apr = Math.max(typedNumber(extraField(vehicle, LOAN_FIELDS.apr)) || 0, 0);
    const term = Math.max(
        Math.round(typedNumber(extraField(vehicle, LOAN_FIELDS.term)) || 0), 0);
    /* NO TERM MEANS NOTHING IS FINANCED. Deriving `financed` from the price
     * alone made a cash purchase claim the whole price was on a loan that has
     * no schedule to repay it — so everything paid came out as the deposit,
     * which on a car bought outright is zero. A $20,000 cash car reported $0
     * paid, on both the chart and the toggle. The check that was supposed to
     * cover it asserted totalCost and never once asked what had been PAID. */
    const financed = term ? round2(Math.max(0, price - down)) : 0;
    const schedule = amortise(financed, apr, term);
    const interest = round2(schedule.reduce((a, row) => a + row.interest, 0));
    const start = parseIsoDate(vehicle.purchaseDate || '');

    /* Everything handed over on the day, whatever the paperwork calls it: the
     * deposit on a financed car, the whole price on a cash one. Taking the
     * larger of the two also covers a vehicle carrying a deposit and no price,
     * which is a half-filled form rather than a free car. */
    const upfront = round2(Math.max(price - financed, down));

    /* The first instalment falls the month AFTER signing, which is what a
     * lender's schedule does and what makes the payoff land exactly `term`
     * months out. Putting it in the purchase month would report every loan as
     * paid off a month early. */
    const payoff = start && schedule.length
        ? new Date(start.getFullYear(), start.getMonth() + schedule.length, 1)
        : null;

    return {
        price, down, apr, term, financed, interest, start, payoff, schedule,
        upfront,
        payment: schedule.length ? schedule[0].payment : 0,
        /* What it ends up costing, defined as what you actually hand over:
         * the money up front plus every instalment. On a financed car that is
         * exactly price + interest; on a cash one it is the price; and on a
         * half-filled form carrying a deposit and no price it is the deposit,
         * where `price + interest` would have said $0. */
        totalCost: round2(upfront + schedule.reduce((a, row) => a + row.payment, 0)),
        financedFully: schedule.length > 0,
    };
}

/** Everything paid on the purchase and its finance by the end of each month.
 *  Null before the vehicle was bought — there was nothing to pay. */
export function paidByMonth(loan, labels) {
    if (!loan || !loan.start) return labels.map(() => null);
    const cum = [0];
    for (const row of loan.schedule) cum.push(round2(cum[cum.length - 1] + row.payment));
    return labels.map((label) => {
        const k = monthsFrom(loan.start, label);
        if (k < 0) return null;
        return round2(loan.upfront + cum[Math.min(k, cum.length - 1)]);
    });
}

/** The same figure at one arbitrary date, for the stat tiles. 0 before the
 *  purchase, so it can be added to a total unconditionally. */
export function paidAt(loan, date = new Date()) {
    if (!loan || !date) return 0;
    return paidByMonth(loan, [monthKey(date)])[0] || 0;
}

/* ── What it is actually worth ──────────────────────────────────────────
 *
 * A depreciation line needs valuations, and there is no honest way to conjure
 * them: a "typical" 15%/year curve drawn beside real spending is an assumption
 * wearing a measurement's clothes, and the one number it is anchored to (the
 * purchase price) is the only part of it that was ever true.
 *
 * So they are typed in, into one extra field, as `2023-06 = 12000, 2026-01 =
 * 10000`. Sparse on purpose — a car is worth looking up once a year, and the
 * two ends of the line come free: the purchase price is the first point and the
 * sold price, when there is one, is the last. One entry is enough to draw a
 * line, because the purchase already supplies the other end.
 *
 * Deliberately simple: straight lines between the points, and flat after the
 * last one. A fitted decay curve would look more like how cars actually
 * depreciate and would be inventing the shape between two real numbers. The
 * line is only ever as good as what is in the box, and drawing it plainly says
 * so.
 */
/* $ £ € ¥ ₹, then optional space, before an amount. */
const CURRENCY = '(?:[$\\u00a3\\u20ac\\u00a5\\u20b9]\\s*)?';
const BARE_AMOUNT = new RegExp('^\\s*' + CURRENCY + '\\d[\\d.,\\s\\u00a0\\u202f]*$');

export function valuationsOf(vehicle) {
    if (!vehicle) return [];
    const out = [];
    const bought = parseIsoDate(vehicle.purchaseDate || '');
    const price = typedNumber(vehicle.purchasePrice) || 0;
    if (bought && price > 0) out.push({ date: bought, value: price, source: 'bought' });

    /* SCANNED, not split on a separator. The obvious `split(/[,;\n]/)` cuts
     * "2023-06 = 12,500" in half at its own thousands separator and files the
     * "500" as a second valuation dated today — which is both wrong and
     * plausible enough to go unnoticed. Matching whole entries instead means
     * whatever sits between them, comma or not, is simply skipped, and so is
     * any prose typed around them. */
    const text = String(extraField(vehicle, VALUATION_FIELD) ?? '');
    /* The amount may carry a currency sign, and its thousands may be grouped
     * with spaces (or the no-break spaces a phone keyboard inserts), as people
     * write money. A space group is exactly three digits and must not run into
     * a digit, so "12 000 2026-01 = 10000" stops before the next entry's year
     * instead of reading it as more of the amount. */
    const entry = new RegExp(
        '(\\d{4})(?:-(\\d{1,2}))?(?:-(\\d{1,2}))?\\s*[=:]\\s*' + CURRENCY
        + '(\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3}(?!\\d))+(?:\\.\\d+)?|[\\d.,]+)', 'g');
    let m;
    let dated = 0;
    while ((m = entry.exec(text)) !== null) {
        dated++;
        const pad = (s, d) => String(s === undefined ? d : Number(s)).padStart(2, '0');
        const date = parseIsoDate(`${m[1]}-${pad(m[2], 1)}-${pad(m[3], 1)}`);
        const value = typedNumber(m[4]);
        /* A year outside living memory is a transposed figure, not a
         * valuation — and one of them would stretch the chart's axis to the
         * year 9000 and make every real point a single pixel. */
        if (!date || value === null || value < 0
            || date.getFullYear() < 1900 || date.getFullYear() > 2200) {
            continue;
        }
        out.push({ date, value: round2(value), source: 'stated' });
    }
    /* A bare number with no date at all is "what it is worth now" — the shape
     * somebody types the first time, before they think of it as a series.
     * Only a box that IS one number, though: read as a whole, an entry that
     * failed to parse ("2024-06 = abc") would come out as the date's own
     * digits, 2024, dated today. */
    const bare = dated || !BARE_AMOUNT.test(text) ? null : typedNumber(text);
    if (bare !== null && bare >= 0) {
        out.push({ date: new Date(), value: round2(bare), source: 'stated' });
    }

    const sold = typedNumber(vehicle.soldPrice) || 0;
    const soldOn = parseIsoDate(vehicle.soldDate || '');
    if (soldOn && sold > 0) out.push({ date: soldOn, value: sold, source: 'sold' });

    /* One value per day, last written wins — so a re-typed figure corrects the
     * old one rather than drawing a vertical step on the same day. */
    const byDay = new Map();
    for (const p of out) byDay.set(p.date.getTime(), p);
    return [...byDay.values()].sort((a, b) => a.date - b.date);
}

/* ── How fast THIS car loses money ──────────────────────────────────────
 *
 * "A car depreciates" is not one curve. Over five years a Porsche 911 loses
 * 11% and a BMW 7 Series loses 62%; one average drawn for both is wrong by a
 * factor of five on the number the chart exists to show. So the shape comes
 * from a study of what actually sold, keyed by model where the study names
 * one and by make otherwise.
 *
 * Figures are 5-YEAR VALUE RETENTION (1 - depreciation) from the iSeeCars
 * 2026 study of ~950,000 five-year-old cars sold Mar 2025 - Feb 2026, whose
 * fleet average retention is 0.582.
 *   https://www.iseecars.com/cars-that-hold-their-value-study
 *
 * Deliberately a hand-refreshed table, not a scraper and not an API. Every
 * vehicle-valuation API costs money and needs a key, and this layer is a
 * COPY-only image over upstream with nowhere server-side to keep one. The
 * study is republished annually; re-read it then. A year-stale table is far
 * closer than no table, and the line it draws is marked estimated anyway.
 */
export const FLEET_RETENTION_5Y = 0.582;
export const EV_RETENTION_5Y = 0.428;      // the study's EV segment: 57.2% off

/* The models the study names — the outliers, where a make-level figure is
 * most wrong. Matched as a PREFIX of "make model" so a trim ("RAV4 Hybrid",
 * "4Runner TRD Pro") lands on its model instead of falling through to the
 * make, longest key first — which is also what keeps a Mustang Mach-E off
 * the Mustang's number, a difference of 34 points. */
const MODEL_RETENTION_5Y = {
    'porsche 718': 0.904,             'porsche 911': 0.889,
    'chevrolet corvette': 0.813,      'toyota tacoma': 0.801,
    'toyota tundra': 0.788,           'honda civic': 0.771,
    'subaru brz': 0.763,              'toyota gr supra': 0.760,
    'toyota supra': 0.760,            'toyota rav4': 0.748,
    'toyota corolla hatchback': 0.745, 'toyota 4runner': 0.745,
    'lexus rc': 0.734,                'ford mustang': 0.732,
    'toyota corolla': 0.724,          'toyota sienna': 0.715,
    'honda hr-v': 0.712,              'honda cr-v': 0.711,
    'subaru crosstrek': 0.709,        'subaru impreza': 0.708,
    'subaru wrx': 0.702,              'toyota corolla hybrid': 0.699,
    'ford ranger': 0.698,             'honda accord': 0.695,
    'mazda mx-5': 0.685,              'toyota prius': 0.679,
    'ford expedition': 0.437,         'lincoln navigator': 0.437,
    'jaguar f-pace': 0.435,           'hyundai kona electric': 0.435,
    'audi a7': 0.435,                 'cadillac escalade': 0.430,
    'nissan armada': 0.430,           'bmw x5': 0.429,
    'audi q7': 0.428,                 'kia niro ev': 0.427,
    'audi a8': 0.424,                 'tesla model y': 0.422,
    'land rover discovery': 0.421,    'audi q5': 0.418,
    'infiniti qx60': 0.417,           'land rover range rover sport': 0.417,
    'bmw 5 series': 0.405,            'ford mustang mach-e': 0.392,
    'tesla model x': 0.388,           'bmw 7 series': 0.384,
    'land rover range rover': 0.383,  'tesla model s': 0.380,
    'volkswagen id.4': 0.379,         'infiniti qx80': 0.372,
    'nissan leaf': 0.369,
};

/* Everything else, by make. These are NOT a published per-make statistic —
 * the study ranks models, not brands — so they are a tier placed against the
 * models it does name and its 0.582 fleet average. Read them as one
 * significant figure: they carry "German luxury falls twice as fast as a
 * Toyota", which is the thing worth being right about, and nothing finer. */
const MAKE_RETENTION_5Y = {
    porsche: 0.75, toyota: 0.70, kubota: 0.70, 'john deere': 0.70,
    subaru: 0.69, honda: 0.69, lexus: 0.66, ram: 0.66, gmc: 0.65,
    jeep: 0.65, mazda: 0.62, acura: 0.60, chevrolet: 0.59, ford: 0.58,
    dodge: 0.58, kia: 0.57, hyundai: 0.57, nissan: 0.55, mitsubishi: 0.55,
    buick: 0.54, volkswagen: 0.53, chrysler: 0.52, mini: 0.52,
    genesis: 0.48, volvo: 0.47, cadillac: 0.46, fiat: 0.45, lincoln: 0.45,
    bmw: 0.45, 'mercedes-benz': 0.45, mercedes: 0.45, audi: 0.44,
    infiniti: 0.42, tesla: 0.41, jaguar: 0.41, 'land rover': 0.40,
    rivian: 0.40, polestar: 0.38, 'alfa romeo': 0.38, lucid: 0.35,
    maserati: 0.32,
};

const MODEL_KEYS = Object.keys(MODEL_RETENTION_5Y)
    .sort((a, b) => b.length - a.length);

/* Cars do not fall to zero — they level off at what a running example is
 * worth to somebody, which is why a 20-year-old Civic is not free. A bare
 * exponential says it is, and says it loudest exactly where older cars sit.
 * This is the calibration knob: raise it if the tail reads low. */
export const RESIDUAL_FLOOR = 0.10;

/** Retention at `age` years, as a fraction of what the car was worth new. */
function retentionAt(k, age) {
    return RESIDUAL_FLOOR
        + (1 - RESIDUAL_FLOOR) * Math.exp(-k * Math.max(0, age));
}

/* ── Measured curves, for a few common models ───────────────────────────
 *
 * A rate fitted to one five-year number gets the shape roughly right and the
 * middle wrong. Real depreciation is not smooth: a 3 Series holds 37.5% at
 * eight years and 27.8% at nine — a cliff as the last CPO warranties lapse
 * that no exponential through a single point can produce.
 *
 * So for a few common models, the year-by-year residual is stored as
 * measured and interpolated, and the fitted exponential above is only the
 * fallback for everything else. Residual is a percentage of the car's price
 * when new; we only ever use RATIOS between two ages, so the MSRP cancels and
 * none of these need to know what the car originally cost.
 *
 * Source: CarEdge per-model depreciation tables, read 2026-08-10, which assume
 * 13,500 miles/year and good condition.
 *
 * Deliberately few: a handful of models, hand-entered. Add a table when a
 * model the fallback would otherwise have to guess at matters enough to
 * measure, and re-read these when the source is republished.
 */
const CURVE_3SERIES = { 1: 60.4, 2: 58.9, 3: 57.5, 4: 52.9, 5: 47.4, 6: 43.8,
                        7: 40.5, 8: 37.5, 9: 27.8, 10: 25.7, 11: 23.8, 12: 22.0 };
const CURVE_X3 = { 1: 62.8, 2: 61.3, 3: 60.8, 4: 50.7, 5: 45.9, 6: 39.5,
                   7: 35.8, 8: 31.1, 9: 28.6, 10: 26.4 };
const CURVE_FORESTER = { 1: 82.8, 2: 81.3, 3: 76.3, 4: 66.2, 5: 64.7, 6: 62.8,
                         7: 52.8, 8: 48.3, 9: 41.7, 10: 38.6, 11: 35.7, 12: 33.0 };
const CURVE_CRV = { 1: 80.4, 2: 78.4, 3: 76.6, 4: 71.8, 5: 71.0, 6: 66.4,
                    7: 58.2, 8: 54.6, 9: 50.0, 10: 46.3, 11: 42.8, 12: 39.6 };

/* Keyed by what people actually TYPE — "330i", not "3 Series" — because
 * nobody enters their car as its platform. Prefix-matched like the table
 * above, so "X3" followed by any trim finds the X3 curve. */
const MODEL_CURVES = {
    'bmw 3 series': CURVE_3SERIES, 'bmw 335i': CURVE_3SERIES,
    'bmw 328i': CURVE_3SERIES, 'bmw 330i': CURVE_3SERIES,
    'bmw x3': CURVE_X3,
    'subaru forester': CURVE_FORESTER,
    'honda cr-v': CURVE_CRV, 'honda crv': CURVE_CRV,
};
const CURVE_KEYS = Object.keys(MODEL_CURVES).sort((a, b) => b.length - a.length);

/** Residual at any age, from a measured table: straight-line between the
 *  years it lists, 100% at age zero, and past its last year the annual rate
 *  its own final pair implies — decayed toward the floor, never to nothing.
 *  An older car can run off the end of these tables. */
function residualFromTable(table, age) {
    const ages = Object.keys(table).map(Number).sort((a, b) => a - b);
    const a = Math.max(0, age);
    const first = ages[0], last = ages[ages.length - 1];
    if (a <= 0) return 1;
    if (a < first) return 1 + (a / first) * (table[first] / 100 - 1);
    if (a >= last) {
        const prev = ages[ages.length - 2];
        const perYear = prev === undefined ? 0.93
            : (table[last] / table[prev]) ** (1 / (last - prev));
        const out = (table[last] / 100) * perYear ** (a - last);
        return Math.max(RESIDUAL_FLOOR, out);
    }
    let i = 1;
    while (ages[i] < a) i++;
    const lo = ages[i - 1], hi = ages[i];
    const t = (a - lo) / (hi - lo);
    return (table[lo] + t * (table[hi] - table[lo])) / 100;
}

/** Retention at `age`, whichever kind of curve this vehicle got. */
function retentionOf(curve, age) {
    return curve.table
        ? residualFromTable(curve.table, age)
        : retentionAt(curve.k, age);
}

/** The decay constant landing exactly on the study's 5-year figure. */
function decayFor(retain5) {
    const r = Math.min(Math.max(retain5, RESIDUAL_FLOOR + 0.01), 0.999);
    return -Math.log((r - RESIDUAL_FLOOR) / (1 - RESIDUAL_FLOOR)) / 5;
}

/** The curve for one vehicle, or null when there is no model year to age it
 *  against. `retain5` is carried so the UI can say where the shape came
 *  from rather than presenting it as arithmetic. */
export function depreciationCurve(vehicle) {
    if (!vehicle) return null;
    const year = Number(vehicle.year);
    if (!Number.isFinite(year) || year < 1900 || year > 2200) return null;

    const make = String(vehicle.make || '').trim().toLowerCase()
        .replace(/\s+/g, ' ');
    const model = String(vehicle.model || '').trim().toLowerCase()
        .replace(/\s+/g, ' ');
    if (!make) return null;

    const full = `${make} ${model}`.trim();
    const matches = (k) => full === k || full.startsWith(`${k} `);

    /* A measured year-by-year table beats anything fitted, so it wins outright
     * and skips the rate lookup entirely. */
    const curveKey = CURVE_KEYS.find(matches);
    if (curveKey) {
        const table = MODEL_CURVES[curveKey];
        /* Its own five-year figure, read off the table rather than stored
         * beside it, so the caption can never drift from the curve it
         * describes. */
        return { year, basis: 'measured', table,
                 retain5: residualFromTable(table, 5) };
    }

    const key = MODEL_KEYS.find(matches);

    /* An unlisted EV follows the EV segment, not its badge. The study puts
     * every EV at 57.2% over five years and the spread between brands is
     * small beside that — a Kona Electric loses a third more than a Kona.
     * Upstream already knows which it is, so this costs nothing. Named models
     * still win: the study measured those individually. */
    const retain5 = key ? MODEL_RETENTION_5Y[key]
        : (vehicle.isElectric ? EV_RETENTION_5Y
            : (MAKE_RETENTION_5Y[make] ?? FLEET_RETENTION_5Y));

    /* WHICH row answered, so the page can say so in the vehicle's own words
     * rather than echoing a lookup key — and so it never claims a model-level
     * measurement it got from the make. */
    const basis = key ? 'model'
        : (vehicle.isElectric ? 'ev'
            : (MAKE_RETENTION_5Y[make] ? 'make' : 'fleet'));
    return { year, retain5, k: decayFor(retain5), basis };
}

/* Age in years at `date`, from the model year. Month-resolution, because the
 * chart steps a month at a time and a whole-year age would draw the value as
 * a staircase. */
function ageAt(curve, date) {
    return (date.getFullYear() - curve.year) + (date.getMonth() / 12);
}

/** Straight-line between valuations; null before the first, because what it
 *  was worth before you owned it is not this chart.
 *
 *  AFTER the last real point, with a curve, it follows that curve — as a
 *  RATIO against the last real point, never as an absolute. That is what lets
 *  a study measured from MSRP price a car nobody bought new: the MSRP cancels,
 *  and all that is used is the shape between two ages. It also means the line
 *  passes exactly through every figure actually typed in, so one real number
 *  from a valuation site re-anchors the whole tail. Without a curve it holds
 *  flat, which is the old behaviour and still the honest one. */
export function valueAt(points, date, curve = null) {
    if (!points || !points.length || !date) return null;
    const first = points[0];
    if (date < first.date) {
        /* BEFORE the first figure, the curve runs backwards — but only when
         * that figure is not the purchase. What a car was worth before you
         * owned it is not this chart, so a purchase anchor still ends the line
         * exactly where it always did.
         *
         * This is what lets a car with NO purchase price chart at all — and
         * plenty of cars have none on file. Without running the curve
         * backwards a single typed "worth this now" is one dot, not a line —
         * so the whole feature would need four figures per car instead of one.
         * Age zero is the hard stop: nothing was worth anything before it was
         * built. */
        if (!curve || first.source === 'bought') return null;
        const to = retentionOf(curve, ageAt(curve, date));
        const from = retentionOf(curve, ageAt(curve, first.date));
        if (!(from > 0) || ageAt(curve, date) < 0) return null;
        return Math.round((first.value * to / from) / 10) * 10;
    }
    const last = points[points.length - 1];
    if (date >= last.date) {
        if (!curve) return last.value;
        /* Never model over a real number.
         *
         * A SALE is a transaction, not an estimate — what somebody actually
         * paid on the day is the last word on what the car was worth, and
         * depreciating past it rewrites a settled fact.
         *
         * And ON the last point the ratio is 1, so the arithmetic is a no-op —
         * but the rounding below is not, and it would hand back $7,230 for a
         * figure typed as $7,234. Both would quietly break the promise this
         * curve is built on: it passes exactly through what you entered. */
        if (last.source === 'sold' || date.getTime() === last.date.getTime()) {
            return last.value;
        }
        const from = retentionOf(curve, ageAt(curve, last.date));
        if (!(from > 0)) return last.value;
        /* To the nearest ten, because this is an estimate and "$6,543.21"
         * claims a precision it does not have — a modelled figure that reads
         * to the cent invites exactly the trust it has not earned. Ten and not
         * fifty: a car this age moves about $45 a month, and rounding coarser
         * than that turns a smooth line into a staircase. */
        const raw = last.value * retentionOf(curve, ageAt(curve, date)) / from;
        return Math.round(raw / 10) * 10;
    }
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        if (date <= b.date) {
            const span = dayIndex(b.date) - dayIndex(a.date);
            if (span <= 0) return b.value;
            const t = (dayIndex(date) - dayIndex(a.date)) / span;
            return round2(a.value + t * (b.value - a.value));
        }
    }
    return last.value;
}

/** Value at the END of each month — the same instant the money lines are
 *  cumulative to, so the two are comparable point for point. */
export function valueByMonth(points, labels, curve = null) {
    return labels.map((label) => {
        const [y, m] = label.split('-').map(Number);
        return valueAt(points, new Date(y, m, 0), curve);  // day 0 = last of month
    });
}

/* Money rounded at the aggregate boundary. Float drift is invisible on one
 * receipt and shows up as a stray cent once you sum a few hundred. */
export function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
}
