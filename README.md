# STS2 Overlay

Purely visual, click-through overlay for Slay the Spire 2 on macOS. On a card reward screen, press a hotkey — the app screenshots the game, OCRs the card names, and shows each card's community win% (from [sts2.fun](https://www.sts2.fun/cards)) as a small badge below the card. It never intercepts mouse or keyboard input.

## Setup

Requires Node.js 18+.

```bash
npm install
npm start
```

First run:

1. **Screen Recording permission** — macOS will prompt (or grant manually in System Settings → Privacy & Security → Screen Recording) for Electron / your terminal app. Required for screenshots. Restart the app after granting.
2. **OCR engine** — the app compiles a tiny Apple Vision OCR helper (needs Xcode Command Line Tools: `xcode-select --install`). If unavailable it falls back to bundled tesseract.js automatically (slower, slightly less accurate on game fonts).
3. Card data is scraped from sts2.fun on startup and cached for 24h in `~/.sts2-overlay/`.

The app lives in the menu bar (small icon, no dock icon).

## Usage

1. Start the overlay, then launch STS2 via Steam.
2. Pick your character from the tray menu (character-specific win rates).
3. **Auto-scan is on by default**: badges appear by themselves on card reward and shop screens, and disappear when you leave. Each card gets two badges: base-card win% above the card, upgraded-card win% below it (regardless of which variant is offered).
4. **⌘⇧1** forces a manual scan (these badges auto-hide after 20s), **⌘⇧2** hides badges immediately. Auto-scan can be toggled in the tray menu.

Auto-scan works by polling a ~48px screen thumbnail every 1.5s and running full OCR only after the screen changes and settles — idle cost is negligible. Note: `captureProtection` hides the overlay from all screen capture (required so it doesn't detect its own badges), so badges won't show up in screenshots or streams; set it `false` (and turn auto-scan off) if you need to capture them.

## Configuration

`~/.sts2-overlay/config.json` (restart to apply):

| Key | Default | Meaning |
|---|---|---|
| `hotkeyScan` / `hotkeyHide` | `Cmd+Shift+1` / `2` | Global hotkeys |
| `character` | `all` | Also settable from the tray menu |
| `badgeOffsets` | `{above:-0.10, below:0.25}` | Badge row positions as fractions of screen height, relative to the card-name row. `above` = base win% badge, `below` = upgraded win% badge |
| `shopBadgeOffsets` | `{above:-0.08, below:0.20}` | Same, for shop screens (smaller cards). Shops are auto-detected: card names in two rows instead of one |
| `baseWinRate` | `pooled` | `pooled` = base+upgraded combined (site default view); `base` = base variant only |
| `ocrRegion` | middle 80×65% | Screen fraction scanned for card names |
| `minMatchScore` | `0.74` | Fuzzy-match threshold OCR→card name |
| `autoHideSeconds` | `20` | For manual scans; `0` = badges stay until hidden |
| `autoScan` | `true` | Automatic scanning on screen change (tray-toggleable) |
| `autoScanIntervalMs` | `1500` | Poll interval for change detection |
| `captureProtection` | `true` | Hide overlay from screen capture (needed by auto-scan) |
| `showPickRate` | `false` | Also show pick% under win% |
| `sampleThresholds` | `{reliable:200, minimum:50}` | Picks needed behind a win%: below `reliable` it shows with ⚠️ and red border; below `minimum` it shows "–" with red border |
| `cardsUrl`, `characterUrlTemplate` | sts2.fun | Data source URLs |

## Fullscreen note

The overlay floats above macOS native-fullscreen Spaces (screen-saver window level + visible-on-all-Spaces). If STS2 ever grabs true exclusive fullscreen and the badges don't appear, switch the game to **borderless windowed / windowed fullscreen** in its video settings.

## If sts2.fun changes its layout

The scraper is generic (sniffs the site's JSON API calls + parses rendered tables), but if it starts extracting 0 cards:

```bash
npm run dump
```

This saves `debug/sniffed.json` (every JSON response the page loaded) and `debug/page.html` (rendered DOM). Adjust the extraction heuristics in `src/cards.js` accordingly.

## How it works

`main.js` — tray app, global hotkeys, transparent always-on-top click-through window spanning the screen. `src/capture.js` — screenshot via desktopCapturer. `src/ocr.js` — Apple Vision (compiled from `visionocr.swift`) or tesseract.js; returns text lines with bounding boxes. `src/match.js` — fuzzy (Levenshtein) matching of OCR lines against card names. `src/cards.js` — hidden-window scraper for sts2.fun with JSON sniffing, DOM fallback, and disk cache. Badge positions are derived from the OCR bounding box of each card's name.
