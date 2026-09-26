// STS2 Overlay — purely visual, click-through overlay showing card tier ratings
// from Baalorlord's tier lists on sts2.untapped.gg.
// Hotkey (default Cmd+Shift+1) on a card reward screen: screenshots the game,
// OCRs the card names, and shows a tier badge (e.g. "B - tier") above each card.
const { app, BrowserWindow, Tray, Menu, globalShortcut, screen, nativeImage } = require('electron');
const path = require('path');
const config = require('./src/config');
const cards = require('./src/cards');
const capture = require('./src/capture');
const ocr = require('./src/ocr');
const { matchLines } = require('./src/match');

// Tier orders 6+ are the relic-only scale, whose names are already prose.
const FIRST_RELIC_TIER_ORDER = 6;

// Selectable in the tray. 'colorless' is a tier-list source, not a playable
// character, so it is deliberately absent: its ratings are merged in as the
// fallback for anything the chosen character's own list doesn't rate.
const CHARACTERS = ['all', 'ironclad', 'silent', 'defect', 'regent', 'necrobinder'];

let overlayWin = null;
let tray = null;
let hideTimer = null;
let cardData = null;
let busy = false;

// ── Menu bar indicator. The tray title is the only always-visible sign the app is
// alive, so it doubles as a status light: at a glance you can tell the difference
// between "running and watching", "working right now", "showing N badges", and
// "something broke" — which otherwise all looked identical (a static "S2").
const TRAY_STATES = {
  idle:     { title: 'S2 ●',  tip: 'Watching for card screens' },
  scanning: { title: 'S2 ◉',  tip: 'Scanning…' },
  paused:   { title: 'S2 ⏸',  tip: 'Auto-scan off — use the hotkey to scan' },
  error:    { title: 'S2 ⚠',  tip: 'Last scan failed — see the console' }
};
let trayState = 'idle';
let lastHitCount = 0;

function setTrayState(state, detail) {
  trayState = state;
  if (state === 'hit') lastHitCount = detail;
  if (!tray) return;
  if (state === 'hit') {
    // Card count is the most useful confirmation: badges are on screen right now.
    tray.setTitle(`S2 ✓${detail}`);
    tray.setToolTip(`STS2 Overlay — showing ${detail} card${detail === 1 ? '' : 's'}`);
    return;
  }
  const s = TRAY_STATES[state] || TRAY_STATES.idle;
  tray.setTitle(s.title);
  tray.setToolTip('STS2 Overlay — ' + s.tip);
}

// Back to whatever resting state matches the config: watching, or paused.
function restTrayState() {
  setTrayState(config.get().autoScan ? 'idle' : 'paused');
}

function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlayWin = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    transparent: true, frame: false, hasShadow: false, resizable: false,
    movable: false, focusable: false, skipTaskbar: true, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  overlayWin.setIgnoreMouseEvents(true);                                   // never eat clicks
  overlayWin.setAlwaysOnTop(true, 'screen-saver');                         // above the game
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // over fullscreen Spaces
  if (config.get().captureProtection) overlayWin.setContentProtection(true); // invisible to our own screenshots
  overlayWin.loadFile(path.join(__dirname, 'src', 'overlay.html'));
}

function send(channel, payload) {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(channel, payload);
}

function showStatus(msg, autoClearMs = 0) {
  send('status', msg);
  overlayWin.showInactive();
  if (autoClearMs) setTimeout(() => send('status', null), autoClearMs);
}

function hideOverlay() {
  clearTimeout(hideTimer);
  send('clear');
  if (overlayWin) overlayWin.hide();
  restTrayState();
}

async function scan(auto = false) {
  if (busy) return;
  busy = true;
  setTrayState('scanning');
  const cfg = config.get();
  try {
    send('clear');
    if (!auto) showStatus('Scanning…');

    const shot = await capture.captureScreen();
    const lines = await ocr.recognize(shot.png, shot.width, shot.height);
    if (!cardData) cardData = await cards.getData();
    const index = cards.buildIndex(cardData, cfg.character);
    const rows = matchLines(lines, index, cfg.minMatchScore, shot.height * 0.05);
    const matches = rows.flat();

    if (!matches.length) {
      if (auto) hideOverlay();           // not a card screen — stay silent
      else showStatus('No cards recognized', 2500);
      restTrayState();
      return;
    }

    // Screen type from layout: reward screens have one row of card names,
    // shops have two or more (class cards, colorless cards, and a row of relics).
    // Shop cards are smaller, so they get their own offsets.
    const isShop = rows.length > 1;
    const cardOff = isShop ? cfg.shopBadgeOffsets : cfg.badgeOffsets;

    // One badge per item, above its name. Badges share row-level y positions:
    // anchored at each row's median name top (names are aligned), offset by a
    // fraction of screen height (game UI scales with resolution). A row of relics
    // uses the relic offset — relic names sit closer to their art than card names
    // do, so reusing the card offset would float the badge too high.
    const labels = rows.flatMap(row => {
      const isRelicRow = row.every(m => m.card.kind === 'relic');
      const off = isRelicRow ? cfg.relicBadgeOffsets : cardOff;
      const ys = row.map(m => m.line.y).sort((a, b) => a - b);
      const anchorY = ys[Math.floor(ys.length / 2)];
      const y = (anchorY + off.above * shot.height) / shot.scale;
      return row.map(m => ({
        x: (m.line.x + m.line.w / 2) / shot.scale,
        y,
        // Relic tiers are already prose ("Always Amazing"); only the letter tiers
        // read as a grade needing the " - tier" suffix.
        text: m.card.tier
          ? (m.card.kind === 'relic' && m.card.tierOrder >= FIRST_RELIC_TIER_ORDER
              ? m.card.tier
              : `${m.card.tier} - tier`)
          : '–',
        kind: m.card.kind || 'card',
        tier: m.card.tier || null,
        tierOrder: m.card.tierOrder ?? null,
        color: m.card.tierColor || null,   // the site's own colour, as a fallback
        colored: cfg.useTierColors !== false,
        sub: cfg.showGoodUpgrade && m.card.goodUpgrade ? 'Good Upgrade' : null // overlay prepends the ✓
      }));
    });

    send('status', null);
    send('labels', labels);
    overlayWin.showInactive();
    setTrayState('hit', matches.length);
    console.log(`[scan] ${isShop ? 'shop' : 'reward'}:`, matches.map(m =>
      `${m.card.name}${m.card.kind === 'relic' ? '[relic]' : ''}=${m.card.tier}` +
      `${m.card.goodUpgrade ? '+up' : ''} (${m.score.toFixed(2)})`).join(', '));

    clearTimeout(hideTimer);
    // auto-scan badges persist until the screen changes; manual ones time out
    if (!auto && cfg.autoHideSeconds > 0) hideTimer = setTimeout(hideOverlay, cfg.autoHideSeconds * 1000);
  } catch (e) {
    console.error('[scan]', e);
    setTrayState('error');
    if (!auto) showStatus('Error: ' + e.message.slice(0, 80), 4000);
  } finally {
    busy = false;
  }
}

