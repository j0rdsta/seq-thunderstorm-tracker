import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../packages/core/index.js';
import { TOWNS } from './towns.mjs';

const BASE = [229, 222, 201, 255];
const FILL = [245, 189, 138, 255];
const LINE = [204, 120, 51, 255];

/** A tracker-sized image with the basemap colour everywhere. */
function blank() {
  const d = new Uint8ClampedArray(core.IMAGE_W * core.IMAGE_H * 4);
  for (let i = 0; i < core.IMAGE_W * core.IMAGE_H; i++) d.set(BASE, i * 4);
  return d;
}

/** Paint a filled ellipse (semi-axes rx, ry px, rotated by `deg`) in the cell fill colour. */
function ellipse(d, cx, cy, rx, ry, deg = 0, colour = FILL) {
  const t = (deg * Math.PI) / 180;
  for (let y = 0; y < core.IMAGE_H; y++) for (let x = 0; x < core.IMAGE_W; x++) {
    const dx = x - cx; const dy = y - cy;
    const u = dx * Math.cos(t) + dy * Math.sin(t);
    const v = -dx * Math.sin(t) + dy * Math.cos(t);
    if ((u / rx) ** 2 + (v / ry) ** 2 <= 1) d.set(colour, (y * core.IMAGE_W + x) * 4);
  }
}

test('pixelToLonLat and lonLatToPixel are inverses and land on the control towns', () => {
  const g = core.imageToMercatorAffine();
  const inv = core.invertAffine(g);
  for (const [name, px, py, lat, lon] of TOWNS) {
    const [x, y] = core.lonLatToPixel(inv, lon, lat);
    assert.ok(Math.hypot(x - px, y - py) < 4, name);
    const [lo, la] = core.pixelToLonLat(g, x, y);
    assert.ok(Math.abs(lo - lon) < 1e-9 && Math.abs(la - lat) < 1e-9, name);
  }
});

test('analyseImage locates a storm cell on the ground and measures its ellipse', () => {
  const d = blank();
  // Brisbane CBD marker is at about (387, 369); an ellipse 20 px by 10 px, long axis east-west.
  ellipse(d, 387, 369, 20, 10, 0);
  const { cells, forecast } = core.analyseImage(d);
  assert.equal(cells.length, 1);
  const c = cells[0];
  assert.ok(Math.abs(c.lat - -27.47) < 0.03 && Math.abs(c.lon - 153.025) < 0.03, JSON.stringify(c));
  // About 0.42 km per px east-west and 0.39 km per px north-south near Brisbane.
  assert.ok(Math.abs(c.major_km - 20 * 0.416) < 0.3, `major ${c.major_km}`);
  assert.ok(Math.abs(c.minor_km - 10 * 0.39) < 0.3, `minor ${c.minor_km}`);
  assert.ok(Math.abs(c.bearing - 90) < 3, `bearing ${c.bearing}`);
  assert.ok(Math.abs(c.area_km2 - Math.PI * c.major_km * c.minor_km) / c.area_km2 < 0.05, `area ${c.area_km2}`);
  assert.deepEqual(forecast, []);
});

test('cell ellipse bearing follows the drawn orientation', () => {
  for (const [deg, want] of [[90, 0], [-45, 45], [45, 135]]) {
    const d = blank();
    ellipse(d, 300, 300, 24, 8, deg); // image y points south, so +45° in the image runs NW-SE
    const [c] = core.analyseImage(d).cells;
    const diff = Math.abs(((c.bearing - want + 270) % 180) - 90);
    assert.ok(diff < 6, `drawn ${deg}°: bearing ${c.bearing}, wanted about ${want}`);
  }
});

test('forecast points follow the arrows and arcs but not the cell fill or the basemap', () => {
  const d = blank();
  ellipse(d, 200, 300, 12, 12);
  // A 2 px thick "arrow" 60 px long heading east from the cell, aligned to the thinning grid.
  for (let x = 216; x < 276; x++) for (const y of [300, 301]) d.set(LINE, (y * core.IMAGE_W + x) * 4);
  d.set(LINE, (50 * core.IMAGE_W + 50) * 4); // a lone speck is ignored
  const { cells, forecast } = core.analyseImage(d);
  assert.equal(cells.length, 1);
  assert.equal(forecast.length, 60 / core.FORECAST_GRID_PX);
  const g = core.imageToMercatorAffine();
  const [west] = core.pixelToLonLat(g, 216, 300);
  const [east] = core.pixelToLonLat(g, 276, 300);
  for (const [lon, lat] of forecast) {
    assert.ok(lon > west - 0.01 && lon < east + 0.01);
    assert.ok(Math.abs(lat - cells[0].lat) < 0.02);
  }
});

