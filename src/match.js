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

// lines: [{text,x,y,w,h}] -> array of ROWS, each row = [{card, score, line}] sorted by x.
// Matches are deduped by name, then clustered into horizontal bands (names are
// vertically aligned per row). Reward screens yield 1 row; shops yield several
// (class cards, colorless cards, and a row of relics), which the caller tells apart
// by the kind of the items in each. Singleton clusters are dropped as likely false
// positives — unless nothing else matched.
function matchLines(lines, cardIndex, minScore, yTol = Infinity) {
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

module.exports = { normalize, similarity, bestCardForText, matchLines };
