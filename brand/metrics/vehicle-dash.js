/* Road Track — per-vehicle dashboard.
 *
 * Replaces the body of LubeLogger's own Dashboard tab (#report-tab-pane). The
 * swap happens in roadtrack-ui.js by redefining the global getVehicleReport;
 * this module is the renderer and knows nothing about how it got called.
 *
 * WHY REPLACE IT AT ALL. Upstream's version is not merely plain, it reports
 * things that are not true for a garage without fuel records:
 *   · "Distance Traveled 0"  — derived from gas records only, so a vehicle with
 *     30,000 miles of odometer readings and no fill-ups logged reads zero.
 *   · "0 mpg Average Fuel Economy" — a measurement presented as a value when
 *     there is nothing to measure.
 *   · "Expenses by Month" is month-of-YEAR: every July on record summed into
 *     one bar, on a chart whose second axis is a dead 0–1 distance scale.
 *   · Two of the five panels say "No data found".
 *
 * This is the only metrics surface. There was a standalone Metrics page
 * beside it until an earlier release, running the same aggregate.js against
 * a second shell; it was a strict subset of this and was deleted. The engine
 * still lives next door — aggregate.js for the money maths, chart-kit.js for
 * the palette and Chart.js baseline, metrics.css for both.
 */

import {
    SOURCES, ODOMETER_SOURCE, normalise, normaliseReadings, filterRecords,
    monthlyByCategory, cumulativeByMonth,
    yearlyByCategory, byCategory, total, activeCategories, ownershipSpan, monthKey,
    costPerDistance, distanceCovered, latestOdometer, usageByMonth,
    usageByYear, MAX_USAGE_MONTHS, coverage, estimatedDistance, topExpenses,
    cumulativeCostPerDistance, trailingMonthlyTotals, trend, bySystem,
    anchorOf, anchored, anchorReading, odometerSeries, unownedLeadMonths,
    PURCHASE_ODOMETER_FIELD,
    loanOf, paidByMonth, paidAt, valuationsOf, valueByMonth, depreciationCurve,
    round2,
} from './aggregate.js?v=__RT_VERSION__';
import {
    applyChartDefaults, fmt, money, moneyPrecise, distanceNumber,
    monthLabel, vehicleLabel, api, AuthError, loadFormatting, tokens, distanceUnits,
    seriesColour, swatch, swatchFor, wash, withScope, baseOptions, horizontalBarOptions,
    endLabelPlugin, barValueLabelPlugin, lineDataset, chartDrawer,
} from './chart-kit.js?v=__RT_VERSION__';

const RANGES = [
    { months: 12, label: '12M' },
    { months: 24, label: '24M' },
    { months: 60, label: '5Y' },
    { months: 0, label: 'All' },
];

const MODES = [
    { mode: 'cumulative', label: 'Cumulative' },
    { mode: 'monthly', label: 'By month' },
    { mode: 'yearly', label: 'By year' },
    { mode: 'category', label: 'By category' },
];

/* Static shell only — every value in it is written later with textContent.
 * Nothing user-supplied is ever interpolated into markup (a description is
 * free text, and an <img onerror> typed into one is not a hypothetical). */
const TEMPLATE = `
<div class="rt-filters">
    <span class="rt-vdash-name" id="rtv-name"></span>
    <div class="rt-spacer"></div>
    <!-- Off by default, and deliberately: every figure on this page has meant
         "what it costs to run" from the start, and flipping that silently would
         reprice years of history for anyone who opens the tab. -->
    <div class="rt-range" id="rtv-buy-wrap" hidden>
        <button type="button" id="rtv-buy" aria-pressed="false">
            Include purchase &amp; finance
        </button>
    </div>
    <div class="rt-range" id="rtv-range" role="group" aria-label="Time range"></div>
</div>

<div id="rtv-body" class="rt-refreshes" hidden>
    <section class="rt-kpis" aria-label="Headline figures">
        <div class="rt-tile rt-hero">
            <span class="rt-tile-label">Total spend</span>
            <span class="rt-tile-value" id="rtv-total">—</span>
            <span class="rt-tile-sub" id="rtv-total-sub"></span>
        </div>
        <div class="rt-tile">
            <span class="rt-tile-label">Last 12 months</span>
            <span class="rt-tile-value" id="rtv-year">—</span>
            <span class="rt-tile-sub" id="rtv-year-sub"></span>
            <div class="rt-spark"><canvas id="rtv-spark" aria-hidden="true"></canvas></div>
        </div>
        <div class="rt-tile">
            <span class="rt-tile-label">Cost per month</span>
            <span class="rt-tile-value" id="rtv-monthly">—</span>
            <span class="rt-tile-sub" id="rtv-monthly-sub"></span>
        </div>
        <div class="rt-tile">
            <span class="rt-tile-label" id="rtv-permile-label">Cost per mile</span>
            <span class="rt-tile-value" id="rtv-permile">—</span>
            <span class="rt-tile-sub" id="rtv-permile-sub"></span>
        </div>
        <div class="rt-tile">
            <span class="rt-tile-label" id="rtv-distance-label">Distance covered</span>
            <span class="rt-tile-value" id="rtv-distance">—</span>
            <span class="rt-tile-sub" id="rtv-distance-sub"></span>
        </div>
    </section>

    <section class="rt-card" id="rtv-card-main">
        <div class="rt-card-head">
            <h3 class="rt-card-title" id="rtv-main-title">Cumulative spend</h3>
            <span class="rt-card-note" id="rtv-main-note"></span>
            <div class="rt-range" id="rtv-mode" role="group" aria-label="Chart mode"></div>
        </div>
        <div class="rt-plot rt-plot-tall"><canvas id="rtv-chart-main"></canvas></div>
        <div class="rt-legend" id="rtv-legend" hidden></div>
    </section>

    <div class="rt-grid">
        <section class="rt-card" id="rtv-card-usage">
            <div class="rt-card-head">
                <h3 class="rt-card-title" id="rtv-usage-title">Distance driven</h3>
                <span class="rt-card-note" id="rtv-usage-note"></span>
            </div>
            <div class="rt-plot"><canvas id="rtv-chart-usage"></canvas></div>
        </section>

        <section class="rt-card" id="rtv-card-permile">
            <div class="rt-card-head">
                <h3 class="rt-card-title" id="rtv-permile-title">Running cost per mile</h3>
                <span class="rt-card-note" id="rtv-permile-note"></span>
            </div>
            <div class="rt-plot"><canvas id="rtv-chart-permile"></canvas></div>
        </section>
    </div>

    <section class="rt-card" id="rtv-card-system">
        <div class="rt-card-head">
            <h3 class="rt-card-title">Spend by system</h3>
            <span class="rt-card-note" id="rtv-system-note"></span>
        </div>
        <div class="rt-plot" id="rtv-system-plot"><canvas id="rtv-chart-system"></canvas></div>
        <p class="rt-note" id="rtv-system-caveat"></p>
    </section>

    <!-- Spend by system says WHICH PART ate the money; this says WHICH JOBS
         did. A ranked list rather than a chart: eight rows of date, thing,
         amount are read faster than eight bars, and the description is the
         part that changes a decision.

         Ported from the standalone Metrics page, which was otherwise a strict
         SUBSET of this dashboard -- every other card and tile on it already
         existed here. This was the one thing it had. -->
    <section class="rt-card" id="rtv-card-top">
        <div class="rt-card-head">
            <h3 class="rt-card-title">Biggest expenses</h3>
            <span class="rt-card-note" id="rtv-top-note"></span>
        </div>
        <ol class="rt-top" id="rtv-top"></ol>
    </section>

    <section class="rt-card" id="rtv-card-table">
        <div class="rt-card-head">
            <h3 class="rt-card-title">All figures</h3>
            <span class="rt-card-note">Every value in the charts above, as text</span>
            <div class="rt-range ms-auto">
                <button type="button" id="rtv-table-toggle" aria-expanded="false"
                        aria-controls="rtv-table-wrap">Show table</button>
            </div>
        </div>
        <div class="rt-table-wrap" id="rtv-table-wrap" hidden></div>
    </section>

    <div class="rt-vdash-tools" id="rtv-tools"></div>
    <p class="rt-note" id="rtv-footnote"></p>
</div>

<div class="rt-empty" id="rtv-state">Loading…</div>
`;

