# Changelog

Every release's entry here is also its GitHub Release notes. Versions follow
[semantic versioning](https://semver.org), and a release's image is never rebuilt.

## Unreleased

## 2.0.1 — 2026-10-02

### Fixed

- **Estimated values with a currency sign or spaced thousands.** An entry such as
  `2024-06 = $12,000` or `2024-06 = 12 000` was dropped or read as 12. Both now
  read as 12,000, and a space-grouped amount stops before the next entry's year.
- **A valuation that does not parse is skipped, not invented.** When no entry in
  the box parsed, the whole box was read as one "worth this today" figure, so
  `2024-06 = abc` became a valuation of 2,024 dated today. Only a box holding
  nothing but a number is read that way now.

## 2.0.0 — 2026-10-02

The first public release. Road Track has been in daily use on a private
instance; this release publishes it, with everything that belonged to that one
installation moved out of the code and into configuration.

### New

- **The Add a receipt button is configured at run time.** Its Telegram bot and
  receipts address come from `ROADTRACK_RECEIPT_TELEGRAM_BOT`,
  `ROADTRACK_RECEIPT_TELEGRAM_NAME` and `ROADTRACK_RECEIPT_EMAIL`, which the
  container's new entrypoint writes to `/brand/config.json`. Each value must
  match a strict pattern; a bad one is dropped with a warning in the container
  log. With neither channel set there is no button.
- **Images for amd64 and arm64** at `ghcr.io/spencercnorton/roadtrack`, each
  built natively and started on its own architecture before it is published.
  `latest` follows tagged releases.
- **A smoke test** builds the image, starts it, and checks that every file the
  brand layer changes is served changed.
- The licence notices — Road Track's and LubeLogger's — ship inside the image
  at `/usr/share/doc/roadtrack/`.

### In this release

Built on LubeLogger v1.7.0. A per-vehicle dashboard of running costs, a Finance
tab, named printable reports, a Collaborators tab, an administrators' Access
grid, purchase-anchored lifetime figures, cleaned odometer readings, the
NorviTech theme in light and dark, an installable web app, and phone layouts.
See the [user guide](docs/user-guide.md).
