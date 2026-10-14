#!/bin/sh
# Plot Analysis Tool - offline launcher for macOS / Linux. Uses Python 3 or Node.js if present.
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then exec python3 serve.py "$@"; fi
if command -v node >/dev/null 2>&1; then exec node serve.mjs "$@"; fi
echo "Python 3 or Node.js is needed to run the local server (see README.txt)."
exit 1
