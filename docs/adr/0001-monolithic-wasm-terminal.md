# Status

Proposed

# Context

MMT-Trade targets a single monolithic Odin/Emscripten binary (`terminal.wasm`)
with Sokol rendering and ImGui docking — not a micro-frontend of HTML widgets.

# Decision

Build the primary UI inside WASM (`packages/engine`) loaded by a minimal
COOP/COEP shell (`packages/shell`). The Vue workspace (`web/frontend`) remains
as a parallel hybrid path until feature parity, then retires to `legacy-frontend`.

# Consequences

- SharedArrayBuffer and WASM workers require cross-origin isolation headers.
- All hot-path rendering and input must stay zero-allocation inside Odin.
- Backend remains a hardened proxy — never expose exchange keys to the browser.
- E2E tests must cover both shell and legacy paths until cutover (ADR-0001).

# References

- [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
- [`docs/BACKLOG.md`](../BACKLOG.md) item A14
