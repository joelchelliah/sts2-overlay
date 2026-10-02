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
const { matchLines, looksLikeCombat, LIST_X_TOL_FRAC } = require('./src/match');

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
  if (state === 'hit' || state === 'list') lastHitCount = detail;
  if (!tray) return;
  if (state === 'list') {
    tray.setTitle(`S2 ☰${detail}`);
    tray.setToolTip(`STS2 Overlay — relic list (${detail} relics)`);
    return;
  }
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

// ── Relic reference list: a full, browsable list of rated relics, toggled by
// hotkey. Shops show relics as bare icons with no name on screen, so there is
// nothing to OCR there; this is how you look one up instead.
let relicsShown = false;

async function toggleRelicList() {
  if (relicsShown) {
    relicsShown = false;
    send('relics', null);
    if (!overlayWin.webContents.isDestroyed()) overlayWin.hide();
    restTrayState();
    return;
  }
  try {
    if (!cardData) cardData = await cards.getData();
    const cfg = config.get();
    const tiers = cards.relicTiers(cardData, cfg.character);
    if (!tiers.length) { showStatus('No relic ratings loaded', 2500); return; }

    const total = tiers.reduce((n, t) => n + t.relics.length, 0);
    send('relics', {
      title: `${total} relics · ${cfg.character === 'all' ? 'all characters' : cfg.character}`,
      hint: `${cfg.hotkeyRelics} to close`,
      tiers: tiers.map(t => ({
        tier: t.tier,
        tierOrder: t.tierOrder,
        relics: t.relics
      }))
    });
    relicsShown = true;
    // The list covers the screen, so any badges under it are just noise.
    clearTimeout(hideTimer);
    send('clear');
    overlayWin.showInactive();
    setTrayState('list', total);
  } catch (e) {
    console.error('[relics]', e.message);
    showStatus('Could not build relic list: ' + e.message.slice(0, 60), 4000);
  }
}

function hideOverlay() {
  clearTimeout(hideTimer);
  if (relicsShown) { relicsShown = false; send('relics', null); }
  send('clear');
  if (overlayWin) overlayWin.hide();
  restTrayState();
}

