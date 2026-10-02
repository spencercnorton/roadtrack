/* Road Track — what the car itself cost.
 *
 * A tab on the vehicle page, injected by roadtrack-ui.js exactly like Reports
 * and Collaborators. Everything else in Road Track measures what a vehicle
 * costs to RUN; this is the one surface for the cheque that bought it.
 *
 * IT READS ONE ENDPOINT. Every figure here comes off the vehicle record —
 * upstream's own purchase price, sold price and dates, plus the loan terms
 * stored as extra fields — so the tab opens without pulling a single service
 * record. The maths all lives next door in aggregate.js, under node, with its
 * own checks in tools/test_metrics.mjs; this file is the renderer and does no
 * arithmetic worth testing in a browser.
 *
 * NOTHING IS INTERPOLATED AS MARKUP. Same rule as everywhere else — every
 * value is written with textContent.
 */

import {
    loanOf, valuationsOf, valueAt, depreciationCurve, monthKey, round2,
    LOAN_FIELDS, VALUATION_FIELD,
} from './aggregate.js?v=__RT_VERSION__';
import {
    applyChartDefaults, money, monthLabel, vehicleLabel, api, AuthError,
    loadFormatting, tokens, baseOptions, lineDataset, chartDrawer, swatch,
    endLabelPlugin, withScope,
} from './chart-kit.js?v=__RT_VERSION__';

const TEMPLATE = `
<div class="rt-filters">
    <span class="rt-vdash-name" id="rtf-name"></span>
</div>

<div id="rtf-body" hidden>
    <section class="rt-kpis" aria-label="Purchase figures">
        <div class="rt-tile rt-hero">
            <span class="rt-tile-label">What it ends up costing</span>
            <span class="rt-tile-value" id="rtf-total">—</span>
            <span class="rt-tile-sub" id="rtf-total-sub"></span>
        </div>
        <div class="rt-tile">
            <span class="rt-tile-label">Paid off</span>
            <span class="rt-tile-value" id="rtf-payoff">—</span>
            <span class="rt-tile-sub" id="rtf-payoff-sub"></span>
        </div>
        <div class="rt-tile">
            <span class="rt-tile-label">Interest</span>
            <span class="rt-tile-value" id="rtf-interest">—</span>
            <span class="rt-tile-sub" id="rtf-interest-sub"></span>
        </div>
        <div class="rt-tile">
            <span class="rt-tile-label">Paid so far</span>
            <span class="rt-tile-value" id="rtf-paid">—</span>
            <span class="rt-tile-sub" id="rtf-paid-sub"></span>
        </div>
        <div class="rt-tile">
            <span class="rt-tile-label">Worth now</span>
            <span class="rt-tile-value" id="rtf-worth">—</span>
            <span class="rt-tile-sub" id="rtf-worth-sub"></span>
        </div>
    </section>

    <section class="rt-card" id="rtf-card-chart">
        <div class="rt-card-head">
            <h3 class="rt-card-title">Paid against value</h3>
            <span class="rt-card-note" id="rtf-chart-note"></span>
        </div>
        <div class="rt-plot rt-plot-tall"><canvas id="rtf-chart"></canvas></div>
        <div class="rt-legend" id="rtf-legend"></div>
        <p class="rt-note" id="rtf-chart-caveat"></p>
    </section>

    <section class="rt-card" id="rtf-card-terms">
        <div class="rt-card-head">
            <h3 class="rt-card-title">The loan</h3>
            <span class="rt-card-note" id="rtf-terms-note"></span>
        </div>
        <div class="rt-table-wrap"><table class="rt-table" id="rtf-terms"></table></div>
    </section>
</div>

<div class="rt-empty" id="rtf-state">Loading…</div>
`;

