#!/bin/bash
# Road Track entrypoint: write the settings the brand layer reads at run time,
# then start upstream's own command unchanged.
#
# The brand layer is static files, so it cannot read the container's
# environment. This turns the ROADTRACK_* variables into
# /App/wwwroot/brand/config.json, which roadtrack-ui.js fetches.
#
# Every value must match a strict pattern made only of characters that need no
# escaping in JSON or in a link, and anything else is dropped with a warning
# rather than escaped. A bad value costs the receipt button, never the app,
# which is also why a config file that cannot be written is only a warning.
set -euo pipefail

# ROADTRACK_CONFIG_PATH is for tools/test_entrypoint.sh, which runs this outside a container.
config=${ROADTRACK_CONFIG_PATH:-/App/wwwroot/brand/config.json}
json=

add() {  # add <json key> <variable> <pattern>
    local value=${!2:-}
    [[ -n $value ]] || return 0
    if [[ $value =~ $3 ]]; then
        json+="${json:+,}\"$1\":\"$value\""
    else
        echo "roadtrack: ignoring $2: not a valid value" >&2
    fi
}

add receiptTelegramBot  ROADTRACK_RECEIPT_TELEGRAM_BOT  '^[A-Za-z][A-Za-z0-9_]{4,31}$'
add receiptTelegramName ROADTRACK_RECEIPT_TELEGRAM_NAME '^[A-Za-z0-9][A-Za-z0-9 .-]{0,39}$'
add receiptEmail        ROADTRACK_RECEIPT_EMAIL         '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$'

printf '{%s}\n' "$json" > "$config" \
    || echo "roadtrack: cannot write $config; the receipt button stays off" >&2

exec "$@"
