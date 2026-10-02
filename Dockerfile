# Road Track — a branding layer over upstream LubeLogger.
#
# This is deliberately NOT a fork. Upstream ships every hook we need for the
# logo and the theme; the only thing it does not expose is a handful of
# strings compiled into the Razor views, and those are rewritten in the
# browser instead (see docs/how-it-works.md). So all this image does is add
# static files and a small entrypoint.
#
# Bumping upstream: change LUBELOGGER_VERSION, nothing else.
ARG LUBELOGGER_VERSION=v1.7.0
# Overridable ONLY so tools/test_build_guard.sh can rebuild THIS Dockerfile —
# not a copy of it — against a deliberately broken base, and prove the BRAND
# GUARD checks below actually fail it. Nothing in the pipeline sets this.
ARG LUBELOGGER_IMAGE=ghcr.io/hargata/lubelogger:${LUBELOGGER_VERSION}
FROM ${LUBELOGGER_IMAGE}

# Everything brand-new lives under /brand/ and is referenced by the
# LUBELOGGER_LOGO_URL / LUBELOGGER_LOGO_SMALL_URL environment variables (see
# docker-compose.example.yml).
COPY brand/ /App/wwwroot/brand/

# Surfaces upstream hardcodes, which no setting can point elsewhere:
# favicon.ico and manifest.json are fixed paths, and _Layout.cshtml names
# these three icons directly.
COPY brand/favicon.ico   /App/wwwroot/favicon.ico
COPY brand/manifest.json /App/wwwroot/manifest.json
COPY brand/icon-128.png  /App/wwwroot/defaults/lubelogger_icon_128.png
COPY brand/icon-192.png  /App/wwwroot/defaults/lubelogger_icon_192.png
COPY brand/launch.png    /App/wwwroot/defaults/lubelogger_launch.png

# The theme is appended to site.css rather than installed as a LubeLogger
# theme: data/themes/ lives under /App/data, which is a host bind mount at
# runtime, so anything COPYed there would be masked. Appending also means the
# theme needs no UserTheme setting and applies to anonymous pages like /Login.
#
# The .br/.gz siblings are not served by this app (it uses UseStaticFiles, not
# .NET 9 MapStaticAssets — verified against a running instance), but they are
# removed anyway so a future upstream upgrade cannot start serving the stale
# pre-brand copies.
# THE GUARD, and it is the reason a green build here means anything.
#
# `>>` CREATES a missing target. Rename site.css upstream and this append lands
# in a brand-new orphan file, the version sed below still succeeds, both
# placeholder greps still pass, and the image publishes GREEN — to everyone who
# pulls `latest`. Their instance then has no theme, and there is no
# error anywhere to find. Same for shared.js below, where the cost is the whole
# navbar and the vehicle dashboard.
#
# TWO checks, because there are two ways to lose the file. `test -s` catches the
# rename and the truncation. The marker grep catches the REWRITE, where the path
# still exists and no longer holds what we are extending — and the marker is a
# thing the brand layer actually depends on rather than a nonce: roadtrack.css
# hides the Household entries inside `.lubelogger-mobile-nav`, so if upstream
# drops that class our rules match nothing whether or not the append worked.
#
# Proven to fire — both files, rename and rewrite — by tools/test_build_guard.sh,
# which CI runs as the build-guard check.
RUN set -e; \
    test -s /App/wwwroot/css/site.css \
      || { echo 'BRAND GUARD: /App/wwwroot/css/site.css is missing or empty — upstream renamed or dropped it'; exit 1; }; \
    grep -q 'lubelogger-mobile-nav' /App/wwwroot/css/site.css \
      || { echo 'BRAND GUARD: /App/wwwroot/css/site.css no longer carries .lubelogger-mobile-nav — upstream rewrote it'; exit 1; }; \
    cat /App/wwwroot/brand/roadtrack.css >> /App/wwwroot/css/site.css; \
    rm -f /App/wwwroot/css/site.css.br    /App/wwwroot/css/site.css.gz \
          /App/wwwroot/favicon.ico.br     /App/wwwroot/favicon.ico.gz \
          /App/wwwroot/manifest.json.br   /App/wwwroot/manifest.json.gz

