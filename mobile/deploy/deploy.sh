#!/usr/bin/env bash
# Builds the APK and uploads the PWA + APK to the VPS.
# Usage: mobile/deploy/deploy.sh user@vps [/var/www/pear]
set -euo pipefail

TARGET=${1:?usage: deploy.sh user@host [remote_dir]}
REMOTE_DIR=${2:-/var/www/pear}
HERE=$(cd "$(dirname "$0")/.." && pwd)

(cd "$HERE/android" && ./gradlew assembleRelease --console=plain -q)

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
/bin/cp -r "$HERE/remote/." "$STAGE/"
/bin/cp "$HERE/android/app/build/outputs/apk/release/app-release.apk" "$STAGE/pear-mobile.apk"

rsync -av --delete "$STAGE/" "$TARGET:$REMOTE_DIR/"
echo "Deployed to $TARGET:$REMOTE_DIR"
