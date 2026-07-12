// Card win-rate data from sts2.fun.
//
// The site is a client-rendered SPA, so we load it in a hidden BrowserWindow and
// extract data two ways, merging the results:
//   1. JSON sniffing — sniff-preload.js forwards every JSON API response the page
//      makes; we heuristically pick out arrays of card-stat objects.
//   2. DOM fallback — parse rendered tables (name column + % columns).
//
// Run `npm run dump` to save everything we saw (debug/sniffed.json, debug/page.html)
// if extraction ever needs tuning for a site redesign.
const { BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { normalize } = require('./match');

const CACHE = path.join(config.DIR, 'cards-cache.json');
const CACHE_VERSION = 4; // bump when the cached entry shape changes
const DEBUG_DIR = path.join(__dirname, '..', 'debug');

const NAME_KEYS = ['name', 'cardname', 'card_name', 'card', 'title', 'cardtitle'];
const WIN_KEYS = k => k.includes('win');
const PICK_KEYS = k => k.includes('pick');
const CHAR_KEYS = ['character', 'char', 'class', 'color', 'hero'];

function pct(v) {
  if (typeof v === 'string') v = parseFloat(v);
  if (typeof v !== 'number' || !isFinite(v)) return null;
  return v <= 1 ? +(v * 100).toFixed(1) : +v.toFixed(1);
}

// Walk arbitrary JSON, find arrays of objects that look like card stats.
function extractFromJson(root) {
  const cards = [];
  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length >= 10 && node.every(o => o && typeof o === 'object' && !Array.isArray(o))) {
        for (const o of node) {
          const keys = Object.keys(o);
          const lower = Object.fromEntries(keys.map(k => [k.toLowerCase(), o[k]]));
          const nameKey = NAME_KEYS.find(k => typeof lower[k] === 'string');
          const winKey = Object.keys(lower).find(k => WIN_KEYS(k) && pct(lower[k]) !== null);
          if (!nameKey || !winKey) continue;
          const pickKey = Object.keys(lower).find(k => PICK_KEYS(k) && pct(lower[k]) !== null);
          const charKey = CHAR_KEYS.find(k => typeof lower[k] === 'string');
          cards.push({
            name: lower[nameKey],
            winRate: pct(lower[winKey]),
            pickRate: pickKey ? pct(lower[pickKey]) : null,
            character: charKey ? lower[charKey].toLowerCase() : null
          });
        }
      }
      node.forEach(walk);
    } else {
      Object.values(node).forEach(walk);
    }
  })(root);
  return cards;
}

// Runs inside the page. sts2.fun renders a hidden <table id="cards-data-table">
// whose rows carry all stats as data attributes:
//   data-displayname, data-winrate, data-pickrate, data-cardclass,
//   data-upgraded ("0" base / "1" upgraded), data-rarity, ...
// We take base rows only — that's what card reward screens offer by name.
// Falls back to generic visible-table parsing if that structure disappears.
const DOM_EXTRACT = `(() => {
  const hidden = [...document.querySelectorAll('#cards-tbody tr, #cards-data-table tr')]
    .filter(tr => tr.dataset && tr.dataset.displayname)
    .map(tr => ({
      name: tr.dataset.displayname,
      upgraded: tr.dataset.upgraded === '1',
      wins: parseFloat(tr.dataset.wins),
      picked: parseFloat(tr.dataset.picked),
      offered: parseFloat(tr.dataset.offered),
      winRate: parseFloat(tr.dataset.winrate),
      pickRate: parseFloat(tr.dataset.pickrate),
      character: tr.dataset.cardclass || null
    }))
    .filter(r => r.name && (isFinite(r.winRate) || isFinite(r.wins)));
  if (hidden.length) return { cards: hidden };

  const out = { headers: [], rows: [] };
  const table = [...document.querySelectorAll('table')].find(t => t.offsetParent !== null) ||
                document.querySelector('table');
  if (table) {
    out.headers = [...table.querySelectorAll('th')].map(h => h.innerText.trim().toLowerCase());
    for (const tr of table.querySelectorAll('tbody tr, tr')) {
      const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
      if (cells.length >= 2) out.rows.push(cells);
    }
  }
  return out;
})()`;