export default async function renderVehicleDashboard(pane, vehicleId) {
    applyChartDefaults();

    const root = document.createElement('div');
    root.className = 'rt-metrics rt-vdash';
    root.innerHTML = TEMPLATE;
    pane.replaceChildren(root);

    const $ = (id) => root.querySelector(`#${id}`);
    const draw = chartDrawer();
    const state = {
        records: [],
        readings: [],       // odometer-only rows — distance aggregators ONLY
        vehicle: null,
        anchor: null,       // when it was bought and at what mileage — see aggregate.js
        excluded: 0,        // records dated before the anchor, i.e. not this owner's
        skipped: 0,
        months: 0,
        mode: 'cumulative',
        hidden: new Set(),
        loan: null,         // what it cost to buy — null when no price is on file
        valuations: [],     // what it has been worth since
        curve: null,        // how fast this make and model loses money
        includePurchase: false,
    };

    /* LubeLogger's dark-mode toggle restamps [data-bs-theme] on <html> without
     * a reload, and every colour in these charts was read out of CSS at draw
     * time. Re-render so they follow rather than staying inverted. */
    const themeWatch = new MutationObserver(() => render());

    /* Upstream's own tab teardown empties this pane when you leave the tab
     * ($("#report-tab-pane").html("") in vehicle.js). Chart.js and the theme
     * observer both hold references that outlive the DOM, so tear them down
     * with it rather than leaking one set per visit to the tab. */
    let disposed = false;
    const onCssLoaded = () => render();
    const teardown = new MutationObserver(() => {
        if (!pane.contains(root)) {
            disposed = true;
            draw.destroyAll();
            themeWatch.disconnect();
            teardown.disconnect();
            document.removeEventListener('rt-metrics-css-loaded', onCssLoaded);
        }
    });
    teardown.observe(pane, { childList: true });

    buildRange();
    buildModes();
    buildPurchaseToggle();

    try {
        await load();
    } catch (e) {
        if (disposed) return;
        $('rtv-state').textContent = e instanceof AuthError
            ? 'Your session has expired — reload the page to sign in again.'
            : 'Could not load this vehicle’s records.';
        return;
    }

    /* Leaving the tab while load() is in flight tears the root out of the pane
     * and destroys the charts — but this function is still parked on that await
     * and would happily render into the detached DOM afterwards, creating a
     * fresh set of charts nothing will ever destroy. It would also push this
     * vehicle's unit into the shared `fmt` after the fact. Check the flag at
     * every await boundary, not just this one. */
    if (disposed) return;

    applyDistanceUnit();
    $('rtv-body').hidden = false;
    $('rtv-state').hidden = true;
    render();
    loadTools();

    /* ── Data ───────────────────────────────────────────────────────── */

    async function load() {
        await loadFormatting();
        const [vehicles, odometer, ...sets] = await Promise.all([
            api('/api/vehicles'),
            api(ODOMETER_SOURCE).catch(() => []),
            ...SOURCES.map((s) => api(s.path)),
        ]);
        state.vehicle = (Array.isArray(vehicles) ? vehicles : [])
            .find((v) => Number(v.id) === vehicleId) || null;
        /* Every /all endpoint returns the whole garage regardless of a
         * vehicleId query param, so the scoping is ours to do — and it happens
         * on the RAW rows, before normalise(). Filtering afterwards scoped the
         * records but not the skipped count, so an unreadable record on another
         * vehicle was reported in this vehicle's footnote. */
        const mine = (rows) => (rows || [])
            .filter((r) => Number.parseInt(r.vehicleId, 10) === vehicleId);
        sets.forEach((rows, i) => {
            const { records, skipped } = normalise(SOURCES[i].category, mine(rows));
            state.records.push(...records);
            state.skipped += skipped;
        });
        state.readings = normaliseReadings(mine(odometer)).records;
        /* The anchor is read off the CLEANED series, and against the whole
         * history — so inferring "what did the odometer read the day I bought
         * it" can see the readings either side of that day even when the ones
         * before it are about to be filtered out by the anchor itself. */
        const series = odometerSeries(state.records.concat(state.readings))
            .series.get(vehicleId) || [];
        state.anchor = anchorOf(state.vehicle, series);
        state.excluded = state.records.length
            - anchored(state.records, state.anchor).length;
        state.loan = loanOf(state.vehicle);
        state.valuations = valuationsOf(state.vehicle);
        state.curve = depreciationCurve(state.vehicle);
        /* No price on file, nothing to fold in — the button would be a control
         * that does nothing, which is worse than no control. */
        $('rtv-buy-wrap').hidden = !state.loan;
        $('rtv-name').textContent = vehicleLabel(state.vehicle) || '';
    }

    /* Everything paid on the car itself — deposit plus instalments — inside the
     * window the range buttons have selected.
     *
     * SCOPED TO THE RANGE, like the numerator it joins. With "12M" selected the
     * spend total covers twelve months, so the finance figure beside it has to
     * be the twelve months of instalments, not the whole loan to date. Charging
     * a six-year-old deposit against one year of running costs would report a
     * cost per month several times the truth. */
    function purchaseInRange(until = new Date()) {
        if (!state.includePurchase || !state.loan) return 0;
        return round2(paidAt(state.loan, until) - paidBefore());
    }

    /* Everything paid BEFORE the range opens — the base the range subtracts.
     *
     * The month before it, not the month it starts in. paidAt() answers "by the
     * END of this month", so basing on the range's own first month subtracted
     * that month's instalment out of the window that is supposed to contain it:
     * a 12-month view reported eleven payments.
     */
    function paidBefore() {
        const from = since();
        if (!from || !state.loan) return 0;
        return paidAt(state.loan,
            new Date(from.getFullYear(), from.getMonth() - 1, 1));
    }

    /* The same as a function of a month key, for the cumulative charts. */
    function paidUpTo(labels) {
        if (!state.loan) return labels.map(() => null);
        const base = paidBefore();
        return paidByMonth(state.loan, labels)
            .map((v) => (v === null ? null : round2(Math.max(0, v - base))));
    }

    /* Every spend record that is this owner's, whole history, unfiltered by the
     * range buttons. The tiles that compare against a fixed window read this. */
    function owned() {
        return anchored(state.records, state.anchor);
    }

    /* The same, plus the odometer-only readings and the synthetic reading at
     * the purchase itself — the denominator side of every distance figure. */
    function ownedMeasured() {
        return owned().concat(
            anchored(state.readings, state.anchor),
            anchorReading(state.anchor, vehicleId));
    }

    /* LubeLogger tracks some vehicles in engine hours rather than distance.
     * Reading the flag off this one vehicle is exact — the Metrics page has to
     * cope with a mixed selection and suppresses the figure instead. */
    function applyDistanceUnit() {
        /* Distance units are a server-side per-user setting. The standalone
         * Metrics page cannot read it and has to be handed ?units= by the nav
         * link; this dashboard runs INSIDE the app, so it reads the same config
         * upstream does. Without this every metric user was shown "Cost per
         * mile" over numbers computed from kilometres. (`useMPG` is upstream's
         * name for the flag; it governs distance, and distance is now the
         * only thing on this page that has a unit.) */
        try {
            const cfg = window.getGlobalConfig ? window.getGlobalConfig() : null;
            if (cfg && cfg.useMPG === false) fmt.baseDistance = 'km';
        } catch (e) {
            /* getGlobalConfig is defined inline in _Layout; if upstream moves
               it, fall through to the mile defaults rather than break. */
        }
        fmt.distance = (state.vehicle && state.vehicle.useHours)
            ? 'hour' : fmt.baseDistance;
    }

    function since() {
        if (!state.months) return null;
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth() - state.months + 1, 1);
    }

    function slice() {
        return filterRecords(owned(), { since: since() });
    }

    /* Spend records PLUS the odometer-only readings, for the aggregators that
     * measure distance. Readings carry cost 0, so every money figure computed
     * over this set is identical to the one computed over slice() alone —
     * covered by a check in tools/test_metrics.mjs. */
    function sliceWithReadings() {
        return filterRecords(ownedMeasured(), { since: since() });
    }

    /* A declaration, not a const arrow: render() runs during boot, above where
     * this sits in the file, and a const would still be in its temporal dead
     * zone at that point. */
    function chartCategories(records) {
        return activeCategories(records).filter((c) => !state.hidden.has(c));
    }

    /* ── Controls ───────────────────────────────────────────────────── */

    function buildRange() {
        const box = $('rtv-range');
        for (const r of RANGES) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = r.label;
            b.setAttribute('aria-pressed', String(r.months === state.months));
            b.addEventListener('click', () => {
                state.months = r.months;
                for (const other of box.children) {
                    other.setAttribute('aria-pressed', String(other === b));
                }
                render();
            });
            box.append(b);
        }
    }

    /* One switch, every figure. The tiles, the main chart and the running cost
     * per distance all read state.includePurchase rather than each offering
     * their own control — a page where "total" means one thing in a tile and
     * another in the chart beside it is worse than one that never offered the
     * option. */
    function buildPurchaseToggle() {
        const b = $('rtv-buy');
        b.addEventListener('click', () => {
            state.includePurchase = !state.includePurchase;
            b.setAttribute('aria-pressed', String(state.includePurchase));
            b.textContent = state.includePurchase
                ? 'Running costs only' : 'Include purchase & finance';
            render();
        });
    }

    function buildModes() {
        const box = $('rtv-mode');
        for (const m of MODES) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = m.label;
            b.setAttribute('aria-pressed', String(m.mode === state.mode));
            b.addEventListener('click', () => {
                state.mode = m.mode;
                for (const other of box.children) {
                    other.setAttribute('aria-pressed', String(other === b));
                }
                render();
            });
            box.append(b);
        }
    }

    /* ── Render ─────────────────────────────────────────────────────── */

    function render() {
        if (disposed) return;
        const t = tokens(root);
        const records = slice();
        const measured = sliceWithReadings();
        /* With nothing in range there is nothing to plot, and an empty 380px
         * plot with a $0-to-$1 axis is exactly the "No data found" panel this
         * dashboard exists to get rid of. The tiles and the footnote already
         * say so in words. */
        const empty = records.length === 0;
        $('rtv-card-main').hidden = empty;
        $('rtv-card-table').hidden = empty;
        /* Computed ONCE and handed to both the tile and the footnote. They used
         * to work it out separately, over different record sets, and disagreed
         * with each other on screen — see renderFootnote. Sharing the object is
         * the fix: there is no longer a second answer to drift from the first. */
        const est = estimatedDistance(measured, since());
        renderKpis(records, measured, est, t);
        /* Distance does not depend on spend. A vehicle tracked through the
         * Odometer tab can have real mileage in a range with no receipts in
         * it, and hiding this card alongside the spend cards contradicted the
         * distance the tile above was showing. It hides itself when there is
         * genuinely nothing to draw. */
        renderUsage(measured, t);
        if (empty) {
            /* 'rtv-card-top' belongs in this list and was missing from it. The
             * ONLY code that clears or hides Biggest expenses is renderTop(),
             * which this path never reaches — so an empty range left the card on
             * screen holding whatever the last non-empty render put there. Any
             * vehicle with no records at all opened on an empty card; and
             * switching a vehicle from "All" to "12M" with no recent spend kept
             * the PREVIOUS range's rows visible under a footnote reading "No
             * records in the selected range." */
            for (const id of ['rtv-card-permile', 'rtv-card-system', 'rtv-card-top']) {
                $(id).hidden = true;
            }
            renderFootnote(records, est);
            return;
        }
        renderMain(records, t);
        renderPerDistance(measured, t);
        renderSystems(records, t);
        renderTop(records, t);
        renderTable(records, t);
        renderFootnote(records, est);
    }

    /* `est` comes from render() rather than from here, because renderFootnote
     * has to describe the SAME estimate this tile displays. */
    function renderKpis(records, measured, est, t) {
        const bought = purchaseInRange();
        const spend = round2(total(records) + bought);
        $('rtv-total').textContent = money(spend, true);
        /* Describes the records on screen, so it reads off the slice. */
        const inRange = ownershipSpan(records);
        $('rtv-total-sub').textContent = inRange.from
            ? `${records.length.toLocaleString(fmt.locale)} records since ${monthLabel(monthKey(inRange.from))}`
              + (bought ? ` · includes ${money(bought, true)} of car and finance` : '')
            : 'No records in range';

        /* Total over EVERY month on the books, not just the months that saw a
         * bill — the quiet months are what make it a running cost rather than
         * an average invoice.
         *
         * The denominator comes from the WHOLE history plus the odometer
         * readings, clipped by the range rather than derived from it. Two
         * things went wrong when it was just `records`: selecting 12M restarted
         * "ownership" at the first receipt inside that window, and a vehicle
         * whose earliest evidence is an odometer entry rather than a receipt
         * had its ownership start late — both inflating the figure, which is
         * the exact bug this tile was added to fix. */
        const own = ownershipSpan(ownedMeasured(), new Date(), since());
        $('rtv-monthly').textContent = own.months
            ? money(spend / own.months) : '—';
        $('rtv-monthly-sub').textContent = own.from
            ? `Across ${own.months} month${own.months === 1 ? '' : 's'} since `
              + `${monthLabel(monthKey(own.from))}`
              + (state.anchor && !since() ? ', when you bought it' : '')
            : '';

        /* Deliberately NOT the range-filtered slice. This tile is labelled
         * "Last 12 months" and compares against the 12 before it — a fixed
         * window that the range buttons do not scope. Reading it off the slice
         * meant selecting 12M cut away the entire comparison period, so the
         * delta silently became "No prior year to compare" exactly when
         * someone had asked to look at the last year. */
        const year = trend(owned(), 365);
        $('rtv-year').textContent = money(year.current, true);
        const sub = $('rtv-year-sub');
        sub.replaceChildren();
        if (year.changePct === null) {
            sub.textContent = 'No prior year to compare';
        } else {
            /* Money, not a percentage. Against a near-zero prior year the
             * percentage reads something like ▲2300% — arithmetically correct
             * and meaningless, because a percentage carries no sense of the
             * base it is over. "▲ $11.5K vs $500.00 last year" says the same
             * thing and says what it is over, in the same width. */
            const up = year.current >= year.prior;
            const delta = document.createElement('span');
            delta.className = `rt-delta ${up ? 'is-up' : 'is-down'}`;
            delta.textContent =
                `${up ? '▲' : '▼'} ${money(Math.abs(year.current - year.prior), true)}`;
            sub.append(delta,
                document.createTextNode(` vs ${money(year.prior, true)} last year`));
        }
        drawSparkline(owned(), t);

        /* Distance is only measured across months that carry readings. A
         * garage that files receipts but never touches the Odometer tab has
         * its cost per distance divided by part of its history — which reads
         * HIGH, and silently. Where the readings establish a rate, the
         * uncovered months are filled at it and the tile says so. */
        const covered = est.distance;
        /* total(measured) === total(records): the odometer-only readings carry
         * cost 0. Written off `measured` because that is the set the distance
         * came from, so the two halves of the ratio cannot drift apart. */
        const perDistance = covered ? (total(measured) + bought) / covered : null;
        $('rtv-permile-label').textContent = `Cost per ${fmt.distance}`;
        $('rtv-permile').textContent = moneyPrecise(perDistance);
        $('rtv-permile').classList.toggle('rt-est', est.estimated);
        if (!covered) {
            $('rtv-permile-sub').textContent = 'Not enough odometer readings';
        } else if (est.estimated) {
            $('rtv-permile-sub').textContent =
                `Across about ${distanceNumber(covered)} ${distanceUnits()} — `
                + `${distanceNumber(est.measured)} measured over ${est.readingMonths} `
                + `of ${est.months} months, the rest at `
                + `${distanceNumber(est.ratePerMonth)}/month`;
        } else {
            $('rtv-permile-sub').textContent =
                `Across ${distanceNumber(covered)} ${distanceUnits()}`
                + (state.anchor && state.anchor.odometer !== null && !since()
                    ? ` since ${distanceNumber(state.anchor.odometer)}`
                    : ' of readings');
        }

        /* The stat upstream gets wrong. Its "Distance Traveled" comes from fuel
         * records alone, so with no fill-ups logged it reads 0 beside 30,000
         * miles of odometer history. This one is the odometer span. */
        $('rtv-distance-label').textContent = fmt.distance === 'hour'
            ? 'Hours logged' : 'Distance covered';
        /* This tile reports what the odometer actually recorded, NOT the
         * estimate the cost-per-distance tile divides by. They are different
         * questions: "how far has it gone" is a measurement, and answering it
         * with a projection would put an invented mileage next to a real
         * "Odometer now" underneath it. */
        $('rtv-distance').textContent = est.measured === null
            ? '—' : distanceNumber(est.measured);
        const latest = latestOdometer(measured);
        $('rtv-distance-sub').textContent = latest === null
            ? 'No odometer readings in range'
            : `Odometer now ${distanceNumber(latest)}`;
    }

    function drawSparkline(records, t) {
        /* The same trailing 12 calendar months the tile's figure covers. */
        const tail = trailingMonthlyTotals(records, 12).values;
        draw('spark', $('rtv-spark'), {
            type: 'line',
            data: {
                labels: tail.map((_, i) => String(i)),
                datasets: [{
                    data: tail,
                    borderColor: t.series[0],
                    backgroundColor: wash(t.series[0], 0.18),
                    borderWidth: 1.5,
                    fill: true,
                    tension: 0.35,
                    pointRadius: 0,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                /* Decoration, not a readable chart — it has no axes, so it must
                 * not offer a tooltip that implies precision it cannot show. */
                events: [],
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
                scales: { x: { display: false }, y: { display: false, beginAtZero: true } },
            },
        });
    }

    function sizePlotForRows(plot, rows) {
        plot.style.height = `${Math.max(160, rows * 46 + 70)}px`;
    }

    function renderMain(records, t) {
        const cats = chartCategories(records);
        const canvas = $('rtv-chart-main');
        const plot = canvas.parentElement;

        /* ── The ownership chart ──────────────────────────────────────
         *
         * Three lines against one money axis: what servicing has cost, what
         * the car itself has cost, and what it is worth. It is the same
         * cumulative-spend line this card has always drawn — the other two
         * appear only when there is a purchase price and a valuation to draw
         * them from, so a vehicle with neither sees exactly what it saw before.
         *
         * ONE AXIS, NOT TWO. All three are money, so a second scale would be
         * inventing a difference that is not in the data — and a dual axis lets
         * whoever picks the scales decide where the lines cross, which on this
         * chart is the whole question. Where the value line falls below the
         * paid line is the month the car stopped being worth what you had put
         * into it, and that crossing has to be a fact rather than a choice.
         */
        if (state.mode === 'cumulative') {
            plot.style.height = '';
            const { labels, values } = ownershipSpanMonths(cumulativeByMonth(records));
            const paid = state.loan ? paidUpTo(labels) : null;
            const worth = state.valuations.length
                ? valueByMonth(state.valuations, labels, state.curve) : null;
            /* Dashed from the last figure anybody stated, exactly as the
             * Finance tab draws it — the two surfaces answer the same question
             * and must not answer it with different confidence. */
            /* A SALE ends the line — valueAt() holds a sold price forever and
             * never models past it, so there is no modelled tail to dash. Same
             * guard as the Finance tab, because the two answer one question. */
            const lastPoint = state.valuations.length
                ? state.valuations[state.valuations.length - 1] : null;
            const modelledFrom = state.curve && lastPoint
                && lastPoint.source !== 'sold'
                ? labels.findIndex((l) => l > monthKey(lastPoint.date)) : -1;
            /* And everything BEFORE the first stated figure, which on a car
             * with no purchase price is most of the chart — the curve is
             * running backwards there and it must not read as measured. */
            const firstReal = state.valuations.length
                ? state.valuations[0] : null;
            /* findIndex returns -1 when EVERY label is before that figure —
             * which is the common case, not an edge one: the only figure on
             * file is usually "what it is worth now", dated later than the
             * last service record the chart ends on. Read as -1 that means
             * "nothing modelled" and the whole line draws solid, which is the
             * exact opposite of the truth. It means the whole line is
             * modelled, so dash all of it. */
            let modelledBefore = -1;
            if (state.curve && firstReal && firstReal.source !== 'bought') {
                const at = labels.findIndex((l) => l >= monthKey(firstReal.date));
                modelledBefore = at === -1 ? labels.length : at;
            }

            const lines = [
                { name: 'Running spend', data: values, colour: t.series[0] },
            ];
            /* Slots picked as a validated categorical triple (orange, violet,
             * aqua), not by eye: it clears the CVD, normal-vision and contrast
             * gates on ALL pairs in both themes. Re-colour one and re-check
             * those gates before believing it still does. */
            if (paid && paid.some((v) => v !== null)) {
                lines.push({ name: 'Paid for the car', data: paid, colour: t.series[3] });
            }
            if (worth && worth.some((v) => v !== null)) {
                lines.push({ name: 'What it’s worth', data: worth,
                             colour: t.series[2], dashFrom: modelledFrom,
                             dashBefore: modelledBefore });
            }
            const shown = lines.filter((l) => !state.hidden.has(l.name));

            const solo = lines.length === 1;
            $('rtv-main-title').textContent = solo
                ? 'Cumulative spend' : 'Cost of ownership';
            const last = values.length ? values[values.length - 1] : null;
            /* Describes the LINES, and never quotes a total across them. An
             * earlier draft printed "$5,000 in, everything to date" beside a
             * chart whose paid-for-the-car line ended at $20,000, which reads
             * as a contradiction — and is one, because the running spend and
             * the purchase are two separate answers and only the toggle
             * decides whether they are added. Each line ends in its own
             * figure; this says what they are. */
            $('rtv-main-note').textContent = last === null ? ''
                : (solo
                    ? `${money(last)} to date`
                    : 'What you have spent, what you have paid for the car'
                      + (lines.length > 2 ? ', and what it is worth' : ''));

            const opts = baseOptions(t);
            draw('main', canvas, {
                type: 'line',
                data: {
                    labels: labels.map(monthLabel),
                    datasets: shown.map((l) => ({
                        ...lineDataset(l.name, l.data, l.colour, t, { fill: solo }),
                        segment: !(l.dashFrom >= 0 || l.dashBefore > 0)
                            ? undefined : {
                                borderDash: (ctx) => {
                                    const i = ctx.p0DataIndex;
                                    const after = l.dashFrom >= 0
                                        && i >= l.dashFrom - 1;
                                    /* `< dashBefore`, NOT `< dashBefore - 1`:
                                       the segment ENDING at the first real
                                       point starts at dashBefore - 1 and is
                                       still modelled, so excluding it drew the
                                       last backward segment solid. The forward
                                       boundary already includes its transition
                                       segment with `>= dashFrom - 1`. */
                                    const before = l.dashBefore > 0
                                        && i < l.dashBefore;
                                    return after || before ? [4, 4] : undefined;
                                },
                            },
                    })),
                },
                options: {
                    ...opts,
                    plugins: {
                        ...opts.plugins,
                        /* Direct labels on every line — with three of them, a
                         * legend alone makes you look back and forth to find
                         * which is which at the end, where the answer is. */
                        rtEndLabel: {
                            colour: t.ink,
                            series: shown.map((l) => {
                                const v = lastOf(l.data);
                                return v === null ? null : { text: money(v, true) };
                            }),
                        },
                    },
                },
                plugins: [endLabelPlugin],
            });
            /* A single series names itself in the title; two or more always
             * carry a legend, so identity is never colour alone. */
            renderLegend(t, solo ? [] : lines);
            return;
        }

        if (state.mode === 'monthly' || state.mode === 'yearly') {
            plot.style.height = '';
            const yearly = state.mode === 'yearly';
            const { labels, series } = yearly
                ? yearlyByCategory(records) : monthlyByCategory(records);
            $('rtv-main-title').textContent = yearly ? 'Spend by year' : 'Spend by month';
            $('rtv-main-note').textContent = 'Stacked by category';
            draw('main', canvas, {
                type: 'bar',
                data: {
                    labels: yearly ? labels : labels.map(monthLabel),
                    datasets: cats.map((c) => ({
                        label: c,
                        data: series[c],
                        backgroundColor: seriesColour(c, t),
                        /* 2px of surface between segments — the gap does the
                           separating, not a stroke drawn around the mark. */
                        borderColor: t.surface,
                        borderWidth: 2,
                        borderRadius: 3,
                        borderSkipped: false,
                        maxBarThickness: yearly ? 64 : 24,
                    })),
                },
                options: baseOptions(t, { stacked: true }),
            });
            renderLegend(t, activeCategories(records)
                .map((c) => ({ name: c, colour: seriesColour(c, t) })));
            return;
        }

        $('rtv-main-title').textContent = 'Spend by category';
        const rows = byCategory(records).filter((r) => r.total !== 0);
        sizePlotForRows(plot, rows.length);
        const grand = rows.reduce((a, r) => a + r.total, 0);
        $('rtv-main-note').textContent = grand ? `${money(grand)} total` : '';
        const catOpts = horizontalBarOptions(t, undefined, rows.map((r) => r.total));
        draw('main', canvas, {
            type: 'bar',
            data: {
                labels: rows.map((r) => r.category),
                datasets: [{
                    label: 'Spend',
                    /* Category colours stay attached to the category here too,
                       so Service is the same hue in every chart on the page. */
                    backgroundColor: rows.map((r) => seriesColour(r.category, t)),
                    data: rows.map((r) => r.total),
                    borderRadius: 4,
                    borderSkipped: 'start',
                    maxBarThickness: 24,
                }],
            },
            options: {
                ...catOpts,
                plugins: {
                    ...catOpts.plugins,
                    rtBarLabels: {
                        labels: rows.map((r) => money(r.total)),
                        colour: t.ink,
                    },
                },
            },
            plugins: [barValueLabelPlugin],
        });
        $('rtv-legend').hidden = true;   // the y-axis already names every bar
    }

    /* Back-fill the cumulative series to the month the vehicle was BOUGHT.
     *
     * monthSpan() starts at the first month carrying spend, which is the right
     * start for a spending chart and the wrong one for this chart: "over the
     * total time it was owned" is what the ownership view is for, and a car
     * bought in January whose first receipt is in August was still yours — and
     * still depreciating, and still being paid for — for those seven months.
     * Left alone, the paid line enters the plot part-way up its climb, which
     * reads as a lump sum paid on the chart's first day.
     *
     * Zeroes, not nulls: nothing had been SPENT in those months, and that is a
     * measurement rather than a gap. Only extends when the whole history is on
     * screen — a 12M range asking to see the last year should not be dragged
     * back six years by the purchase date.
     */
    function ownershipSpanMonths({ labels, values }) {
        const start = state.anchor && state.anchor.date ? state.anchor.date
            : (state.loan && state.loan.start) || null;
        if (!start || since() || !labels.length) return { labels, values };
        const first = monthKey(start);
        if (first >= labels[0]) return { labels, values };
        const head = [];
        const cur = new Date(start.getFullYear(), start.getMonth(), 1);
        while (monthKey(cur) < labels[0]) {
            head.push(monthKey(cur));
            cur.setMonth(cur.getMonth() + 1);
        }
        return {
            labels: head.concat(labels),
            values: head.map(() => 0).concat(values),
        };
    }

    /** The last non-null value of a series, which is where its label goes. */
    function lastOf(values) {
        for (let i = values.length - 1; i >= 0; i--) {
            if (values[i] !== null && values[i] !== undefined) return values[i];
        }
        return null;
    }

    /* `entries` is [{ name, colour }] — a category takes its colour from
     * seriesColour(), the ownership lines carry their own. Hiding is keyed on
     * the NAME either way, so one Set covers both and a hidden series stays
     * hidden across a mode switch. */
    function renderLegend(t, entries) {
        const box = $('rtv-legend');
        box.hidden = entries.length === 0;
        box.replaceChildren();
        for (const entry of entries) {
            const on = !state.hidden.has(entry.name);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('aria-pressed', String(on));
            const name = document.createElement('span');
            name.className = 'rt-legend-name';
            name.textContent = entry.name;
            btn.append(swatch(entry.colour), name);
            btn.addEventListener('click', () => {
                if (state.hidden.has(entry.name)) state.hidden.delete(entry.name);
                else state.hidden.add(entry.name);
                render();
            });
            box.append(btn);
        }
    }


    /* The chart upstream cannot draw. Its distance axis reads fuel records, so
     * for a garage that logs no fill-ups it is a flat line pinned to a 0–1
     * scale; this reads the odometer numbers already on every service record. */
    /* `records` here is spend PLUS odometer-only readings — see
     * sliceWithReadings(). Distance is the whole point of this chart. */
    function renderUsage(records, t) {
        const monthly = usageByMonth(records);
        const has = monthly.values.some((v) => v !== null);
        $('rtv-card-usage').hidden = !has;
        $('rtv-usage-title').textContent = fmt.distance === 'hour'
            ? 'Hours run' : 'Distance driven';
        if (!has) return;

        /* Past a few years the monthly line stops being readable — see
         * MAX_USAGE_MONTHS. Bars for years, a line for months: a year is a
         * count of something that happened over it, a month-by-month series is
         * a trend, and the mark should say which one is on screen. */
        const yearly = monthly.labels.length > MAX_USAGE_MONTHS;
        const { labels, values, partial } = yearly
            ? usageByYear(records) : monthly;

        /* Say what the gaps ARE, precisely. They are not months with no
         * reading nearby — they are months the readings do not cover END TO
         * END, which in practice is almost always the first and last month of
         * the history. "No reading either side" would send someone hunting for
         * data that is already there. */
        if (yearly) {
            const short = partial.filter(Boolean).length;
            $('rtv-usage-note').textContent = short
                ? `Per year, from the odometer readings · ${short} of ${labels.length} `
                  + `years ${short === 1 ? 'isn’t' : 'aren’t'} recorded end to end `
                  + `and read${short === 1 ? 's' : ''} low`
                : 'Per year, from the odometer readings';
        } else {
            const gaps = values.filter((v) => v === null).length;
            $('rtv-usage-note').textContent = gaps
                ? `Per month, spread between odometer readings · ${gaps} of ${values.length} months aren’t covered end to end and are left blank`
                : 'Per month, spread between odometer readings';
        }

        const opts = baseOptions(t, { money: false });
        const label = fmt.distance === 'hour' ? 'Hours' : 'Distance';
        draw('usage', $('rtv-chart-usage'), {
            type: yearly ? 'bar' : 'line',
            data: {
                labels: yearly ? labels : labels.map(monthLabel),
                datasets: [yearly ? {
                    label,
                    data: values,
                    backgroundColor: t.series[3],
                    borderRadius: 3,
                    borderSkipped: false,
                    maxBarThickness: 64,
                } : lineDataset(label, values, t.series[3], t)],
            },
            options: {
                ...opts,
                scales: {
                    ...opts.scales,
                    y: {
                        ...opts.scales.y,
                        ticks: {
                            color: t.muted,
                            padding: 8,
                            callback: (v) => distanceNumber(v),
                        },
                    },
                },
            },
        });
    }

    /* `records` here is spend PLUS odometer-only readings. The readings carry
     * cost 0, so the numerator is unchanged and only the denominator grows. */
    function renderPerDistance(records, t) {
        /* The purchase rides along when the toggle is on. Keyed by month label
         * rather than handed in as an array because the labels are chosen
         * inside cumulativeCostPerDistance and the caller cannot know them. */
        const byLabel = state.includePurchase && state.loan
            ? (() => {
                const cache = new Map();
                return (label) => {
                    if (!cache.has(label)) {
                        cache.set(label, paidUpTo([label])[0] || 0);
                    }
                    return cache.get(label);
                };
            })()
            : null;
        const { labels, values, opening } =
            cumulativeCostPerDistance(records, { paidByLabel: byLabel });
        const has = values.some((v) => v !== null);
        $('rtv-card-permile').hidden = !has;
        $('rtv-permile-title').textContent = `Running cost per ${fmt.distance}`;
        if (!has) return;

        /* No gap count to report any more — cumulative cannot break mid-line.
         * What the note has to carry instead is that the line is lifetime-to-
         * date rather than "this month", because a falling line otherwise
         * looks like the car got cheaper LAST month specifically.
         *
         * And when the opening months have been held back, SAY SO. A line that
         * silently begins four months into a history is a line the reader will
         * eventually notice and distrust. */
        $('rtv-permile-note').textContent =
            `Everything spent, per ${fmt.distance} driven, as it stood each month`
            + (opening
                ? ` · the first ${opening} month${opening === 1 ? '' : 's'} `
                  + `${opening === 1 ? 'is' : 'are'} left off — too few `
                  + `${distanceUnits()} yet to divide by`
                : '');

        const opts = baseOptions(t);
        draw('permile', $('rtv-chart-permile'), {
            type: 'line',
            data: {
                labels: labels.map(monthLabel),
                datasets: [lineDataset(`Cost per ${fmt.distance}`, values, t.series[1], t)],
            },
            options: {
                ...opts,
                scales: {
                    ...opts.scales,
                    y: {
                        ...opts.scales.y,
                        /* Two decimals on the axis; the three-decimal figure
                           belongs on the stat tile, not repeated down a scale. */
                        ticks: { color: t.muted, padding: 8, callback: (v) => money(v) },
                    },
                },
            },
        });
    }

    /* The per-vehicle question a garage-wide page cannot answer: not which
     * ledger the money was filed under, but which part of the car it went on. */
    /* What the money went on. A ranked list, not a chart -- the description is
     * the part that changes a decision, and eight rows read faster than eight
     * bars. Same renderer as the standalone Metrics page had. */
    function renderTop(records, t) {
        const rows = topExpenses(records, 8);
        const list = $('rtv-top');
        list.replaceChildren();
        $('rtv-card-top').hidden = rows.length === 0;
        $('rtv-top-note').textContent = rows.length
            ? `Top ${rows.length} of ${records.length.toLocaleString(fmt.locale)} records`
            : '';
        for (const r of rows) {
            const li = document.createElement('li');
            const desc = document.createElement('span');
            desc.className = 'rt-top-desc';
            /* textContent, never innerHTML: a description is a record somebody
             * typed, and "<img onerror=...>" typed into one is not a
             * hypothetical. */
            desc.textContent = r.description;
            desc.title = r.description;
            const meta = document.createElement('span');
            meta.className = 'rt-top-meta';
            meta.textContent = [
                r.date.toLocaleDateString(fmt.locale, { month: 'short', year: 'numeric' }),
                r.category,
            ].filter(Boolean).join(' · ');
            const cost = document.createElement('span');
            cost.className = 'rt-top-cost';
            cost.textContent = money(r.cost);
            li.append(swatchFor(r.category, t), desc, meta, cost);
            list.append(li);
        }
    }

    function renderSystems(records, t) {
        const { rows, mixed } = bySystem(records);
        $('rtv-card-system').hidden = rows.length === 0;
        if (!rows.length) return;

        const spend = rows.reduce((a, r) => a + r.total, 0);
        const top = rows[0];
        $('rtv-system-note').textContent = spend
            ? `${top.system} leads at ${money(top.total)} across ${top.count} record${top.count === 1 ? '' : 's'}`
            : '';

        sizePlotForRows($('rtv-system-plot'), rows.length);
        const opts = horizontalBarOptions(t, undefined, rows.map((r) => r.total));
        draw('system', $('rtv-chart-system'), {
            type: 'bar',
            data: {
                labels: rows.map((r) => r.system),
                datasets: [{
                    label: 'Spend',
                    data: rows.map((r) => r.total),
                    /* One series, one colour. Colouring bars by their own value
                       would spend the identity channel re-encoding what bar
                       length already shows. */
                    backgroundColor: t.series[0],
                    borderRadius: 4,
                    borderSkipped: 'start',
                    maxBarThickness: 24,
                }],
            },
            options: {
                ...opts,
                plugins: {
                    ...opts.plugins,
                    /* The amounts, on the chart. This is a ranked list of
                       figures, and until now the figures were reachable only by
                       hovering — which a touch screen cannot do at all. */
                    rtBarLabels: {
                        labels: rows.map((r) => money(r.total)),
                        colour: t.ink,
                    },
                    tooltip: {
                        ...opts.plugins.tooltip,
                        callbacks: {
                            label: (ctx) => {
                                const row = rows[ctx.dataIndex];
                                return `${money(row.total)} · ${row.count} record${row.count === 1 ? '' : 's'}`;
                            },
                        },
                    },
                },
            },
            plugins: [barValueLabelPlugin],
        });

        /* Say out loud that this is a reading of free text. A breakdown that
         * looks as exact as the category totals, but is produced by keyword
         * matching, is the kind of number that gets quoted at a service desk. */
        $('rtv-system-caveat').textContent = mixed
            ? `Read from each record’s description — ${mixed} of ${records.length} mention more than one system and are counted under the first one named.`
            : 'Read from each record’s description, counted under the first system named.';
    }

    /* The WCAG relief channel. Two of the light-mode series colours sit under
     * 3:1, which is only legal because every value is also reachable as text.
     * Do not remove it. */
    function renderTable(records, t) {
        const wrap = $('rtv-table-wrap');
        if (wrap.hidden) return;             // built on demand, see wiring below

        const cats = activeCategories(records);
        const { labels, series } = monthlyByCategory(records);
        /* Keyed by month, NOT by array index. The rows come from the spend
         * records' span and the distances from a span that also includes
         * odometer-only readings; those coincide today only because monthSpan()
         * bases itself on records carrying spend. A history where every record
         * is zero-cost (warranty work) breaks that coincidence and would shift
         * every distance into the wrong month — silently, with plausible
         * numbers. Look it up by label and the question cannot arise. */
        const usageSeries = usageByMonth(sliceWithReadings());
        const usage = new Map(
            usageSeries.labels.map((l, i) => [l, usageSeries.values[i]]));

        const table = document.createElement('table');
        table.className = 'rt-table';

        const head = document.createElement('tr');
        head.append(withScope(cell('th', 'Month'), 'col'));
        for (const c of cats) {
            const th = cell('th', '');
            const key = document.createElement('span');
            key.className = 'rt-th-key';
            const name = document.createElement('span');
            name.textContent = c;
            key.append(swatchFor(c, t), name);
            th.append(key);
            head.append(withScope(th, 'col'));
        }
        head.append(withScope(cell('th', 'Total'), 'col'));
        head.append(withScope(cell('th', fmt.distance === 'hour' ? 'Hours' : 'Distance'), 'col'));
        const thead = document.createElement('thead');
        thead.append(head);

        const tbody = document.createElement('tbody');
        labels.forEach((label, i) => {
            const tr = document.createElement('tr');
            tr.append(withScope(cell('th', monthLabel(label)), 'row'));
            let rowTotal = 0;
            for (const c of cats) {
                rowTotal += series[c][i];
                tr.append(cell('td', money(series[c][i])));
            }
            tr.append(cell('td', money(rowTotal)));
            const miles = usage.get(label);
            tr.append(cell('td',
                miles === null || miles === undefined ? '—' : distanceNumber(miles)));
            tbody.append(tr);
        });

        const foot = document.createElement('tr');
        foot.append(withScope(cell('th', 'Total'), 'row'));
        for (const c of cats) {
            foot.append(cell('td', money(series[c].reduce((a, b) => a + b, 0))));
        }
        foot.append(cell('td', money(total(records))));
        const covered = distanceCovered(sliceWithReadings());
        foot.append(cell('td', covered === null ? '—' : distanceNumber(covered)));
        const tfoot = document.createElement('tfoot');
        tfoot.append(foot);

        table.append(thead, tbody, tfoot);
        wrap.replaceChildren(table);
    }

    function cell(tag, text) {
        const el = document.createElement(tag);
        el.textContent = text;
        return el;
    }

    /* Everything the reader would otherwise have to take on trust: what was
     * dropped, what was measured from, and — when nothing anchors the figures —
     * where to go and say so. */
    function renderFootnote(records, est) {
        const parts = [];
        if (state.skipped) {
            parts.push(`${state.skipped} record${state.skipped === 1 ? '' : 's'} skipped — unreadable date or cost.`);
        }
        if (state.anchor) {
            const bought = monthLabel(monthKey(state.anchor.date));
            const at = state.anchor.odometer === null ? ''
                : ` at ${distanceNumber(state.anchor.odometer)} ${distanceUnits()}`
                  + (state.anchor.odometerSet ? '' : ' (estimated from the readings either side)');
            parts.push(`Measured from ${bought}${at}, when you bought it.`);
            if (state.anchor.conflicts) {
                parts.push(`That reading is higher than one recorded after it, so it was not used for distance — check it against the records.`);
            }
            if (state.excluded) {
                parts.push(`${state.excluded} earlier record${state.excluded === 1 ? '' : 's'} — the previous owner's history — ${state.excluded === 1 ? 'is' : 'are'} left out.`);
            }
        } else {
            /* Only when it would move a number. A vehicle whose history starts
             * where its spending starts is already measured correctly, and a
             * permanent prompt on it teaches people to ignore this line. */
            const lead = unownedLeadMonths(state.records.concat(state.readings));
            if (lead >= 12) {
                parts.push(`Measured from the oldest record on file, which is ${Math.floor(lead / 12)} year${lead >= 24 ? 's' : ''} before the first one that cost anything. If you bought this vehicle later, set Purchased Date and “${PURCHASE_ODOMETER_FIELD}” in the vehicle's edit form and these figures will start there.`);
            }
        }
        const { dropped } = odometerSeries(sliceWithReadings());
        if (dropped) {
            parts.push(`${dropped} odometer reading${dropped === 1 ? '' : 's'} contradicted the readings around ${dropped === 1 ? 'it' : 'them'} and ${dropped === 1 ? 'was' : 'were'} not used for distance.`);
        }
        /* What the figures rest on. Said plainly rather than withheld: a page
         * that hides a metric because coverage is "too low" reads as broken,
         * and the number is still the best answer available. Only shown when
         * something is actually missing — on a complete history this line
         * would be noise, and a line that is always there is a line nobody
         * reads. */
        /* TWO FACTS, AND THEY WERE ONE SENTENCE. How many receipts carry a
         * reading, and whether the distance figure is partly filled in, are
         * separate questions with separate answers — and welding them meant the
         * caveat could only appear when the first one happened to be true.
         *
         * Worse, the estimate half was computed here over `records` while the
         * tile it describes computed it over `measured`. They disagreed in both
         * directions. A garage that keeps its mileage in the Odometer tab has no
         * reading on any receipt, so this said nothing was estimated beside a
         * tile wearing the estimate mark; and a garage where every receipt DOES
         * carry a reading never got past the coverage guard at all, so the
         * caveat vanished on exactly the histories whose readings stop years
         * before their receipts do. The footnote is this page's honesty channel
         * and it went quiet precisely when it was needed.
         *
         * `est` is now the object the tile was drawn from, handed in by
         * render(). There is no second computation left to drift. */
        const cov = coverage(records);
        if (cov.records && cov.withOdometer < cov.records) {
            parts.push(`${cov.withOdometer} of ${cov.records} records carry an `
                + `odometer reading.`);
        }
        if (est.estimated) {
            parts.push(`Odometer readings cover ${est.readingMonths} of `
                + `${est.months} months — cost per ${fmt.distance} fills the rest `
                + `at the rate those readings show, so treat it as an estimate.`);
        }
        if (!records.length) parts.push('No records in the selected range.');
        $('rtv-footnote').textContent = parts.join(' ');
    }

    /* ── Upstream's own controls ────────────────────────────────────── */

    /* The Dashboard tab is also where LubeLogger puts vehicle search, the
     * printable history report and attachment export. Those are not metrics,
     * but they have no other home in the UI — dropping them to make room for
     * charts would be a straight functional regression. They are rebuilt here
     * because each is one call to a global upstream already defines.
     *
     * COLLABORATORS USED TO BE LIFTED IN HERE TOO, and is not any more: it has
     * its own tab now (roadtrack-ui.js). Sharing a car is one of the things
     * people do most and it was sat below five charts, which is upstream's
     * layout faithfully reproduced and nobody's idea of reachable. */
    function loadTools() {
        const box = $('rtv-tools');
        const actions = [
            ['bi-search', 'Search records', 'showGlobalSearch'],
            ['bi-file-earmark-text', 'Maintenance report', 'generateVehicleHistoryReport'],
            ['bi-paperclip', 'Export attachments', 'exportAttachments'],
        ];
        const card = document.createElement('section');
        card.className = 'rt-card rt-vdash-actions';
        for (const [icon, label, fn] of actions) {
            if (typeof window[fn] !== 'function') continue;
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn btn-secondary btn-sm';
            const i = document.createElement('i');
            i.className = `bi ${icon} me-2`;
            b.append(i, document.createTextNode(label));
            b.addEventListener('click', () => window[fn]());
            card.append(b);
        }
        if (card.childElementCount) box.append(card);
    }

    /* ── Wiring ─────────────────────────────────────────────────────── */

    $('rtv-table-toggle').addEventListener('click', (e) => {
        const wrap = $('rtv-table-wrap');
        const show = wrap.hidden;
        wrap.hidden = !show;
        e.currentTarget.setAttribute('aria-expanded', String(show));
        e.currentTarget.textContent = show ? 'Hide table' : 'Show table';
        if (show) renderTable(slice(), tokens(root));
    });

    themeWatch.observe(document.documentElement, {
        attributes: true, attributeFilter: ['data-bs-theme'],
    });

    /* Chart colours are read out of CSS at draw time. ensureMetricsCss() gives
     * up waiting after 3s so a stalled stylesheet can never leave the tab
     * blank — but if the sheet then arrives, the layout corrects itself while
     * the canvases keep whatever they were drawn with. This redraws them.
     *
     * Removed on teardown as well as after firing: `once` only cleans up if the
     * event ever happens, so leaving the tab first would strand this closure —
     * and the whole dashboard it captures — on `document` until the page
     * unloads. One per visit to the tab adds up. */
    document.addEventListener('rt-metrics-css-loaded', onCssLoaded, { once: true });
}
