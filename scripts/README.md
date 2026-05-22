# Scripts

| Script | Usage | Purpose |
|--------|-------|---------|
| [`build-wasm.sh`](./build-wasm.sh) | `npm run build:wasm` | Build legacy chart WASM: `odin/` → `web/frontend/public/engine.wasm` |
| [`setup-mmt-token.mjs`](./setup-mmt-token.mjs) | `npm run setup:mmt` | Interactive MMT JWT → `web/backend/.env` |
| [`test-mmt-cbor.mjs`](./test-mmt-cbor.mjs) | `npm run test:mmt-cbor` | Decode sample CBOR heatmap frame |
| [`analyze-mmt-har.mjs`](./analyze-mmt-har.mjs) | `npm run analyze:mmt-har <file.har>` | Summarize MMT HAR WebSocket traffic |
| [`decode-mmt-capture.mjs`](./decode-mmt-capture.mjs) | `node scripts/decode-mmt-capture.mjs <file>` | Decode raw MMT WS capture |
| [`decode-ws-hex.mjs`](./decode-ws-hex.mjs) | `node scripts/decode-ws-hex.mjs` | Decode hex WS payloads (stdin) |
| [`extract-mmt-heatmap-from-har.mjs`](./extract-mmt-heatmap-from-har.mjs) | manual | Extract heatmap CBOR frames from HAR |
| [`replay-mmt-har.mjs`](./replay-mmt-har.mjs) | manual | Replay HAR WS subscribe sequence |

Engine build scripts live under `packages/engine/` (`build.sh`, `scripts/install-emscripten.sh`, `scripts/install-vendor.sh`).

Odin chart build (Windows): `odin/build_engine.ps1`, `odin/orderbook/build_orderbook.ps1`.
