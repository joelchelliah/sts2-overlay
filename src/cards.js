// Tier data from sts2.untapped.gg (Baalorlord's tier lists).
//
// Six pages are scraped: one per character, plus the colorless list. The pages are
// server-rendered by Next.js, so a plain HTTPS GET is enough — no browser, no SPA
// wait. The data we want lives in the RSC flight payload inside
// `self.__next_f.push([1, "..."])` script chunks, JSON double-escaped (\\" for
// every quote).
//
// Two things are pulled from each page:
//
//   1. The `"tierList"` object — the authority for ratings:
//        tierList.tiers[] = [{ name: "S", order: 0, color: "#408abf", cards: [], relics: [] }, ...]
//        tiers[].cards[]  = [{ card_id: "THE_SEALED_THRONE", good_upgrade: true, ... }]
//        tiers[].relics[] = [{ item_id: "DATA_DISK", ... }]  (colorless page only)
//      A rating is *positional*: there is no per-item score, the tier is whichever
//      bucket the item's entry sits in.
//
//      The page carries two parallel scales in one `tiers[]` array:
//        orders 0-5  S/A/B/C/D/F              — all cards, and some relics
//        orders 6-10 Always Amazing ... Almost Never — relics only
//      Character pages only ever fill orders 0-5. The colorless page fills both:
//      its 64 cards sit in 0-5, while its 130 relics are spread across the whole
//      range (~30 in the letter buckets, the rest in the 6-10 scale). So relics
//      are read from every tier, cards only from 0-5.
//
//   2. An `id -> display name` map, from the per-item render blocks:
//        "item":{"type":"card","id":"STRIKE_REGENT","card":{"slug":..,"name":"Strike",..}}
//        "item":{"type":"relic","id":"DATA_DISK","relic":{"slug":..,"name":"Data Disk",..}}
//      Needed because OCR reads what the game prints ("Strike") while the tier
//      list keys on ids ("STRIKE_REGENT"). Titleizing the id is only a fallback —
//      it would turn STRIKE_REGENT into "Strike Regent" and never match.
//
// Run `npm run dump` to save the fetched pages to debug/ if extraction ever needs
// tuning for a site redesign.
const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { normalize } = require('./match');

const CACHE = path.join(config.DIR, 'cards-cache.json');
const CACHE_VERSION = 6; // bump when the cached entry shape changes
const DEBUG_DIR = path.join(__dirname, '..', 'debug');

// Tier orders 0..5 are the letter scale (S..F); 6+ are the relic-only scale
// ("Always Amazing" ... "Almost Never"). Cards never appear above 5.
const MAX_CARD_TIER_ORDER = 5;
const FIRST_RELIC_TIER_ORDER = 6;

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        // Untapped serves the flight payload to a plain client, but a real UA
        // avoids any bot-shaped filtering.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchPage(new URL(res.headers.location, url).href).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`Timed out fetching ${url}`)));
  });
}

// The flight payload is JSON embedded in a JS string literal, so every quote is
// \\" and every backslash \\\\. Undo one level of escaping to get parseable JSON.
function unescapeFlight(s) {
  return s.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (m, esc) => {
    switch (esc[0]) {
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'u': return String.fromCharCode(parseInt(esc.slice(1), 16));
      default: return m;
    }
  });
}