function extractFromDom(dom) {
  if (!dom) return [];
  if (dom.cards) {
    // Group base + upgraded variants per card. Base entries show pooled win%
    // (site default view) or base-only, per config. "+" entries = upgraded-only
    // (site's "Separate upgrades" view). Integers, matching the site's display.
    const mode = config.get().baseWinRate;
    // Raw rates are always stored; sample-size tiers are applied at render time
    // (see scan() in main.js), so threshold changes don't require a rescrape.
    const rate = r => {
      if (isFinite(r.winRate)) return Math.round(r.winRate);
      return r.picked > 0 ? Math.round(100 * r.wins / r.picked) : null;
    };
    const prate = r => isFinite(r.pickRate) ? Math.round(r.pickRate) : null;
    const count = r => isFinite(r.picked) ? r.picked : null;

    const groups = new Map();
    for (const r of dom.cards) {
      const key = (r.character || '') + '|' + r.name;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const out = [];
    for (const rows of groups.values()) {
      const base = rows.find(r => !r.upgraded);
      const upg = rows.find(r => r.upgraded);
      const character = rows[0].character ? rows[0].character.toLowerCase() : null;

      let winRate = base ? rate(base) : null;
      let pickRate = base ? prate(base) : null;
      let samples = base ? count(base) : null;
      if (base && mode === 'pooled') {
        const wins = rows.reduce((a, r) => a + (isFinite(r.wins) ? r.wins : 0), 0);
        const picked = rows.reduce((a, r) => a + (isFinite(r.picked) ? r.picked : 0), 0);
        const offered = rows.reduce((a, r) => a + (isFinite(r.offered) ? r.offered : 0), 0);
        if (picked > 0) { winRate = Math.round(100 * wins / picked); samples = picked; }
        if (offered > 0) pickRate = Math.round(100 * picked / offered);
      }

      // One entry per card carrying BOTH rates; a "Name+" alias so OCR of an
      // upgraded card matches too. Overlay shows winRate above / upgradedWinRate below.
      const entry = {
        name: (base || upg).name.replace(/\+$/, ''),
        winRate,
        pickRate,
        samples,
        upgradedWinRate: upg ? rate(upg) : null,
        upgradedPickRate: upg ? prate(upg) : null,
        upgradedSamples: upg ? count(upg) : null,
        character
      };
      if (entry.winRate !== null || entry.upgradedWinRate !== null) {
        out.push(entry);
        if (upg) out.push({ ...entry, name: entry.name + '+' });
      }
    }
    return out;
  }
  if (!dom.rows || !dom.rows.length) return [];
  const winIdx = dom.headers.findIndex(h => h.includes('win'));
  const pickIdx = dom.headers.findIndex(h => h.includes('pick'));
  const nameIdx = Math.max(0, dom.headers.findIndex(h => h.includes('name') || h.includes('card')));
  return dom.rows.map(cells => {
    const pcts = cells.map(c => /%/.test(c) ? pct(parseFloat(c)) : null);
    const win = winIdx >= 0 ? pct(parseFloat(cells[winIdx])) : pcts.find(v => v !== null);
    const pick = pickIdx >= 0 ? pct(parseFloat(cells[pickIdx])) : null;
    const name = cells[nameIdx];
    return name && win !== null ? { name, winRate: win, pickRate: pick, character: null } : null;
  }).filter(Boolean);
}

function scrapeUrl(url, dump = false) {
  return new Promise((resolve, reject) => {
    const sniffed = [];
    const onJson = (_e, payload) => sniffed.push(payload);
    ipcMain.on('sniffed-json', onJson);

    const win = new BrowserWindow({
      show: false,
      width: 1400,
      height: 2000,
      webPreferences: {
        preload: path.join(__dirname, 'sniff-preload.js'),
        contextIsolation: false,
        nodeIntegration: false
      }
    });

    const finish = async () => {
      try {
        let dom = null;
        try { dom = await win.webContents.executeJavaScript(DOM_EXTRACT); } catch {}
        if (dump) {
          fs.mkdirSync(DEBUG_DIR, { recursive: true });
          fs.writeFileSync(path.join(DEBUG_DIR, 'sniffed.json'), JSON.stringify(sniffed, null, 2));
          const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML').catch(() => '');
          fs.writeFileSync(path.join(DEBUG_DIR, 'page.html'), html || '');
          console.log('[cards] dumped debug/sniffed.json and debug/page.html');
        }
        const fromJson = sniffed.flatMap(s => extractFromJson(s.json));
        const fromDom = extractFromDom(dom);
        // Prefer sniffed API data; fill gaps from DOM
        const byName = new Map();
        for (const c of [...fromDom, ...fromJson]) {
          if (c.name && c.winRate !== null) byName.set(normalize(c.name) + '|' + (c.character || ''), c);
        }
        resolve([...byName.values()]);
      } catch (e) {
        reject(e);
      } finally {
        ipcMain.removeListener('sniffed-json', onJson);
        win.destroy();
      }
    };

    win.webContents.on('did-finish-load', () => setTimeout(finish, 8000)); // let the SPA render + fetch
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      ipcMain.removeListener('sniffed-json', onJson);
      win.destroy();
      reject(new Error(`Failed to load ${url}: ${desc}`));
    });
    win.loadURL(url);
  });
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; }
}

