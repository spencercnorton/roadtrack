#!/bin/sh
# Prove the BRAND GUARD checks in the Dockerfile actually fail a build.
#
#     tools/test_build_guard.sh          # needs docker; ~30s warm
#
# WHY THIS EXISTS. The brand layer is installed with `cat brand/... >> upstream`,
# and `>>` creates a missing target. Before the guards, an upstream rename made
# the append land in an orphan file, the version sed succeeded, both placeholder
# greps passed, and the image published GREEN — to anything that pulls it on a
# schedule. A running instance would have lost its theme, its navbar tabs and
# its vehicle dashboard with no error anywhere.
#
# The guards close that. This closes the next gap along: a guard nobody has
# watched fire is a guard being trusted on faith. So this rebuilds the REAL
# Dockerfile (via its LUBELOGGER_IMAGE arg, not a sed'd copy) against bases that
# have been broken in each of the two ways that matter, and fails if any of them
# survives.
#
# Deliberately simple: no per-case fixtures and no test framework — a control
# build, four sabotage builds and a string match on the guard's own message.
set -eu
cd "$(dirname "$0")/.."

# Build on the builder backed by the docker daemon's IMAGE STORE. The sabotage
# bases below are built locally and never pushed, and a docker-container builder
# — which a CI runner may keep selected between jobs — cannot see them: it
# would go looking for the sabotage tag in a registry. `default` on a plain
# engine, `desktop-linux` on Docker Desktop, so read it rather than assume.
BUILDER="$(docker buildx ls | awk '$2 == "docker" && $1 ~ /\*$/ { sub(/\*$/, "", $1); print $1; exit }')"
: "${BUILDER:=default}"

BASE="${LUBELOGGER_IMAGE:-ghcr.io/hargata/lubelogger:$(sed -n 's/^ARG LUBELOGGER_VERSION=//p' Dockerfile)}"

# Image tags are daemon-global and a CI runner may be shared, so a second
# concurrent run would overwrite the sabotage base between its creation here and
# the guarded build that reads it — and the failure mode is not just flakiness:
# a build could be checked against ANOTHER run's base and report a pass it never
# earned. Namespace per run, and clean up on exit so an early failure does not
# leave images behind on a builder other jobs share.
RUN="${GITHUB_RUN_ID:-$$}"
SABOTAGE="rt-guard-base-$RUN"
CHECK="rt-guard-check-$RUN"
CONTROL="rt-guard-control-$RUN"
# The logs are shared state for the same reason the tags are: two runs writing
# one path means a verdict read off the wrong build.
LOG="/tmp/rt-guard-$RUN.log"
CLOG="/tmp/rt-guard-control-$RUN.log"
trap 'docker rmi -f "$SABOTAGE" "$CHECK" "$CONTROL" >/dev/null 2>&1 || true; rm -f "$LOG" "$CLOG"' EXIT

echo "base: $BASE   builder: $BUILDER   run: $RUN"

fail=0

# The control. Without it a sabotage build that fails for an unrelated reason —
# an unreachable ghcr.io, a Dockerfile syntax error — reads as the guard working.
printf '\n== control: unmodified base must BUILD ==\n'
if docker buildx build --builder "$BUILDER" --load --build-arg "LUBELOGGER_IMAGE=$BASE" -t "$CONTROL" . >"$CLOG" 2>&1
then
    echo "  ok   the real build is green"
else
    echo "  FAIL the unmodified build is broken — nothing below proves anything"
    tail -30 "$CLOG"
    exit 1
fi

# Each case breaks ONE file the brand layer appends to, in one of the two ways
# an upstream release can break it, and the build must go red naming that file.
#   rename  — the path is gone. `>>` would silently create it. `test -s` catches it.
#   rewrite — the path is there and no longer holds what we extend. `>>` and
#             every check downstream of it would pass. The marker grep catches it.
#
# `$expect` is the half of the guard that must have fired, not just "a guard
# fired": otherwise a rewrite caught by `test -s` would read as the marker grep
# working, and the marker grep is the half nothing else in this build can cover.
#
# ANCHORED ON BUILDKIT'S ELAPSED-TIME FIELD (`#14 0.090 BRAND GUARD: ...`) and
# that anchor is the whole check. BuildKit also echoes the RUN instruction, so
# every guard's message text appears in the log of EVERY build including a green
# one — matched loosely, this harness reported "red for the right reason" on a
# failure it had not even read, which is the same self-certifying trap the
# Dockerfile guards exist to close.
sabotage() {
    target="$1"; how="$2"; expect="$3"; recipe="$4"
    printf '\n== %s %s: build must FAIL ==\n' "$how" "$target"
    printf 'FROM %s\nRUN %s\n' "$BASE" "$recipe" \
        | docker buildx build --builder "$BUILDER" --load -q -t "$SABOTAGE" - >/dev/null

    if docker buildx build --builder "$BUILDER" --load --build-arg "LUBELOGGER_IMAGE=$SABOTAGE" \
                    -t "$CHECK" . >"$LOG" 2>&1
    then
        echo "  FAIL the build went GREEN with $target $how — this image would ship broken"
        fail=1
    elif grep -Eq "^#[0-9]+ [0-9]+\.[0-9]+ BRAND GUARD: $target $expect" "$LOG"
    then
        echo "  ok   red, and red for the right reason:"
        grep -E "^#[0-9]+ [0-9]+\.[0-9]+ BRAND GUARD: " "$LOG" | head -1
    else
        echo "  FAIL red, but not from '$target $expect' — that guard is not what caught it"
        tail -30 "$LOG"
        fail=1
    fi
}

# file:marker — the same pairs the Dockerfile guards on.
for case in \
    '/App/wwwroot/css/site.css:lubelogger-mobile-nav' \
    '/App/wwwroot/js/shared.js:function printContainer'
do
    target="${case%%:*}"
    marker="${case#*:}"
    sabotage "$target" rename 'is missing or empty' \
        "mv $target $target.renamed"
    # Strip only the marker lines: the file stays present and plausible, which
    # is the case `test -s` alone cannot see.
    sabotage "$target" rewrite 'no longer' \
        "grep -v '$marker' $target > /tmp/x && mv /tmp/x $target"
done

# The app itself. Setting an ENTRYPOINT means restating upstream's CMD, so if
# upstream ever starts the app another way the image would publish green and
# its container would exit at start.
sabotage /App/CarCareTracker rename 'is missing' \
    "mv /App/CarCareTracker /App/CarCareTracker.renamed"

printf '\n'
if [ "$fail" -eq 0 ]; then
    echo "all guards fire."
else
    echo "GUARD NOT PROVEN — see above."
    exit 1
fi
