# MMT.gg Integration — Implementierungsstand

## Was jetzt im Repo ist

| Modul | Pfad | Rolle |
|-------|------|--------|
| **CBOR-Decoder** | `web/backend/lib/mmtCbor.js` | MMT-Bulk-Säule → `{ ts, levels[] }` |
| **Protokoll** | `web/backend/lib/mmtProtocol.js` | `stream:16`, Subscribe/Getrange-RPC |
| **MMT-Upstream** | `web/backend/lib/mmtUpstream.js` | Optional: echte MMT-WS → unser Protobuf |
| **Book → Frame** | `web/backend/lib/heatmapBook.js` | Bis **800 Levels/Seite**, Book **5000** |
| **HAR-Tool** | `scripts/analyze-mmt-har.mjs` | HAR auswerten |
| **CBOR-Test** | `scripts/test-mmt-cbor.mjs` | Sample-Frame dekodieren |
| **Fixture** | `docs/captures/mmt-ws-frame-sample.bin` | ~64 KB aus deiner HAR |

Frontend bleibt auf **`/ws/heatmap` Protobuf** — kein Breaking Change.

---

## Modus A — Binance (Standard, ohne MMT-Account)

- Depth `limit=1000`, Book bis 5000, Broadcast bis 800 Levels
- Aggregation `?aggregate=binance,bybit` wie bisher
- OB-Textur 512×512, MMT-Grün-Shader

```bash
npm run dev
```

---

## Modus B — Echte MMT-Daten (mit JWT)

1. In mmt.gg einloggen → DevTools → WS-URL → `token=eyJ…` kopieren  
2. **Nur lokal**, nie committen:

```bash
export MMT_WS_TOKEN='eyJ...'
cd web/backend && npm install && npm run dev
```

3. Frontend unverändert — Backend verbindet `wss://eu-central-2.mmt.gg/api/v2/ws`, subscribed **`stream:16`** (7-Börsen-Aggregat), dekodiert CBOR, sendet Protobuf an den Chart.

Optional:

```bash
export MMT_WS_HOST=eu-central-2.mmt.gg
export MMT_APP_VERSION=4.2.2
export HEATMAP_MAX_LEVELS=800
```

---

## Tests

```bash
cd web/backend && npm install
node ../../scripts/test-mmt-cbor.mjs
node ../../scripts/analyze-mmt-har.mjs ~/Downloads/app.mmt.gg.har
```

---

## Neu (Fortsetzung)

| Feature | Status |
|---------|--------|
| **getrange** 7d Backfill (MMT_TOKEN) | ● beim WS-Connect |
| **TF am WS** `?tf=1h` | ● Backend + obWorker |
| **Kerzen-Snapshots** | ● `candleOpenMs` für Frame-`ts` |
| **Footprint** | ● 128 Bins, POC, Labels |
| **VPVR** | ● `vpvrLayerWorker` + Toolbar-Toggle |

## Nächste Schritte

- [ ] Footprint via MMT `stream:6` (mit Token)
- [ ] Historische Spalten im Frontend puffern (>768 Kerzen)
- [ ] Frontend optional CBOR direkt (ohne Backend)

Siehe auch [`MMT_HAR_ANALYSIS.md`](./MMT_HAR_ANALYSIS.md), [`MMT_WS_CAPTURE.md`](./MMT_WS_CAPTURE.md).
