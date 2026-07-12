// Config: defaults merged with ~/.sts2-overlay/config.json (created on first run).
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.sts2-overlay');
const FILE = path.join(DIR, 'config.json');

const DEFAULTS = {
  // Global hotkeys (Electron accelerator syntax)
  hotkeyScan: 'CommandOrControl+Shift+1',
  hotkeyHide: 'CommandOrControl+Shift+2',

  // Character whose stats to show: ironclad | silent | defect | regent | necrobinder | all
  character: 'all',

  // Data source. ?character=ALL serves every character's cards in one page.
  cardsUrl: 'https://www.sts2.fun/cards?character=ALL',
  // Per-character fallback (site expects uppercase), used only if the ALL page yields nothing.
  characterUrlTemplate: 'https://www.sts2.fun/cards?character={CHARACTER}',
  dataMaxAgeHours: 24,

  // OCR: only scan this region of the screen (fractions of screen size).
  // Card reward cards sit in the middle of the screen.
  ocrRegion: { x: 0.10, y: 0.15, width: 0.80, height: 0.65 },

  // Minimum fuzzy-match similarity (0..1) between OCR text and a card name
  minMatchScore: 0.74,

  // Badge placement as fractions of screen height, relative to the card-name row
  // (all badges in a row share one y, anchored at the median detected name top).
  // above = base win% badge (negative = above the card), below = upgraded win% badge.
  badgeOffsets: { above: -0.10, below: 0.25 },

  // Same, but for shop screens (detected automatically: card names in 2 rows).
  // Shop cards are smaller, so the upgraded badge sits closer to the name row.
  shopBadgeOffsets: { above: -0.08, below: 0.20 },

  // Hide badges automatically after this many seconds (0 = stay until hotkeyHide).
  // Applies to manual (hotkey) scans; auto-scan badges clear when the screen changes.
  autoHideSeconds: 20,

  // Auto-scan: poll a tiny screenshot thumbnail; when the screen changes and then
  // settles, run a scan. Badges appear on reward/shop screens by themselves and
  // disappear when you leave. Toggleable from the tray menu.
  autoScan: true,
  autoScanIntervalMs: 1500,
  // Fraction of thumbnail pixels that must differ to count as a screen change
  autoScanChangedFraction: 0.02,

  // Exclude the overlay from screen capture (required for auto-scan: otherwise our
  // own badges trigger the change detector). Side effect: badges won't appear in
  // screenshots or screen recordings. Set false if you need to capture them.
  captureProtection: true,

  // Show pick% next to win%
  showPickRate: false,

  // Sample-size tiers (number of picks behind a win%):
  //   >= reliable: shown normally
  //   >= minimum:  shown with a warning emoji and red border
  //   <  minimum:  shown as "–" with red border
  sampleThresholds: { reliable: 200, minimum: 50 },

  // Win% shown for non-upgraded cards:
  //   'pooled' — base+upgraded picks combined (matches the site's default view)
  //   'base'   — base variant only (matches the site's "Separate upgrades" view)
  // Upgraded cards (name ending in +) always show upgraded-only stats.
  baseWinRate: 'pooled'
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
    user = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    try { fs.writeFileSync(FILE, JSON.stringify(DEFAULTS, null, 2)); } catch {}
  }
  // Migrate stale defaults written by older versions
  if (user.cardsUrl === 'https://www.sts2.fun/cards') delete user.cardsUrl;
  if (user.characterUrlTemplate === 'https://www.sts2.fun/cards?character={character}') delete user.characterUrlTemplate;
  delete user.labelOffset; // replaced by badgeOffsets
  delete user.minSamples;  // replaced by sampleThresholds
  // reset badgeOffsets saved in old units or old miscalibrated defaults
  if (user.badgeOffsets && (
    Math.abs(user.badgeOffsets.above) >= 1 || Math.abs(user.badgeOffsets.below) >= 1 ||
    (user.badgeOffsets.above === -0.08 && user.badgeOffsets.below === 0.44)
  )) {
    delete user.badgeOffsets;
  }
  cached = { ...DEFAULTS, ...user };
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
