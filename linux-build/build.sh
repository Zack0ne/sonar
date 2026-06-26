#!/usr/bin/env bash
# Runs inside the linux/amd64 builder container. Expects the project mounted at /app.
set -euo pipefail

export CARGO_HOME=/opt/cargo
export PATH=/opt/cargo/bin:$PATH
export APPIMAGE_EXTRACT_AND_RUN=1

cd /app

echo ">>> Installing frontend/CLI deps"
npm install --no-audit --no-fund

echo ">>> Building Tauri bundle for x86_64-unknown-linux-gnu (.deb + AppImage)"
npx tauri build --target x86_64-unknown-linux-gnu --bundles deb appimage

# Hand ownership of build artifacts back to the host user.
if [ -n "${HOST_UID:-}" ]; then
  chown -R "${HOST_UID}:${HOST_GID:-${HOST_UID}}" \
    /app/src-tauri/target /app/node_modules 2>/dev/null || true
fi

echo ">>> Done. Bundles:"
ls -1 /app/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/deb/*.deb 2>/dev/null || true
ls -1 /app/src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/appimage/*.AppImage 2>/dev/null || true
