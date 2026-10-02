# STS2 Overlay

Purely visual, click-through overlay for Slay the Spire 2 on macOS. On a card reward screen, press a hotkey — the app screenshots the game, OCRs the names, and shows each item's tier rating (e.g. `B - tier`) as a small badge above it. Cards *and* relics are rated, so shop screens get badges on both. Ratings come from [Baalorlord's tier lists](https://sts2.untapped.gg/en/tier-lists) on sts2.untapped.gg. It never intercepts mouse or keyboard input.

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
2. Pick your character from the tray menu. This matters: names are only unique *within* a list — every character has a "Strike" and a "Defend", and they are rated differently (Ironclad's Strike is C, Defect's is F). With `all` selected, an ambiguous name shows the best tier any list gives it.
3. **Auto-scan is on by default**: badges appear by themselves on card reward and shop screens, and disappear when you leave. Each card gets one badge showing its tier, colour-coded S→F, plus a **✓ Good Upgrade** line when the tier list flags the card as worth upgrading. Relics get a badge too — see below.
4. **⌘⇧1** forces a manual scan (these badges auto-hide after 20s), **⌘⇧2** hides badges immediately. Auto-scan can be toggled in the tray menu.
5. **⌘⇧3** toggles the **relic list**: every rated relic, grouped by tier, best first, in the same colours the badges use. Press again (or ⌘⇧2, or run a scan) to close it. This is the workaround for shops — they show relics as bare icons with no name to OCR — so you can look up what you're being offered.
6. **Combat is skipped.** The cards in your hand are already in your deck, so rating them is noise. The overlay recognises a fight by the "End Turn" button and stays out of the way; the card reward *after* the fight is a separate screen and still gets badged. Set `skipInCombat: false` to rate the hand anyway.

### Relics

Relics are rated from the same tier lists and badged the same way. They show up in two places so far:

- **Act-start relic offers** — the screen offering one of three relics, listed vertically after a line or two of dialogue. Badges hang in the empty gutter to the left of each relic, clear of the icons.
- **Shops** — the cards for sale are badged normally. The relics and potions on the right are **not**, and can't be: the shop prints only their price, never their name, so a screenshot of an un-hovered shop doesn't contain enough to identify them. Potions aren't rated by the tier lists at all (`potions[]` is empty on every page), so there'd be nothing to show for those regardless.

Two things differ from cards:

- **They use their own scale.** Most relics are rated `Always Amazing` → `Always Good` → `Needs Synergy` → `Inconsistent` → `Almost Never`, shown verbatim on the badge. About 30 relics sit in the ordinary S–F buckets instead and read as `S - tier`. Both scales share one colour ramp, so blue is the best thing on screen either way.
- **No upgrade line.** Relics aren't upgradable, so they never show ✓ Good Upgrade.

Picking your character matters here as much as it does for cards: each character's list rates ~10 relics itself, and those ratings can be opposites. Precarious Shears is `Always Amazing` for Defect and `Almost Never` for Ironclad. With a character selected you get that character's verdict; everything else falls back to the colorless list.

Other places relics appear (chests, boss rewards, events) aren't recognised yet — those that print the relic's name should work once wired up; those that show only an icon have the same limitation as the shop.

Set `showRelics: false` in the config to badge cards only.

Auto-scan works by polling a ~48px screen thumbnail every 1.5s and running full OCR a beat after the screen changes — idle cost is negligible. Game screens are never perfectly still (water, torchlight, drifting backgrounds move ~8% of the thumbnail frame to frame, against ~50% for a real transition), so the change threshold sits well above that animation, and badges are cleared when a scan finds nothing rather than whenever pixels move. A threshold below the animation makes the overlay read every frame as a new screen: auto-scan never fires and badges are wiped moments after appearing. Note: `captureProtection` hides the overlay from all screen capture (required so it doesn't detect its own badges), so badges won't show up in screenshots or streams; set it `false` (and turn auto-scan off) if you need to capture them.

## Configuration

Settings live in **`~/.sts2-overlay/config.json`** — edit that file, then restart.

> **Not `src/config.js`.** That file only holds the *defaults*, which the saved
> config overrides key by key. Editing the source has no effect once a value is
> saved, which looks exactly like the setting being ignored. The app prints the
> live path and current badge offsets at startup, so check that line first if a
> change seems to do nothing.

All offsets are **fractions of screen size**, never pixels: `0.01` is 1% of the
screen, roughly 29px wide / 19px tall at 2940×1912. A value like `50` is not
"50 pixels" — it would be 50 screens' worth, far out of view. Values outside
-1…1 are rejected at load with a warning and fall back to the default.

| Key | Default | Meaning |
|---|---|---|
| `hotkeyScan` / `hotkeyHide` | `Cmd+Shift+1` / `2` | Global hotkeys |
| `hotkeyRelics` | `Cmd+Shift+3` | Toggles the relic reference list |
| `character` | `all` | Also settable from the tray menu |
| `badgeNudge` | `{x:0, y:0}` | **Uniform nudge for every badge on every screen** — the knob for fine-tuning placement. Fractions of screen size: negative `x` = left, negative `y` = up. `0.01` ≈ 29px on a 2940px-wide screen |
| `badgeOffsets` | `{above:-0.10}` | Badge row position as a fraction of screen height, relative to the card-name row (negative = above the card) |
| `shopBadgeOffsets` | `{above:-0.08}` | Same, for shop screens (smaller cards). Shops are auto-detected: names in two or more rows instead of one |
| `relicBadgeOffsets` | `{above:-0.05}` | Same, for a horizontal row of relics (shops) |
| `relicListBadgeOffsets` | `{x:-0.075, y:0}` | Badge position on act-start relic offers **only** — shops are unaffected. Screen fractions from the name's left edge and middle; `x` is wide enough to clear the relic icon, which OCR can't see |
| `showRelics` | `true` | Rate relics as well as cards |
| `skipInCombat` | `true` | Don't scan during a fight — the hand is cards you already own, so there's no pick to inform. Detected by the "End Turn" button |
| `ocrRegion` | 80% wide, y 0.18–0.92 | Screen fraction scanned for names. Must reach low enough for the third relic in an act-start offer (~y=0.86) while still excluding the HUD |
| `minMatchScore` | `0.74` | Fuzzy-match threshold OCR→card name |
| `autoHideSeconds` | `20` | For manual scans; `0` = badges stay until hidden |
| `autoScan` | `true` | Automatic scanning on screen change. Set `false` to scan only on ⌘⇧1. Also toggleable from the tray menu |
| `autoScanIntervalMs` | `1500` | Poll interval for change detection |
| `autoScanChangedFraction` | `0.25` | Thumbnail fraction that must differ to count as a new screen. Has to clear the game's ambient animation (~0.08); a real transition is ~0.50 |
| `autoScanSettleTicks` | `2` | Ticks to wait after a change before scanning, so one transition triggers one scan |
| `captureProtection` | `true` | Hide overlay from screen capture (needed by auto-scan) |
| `showGoodUpgrade` | `true` | Show the "✓ Good Upgrade" line for cards the tier list marks as worth upgrading |
| `useTierColors` | `true` | Colour-code the tier text S→F; `false` renders badges plain white |
| `tierListUrls` | 6 untapped.gg URLs | Tier-list pages: one per character, plus `colorless` (colorless cards and most relics) |

### Fine-tuning badge placement

`badgeNudge` shifts every badge on every screen at once, which is usually what you want:

```jsonc
// ~/.sts2-overlay/config.json — restart to apply
"badgeNudge": { "x": 0, "y": -0.01 }   // all badges 19px higher on a 1912px-tall screen
```

Both values are fractions of screen size, so a setting that looks right holds at any resolution. Negative `x` moves left, negative `y` moves up.

If only *one kind* of screen is off, adjust that layout's own offset instead and leave the nudge at zero. The nudge is applied on top of whichever of these matched:

| Key | Screen | Axes |
|---|---|---|
| `badgeOffsets` | card rewards | vertical only |
| `shopBadgeOffsets` | shops | vertical only |
| `relicBadgeOffsets` | a horizontal row of relics (shops) | vertical only |
| `relicListBadgeOffsets` | act-start relic offers (one of three relics) | `x` and `y` |

These are independent — tuning the act-start relic offer leaves shop badges exactly where they were:

```jsonc
// nudge the three act-start relic badges left and up; nothing else moves
"relicListBadgeOffsets": { "x": -0.09, "y": -0.01 }
```

## Fullscreen note

The overlay floats above macOS native-fullscreen Spaces (screen-saver window level + visible-on-all-Spaces). If STS2 ever grabs true exclusive fullscreen and the badges don't appear, switch the game to **borderless windowed / windowed fullscreen** in its video settings.

## Data source

Six pages on sts2.untapped.gg are scraped, listed under `tierListUrls` in the config: one per character, plus the colorless list. They are server-rendered, so scraping is a plain HTTPS GET — no browser, no SPA wait. Together they yield ~543 card and ~178 relic ratings.

The ratings live in the Next.js RSC flight payload (`self.__next_f.push([1, "…"])`), JSON double-escaped. `src/cards.js` pulls two things out of it:

- the **`tierList`** object — the authority for ratings. A rating is *positional*: there is no per-item score, its tier is whichever `tiers[]` bucket the item sits in. Each tier holds a `cards[]` and a `relics[]` array. Card entries also carry `good_upgrade`; relic entries don't.
- an **id → display name** map, from the per-item render blocks (`"item":{"type":"card"…}` and `"type":"relic"`). Needed because OCR reads what the game prints ("Strike") while the tier list keys on ids (`STRIKE_REGENT`); titleizing the id alone would never match.

### The two tier scales

One `tiers[]` array carries two parallel scales:

| Orders | Scale | Holds |
|---|---|---|
| 0–5 | S / A / B / C / D / F | all cards, and ~30 relics |
| 6–10 | Always Amazing / Always Good / Needs Synergy / Inconsistent / Almost Never | relics only |

Character pages only ever fill orders 0–5 with cards, but they *do* rate ~10 relics each across both scales. So cards are read from orders 0–5 only, while relics are read from every tier on every page.

Because the same item can be rated on more than one page, `buildIndex` resolves duplicates: the selected character's own rating wins, otherwise the best tier wins. That ordering matters — the colorless list rates a card generically while a character's list rates it *for that character*, and the latter is usually higher (Finesse is B colorless, S for Ironclad).

## If untapped.gg changes its layout

If the scraper starts extracting 0 cards:

```bash
npm run dump
```

This saves each fetched page to `debug/tier-list-<character>.html` (including `tier-list-colorless.html`). Look for the `\"tierList\":{` marker and the `"item":{"type":"card"` / `"type":"relic"` render blocks, and adjust the extraction in `src/cards.js` accordingly.

## How it works

`main.js` — tray app, global hotkeys, transparent always-on-top click-through window spanning the screen. `src/capture.js` — screenshot via desktopCapturer. `src/ocr.js` — Apple Vision (compiled from `visionocr.swift`) or tesseract.js; returns text lines with bounding boxes. `src/match.js` — fuzzy (Levenshtein) matching of OCR lines against card and relic names, plus the layout detection that tells the screens apart. Layout is read from the shape of the matches rather than by trying to identify the screen: names sharing a *y* are a row of cards, while relics sharing an *x* down a column are an act-start relic offer. `src/cards.js` — HTTPS scraper for the untapped.gg tier lists (RSC payload extraction) with a 24h disk cache. Badge positions are derived from the OCR bounding box of each name.