// ── Auto-scan: poll a tiny thumbnail; on screen change hide badges, and once the
// screen settles (one quiet interval) run a scan. Cheap while idle: one ~48px
// screenshot per interval, full OCR only after actual changes.
let autoTimer = null;
let prevThumb = null;
let dirty = true; // scan once on startup

function setAutoScan(enabled) {
  config.set({ autoScan: enabled });
  clearInterval(autoTimer);
  autoTimer = null;
  prevThumb = null;
  if (!enabled) { setTrayState('paused'); return; }
  restTrayState();
  dirty = true;
  const cfg = config.get();
  autoTimer = setInterval(async () => {
    if (busy) return;
    try {
      const thumb = await capture.captureThumbnail();
      const changed = capture.diffFraction(prevThumb, thumb) > cfg.autoScanChangedFraction;
      prevThumb = thumb;
      if (changed) {
        dirty = true;
        hideOverlay(); // stale badges shouldn't linger over a new screen
      } else if (dirty) {
        dirty = false;
        await scan(true);
      }
    } catch (e) {
      console.error('[auto]', e.message);
    }
  }, cfg.autoScanIntervalMs);
}

async function refreshData(force) {
  try {
    cardData = await cards.getData(force);
    buildTray();
  } catch (e) {
    console.error('[data]', e.message);
    setTrayState('error');
    showStatus('Data refresh failed: ' + e.message.slice(0, 60), 5000);
  }
}

function buildTray() {
  const cfg = config.get();
  if (!tray) {
    // simple 16x16 dot as tray icon
    tray = new Tray(nativeImage.createEmpty());
  }
  // Rebuilding the menu must not blank the indicator — repaint the current state.
  setTrayState(trayState, trayState === 'hit' ? lastHitCount : undefined);
  const gameVersion = cardData && cardData.sources
    ? Object.values(cardData.sources).map(s => s.gameVersion).find(Boolean)
    : null;
  const relicCount = cardData ? cardData.cards.filter(c => c.kind === 'relic').length : 0;
  const dataInfo = cardData
    ? `Data: ${cardData.cards.length - relicCount} cards · ${relicCount} relics` +
      `${gameVersion ? ' · ' + gameVersion : ''} (${new Date(cardData.fetchedAt).toLocaleString()})`
    : 'Data: not loaded';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: dataInfo, enabled: false },
    { type: 'separator' },
    {
      label: 'Character',
      submenu: CHARACTERS.map(ch => ({
        label: ch[0].toUpperCase() + ch.slice(1),
        type: 'radio',
        checked: cfg.character === ch,
        click: () => { config.set({ character: ch }); refreshData(false); }
      }))
    },
    {
      label: 'Auto-scan',
      type: 'checkbox',
      checked: cfg.autoScan,
      click: item => setAutoScan(item.checked)
    },
    { label: `Scan now (${cfg.hotkeyScan})`, click: () => scan(false) },
    { label: `Hide badges (${cfg.hotkeyHide})`, click: hideOverlay },
    { label: 'Refresh data from untapped.gg', click: () => refreshData(true) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide(); // required to float over fullscreen Spaces

  if (process.env.DUMP) {
    await cards.refresh(true).catch(e => console.error(e.message));
    app.quit();
    return;
  }
  if (process.env.REFRESH_ONLY) {
    await cards.refresh(false).catch(e => console.error(e.message));
    app.quit();
    return;
  }

  createOverlay();
  buildTray();
  restTrayState(); // paused vs watching, per saved config

  const cfg = config.get();
  if (!globalShortcut.register(cfg.hotkeyScan, scan)) {
    console.error(`Could not register hotkey ${cfg.hotkeyScan}`);
  }
  globalShortcut.register(cfg.hotkeyHide, hideOverlay);

  refreshData(!!process.env.FORCE_REFRESH); // warm the cache in the background (FORCE_REFRESH=1 rescrapes)
  if (cfg.autoScan) setAutoScan(true);
  console.log(`STS2 Overlay running. Auto-scan: ${cfg.autoScan ? 'on' : 'off'}  Scan: ${cfg.hotkeyScan}  Hide: ${cfg.hotkeyHide}`);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', e => e.preventDefault()); // tray app — stay alive
