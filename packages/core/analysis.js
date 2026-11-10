/**
 * Turning a tracker image into numbers: where each storm is on the ground, how big it is, and
 * where the Bureau's arrows and arcs say it is heading. Home Assistant measures distances from
 * this, so everything here comes from the Bureau's own drawing and nothing is extrapolated.
 */

import { IMAGE_W, IMAGE_H, imageToMercatorAffine, applyAffine, lonLatToMercator, mercatorToLonLat } from './georef.js';
import { stormAlpha, isCellFill, findCells, chromaKey, stormHash } from './keying.js';

export const SNAPSHOT_VERSION = 1;
/** Forecast-track pixels are thinned to one point per FORECAST_GRID_PX square (about 2.5 km). */
export const FORECAST_GRID_PX = 6;

const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

export function pixelToLonLat(g, px, py) {
  const [X, Y] = applyAffine(g, px, py);
  return mercatorToLonLat(X, Y);
}

/** `inv` is invertAffine(imageToMercatorAffine()). */
export function lonLatToPixel(inv, lon, lat) {
  const [X, Y] = lonLatToMercator(lon, lat);
  return applyAffine(inv, X, Y);
}

/**
 * The drawn ellipse of a cell, on the ground. The image's pixels are not square on the ground
 * (about 0.42 km wide by 0.39 km tall near Brisbane), so the pixel spread is first carried into
 * east/north kilometres through the georeference, then split into its two axes.
 * @returns {{ major_km:number, minor_km:number, bearing:number, area_km2:number }} semi-axes,
 *   and the major axis as a compass bearing in [0, 180)
 */
export function cellEllipse(cell, g, lat) {
  const k = Math.cos((lat * Math.PI) / 180) / 1000; // Mercator metres -> ground km at this latitude
  // Columns of J: where one pixel step right / down goes, in (east, north) km.
  const ex = g.a * k; const nx = g.b * k;
  const ey = g.c * k; const ny = g.d * k;
  const vxx = cell.vxx || 0; const vyy = cell.vyy || 0; const vxy = cell.vxy || 0;
  const see = ex * ex * vxx + 2 * ex * ey * vxy + ey * ey * vyy;
  const snn = nx * nx * vxx + 2 * nx * ny * vxy + ny * ny * vyy;
  const sen = ex * nx * vxx + (ex * ny + ey * nx) * vxy + ey * ny * vyy;
  const mid = (see + snn) / 2;
  const half = Math.hypot((see - snn) / 2, sen);
  // A filled ellipse with semi-axis a has variance a²/4 along that axis.
  const major = 2 * Math.sqrt(Math.max(0, mid + half));
  const minor = 2 * Math.sqrt(Math.max(0, mid - half));
  let bearing = (0.5 * Math.atan2(2 * sen, snn - see) * 180) / Math.PI; // from north, clockwise
  if (bearing < 0) bearing += 180;
  if (bearing >= 180) bearing -= 180;
  return { major_km: major, minor_km: minor, bearing, area_km2: cell.area * Math.abs(ex * ny - ey * nx) };
}

/**
 * Analyse the ORIGINAL pixels of a tracker image.
 * @param {Uint8ClampedArray} data RGBA
 * @returns {{
 *   hash: string,
 *   cells: { lon:number, lat:number, area_km2:number, major_km:number, minor_km:number, bearing:number }[],
 *   forecast: [number, number][],
 *   pixelCells: { x:number, y:number, area:number }[]
 * }} `forecast` is [lon, lat] points along the Bureau's storm outlines, arrows and 10, 20 and
 *   30-minute arcs.
 */
export function analyseImage(data, w = IMAGE_W, h = IMAGE_H, g = imageToMercatorAffine()) {
  const pixelCells = findCells(data, w, h);
  const cells = pixelCells.map((c) => {
    const [lon, lat] = pixelToLonLat(g, c.x, c.y);
    const e = cellEllipse(c, g, lat);
    return {
      lon: round(lon, 4), lat: round(lat, 4), area_km2: round(e.area_km2, 1),
      major_km: round(e.major_km, 2), minor_km: round(e.minor_km, 2), bearing: round(e.bearing, 1),
    };
  });

  const cols = Math.ceil(w / FORECAST_GRID_PX);
  const buckets = new Map();
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    if (!data[i + 3]) continue;
    const r = data[i]; const gr = data[i + 1]; const b = data[i + 2];
    if (stormAlpha(r, gr, b) === 0 || isCellFill(r, gr, b)) continue;
    const x = p % w;
    const y = (p - x) / w;
    const key = Math.floor(y / FORECAST_GRID_PX) * cols + Math.floor(x / FORECAST_GRID_PX);
    const acc = buckets.get(key);
    if (acc) { acc[0] += x; acc[1] += y; acc[2]++; } else buckets.set(key, [x, y, 1]);
  }
  const forecast = [];
  for (const [sx, sy, n] of buckets.values()) {
    if (n < 2) continue; // a lone pixel is an antialiasing speck, not a line
    const [lon, lat] = pixelToLonLat(g, sx / n, sy / n);
    forecast.push([round(lon, 4), round(lat, 4)]);
  }

  const keyed = new Uint8ClampedArray(data);
  chromaKey(keyed, 'original');
  return { hash: stormHash(keyed), cells, forecast, pixelCells };
}

/**
 * The message the bridge posts to Home Assistant.
 * @param {{ issued:number, analysis:ReturnType<typeof analyseImage>, description?:string|null,
 *   png?:string|null, source?:string }} o `issued` is epoch ms (the image's Last-Modified);
 *   `png` is the original image as base64, or null for a heartbeat when the storms have not changed.
 */
export function buildSnapshot({ issued, analysis, description = null, png = null, source = 'unknown' }) {
  return {
    v: SNAPSHOT_VERSION,
    source,
    issued,
    hash: analysis.hash,
    image: png ? { w: IMAGE_W, h: IMAGE_H, png } : null,
    cells: analysis.cells,
    forecast: analysis.forecast,
    description: description || null,
  };
}
