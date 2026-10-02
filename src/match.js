// Fuzzy-match OCR lines against known card names.
function normalize(s) {
  // '+' is kept: upgraded cards ("Uppercut+") have separate stats
  return s.toLowerCase().replace(/[^a-z0-9+ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

// cardIndex: Map<normalizedName, card>. Returns best {card, score} for a text, or null.
// A match is only accepted if the card name covers >=50% of the OCR line — card-name
// lines contain (almost) only the name, while description lines are much longer.
function bestCardForText(text, cardIndex, minScore) {
  const norm = normalize(text);
  if (norm.length < 3) return null;
  const words = norm.split(' ');
  const candidates = new Map([[norm, 1]]); // candidate -> fraction of line covered
  for (let len = 1; len <= Math.min(4, words.length); len++) {
    for (let i = 0; i + len <= words.length; i++) {
      const gram = words.slice(i, i + len).join(' ');
      const cov = gram.length / norm.length;
      if (!candidates.has(gram) || candidates.get(gram) < cov) candidates.set(gram, cov);
    }
  }
  let best = null;
  for (const [name, card] of cardIndex) {
    for (const [cand, coverage] of candidates) {
      if (coverage < 0.5) continue;
      if (Math.abs(cand.length - name.length) > Math.max(3, name.length * 0.4)) continue;
      const score = similarity(cand, name);
      if (score >= minScore && (!best || score > best.score)) best = { card, score };
    }
  }
  return best;
}

// In combat the cards in hand are already yours — there is no pick to inform, so
// badging them is just clutter. Combat is identified by the "End Turn" button,
// which is present for the whole fight and on no other screen. Matching is fuzzy
// on the two words alone, so OCR noise still counts and the digits are ignored:
// "rn" is routinely read as "m", hence the (rn|m) alternation for "Turn"/"Tum".
//
// Anything with an in-combat reward step (card rewards after a fight) is a
// *separate* screen with no End Turn button, so it still gets badged.
function looksLikeCombat(lines) {
  return lines.some(l => /\bend\s*t[ua](rn|m)\b/i.test(l.text));
}

// A relic-offer screen (start of an act: 1-3 lines of dialogue, then three relics)
// lists its relics *vertically* — names left-aligned on a shared x, one per line,
// each followed by its description. That is the opposite of the card layout, so the
// horizontal clustering below would put every relic in its own singleton cluster
// and throw all but one away.
//
// Detected by the thing that makes the layout what it is: several relics sharing a
// left edge at different heights. Two is enough to be unambiguous — no card screen
// stacks relic names down a column — which still catches the screen when OCR misses
// one of the three.
const LIST_X_TOL_FRAC = 0.02;  // shared left edge, as a fraction of screen width
const LIST_MIN_ITEMS = 2;

function verticalRelicList(matches, xTol, yTol) {
  const relics = matches.filter(m => m.card.kind === 'relic');
  if (relics.length < LIST_MIN_ITEMS) return null;

  // Group by left edge, then keep a column only if its items are at distinct heights.
  const columns = [];
  for (const m of [...relics].sort((a, b) => a.line.x - b.line.x)) {
    const col = columns.find(c => Math.abs(c.x - m.line.x) <= xTol);
    if (col) { col.items.push(m); col.x = (col.x * (col.items.length - 1) + m.line.x) / col.items.length; }
    else columns.push({ x: m.line.x, items: [m] });
  }

  const best = columns
    .map(c => ({ ...c, items: c.items.sort((a, b) => a.line.y - b.line.y) }))
    .filter(c => c.items.length >= LIST_MIN_ITEMS &&
                 c.items.every((m, i) => i === 0 || m.line.y - c.items[i - 1].line.y > yTol))
    .sort((a, b) => b.items.length - a.items.length)[0];

  // Each relic is its own row: they share an x, so they need per-item y placement.
  return best ? best.items.map(m => [m]) : null;
}

// lines: [{text,x,y,w,h}] -> array of ROWS, each row = [{card, score, line}] sorted by x.
// Matches are deduped by name, then clustered into horizontal bands (names are
// vertically aligned per row). Reward screens yield 1 row; shops yield several
// (class cards, colorless cards, and a row of relics), which the caller tells apart
// by the kind of the items in each. Singleton clusters are dropped as likely false
// positives — unless nothing else matched.
//
// A vertical relic list is checked for first, since it breaks that assumption.
function matchLines(lines, cardIndex, minScore, yTol = Infinity, xTol = 0) {
  const byCard = new Map();
  for (const line of lines) {
    const hit = bestCardForText(line.text, cardIndex, minScore);
    if (!hit) continue;
    const existing = byCard.get(hit.card.name);
    if (!existing || hit.score > existing.score) {
      byCard.set(hit.card.name, { card: hit.card, score: hit.score, line });
    }
  }
  const matches = [...byCard.values()];
  if (!matches.length) return [];

  const list = isFinite(yTol) ? verticalRelicList(matches, xTol, yTol) : null;
  if (list) return list;

  if (!isFinite(yTol) || matches.length === 1) {
    return [matches.sort((a, b) => a.line.x - b.line.x).slice(0, 8)];
  }

  const clusters = [];
  for (const m of [...matches].sort((a, b) => a.line.y - b.line.y)) {
    const c = clusters.find(c => Math.abs(c.y - m.line.y) <= yTol);
    if (c) { c.items.push(m); c.y = c.items.reduce((s, i) => s + i.line.y, 0) / c.items.length; }
    else clusters.push({ y: m.line.y, items: [m] });
  }

  let kept = clusters.filter(c => c.items.length >= 2);
  if (!kept.length) {
    clusters.sort((a, b) =>
      Math.max(...b.items.map(i => i.score)) - Math.max(...a.items.map(i => i.score)));
    kept = [clusters[0]];
  }
  return kept
    .sort((a, b) => a.y - b.y)
    .map(c => c.items.sort((a, b) => a.line.x - b.line.x).slice(0, 8));
}

module.exports = { normalize, similarity, bestCardForText, matchLines, looksLikeCombat, LIST_X_TOL_FRAC };
