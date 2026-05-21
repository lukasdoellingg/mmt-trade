# Contributing to MMT-Trade

Thank you for contributing. This project follows enterprise-grade quality gates
even as a sovereign monorepo — every change must pass smoke and regression tests.

## Prerequisites

| Tool       | Version | Notes                                           |
| ---------- | ------- | ----------------------------------------------- |
| Node.js    | ≥ 20    | [`.nvmrc`](./.nvmrc)                            |
| npm        | ≥ 10    | Workspaces monorepo                             |
| Odin       | latest  | Native CBOR regression + WASM builds            |
| Emscripten | 3.1.74  | `packages/engine/scripts/install-emscripten.sh` |

Setup guide: [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md).

## Branching

We use **Git-Flow Light**:

```
main      ← production-ready, tagged releases
develop   ← integration branch (default target for PRs)
feature/* ← new work
hotfix/*  ← urgent fixes against main
release/* ← release candidates
```

| Branch      | Merge target                  | CI required                     |
| ----------- | ----------------------------- | ------------------------------- |
| `feature/*` | `develop`                     | Fast CI (smoke + regression JS) |
| `develop`   | —                             | Fast CI                         |
| `release/*` | `main` + back-merge `develop` | Full regression                 |
| `hotfix/*`  | `main` + back-merge `develop` | Smoke + targeted regression     |

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(engine): add MMT stream 1 decoder
fix(backend): clamp heatmap levels to 800
test(cbor): regression fixture from mini capture
docs(adr): record CBOR-over-JSON decision
ci: add nightly regression workflow
```

## Pull Request Checklist

Copy into your PR description (template provided):

- [ ] Branch targets `develop` (or `main` for hotfix/release)
- [ ] `npm run lint` passes (zero warnings)
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (smoke + regression)
- [ ] Odin CBOR regression passes if `packages/engine/**` changed
- [ ] No new `console.log` in hot paths (use `debug` flag)
- [ ] Documentation updated if API or architecture changed
- [ ] Performance budget preserved (WASM ≤ 8 MB, zero-alloc hot paths)
- [ ] No secrets, tokens, or HAR captures committed

## Definition of Done

An item is **done** when it meets every point in the PR checklist above and
the acceptance criteria in the linked backlog story.

## Code Style

- ESLint + Prettier (enforced by pre-commit hook)
- Match existing module conventions — no drive-by renames
- Performance rules: [`.cursor/rules/performance.mdc`](./.cursor/rules/performance.mdc)
- Odin WASM rebuild: [`.cursor/rules/odin-wasm-rebuild.mdc`](./.cursor/rules/odin-wasm-rebuild.mdc)

## Tests

| Layer      | Command                   | When                           |
| ---------- | ------------------------- | ------------------------------ |
| Smoke      | `npm run test:smoke`      | Every commit (pre-commit + CI) |
| Regression | `npm run test:regression` | Every PR (CI)                  |
| Odin CBOR  | `npm run test:cbor:odin`  | Engine/net changes             |
| E2E        | `npm run test:e2e`        | Nightly + release              |
| All        | `npm test`                | Default test entry point       |

Strategy: [`docs/testing/STRATEGY.md`](./docs/testing/STRATEGY.md).

## Architecture Decisions

Significant design changes require an ADR in `docs/adr/` before implementation.
Use the template in `docs/adr/0000-template.md`.

## Security

See [`SECURITY.md`](./SECURITY.md). Never commit credentials. Report
vulnerabilities privately.

## Sprint Process

Sprint artifacts live in `docs/sprints/sprint-NN/`. The product backlog is
[`docs/BACKLOG.md`](./docs/BACKLOG.md).
