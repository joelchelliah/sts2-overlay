// OCR pipeline. Prefers Apple Vision (fast, great with game fonts) via a small
// Swift helper compiled on first run; falls back to tesseract.js if swiftc is missing.
// Returns lines: [{ text, x, y, w, h }] in screenshot *pixel* coords, top-left origin.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');

const BIN = path.join(config.DIR, 'visionocr');
const SRC = path.join(__dirname, 'visionocr.swift');

let visionState = 'unknown'; // unknown | ok | unavailable
let tessWorker = null;

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function ensureVision() {
  if (visionState !== 'unknown') return visionState === 'ok';
  if (fs.existsSync(BIN)) { visionState = 'ok'; return true; }
  try {
    await exec('xcrun', ['--find', 'swiftc']);
    await exec('swiftc', ['-O', '-o', BIN, SRC]);
    visionState = 'ok';
    console.log('[ocr] compiled Vision OCR helper ->', BIN);
    return true;
  } catch (e) {
    console.warn('[ocr] Vision helper unavailable (' + e.message.trim().slice(0, 120) + '), using tesseract.js');
    visionState = 'unavailable';
    return false;
  }
}

async function visionRecognize(pngPath) {
  const out = await exec(BIN, [pngPath]);
  return JSON.parse(out);
}

async function tesseractRecognize(pngPath) {
  if (!tessWorker) {
    const { createWorker } = require('tesseract.js');
    tessWorker = await createWorker('eng');
  }
  const { data } = await tessWorker.recognize(pngPath);
  return (data.lines || []).map(l => ({
    text: l.text.trim(),
    x: l.bbox.x0,
    y: l.bbox.y0,
    w: l.bbox.x1 - l.bbox.x0,
    h: l.bbox.y1 - l.bbox.y0
  })).filter(l => l.text);
}

// pngBuffer: full-screen screenshot. region: fractional crop applied via coordinate
// filtering (we OCR the full image — Vision is fast — then drop lines outside region).
async function recognize(pngBuffer, imgWidth, imgHeight) {
  const tmp = path.join(os.tmpdir(), `sts2-ocr-${Date.now()}.png`);
  fs.writeFileSync(tmp, pngBuffer);
  try {
    const lines = (await ensureVision())
      ? await visionRecognize(tmp)
      : await tesseractRecognize(tmp);

    const r = config.get().ocrRegion;
    const rx = r.x * imgWidth, ry = r.y * imgHeight;
    const rw = r.width * imgWidth, rh = r.height * imgHeight;
    return lines.filter(l => {
      const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
      return cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh;
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = { recognize };
