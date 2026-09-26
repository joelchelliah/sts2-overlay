# STS2 Overlay

Purely visual, click-through overlay for Slay the Spire 2 on macOS. On a card reward screen, press a hotkey — the app screenshots the game, OCRs the card names, and shows each card's tier rating (e.g. `B - tier`) as a small badge above the card. Ratings come from [Baalorlord's tier lists](https://sts2.untapped.gg/en/tier-lists) on sts2.untapped.gg. It never intercepts mouse or keyboard input.

## Setup

Requires Node.js 18+.

```bash
npm install
npm start
```

First run:

1. **Screen Recording permission** — macOS will prompt (or grant manually in System Settings → Privacy & Security → Screen Recording) for Electron / your terminal app. Required for screenshots. Restart the app after granting.
2. **OCR engine** — the app compiles a tiny Apple Vision OCR helper (needs Xcode Command Line Tools: `xcode-select --install`). If unavailable it falls back to bundled tesseract.js automatically (slower, slightly less accurate on game fonts).
3. Tier data is scraped from sts2.untapped.gg on startup and cached for 24h in `~/.sts2-overlay/`.

The app lives in the menu bar (small icon, no dock icon).

## Usage

1. Start the overlay, then launch STS2 via Steam.
2. Pick your character from the tray menu. This matters: card names are only unique *within* a character — every character has a "Strike" and a "Defend", and they are rated differently (Ironclad's Strike is C, Defect's is F). With `all` selected, an ambiguous name shows the best tier any character gives it.
3. **Auto-scan is on by default**: badges appear by themselves on card reward and shop screens, and disappear when you leave. Each card gets one badge showing its tier, colour-coded S→F, plus a **✓ Good Upgrade** line when the tier list flags the card as worth upgrading.
4. **⌘⇧1** forces a manual scan (these badges auto-hide after 20s), **⌘⇧2** hides badges immediately. Auto-scan can be toggled in the tray menu.

Auto-scan works by polling a ~48px screen thumbnail every 1.5s and running full OCR only after the screen changes and settles — idle cost is negligible. Note: `captureProtection` hides the overlay from all screen capture (required so it doesn't detect its own badges), so badges won't show up in screenshots or streams; set it `false` (and turn auto-scan off) if you need to capture them.

## Configuration

`~/.sts2-overlay/config.json` (restart to apply):

| Key | Default | Meaning |
|---|---|---|
| `hotkeyScan` / `hotkeyHide` | `Cmd+Shift+1` / `2` | Global hotkeys |
| `character` | `all` | Also settable from the tray menu |
| `badgeOffsets` | `{above:-0.10}` | Badge row position as a fraction of screen height, relative to the card-name row (negative = above the card) |
| `shopBadgeOffsets` | `{above:-0.08}` | Same, for shop screens (smaller cards). Shops are auto-detected: card names in two rows instead of one |
| `ocrRegion` | middle 80×65% | Screen fraction scanned for card names |
| `minMatchScore` | `0.74` | Fuzzy-match threshold OCR→card name |
| `autoHideSeconds` | `20` | For manual scans; `0` = badges stay until hidden |
| `autoScan` | `true` | Automatic scanning on screen change (tray-toggleable) |
| `autoScanIntervalMs` | `1500` | Poll interval for change detection |
| `captureProtection` | `true` | Hide overlay from screen capture (needed by auto-scan) |
| `showGoodUpgrade` | `true` | Show the "✓ Good Upgrade" line for cards the tier list marks as worth upgrading |
| `useTierColors` | `true` | Colour-code the tier text S→F; `false` renders badges plain white |
| `tierListUrls` | 5 untapped.gg URLs | Per-character tier-list pages, keyed by character |

## Fullscreen note

The overlay floats above macOS native-fullscreen Spaces (screen-saver window level + visible-on-all-Spaces). If STS2 ever grabs true exclusive fullscreen and the badges don't appear, switch the game to **borderless windowed / windowed fullscreen** in its video settings.

## Data source

Each character has its own tier-list page on sts2.untapped.gg, listed under `tierListUrls` in the config. The pages are server-rendered, so scraping is a plain HTTPS GET — no browser, no SPA wait.

The ratings live in the Next.js RSC flight payload (`self.__next_f.push([1, "…"])`), JSON double-escaped. `src/cards.js` pulls two things out of it:

- the **`tierList`** object — the authority for ratings. A card's rating is *positional*: there is no per-card score, its tier is whichever `tiers[]` bucket the card sits in. Tier orders 0–5 are S/A/B/C/D/F for cards; orders 6+ (`Always Amazing`, …) are the relic/potion scale and are skipped. Each card entry also carries `good_upgrade`.
- a **`card_id` → display name** map, from the per-card render blocks. Needed because OCR reads what the game prints ("Strike") while the tier list keys on ids (`STRIKE_REGENT`); titleizing the id alone would never match.

## If untapped.gg changes its layout

If the scraper starts extracting 0 cards:

```bash
npm run dump
```

This saves each fetched page to `debug/tier-list-<character>.html`. Look for the `\"tierList\":{` marker and the `"item":{"type":"card"` render blocks, and adjust the extraction in `src/cards.js` accordingly.

## How it works

`main.js` — tray app, global hotkeys, transparent always-on-top click-through window spanning the screen. `src/capture.js` — screenshot via desktopCapturer. `src/ocr.js` — Apple Vision (compiled from `visionocr.swift`) or tesseract.js; returns text lines with bounding boxes. `src/match.js` — fuzzy (Levenshtein) matching of OCR lines against card names. `src/cards.js` — HTTPS scraper for the untapped.gg tier lists (RSC payload extraction) with a 24h disk cache. Badge positions are derived from the OCR bounding box of each card's name.
