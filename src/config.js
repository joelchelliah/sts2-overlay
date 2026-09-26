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

  // Character whose ratings to show: ironclad | silent | defect | regent | necrobinder | all
  // Card names are only unique within a character (every character has a "Strike"),
  // so picking your current character gives the correct tier for those.
  character: 'all',

  // Data source: Baalorlord's per-character tier lists on sts2.untapped.gg.
  // One page per character; each is scraped and merged into a single index.
  tierListUrls: {
    ironclad:    'https://sts2.untapped.gg/en/tier-list/004de170-026a-4dd4-a280-3b904be0b5d6',
    silent:      'https://sts2.untapped.gg/en/tier-list/6d61ea21-0552-4c49-8bb5-a5c15530fc00',
    defect:      'https://sts2.untapped.gg/en/tier-list/5a512e04-4583-4a16-9271-d46864c6cb4c',
    necrobinder: 'https://sts2.untapped.gg/en/tier-list/43d0b41f-7d6d-4ce9-928e-c1310a413983',
    regent:      'https://sts2.untapped.gg/en/tier-list/0e6c1e23-bec6-4887-a9e0-dbf49ede974d'
  },
  dataMaxAgeHours: 24,

  // OCR: only scan this region of the screen (fractions of screen size).
  // Card reward cards sit in the middle of the screen.
  ocrRegion: { x: 0.10, y: 0.15, width: 0.80, height: 0.65 },

  // Minimum fuzzy-match similarity (0..1) between OCR text and a card name
  minMatchScore: 0.74,

  // Badge placement as a fraction of screen height, relative to the card-name row
  // (all badges in a row share one y, anchored at the median detected name top).
  // Negative = above the card name. One tier badge per card.
  badgeOffsets: { above: -0.10 },

  // Same, but for shop screens (detected automatically: card names in 2 rows).
  shopBadgeOffsets: { above: -0.08 },

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

  // Show a "Good Upgrade" line under the tier badge for cards the tier list flags
  // as worth upgrading (tierList good_upgrade).
  showGoodUpgrade: true,

  // Use the tier colours from the tier list itself (S blue, A green, ... F red)
  // rather than the overlay's own palette.
  useTierColors: true
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
  // Migrate configs written by older versions
  delete user.labelOffset;    // replaced by badgeOffsets
  delete user.minSamples;     // replaced by sampleThresholds, then dropped
  // sts2.fun era (win-rate data source) — no equivalent under tier lists
  delete user.cardsUrl;
  delete user.characterUrlTemplate;
  delete user.sampleThresholds;
  delete user.baseWinRate;
  delete user.showPickRate;
  // reset badgeOffsets saved in old units, or from the two-badge (win%/upgraded%) era
  if (user.badgeOffsets && (Math.abs(user.badgeOffsets.above) >= 1 || 'below' in user.badgeOffsets)) {
    delete user.badgeOffsets;
  }
  if (user.shopBadgeOffsets && (Math.abs(user.shopBadgeOffsets.above) >= 1 || 'below' in user.shopBadgeOffsets)) {
    delete user.shopBadgeOffsets;
  }
  cached = { ...DEFAULTS, ...user, tierListUrls: { ...DEFAULTS.tierListUrls, ...(user.tierListUrls || {}) } };
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
