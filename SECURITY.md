# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 2.x     | Yes       |
| < 2.0   | No        |

## Reporting a Vulnerability

**Do not open public GitHub issues for security vulnerabilities.**

Send a private report to the repository owner with:

1. Description of the issue and potential impact
2. Steps to reproduce
3. Affected components (backend, shell, engine, frontend)
4. Suggested fix (optional)

We aim to acknowledge reports within **72 hours** and provide a remediation
timeline within **7 business days** for confirmed issues.

## Secrets and Credentials

- Never commit `.env`, JWT tokens, API keys, or HAR captures containing tokens.
- Rotate `MMT_WS_TOKEN` immediately if exposed in logs, commits, or screenshots.
- Use `web/backend/.env.example` as the template; production values live only in
  deployment secrets.

## Security Invariants

These are enforced in code (`web/backend/lib/security.js`) and must not be
weakened without an ADR:

| Control                 | Default                                                         |
| ----------------------- | --------------------------------------------------------------- |
| CORS                    | Allow-list via `CORS_ALLOWED_ORIGINS` — never `*` in production |
| REST rate limit         | 120 req/min global; 30/min order book; 60/min symbols           |
| WebSocket origin gate   | Same allow-list as CORS                                         |
| WS concurrency          | 3 sockets per IP                                                |
| WS payload cap          | 64 KB                                                           |
| Symbol validation       | `SYMBOL_REGEX` on all symbol routes                             |
| Token redaction         | `redactTokensInUrl()` before any URL logging                    |
| REST API key (optional) | `API_KEY` env — `X-API-Key` or `Bearer`; `/api/health` public   |

## Dependency Updates

- Dependabot opens weekly PRs for npm dependencies.
- CI runs `npm audit --audit-level=high` on every push.
- Patch updates to production dependencies should be merged within one sprint.

## WASM / Browser Surface

- The shell runs under strict CSP and COOP/COEP (`packages/shell/vite.config.ts`).
- SharedArrayBuffer requires cross-origin isolation — do not remove those headers.
- Third-party vendor sources (Sokol, ImGui) are pinned in `packages/engine/vendor/`.

## Incident Response

1. Rotate affected credentials.
2. Patch and release a hotfix tag (`v2.x.y`).
3. Document the incident in `docs/runbooks/` if operational steps are needed.
4. Update this policy if a new attack surface was introduced.
