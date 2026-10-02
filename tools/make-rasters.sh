#!/usr/bin/env bash
# Regenerate every raster in brand/ from the two source SVGs.
# The SVGs are the single source of truth; the PNGs and the .ico are build
# output that happens to be committed, because CI has no SVG toolchain.
#
# Needs: rsvg-convert (librsvg2-bin), magick (imagemagick)
set -euo pipefail

cd "$(dirname "$0")/.."
command -v rsvg-convert >/dev/null || { echo "need rsvg-convert (apt install librsvg2-bin)"; exit 1; }
command -v magick       >/dev/null || { echo "need magick (apt install imagemagick)"; exit 1; }

render() { # svg size out
    rsvg-convert -w "$2" -h "$2" "brand/$1" -o "brand/$3"
    echo "  brand/$3  ${2}x${2}"
}

# 192 AND 512 are the installability pair: Chromium will not offer to install
# the app without both, whatever else is in the list. The rest are presentation.
for size in 72 128 144 192 512; do
    render icon.svg "$size" "icon-${size}.png"
done
for size in 72 128 192 512; do
    render icon-maskable.svg "$size" "icon-maskable-${size}.png"
done

# Favicon: browsers still pick from the .ico, so ship the classic three sizes.
# Every magick write below is stripped: left to itself, ImageMagick stamps the
# time of the build into date:create / date:modify text chunks and a tIME
# chunk, and those would ship in the image. rsvg-convert writes no dates.
rsvg-convert -w 48 -h 48 brand/icon.svg -o /tmp/rt-favicon.png
magick /tmp/rt-favicon.png -define icon:auto-resize=48,32,16 -strip brand/favicon.ico
rm -f /tmp/rt-favicon.png
echo "  brand/favicon.ico  48,32,16"

# apple-touch-startup-image. LubeLogger hardcodes one 1125x2436 splash, so
# match that exactly: brand tile centred on the dark chrome colour.
rsvg-convert -w 360 -h 360 brand/icon.svg -o /tmp/rt-launch.png
magick -size 1125x2436 xc:'#2D2D2D' /tmp/rt-launch.png -gravity center -composite \
       -strip -define png:exclude-chunks=date,time brand/launch.png
rm -f /tmp/rt-launch.png
echo "  brand/launch.png   1125x2436"

echo "done."
