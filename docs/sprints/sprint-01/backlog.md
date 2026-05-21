# Sprint 01 — Enterprise Foundation

**Dates:** 2026-05-19 → 2026-06-02  
**Goal:** Establish sovereign project governance, test pyramid, and CI/CD gates.

## Sprint backlog

| Story                                 | SP  | Owner | Status      |
| ------------------------------------- | --- | ----- | ----------- |
| D4 CI smoke + regression pipeline     | 5   | Dev   | Done        |
| D5 Governance docs + templates        | 3   | Dev   | Done        |
| Test pyramid (smoke/regression/E2E)   | 8   | Dev   | Done        |
| Pre-commit hooks (Husky)              | 2   | Dev   | Done        |
| ADR baseline (0001–0003)              | 2   | Dev   | Done        |
| A9 CBOR validation (Odin + JS parity) | 5   | Dev   | In Progress |

**Committed SP:** 20  
**Stretch:** Playwright E2E in nightly, release workflow

## Acceptance criteria

- [x] `npm test` runs smoke + regression locally and in CI
- [x] CONTRIBUTING, SECURITY, LICENSE, CoC exist
- [x] PR + issue templates configured
- [x] `develop` branch documented as integration target
- [ ] Odin CBOR green against mini fixture in CI
- [ ] First retro filed

## Risks

| Risk                        | Mitigation                         |
| --------------------------- | ---------------------------------- |
| Emscripten CI slow          | emsdk cache + path filters         |
| Large captures absent in CI | Optional fixture skip in Odin test |
| npm audit noise             | `--audit-level=high` gate          |

## Links

- [`docs/BACKLOG.md`](../BACKLOG.md)
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
