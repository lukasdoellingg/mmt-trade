# Test Strategy

MMT-Trade is latency-critical. Tests prioritise **fast smoke gates on every
commit** and **deeper regression on PR/nightly** without blocking the inner loop.

## Pyramid

```
        ┌─────────────┐
        │  E2E (5–10) │  Playwright — shell + Vue mount
        ├─────────────┤
        │ Integration │  Backend spawn, API contracts
        ├─────────────┤
        │ Regression  │  CBOR, protocol, security invariants
        ├─────────────┤
        │ Smoke       │  Health, mini decode, lint, typecheck
        └─────────────┘
```

## Layers

| Layer       | Location                               | Runner        | CI trigger                  |
| ----------- | -------------------------------------- | ------------- | --------------------------- |
| Smoke       | `tests/smoke/`                         | `node --test` | Every push/PR + pre-commit  |
| Regression  | `tests/regression/`                    | `node --test` | Every push/PR               |
| Integration | `tests/integration/`                   | `node --test` | PR + nightly                |
| Odin CBOR   | `packages/engine/scripts/test-cbor.sh` | Odin native   | PR (engine paths) + nightly |
| E2E         | `tests/e2e/`                           | Playwright    | Nightly + release           |
| WASM smoke  | `build.sh --smoke`                     | Emscripten    | PR + nightly                |

## Coverage goals

| Area                             | Target         | Notes                              |
| -------------------------------- | -------------- | ---------------------------------- |
| `web/backend/lib/security.js`    | 90%+ branches  | Pure functions — fully unit tested |
| `web/backend/lib/mmtCbor.js`     | 80%+           | Mini + optional capture fixture    |
| `web/backend/lib/mmtProtocol.js` | 80%+           | RPC builders                       |
| Odin `net/cbor.odin`             | Fixture parity | Native regression vs JS            |
| Vue components                   | E2E smoke      | Mount tests only until cutover     |

## Fixtures policy

- **Committed:** `tests/fixtures/mmt-column-mini.bin` (generated in CI, small)
- **Gitignored:** `docs/captures/*.bin`, `*.har` (may contain JWT)
- **Optional in Odin test:** large capture fixtures skip when absent

## Performance budgets (CI gates)

| Artifact              | Gate                                                    |
| --------------------- | ------------------------------------------------------- |
| `terminal_smoke.wasm` | 100 KB ≤ size ≤ 8 MB                                    |
| `terminal.wasm`       | ≤ 8 MB (nightly)                                        |
| Hot-path alloc        | 0 per frame (manual audit, `docs/PERFORMANCE_AUDIT.md`) |

## Commands

```bash
npm test                    # default — smoke + regression
npm run test:integration
npm run test:cbor:odin
npm run test:e2e
npm run test:all
```

## Adding tests

1. **Pure logic** → `tests/regression/<module>.test.mjs`
2. **Server contract** → `tests/integration/` using `tests/helpers/server.mjs`
3. **UI mount** → `tests/e2e/*.spec.ts`
4. **Binary decoder** → extend `main_cbor_test.odin` + JS parity test

Every bug fix should include a regression test unless documented in an ADR.
