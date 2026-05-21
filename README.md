# MMT-Trade

**Low-latency crypto trading terminal** — monolithic Odin/Emscripten WASM engine, hardened market-data gateway, and a workspace UI oriented toward [MMT.gg](https://mmt.gg)-class order-flow analytics.

[![CI](https://github.com/lukas/mmt-trade/actions/workflows/ci.yml/badge.svg)](https://github.com/lukas/mmt-trade/actions/workflows/ci.yml)
[![Regression](https://github.com/lukas/mmt-trade/actions/workflows/regression.yml/badge.svg)](https://github.com/lukas/mmt-trade/actions/workflows/regression.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](./.nvmrc)
[![License](https://img.shields.io/badge/license-proprietary-red)](#license)

---

## Overview

MMT-Trade is a self-hosted trading desk built for **120 FPS charting**, **zero-allocation hot paths**, and **binary market-data protocols**. The target runtime is a single `terminal.wasm` (Odin + Sokol + ImGui) loaded by a minimal COOP/COEP shell. Until cutover, a Vue workspace (`web/frontend`) runs in parallel for chart, heatmap, and order-flow widgets.

| Layer                                  | Role                                                    | Status               |
| -------------------------------------- | ------------------------------------------------------- | -------------------- |
| [`packages/engine`](./packages/engine) | Odin/Emscripten terminal core — chart, layers, CBOR, WS | Active               |
| [`packages/shell`](./packages/shell)   | WASM bootloader (SharedArrayBuffer / COOP+COEP)         | Active               |
| [`web/backend`](./web/backend)         | Hardened Express proxy — REST, heatmap WS, MMT upstream | Production-ready     |
| [`web/frontend`](./web/frontend)       | Vue 3 workspace — chart, ladder, heatmap (legacy path)  | Active until cutover |

Architecture, migration phases, and acceptance criteria: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

**Integration branch:** `develop` · **Release tags:** `v*` · Process: [`CONTRIBUTING.md`](./CONTRIBUTING.md)

---

## Features

### Terminal engine (`packages/engine`)

- Sokol WebGL2 rendering with instanced layer draws
- MMT-style layout chrome (top bar, tool rail, chart / ladder split)
- Candle viewport with WASM-side pan/zoom input bridge
- CBOR codec + MMT protocol skeleton (`net/mbor.odin`, `net/mmt_protocol.odin`)
- Layer stack: heatmap GPU, VWAP, EMA, footprint, VPVR, OB depth, CVD, OI, liquidations

### Workspace UI (`web/frontend`)

- Single-surface heatmap workspace (retired multi-view dashboard router)
- WebGL chart with Odin WASM overlay (VWAP suite, EMA, liquidation markers)
- Order-book heatmap worker with MMT-oriented colour mapping
- Draggable widget grid: chart, order-flow ladders, symbol bar

### Market-data gateway (`web/backend`)

- Multi-exchange REST via CCXT (Binance, Bybit, OKX, Deribit, Hyperliquid, Coinbase)
- TradFi snapshots via Yahoo Finance (CME, ETFs, macro indices)
- Rate limiting, symbol validation, WS origin gate, upstream backoff
- Optional MMT.gg upstream for live heatmap CBOR streams

---

## Quick start

### Prerequisites

| Tool       | Version | Notes                                                         |
| ---------- | ------- | ------------------------------------------------------------- |
| Node.js    | ≥ 20    | See [`.nvmrc`](./.nvmrc)                                      |
| npm        | ≥ 10    | Workspaces monorepo                                           |
| Odin       | latest  | Required for WASM engine builds                               |
| Emscripten | 3.1.74  | Installed via `packages/engine/scripts/install-emscripten.sh` |

### Install

```bash
git clone https://github.com/lukas/mmt-trade.git
cd mmt-trade
npm ci
cp web/backend/.env.example web/backend/.env
```

### Development

```bash
# Legacy Vue workspace + backend (default for feature work today)
npm run dev:legacy

# Target architecture: minimal shell + backend
npm run dev
```

| Service       | URL                                    |
| ------------- | -------------------------------------- |
| Backend API   | http://localhost:3001                  |
| Vue workspace | http://localhost:5173                  |
| WASM shell    | http://localhost:5174 (packages/shell) |

### WASM engine

```bash
# One-time toolchain setup
bash packages/engine/scripts/install-emscripten.sh
bash packages/engine/scripts/install-vendor.sh
source packages/engine/.emsdk/emsdk_env.sh

# Smoke test (Hello Triangle — CI stop-gate)
npm run build:engine:smoke

# Full terminal build
npm run build:engine
```

Docker fallback for Linux CI or fragile local toolchains: see [`packages/engine/README.md`](./packages/engine/README.md).

---

## Repository layout

```
mmt-trade/
├── packages/
│   ├── engine/          # Odin → terminal.wasm (Sokol, ImGui, net, layers)
│   └── shell/             # COOP/COEP HTML/TS loader
├── web/
│   ├── backend/           # Express gateway + security middleware
│   └── frontend/          # Vue 3 workspace (cutover → legacy)
├── docs/                  # Protocol research, API, backlog, audits, ADRs, sprints
├── tests/                 # smoke, regression, integration, e2e
├── scripts/               # WASM build, HAR analysis, CBOR fixtures
└── .github/workflows/     # CI, nightly regression, release
```

---

## Scripts

| Command                      | Description                       |
| ---------------------------- | --------------------------------- |
| `npm run dev`                | Backend + WASM shell              |
| `npm run dev:legacy`         | Backend + Vue frontend            |
| `npm run build`              | Production Vue build              |
| `npm run build:engine`       | Full Odin terminal WASM           |
| `npm run build:engine:smoke` | Smoke WASM (CI gate)              |
| `npm run lint`               | ESLint (zero warnings)            |
| `npm run typecheck`          | TypeScript check (frontend)       |
| `npm test`                   | Smoke + regression (JS)           |
| `npm run test:integration`   | Backend API integration           |
| `npm run test:e2e`           | Playwright E2E (shell + frontend) |
| `npm run test:cbor:odin`     | Odin native CBOR regression       |
| `npm run test:all`           | Full suite incl. E2E              |

---

## Configuration

Copy [`web/backend/.env.example`](./web/backend/.env.example) and set:

- `CORS_ALLOWED_ORIGINS` — comma-separated allow-list (never `*` in production)
- `MMT_WS_TOKEN` — JWT for MMT.gg upstream (never commit; rotate on leak)
- `PORT` — HTTP listen port (default `3001`)

Security invariants are documented in [`ARCHITECTURE.md`](./ARCHITECTURE.md#backend-security-modell) and [`SECURITY.md`](./SECURITY.md).

---

## Documentation

| Document                                                   | Contents                                          |
| ---------------------------------------------------------- | ------------------------------------------------- |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md)                     | Target runtime, monorepo layout, migration phases |
| [`docs/API.md`](./docs/API.md)                             | REST endpoint reference                           |
| [`docs/MMT_PROTOCOL.md`](./docs/MMT_PROTOCOL.md)           | MMT.gg WS/CBOR protocol research                  |
| [`docs/BACKLOG.md`](./docs/BACKLOG.md)                     | Honest task backlog and priorities                |
| [`docs/PERFORMANCE_AUDIT.md`](./docs/PERFORMANCE_AUDIT.md) | Performance budget and profiling notes            |
| [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md)             | Contributor setup and conventions                 |
| [`docs/testing/STRATEGY.md`](./docs/testing/STRATEGY.md)   | Test pyramid and coverage goals                   |
| [`docs/adr/`](./docs/adr/)                                 | Architecture Decision Records                     |
| [`docs/sprints/`](./docs/sprints/)                         | Sprint goals, backlogs, retros                    |
| [`docs/runbooks/`](./docs/runbooks/)                       | Deploy and ops playbooks                          |
| [`SECURITY.md`](./SECURITY.md)                             | Vulnerability reporting and invariants            |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md)                     | Branching, DoD, PR checklist                      |
| [`CHANGELOG.md`](./CHANGELOG.md)                           | Release history                                   |

---

## Supported markets

**Crypto:** Binance, Bybit, OKX, Deribit, Hyperliquid (futures/perps), Coinbase (spot)

**TradFi (via Yahoo Finance):** CME BTC/ETH futures, GBTC/ETHE, IBIT/FBTC, DXY, S&P 500, Gold, US 10Y

---

## License

Proprietary — all rights reserved. See [`LICENSE`](./LICENSE).

This project implements interfaces inspired by third-party trading terminals. It is **not affiliated with MMT.gg** or any exchange. Use at your own risk; not financial advice.

---

**Version:** 2.0.0 · **Last updated:** May 2026
