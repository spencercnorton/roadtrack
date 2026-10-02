/* Render a REAL page from a running instance with the LOCAL brand assets
 * swapped in, then read the result back.
 *
 * This exists because preview.py's synthetic data can be kinder than a real
 * instance: it can serve a path a real instance 404s, carry a locale a real one
 * lacks, or generate tidy fuel records for a garage that logs none.
 *
 * preview.py is still the right tool for working offline on layout. This is the
 * one to trust before merging: everything except the files under test comes
 * from the running app, with its own login and its own records. It found three
 * real defects in the vehicle dashboard that the unit tests could not see — a
 * temporal-dead-zone throw, a collaborator panel crushed to a sixth of its
 * width by inherited Bootstrap grid classes, and a distance line that dived at
 * both ends because the first and last months are only partly covered.
 *
 * Usage:
 *   RT_BASE=https://roadtrack.example.com RT_COOKIE=<ACCESS_TOKEN value> \
 *     node tools/live-preview.mjs \
 *       '/Vehicle/Index?vehicleId=3' out.png [light|dark] [width] [height]
 *
 * Get RT_COOKIE by logging in once:
 *   curl -s -c - -X POST https://roadtrack.example.com/Login/Login \
 *     --data-urlencode userName=... --data-urlencode password=...
 * On an instance that signs in through OpenID Connect instead, copy the
 * ACCESS_TOKEN cookie out of a signed-in browser.
 *
 * Needs playwright-core on the box; it is not a dependency of this repo and CI
 * never runs this. `npx playwright-core` or point PLAYWRIGHT at an install.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.RT_BASE || '').replace(/\/+$/, '');
const COOKIE = process.env.RT_COOKIE;
if (!BASE || !COOKIE) {
    console.error([
        'usage: RT_BASE=https://roadtrack.example.com RT_COOKIE=<ACCESS_TOKEN value> \\',
        '         node tools/live-preview.mjs [route] [out.png] [light|dark] [w] [h]',
        'The header of this file says how to get the cookie.',
    ].join('\n'));
    process.exit(2);
}
const HOST = new URL(BASE).hostname;

const { chromium } = await import(
    process.env.PLAYWRIGHT || 'playwright-core');

const VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();
/* The Dockerfile substitutes this at build time; do the same here or every
 * ES import in the page 404s on a literal "__RT_VERSION__". */
const local = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')
    .replaceAll('__RT_VERSION__', VERSION);

const [route = '/Home', out = 'preview.png', theme = 'light',
       width = '1600', height = '1200'] = process.argv.slice(2);

const browser = await chromium.launch();
const ctx = await browser.newContext({
    viewport: { width: +width, height: +height },
    colorScheme: theme === 'dark' ? 'dark' : 'light',
});
await ctx.addCookies([{
    name: 'ACCESS_TOKEN', value: COOKIE, domain: HOST, path: '/',
    secure: BASE.startsWith('https:'),
}]);

/* shared.js is upstream's with our layer appended, and site.css upstream's with
 * our theme appended — exactly what the Dockerfile does at build time.
 *
 * `marker` is the first line of the local file, and it MATTERS: the running
 * instance already has a previous release of that same layer appended, so a
 * naive append serves BOTH copies. The deployed one runs first, and anything
 * guarded against double-application — `inject()` returns early once the
 * Metrics tab exists — silently keeps the OLD behaviour while the new code sits
 * below it doing nothing. That is a harness that reports a pass for a change it
 * never actually ran. Cut the old copy out before appending the new one. */
const appendLocal = (pattern, rel, type, marker) => ctx.route(pattern, async (r) => {
    const upstream = await r.fetch();
    let body = await upstream.text();
    if (marker) {
        const at = body.indexOf(marker);
        if (at !== -1) body = body.slice(0, at);
    }
    r.fulfill({
        response: upstream,
        body: body + '\n' + local(rel),
        headers: { ...upstream.headers(), 'content-type': type },
    });
});
await appendLocal('**/js/shared.js*', 'brand/roadtrack-ui.js', 'application/javascript',
                  '/* Road Track — UI layer over upstream LubeLogger.');
await appendLocal('**/css/site.css*', 'brand/roadtrack.css', 'text/css',
                  '/* ── Road Track — NorviTech theme');

for (const file of fs.readdirSync(path.join(REPO, 'brand/metrics'))) {
    await ctx.route(`**/brand/metrics/${file}*`, (r) => r.fulfill({
        contentType: file.endsWith('.css') ? 'text/css'
            : file.endsWith('.html') ? 'text/html' : 'application/javascript',
        body: local(`brand/metrics/${file}`),
    }));
}

const page = await ctx.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));

await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 60000 });
if (theme === 'dark') {
    await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
}
/* Wait for content, never for the network: LubeLogger holds a SignalR socket
 * open, so networkidle never arrives and the run just times out.
 *
 * Wait for OUR content first and on its own. An earlier version also accepted
 * `.lubelogger-body-container`, which exists on every LubeLogger page the
 * moment it parses — so the wait returned instantly, the screenshot caught a
 * half-loaded dashboard, and the run reported an empty readout as though the
 * page were broken. A check that can pass before the thing under test exists
 * is worse than no check. */
await page.waitForSelector('#rtv-body:not([hidden]), #rt-body:not([hidden])',
    { timeout: 45000 }).catch(() => {
        /* Not a Road Track surface at all (a plain LubeLogger page)? Then the
         * generic container is the right thing to wait for. Anything else is a
         * real failure. */
        if (!page.url().match(/\/Vehicle\/|\/brand\/metrics\//)) return;
        problems.push('TIMEOUT: Road Track content never appeared');
    });
await page.waitForTimeout(2000);
await page.screenshot({ path: out, fullPage: true });

/* Read the rendered figures back as text. A screenshot proves it drew; this
 * proves WHAT it drew, which is the half that silently goes wrong. */
const readout = await page.evaluate(() => {
    const read = (el) => el.textContent.trim().replace(/\s+/g, ' ');
    return {
        title: document.title,
        tiles: [...document.querySelectorAll('.rt-tile')].map(read),
        cards: [...document.querySelectorAll('.rt-card:not([hidden])')]
            .map((c) => read(c.querySelector('.rt-card-head') || c)),
        hidden: [...document.querySelectorAll('.rt-card[hidden]')].map((c) => c.id),
        notes: [...document.querySelectorAll('.rt-note')].map(read).filter(Boolean),
    };
});
console.log(JSON.stringify(readout, null, 2));

if (problems.length) {
    console.error('\nPROBLEMS:\n' + problems.join('\n'));
    process.exitCode = 1;
} else {
    console.error('\nno console errors.');
}
await browser.close();
