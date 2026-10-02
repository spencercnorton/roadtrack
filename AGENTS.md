# AGENTS.md

Guidance for coding agents working in this repository. People should start with
[CONTRIBUTING.md](CONTRIBUTING.md) and [docs/development.md](docs/development.md);
everything here is consistent with them.

Road Track is a layer of browser-side files over LubeLogger's published container
image. Read [README.md](README.md), then [docs/how-it-works.md](docs/how-it-works.md),
before changing anything.

## Before you touch anything

- **This is not a fork.** If you find yourself wanting to edit LubeLogger's C# or
  Razor, stop: the answer is almost always an upstream setting, a `COPY` in the
  `Dockerfile`, or a hook in `brand/roadtrack-ui.js`.
- **Do not blanket-replace "LubeLogger".** Upstream's funding link contains the
  word. The three replacements in `roadtrack-ui.js` are deliberately targeted.
- **Do not strip LubeLogger's attribution.** The About panel credits upstream's
  author and keeps their funding link.
- **Both navigations, always.** Upstream ships a tab bar and a separate phone menu
  (`.lubelogger-mobile-nav`), and nothing copies between them. A tab added to one
  only is missing on every phone, with no error anywhere.
- **Text as text.** Anything a user typed, and every setting, goes into the page as
  text or as a property, never as markup.
- **No private data in the tree, test fixtures included.** No names, e-mail
  addresses, licence plates, real vehicle records, hostnames or credentials. Use
  `example.com` and made-up numbers. The privacy scan rejects what it can
  recognise; the rest is on review.

## Gotchas that cost time to find

- `/App/data` is a volume at run time, so anything copied under it at build time
  is invisible. That is why the theme is appended to `site.css` rather than
  installed as a LubeLogger theme.
- The app serves plain files through `UseStaticFiles`, not `MapStaticAssets`, so
  the `.br`/`.gz` siblings in `wwwroot` are not served. The `Dockerfile` removes
  the ones next to files it modifies anyway, so an upstream upgrade cannot start
  serving stale pre-brand copies.
- `>>` creates a missing file. The BRAND GUARD checks in the `Dockerfile`, and
  `tools/test_build_guard.sh` proving they fire, are the only reason a green build
  means anything here.
- Assets loaded by URL carry `?v=__RT_VERSION__`, stamped from `VERSION` at build
  time, so every release busts its own cache. A placeholder left unstamped fails
  the build.
- A tab button's id must contain no hyphen before `-tab`; upstream writes the
  active tab into the URL by splitting at the first hyphen (see `addPaneTab`).
- Keep line 1 of `brand/roadtrack-ui.js` and `brand/roadtrack.css` unchanged:
  `tools/live-preview.mjs` finds the deployed copies by them.

## Checks

```bash
python3 tools/check.py           # brand assets
node tools/test_metrics.mjs      # the money and distance maths
sh tools/test_entrypoint.sh      # the runtime settings
sh tools/test_build_guard.sh     # Docker: the guards fire
sh tools/smoke_test.sh           # Docker: the image builds, starts and serves the layer
```

Nothing in CI opens a page. If you change what is drawn, render it with the
preview harness in [docs/development.md](docs/development.md), at a phone width
and in dark mode too, before calling it done.

## Changes

One concern per pull request. Commits are signed off (`git commit -s`). Behaviour
changes get a line under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md).