async function scan(auto = false) {
  if (busy) return;
  // A scan replaces the relic list rather than drawing badges underneath it.
  if (relicsShown) { relicsShown = false; send('relics', null); }
  busy = true;
  setTrayState('scanning');
  const cfg = config.get();
  try {
    send('clear');
    if (!auto) showStatus('Scanning…');

    const shot = await capture.captureScreen();
    const lines = await ocr.recognize(shot.png, shot.width, shot.height);

    // In combat the hand is cards you already own — no pick to inform, so skip it
    // before the matching work rather than badging and then hiding.
    if (cfg.skipInCombat !== false && looksLikeCombat(lines)) {
      if (auto) hideOverlay();
      else showStatus('In combat — nothing to rate', 2000);
      restTrayState();
      return;
    }

    if (!cardData) cardData = await cards.getData();
    const index = cards.buildIndex(cardData, cfg.character);
    const rows = matchLines(lines, index, cfg.minMatchScore,
                            shot.height * 0.05, shot.width * LIST_X_TOL_FRAC);
    const matches = rows.flat();

    if (!matches.length) {
      if (auto) hideOverlay();           // not a card screen — stay silent
      else showStatus('No cards recognized', 2500);
      restTrayState();
      return;
    }

    // Two layouts, told apart by shape rather than by guessing the screen:
    //
    //  - Vertical relic list (act-start relic offer): every row holds one relic,
    //    all sharing a left edge. Badges go to the *left* of each name — the names
    //    are only ~150px apart vertically and have their description text to the
    //    right, so there is no room above or beside them.
    //  - Rows of cards (reward screens: one row; shops: two or more). Badges are
    //    centred above the row, at a shared y anchored on the row's median name
    //    top, offset by a fraction of screen height (the game UI scales with
    //    resolution).
    const isList = rows.length > 1 && rows.every(r => r.length === 1 && r[0].card.kind === 'relic');
    const isShop = !isList && rows.length > 1;
    const cardOff = isShop ? cfg.shopBadgeOffsets : cfg.badgeOffsets;

    const labels = rows.flatMap(row => {
      const isRelicRow = row.every(m => m.card.kind === 'relic');
      const off = isRelicRow ? cfg.relicBadgeOffsets : cardOff;
      const ys = row.map(m => m.line.y).sort((a, b) => a - b);
      const rowY = ys[Math.floor(ys.length / 2)] + off.above * shot.height;
      // Uniform user nudge, on top of whichever layout's offsets applied. Computed
      // in screenshot pixels like everything else here, then converted to screen
      // points once, at the end.
      const nudgeX = cfg.badgeNudge.x * shot.width;
      const nudgeY = cfg.badgeNudge.y * shot.height;
      return row.map(m => ({
        // In a list the badge is right-aligned into the gutter left of the name;
        // otherwise centred on it. `anchor` tells the overlay which way to hang.
        x: ((isList
          ? m.line.x + cfg.relicListBadgeOffsets.x * shot.width
          : m.line.x + m.line.w / 2) + nudgeX) / shot.scale,
        y: ((isList
          ? m.line.y + m.line.h / 2 + cfg.relicListBadgeOffsets.y * shot.height
          : rowY) + nudgeY) / shot.scale,
        anchor: isList ? 'right' : 'center',
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
    console.log(`[scan] ${isList ? 'relic offer' : isShop ? 'shop' : 'reward'}:`, matches.map(m =>
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

// ── Auto-scan: poll a tiny thumbnail and scan when the screen changes.
//
// Game screens are never perfectly still — ambient animation (water, torchlight,
// drifting backgrounds) moves ~8% of a 48px thumbnail between any two frames,
// while an actual screen transition moves ~50%. Two consequences shape this loop:
//
//   - The change threshold has to sit above the animation, not just above sensor
//     noise, or every frame reads as a transition.
//   - Waiting for a *quiet* frame before scanning never succeeds on an animated
//     screen. So a change schedules a scan a beat later instead of requiring
//     stillness, and `settleTicks` is what gives a transition time to finish.
//
// Badges are also not dropped just because pixels moved: they are cleared when a
// scan finds nothing (we left the screen), which is the thing we actually care
// about. Otherwise ambient motion would wipe them a second after they appear.
let autoTimer = null;
let prevThumb = null;
let pending = 1; // ticks until the next scan; 1 = scan on the first tick

function setAutoScan(enabled) {
  config.set({ autoScan: enabled });
  clearInterval(autoTimer);
  autoTimer = null;
  prevThumb = null;
  if (!enabled) { setTrayState('paused'); return; }
  restTrayState();
  pending = 1;
  const cfg = config.get();
  autoTimer = setInterval(async () => {
    // The relic list is a deliberate, hotkey-held view: auto-scan would find no
    // cards behind it and hide the overlay a couple of seconds after it opened.
    if (busy || relicsShown) return;
    try {
      const thumb = await capture.captureThumbnail();
      const changed = capture.diffFraction(prevThumb, thumb) > cfg.autoScanChangedFraction;
      prevThumb = thumb;
      // A change (re)starts the settle countdown, so a multi-frame transition
      // scans once at the end rather than once per frame.
      if (changed) pending = Math.max(1, cfg.autoScanSettleTicks);
      else if (pending > 0 && --pending === 0) await scan(true);
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
  setTrayState(trayState, (trayState === 'hit' || trayState === 'list') ? lastHitCount : undefined);
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
    { label: `Relic list (${cfg.hotkeyRelics})`, click: toggleRelicList },
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
  if (!globalShortcut.register(cfg.hotkeyRelics, toggleRelicList)) {
    console.error(`Could not register hotkey ${cfg.hotkeyRelics}`);
  }

  refreshData(!!process.env.FORCE_REFRESH); // warm the cache in the background (FORCE_REFRESH=1 rescrapes)
  if (cfg.autoScan) setAutoScan(true);
  console.log(`STS2 Overlay running. Auto-scan: ${cfg.autoScan ? 'on' : 'off'}  Scan: ${cfg.hotkeyScan}  Hide: ${cfg.hotkeyHide}  Relics: ${cfg.hotkeyRelics}`);
  // Editing src/config.js only changes the *defaults*: this file overrides them and
  // is what actually takes effect, so print the path and the live badge offsets.
  // Without this, tuning the wrong file looks like the settings doing nothing.
  console.log(`[config] editing ${config.FILE} (restart to apply)`);
  console.log(`[config] badgeNudge ${JSON.stringify(cfg.badgeNudge)}` +
              `  relicList ${JSON.stringify(cfg.relicListBadgeOffsets)}` +
              `  reward ${JSON.stringify(cfg.badgeOffsets)}` +
              `  shop ${JSON.stringify(cfg.shopBadgeOffsets)}` +
              `  relicRow ${JSON.stringify(cfg.relicBadgeOffsets)}`);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', e => e.preventDefault()); // tray app — stay alive