// Extract the JSON object starting at the '{' at or after `from`, by brace matching
// (skipping braces inside string literals). Returns the substring, or null.
function objectAt(s, from) {
  const start = s.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

// id -> display name, from the per-item render blocks in the flight payload.
// `kind` is "card" or "relic"; both blocks have the same shape, keyed by the kind.
function extractNameMap(unescaped, kind) {
  const map = new Map();
  const re = new RegExp(
    `"item":\\{"type":"${kind}","id":"([A-Z0-9_]+)","${kind}":\\{"slug":"[^"]*","id":"[^"]*","name":"((?:[^"\\\\]|\\\\.)*)"`,
    'g');
  let m;
  while ((m = re.exec(unescaped))) {
    if (!map.has(m[1])) map.set(m[1], JSON.parse(`"${m[2]}"`));
  }
  return map;
}

// Fallback display name when the render tree didn't include the card:
// "FOLLOW_THROUGH" -> "Follow Through".
function titleize(cardId) {
  return cardId.toLowerCase().split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// One tier-list page -> { cards: [{ name, id, kind, tier, tierOrder, tierColor,
// goodUpgrade, character }], ... }. Cards and relics share the entry shape; `kind`
// tells them apart, since the overlay labels them differently.
function parseTierListPage(html, character) {
  const at = html.indexOf('\\"tierList\\":{');
  if (at < 0) throw new Error(`No tierList payload found for ${character} (site layout may have changed)`);

  // Unescape from the tierList marker onward; that's all we need and keeps the
  // work off the ~2MB of surrounding markup.
  const unescaped = unescapeFlight(html.slice(at));
  const json = objectAt(unescaped, unescaped.indexOf('"tierList"') + '"tierList"'.length);
  if (!json) throw new Error(`Could not delimit tierList JSON for ${character}`);

  let tierList;
  try {
    tierList = JSON.parse(json);
  } catch (e) {
    throw new Error(`tierList JSON parse failed for ${character}: ${e.message}`);
  }

  const cardNames = extractNameMap(unescaped, 'card');
  const relicNames = extractNameMap(unescaped, 'relic');
  const out = [];
  for (const tier of tierList.tiers || []) {
    const common = { tier: tier.name, tierOrder: tier.order, tierColor: tier.color || null, character };
    // Cards only use the letter scale; anything above it is a relic-only tier.
    if (tier.order <= MAX_CARD_TIER_ORDER) {
      for (const c of tier.cards || []) {
        const id = c.card_id || c.item_id;
        if (!id) continue;
        out.push({ ...common, name: cardNames.get(id) || titleize(id), id, kind: 'card',
                   goodUpgrade: c.good_upgrade === true });
      }
    }
    // Relics span every tier, and have no good_upgrade — they aren't upgradable.
    for (const r of tier.relics || []) {
      const id = r.item_id || r.relic_id;
      if (!id) continue;
      out.push({ ...common, name: relicNames.get(id) || titleize(id), id, kind: 'relic',
                 goodUpgrade: false });
    }
  }
  if (!out.length) throw new Error(`tierList for ${character} contained no cards or relics`);
  return { cards: out, version: tierList.version || null, listName: tierList.name || null };
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; }
}

async function refresh(dump = false) {
  const urls = config.get().tierListUrls;
  const characters = Object.keys(urls);
  if (!characters.length) throw new Error('No tierListUrls configured');

  if (dump) fs.mkdirSync(DEBUG_DIR, { recursive: true });

  let cards = [];
  const sources = {};
  const errors = [];
  for (const ch of characters) {
    try {
      const html = await fetchPage(urls[ch]);
      if (dump) {
        fs.writeFileSync(path.join(DEBUG_DIR, `tier-list-${ch}.html`), html);
        console.log(`[cards] dumped debug/tier-list-${ch}.html`);
      }
      const parsed = parseTierListPage(html, ch);
      cards = cards.concat(parsed.cards);
      sources[ch] = { count: parsed.cards.length, gameVersion: parsed.version, listName: parsed.listName };
      console.log(`[cards] ${ch}: ${parsed.cards.length} cards (${parsed.version || 'unknown version'})`);
    } catch (e) {
      errors.push(`${ch}: ${e.message}`);
      console.warn(`[cards] scrape failed for ${ch}: ${e.message}`);
    }
  }

  if (!cards.length) {
    throw new Error('Extracted 0 cards from sts2.untapped.gg — run `npm run dump` and inspect debug/. ' + errors.join('; '));
  }
  const data = { version: CACHE_VERSION, fetchedAt: new Date().toISOString(), sources, cards };
  fs.writeFileSync(CACHE, JSON.stringify(data, null, 2));
  console.log(`[cards] cached ${cards.length} card entries across ${Object.keys(sources).length} characters`);
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

// Comparable rank for "which rating is better". Tier order alone is not comparable
// across the two scales: a relic in "Always Amazing" (order 6) is the best a relic
// can be, but would lose a naive `<` against any letter tier. Normalising the
// relic scale onto the letter range keeps the two ends aligned. No relic is
// currently rated on both scales, so this only guards against a future reshuffle.
function rank(entry) {
  return entry.tierOrder >= FIRST_RELIC_TIER_ORDER
    ? entry.tierOrder - FIRST_RELIC_TIER_ORDER
    : entry.tierOrder;
}

// Map<normalizedName, entry> for the chosen character.
//
// Names are only unique *within* a list — every character has a "Strike" and a
// "Defend", and they can sit in different tiers. The colorless list also overlaps
// the character lists: ~24 colorless cards and ~10 relics per character are rated
// in both places, generically on the colorless page and specifically on the
// character's own. The character's rating is the better one to show (Finesse is B
// colorless but S for Ironclad), so with a character selected it wins.
//
// Failing that we keep the best-rated entry, so an ambiguous name never reads
// worse than it might actually be. Cards and relics are indexed together: no relic
// name collides with a card name, so one map is enough.
//
// `character` is a playable character or 'all'; the colorless list is never a
// selectable character, only a source, so its entries act purely as the fallback.
function buildIndex(data, character) {
  const index = new Map();
  for (const c of data.cards) {
    if (c.kind === 'relic' && config.get().showRelics === false) continue;
    const key = normalize(c.name);
    const isForChar = character !== 'all' && c.character === character;
    const existing = index.get(key);
    if (!existing) {
      index.set(key, { ...c, __forChar: isForChar });
      continue;
    }
    if (isForChar && !existing.__forChar) {
      index.set(key, { ...c, __forChar: isForChar });        // exact character wins
    } else if (isForChar === existing.__forChar && rank(c) < rank(existing)) {
      index.set(key, { ...c, __forChar: isForChar });        // otherwise best tier wins
    }
  }
  return index;
}

// All rated relics for the chosen character, grouped into tiers, best first.
// Used by the relic-list overlay: the shop shows relics as bare icons with no
// name, so there is nothing to OCR there — a browsable list is the fallback.
//
// Tiers are ordered by rank(), not tierOrder, because the two scales interleave:
// "Always Amazing" is order 6 but is the *best* a relic can be, so sorting on the
// raw order would file it below an F.
function relicTiers(data, character) {
  const index = buildIndex(data, character);
  const tiers = new Map();
  for (const entry of index.values()) {
    if (entry.kind !== 'relic') continue;
    if (!tiers.has(entry.tier)) {
      tiers.set(entry.tier, {
        tier: entry.tier,
        tierOrder: entry.tierOrder,
        rank: rank(entry),
        relics: []
      });
    }
    tiers.get(entry.tier).relics.push(entry.name);
  }
  return [...tiers.values()]
    .sort((a, b) => a.rank - b.rank || a.tierOrder - b.tierOrder)
    .map(t => ({ ...t, relics: t.relics.sort((a, b) => a.localeCompare(b)) }));
}

module.exports = { getData, refresh, buildIndex, parseTierListPage, relicTiers };
