#!/bin/sh
# Builds the BLE -> TCP ELM bridge: tools/live/bin/elm-bridge (gitignored).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/bin"
swiftc -O -swift-version 5 -o "$here/bin/elm-bridge" "$here/elm-bridge.swift"
echo "built $here/bin/elm-bridge"
