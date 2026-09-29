#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT_DIR="${ROOT_DIR}/dist/native"
mkdir -p "${OUT_DIR}"

NODE_EXEC="$(which node)"
NODE_PREFIX="$(dirname "$(dirname "${NODE_EXEC}")")"
NODE_INCLUDE="${NODE_PREFIX}/include/node"

if [ ! -f "${NODE_INCLUDE}/node_api.h" ]; then
  # Fallback to headers in nvm or current process directory
  NODE_INCLUDE="$(node -e "console.log(require('path').resolve(process.execPath, '../../include/node'))")"
fi

if [ ! -f "${NODE_INCLUDE}/node_api.h" ]; then
  echo "Error: Cannot find node_api.h in ${NODE_INCLUDE}" >&2
  exit 1
fi

# Release by default; DEBUG=1 builds with AddressSanitizer for leak/UB testing:
#   DEBUG=1 bash native/darwin/compile.sh
#   DYLD_INSERT_LIBRARIES="$(clang -print-file-name=libclang_rt.asan_osx_dynamic.dylib)" \
#     node --expose-gc test/leak-darwin.mjs
OPT_FLAGS=(-O3)
if [ "${DEBUG:-0}" = "1" ]; then
  OPT_FLAGS=(-O1 -g -fno-omit-frame-pointer -fsanitize=address)
  echo "[compile.sh] DEBUG=1: building with AddressSanitizer"
fi

echo "[compile.sh] Compiling darwin_telemetry.node using Clang..."
clang++ "${OPT_FLAGS[@]}" -std=c++17 \
  -Wall -Wextra -Wunguarded-availability-new \
  -mmacosx-version-min=11.0 -DNAPI_VERSION=8 -fvisibility=hidden \
  -shared -undefined dynamic_lookup \
  -I"${NODE_INCLUDE}" \
  -framework CoreFoundation \
  -framework IOKit \
  "${SCRIPT_DIR}/src/addon.cc" \
  -o "${OUT_DIR}/darwin_telemetry.node"

echo "[compile.sh] Successfully built ${OUT_DIR}/darwin_telemetry.node"
