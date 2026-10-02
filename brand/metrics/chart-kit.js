/* Road Track — shared chart plumbing.
 *
 * Everything two or more Road Track surfaces need to draw an identical-looking
 * chart: number formatting, the theme tokens read off CSS custom properties,
 * the Chart.js option baseline, and the direct-label plugin.
 *
 * Extracted from metrics.js when the per-vehicle dashboard (vehicle-dash.js)
 * needed the same look inside LubeLogger's own page. The alternative was a
 * second copy of the tooltip/axis/palette rules, which drift apart the first
 * time only one of them is touched.
 *
 * No DOM ids and no page state live here — callers pass their own root element
 * and canvases. `Chart` is read off the global, because both callers load
 * upstream's vendored chart.umd.js rather than shipping a second copy.
 */

import { CATEGORIES } from './aggregate.js?v=__RT_VERSION__';

/* ── Chart.js defaults ──────────────────────────────────────────────── */

/* Off deliberately. Every filter change rebuilds these charts, so an entry
 * animation is a flash of empty plot on each interaction rather than polish —
 * and it makes what is on screen depend on when you look. */
export function applyChartDefaults() {
    Chart.defaults.animation = false;
    Chart.defaults.font.family =
        'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
}

/* ── Formatting ─────────────────────────────────────────────────────── */

/* LubeLogger reports the server's locale and currency symbol but not an ISO
 * currency code, so the symbol is prefixed onto a locale-formatted number
 * rather than run through Intl's currency style.
 *
 * `distance` is derived per selection; `baseDistance` is what the browser was
 * told at boot. Keeping both means selecting an hours-based vehicle and then
 * going back cannot strand the label on "hour" while the number underneath is
 * computed from odometer miles.
 *
 * Exported as a live object, not as copies of its fields — callers mutate it
 * (applyDistanceUnit) and every formatter here must see that immediately. */
export const fmt = {
    locale: undefined,
    symbol: '$',
    baseDistance: 'mile',
    distance: 'mile',
};

export function money(n, compact = false) {
    if (n === null || !Number.isFinite(n)) return '—';
    const opts = compact && Math.abs(n) >= 10000
        ? { notation: 'compact', maximumFractionDigits: 1 }
        : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
    return fmt.symbol + new Intl.NumberFormat(fmt.locale, opts).format(n);
}

/* Axis ticks are always compact, so one axis never mixes "$5,000.00" with
 * "$40K". Whole units only — the cents belong in the tooltip and the table. */
