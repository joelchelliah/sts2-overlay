// Screenshot of the primary display via desktopCapturer (needs Screen Recording permission).
const { desktopCapturer, screen } = require('electron');

async function captureScreen() {
  const display = screen.getPrimaryDisplay();
  const size = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor)
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  if (!sources.length) throw new Error('No screen sources — is Screen Recording permission granted?');
  const src = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
  const img = src.thumbnail;
  const { width, height } = img.getSize();
  if (!width || !height) throw new Error('Empty screenshot — grant Screen Recording permission to this app.');
  return {
    png: img.toPNG(),
    width,
    height,
    // divide pixel coords by this to get screen points
    scale: width / display.size.width
  };
}

// Tiny screenshot for cheap change detection (~48px wide). Returns raw BGRA buffer.
async function captureThumbnail(width = 48) {
  const display = screen.getPrimaryDisplay();
  const height = Math.max(1, Math.round(width * display.size.height / display.size.width));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
  if (!sources.length) return null;
  const src = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
  return src.thumbnail.toBitmap();
}

// Fraction of pixels that differ noticeably between two thumbnails (0..1)
function diffFraction(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let changed = 0;
  const pixels = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > 30) changed++;
  }
  return changed / pixels;
}

module.exports = { captureScreen, captureThumbnail, diffFraction };
