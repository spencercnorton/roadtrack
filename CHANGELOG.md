# Changelog

Every release's entry here is also its GitHub Release notes. Versions follow
[semantic versioning](https://semver.org), and a release's image is never rebuilt.

## Unreleased

### Changed

- Garage posters below the fold download when they are scrolled to rather than
  with the page, which matters on a phone with a large garage. A poster whose
  photo file is missing shows the card's background instead of a broken-image
  icon.

### Fixed

- Negative amounts read `-$50.00` rather than `$-50.00`, and an amount that
  rounds to zero never shows a minus sign, in any locale.

## 2.1.0 — 2026-10-02

Built on LubeLogger v1.7.3 (was v1.7.0). Back up `/App/data` first: going back
to Road Track 2.0.x, and so to LubeLogger 1.7.0, with the same data is not
supported.

### Security

LubeLogger 1.7.1 fixed three access-control flaws, each reachable by a
signed-in user:

- [GHSA-c7rp-fp3h-h3vv](https://github.com/hargata/lubelog/security/advisories/GHSA-c7rp-fp3h-h3vv)
  (high): supply records of a vehicle the user has no access to could be
  modified through their id.
- [GHSA-qw92-hqxv-2x9g](https://github.com/hargata/lubelog/security/advisories/GHSA-qw92-hqxv-2x9g)
  (medium): supply records could be read through a plan template's id.
- [GHSA-9xp6-9ch3-qqmj](https://github.com/hargata/lubelog/security/advisories/GHSA-9xp6-9ch3-qqmj)
  (medium): another user's odometer records could be copied onto one's own
  vehicle.

The advisories list LubeLogger 1.6.8 and earlier, but 1.7.0, which Road Track
2.0.x is built on, does not carry the fixes either.

### Changed, from LubeLogger

- Settings has a new layout ("your settings have moved"), with two new
  options: dialogs that a stray click outside does not close, and notes that
  wrap in record lists instead of being cut short.
- A refused API request answers `403` rather than `401`. A request with no
  credentials still answers `401`.
- Images, documents and temporary files are served by the app, behind its
  sign-in, instead of as static files. API keys are accepted under `/api`,
  `/kiosk`, `/images`, `/documents` and now `/temp`.
- Vehicle image tags can be combined with `and` / `or`.

### Fixed

- **The About sentence in Settings now says Road Track.** The rewrite ran once,
  when the page loaded, and LubeLogger fills the Settings tab after that, so it
  never applied. It now runs whenever the tab is filled.

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