export default async function render(pane, vehicleId) {
    applyChartDefaults();

    const root = document.createElement('div');
    root.className = 'rt-metrics rt-vdash rt-finance';
    root.innerHTML = TEMPLATE;
    pane.replaceChildren(root);

    const $ = (id) => root.querySelector(`#${id}`);
    const draw = chartDrawer();

    /* Same teardown contract as the dashboard: upstream empties panes on tab
     * switches, and Chart.js and the theme observer both outlive the DOM. */
    let disposed = false;
    const themeWatch = new MutationObserver(() => paint());
    const teardown = new MutationObserver(() => {
        if (!pane.contains(root)) {
            disposed = true;
            draw.destroyAll();
            themeWatch.disconnect();
            teardown.disconnect();
        }
    });
    teardown.observe(pane, { childList: true });

    let vehicle = null;
    try {
        await loadFormatting();
        const vehicles = await api('/api/vehicles');
        vehicle = (Array.isArray(vehicles) ? vehicles : [])
            .find((v) => Number(v.id) === vehicleId) || null;
    } catch (e) {
        if (disposed) return;
        $('rtf-state').textContent = e instanceof AuthError
            ? 'Your session has expired — reload the page to sign in again.'
            : 'Could not load this vehicle.';
        return;
    }
    if (disposed) return;

    const loan = loanOf(vehicle);
    const valuations = valuationsOf(vehicle);
    const curve = depreciationCurve(vehicle);
    /* The last real figure on file — the POINT, not just its date, because a
     * SALE ends the line. valueAt() holds a sold price forever and never
     * models past it, so a sold vehicle has no modelled tail at all: marking
     * one estimated would label a settled transaction as a guess.
     *
     * Shared by the tile and the chart so the two cannot disagree about which
     * of them is a measurement. */
    const lastReal = valuations.length
        ? valuations[valuations.length - 1] : null;
    const modelsAfterLast = !!(curve && lastReal && lastReal.source !== 'sold');
    const modelledNow = modelsAfterLast && new Date() > lastReal.date;

    /* Named in the vehicle's own words, and never finer than the row that
     * actually answered.
     *
     * `measured` is the only basis backed by a published figure for THIS
     * model. The make row is a tier this repo assigned by reading the study's
     * model rankings — defensible, but not a measurement of that make — and
     * saying "what a BMW loses" would dress an inferred heuristic up as sales
     * data on a page full of real money. So the inferred bases say so. */
    const MEASURED = new Set(['measured', 'model']);
    const curveBasis = () => (curve && {
        measured: `a ${vehicle.make} ${vehicle.model}`,
        model: `a ${vehicle.make} ${vehicle.model}`,
        make: `${vehicle.make}-class cars`,
        ev: 'electric cars',
        fleet: 'cars in general',
    }[curve.basis]) || 'cars in general';
    $('rtf-name').textContent = vehicleLabel(vehicle) || '';

    /* NOT an error state — it is the state every vehicle starts in. So it says
     * what to type and where, in the words the form uses, rather than
     * reporting that something is missing. */
    if (!loan) {
        $('rtf-state').replaceChildren(...explainer());
        $('rtf-state').className = 'rt-empty rt-finance-empty';
        themeWatch.observe(document.documentElement, {
            attributes: true, attributeFilter: ['data-bs-theme'],
        });
        return;
    }

    $('rtf-body').hidden = false;
    $('rtf-state').hidden = true;
    paint();
    themeWatch.observe(document.documentElement, {
        attributes: true, attributeFilter: ['data-bs-theme'],
    });

    function paint() {
        if (disposed || !loan) return;
        const t = tokens(root);
        renderTiles();
        renderChart(t);
        renderTerms();
    }

    /* ── Tiles ──────────────────────────────────────────────────────── */

    function renderTiles() {
        const now = new Date();
        const paid = paidAtLocal(now);

        $('rtf-total').textContent = money(loan.totalCost, true);
        $('rtf-total-sub').textContent = loan.financedFully
            ? `${money(loan.price, true)} for the car, `
              + `${money(loan.interest, true)} to borrow it`
            : `${money(loan.price, true)} for the car, bought outright`;

        if (!loan.financedFully) {
            $('rtf-payoff').textContent = 'Outright';
            $('rtf-payoff-sub').textContent = loan.start
                ? `Bought ${monthLabel(monthKey(loan.start))}, nothing financed`
                : 'Nothing financed';
        } else if (!loan.payoff) {
            $('rtf-payoff').textContent = `${loan.term} months`;
            $('rtf-payoff-sub').textContent =
                'Set Purchased Date to place the loan on a calendar';
        } else {
            const settled = loan.payoff <= now;
            $('rtf-payoff').textContent = monthLabel(monthKey(loan.payoff));
            const years = Math.floor(loan.term / 12);
            const rest = loan.term % 12;
            const span = [years ? `${years} year${years === 1 ? '' : 's'}` : '',
                          rest ? `${rest} month${rest === 1 ? '' : 's'}` : '']
                .filter(Boolean).join(' ');
            $('rtf-payoff-sub').textContent = settled
                ? `${span} of payments, all made`
                : `${span} of payments · ${monthsBetween(now, loan.payoff)} to go`;
        }

        $('rtf-interest').textContent = money(loan.interest, true);
        $('rtf-interest-sub').textContent = loan.financedFully
            ? `${loan.apr}% APR on ${money(loan.financed, true)} over ${loan.term} months`
            : 'Nothing borrowed, nothing owed';

        $('rtf-paid').textContent = money(paid, true);
        const left = round2(loan.totalCost - paid);
        $('rtf-paid-sub').textContent = !loan.start
            ? 'Set Purchased Date to track this'
            : (left > 0
                ? `${money(left, true)} still to pay`
                : 'Paid in full');

        /* Modelled from what this make and model actually sold for at five
         * years old, hung off the price paid — and marked estimated, with the
         * `~` the odometer readings already use, so it never passes for a
         * figure somebody looked up. A typed valuation supersedes it. */
        const worth = valueAt(valuations, new Date(), curve);
        const stated = valuations.some((p) => p.source !== 'bought');
        const known = stated || (curve && worth !== null);
        /* Estimated when TODAY sits past the last figure anybody stated — not
         * merely when none were. A car valued in 2024 and not since has a
         * modelled number on it now, and calling that stated because something
         * was once stated is the failure this mark exists to prevent. */
        $('rtf-worth').textContent = known ? money(worth, true) : '—';
        $('rtf-worth').classList.toggle('rt-est', known && modelledNow);
        /* "Down $12K", not "$-12K". money() puts the currency symbol in
         * front of whatever it is given, so a negative renders as "$-12K" —
         * which is the sort of thing that reads as a formatting bug and makes
         * a reader distrust the figures around it. */
        const delta = round2(worth - loan.price);
        $('rtf-worth-sub').textContent = known
            ? `${delta < 0 ? 'Down' : 'Up'} ${money(Math.abs(delta), true)} on the `
              + `${money(loan.price, true)} you paid`
              + (modelledNow ? ', estimated' : '')
            : `Add “${VALUATION_FIELD}” on the vehicle to track this`;
    }

    /* ── Paid against value ─────────────────────────────────────────── */

    function renderChart(t) {
        const now = new Date();
        if (!loan.start) {
            $('rtf-card-chart').hidden = true;
            return;
        }
        $('rtf-card-chart').hidden = false;

        /* Past the end of the loan OR past today, whichever is later: a loan
         * still running should show where it finishes, and one long settled
         * should still run up to now beside the value line. */
        const end = loan.payoff && loan.payoff > now ? loan.payoff : now;
        const labels = [];
        const cur = new Date(loan.start.getFullYear(), loan.start.getMonth(), 1);
        while (cur <= end) {
            labels.push(monthKey(cur));
            cur.setMonth(cur.getMonth() + 1);
        }

        const cum = [0];
        for (const row of loan.schedule) cum.push(round2(cum[cum.length - 1] + row.payment));
        const nowKey = monthKey(now);
        /* labels[0] IS the purchase month, so the index is the number of
         * instalments due by then — nothing at k=0 but the money up front,
         * which on a car bought outright is the whole price. */
        const paid = labels.map((_, k) =>
            round2(loan.upfront + cum[Math.min(k, cum.length - 1)]));
        /* The value line STOPS AT TODAY. Holding it flat into the months of a
         * loan that has not finished yet would be forecasting a resale price,
         * which is not something this page knows. */
        const worth = labels.map((label) => {
            if (label > nowKey) return null;
            const [y, m] = label.split('-').map(Number);
            return valueAt(valuations, new Date(y, m, 0), curve);
        });
        const hasWorth = worth.some((v) => v !== null)
            && (curve || valuations.some((p) => p.source !== 'bought'));

        /* Dashed from the last figure anybody actually stated — which on a
         * vehicle with none is the purchase, so the whole line is dashed. Same
         * device the unpaid schedule uses on this chart: measured is solid,
         * modelled is not, and the two are never one claim. */
        const lastRealKey = lastReal ? monthKey(lastReal.date) : null;
        const modelled = modelsAfterLast
            ? labels.findIndex((l) => l > lastRealKey) : -1;
        const future = labels.findIndex((l) => l > nowKey);

        const lines = [{ name: 'Paid for the car', data: paid,
                         colour: t.series[3], dashFrom: future }];
        if (hasWorth) {
            lines.push({ name: 'What it’s worth', data: worth,
                         colour: t.series[2], dashFrom: modelled });
        }

        $('rtf-chart-note').textContent = hasWorth
            ? 'Every payment made, against what it has been worth'
            : 'Every payment made';

        const opts = baseOptions(t);
        draw('finance', $('rtf-chart'), {
            type: 'line',
            data: {
                labels: labels.map(monthLabel),
                datasets: lines.map((l) => ({
                    ...lineDataset(l.name, l.data, l.colour, t, { fill: false }),
                    /* Payments not yet made are a SCHEDULE, not a history, and
                     * value past the last stated figure is a MODEL. Dashed so
                     * neither is read as the same kind of claim as the solid
                     * part of its own line. */
                    segment: l.dashFrom < 0 ? undefined : {
                        borderDash: (ctx) =>
                            (ctx.p0DataIndex >= l.dashFrom - 1 ? [4, 4] : undefined),
                    },
                })),
            },
            options: {
                ...opts,
                plugins: {
                    ...opts.plugins,
                    rtEndLabel: {
                        colour: t.ink,
                        series: lines.map((l) => {
                            const v = lastValue(l.data);
                            return v === null ? null : { text: money(v, true) };
                        }),
                    },
                },
            },
            plugins: [endLabelPlugin],
        });

        const box = $('rtf-legend');
        box.replaceChildren();
        box.hidden = lines.length < 2;
        for (const l of lines) {
            const item = document.createElement('span');
            item.className = 'rt-legend-static';
            const name = document.createElement('span');
            name.className = 'rt-legend-name';
            name.textContent = l.name;
            item.append(swatch(l.colour), name);
            box.append(item);
        }

        const parts = [];
        if (future >= 0) {
            parts.push('Payments after this month are the remaining schedule, drawn dashed.');
        }
        if (hasWorth) {
            const points = valuations.filter((p) => p.source === 'stated').length;
            if (points) {
                parts.push(`Value is a straight line between the ${points} figure`
                    + `${points === 1 ? '' : 's'} you entered`
                    + (loan.price ? ', starting from what you paid' : '') + '.');
            }
            /* Says WHICH curve, because "estimated" on its own invites the
             * reader to assume a generic one — and the whole point is that it
             * is not generic. Two things it must get right:
             *
             *  · MEASURED vs INFERRED. Only the per-model tables are published
             *    figures for this car; the make row is a tier this repo
             *    assigned, and must not be reported as what that make loses.
             *  · WHICH anchor. The tail is scaled to the LAST REAL POINT, so
             *    once a valuation is typed it is no longer "what you paid" —
             *    and re-anchoring is the whole design. */
            if (modelsAfterLast && (!points || modelled >= 0)) {
                const pct = Math.round((1 - curve.retain5) * 100);
                const anchor = lastReal && lastReal.source === 'stated'
                    ? 'your latest recorded value' : 'what you paid';
                parts.push(MEASURED.has(curve.basis)
                    ? `The dashed part follows what ${curveBasis()} actually `
                      + `loses (${pct}% in five years), scaled to ${anchor}. `
                      + `Put a real figure in “${VALUATION_FIELD}” and the line `
                      + `bends to it.`
                    : `The dashed part uses a ${curveBasis()} rate (${pct}% in `
                      + `five years) — a category estimate, not a measurement of `
                      + `this model — scaled to ${anchor}. Put a real figure in `
                      + `“${VALUATION_FIELD}” and the line bends to it.`);
            }
        } else {
            parts.push(`Nothing is recorded for what this is worth. Put figures like `
                + `“2024-06 = 12000, 2026-01 = 10000” in “${VALUATION_FIELD}” on the `
                + `vehicle and the depreciation line appears here.`);
        }
        $('rtf-chart-caveat').textContent = parts.join(' ');
    }

    /* ── The terms, as text ─────────────────────────────────────────── */

    /* The WCAG relief channel, same as the dashboard's figures table: two of
     * the light-mode series colours sit under 3:1, which is only defensible
     * while every value is also reachable as text. */
    function renderTerms() {
        const table = $('rtf-terms');
        $('rtf-card-terms').hidden = !loan.financedFully;
        if (!loan.financedFully) return;
        $('rtf-terms-note').textContent =
            `${money(loan.payment)} a month for ${loan.term} months`;

        const rows = [
            ['Price', money(loan.price)],
            ['Deposit', money(loan.down)],
            ['Financed', money(loan.financed)],
            ['APR', `${loan.apr}%`],
            ['Term', `${loan.term} months`],
            ['Monthly payment', money(loan.payment)],
            ['Total interest', money(loan.interest)],
            ['Total cost', money(loan.totalCost)],
        ];
        const body = document.createElement('tbody');
        for (const [label, value] of rows) {
            const tr = document.createElement('tr');
            tr.append(withScope(cell('th', label), 'row'), cell('td', value));
            body.append(tr);
        }
        table.replaceChildren(body);
    }

    /* ── Helpers ────────────────────────────────────────────────────── */

    function explainer() {
        const h = document.createElement('p');
        h.className = 'rt-finance-lead';
        h.textContent = 'Nothing is recorded for what this vehicle cost to buy.';
        const p = document.createElement('p');
        p.textContent = 'Open the vehicle’s edit form, expand '
            + '“Purchase/Sold Information” and fill in:';
        const ul = document.createElement('ul');
        for (const [name, why] of [
            ['Purchased Price', 'what you paid for the car'],
            ['Purchased Date', 'when — this also anchors every figure on the Dashboard'],
            [LOAN_FIELDS.down, 'the deposit, if there was one'],
            [LOAN_FIELDS.apr, 'the rate on the loan agreement, e.g. 5.9'],
            [LOAN_FIELDS.term, 'how many payments, e.g. 60'],
            [VALUATION_FIELD, 'what it has been worth since, e.g. 2026-01 = 10000'],
        ]) {
            const li = document.createElement('li');
            const b = document.createElement('strong');
            b.textContent = name;
            li.append(b, document.createTextNode(` — ${why}`));
            ul.append(li);
        }
        const tail = document.createElement('p');
        tail.className = 'rt-note';
        tail.textContent = 'A price alone is enough — the loan fields are only '
            + 'needed if you financed it, and none of this changes the '
            + 'Dashboard until you press “Include purchase & finance” there.';
        return [h, p, ul, tail];
    }

    /* Local rather than aggregate.js's paidAt(): that one builds a label array
     * to reuse paidByMonth, which is the right trade for one call from the
     * dashboard and the wrong one here, where the schedule is already in hand. */
    function paidAtLocal(date) {
        if (!loan.start || date < loan.start) return 0;
        const k = monthsBetween(loan.start, date);
        let sum = loan.upfront;
        for (let i = 0; i < Math.min(k, loan.schedule.length); i++) {
            sum += loan.schedule[i].payment;
        }
        return round2(sum);
    }

    function cell(tag, text) {
        const el = document.createElement(tag);
        el.textContent = text;
        return el;
    }
}

const monthsBetween = (from, to) =>
    (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());

function lastValue(values) {
    for (let i = values.length - 1; i >= 0; i--) {
        if (values[i] !== null && values[i] !== undefined) return values[i];
    }
    return null;
}
