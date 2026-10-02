# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**[Report a vulnerability](https://github.com/spencercnorton/roadtrack/security/advisories/new)**.
Do not open a public issue, and do not include cookies, API keys, vehicle records, hostnames or
personal details in the report — a description and a minimal reproduction are enough.

There is no e-mail address for security reports; the advisory form is the only channel, and it is
the one that is monitored. You will get an acknowledgement within a week. Fixes ship as a tagged
release; the advisory is published once the release is out, and credits you unless you ask
otherwise.

A vulnerability in LubeLogger itself — its server, its API, its sign-in — belongs to
[LubeLogger](https://github.com/hargata/lubelog). If you are unsure which side a problem is on,
report it here and it will be sorted out.

## Supported versions

Only the latest tagged release is supported.

## What Road Track does, and trusts

- Road Track adds files to LubeLogger's image and changes none of its server code. Sign-in,
  permissions and storage are LubeLogger's; Road Track adds no endpoint, no database and no
  account of its own.
- Everything under `/brand/` is static and served without sign-in, including `/brand/config.json`.
  It holds code and, if you set them, the receipt channels (a bot name and an address) — never
  vehicle data. Vehicle data is read only from LubeLogger's API, in the signed-in user's browser,
  with that user's own permissions.
- The Access page is gated by the server, not by the page: its user list comes from LubeLogger's
  administrator-only endpoint, and every change goes through LubeLogger's own collaborator
  endpoints and their rules.
- The entrypoint accepts a `ROADTRACK_*` setting only if it matches a strict pattern; anything
  else is dropped with a warning in the container log, never escaped into the page. Text that
  users typed, such as a vehicle's make and model, is always inserted as text, never as markup.
- Single sign-on is LubeLogger's, and its "disable regular login" setting does not by itself
  make the identity provider the only way in: LubeLogger still accepts its own credentials on
  some routes. If that matters to you, apply the checklist in
  [docs/operations.md](docs/operations.md#single-sign-on-only) at your reverse proxy.
- The pages make no third-party requests and carry no analytics. The receipt links open Telegram
  or the device's mail client only when somebody presses them.
