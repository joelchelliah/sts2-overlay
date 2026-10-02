// Config: defaults merged with ~/.sts2-overlay/config.json (created on first run).
const fs = require("fs");
const path = require("path");
const os = require("os");

const DIR = path.join(os.homedir(), ".sts2-overlay");
const FILE = path.join(DIR, "config.json");

const DEFAULTS = {
  // Global hotkeys (Electron accelerator syntax)
  hotkeyScan: "CommandOrControl+Shift+1",
  hotkeyHide: "CommandOrControl+Shift+2",
  // Toggles the relic reference list (all rated relics, grouped by tier). Shops
  // show relics as bare icons with no name to OCR, so the list is the fallback.
  hotkeyRelics: "CommandOrControl+Shift+3",

  // Character whose ratings to show: ironclad | silent | defect | regent | necrobinder | all
  // Card names are only unique within a character (every character has a "Strike"),
  // so picking your current character gives the correct tier for those.
  character: "all",

  // Data source: Baalorlord's tier lists on sts2.untapped.gg. One page per
  // character plus the colorless list; each is scraped and merged into a single
  // index. The colorless page is where colorless cards and most relic ratings come
  // from; character pages also rate ~10 relics each, and those ratings win when
  // that character is selected (they differ a lot: Precarious Shears is
  // "Always Amazing" for Defect and "Almost Never" for Ironclad).
  tierListUrls: {
    ironclad:
      "https://sts2.untapped.gg/en/tier-list/004de170-026a-4dd4-a280-3b904be0b5d6",
    silent:
      "https://sts2.untapped.gg/en/tier-list/6d61ea21-0552-4c49-8bb5-a5c15530fc00",
    defect:
      "https://sts2.untapped.gg/en/tier-list/5a512e04-4583-4a16-9271-d46864c6cb4c",
    necrobinder:
      "https://sts2.untapped.gg/en/tier-list/43d0b41f-7d6d-4ce9-928e-c1310a413983",
    regent:
      "https://sts2.untapped.gg/en/tier-list/0e6c1e23-bec6-4887-a9e0-dbf49ede974d",
    colorless:
      "https://sts2.untapped.gg/en/tier-list/0a626c22-dc49-433e-ac6e-76cc9abf5684",
  },
  dataMaxAgeHours: 24,

  // OCR: only scan this region of the screen (fractions of screen size).
  // Card reward cards sit in the middle; act-start relic offers run lower, with
  // the third relic's name near y=0.86, so the region has to reach past it. The
  // top cut still clears the HUD (HP/gold, ~y=0.10) and the version/seed stamp
  // (~y=0.17), which is what keeps them out of the matcher.
  ocrRegion: { x: 0.1, y: 0.18, width: 0.8, height: 0.74 },

  // Minimum fuzzy-match similarity (0..1) between OCR text and a card name
  minMatchScore: 0.74,

  // Uniform nudge applied to every badge, whatever the screen — the knob to reach
  // for when badges are consistently a bit off. Fractions of screen size, so it
  // holds at any resolution: negative x = left, negative y = up. The per-layout
  // offsets below stay as the baseline; this shifts all of them together.
  // 0.01 is roughly 29px on a 2940px-wide screen.
  badgeNudge: { x: 0, y: 0 },

  // Badge placement as a fraction of screen height, relative to the card-name row
  // (all badges in a row share one y, anchored at the median detected name top).
  // Negative = above the card name. One tier badge per card.
  badgeOffsets: { above: -0.1 },

  // Same, but for shop screens (detected automatically: card names in 2 rows).
  shopBadgeOffsets: { above: -0.08 },

  // Relics in shops sit in their own row and are smaller than cards, so their
  // badges get their own offset. Relic names are matched the same way as cards.
  relicBadgeOffsets: { above: -0.05 },

  // Act-start relic offers (the screen offering one of three relics) list them
  // vertically, names left-aligned with the description to the right. The badge
  // hangs in the gutter left of the name: right-aligned at `x` from the name's
  // left edge, vertically centred on the name at `y` from its middle. Fractions of
  // screen size, same sign convention as badgeNudge — negative x = left, y = up.
  //
  // This is the knob for that screen alone; shops are unaffected. `x` has to clear
  // the relic icon, which sits between the gutter and the name and is invisible to
  // OCR (no text on it), so it can't be measured — only allowed for.
  relicListBadgeOffsets: { x: -0.075, y: 0 },

  // Skip scanning during combat: the cards in hand are already in your deck, so
  // there is no pick to inform. Detected by the "End Turn" button.
  skipInCombat: true,

  // Show relic ratings in addition to card ratings. Relics use their own tier
  // scale ("Always Amazing" ... "Almost Never") shown verbatim, except for the
  // ~30 relics the lists place in the S..F buckets.
  showRelics: true,

  // Hide badges automatically after this many seconds (0 = stay until hotkeyHide).
  // Applies to manual (hotkey) scans; auto-scan badges clear when the screen changes.
  autoHideSeconds: 20,

  // Auto-scan: poll a tiny screenshot thumbnail; when the screen changes and then
  // settles, run a scan. Badges appear on reward/shop screens by themselves and
  // disappear when you leave. Toggleable from the tray menu.
  // Set false to scan only when you press hotkeyScan. Also toggleable from the
  // tray menu (which writes this key back here).
  autoScan: true,
  autoScanIntervalMs: 1500,
  // Fraction of thumbnail pixels that must differ to count as a screen change.
  // Must clear the game's ambient animation (water, torchlight, drifting
  // backgrounds), which moves ~8% of the thumbnail between any two frames on a
  // static screen. A real screen transition moves ~50%, so 0.25 sits well clear of
  // the noise with room to spare. Too low and the overlay reads every animated
  // frame as a new screen: it never settles, so auto-scan never fires and badges
  // are wiped a second after appearing.
  autoScanChangedFraction: 0.25,
  // Quiet-ish ticks to wait after a change before scanning, so a transition that
  // spans several frames triggers one scan at the end rather than one per frame.
  autoScanSettleTicks: 2,

  // Exclude the overlay from screen capture (required for auto-scan: otherwise our
  // own badges trigger the change detector). Side effect: badges won't appear in
  // screenshots or screen recordings. Set false if you need to capture them.
  captureProtection: true,

  // Show a "Good Upgrade" line under the tier badge for cards the tier list flags
  // as worth upgrading (tierList good_upgrade).
  showGoodUpgrade: true,

  // Use the tier colours from the tier list itself (S blue, A green, ... F red)
  // rather than the overlay's own palette.
  useTierColors: true,
};

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

