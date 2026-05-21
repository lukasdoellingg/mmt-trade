# Development Guide

Setup, workflows, and conventions for day-to-day work on MMT-Trade.

## First-time setup

```bash
git clone https://github.com/lukas/mmt-trade.git
cd mmt-trade
git checkout develop   # integration branch
nvm use                # Node ≥ 20 from .nvmrc
npm ci
cp web/backend/.env.example web/backend/.env
npm run prepare        # installs Husky pre-commit hooks
```

### WASM toolchain (engine work)

```bash
bash packages/engine/scripts/install-emscripten.sh
bash packages/engine/scripts/install-vendor.sh
source packages/engine/.emsdk/emsdk_env.sh
npm run build:engine:smoke
```

Odin must be on `PATH` for native CBOR regression and WASM builds.

## Dev servers

| Command               | Stack                                 | URL           |
| --------------------- | ------------------------------------- | ------------- |
| `npm run dev`         | Backend + WASM shell                  | :3001 + :5174 |
| `npm run dev:legacy`  | Backend + Vue workspace               | :3001 + :5173 |
| `npm run dev:backend` | API only                              | :3001         |
| `npm run dev:shell`   | Shell only (needs backend for `/api`) | :5174         |

The shell Vite server sets COOP/COEP headers required for SharedArrayBuffer.

## Test commands

```bash
npm test                 # smoke + regression (JS)
npm run test:smoke       # fast (< 30s)
npm run test:regression  # security, CBOR, protocol
npm run test:integration # backend API (spawns server)
npm run test:cbor:odin   # Odin native decoder (needs odin)
npm run test:e2e         # Playwright (build previews first)
npm run test:all         # everything including E2E
```

Pre-commit runs `lint-staged` + `test:smoke` automatically.

## WASM rebuild rule

After changes under `packages/engine/src/**` that affect layout, exports, or
memory:

```bash
source packages/engine/.emsdk/emsdk_env.sh
npm run build:engine        # full terminal
# or
npm run build:engine:smoke  # toolchain gate only
```

Copy output lands in `packages/shell/public/`. Hard-refresh the browser after
rebuild.

## Branch workflow

1. Branch from `develop`: `feature/a9-cbor-validation`
2. Commit with [Conventional Commits](https://www.conventionalcommits.org/)
3. Open PR → `develop` using the PR template
4. Ensure CI green (smoke + regression)
5. Merge squash; delete branch

Release branches `release/v2.x` merge to `main` with full regression + E2E.

## Debugging

| Surface       | Tool                                |
| ------------- | ----------------------------------- |
| Vue workspace | Chrome Vue DevTools                 |
| WASM terminal | Chrome → Sources → `terminal.wasm`  |
| Backend API   | `curl localhost:3001/api/exchanges` |
| WS proxy      | Chrome Network → WS frames          |
| CBOR fixtures | `npm run test:regression`           |

Enable backend stderr in tests: `DEBUG_BACKEND=1 npm run test:smoke`.

## Fixtures

| Path                                 | Purpose                                    |
| ------------------------------------ | ------------------------------------------ |
| `tests/fixtures/mmt-column-mini.bin` | Generated mini column (committed in CI)    |
| `docs/captures/*.bin`                | Full HAR extracts (gitignored, local only) |

Generate mini fixture:

```bash
node -e "import { writeMiniColumnFixture } from './tests/helpers/fixtures.mjs'; writeMiniColumnFixture();"
```

## Code conventions

- Match existing module style — no drive-by renames
- Performance: zero allocation in render/WS hot paths (see `.cursor/rules/performance.mdc`)
- Security: never weaken CORS/rate limits without ADR
- Architecture changes: add ADR in `docs/adr/`

## Related docs

- [`CONTRIBUTING.md`](../CONTRIBUTING.md)
- [`docs/testing/STRATEGY.md`](./testing/STRATEGY.md)
- [`ARCHITECTURE.md`](../ARCHITECTURE.md)
- [`docs/BACKLOG.md`](./BACKLOG.md)
