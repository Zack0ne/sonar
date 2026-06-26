#!/usr/bin/env bash
# Runs inside the linux/amd64 builder container for Windows cross-compilation.
# Expects the project mounted at /app.
set -euo pipefail

export CARGO_HOME=/opt/cargo
export PATH=/opt/cargo/bin:$PATH

cd /app

echo ">>> Installing frontend/CLI deps"
npm install --no-audit --no-fund

echo ">>> Building Tauri bundle for x86_64-pc-windows-gnu (.exe)"
npx tauri build --target x86_64-pc-windows-gnu --bundles nsis

# Hand ownership of build artifacts back to the host user.
if [ -n "${HOST_UID:-}" ]; then
  chown -R "${HOST_UID}:${HOST_GID:-${HOST_UID}}" \
    /app/src-tauri/target /app/node_modules 2>/dev/null || true
fi

echo ">>> Done. Bundles:"
ls -1 /app/src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/*.exe 2>/dev/null || true
ls -1 /app/src-tauri/target/x86_64-pc-windows-gnu/release/*.exe 2>/dev/null || true
