# `engine.wasm` bauen (Odin → WebAssembly)

Der Heatmap-Chart braucht die Datei **`web/frontend/public/engine.wasm`**. Ohne frischen Build passen Speicher-Layouts (z. B. 8000 Kerzen) nicht zur TypeScript-Bridge → Fehler beim Start.

## Voraussetzung: Odin-Compiler

- **Windows:** Release von [Odin Releases](https://github.com/odin-lang/Odin/releases) entpacken, dann **`odin.exe`** entweder in den **PATH** legen **oder** die Variable **`ODIN_ROOT`** auf den Ordner setzen (der `bin\odin.exe` enthält).
- **WSL / Linux / macOS:** Odin installieren, `odin` muss im **PATH** sein.

## Windows (empfohlen)

```powershell
cd odin
powershell -ExecutionPolicy Bypass -File .\build_engine.ps1
```

Wenn `odin` nicht gefunden wird:

```powershell
$env:ODIN_ROOT = "C:\Pfad\zu\deinem\Odin-Ordner"
powershell -ExecutionPolicy Bypass -File .\build_engine.ps1
```

## Git Bash / WSL (wie Linux)

```bash
cd odin
chmod +x build_engine.sh
./build_engine.sh
```

## Manuell (gleiche Aufrufe wie die Skripte)

```bash
odin build ./odin -target:js_wasm32 -opt:speed -out:web/frontend/public/engine.wasm -no-entry-point
```

(Pfade vom Projektroot aus anpassen.)

## Hinweis

- `heatmap_engine` liegt unter `odin/heatmap/` (eigenes Package) und ist **nicht** Teil von `engine.wasm`; der Chart nutzt nur **`engine.odin`** im Ordner `odin/`.
