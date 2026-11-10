/**
 * The chroma key as an SVG filter.
 *
 * A dashboard on another origin can show the tracker image but cannot read its pixels, so it
 * cannot run chromaKey(). An SVG filter can still do the same job while the browser paints.
 * For the storm oranges red is the largest channel and blue the smallest, which makes every
 * test in stormAlpha() a straight-line rule on R, G and B:
 *
 *   saturation >= 0.2   <=>  0.8R - B >= 0          (also the alpha ramp)
 *   hue >= 8 degrees    <=>  (G - B) - (8/60)(R - B) >= 0
 *   hue <= 42 degrees   <=>  (42/60)(R - B) - (G - B) >= 0
 *   red >= 120          <=>  R - 120/255 >= 0
 *
 * Each rule becomes one feColorMatrix that writes its answer into alpha, and feComposite "in"
 * multiplies them together.
 */

import { COLOUR_MODES } from './keying.js';

const STEEP = 60; // gates go from 0 to 1 across 1/60 of the channel range
const RAMP = 2.8; // matches stormAlpha's (s - 0.2) / 0.4 for red between 200 and 250

/**
 * Alpha rows [r, g, b, a, offset] on 0..1 channels. The first is the soft alpha, the rest are gates.
 */
export const KEY_FILTER_ROWS = [
  [0.8 * RAMP, 0, -RAMP, 0, 0],
  [-STEEP * (8 / 60), STEEP, -STEEP * (1 - 8 / 60), 0, 0],
  [STEEP * (42 / 60), -STEEP, STEEP * (1 - 42 / 60), 0, 0],
  [STEEP, 0, 0, 0, -STEEP * (120 / 255)],
];

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** What the filter makes of one opaque sRGB pixel (0..255 channels): its alpha, 0..1. */
export function keyFilterAlpha(r, g, b) {
  const c = [r / 255, g / 255, b / 255, 1];
  return KEY_FILTER_ROWS.reduce((alpha, row) => {
    const v = row[0] * c[0] + row[1] * c[1] + row[2] * c[2] + row[3] * c[3] + row[4];
    return alpha * clamp01(v);
  }, 1);
}

const fmt = (n) => String(Math.round(n * 1e4) / 1e4);

/**
 * `<filter>` markup for an inline SVG. `mode` recolours the storms like the userscript's
 * "Storm colour" setting.
 */
export function keyFilterMarkup(id, mode = 'original') {
  const tint = COLOUR_MODES[mode] || null;
  const rgb = tint
    ? tint.map((v) => `0 0 0 0 ${fmt(v / 255)}`)
    : ['1 0 0 0 0', '0 1 0 0 0', '0 0 1 0 0'];
  const blank = ['0 0 0 0 0', '0 0 0 0 0', '0 0 0 0 0'];
  const matrix = (rows, alphaRow, result) =>
    `<feColorMatrix in="SourceGraphic" type="matrix" values="${[...rows, alphaRow.map(fmt).join(' ')].join(' ')}" result="${result}"/>`;
  const parts = [matrix(rgb, KEY_FILTER_ROWS[0], 'k0')];
  KEY_FILTER_ROWS.slice(1).forEach((row, i) => {
    parts.push(matrix(blank, row, `g${i + 1}`));
    parts.push(`<feComposite in="k${i}" in2="g${i + 1}" operator="in" result="k${i + 1}"/>`);
  });
  // sRGB, or the browser does the sums on linearised colours and the thresholds move.
  return `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">${parts.join('')}</filter>`;
}
