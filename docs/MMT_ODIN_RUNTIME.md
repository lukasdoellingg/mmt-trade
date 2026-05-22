# MMT `odin.js` — technische Einordnung

Basierend auf dem von dir geteilten Runtime-Bundle (Standard-Odin-JS-Glue + MMT-Patches).

## Architektur

```
┌─────────────────────────────────────────────────────────┐
│  odin.js (Main oder Worker)                             │
│  ├─ WasmMemoryInterface  ←→  WASM linear memory         │
│  ├─ WebGLInterface       ←→  ctx.* (volle WebGL2 API)    │
│  ├─ odin_dom             ←→  DOM events (Main only)       │
│  └─ runWasm() → _start() → step(dt) loop                │
└─────────────────────────────────────────────────────────┘
```

MMT ruft **nicht** `drawArrays` aus TypeScript auf — Odin-Code importiert `webgl2` und kompiliert Shader/Draw-Calls nach WASM.

## Worker-Patch (wichtig)

```javascript
if (this.memory.buffer instanceof SharedArrayBuffer) {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new TextDecoder().decode(copy);
}
```

→ Heatmap/Chart können in **Dedicated Workers** laufen, sofern Memory geteilt oder Views neu gebunden werden.

## Vergleich: MMT vs. MMT-Trade (aktuell)

| | MMT | MMT-Trade |
|---|-----|----------------|
| WASM | Volles App-Modul + WebGL in Odin | Kleines `engine.odin` nur Geometrie |
| WebGL | Odin → `webgl2.*` Imports | TS `ChartRenderer` + Instancing |
| Heatmap | Vermutlich Odin-Shader | `obHeatmapWorker` + RG-Textur |
| Loop | `exports.step(dt)` | `requestAnimationFrame` in JS Workers |

## Datei im Repo

Kopie des Runtimes (Referenz / spätere Migration):  
`web/frontend/public/odin.js`

Nutzung (Zukunft):

```javascript
import '/odin.js';
await odin.runWasm('/engine_full.wasm', null, customImports, mem, 4);
```

Bis `engine.odin` WebGL-Imports nutzt, bleibt unser `WasmBridge.ts` + `ChartRenderer.ts` aktiv.
