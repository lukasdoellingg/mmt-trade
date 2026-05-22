# MMT-Trade Terminal

Web-based crypto order-flow and analytics terminal, oriented toward [MMT.gg](https://mmt.gg). The repo is a monorepo with two parallel UI paths:

| Path | Status | Entry |
|------|--------|-------|
| **Vue workspace** (`web/frontend`) | Active dev UI | `npm run dev` → http://localhost:5173 |
| **Odin shell** (`packages/shell`) | Target WASM terminal | `npm run dev:shell` |

Long-term target: one Odin/Emscripten `terminal.wasm` (Sokol + ImGui + WS-in-WASM). See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the rewrite roadmap and [`docs/CURRENT_STACK.md`](./docs/CURRENT_STACK.md) for what runs today.

## Monorepo layout

```
mmt-trade/
├── packages/
│   ├── engine/          # Odin/Emscripten → terminal.wasm (rewrite target)
│   └── shell/           # Minimal HTML/TS bootloader (COOP/COEP)
├── odin/                  # Legacy chart WASM (→ web/frontend/public/engine.wasm)
├── web/
│   ├── backend/           # Express proxy: REST + /ws/heatmap + /api/v2/ws
│   └── frontend/          # Vue 3 workspace (HeatmapView, chart widgets)
├── docs/                  # MMT research, protocol notes, implementation status
├── scripts/               # WASM build, HAR analysis, CBOR tests
└── tests/smoke/           # Backend health + MMT protocol smoke tests
```

## Quick start

```bash
npm run install:all   # installs all workspaces
npm run dev           # backend :3001 + frontend :5173
```

WASM (chart engine for Vue frontend):

```bash
npm run build:wasm    # odin/ → web/frontend/public/engine.wasm
```

Full Odin terminal (requires Emscripten — see `packages/engine/README.md`):

```bash
npm run build:engine  # packages/engine → packages/shell/public/terminal.wasm
npm run dev:shell
```

## Current UI (Vue workspace)

- **HeatmapView** — mmt.gg-style dockable workspace (chart + order-flow ladders)
- **Chart worker** — Binance WS + Odin `engine.wasm` (VWAP, EMA, liquidations)
- **OB heatmap worker** — WebGL2 RG texture via `/ws/heatmap` Protobuf
- **Layer workers** — Footprint, VPVR overlays

Backend REST reference: [`API.md`](./API.md). MMT integration notes: [`docs/MMT_IMPLEMENTATION.md`](./docs/MMT_IMPLEMENTATION.md).

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Backend + Vue frontend |
| `npm run dev:shell` | Backend + Odin shell |
| `npm run build:wasm` | Legacy chart WASM (`odin/`) |
| `npm run build:engine` | Full terminal WASM (`packages/engine/`) |
| `npm run lint` | ESLint (TS/Vue/JS) |
| `npm run typecheck` | Frontend TypeScript check |
| `npm test` | Smoke tests |
| `npm run setup:mmt` | Interactive MMT JWT setup |

## Documentation index

See [`docs/README.md`](./docs/README.md) for all research and protocol docs.

## Requirements

- **Node.js 20+** (see `.nvmrc`)
- **Odin** (optional, for WASM builds — `scripts/build-wasm.sh` can download a SDK)

## Security

Phase 0 hardening is in place: CORS allowlist, rate limits, WS origin checks, payload caps, upstream backoff. See [`ARCHITECTURE.md`](./ARCHITECTURE.md#security-phase-0).

---

**Version:** 2.0.0
