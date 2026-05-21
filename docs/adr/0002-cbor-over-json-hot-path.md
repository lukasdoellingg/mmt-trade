# Status

Accepted

# Context

MMT.gg market-data frames use CBOR envelopes with nested column maps. JSON
would allocate heavily on every WebSocket message in the browser hot path.

# Decision

Implement CBOR decode in Odin (`packages/engine/src/net/cbor.odin`) and mirror
the column layout in Node (`web/backend/lib/mmtCbor.js`) for proxy/testing.
Regression tests must keep both decoders aligned on shared fixtures.

# Consequences

- Fixtures live under `tests/fixtures/` (mini) and optional `docs/captures/` (full).
- `npm run test:regression` covers JS; `npm run test:cbor:odin` covers Odin native.
- No `JSON.parse` on heatmap WS hot paths in production code.

# References

- [`docs/MMT_PROTOCOL.md`](../MMT_PROTOCOL.md)
- [`tests/regression/cbor-decode.test.mjs`](../../tests/regression/cbor-decode.test.mjs)
