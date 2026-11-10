/** Telling storms from basemap: the chroma key, the storm fingerprint and cell detection. */

export function rgbToHs(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const s = max === 0 ? 0 : delta / max;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  if (h < 0) h += 360;
  return [h, s];
}

/**
 * Storm-feature alpha (0..1) for a tracker pixel. The tracker draws storms in orange
 * (fill ≈ 245,189,138; lines ≈ 204,120,51) on a desaturated tan/blue basemap, so we key on
 * orange hue + saturation. Fill ends up semi-transparent, lines opaque.
 */
export function stormAlpha(r, g, b) {
  const [h, s] = rgbToHs(r, g, b);
  if (h < 8 || h > 42) return 0;
  if (s < 0.2) return 0;
  if (r < 120) return 0;
  return Math.min(1, (s - 0.2) / 0.4);
}

export const COLOUR_MODES = {
  original: null,
  magenta: [214, 0, 170],
  black: [20, 20, 20],
};

/** Chroma-key RGBA pixel buffer in place. Returns number of storm pixels. */
export function chromaKey(data, mode = 'original') {
  const tint = COLOUR_MODES[mode] || null;
  let kept = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] === 0 ? 0 : stormAlpha(data[i], data[i + 1], data[i + 2]);
    if (a === 0) {
      data[i + 3] = 0;
      continue;
    }
    kept++;
    if (tint) {
      data[i] = tint[0];
      data[i + 1] = tint[1];
      data[i + 2] = tint[2];
    }
    data[i + 3] = Math.round(a * 255);
  }
  return kept;
}

/**
 * Fingerprint of the storm drawing in a chroma-keyed RGBA buffer (FNV-1a over which pixels are
 * storm pixels). BoM re-renders the image every minute with a new "Issued at" stamp, but the
 * storms only change with each new radar scan (~5 min); this tells those apart.
 */
export function stormHash(keyed) {
  let h = 0x811c9dc5;
  for (let i = 3, p = 0; i < keyed.length; i += 4, p++) {
    if (keyed[i]) {
      h ^= p & 0xff; h = Math.imul(h, 0x01000193);
      h ^= p >>> 8; h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16);
}

/** Is this pixel part of a storm cell's filled ellipse (current position)? */
export function isCellFill(r, g, b) {
  const [h, s] = rgbToHs(r, g, b);
  return h >= 18 && h <= 38 && s >= 0.3 && s <= 0.55 && r >= 200;
}

/**
 * Find filled storm cells (current positions) as connected components of the fill colour.
 * Operates on the ORIGINAL pixels. Returns [{ x, y, area, vxx, vyy, vxy }]: centroid and area in
 * image px, plus the spread of the cell's pixels about its centroid (variances and covariance,
 * px²), which is enough to recover the drawn ellipse (see cellEllipse in analysis.js).
 */
export function findCells(data, w, h, minPixels = 40) {
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    if (data[i + 3] && isCellFill(data[i], data[i + 1], data[i + 2])) mask[p] = 1;
  }
  const cells = [];
  const stack = [];
  for (let p = 0; p < w * h; p++) {
    if (mask[p] !== 1) continue;
    mask[p] = 2;
    stack.push(p);
    let size = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    while (stack.length) {
      const q = stack.pop();
      const x = q % w;
      const y = (q - x) / w;
      size++; sx += x; sy += y;
      sxx += x * x; syy += y * y; sxy += x * y;
      if (x > 0 && mask[q - 1] === 1) { mask[q - 1] = 2; stack.push(q - 1); }
      if (x < w - 1 && mask[q + 1] === 1) { mask[q + 1] = 2; stack.push(q + 1); }
      if (y > 0 && mask[q - w] === 1) { mask[q - w] = 2; stack.push(q - w); }
      if (y < h - 1 && mask[q + w] === 1) { mask[q + w] = 2; stack.push(q + w); }
    }
    if (size >= minPixels) {
      const x = sx / size;
      const y = sy / size;
      cells.push({ x, y, area: size, vxx: sxx / size - x * x, vyy: syy / size - y * y, vxy: sxy / size - x * y });
    }
  }
  return cells;
}

export function countCells(data, w, h, minPixels = 40) {
  return findCells(data, w, h, minPixels).length;
}
