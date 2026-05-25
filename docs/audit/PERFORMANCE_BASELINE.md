# Performance Baseline — IPO Audit

Before/after budgets for regression gates. Measure in Chrome DevTools (Performance + Memory) with COOP/COEP enabled (Vite dev headers or production preview).

## Scenarios

| Scenario | What to measure | Tooling |
|----------|-----------------|---------|
| 1× Chart, OB heatmap on | Main-thread FPS during pan; JS heap; worker count; WS count | Performance panel, `chrome://tracing` |
| 2× Chart workspace | + GPU `texSubImage2D` bytes/frame | WebGL Spector or ObHeatmap partial-upload counters |
| Futures desk (5 panes) | REST QPS; Highcharts instance count | Network tab |
| Backend 10-symbol REST | p95 latency; RSS | `process.memoryUsage()`, load script |

## Budgets (targets)

| Metric | Target | Notes |
|--------|--------|-------|
| Main thread pan/zoom | ≥120 FPS | Existing performance rule |
| Idle chart CPU | 0 sustained rAF when no dirty flags | chartEngineWorker + ChartWidget idle-stop |
| Per chart RAM | <150 MB JS+WASM | Adjust per deployment; measure heap + WASM pages |
| OB heatmap GPU upload | <100 KB/frame steady-state | Partial column upload vs full 768×512×2 B |
| feedHub multi-port fan-out | 1 transfer + (N−1) copies max | First port gets zero-copy transfer |
| Backend REST p95 (cached) | <200 ms | 10 concurrent symbols, warm cache |

## Worker / socket inventory

| Layout | chartEngineWorker | obHeatmapWorker | fp/vpvr | feedHubWorker | Binance WS |
|--------|-------------------|-----------------|---------|---------------|------------|
| 1× chart, all layers | 1 | 0–1 (Emscripten path: 0) | 0–2 | 1 (session MUX) | 1 heatmap + 0–1 aggTrade |
| 2× chart workspace | 2 | 0–2 | 0–4 | 1 shared | 1–2 heatmap upstreams (refcount) |

## Measurement procedure

1. Start `npm run dev`, open heatmap workspace with BTCUSDT 1h.
2. Record 10 s pan-left/right — note FPS and main-thread long tasks.
3. Stop interaction; wait 5 s — confirm rAF stops (Performance: no repeating `frame` callbacks).
4. Memory snapshot before/after 5 min idle — delta should stay <10% vs this baseline doc revision.
5. Run `npm run test:regression` — must stay green.

## Baseline placeholders (fill on first formal run)

| Scenario | FPS (pan) | Idle rAF | Heap MB | OB upload KB/frame |
|----------|-----------|----------|---------|-------------------|
| 1× chart | TBD | TBD | TBD | TBD |
| 2× chart | TBD | TBD | TBD | TBD |

Revision: IPO audit A0 — structure + P0 fixes landed; re-measure after A1 merge.
