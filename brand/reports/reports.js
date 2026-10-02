/* Road Track — printable reports.
 *
 * Lives in a tab on the vehicle page (injected by roadtrack-ui.js, same
 * mechanism as the Collaborators tab) and renders a WYSIWYG preview of the
 * report you are about to print. What you see in the pane is the same element
 * that goes to the printer.
 *
 * WHY NOT UPSTREAM'S REPORT. LubeLogger already has one —
 * `generateVehicleHistoryReport()` pops a column picker and POSTs to
 * `/Vehicle/GetVehicleHistory`. It is genuinely usable and it stays reachable
 * from the dashboard's tools row. Two things it cannot do:
 *
 *   · Its parameters are columns, tags and a date range — there is NO record
 *     TYPE filter. "Routine maintenance" is not expressible, and that is the
 *     report a car owner actually wants.
 *   · It is a raw column picker. Every use starts by deciding which of six
 *     columns you want, which is a question about our data model rather than
 *     about your car.
 *
 * So this offers named reports instead of controls, over the same records the
 * dashboard already knows how to read (aggregate.js).
 *
 * PRINTING IS UPSTREAM'S. `printContainer(html)` in shared.js hides the app
 * chrome, drops the HTML into `.stickerPrintContainer`, calls window.print()
 * and puts everything back. Reused rather than reimplemented: it means the
 * browser's own "Save as PDF" produces the file, so there is no PDF library
 * in the image and it works on a phone.
 *
 * NOTHING IS INTERPOLATED AS MARKUP. Every field off a record is written with
 * textContent — a record holds whatever somebody typed or imported, so a
 * description containing `<img onerror=…>` is a case to expect, not a
 * hypothetical.
 */

import {
    SOURCES, ODOMETER_SOURCE, normalise, normaliseReadings, total,
    byCategory, bySystem, topExpenses, ownershipSpan, estimatedDistance,
    anchorOf, anchored, anchorReading, odometerSeries,
} from '../metrics/aggregate.js?v=__RT_VERSION__';
import {
    api, fmt, money, moneyPrecise, distanceNumber, distanceUnits,
    loadFormatting, vehicleLabel, AuthError,
} from '../metrics/chart-kit.js?v=__RT_VERSION__';

/* `needsCost` marks a report that IS the money — offering it with costs
 * switched off would render an empty page rather than a discreet one. */
const TYPES = [
    {
        id: 'routine',
        label: 'Routine maintenance',
        blurb: 'Servicing only — the history a buyer, a mechanic or a warranty asks for.',
        sortable: true,
    },
    {
        id: 'full',
        label: 'Full records',
        blurb: 'Everything on file for this vehicle, including odometer readings.',
        sortable: true,
    },
    {
        id: 'cost',
        label: 'Cost summary',
        blurb: 'What it has cost to own and run, by category and by system.',
        needsCost: true,
    },
];

/* Order matters on a printed sheet, because the reader cannot re-sort it. The
 * default is the one every report had before this control existed.
 *
 * `note` is what the footer says. Only a LIST of records can be reordered —
 * the cost summary is three aggregate tables, each already ranked by the thing
 * it is about, so the control hides rather than lying about what it does. */
const SORTS = [
    { id: 'date-asc', label: 'Date — oldest first' },
    { id: 'date-desc', label: 'Date — newest first',
      note: 'Ordered by date, newest first.' },
    { id: 'cost-desc', label: 'Cost — highest first',
      note: 'Ordered by cost, most expensive first.' },
    { id: 'cost-asc', label: 'Cost — lowest first',
      note: 'Ordered by cost, least expensive first.' },
];

/* The sheet has to exist before printContainer() runs, and no LubeLogger page
 * has asked for it — same situation metrics.css is in on the dashboard. Done
 * here rather than in roadtrack-ui.js so the module owns its own styling. */
function ensureCss() {
    if (document.getElementById('rt-reports-css')) return;
    const link = document.createElement('link');
    link.id = 'rt-reports-css';
    link.rel = 'stylesheet';
    link.href = '/brand/reports/reports.css?v=__RT_VERSION__';
    document.head.appendChild(link);
}