export function moneyAxis(n) {
    if (!Number.isFinite(n)) return '';
    return fmt.symbol + new Intl.NumberFormat(fmt.locale,
        { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function moneyPrecise(n) {
    if (n === null || !Number.isFinite(n)) return '—';
    return fmt.symbol + new Intl.NumberFormat(fmt.locale,
        { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(n);
}

/* "km" does not take an -s. Naive pluralisation renders "12,000 kms of
 * readings" for every metric user, which is the sort of thing that makes a
 * page look like nobody read it. */
export const distanceUnits = () =>
    (fmt.distance === 'km' ? 'km' : fmt.distance + 's');

/** A whole-number count of miles/km/hours, for distance readouts. */
export function distanceNumber(n) {
    if (n === null || !Number.isFinite(n)) return '—';
    return new Intl.NumberFormat(fmt.locale, { maximumFractionDigits: 0 }).format(n);
}

export const monthLabel = (key) => {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(fmt.locale,
        { month: 'short', year: 'numeric' });
};

/** "2018 Toyota RAV4", falling back to the plate then the bare id. */
export function vehicleLabel(v) {
    if (!v) return null;
    return [v.year, v.make, v.model].filter(Boolean).join(' ')
        || v.licensePlate || `Vehicle ${v.id}`;
}

/* ── Data access ────────────────────────────────────────────────────── */

export class AuthError extends Error {}

/* `culture-invariant` makes LubeLogger serialise cost as a JSON number and
 * date as yyyy-MM-dd. Without it both arrive locale-formatted and cannot be
 * parsed without knowing the server's culture. */
export async function api(path) {
    const res = await fetch(path, {
        headers: { 'culture-invariant': 'true' },
        credentials: 'same-origin',
    });
    if (res.status === 401 || res.status === 403) throw new AuthError();
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return res.json();
}

/* Locale and currency symbol, straight into `fmt`. Never throws for anything
 * but auth: the dashboard is not worth failing over a currency symbol. */
export async function loadFormatting() {
    try {
        const info = await api('/api/info');
        fmt.locale = info.locale || undefined;
        /* "¤" is the generic CURRENCY SIGN the invariant culture returns
         * when no locale is configured — it means "unknown", not a currency, so
         * it is not something to print beside a number. The real fix is
         * LUBELOGGER_LOCALE_OVERRIDE on the container; this keeps the page
         * readable if that is ever unset again. */
        const symbol = (info.currencySymbol || '').trim();
        fmt.symbol = (!symbol || symbol === '¤') ? '$' : symbol;
    } catch (e) {
        if (e instanceof AuthError) throw e;
    }
}

/* ── Theme tokens ───────────────────────────────────────────────────── */

/* Read off the CSS custom properties rather than restated in JS, so light/dark
 * and any future palette edit stay in metrics.css alone. */
export function tokens(root) {
    const cs = getComputedStyle(root);
    const v = (name) => cs.getPropertyValue(name).trim();
    return {
        surface: v('--surface'),
        ink: v('--ink'),
        ink2: v('--ink-2'),
        muted: v('--ink-muted'),
        grid: v('--grid'),
        axis: v('--axis'),
        series: CATEGORIES.map((_, i) => v(`--series-${i + 1}`)),
    };
}

export const seriesColour = (category, t) => t.series[CATEGORIES.indexOf(category)];

/** `scope` can't be set via a property, and this keeps the table builders terse. */
export function withScope(th, scope) {
    th.setAttribute('scope', scope);
    return th;
}

/** A colour chip. Built, not interpolated — never an innerHTML sink. */
export function swatch(colour) {
    const span = document.createElement('span');
    span.className = 'rt-swatch';
    span.style.background = colour;
    return span;
}

export const swatchFor = (category, t) => swatch(seriesColour(category, t));

/** Hex → rgba, for the 10%-opacity area wash under a line. */
export function wash(hex, alpha = 0.12) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
    if (!m) return hex;
    const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ── Chart defaults ─────────────────────────────────────────────────── */

export function baseOptions(t, { stacked = false, money: isMoney = true } = {}) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { display: false },   // rendered as HTML, see renderLegend()
            tooltip: {
                backgroundColor: t.surface,
                titleColor: t.ink,
                bodyColor: t.ink2,
                borderColor: t.axis,
                borderWidth: 1,
                padding: 10,
                cornerRadius: 6,
                displayColors: true,
                boxWidth: 8,
                boxHeight: 8,
                boxPadding: 4,
                usePointStyle: true,
                callbacks: {
                    label: (ctx) => {
                        /* Read the VALUE axis, not blindly y. On the
                           horizontal category chart (indexAxis: 'y') parsed.y
                           is the category index — a number, so `y ?? x` never
                           falls through and every bar reported its position
                           as money ("Fuel: $0.00" on a four-figure bar). */
                        const v = ctx.chart.options.indexAxis === 'y'
                            ? ctx.parsed.x : ctx.parsed.y;
                        if (v === null || v === undefined) {
                            return `${ctx.dataset.label}: no data`;
                        }
                        return `${ctx.dataset.label}: ${isMoney ? money(v) : v}`;
                    },
                },
            },
        },
        scales: {
            x: {
                stacked,
                grid: { display: false },
                border: { color: t.axis },
                ticks: { color: t.muted, maxRotation: 0, autoSkipPadding: 16 },
            },
            y: {
                stacked,
                beginAtZero: true,
                grid: { color: t.grid, drawTicks: false },   // solid hairline, never dashed
                border: { display: false },
                ticks: {
                    color: t.muted,
                    padding: 8,
                    callback: (v) => (isMoney ? moneyAxis(v) : v),
                },
            },
        },
    };
}

/* Horizontal-bar option block. Bars name themselves on the y axis, so these
 * charts never carry a legend and hover per-bar rather than per-index.
 *
 * `values` is the data about to be plotted, and is only used to reserve room at
 * the right-hand end for the direct labels (see barValueLabelPlugin). Chart.js
 * sizes the axis to the data, so without the headroom the longest bar — the one
 * whose figure people came to read — is the one whose label gets clipped. */
export function horizontalBarOptions(t, valueFormat = moneyAxis, values = null) {
    const max = values && values.length ? Math.max(...values, 0) : 0;
    return {
        ...baseOptions(t),
        indexAxis: 'y',
        interaction: { mode: 'nearest', intersect: true },
        scales: {
            x: {
                beginAtZero: true,
                suggestedMax: max ? max * 1.18 : undefined,
                grid: { color: t.grid, drawTicks: false },
                border: { display: false },
                ticks: { color: t.muted, callback: (v) => valueFormat(v) },
            },
            y: {
                grid: { display: false },
                border: { color: t.axis },
                ticks: { color: t.ink2 },
            },
        },
    };
}

/* The figure at the end of every bar on a horizontal bar chart.
 *
 * Without it the only way to read a value is to hover it, which is no way at
 * all on a touch screen and no way at all for anyone scanning down the rows to
 * compare two of them. "Spend by system" is a ranked list of amounts whose
 * amounts were invisible.
 *
 * Always drawn OUTSIDE the bar, in the body ink. Putting it inside the bar
 * would look tidier on the long rows and would put text on top of a saturated
 * series colour — five palette slots, two themes, and no contrast guarantee for
 * any of the ten combinations. Outside, the label sits on the card surface,
 * which is the pairing the theme already checks (tools/check.py).
 */
export const barValueLabelPlugin = {
    id: 'rtBarLabels',
    afterDatasetsDraw(chart, _args, opts) {
        if (!opts || !opts.labels) return;
        const { ctx, chartArea } = chart;
        const bars = (chart.getDatasetMeta(0) || {}).data || [];
        ctx.save();
        ctx.font = '600 12px ' + Chart.defaults.font.family;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = opts.colour;
        bars.forEach((bar, i) => {
            const text = opts.labels[i];
            /* A zero-length bar's label would float against the axis reading as
               if it belonged to the row below; the table has that value. */
            if (!text || bar.x <= chartArea.left + 1) return;
            if (bar.x + 8 + ctx.measureText(text).width > chartArea.right) return;
            ctx.fillText(text, bar.x + 8, bar.y);
        });
        ctx.restore();
    },
};

/* Direct-label the last point of each line. "Lines get their value at the end"
 * — one label on the point that matters, rather than a number on every point,
 * which nobody reads. Skipped when it would overhang the plot.
 *
 * `opts.series` is one entry per dataset, in dataset order, each `{ text }` or
 * null to skip that line. An array rather than a single `text` because the
 * ownership chart draws three lines and a legend alone makes the reader look
 * back and forth to find which is which at the end — which is where the answer
 * is. Labels wear `opts.colour` (body ink), never the series colour: text is
 * text, and the mark beside it already carries identity.
 */
export const endLabelPlugin = {
    id: 'rtEndLabel',
    afterDatasetsDraw(chart, _args, opts) {
        if (!opts || !opts.series) return;
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.font = '600 12px ' + Chart.defaults.font.family;
        ctx.fillStyle = opts.colour;
        ctx.textAlign = 'right';

        const taken = [];
        opts.series.forEach((entry, d) => {
            if (!entry || !entry.text) return;
            const data = (chart.data.datasets[d] || {}).data || [];
            const pts = (chart.getDatasetMeta(d) || {}).data || [];
            let last = null;
            for (let i = pts.length - 1; i >= 0; i--) {
                if (data[i] !== null && data[i] !== undefined) { last = pts[i]; break; }
            }
            if (!last) return;
            // Horizontal room is the only hard requirement; if there isn't any,
            // the axis and tooltip still carry the value.
            if (last.x - ctx.measureText(entry.text).width - 10 <= chartArea.left) return;
            /* A cumulative line ENDS at its maximum, so the last point sits
               against the top of the plot and a label above it would be
               clipped. Flip below the point in that case rather than dropping
               the one label the chart actually needs. */
            const above = last.y > chartArea.top + 16;
            const y = last.y + (above ? -6 : 6);
            /* Two lines that finish close together would stack their labels on
               top of each other and render as one unreadable smudge. The later
               dataset's label is dropped — its value is in the legend-adjacent
               tooltip and in the table, and an illegible label is worse than
               no label. */
            if (taken.some((prev) => Math.abs(prev - y) < 14)) return;
            taken.push(y);
            ctx.textBaseline = above ? 'bottom' : 'top';
            ctx.fillText(entry.text, last.x - 6, y);
        });
        ctx.restore();
    },
};

/* A line dataset in the house style. Every line on both surfaces is one of
 * these; the only per-caller choices are the colour and whether it fills. */
export function lineDataset(label, values, colour, t, { fill = true } = {}) {
    return {
        label,
        data: values,
        borderColor: colour,
        backgroundColor: fill ? wash(colour) : undefined,
        borderWidth: 2,
        fill,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: t.surface,
        pointHoverBackgroundColor: colour,
        spanGaps: false,   // a gap is missing data, not a straight line
    };
}

/** Destroy-then-create, keyed by name. Chart.js leaks a canvas otherwise. */
export function chartDrawer() {
    const charts = {};
    const draw = (key, canvas, config) => {
        charts[key]?.destroy();
        charts[key] = new Chart(canvas, config);
    };
    draw.destroyAll = () => {
        for (const k of Object.keys(charts)) {
            charts[k]?.destroy();
            delete charts[k];
        }
    };
    return draw;
}
