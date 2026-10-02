#!/bin/sh
# Prove the entrypoint writes only what it should into the brand config.
#
#     sh tools/test_entrypoint.sh        # needs bash; no Docker
#
# The values end up in a JSON file and in links on every page, so the refusals
# matter as much as the happy path: each hostile value below must be dropped,
# not escaped, and the command after it must still run.
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cfg="$tmp/config.json"
fail=0

run() {  # run <expected config> [VAR=value ...]
    expect=$1; shift
    rm -f "$cfg"
    if ! env -i PATH="$PATH" ROADTRACK_CONFIG_PATH="$cfg" "$@" \
            bash docker/entrypoint.sh true 2>"$tmp/err"; then
        echo "  FAIL the command after the entrypoint did not run ($*)"; fail=1; return
    fi
    got=$(cat "$cfg")
    if [ "$got" = "$expect" ]; then
        echo "  ok   $got"
    else
        echo "  FAIL expected $expect, got $got ($*)"; fail=1
    fi
}

run '{}'
run '{"receiptTelegramBot":"examplereceiptbot","receiptTelegramName":"Receipt Bot","receiptEmail":"receipts@example.com"}' \
    ROADTRACK_RECEIPT_TELEGRAM_BOT=examplereceiptbot \
    ROADTRACK_RECEIPT_TELEGRAM_NAME='Receipt Bot' \
    ROADTRACK_RECEIPT_EMAIL=receipts@example.com
run '{"receiptEmail":"receipts@example.com"}' ROADTRACK_RECEIPT_EMAIL=receipts@example.com

# Hostile or malformed values, each of which must be dropped.
nl='
'
for bad in 'bad"bot' 'abc' "goodbot1$nl\"}" '<script>' 'two words'; do
    run '{}' ROADTRACK_RECEIPT_TELEGRAM_BOT="$bad"
done
for bad in 'receipts@example.com?bcc=other@example.com' 'not-an-address' \
           '"x"@example.com' 'a@b' "receipts@example.com$nl"; do
    run '{}' ROADTRACK_RECEIPT_EMAIL="$bad"
done
run '{}' ROADTRACK_RECEIPT_TELEGRAM_NAME='<b>bold</b>'

# A refused value is a warning, never silence.
env -i PATH="$PATH" ROADTRACK_CONFIG_PATH="$cfg" ROADTRACK_RECEIPT_EMAIL=nope \
    bash docker/entrypoint.sh true 2>"$tmp/err"
if grep -q 'roadtrack: ignoring ROADTRACK_RECEIPT_EMAIL' "$tmp/err"; then
    echo "  ok   a refused value is logged"
else
    echo "  FAIL a refused value was dropped silently"; fail=1
fi

# A config that cannot be written costs the button, not the app.
if env -i PATH="$PATH" ROADTRACK_CONFIG_PATH="$tmp/missing/config.json" \
        bash docker/entrypoint.sh true 2>/dev/null; then
    echo "  ok   an unwritable config still starts the app"
else
    echo "  FAIL an unwritable config stopped the app"; fail=1
fi

if [ "$fail" -eq 0 ]; then echo "entrypoint: all checks pass."; else echo "entrypoint: FAILED"; exit 1; fi