const ALL_CHARACTERS = ['IRONCLAD', 'SILENT', 'DEFECT', 'REGENT', 'NECROBINDER', 'COLORLESS'];

async function refresh(dump = false) {
  const cfg = config.get();
  let cards = await scrapeUrl(cfg.cardsUrl, dump);

  // Shops offer colorless cards too — if the ALL page didn't include them, add them
  if (cards.length && cfg.characterUrlTemplate &&
      !cards.some(c => (c.character || '').includes('colorless'))) {
    try {
      const cc = await scrapeUrl(cfg.characterUrlTemplate.replace('{CHARACTER}', 'COLORLESS'));
      for (const c of cc) if (!c.character) c.character = 'colorless';
      cards = [...cards, ...cc];
    } catch (e) {
      console.warn('[cards] colorless scrape failed:', e.message);
    }
  }

  // Fallback: if the ALL page yielded nothing, scrape each character page
  if (!cards.length && cfg.characterUrlTemplate) {
    for (const ch of ALL_CHARACTERS) {
      try {
        const chCards = await scrapeUrl(cfg.characterUrlTemplate.replace('{CHARACTER}', ch));
        for (const c of chCards) if (!c.character) c.character = ch.toLowerCase();
        cards = [...cards, ...chCards];
      } catch (e) {
        console.warn(`[cards] scrape failed for ${ch}:`, e.message);
      }
    }
  }

  if (!cards.length) throw new Error('Extracted 0 cards from sts2.fun — run `npm run dump` and inspect debug/');
  const data = { version: CACHE_VERSION, fetchedAt: new Date().toISOString(), cards };
  fs.writeFileSync(CACHE, JSON.stringify(data, null, 2));
  console.log(`[cards] cached ${cards.length} card entries`);
  return data;
}

async function getData(force = false) {
  let cache = readCache();
  if (cache && cache.version !== CACHE_VERSION) cache = null; // older format — rescrape
  const maxAgeMs = config.get().dataMaxAgeHours * 3600 * 1000;
  if (!force && cache && Date.now() - new Date(cache.fetchedAt).getTime() < maxAgeMs) return cache;
  try {
    return await refresh();
  } catch (e) {
    if (cache) { console.warn('[cards] refresh failed, using stale cache:', e.message); return cache; }
    throw e;
  }
}

// Map<normalizedName, card> for the chosen character ('all' = character-agnostic best entry)
function buildIndex(data, character) {
  const index = new Map();
  for (const c of data.cards) {
    const key = normalize(c.name);
    const isForChar = c.character && character !== 'all' && c.character.includes(character);
    const existing = index.get(key);
    if (!existing || isForChar && !existing.__forChar) {
      index.set(key, { ...c, __forChar: isForChar });
    }
  }
  return index;
}

module.exports = { getData, refresh, buildIndex };
