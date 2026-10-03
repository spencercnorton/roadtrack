# Operations

Upgrades, pinning and rollback, backups, logs, and making single sign-on the
only way in. Settings are in [configuration](configuration.md).

## Pinning and rollback

Each release is published as `ghcr.io/spencercnorton/roadtrack:vX.Y.Z` and
never rebuilt; `latest` moves to each new release. Pin a version tag to
upgrade when you choose, not whenever the container is next recreated.

To roll back, set the previous tag and run `docker compose up -d`. Road Track
keeps nothing outside LubeLogger, so that is all it takes when both images
carry the same LubeLogger version (the Dockerfile's `ARG LUBELOGGER_VERSION`
at each release's tag). If the newer image also upgraded LubeLogger, restore
the backup taken before the upgrade: LubeLogger may change what it stores,
and rolling an image back does not roll its data back.

## Upgrading LubeLogger

Each release is built on one LubeLogger version. For a newer one, take the
Road Track release that adopts it, or back up and build your own image:

```sh
docker build --build-arg LUBELOGGER_VERSION=vX.Y.Z -t roadtrack:local .
```

| If the new LubeLogger… | the result is |
|---|---|
| renames, empties or removes `css/site.css` or `js/shared.js`, or drops their markers | the build fails with `BRAND GUARD` |
| no longer starts as `/App/CarCareTracker` | the build fails |
| changes an id, class, global or HTML fragment `roadtrack-ui.js` relies on | the build passes and a feature breaks |
| rewords the page title, the iOS title tag or the About sentence | the build passes and "LubeLogger" shows again |
| changes the JSON its API returns | the build passes and the Dashboard, Finance or Reports misread data |

So read LubeLogger's release notes for changes to its layout, `vehicle.js`,
`shared.js`, and the vehicle and admin views, then check in a browser: the
Dashboard's figures match the records; Finance, Reports and Collaborators
open from the tab bar and the phone menu and survive a reload; the vehicle
form shows the purchase fields with their values; a report prints; Access
lists accounts; and the tab title ends in "Road Track".

## Backups

Back up both volumes:

- **`/App/data`** holds everything LubeLogger stores, every Road Track field
  included. This is the one that matters.
- **`/root/.aspnet/DataProtection-Keys`** only spares everyone a sign-out
  after a restore. It is a secret; store it encrypted.

For a consistent copy, stop the container first. Compose prefixes volume
names with the project name, so `docker volume ls` shows the real names:

```sh
docker compose stop roadtrack
docker run --rm -v roadtrack_data:/data -v "$PWD":/backup alpine \
    tar czf /backup/roadtrack-data.tgz -C /data .
docker compose start roadtrack
```

LubeLogger can also make an archive while running, under **Settings →
Backups**. If its data is in PostgreSQL (`POSTGRES_CONNECTION`), back that
database up too.

## Logs

`docker compose logs roadtrack` shows LubeLogger's log and the entrypoint's.
Road Track's own lines begin `roadtrack:`, for a refused receipt setting or a
configuration file it could not write. Two LubeLogger lines are worth knowing:

- `User <address> tried to login via OpenID but is not a registered user in
  LubeLogger.` gives the exact address the identity provider sent. Check it
  first when someone cannot get in.
- `Failed Login for <username> from <address>` is a refused password
  sign-in, with `X-Forwarded-For` appended when a proxy sends it.

In the browser, a Road Track tab that fails to load logs an error prefixed
`Road Track` to the console.

## Single sign-on only

LubeLogger signs people in through OpenID Connect with its
[`OpenIDConfig__*` settings](configuration.md#environment-variables), but its
"disable regular login" flag alone does not make that the only way in. The
behaviour below is LubeLogger 1.7.3's, read from its source (unchanged since
1.7.0, except that a refused API request now answers 403 rather than 401).

**What the flag does.** `OpenIDConfig__DisableRegularLogin=true` sends
`/Login`, and the registration and password-reset pages, straight to the
provider on every hostname, but only when `OpenIDConfig__LogOutURL` is also
set; without one it is ignored. It does **not** turn off passwords:
`POST /Login/Login` still accepts a username and password, every route still
accepts an HTTP `Authorization: Basic` header, and `POST /Login/Register`
still creates a password account for anyone holding a registration token.
Accounts created through single sign-on have no password, so password
sign-in refuses them. Root always has one, because creating it is how
authentication is turned on.

**Who can register.** LubeLogger matches the e-mail address the provider
sends (the `email` claim, or the UserInfo endpoint) against its accounts, at
the first sign-in and every later one. An unknown address gets a
registration page, which needs a registration token for that address:

- `OpenIDConfig__AutoGenerateTokens=true` fills one in on the spot, so
  **anyone the provider lets through can create an account**;
- otherwise `LUBELOGGER_OPEN_REGISTRATION=true` lets the page e-mail one,
  which needs SMTP;
- otherwise only a token an administrator issues will do;
- `OpenIDConfig__DisableRegistration=true` shows "Access Denied" instead.

An auto-generated token is an ordinary registration token. Posted to
`/Login/Register` with a password, it makes a password account for that
address. New accounts see an empty garage until a vehicle is shared with
them, and someone whose address changes at the provider is a stranger to
LubeLogger.

**Checklist.**

1. Turn on authentication and give root a long, unique password.
2. Set `OpenIDConfig__RedirectURL=https://roadtrack.example.com/Login/RemoteAuth`,
   `OpenIDConfig__DisableRegularLogin=true`, and `OpenIDConfig__LogOutURL` to
   the provider's sign-out address. Choose who may register, and leave
   `LUBELOGGER_OPEN_REGISTRATION` unset.
3. Make the proxy the only way in. The example compose file publishes port
   8080 on every interface; publish it on loopback only
   (`127.0.0.1:8080:8080`), or reach the container over a Docker network.
4. At the proxy, return 403 for `/Login/Login` and `/Login/Register` in every
   letter case, with or without anything after them. LubeLogger's routing
   ignores case and nginx's prefix locations do not, and a block that covers
   one spelling looks closed and is not:

   ```nginx
   location ~* ^/Login/(Login|Register)(/|$) { return 403; }
   ```

5. Strip the `Authorization` header from every request
   (`proxy_set_header Authorization "";`). Integrations should use API keys
   (`x-api-key`), which LubeLogger accepts only under `/api`, `/kiosk`,
   `/images`, `/documents` and `/temp`.
6. Test from outside. The first command must print 403, not 200; the second,
   with a working local username and password, must print 401:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://roadtrack.example.com/login/LOGIN
   curl -s -o /dev/null -w '%{http_code}\n' -u 'user:password' https://roadtrack.example.com/api/vehicles
   ```

7. Decide how root signs in. With LubeLogger's `EnableRootUserOIDC` setting,
   root can use the provider when the address it sends equals the server's
   `DefaultReminderEmail`. Root's password works wherever the proxy rules do
   not apply, which makes root the break-glass account.
8. When someone leaves, removing them at the provider stops new sign-ins, but
   a single sign-on session lasts up to a day and carries its roles, so
   removing *Is Admin* bites only at their next sign-in. Deleting the account
   in the Admin Panel ends its sessions and deletes its API keys at once.

**If the provider fails**, unset `OpenIDConfig__DisableRegularLogin`, run
`docker compose up -d`, and sign in as root where the proxy rules do not
apply: `http://localhost:8080` on the host, or through an SSH tunnel to it.
