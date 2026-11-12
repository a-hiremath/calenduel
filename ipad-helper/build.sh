#!/bin/sh
# Build "Calenduel iPad.app" (ad-hoc signed, for your own Mac).
#   ./build.sh            build into ipad-helper/build/
#   ./build.sh --install  also copy to ~/Applications and open it
#   ./build.sh --dev      also answer the local vite dev server (testing only)
set -eu
cd "$(dirname "$0")"
APP="build/Calenduel iPad.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"
FLAGS=""
[ "${1:-}" = "--dev" ] && FLAGS="-D DEV"
swiftc -O -swift-version 5 $FLAGS CalenduelIPad.swift -o "$APP/Contents/MacOS/CalenduelIPad"
codesign --force --sign - "$APP"
echo "built $APP"
if [ "${1:-}" = "--install" ]; then
  pkill -x CalenduelIPad 2>/dev/null || true
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/Calenduel iPad.app"
  cp -R "$APP" "$HOME/Applications/"
  open "$HOME/Applications/Calenduel iPad.app"
  echo "installed ~/Applications/Calenduel iPad.app"
fi