# The "Metrics" nav link rides along the same way, appended to the js/shared.js
# that _Layout.cshtml loads on every page. Same reasoning as the theme: it
# keeps the link in git and in the image, and needs no Razor fork and no proxy
# rule to put a tab in the navbar.
#
# The metrics page's own assets carry no upstream `?v=`, so without a stamp they
# would sit at a URL that never changes between releases — the exact trap that
# once hid a CSS release behind a cached copy. Substituting this repo's VERSION into
# the tags AND every ES import means each release busts its own cache. shared.js
# is stamped too, because the vehicle dashboard it now loads is referenced from
# there rather than from a page this repo owns.
#
# The final greps fail the build if a placeholder is ever left unsubstituted, so
# a renamed file cannot silently ship a literal "__RT_VERSION__" to browsers.
#
# EVERY text asset under brand/, found rather than listed. The list was the
# maintenance hazard it looks like: adding brand/metrics/finance.js
# meant remembering to add a line here, and the only thing that would have
# caught it is the grep two lines below — a build failure rather than a bad
# image, but still a build failure for a reason nobody would enjoy diagnosing.
# The -name filter keeps sed away from the PNGs and the .ico.
COPY VERSION /tmp/rt-version
# Same guard as the theme, same reasoning — see above. `printContainer` is the
# marker because reports.js calls window.printContainer directly; if it is gone
# the Reports tab's print button is dead whatever this append did.
RUN set -e; \
    test -s /App/wwwroot/js/shared.js \
      || { echo 'BRAND GUARD: /App/wwwroot/js/shared.js is missing or empty — upstream renamed or dropped it'; exit 1; }; \
    grep -q 'function printContainer' /App/wwwroot/js/shared.js \
      || { echo 'BRAND GUARD: /App/wwwroot/js/shared.js no longer defines printContainer — upstream rewrote it'; exit 1; }; \
    cat /App/wwwroot/brand/roadtrack-ui.js >> /App/wwwroot/js/shared.js \
 && rm -f /App/wwwroot/js/shared.js.br /App/wwwroot/js/shared.js.gz \
 && rm /App/wwwroot/brand/roadtrack-ui.js \
 && RT="$(cat /tmp/rt-version)" \
 && find /App/wwwroot/brand -type f \
        \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.json' \) \
        -exec sed -i "s/__RT_VERSION__/${RT}/g" {} + \
 && sed -i "s/__RT_VERSION__/${RT}/g" /App/wwwroot/js/shared.js \
 && rm /tmp/rt-version \
 && ! grep -rq __RT_VERSION__ /App/wwwroot/brand/metrics/ \
 && ! grep -rq __RT_VERSION__ /App/wwwroot/brand/reports/ \
 && ! grep -rq __RT_VERSION__ /App/wwwroot/brand/access/ \
 && ! grep -q __RT_VERSION__ /App/wwwroot/js/shared.js

# Road Track's licence and the notice that carries LubeLogger's: this image
# redistributes LubeLogger, and its MIT licence asks for the notice to travel
# with every copy.
COPY LICENSE NOTICE /usr/share/doc/roadtrack/

# Runtime settings. The brand layer is static files and cannot read the
# container's environment, so the entrypoint writes the ROADTRACK_* variables
# to /App/wwwroot/brand/config.json and then starts upstream's own command,
# unchanged. Setting ENTRYPOINT resets the CMD inherited from the base image,
# hence restating it here — and hence the guard: if upstream ever starts the
# app some other way, this build fails instead of publishing an image whose
# container exits at start.
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/roadtrack-entrypoint
RUN test -x /App/CarCareTracker \
      || { echo 'BRAND GUARD: /App/CarCareTracker is missing — upstream changed how the app starts; update CMD'; exit 1; }
ENTRYPOINT ["/usr/local/bin/roadtrack-entrypoint"]
CMD ["./CarCareTracker"]

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Road Track" \
      org.opencontainers.image.description="A dashboard, finance and reporting layer for LubeLogger" \
      org.opencontainers.image.source="https://github.com/spencercnorton/roadtrack" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
