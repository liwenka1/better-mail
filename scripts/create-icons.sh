#!/bin/sh
set -eu
swift scripts/create-icon.swift
icon_work=$(mktemp -d)
trap 'rm -rf "$icon_work"' EXIT
mkdir "$icon_work/BetterMail.iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" resources/icon.png --out "$icon_work/BetterMail.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" resources/icon.png --out "$icon_work/BetterMail.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$icon_work/BetterMail.iconset" -o resources/icon.icns
