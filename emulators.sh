#!/usr/bin/env bash
#
# Starts the emulator suite with its data persisted across restarts.
#
# Without this, Auth users and Firestore documents live only in memory, so
# every restart loses the admin account — and since approveEmployee requires
# an already-active admin, that account can only be recreated by hand in the
# Emulator UI. Persisting the data means you bootstrap the admin once and
# approve everyone else in the admin console, the way it works in production.
#
#   ./emulators.sh
#
# Data lands in ./.emulator-data (gitignored). Stop with Ctrl-C — the export
# happens on a clean shutdown, so do not kill -9 the suite or the session's
# changes are lost. Delete the directory to start from a blank slate.

set -euo pipefail

cd "$(dirname "$0")"

DATA_DIR="./.emulator-data"

# The Firestore emulator is a Java process. openjdk is typically installed
# via Homebrew without being linked onto the PATH, which surfaces as a
# confusing "Unable to locate a Java Runtime" from firebase-tools.
#
# Test that java actually runs rather than that the binary exists: macOS ships
# a /usr/bin/java stub which is present even with no JDK installed and fails
# only when invoked, so `command -v java` reports success either way.
if ! java -version >/dev/null 2>&1; then
  for candidate in /opt/homebrew/opt/openjdk@21 /opt/homebrew/opt/openjdk /usr/local/opt/openjdk; do
    if "$candidate/bin/java" -version >/dev/null 2>&1; then
      export JAVA_HOME="$candidate"
      export PATH="$JAVA_HOME/bin:$PATH"
      break
    fi
  done
fi

if ! java -version >/dev/null 2>&1; then
  echo "No Java runtime found — the Firestore emulator needs one." >&2
  echo "Install it with: brew install openjdk@21" >&2
  exit 1
fi

# --import fails outright if the directory does not exist, so the first run
# has to start empty and only export.
IMPORT_ARGS=()
if [ -d "$DATA_DIR" ]; then
  IMPORT_ARGS=(--import="$DATA_DIR")
else
  echo "No saved emulator data yet — starting empty, and exporting to $DATA_DIR on exit."
fi

exec firebase emulators:start \
  --only functions,firestore,auth \
  ${IMPORT_ARGS[@]+"${IMPORT_ARGS[@]}"} \
  --export-on-exit="$DATA_DIR" \
  "$@"
