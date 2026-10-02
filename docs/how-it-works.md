# How Road Track works

Road Track is LubeLogger's published image with files added. It contains no
copy of LubeLogger's code: no C#, no Razor views, no patched binaries. The
Dockerfile:

1. **copies** Road Track's files to `/App/wwwroot/brand/`, which LubeLogger
   already serves as static files;
2. **replaces** the images and the manifest whose paths LubeLogger hardcodes;
3. **appends** the theme to `css/site.css` and the UI layer to `js/shared.js`;
4. **starts** through a small entrypoint that writes the receipt settings to
   `/brand/config.json`, then runs LubeLogger's own command unchanged.

LubeLogger's own logo settings point at the Road Track artwork.

## Why it is not a fork

A fork has to be merged with every upstream release; a layer is simply
rebuilt. Moving to a new LubeLogger is a one-line change to
`ARG LUBELOGGER_VERSION`, and the build guards below fail the build if
upstream has moved something the layer depends on. All Road Track stores is
ordinary LubeLogger extra fields, so an instance can switch between the two
images at the same LubeLogger version, with
[one caveat](configuration.md#vehicle-fields-road-track-adds).

LubeLogger is MIT-licensed, by Hargata Softworks. Road Track renames the
product but not its authorship: the About panel keeps its credit to Hargata
Softworks and upstream's funding links, and both licence notices ship in the
image at `/usr/share/doc/roadtrack/`.

## What is branded, and how

| Surface | Mechanism |
|---|---|
| Accent colour throughout: buttons, links, focus rings, form controls | `roadtrack.css` appended to `site.css` |
| Logo on the login page and the garage; navbar logo | `LUBELOGGER_LOGO_URL`, `LUBELOGGER_LOGO_SMALL_URL` |
| Favicon; installed web app's name and icons | `/favicon.ico` and `/manifest.json` replaced |
| Apple touch icons and launch screen | three files in `/defaults/` replaced |
| Browser tab title, iOS home-screen title, one sentence in About | rewritten by `roadtrack-ui.js` |
| Garage cards drawn as photo posters | `roadtrack.css`, scoped to the garage |
| Calendar tab and Household controls hidden | `roadtrack.css`; old `?tab=calendar` links go to the garage |
| Vehicle Dashboard | `roadtrack-ui.js` replaces upstream's renderer |
| Finance, Reports and Collaborators tabs; Access tab for administrators | `roadtrack-ui.js` |
| Purchase and loan fields in the vehicle form | `roadtrack-ui.js`, as LubeLogger extra fields |
| Add a receipt button | `roadtrack-ui.js`, configured by `/brand/config.json` |

The palette is `#FD8024` (brand orange), `#2D2D2D` (chrome) and `#FFFFFF`.
Links on white use a darker `#A64E0B`, because the brand orange does not
reach WCAG AA contrast on white.

## Why the theme is appended to `site.css`

LubeLogger has a theme system: stylesheets in `data/themes/`, chosen by a
setting. Road Track cannot ship a theme there, because `/App/data` is a
volume at run time and would hide anything the image put in it. Appended to
`site.css`, the theme stays in the image, needs no setting, and also covers
pages seen before sign-in, such as `/Login`. It only recolours: each of its
selectors is one where upstream hardcodes its blue. The `.br` and `.gz` copies
of each modified file are deleted too. LubeLogger does not serve them today,
and this way a future release that does cannot serve the unbranded original.

## The UI layer rides in `shared.js`

LubeLogger's layout loads `js/shared.js` in the `<head>` of every page, so
`roadtrack-ui.js`, appended to it, runs everywhere without a proxy rule or a
changed view. The dashboard, Finance and Reports are ES modules under
`/brand/`, loaded when their tab first opens.

- LubeLogger draws a tab bar, a phone menu and an overflow menu, and copies
  nothing between them, so each Road Track tab is added to all three.
- LubeLogger records the open tab in the URL by the part of its id before
  the first hyphen. Road Track's ids (`rtfinance-tab` and so on) have no
  earlier hyphen, so its tabs survive a reload.
- LubeLogger's save routine collects every `.extra-field` in the form, named
  by its label, so it saves the purchase and loan fields itself. It only draws
  extra fields declared as templates, so Road Track refills saved values when
  the form opens; otherwise saving would blank them.

## Why three strings are rewritten in the browser

Three appearances of "LubeLogger" are compiled into its views, beyond the
reach of any file or setting: the ` - LubeLogger` title suffix, the
`apple-mobile-web-app-title` meta tag, and the About sentence "LubeLogger
utilizes open-source dependencies…". `roadtrack-ui.js` rewrites exactly
those three.

A reverse proxy could do this, and once did. In the browser the rewrite
follows the app to every hostname and proxy, and cannot be lost when a
proxy's configuration is regenerated. It is targeted, never a global replace:
upstream's funding link is `https://www.patreon.com/LubeLogger`, which a
blanket replace would break, and the About sentence is changed in text nodes
only. The title and meta tag are parsed before `shared.js` runs, so they
change before the first paint and the old name never flashes.

## The dashboard swap, and why the timing is safe

LubeLogger draws the Dashboard tab with a global function,
`getVehicleReport`, which `vehicle.js` declares as it is parsed and first
calls from a jQuery ready handler. Road Track replaces that global from a
`DOMContentLoaded` listener registered in `shared.js`. When the event fires,
`vehicle.js` has been parsed, and jQuery 3 runs ready handlers
asynchronously, after every `DOMContentLoaded` listener. So the replacement
is always in place before the first call, and upstream's dashboard is never
requested. This was verified in a browser, not inferred; verify it the same
way if either side changes. If the module fails to load, the replacement
falls back to upstream's dashboard, so the tab is never blank.

## Version stamping

Road Track's own files are requested with `?v=<Road Track version>`. The
build replaces the `__RT_VERSION__` placeholder in every text file under
`brand/`, every ES module `import` included, with the contents of `VERSION`,
and fails if a placeholder survives. Each release therefore lives at URLs no
cache has seen. The two appended files cannot be stamped, because LubeLogger
writes their URLs; see [caching](configuration.md#caching-proxies-and-cdns).

## The build guards

The shell's `>>` creates a file that does not exist. If LubeLogger renamed
`site.css`, the theme would be appended to a new orphan file and an image
with no theme would publish cleanly. So before each append the Dockerfile
checks that the target exists, is not empty, and still contains a marker the
layer depends on:

| File | Marker | Why |
|---|---|---|
| `css/site.css` | `lubelogger-mobile-nav` | the theme styles the phone menu through it |
| `js/shared.js` | `function printContainer` | Reports prints through it |

A third check requires `/App/CarCareTracker`. Setting an entrypoint resets the
base image's command, so the Dockerfile restates it, and an upstream change
there would otherwise publish a container that exits at start. Each check
fails with a message beginning `BRAND GUARD:`.

`tools/test_build_guard.sh` is the negative control for all three guards. A
control build against the unmodified LubeLogger image must succeed. The real
Dockerfile is then rebuilt against five broken copies (each appended file
renamed away, each rewritten without its marker, and the app's binary renamed),
and every one of those builds must fail with the message of the guard meant to
catch it.

The guards prove the files are where they were, not that the pages still
look as `roadtrack-ui.js` expects. It relies on about forty undocumented
details of upstream's markup and scripts (ids, classes, globals, the shape of
fragments it reads), and a release that changes one still builds cleanly; see
[Upgrading LubeLogger](operations.md#upgrading-lubelogger).

## Assets

`brand/icon.svg` and `brand/icon-maskable.svg` (the variant for platforms
that crop icons into shapes) are the sources of every bitmap; `brand/logo.svg`
is the wordmark, sized for the 204 × 48 px box LubeLogger draws logos in.
`tools/make-rasters.sh` regenerates the bitmaps, which are committed so the
build needs no SVG tools:

| File | Size | Used by |
|---|---|---|
| `icon-{72,128,144,192,512}.png` | as named | manifest, purpose `any` |
| `icon-maskable-{72,128,192,512}.png` | as named | manifest, purpose `maskable` |
| `favicon.ico` | 16, 32 and 48 px | browsers |
| `launch.png` | 1125 × 2436, icon centred on `#2D2D2D` | iOS launch screen |

`icon-128.png`, `icon-192.png` and `launch.png` are also copied over the
three `/defaults/` files LubeLogger's layout names. `tools/check.py` fails if
a colour pair the theme relies on drops below WCAG AA, an SVG stops parsing,
the wordmark outgrows its box, the bitmaps stop matching what `manifest.json`
and the layout ask for, the manifest loses the 192 and 512 px icons browsers
need before offering to install the app, or a stylesheet gains a stray
comment delimiter, which makes browsers silently drop rules.

Building, testing and releasing are covered in [development](development.md)
and [releasing](RELEASING.md).
