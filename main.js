// STS2 Overlay — purely visual, click-through overlay showing card win% from sts2.fun.
// Hotkey (default Cmd+Shift+1) on a card reward screen: screenshots the game,
// OCRs the card names, and shows a win% badge under each card.
const { app, BrowserWindow, Tray, Menu, globalShortcut, screen, nativeImage } = require('electron');
const path = require('path');
const config = require('./src/config');
const cards = require('./src/cards');
const capture = require('./src/capture');
const ocr = require('./src/ocr');
const { matchLines } = require('./src/match');

const CHARACTERS = ['all', 'ironclad', 'silent', 'defect', 'regent', 'necrobinder'];

let overlayWin = null;
let tray = null;
let hideTimer = null;
let cardData = null;
let busy = false;

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
}

async function scan(auto = false) {
  if (busy) return;
  busy = true;
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
      return;
    }

    // Screen type from layout: reward screens have one row of card names,
    // shops have two (5 class cards + 2 colorless). Shop cards are smaller,
    // so they get their own offsets.
    const isShop = rows.length > 1;
    const off = isShop ? cfg.shopBadgeOffsets : cfg.badgeOffsets;

    // Two badges per card: base win% above the card, upgraded win% below it,
    // regardless of which variant is actually offered. Badges share row-level
    // y positions: anchored at each row's median name top (names are aligned),
    // offset by fractions of screen height (game UI scales with resolution).
    const labels = rows.flatMap(row => {
      const ys = row.map(m => m.line.y).sort((a, b) => a - b);
      const anchorY = ys[Math.floor(ys.length / 2)];
      const yAbove = (anchorY + off.above * shot.height) / shot.scale;
      const yBelow = (anchorY + off.below * shot.height) / shot.scale;
      return row.flatMap(m => {
        const cx = (m.line.x + m.line.w / 2) / shot.scale;
        // Sample-size tiers: >=reliable normal; >=minimum win% + warning emoji,
        // red border; <minimum "–" with red border. No data at all: plain "–".
        const t = cfg.sampleThresholds;
        const badge = (y, winRate, pickRate, samples) => {
          const tooFew = samples !== null && samples < t.minimum;
          const wr = tooFew ? null : winRate;
          const shaky = wr !== null && samples !== null && samples < t.reliable;
          return [{
            x: cx,
            y,
            winRate: wr,
            warn: tooFew || shaky, // red border
            text: wr === null ? '–' : shaky ? `${wr}% ⚠️` : `${wr}%`,
            sub: cfg.showPickRate && pickRate !== null ? `pick ${pickRate}%` : null
          }];
        };
        return [
          ...badge(yAbove, m.card.winRate, m.card.pickRate, m.card.samples ?? null),
          ...badge(yBelow, m.card.upgradedWinRate ?? null, m.card.upgradedPickRate ?? null, m.card.upgradedSamples ?? null)
        ];
      });
    });

    send('status', null);
    send('labels', labels);
    overlayWin.showInactive();
    console.log(`[scan] ${isShop ? 'shop' : 'reward'}:`, matches.map(m =>
      `${m.card.name}=${m.card.winRate}%/${m.card.upgradedWinRate ?? '—'}%+ (${m.score.toFixed(2)})`).join(', '));

    clearTimeout(hideTimer);
    // auto-scan badges persist until the screen changes; manual ones time out
    if (!auto && cfg.autoHideSeconds > 0) hideTimer = setTimeout(hideOverlay, cfg.autoHideSeconds * 1000);
  } catch (e) {
    console.error('[scan]', e);
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
  if (!enabled) return;
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
    showStatus('Data refresh failed: ' + e.message.slice(0, 60), 5000);
  }
}

function buildTray() {
  const cfg = config.get();
  if (!tray) {
    // simple 16x16 dot as tray icon
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle('S2'); // text-based menu bar item — always visible
    tray.setToolTip('STS2 Overlay');
  }
  const dataInfo = cardData
    ? `Data: ${cardData.cards.length} cards (${new Date(cardData.fetchedAt).toLocaleString()})`
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
    { label: 'Refresh data from sts2.fun', click: () => refreshData(true) },
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
