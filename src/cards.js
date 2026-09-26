// Card tier data from sts2.untapped.gg (Baalorlord's per-character tier lists).
//
// Each character has its own tier-list page. The pages are server-rendered by
// Next.js, so a plain HTTPS GET is enough — no browser, no SPA wait. The data we
// want lives in the RSC flight payload inside `self.__next_f.push([1, "..."])`
// script chunks, where it is JSON double-escaped (\\" for every quote).
//
// Two things are pulled from each page:
//
//   1. The `"tierList"` object — the authority for ratings:
//        tierList.tiers[] = [{ name: "S", order: 0, color: "#408abf", cards: [...] }, ...]
//        tiers[].cards[]  = [{ card_id: "THE_SEALED_THRONE", good_upgrade: true, ... }]
//      A card's rating is *positional*: there is no per-card score, the tier is
//      whichever bucket the card's entry sits in. Tier orders 0-5 are S/A/B/C/D/F
//      for cards; orders 6+ ("Always Amazing", ...) are the relic/potion scale and
//      are always empty here, so they're skipped.
//
//   2. A `card_id -> display name` map, from the per-card render blocks:
//        "item":{"type":"card","id":"STRIKE_REGENT","card":{"slug":..,"name":"Strike",..}}
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
const CACHE_VERSION = 5; // bump when the cached entry shape changes
const DEBUG_DIR = path.join(__dirname, '..', 'debug');

// Tier orders 0..5 are the card scale; 6+ are the relic/potion scale (always empty).
const MAX_CARD_TIER_ORDER = 5;

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

// card_id -> display name, from the per-card render blocks in the flight payload.
function extractNameMap(unescaped) {
  const map = new Map();
  const re = /"item":\{"type":"card","id":"([A-Z0-9_]+)","card":\{"slug":"[^"]*","id":"[^"]*","name":"((?:[^"\\]|\\.)*)"/g;
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

// One tier-list page -> [{ name, cardId, tier, tierOrder, tierColor, goodUpgrade, character }]
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

  const names = extractNameMap(unescaped);
  const out = [];
  for (const tier of tierList.tiers || []) {
    if (tier.order > MAX_CARD_TIER_ORDER) continue; // relic/potion scale
    for (const c of tier.cards || []) {
      const cardId = c.card_id || c.item_id;
      if (!cardId) continue;
      out.push({
        name: names.get(cardId) || titleize(cardId),
        cardId,
        tier: tier.name,
        tierOrder: tier.order,
        tierColor: tier.color || null,
        goodUpgrade: c.good_upgrade === true,
        character
      });
    }
  }
  if (!out.length) throw new Error(`tierList for ${character} contained no cards`);
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

// Map<normalizedName, card> for the chosen character.
//
// Card names are only unique *within* a character — every character has a "Strike"
// and a "Defend", and they can sit in different tiers. With a character selected we
// therefore prefer that character's entry; for 'all' we keep the best-rated one, so
// an ambiguous name never reads worse than it might actually be.
function buildIndex(data, character) {
  const index = new Map();
  for (const c of data.cards) {
    const key = normalize(c.name);
    const isForChar = character !== 'all' && c.character === character;
    const existing = index.get(key);
    if (!existing) {
      index.set(key, { ...c, __forChar: isForChar });
      continue;
    }
    if (isForChar && !existing.__forChar) {
      index.set(key, { ...c, __forChar: isForChar });        // exact character wins
    } else if (isForChar === existing.__forChar && c.tierOrder < existing.tierOrder) {
      index.set(key, { ...c, __forChar: isForChar });        // otherwise best tier wins
    }
  }
  return index;
}

module.exports = { getData, refresh, buildIndex, parseTierListPage };
