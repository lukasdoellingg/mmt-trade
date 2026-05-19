# Linux fallback for building terminal.wasm — used when the host toolchain
# (Apple Silicon + Rosetta + Emscripten + Odin) is too finicky.
#
# Usage:
#   docker build -f packages/engine/Dockerfile -t mmt-trade-engine .
#   docker run --rm -v "$PWD:/workspace" mmt-trade-engine
#
# The image is intentionally not minimal — debugging WASM toolchain issues is
# easier when the standard build tools are available.
FROM debian:bookworm-slim

ARG ODIN_VERSION=dev-2026-05
ARG EMSDK_VERSION=3.1.74

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git unzip xz-utils \
        build-essential cmake ninja-build python3 python3-pip \
        libssl-dev pkg-config llvm clang lld \
    && rm -rf /var/lib/apt/lists/*

# ── Emscripten SDK ────────────────────────────────────────────────
RUN git clone --depth 1 https://github.com/emscripten-core/emsdk.git /opt/emsdk \
    && cd /opt/emsdk \
    && ./emsdk install "${EMSDK_VERSION}" \
    && ./emsdk activate "${EMSDK_VERSION}"

ENV EMSDK=/opt/emsdk
ENV PATH="/opt/emsdk:/opt/emsdk/upstream/emscripten:${PATH}"

# ── Odin ──────────────────────────────────────────────────────────
RUN git clone --depth 1 --branch "${ODIN_VERSION}" https://github.com/odin-lang/Odin.git /opt/odin \
    && cd /opt/odin \
    && make release-native

ENV PATH="/opt/odin:${PATH}"

WORKDIR /workspace

ENTRYPOINT ["bash", "packages/engine/build.sh"]
