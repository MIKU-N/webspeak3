#!/usr/bin/env bash
# Generates every derived favicon/OG-image size from the single source logo
# at web/public/logo.png. Requires ImageMagick (`magick` on the PATH).
#
# Usage: run from web/ after dropping the source logo at public/logo.png:
#   bash scripts/generate-icons.sh

set -euo pipefail
cd "$(dirname "$0")/.."

SRC=public/logo.png
if [ ! -f "$SRC" ]; then
  echo "Missing $SRC - drop the source logo there first (square PNG, >=512x512, transparent background)." >&2
  exit 1
fi

magick "$SRC" -resize 32x32 public/favicon-32.png
magick "$SRC" -resize 192x192 public/favicon-192.png
magick "$SRC" -resize 180x180 -background white -alpha remove -alpha off public/apple-touch-icon.png
magick "$SRC" -define icon:auto-resize=16,32,48 public/favicon.ico
magick "$SRC" -resize 400x400 -background "#1e1e1e" -gravity center -extent 1200x630 public/og-image.png

echo "Generated favicon-32.png, favicon-192.png, apple-touch-icon.png, favicon.ico, og-image.png in public/"
