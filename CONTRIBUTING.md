# Contributing to Road Track

Thanks for your interest. This is a small project with one maintainer, so the process is
deliberately light.

## How changes land

GitHub is the development home. Branch from `main` and open a pull request into `main`. The checks
must pass before merge. Changes ship in tagged releases.

Use a GitHub noreply address for commit authorship if you prefer to keep your personal address
private. Public history is public data.

## Working on the code

Road Track is a layer over LubeLogger's published image, so most of the work is in `brand/` —
plain CSS and JavaScript the browser loads — and almost none of it needs a build. The checks CI
runs are in [docs/development.md](docs/development.md); the ones to run before you push:

```bash
python3 tools/check.py           # brand assets: contrast, SVGs, CSS comments, rasters, manifest
node tools/test_metrics.mjs      # the money and distance maths behind every chart
sh tools/test_entrypoint.sh      # the runtime settings the entrypoint accepts and refuses
sh tools/test_build_guard.sh     # needs Docker: proves the build fails when upstream moves a file
```

- Nothing in CI opens a page in a browser. If you change what is drawn, run the preview harness in
  [docs/development.md](docs/development.md) and look at it, on a phone-sized window too.
- The UI hooks into LubeLogger's own markup and scripts. Name the upstream file and line you rely on
  in a comment, the way the existing code does, so the next upstream upgrade can be checked.
- Keep a change to one concern.
- Commits carry a `Signed-off-by:` line (`git commit -s`, the Developer Certificate of Origin).
  There is no CLA.
- No secrets, hostnames, personal data, real vehicle records or personal paths in the diff; the
  privacy check rejects the ones it can recognise, and the rest is on review.

## Out of scope

- Changes to LubeLogger's server code, database or Razor views. Road Track works over an
  unmodified upstream image, and that is what keeps an upgrade a one-line change.
- Removing or hiding LubeLogger's attribution or its funding link, or renaming "LubeLogger"
  wholesale.
- A receipt-reading or extraction service inside the image. The Add a receipt button links to
  services you run; it does not become one.
- Analytics, tracking or any request to a third party from the pages.

## Pull request checklist

- [ ] `python3 tools/check.py`, `node tools/test_metrics.mjs` and `sh tools/test_entrypoint.sh` pass
- [ ] Looked at in the preview harness if anything visible changed, light and dark, desktop and phone
- [ ] Commits are signed off
- [ ] `CHANGELOG.md` updated under `## Unreleased` if behaviour changed