let cached = null;

function get() {
  if (cached) return cached;
  ensureDir();
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    try {
      fs.writeFileSync(FILE, JSON.stringify(DEFAULTS, null, 2));
    } catch {}
  }
  // Migrate configs written by older versions
  delete user.labelOffset; // replaced by badgeOffsets
  delete user.minSamples; // replaced by sampleThresholds, then dropped
  // sts2.fun era (win-rate data source) — no equivalent under tier lists
  delete user.cardsUrl;
  delete user.characterUrlTemplate;
  delete user.sampleThresholds;
  delete user.baseWinRate;
  delete user.showPickRate;
  // reset badgeOffsets saved in old units, or from the two-badge (win%/upgraded%) era
  if (
    user.badgeOffsets &&
    (Math.abs(user.badgeOffsets.above) >= 1 || "below" in user.badgeOffsets)
  ) {
    delete user.badgeOffsets;
  }
  if (
    user.shopBadgeOffsets &&
    (Math.abs(user.shopBadgeOffsets.above) >= 1 ||
      "below" in user.shopBadgeOffsets)
  ) {
    delete user.shopBadgeOffsets;
  }
  // The card-era region stopped at y=0.80 and cropped the third relic out of
  // act-start offers (its name sits near y=0.86). Drop it so the wider default
  // applies; a region the user actually tuned themselves is left alone.
  if (
    user.ocrRegion &&
    user.ocrRegion.y === 0.15 &&
    user.ocrRegion.height === 0.65
  ) {
    delete user.ocrRegion;
  }
  // relicListBadgeOffsets used left/top before; x/y matches badgeNudge's naming
  // and sign convention. Carry a saved value over rather than dropping it.
  if (user.relicListBadgeOffsets) {
    const o = user.relicListBadgeOffsets;
    if ("left" in o && !("x" in o)) {
      o.x = o.left;
      delete o.left;
    }
    if ("top" in o && !("y" in o)) {
      o.y = o.top;
      delete o.top;
    }
  }
  // 0.02 was below the game's ambient animation, so every frame read as a screen
  // change: auto-scan never settled and manual badges were wiped ~1s in.
  if (
    user.autoScanChangedFraction !== undefined &&
    user.autoScanChangedFraction <= 0.05
  ) {
    delete user.autoScanChangedFraction;
  }
  // Offset objects are merged per-key: a config written before a new offset
  // existed would otherwise pass through a half-populated object and crash on the
  // missing side (e.g. relicListBadgeOffsets.left).
  const OFFSET_KEYS = [
    "badgeNudge",
    "badgeOffsets",
    "shopBadgeOffsets",
    "relicBadgeOffsets",
    "relicListBadgeOffsets",
  ];
  const offsets = {};
  for (const k of OFFSET_KEYS) {
    const merged = { ...DEFAULTS[k], ...(user[k] || {}) };
    // Offsets are *fractions of screen size*, so every sane value is well under 1.
    // A number like 50 (mistaking the unit for pixels) would throw the badge tens
    // of thousands of pixels off screen, which looks exactly like "badges stopped
    // working". Fall back to the default for that axis and say so, rather than
    // rendering into the void.
    for (const axis of Object.keys(merged)) {
      const v = merged[axis];
      if (typeof v !== 'number' || !isFinite(v) || Math.abs(v) > 1) {
        console.warn(`[config] ${k}.${axis} = ${v} is not a screen fraction ` +
                     `(expected between -1 and 1) — using default ${DEFAULTS[k][axis]}`);
        merged[axis] = DEFAULTS[k][axis];
      }
    }
    offsets[k] = merged;
  }
  cached = {
    ...DEFAULTS,
    ...user,
    ...offsets,
    tierListUrls: { ...DEFAULTS.tierListUrls, ...(user.tierListUrls || {}) },
  };
  return cached;
}

function set(patch) {
  const cfg = { ...get(), ...patch };
  cached = cfg;
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

module.exports = { get, set, DIR, FILE };
