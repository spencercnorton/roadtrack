# Configuration

Road Track is configured entirely through the container's environment.
[`docker-compose.example.yml`](../docker-compose.example.yml) is a working
starting point.

## The container

| | |
|---|---|
| Image | `ghcr.io/spencercnorton/roadtrack`, for `linux/amd64` and `linux/arm64` |
| Tags | one per release (`v2.0.0`, …), never rebuilt; `latest` is the newest release |
| Built on | `ghcr.io/hargata/lubelogger` at the release's `LUBELOGGER_VERSION` (v1.7.0 for 2.0.0) |
| Port | `8080`, plain HTTP |

| Volume | Holds | Without it |
|---|---|---|
| `/App/data` | LubeLogger's database, documents, images and settings, including every field Road Track adds | the data goes with the container |
| `/root/.aspnet/DataProtection-Keys` | the keys that encrypt sign-in cookies | everyone is signed out whenever the container is recreated |

Treat the keys volume as a secret: whoever holds it can forge a sign-in
cookie for any account, root included.

A new instance has no sign-in, and until it is turned on **every visitor is
the root user**. Turn it on under **Settings → Enable Authentication** before
the port is reachable by anyone else. For sign-in through an OpenID Connect
provider, see [Single sign-on only](operations.md#single-sign-on-only).

## Environment variables

| Variable | Accepted value | Effect |
|---|---|---|
| `ROADTRACK_RECEIPT_TELEGRAM_BOT` | a bot username without `@`: 5–32 letters, digits or `_`, starting with a letter | an **Add a receipt** entry linking to `https://t.me/<bot>`, or from a vehicle page `https://t.me/<bot>?start=v<vehicleId>` |
| `ROADTRACK_RECEIPT_TELEGRAM_NAME` | 1–40 letters, digits, spaces, `.` or `-`, starting with a letter or digit | that entry reads "Send a photo to *name*" instead of "Send a photo on Telegram" |
| `ROADTRACK_RECEIPT_EMAIL` | an e-mail address | a "Forward the email to *address*" entry: a `mailto:` link whose subject, from a vehicle page, is the vehicle's year, make and model |
| `LUBELOGGER_LOGO_URL` | `/brand/logo.svg` | the Road Track wordmark on the login page and the garage |
| `LUBELOGGER_LOGO_SMALL_URL` | `/brand/icon.svg` | the Road Track icon in the navbar |
| `LUBELOGGER_LOCALE_OVERRIDE` | e.g. `en-GB` | number, date and currency formats. Unset, LubeLogger prints money with the generic sign `¤`, and Road Track's charts fall back to `$` |
| `LUBELOGGER_DOMAIN` | e.g. `https://roadtrack.example.com` | the public address in the links LubeLogger e-mails |
| `TZ` | e.g. `Europe/London` | the server's time zone |
| `OpenIDConfig__*` | see below | OpenID Connect sign-in |

The `ROADTRACK_*` variables are optional, and the **Add a receipt** button
appears, on the garage and every vehicle page, only when the bot or the
address is set. Every other LubeLogger setting (SMTP, PostgreSQL, cookie
lifetime and so on) works as [its documentation](https://docs.lubelogger.com/)
describes.

LubeLogger's OpenID Connect settings, each prefixed `OpenIDConfig__`, are
`Name`, `ClientId`, `ClientSecret`, `AuthURL`, `TokenURL`, `RedirectURL`
(`https://roadtrack.example.com/Login/RemoteAuth`), `Scope` (default
`openid email`), `UsePKCE`, `ValidateState`, `JwksURL` (turns on id_token
signature checks), `UserInfoURL`, `LogOutURL`, and the flags
`DisableRegularLogin`, `DisableRegistration` and `AutoGenerateTokens`, whose
real effect is in [operations](operations.md#single-sign-on-only).

### How the receipt settings reach the page

Road Track's pages are static files and cannot read the environment. At
every start the entrypoint writes the `ROADTRACK_*` values to
`/App/wwwroot/brand/config.json` (`receiptTelegramBot`,
`receiptTelegramName`, `receiptEmail`), then starts LubeLogger unchanged.
Pages revalidate the file on each load. A value that fails its pattern is
dropped and logged (`roadtrack: ignoring ROADTRACK_RECEIPT_EMAIL: not a valid
value`). If the file cannot be written, as on a read-only root filesystem,
the button stays off and the log says `roadtrack: cannot write …`. A
container keeps the environment it was created with, so a change needs
`docker compose up -d`, not a restart.

The Telegram parameter is added only for a numeric vehicle id. The bot then
receives `/start v<vehicleId>` and can file the next photo against that
vehicle without asking. Road Track never handles receipts itself: the bot and
the mailbox are services you run, and it only links to them.

## Vehicle fields Road Track adds

Five fields join LubeLogger's own **Purchased Date**, **Purchased Price**,
**Sold Date** and **Sold Price** in the vehicle form's **Purchase/Sold
Information** panel. They are ordinary LubeLogger extra fields: stored in its
database, returned by `/api/vehicles` under `extraFields`, and matched by
name, ignoring case.

| Field | Enter | Examples |
|---|---|---|
| Odometer at purchase | the reading on the day you bought it, in the vehicle's own unit | `60000`, `60,000 mi` |
| Down payment | the deposit | `2000`, `£2,000` |
| Loan APR | the annual rate on the agreement, as a percentage | `5.9`, `5.9%` |
| Loan term (months) | the number of monthly payments; blank if bought outright | `60`, `60 months` |
| Estimated values | what the vehicle has been worth, with dates | `2024-06 = 12000, 2026-01 = 10000` |

The first four ignore currency symbols, units, letters and spaces. A full
stop is always the decimal point and a comma always a thousands separator,
whatever the locale, so `2,5` reads as 25. A negative value counts as none.

**Estimated values** is a list of `date = amount` entries. The date is
`YYYY`, `YYYY-MM` or `YYYY-MM-DD` (a missing month or day means January or
the 1st), and `:` works in place of `=`. The amount is digits, with commas
allowed as thousands separators. A currency symbol, space or minus sign
breaks the entry, so `2024-06 = $12000` and `2024-06 = 12 000` are both
misread. Text between entries is skipped, a lone number with no date means
"worth this today", and if a date appears twice the later entry wins. The
purchase and sale prices, on their dates, are added as the first and last
points automatically.

LubeLogger's own form does not display these fields, and saving a vehicle
replaces its whole record. A vehicle edited and saved in LubeLogger without
Road Track therefore loses them.

## Behind a reverse proxy

- Terminate TLS at the proxy and forward to port 8080. LubeLogger does not
  work out its public address from requests, so set `LUBELOGGER_DOMAIN` and
  `OpenIDConfig__RedirectURL` explicitly.
- LubeLogger lifts its own upload limits, so the proxy's is the one people
  hit: nginx's default `client_max_body_size` of 1 MB refuses most
  photographed receipts with a 413.
- `/brand/` is public static files, like `/css/` and `/js/`. Anyone who can
  reach the host can fetch the empty pages of the dashboard, Finance, Reports
  and Access. The data in them comes only from LubeLogger, and only to
  signed-in users (administrators, for Access).

## Caching proxies and CDNs

Road Track appends to `/css/site.css` and `/js/shared.js`, which LubeLogger
requests with its own version in the query string (`?v=1.7.0`) and serves
with no `Cache-Control`. The URL changes with LubeLogger, not with Road Track,
so a cache that picks its own lifetime (hours, on some CDNs) can keep serving
the previous release after an upgrade, even to a private window.

| Path | Changes with | Advice |
|---|---|---|
| `/css/site.css`, `/js/shared.js`, any query string | every Road Track release | send `Cache-Control: no-cache` from the proxy so caches revalidate (a cheap `304`), or purge both on every upgrade |
| `/brand/**/*.js`, `/brand/**/*.css` | every release, via `?v=<Road Track version>` | cache freely |
| `/brand/config.json` | every container start | do not cache at the edge |
| `/favicon.ico`, `/manifest.json`, `/defaults/*.png`, `/brand/*.svg`, `/brand/*.png` | the artwork | purge once after switching from LubeLogger |

Match the first row on the path: the Access page requests `/css/site.css`
with no query string. To check a deployment, fetch the URL the page
requests; a cache-busting parameter of your own skips the cache and shows
the new file while visitors still get the old one.
