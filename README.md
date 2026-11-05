# SpaceLens

**Ein moderner, übersichtlicher Festplatten-Analysator** – die bessere Alternative zu WinDirStat.

SpaceLens zeigt klar und verständlich, **was** auf deinen Laufwerken Platz verbraucht, **wie wichtig** es ist und **was du gefahrlos aufräumen kannst**.

## Features

### Kern
- **Sehr schneller Scan** (Rust + walkdir)
- **Live-Fortschritt** während des Scans (Dateien, Bytes, aktuelle Phase)
- **Kategorien**: Programme, Dokumente, Bilder, Videos, Audio, Archive, Downloads, Temporär/Cache, System, Entwicklung, Sonstiges
- **Wichtigkeits-Score** (Größe + Alter + Kategorie)

### Visualisierung
- **Interaktive Treemap** (klicken zum Hineinzoomen)
- Klassische Baumansicht
- Kategorien-Balken
- „Größte Elemente“-Liste

### Smart Features
- **Installierte Programme erkennen** (Program Files, /Applications, .app-Bundles usw.)
- **Duplikate finden** (schneller Partial-Hash, Dateien ≥ 1 MB)
- **Intelligente Empfehlungen** (Caches, alte Downloads, node_modules, Build-Artefakte …)
- **In Papierkorb verschieben** (sicher, plattformübergreifend)

## Voraussetzungen

- Node.js 18+
- Rust (aktuell, am besten über rustup)
- Linux: WebKitGTK Entwicklungs-Pakete

### Linux (Ubuntu/Debian)
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

## Installation & Start

```bash
cd space-lens
npm install
npm run tauri dev
```

## Produktion bauen

```bash
npm run tauri build
```

Viel Spaß beim Aufräumen!
