#!/usr/bin/env bash
# Rebuilds vendor/libredwg-web: the DWG reader (LibreDWG, GPL-3.0) without run-time code generation.
#
# Why (FDR rows 22, 88; decision U-1): the Emscripten glue published in @mlightcad/libredwg-web
# builds embind's call wrappers with `new Function`. A Content-Security-Policy without
# 'unsafe-eval' (the app's policy, sent as a header by the offline bundle, `vite preview` and
# hosted mode) blocks that, so DWG import failed there. Linking with -sDYNAMIC_EXECUTION=0 makes
# Emscripten emit closures instead; the compiled LibreDWG code and its bindings are unchanged.
#
# The commands are the package's own build scripts (bindings/javascript/package.json at the tag),
# with two differences: -sDYNAMIC_EXECUTION=0, and the link step uses em++ because Emscripten 6
# no longer links C++ libraries when emcc is given .cpp inputs.
#
#   scripts/libredwg/build.sh [work-dir]
#
# Needs git, python3, autoconf, automake, libtool, make and network access to github.com and
# storage.googleapis.com (emsdk). Takes about 5 minutes on 4 cores. Writes
# vendor/libredwg-web/libredwg-web.{js,wasm} and prints their SHA-256 for build-info.json.
set -euo pipefail

VERSION=0.8.0
COMMIT=d0b7c53d55a923f323256d19a310af7bc0137245
EMSDK_VERSION=6.0.12
ZLIB_VERSION=1.3.2

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/vendor/libredwg-web"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$WORK"
cd "$WORK"
echo "libredwg build: working in $WORK"

if [ ! -d emsdk ]; then git clone --depth 1 https://github.com/emscripten-core/emsdk.git; fi
./emsdk/emsdk install "$EMSDK_VERSION"
./emsdk/emsdk activate "$EMSDK_VERSION"
# shellcheck disable=SC1091
source ./emsdk/emsdk_env.sh

# Emscripten's zlib port downloads a GitHub archive tarball, which some networks block. Stage the
# same tag from git instead: a port directory with a matching .emscripten_url marker counts as
# already downloaded.
PORT="$(em-config CACHE)/ports/zlib"
if [ ! -f "$PORT/.emscripten_url" ]; then
  rm -rf "zlib-$ZLIB_VERSION" "$PORT"
  git clone --depth 1 --branch "v$ZLIB_VERSION" https://github.com/madler/zlib.git "zlib-$ZLIB_VERSION"
  mkdir -p "$PORT"
  cp -r "zlib-$ZLIB_VERSION" "$PORT/zlib-$ZLIB_VERSION"
  rm -rf "$PORT/zlib-$ZLIB_VERSION/.git"
  echo "https://github.com/madler/zlib/archive/refs/tags/v$ZLIB_VERSION.tar.gz" > "$PORT/.emscripten_url"
fi

if [ ! -d libredwg-web ]; then
  git clone --depth 1 --branch "v$VERSION" https://github.com/mlightcad/libredwg-web.git
fi
cd libredwg-web
test "$(git rev-parse HEAD)" = "$COMMIT" || { echo "tag v$VERSION is not $COMMIT" >&2; exit 1; }
git submodule update --init --depth 1 jsmn
sh ./autogen.sh
rm -rf build-wasm && mkdir build-wasm && cd build-wasm
emconfigure ../configure CFLAGS="-O2 -sUSE_ZLIB=1 -DNDEBUG" CC=emcc --enable-release --enable-debug \
  --disable-docs --disable-write --disable-python --disable-bindings --disable-shared --disable-json
emmake make -j"$(nproc)"
em++ ../bindings/javascript/embind/*.cpp src/*.o -O2 -lembind -std=c++17 -Isrc -I../src -I../include \
  -o libredwg-web.js -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=1GB -s MAXIMUM_MEMORY=4GB \
  -s MALLOC=mimalloc -s EXPORT_ES6=1 -s MODULARIZE=1 -s EXPORT_NAME="createModule" \
  -sEXPORTED_RUNTIME_METHODS=FS,ENV,ccall,cwrap,UTF8ToString,stringToNewUTF8,setValue \
  -sDYNAMIC_EXECUTION=0

if grep -q 'new Function\|[^A-Za-z_.$]eval(' libredwg-web.js; then
  echo "libredwg-web.js still generates code at run time" >&2
  exit 1
fi
mkdir -p "$OUT"
cp libredwg-web.js libredwg-web.wasm "$OUT/"
sha256sum "$OUT/libredwg-web.js" "$OUT/libredwg-web.wasm"
