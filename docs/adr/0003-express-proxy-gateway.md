# Status

Accepted

# Context

Browsers cannot safely hold exchange API keys. MMT upstream requires JWT in the
query string. Direct browser → exchange REST would bypass rate limiting and
symbol validation.

# Decision

Route all market-data REST and optional MMT WS through `web/backend` with:

- CORS allow-list
- Per-route rate limits
- Symbol/timeframe validation
- WS origin gate + per-IP concurrency cap
- Token redaction in logs

# Consequences

- Frontend/shell connect to same-origin `/api` and `/ws` in production.
- Security invariants are tested in `tests/regression/security.test.mjs`.
- Changes to `web/backend/lib/security.js` require CODEOWNER review.

# References

- [`SECURITY.md`](../../SECURITY.md)
- [`web/backend/lib/security.js`](../../web/backend/lib/security.js)
