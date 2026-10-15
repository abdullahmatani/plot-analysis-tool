#!/usr/bin/env bash
# Regenerates tests/fixtures/dwg/perf/plot-plan-10mb.dwg.br, the NFR-3 reference DWG (10 MB,
# AutoCAD 2000 format) used by e2e/perf.spec.ts.
#
# The drawing is the synthetic plot plan of make-large-dxf.mjs (17 MB of DXF, ~188 000 entities),
# converted by LibreDWG's dxf2dwg, built natively from the same release as the app's DWG reader,
# then Brotli-compressed (the test decompresses it). Read back by the app, the DWG gives the same
# entities, extents and geometry as the DXF, bit for bit.
#
#   scripts/fixtures/make-large-dwg.sh [work-dir]
#
# Needs git, a C compiler, autoconf, automake, libtool and make. The conversion alone takes a few
# minutes.
set -euo pipefail

VERSION=0.8.0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/tests/fixtures/dwg/perf/plot-plan-10mb.dwg.br"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$WORK"
cd "$WORK"

if [ ! -d libredwg-web ]; then
  git clone --depth 1 --branch "v$VERSION" https://github.com/mlightcad/libredwg-web.git
fi
cd libredwg-web
git submodule update --init --depth 1 jsmn
[ -f configure ] || sh ./autogen.sh
mkdir -p build-native && cd build-native
if [ ! -x programs/dxf2dwg ]; then
  ../configure --enable-release --enable-debug --disable-bindings --disable-python --disable-docs \
    --disable-shared CFLAGS=-O2
  make -j"$(nproc)"
fi

cd "$WORK"
node "$ROOT/scripts/fixtures/make-large-dxf.mjs" plot-plan.dxf 17
"$WORK/libredwg-web/build-native/programs/dxf2dwg" -y --as r2000 -o plot-plan-10mb.dwg plot-plan.dxf
mkdir -p "$(dirname "$OUT")"
node -e '
const zlib = require("node:zlib");
const fs = require("node:fs");
const bytes = fs.readFileSync(process.argv[1]);
const p = zlib.constants;
fs.writeFileSync(process.argv[2], zlib.brotliCompressSync(bytes, {
  params: { [p.BROTLI_PARAM_QUALITY]: 11, [p.BROTLI_PARAM_LGWIN]: 24, [p.BROTLI_PARAM_SIZE_HINT]: bytes.length },
}));
' plot-plan-10mb.dwg "$OUT"
sha256sum plot-plan-10mb.dwg
ls -l plot-plan-10mb.dwg "$OUT"
