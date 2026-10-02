# Development

Road Track is a layer of browser-side files over LubeLogger's published image, so
most work is plain CSS and JavaScript in `brand/`, and almost none of it needs a
build. This guide covers the checks, the preview harness, and working against
LubeLogger's markup. How the layer is applied is in [How it works](how-it-works.md).

## Layout

| Path | What it is |
|---|---|
| `brand/` | Everything the browser loads: the theme (`roadtrack.css`), the UI layer (`roadtrack-ui.js`), the dashboard and finance engine (`metrics/`), reports (`reports/`), the Access page (`access/`), the icons, logo and web app manifest |
| `docker/entrypoint.sh` | Writes `/brand/config.json` from the `ROADTRACK_*` settings, then starts LubeLogger |
| `Dockerfile` | `FROM` LubeLogger's image: copies `brand/`, appends the theme and the UI layer, stamps the version, and guards each step |
| `tools/` | The checks, the preview harness, raster generation and the release helper |
| `scripts/` | The privacy gate that CI runs on every change |

## Checks

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs these on every
pull request, and every one of them runs locally the same way.

| CI check | Command | What it proves |
|---|---|---|
| `checks` | `python3 tools/check.py` | The contrast ratios the theme's comments claim (WCAG AA), that every SVG parses, the comment structure of every stylesheet in `brand/` (a stray `*/` silently drops a whole block), the wordmark's width, and that the raster set matches what the manifest and LubeLogger's layout ask for |
| `checks` | `node tools/test_metrics.mjs` | The money and distance maths in `brand/metrics/aggregate.js`. Every money bug the project has had is pinned here |
| `checks` | `sh tools/test_entrypoint.sh` | The settings the entrypoint accepts, and that hostile values are dropped with a warning rather than escaped into the page |
| `build-guard` | `sh tools/test_build_guard.sh` | The negative control: the Dockerfile is rebuilt against LubeLogger images with `site.css` or `shared.js` renamed or rewritten, and each build must fail, naming the right guard |
| `image (amd64)`, `image (arm64)` | `sh tools/smoke_test.sh` | The image builds, starts through the entrypoint, and serves every file the layer changes, changed |
| `Privacy scan` | `python3 scripts/check_public_content.py` | No e-mail addresses, private addresses, personal paths or private repository links in new content; gitleaks scans the whole history |

The last three need Docker. `test_build_guard.sh` exists because the layer is
installed with `cat brand/... >> upstream-file`, and `>>` creates a missing file:
without the guards, an upstream rename would publish a green image with no theme,
no tabs and no dashboard. Do not weaken it into a smoke test; that is what
`smoke_test.sh` is for.

## Looking at it

Nothing in CI opens a page in a browser, and the UI layer relies on roughly forty
of LubeLogger's selectors, ids and globals. If you change what is drawn, look at
it.

**The preview harness** serves the working tree's `brand/` with a mock LubeLogger
API and synthetic records, and takes LubeLogger's own bundles (Bootstrap, jQuery,
Chart.js, the themed `site.css`) from a running container:

```bash
docker build -t roadtrack-local . && docker run -d --rm -p 8080:8080 --name rt-local roadtrack-local
python3 tools/preview.py                    # http://127.0.0.1:8899/
```

`RT_UPSTREAM` points it at another instance (default `http://127.0.0.1:8080`). The
bundles are cached in `/tmp/rt-preview-cache`; delete it after changing the
LubeLogger version. These switches shape the synthetic garage, and combine:

| Variable | The garage it gives you |
|---|---|
| `REALISTIC=1` | No fuel and no tax records, plus a previous owner's zero-cost records: a garage that logs only receipts |
| `SPARSE=1` | Odometer readings only in the first quarter of the history, the way a casual user files receipts |
| `ODOMETER=1` | Mileage only in odometer records, none on any receipt |
| `ANCHORED=1` | A purchase date and an odometer at purchase, plus the big post-purchase service behind the per-mile spike |
| `FINANCED=1` | A loan on vehicle 1, with valuations; `FINANCED=cash` buys it outright instead |
| `VALUED=1` | Vehicle 2 with no price and one typed valuation |
| `DARK=1` | Every page as upstream renders it with dark mode on |

**The tab check** drives headless Chrome through the vehicle page's injected tabs —
that each one opens, that the Collaborators buttons work, that the phone menu has
them too:

```bash
REALISTIC=1 ANCHORED=1 FINANCED=1 VALUED=1 python3 tools/preview.py 8909 &
pip install websockets                       # once
python3 tools/check_vehicle_tabs.py          # CHROME=/path/to/chrome if google-chrome is not on PATH
```

**The live preview** is the one to trust before merging: it renders a real page
from a running instance, with its own login and records, and swaps in only the
local files under test. It needs `playwright-core`:

```bash
RT_BASE=https://roadtrack.example.com RT_COOKIE=<ACCESS_TOKEN cookie> \
  node tools/live-preview.mjs '/Vehicle/Index?vehicleId=1' out.png dark
```

Look at a phone width as well as a desktop one, and at dark mode as well as light.

## Working against LubeLogger's markup

- Name the upstream file and line you rely on in a comment, as the existing code
  does (`_Layout.cshtml:44`, `vehicle.js:94`). The next upgrade is checked against
  those names.
- Upstream ships two navigations — the tab bar and a separate phone menu,
  `.lubelogger-mobile-nav` — and nothing copies between them. Anything added to
  one goes in both.
- Keep the first line of `brand/roadtrack-ui.js` and of `brand/roadtrack.css` as it
  is: `tools/live-preview.mjs` uses them to find the deployed copies inside
  `shared.js` and `site.css`.
- Text a user typed, or a setting, goes in as text, never as markup.
- Upgrading LubeLogger is a one-line change to `LUBELOGGER_VERSION` in the
  `Dockerfile`. The guards cover the two appended files; for everything else, read
  upstream's changes to the views and scripts `brand/roadtrack-ui.js` names, and
  run the tab check and the live preview. See [Operations](operations.md).

## Icons

`tools/make-rasters.sh` regenerates every PNG and the `.ico` in `brand/` from
`icon.svg` and `icon-maskable.svg`; it needs `rsvg-convert` (librsvg) and
ImageMagick. The rasters are committed because CI has no SVG toolchain, and
`check.py` fails if they drift from what the manifest and LubeLogger's layout ask
for. Chromium offers to install the web app only when both the 192 and 512 pixel
icons are declared.

## Releasing

See [Releasing](RELEASING.md).
