# Builder image for producing Linux (x86_64) Tauri bundles from macOS via Docker.
FROM --platform=linux/amd64 ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Tauri 2 Linux system dependencies + AppImage tooling.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget file build-essential pkg-config \
      libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
      libayatana-appindicator3-dev libssl-dev \
      patchelf desktop-file-utils xz-utils squashfs-tools \
      git \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 (provides the @tauri-apps/cli prebuilt binary).
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain, installed to world-writable locations so the build can run
# as an arbitrary host UID.
ENV RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo \
    PATH=/opt/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --profile minimal \
    && chmod -R a+rwX /opt/rustup /opt/cargo

# AppImage tooling can't use FUSE inside a container; extract-and-run instead.
ENV APPIMAGE_EXTRACT_AND_RUN=1 \
    NO_STRIP=1

WORKDIR /app