test('analyseImage hash matches the overlay fingerprint and ignores the basemap', () => {
  const a = blank(); ellipse(a, 100, 100, 9, 9);
  const b = blank(); ellipse(b, 100, 100, 9, 9);
  b.set([191, 219, 238, 255], 0); // a basemap pixel changed (e.g. the "Issued at" stamp)
  const c = blank(); ellipse(c, 104, 100, 9, 9);
  const keyed = new Uint8ClampedArray(a);
  core.chromaKey(keyed);
  assert.equal(core.analyseImage(a).hash, core.stormHash(keyed));
  assert.equal(core.analyseImage(a).hash, core.analyseImage(b).hash);
  assert.notEqual(core.analyseImage(a).hash, core.analyseImage(c).hash);
});

test('buildSnapshot has the shape Home Assistant expects', () => {
  const d = blank(); ellipse(d, 300, 300, 10, 10);
  const analysis = core.analyseImage(d);
  const snap = core.buildSnapshot({ issued: 1794316479000, analysis, description: ' ', png: 'AAAA', source: 'test/1' });
  assert.deepEqual(Object.keys(snap), ['v', 'source', 'issued', 'hash', 'image', 'cells', 'forecast', 'description']);
  assert.equal(snap.v, 1);
  assert.deepEqual(snap.image, { w: 600, h: 643, png: 'AAAA' });
  assert.deepEqual(Object.keys(snap.cells[0]), ['lon', 'lat', 'area_km2', 'major_km', 'minor_km', 'bearing']);
  assert.equal(core.buildSnapshot({ issued: 1, analysis }).image, null);
  assert.ok(!('pixelCells' in snap));
});

test('the SVG key filter agrees with stormAlpha on storm and basemap colours', () => {
  const keep = [[245, 189, 138], [204, 120, 51], [216, 171, 126], [240, 178, 122]];
  const drop = [[229, 222, 201], [191, 219, 238], [223, 237, 247], [153, 153, 153], [0, 0, 0], [51, 51, 51], [255, 255, 255], [242, 239, 228]];
  for (const c of keep) {
    assert.ok(Math.abs(core.keyFilterAlpha(...c) - core.stormAlpha(...c)) < 0.08, `keep ${c}`);
  }
  for (const c of drop) assert.equal(core.keyFilterAlpha(...c), 0, `drop ${c}`);
  // Across the whole colour cube the two only part ways right at a threshold.
  let differ = 0; let n = 0;
  for (let r = 0; r < 256; r += 5) for (let g = 0; g < 256; g += 5) for (let b = 0; b < 256; b += 5) {
    n++;
    if ((core.keyFilterAlpha(r, g, b) > 0.15) !== (core.stormAlpha(r, g, b) > 0.15)) differ++;
  }
  assert.ok(differ / n < 0.01, `${differ} of ${n} colours classified differently`);
});

test('keyFilterMarkup is a self-contained sRGB filter and can recolour', () => {
  const svg = core.keyFilterMarkup('k');
  assert.match(svg, /^<filter id="k"[^>]*color-interpolation-filters="sRGB"/);
  assert.equal((svg.match(/<feColorMatrix/g) || []).length, 4);
  assert.equal((svg.match(/operator="in"/g) || []).length, 3);
  assert.match(svg, /values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 2\.24 0 -2\.8 0 0"/);
  assert.match(core.keyFilterMarkup('k', 'black'), /values="0 0 0 0 0\.0784 /);
});

test('the shared georeference fixture matches the core (the Python tests read the same file)', async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/georef.json', import.meta.url), 'utf8'));
  assert.deepEqual(fixture.corners, core.CORNERS);
  assert.deepEqual(fixture.image, { w: core.IMAGE_W, h: core.IMAGE_H });
  const g = core.imageToMercatorAffine();
  for (const { px, lonlat } of fixture.pixel_to_lonlat) {
    const [lon, lat] = core.pixelToLonLat(g, ...px);
    assert.ok(Math.abs(lon - lonlat[0]) < 1e-9 && Math.abs(lat - lonlat[1]) < 1e-9);
  }
});