export default async function render(pane, vehicleId) {
    ensureCss();
    const state = {
        type: 'routine',
        sort: 'date-asc',
        costs: true,
        vehicle: null,
        records: [],
        readings: [],
        anchor: null,
    };

    pane.replaceChildren();
    const controls = el('div', 'rt-rep-controls');
    const sheet = el('div', 'rt-rep-sheet');
    const status = el('p', 'rt-rep-status', 'Loading…');
    pane.append(controls, status, sheet);

    try {
        await loadFormatting();
        const [vehicles, odometer, ...sets] = await Promise.all([
            api('/api/vehicles'),
            api(ODOMETER_SOURCE).catch(() => []),
            ...SOURCES.map((s) => api(s.path)),
        ]);
        state.vehicle = (Array.isArray(vehicles) ? vehicles : [])
            .find((v) => Number(v.id) === vehicleId) || null;
        /* Every /all endpoint returns the whole garage whatever you pass it, so
         * the scoping is ours — on the RAW rows, before normalise(). */
        const mine = (rows) => (rows || [])
            .filter((r) => Number.parseInt(r.vehicleId, 10) === vehicleId);
        sets.forEach((rows, i) => {
            state.records.push(...normalise(SOURCES[i].category, mine(rows)).records);
        });
        state.readings = normaliseReadings(mine(odometer)).records;

        const series = odometerSeries(state.records.concat(state.readings))
            .series.get(vehicleId) || [];
        state.anchor = anchorOf(state.vehicle, series);
    } catch (err) {
        status.textContent = err instanceof AuthError
            ? 'Your session has expired — reload the page to sign back in.'
            : 'Could not load this vehicle’s records.';
        return;
    }

    status.remove();
    buildControls();
    draw();

    /* ── Controls ──────────────────────────────────────────────────── */

    function buildControls() {
        const picker = el('div', 'rt-rep-types');
        picker.setAttribute('role', 'group');
        picker.setAttribute('aria-label', 'Report');
        for (const t of TYPES) {
            const b = el('button', 'rt-rep-type');
            b.type = 'button';
            b.append(el('span', 'rt-rep-type-label', t.label),
                     el('span', 'rt-rep-type-blurb', t.blurb));
            b.addEventListener('click', () => {
                state.type = t.id;
                /* Choosing the money report with money switched off is a
                   contradiction; resolve it in the user's favour rather than
                   printing an empty page. */
                if (t.needsCost) state.costs = true;
                syncControls();
                draw();
            });
            t.button = b;
            picker.append(b);
        }

        /* A <select>, not a pair of buttons: four ordered choices is exactly
           what a select is for, it comes with keyboard and screen-reader
           behaviour already, and on a phone it opens the native picker. */
        const sortWrap = el('label', 'rt-rep-toggle rt-rep-sort');
        const sort = document.createElement('select');
        sort.className = 'form-select form-select-sm';
        for (const s of SORTS) {
            const o = document.createElement('option');
            o.value = s.id;
            o.textContent = s.label;
            sort.append(o);
        }
        sort.value = state.sort;
        sort.addEventListener('change', () => {
            state.sort = sort.value;
            draw();
        });
        sortWrap.append(el('span', null, 'Sort'), sort);

        const costWrap = el('label', 'rt-rep-toggle');
        const cost = document.createElement('input');
        cost.type = 'checkbox';
        cost.checked = state.costs;
        cost.addEventListener('change', () => {
            state.costs = cost.checked;
            syncControls();
            draw();
        });
        costWrap.append(cost, document.createTextNode('Include prices'));

        const print = el('button', 'btn btn-primary btn-sm rt-rep-print');
        print.type = 'button';
        print.append(iconEl('bi-printer'), document.createTextNode('Print / Save as PDF'));
        print.addEventListener('click', doPrint);

        controls.append(picker, sortWrap, costWrap, print);
        TYPES.costInput = cost;
        TYPES.sortWrap = sortWrap;
        syncControls();
    }

    function syncControls() {
        for (const t of TYPES) {
            const on = t.id === state.type;
            t.button.classList.toggle('is-on', on);
            t.button.setAttribute('aria-pressed', String(on));
        }
        if (TYPES.costInput) TYPES.costInput.checked = state.costs;
        /* Hidden rather than disabled on the cost summary: a greyed-out control
           still asks the reader to work out why it does not apply. */
        if (TYPES.sortWrap) TYPES.sortWrap.hidden = !sortable();
    }

    function sortable() {
        return !!(TYPES.find((t) => t.id === state.type) || {}).sortable;
    }

    /* Copies before sorting — callers pass arrays they built from filter() and
       concat() today, but a future one passing state.records would otherwise
       reorder the loaded set under every other report. */
    function sortRows(rows) {
        const [field, dir] = state.sort.split('-');
        const sign = dir === 'asc' ? 1 : -1;
        return rows.slice().sort((a, b) => {
            if (field !== 'cost') return sign * (a.date - b.date);
            const d = (a.cost || 0) - (b.cost || 0);
            /* Ties fall back to date, and there are a LOT of ties: every
               odometer reading and every previous-owner record costs zero, so
               without this a cost sort would shuffle them into whatever order
               the engine happened to pick and print differently twice. */
            return d ? sign * d : a.date - b.date;
        });
    }

    /* ── The sheet ─────────────────────────────────────────────────── */

    function draw() {
        sheet.replaceChildren();
        /* The body is built first so the header can describe what it holds. */
        const body = state.type === 'routine' ? routine()
                   : state.type === 'full' ? full()
                   : costSummary();
        sheet.append(header(body.rtRows), body, footer());
    }

    function doPrint() {
        if (typeof window.printContainer !== 'function') {
            window.print();          // upstream moved it; printing the page still works
            return;
        }
        /* Serialised AFTER the DOM was built with textContent, so every value
           is escaped by the serialiser rather than trusted by us. */
        window.printContainer('<div class="rt-rep-sheet rt-rep-print-root">'
                              + sheet.innerHTML + '</div>');
    }

    /* ── Pieces ────────────────────────────────────────────────────── */

    function header(rows) {
        const type = TYPES.find((t) => t.id === state.type);
        const head = el('header', 'rt-rep-head');

        const brand = el('div', 'rt-rep-brand');
        const logo = document.createElement('img');
        logo.src = '/brand/icon.svg';
        logo.alt = '';
        logo.className = 'rt-rep-logo';
        brand.append(logo, el('span', 'rt-rep-wordmark', 'Road Track'));

        const meta = el('div', 'rt-rep-meta');
        meta.append(
            el('h2', 'rt-rep-title', type.label),
            el('p', 'rt-rep-vehicle', vehicleLabel(state.vehicle) || 'Vehicle'),
            el('p', 'rt-rep-range', rangeLine(rows)));

        head.append(brand, meta);
        return head;
    }

    /* The range describes THE ROWS ON THIS PAGE, not the vehicle.
     *
     * It used to read off every owned record regardless of report, so a
     * maintenance report whose first service was Nov 2023 was headed "Aug 2023
     * – Jul 2026" because a fuel receipt and an odometer entry sat outside it.
     * A header claiming a wider span than the table beneath it reads as rows
     * gone missing, which is the one thing a printed maintenance history must
     * never suggest. */
    function rangeLine(rows) {
        const parts = [];
        if (rows && rows.length) {
            let first = rows[0].date, last = rows[0].date;
            for (const r of rows) {
                if (r.date < first) first = r.date;
                if (r.date > last) last = r.date;
            }
            parts.push(`${dateOf(first)} – ${dateOf(last)}`);
        }
        parts.push(`prepared ${dateOf(new Date())}`);
        return parts.join(' · ');
    }

    function footer() {
        const f = el('footer', 'rt-rep-foot');
        const bits = [];
        if (state.anchor && state.anchor.date) {
            bits.push(`Measured from ${dateOf(state.anchor.date)}, when this vehicle was bought`
                + (state.anchor.odometer !== null
                    ? ` at ${distanceNumber(state.anchor.odometer)} ${distanceUnits()}` : '')
                + '. Anything older belongs to the previous owner and is left out.');
        }
        /* The order has to be ON the sheet. On screen the control says how the
           rows are sorted; on paper that control is gone, and a maintenance
           history running newest-first or by price looks like a date-ordered
           one with rows in the wrong places. Only when it is not the default —
           saying "oldest first" on every ordinary report is noise. */
        const sorted = SORTS.find((s) => s.id === state.sort);
        if (sortable() && sorted && sorted.note) bits.push(sorted.note);
        if (!state.costs) bits.push('Prices were deliberately left off this report.');
        f.textContent = bits.join(' ');
        return f;
    }

    /* Records this owner is responsible for — the anchor drops the previous
     * owner's paperwork, exactly as the dashboard does. */
    function owned() {
        return anchored(state.records, state.anchor);
    }

    function ownedReadings() {
        return anchored(state.readings, state.anchor)
            .concat(anchorReading(state.anchor, vehicleId));
    }

    function routine() {
        const rows = sortRows(owned().filter((r) => r.category === 'Service'));
        if (!rows.length) return empty('No service records on file for this vehicle.');

        const wrap = el('section', 'rt-rep-section');
        wrap.rtRows = rows;
        wrap.append(summaryLine([
            [`${rows.length}`, rows.length === 1 ? 'service' : 'services'],
            state.costs ? [money(total(rows)), 'total'] : null,
        ]));
        wrap.append(table(
            ['Date', `Odometer`, 'Work done', state.costs ? 'Cost' : null],
            rows.map((r) => [
                dateOf(r.date),
                r.odometer === null ? '—' : distanceNumber(r.odometer),
                r.description || '—',
                state.costs ? money(r.cost) : null,
            ])));
        return wrap;
    }

    function full() {
        /* Readings included on purpose: "full records" that silently omitted
           every odometer entry would not be full, and on a garage that logs
           mileage separately they are most of the file. */
        const rows = sortRows(owned().concat(ownedReadings()));
        if (!rows.length) return empty('No records on file for this vehicle.');

        const wrap = el('section', 'rt-rep-section');
        wrap.rtRows = rows;
        wrap.append(summaryLine([
            [`${rows.length}`, 'records'],
            state.costs ? [money(total(rows)), 'total'] : null,
        ]));
        wrap.append(table(
            ['Date', 'Type', 'Odometer', 'Description', state.costs ? 'Cost' : null],
            rows.map((r) => [
                dateOf(r.date),
                r.category === 'Odometer' ? 'Odometer' : r.category,
                r.odometer === null ? '—' : distanceNumber(r.odometer),
                r.description || (r.category === 'Odometer' ? 'Odometer reading' : '—'),
                state.costs ? (r.cost ? money(r.cost) : '—') : null,
            ])));
        return wrap;
    }

    function costSummary() {
        const rows = owned();
        if (!rows.length) return empty('No records on file for this vehicle.');

        const wrap = el('section', 'rt-rep-section');
        wrap.rtRows = rows;
        const measured = rows.concat(ownedReadings());
        const span = ownershipSpan(measured, new Date());
        const est = estimatedDistance(measured);
        const spent = total(rows);

        wrap.append(summaryLine([
            [money(spent), 'total spend'],
            span.months
                ? [money(spent / span.months),
                   `per month over ${span.months} month${span.months === 1 ? '' : 's'}`]
                : null,
            est.distance ? [moneyPrecise(spent / est.distance), `per ${fmt.distance}`] : null,
        ]));

        /* byCategory emits every category including the empty ones — a
           garage that logs no fuel and no tax would print "$0.00" rows for
           both, which on a printed report read as missing data rather than as
           absent spending. */
        const cats = byCategory(rows)
            .filter((c) => c.total > 0)
            .sort((a, b) => b.total - a.total);
        if (cats.length) {
            wrap.append(el('h3', 'rt-rep-h3', 'By category'));
            wrap.append(table(['Category', 'Spend', 'Share'],
                cats.map((c) => [c.category, money(c.total), pct(c.total, spent)])));
        }

        const systems = bySystem(rows).rows.slice(0, 8);
        if (systems.length) {
            wrap.append(el('h3', 'rt-rep-h3', 'By system'));
            wrap.append(table(['System', 'Spend', 'Share'],
                systems.map((b) => [b.system, money(b.total), pct(b.total, spent)])));
        }

        const top = topExpenses(rows, 10);
        if (top.length) {
            wrap.append(el('h3', 'rt-rep-h3', 'Biggest expenses'));
            wrap.append(table(['Date', 'Description', 'Cost'],
                top.map((r) => [dateOf(r.date), r.description || '—', money(r.cost)])));
        }
        return wrap;
    }

    /* ── Small builders ────────────────────────────────────────────── */

    function summaryLine(pairs) {
        const row = el('div', 'rt-rep-summary');
        for (const p of pairs.filter(Boolean)) {
            const box = el('div', 'rt-rep-figure');
            box.append(el('span', 'rt-rep-figure-value', p[0]),
                       el('span', 'rt-rep-figure-label', p[1]));
            row.append(box);
        }
        return row;
    }

    function table(headings, rows) {
        const cols = headings.filter((h) => h !== null);
        /* Figures are marked per COLUMN INDEX and the class goes on the cells
           themselves. A CSS-only version needs nth-child arithmetic that
           changes every time the price toggle removes a column. */
        const numeric = cols.map(isNumeric);
        const t = document.createElement('table');
        t.className = 'rt-rep-table';
        const thead = document.createElement('thead');
        const htr = document.createElement('tr');
        cols.forEach((h, i) => {
            const th = document.createElement('th');
            th.textContent = h;
            if (numeric[i]) th.className = 'rt-rep-num';
            htr.append(th);
        });
        thead.append(htr);
        const tbody = document.createElement('tbody');
        for (const r of rows) {
            const tr = document.createElement('tr');
            r.filter((c) => c !== null).forEach((cell, i) => {
                const td = document.createElement('td');
                if (numeric[i]) td.className = 'rt-rep-num';
                td.textContent = cell;      // never innerHTML — see file header
                tr.append(td);
            });
            tbody.append(tr);
        }
        t.append(thead, tbody);
        return t;
    }

    function empty(message) {
        return el('p', 'rt-rep-empty', message);
    }
}

const NUMERIC = ['Cost', 'Spend', 'Share', 'Odometer'];
const isNumeric = (h) => NUMERIC.includes(h);

function pct(part, whole) {
    if (!whole) return '—';
    return `${Math.round((part / whole) * 100)}%`;
}

function dateOf(d) {
    return d.toLocaleDateString(fmt.locale, {
        year: 'numeric', month: 'short', day: 'numeric',
    });
}

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
}

function iconEl(name) {
    const i = document.createElement('i');
    i.className = `bi ${name} me-2`;
    return i;
}
