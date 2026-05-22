# MMT.gg WebSocket — Capture-Analyse

## Capture 1 — 53 Bytes (DevTools Copy)

```
815832a56130a261306061316061310e6132006133581ba361301b18b0f1bc4db0884161311b18b0f1bc899d1b2b61321829613400
```

Kleines CBOR-Control/Envelope — **kein** voller Heatmap-Frame. Siehe frühere Analyse.

---

## Capture 2 — `Downloads/<!DOCTYPE html>.html` (~2,8 MB)

| | |
|--|--|
| **Größe** | 2 809 315 Bytes (ein WebSocket-Binary-Frame) |
| **Format** | CBOR: äußeres Array → inneres Byte-String → Map-Envelope |
| **Börse / Pair** | `binance` / `btc/usd` |
| **Typ-Feld `1`** | `1` (vermutlich Batch-Typ / Kanal-ID) |

### Envelope (äußere Map, Keys `"0"`–`"4"`)

| Key | Inhalt |
|-----|--------|
| `0` | `{ "0": "binance", "1": "btc/usd" }` |
| `1` | `1` |
| `2` | `0` |
| `3` | **~2,8 MB** — eine Heatmap-Säule (volle OB-Tiefe) |
| `4` | `0` |

### Eine Säule (Map in Feld `3`, Keys `"0"`–`"9"`)

Dekodiert mit `cbor` (Node). **Eine Kerze / ein Zeitpunkt**, nicht tausende Spalten.

| Key | Typ | Beispiel / Bedeutung |
|-----|-----|----------------------|
| `0` | int | `1779188020` → **2026-05-19T10:53:40Z** (`t`) |
| `1` | map | `{ "0": "binance", "1": "btc/usd" }` |
| `2` | float[] | **~75 834** Ask-**Preise** (aufsteigend, ~76 919+) |
| `3` | float[] | **~75 834** Ask-**Sizes** (USD, passend zu `2`) |
| `4` | float[] | **~85 837** Bid-**Preise** (absteigend, ~76 919−) |
| `5` | float[] | **~85 837** Bid-**Sizes** |
| `6` | float | `76919.25` → **Last Price** (`lp`) |
| `7` | bool | `true` (evtl. Snapshot-Flag) |
| `8` | int | `242055` (evtl. Sequenz / interner Index) |
| `9` | int | `1` |

**Abweichung von [API-Docs](https://docs.mmt.gg/api/basics/types):** Dokumentiert sind `FlatHeatmap` (`s[]` + `minp` + `pg`) oder `Heatmap` mit `p[]` + `s[]` + `si`. Dieser Bulk-Frame nutzt **getrennte Ask/Bid-Preis- und Size-Arrays** — renderer-optimiert, ~161k Levels pro Säule.

### Vergleich mit unserem Stack

| | MMT (dieser Frame) | MMT-Trade |
|--|-------------------|--------------|
| Encoding | CBOR | Protobuf `HeatmapFrame` |
| Modell | Ask/Bid-Preisarrays + Sizes | `levels[]` mit `price`, `volume`, `isBid` |
| Tiefe | ~160k Levels / Seite | Top-N Depth + Bins |
| Endpoint | `wss://eu-central-1.mmt.gg/api/v1/ws?format=cbor` | `/ws/heatmap` (eigenes Backend) |

---

## MMT API (öffentlich)

- **WS:** `wss://eu-central-1.mmt.gg/api/v1/ws?api_key=…&format=cbor`
- **Kanäle:** `flat_heatmap_hd`, `heatmap_sd`, … ([Channels](https://docs.mmt.gg/api/websocket/channels))
- **Aggregat:** `exchange: "binancef:bybitf"` (alphabetisch)

---

## Decode-Hilfe

```bash
# Kleine Hex-Zeile
node scripts/decode-ws-hex.mjs <hex>

# Große Capture-Datei (nur Envelope + Spalten-Header)
node scripts/decode-mmt-capture.mjs "/Users/lukas/Downloads/<!DOCTYPE html>.html"
```

Benötigt `cbor` (im Repo-Root nach `npm install cbor`).

---

## Nächste sinnvolle Captures

1. **WS-URL** inkl. `format=cbor` und Subscribe-JSON (`channel`, `tf`)
2. **Mehrere kleine Frames** (~1 Hz) — Live-Updates vs. dieser Mega-Snapshot
3. **Frame genau bei Kerzenschluss** — Bestätigung „Snapshot pro Kerze“
