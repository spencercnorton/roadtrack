#!/bin/sh
# Build the image and prove a container from it serves Road Track.
#
#     sh tools/smoke_test.sh        # needs Docker; builds for this machine's architecture
#
# The guards prove a build fails when it should. This proves a build that
# passes actually works: the container starts through the entrypoint, LubeLogger
# answers, and every file the brand layer changes is served changed. CI runs it
# on amd64 and on arm64.
set -eu
cd "$(dirname "$0")/.."
run="${GITHUB_RUN_ID:-$$}"
tag="rt-smoke-$run"
name="rt-smoke-$run"
port="${SMOKE_PORT:-18080}"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; docker rmi -f "$tag" >/dev/null 2>&1 || true' EXIT

version=$(tr -d '[:space:]' < VERSION)
docker build -q --build-arg VERSION="$version" -t "$tag" . >/dev/null
docker run -d --name "$name" -p "127.0.0.1:$port:8080" \
    -e LUBELOGGER_LOGO_URL=/brand/logo.svg \
    -e LUBELOGGER_LOGO_SMALL_URL=/brand/icon.svg \
    -e ROADTRACK_RECEIPT_TELEGRAM_BOT=examplereceiptbot \
    -e ROADTRACK_RECEIPT_EMAIL=receipts@example.com \
    "$tag" >/dev/null

base="http://127.0.0.1:$port"
i=0
until curl -fs -o /dev/null "$base/manifest.json"; do
    i=$((i + 1))
    if [ "$i" -ge 90 ]; then
        echo "FAIL the app did not answer within 90s"
        docker logs "$name" 2>&1 | tail -40
        exit 1
    fi
    sleep 1
done

fail=0
expect() {  # expect <path> <fixed string> <what it proves>
    if curl -fs "$base$1" | grep -qF -- "$2"; then
        echo "  ok   $3"
    else
        echo "  FAIL $3: $1 does not contain '$2'"; fail=1
    fi
}
expect /js/shared.js 'drawReceiptButton' 'the UI layer is appended to shared.js'
expect /js/shared.js "?v=$version" 'shared.js carries this release'"'"'s version stamp'
expect /css/site.css '#rt-receipt' 'the theme is appended to site.css'
expect /manifest.json '"name": "Road Track"' 'the web app manifest is Road Track'"'"'s'
expect /brand/config.json '"receiptTelegramBot":"examplereceiptbot"' 'the entrypoint wrote the runtime settings'
expect /brand/metrics/vehicle-dash.js 'export default' 'the vehicle dashboard module is served'

if curl -fs "$base/js/shared.js" | grep -qF '__RT_VERSION__'; then
    echo "  FAIL a version placeholder was left in shared.js"; fail=1
fi
if docker logs "$name" 2>&1 | grep -q '^roadtrack: '; then
    echo "  FAIL the entrypoint refused a valid setting:"
    docker logs "$name" 2>&1 | grep '^roadtrack: '
    fail=1
fi
if docker exec "$name" test -s /usr/share/doc/roadtrack/NOTICE; then
    echo "  ok   the licence notices ship in the image"
else
    echo "  FAIL /usr/share/doc/roadtrack/NOTICE is missing"; fail=1
fi

if [ "$fail" -eq 0 ]; then echo "smoke test: all checks pass."; else echo "smoke test: FAILED"; exit 1; fi
