#!/usr/bin/env bash
# Generate compile_commands.json so clangd/IDE finds Emscripten headers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${EMSDK:-}" ]; then
  for candidate in \
    "$HOME/emsdk" \
    "$HOME/Downloads/emsdk" \
    "$ROOT/../emsdk"; do
    if [ -f "$candidate/emsdk_env.sh" ]; then
      # shellcheck disable=SC1090
      source "$candidate/emsdk_env.sh"
      break
    fi
  done
fi

if [ -z "${EMSDK:-}" ]; then
  echo "error: EMSDK not set. Install emsdk and run: source /path/to/emsdk/emsdk_env.sh" >&2
  exit 1
fi

CLANG="$EMSDK/upstream/bin/clang++"
SYSROOT="$EMSDK/upstream/emscripten/cache/sysroot"

if [ ! -x "$CLANG" ]; then
  echo "error: Emscripten clang not found at $CLANG" >&2
  exit 1
fi

if [ ! -f "$SYSROOT/include/emscripten.h" ]; then
  echo "error: emscripten.h not found under $SYSROOT/include (run emcc once to populate the sysroot)" >&2
  exit 1
fi

python3 - "$ROOT" "$CLANG" "$SYSROOT" > "$ROOT/compile_commands.json" <<'PY'
import json, sys
root, clang, sysroot = sys.argv[1:4]
entry = {
    "directory": root,
    "file": f"{root}/src/lct.cpp",
    "command": " ".join([
        clang,
        "-std=c++17",
        "--target=wasm32-unknown-emscripten",
        f"--sysroot={sysroot}",
        "-DEMSCRIPTEN",
        "-iwithsysroot/include/compat",
        "-iwithsysroot/include/fakesdl",
        "-c",
        f"{root}/src/lct.cpp",
    ]),
}
print(json.dumps([entry], indent=2))
PY

echo "wrote $ROOT/compile_commands.json"
