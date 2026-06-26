# Builder image for producing Windows (x86_64) Tauri bundles via cross-compilation.
FROM --platform=linux/amd64 ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Base build tools and MinGW for Windows cross-compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget file build-essential pkg-config \
      libssl-dev git \
      # MinGW toolchain for Windows
      gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64 \
      # Wine for running Windows tools (NSIS)
      wine64 \
      # NSIS for creating Windows installers
      nsis \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain with Windows target
ENV RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo \
    PATH=/opt/cargo/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --profile minimal \
    && chmod -R a+rwX /opt/rustup /opt/cargo \
    && rustup target add x86_64-pc-windows-gnu

# Configure cargo for Windows cross-compilation
RUN mkdir -p /opt/cargo && echo '[target.x86_64-pc-windows-gnu]\nlinker = "x86_64-w64-mingw32-gcc"' > /opt/cargo/config.toml \
    && chmod -R a+rwX /opt/cargo

WORKDIR /app
