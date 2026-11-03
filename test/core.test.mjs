import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const core = require('../seq-thunderstorm-tracker.user.js');
const SRC = readFileSync(new URL('../seq-thunderstorm-tracker.user.js', import.meta.url), 'utf8');

// Town markers as drawn on IDA00050.png (pixel centre) and their real coordinates.
const TOWNS = [
  ['Noosa Heads', 402.9, 63.2, -26.3943, 153.0901],
  ['Kingaroy', 105.1, 106.1, -26.5407, 151.8394],
  ['Maroochydore', 406.0, 141.9, -26.66, 153.099],
  ['Caloundra', 412.0, 178.1, -26.804, 153.122],
  ['Caboolture', 370.0, 260.0, -27.085, 152.951],
  ['Redcliffe', 407.0, 301.9, -27.23, 153.102],
  ['Brisbane CBD', 387.2, 369.0, -27.4698, 153.0251],
  ['Cleveland', 448.0, 384.2, -27.526, 153.265],
  ['Toowoomba', 134.9, 396.1, -27.5598, 151.9507],
  ['Ipswich', 324.2, 412.0, -27.6141, 152.76],
  ['Logan Central', 406.5, 419.0, -27.639, 153.109],
  ['Beenleigh', 429.2, 436.0, -27.716, 153.203],
  ['Warwick', 154.2, 584.0, -28.215, 152.034],
];

test('georeference maps every control town to within 4 image px (~1.9 km)', () => {
  const inv = core.invertAffine(core.imageToMercatorAffine());
  for (const [name, px, py, lat, lon] of TOWNS) {
    const [X, Y] = core.lonLatToMercator(lon, lat);
    const [x, y] = core.applyAffine(inv, X, Y);
    const err = Math.hypot(x - px, y - py);
    assert.ok(err < 4, `${name}: ${err.toFixed(2)} px`);
  }
});

test('invertAffine round-trips', () => {
  const g = core.imageToMercatorAffine();
  const [X, Y] = core.applyAffine(g, 123, 456);
  const [x, y] = core.applyAffine(core.invertAffine(g), X, Y);
  assert.ok(Math.abs(x - 123) < 1e-6 && Math.abs(y - 456) < 1e-6);
});

test('nudge shifts the footprint in metres', () => {
  const a = core.footprintBounds(core.imageToMercatorAffine());
  const b = core.footprintBounds(core.imageToMercatorAffine(undefined, undefined, undefined, { dx: 1000, dy: -500 }));
  assert.ok(Math.abs(b.xmin - a.xmin - 1000) < 1e-6);
  assert.ok(Math.abs(b.ymax - a.ymax + 500) < 1e-6);
});

test('imageToScreenTransform places the image correctly in a north-up view', () => {
  const g = core.imageToMercatorAffine();
  const fp = core.footprintBounds(g);
  // A view exactly covering the footprint at 1 m/px resolution scaled to 1000x1000 px.
  const ext = { ...fp };
  const t = core.imageToScreenTransform(g, ext, 1000, 1000);
  const tl = [t.e, t.f];
  const br = [t.a * core.IMAGE_W + t.c * core.IMAGE_H + t.e, t.b * core.IMAGE_W + t.d * core.IMAGE_H + t.f];
  assert.ok(Math.abs(tl[0]) < 5 && Math.abs(tl[1]) < 5, `top-left ${tl}`);
  assert.ok(Math.abs(br[0] - 1000) < 5 && Math.abs(br[1] - 1000) < 5, `bottom-right ${br}`);
});

test('viewExtent prefers center/resolution over a stale extent', () => {
  const view = {
    center: { x: 100, y: 200, spatialReference: { wkid: 102100 } },
    resolution: 2,
    extent: { xmin: 0, xmax: 1, ymin: 0, ymax: 1 },
  };
  assert.deepEqual(
    { ...core.viewExtent(view, 50, 20), spatialReference: undefined },
    { xmin: 50, xmax: 150, ymin: 180, ymax: 220, spatialReference: undefined },
  );
  assert.equal(core.viewExtent({ extent: { xmin: 1, xmax: 2, ymin: 3, ymax: 4 } }, 10, 10).xmax, 2);
});

test('intersects detects SEQ coverage', () => {
  const fp = core.footprintBounds(core.imageToMercatorAffine());
  const [bx, by] = core.lonLatToMercator(153.03, -27.47);
  const [px, py] = core.lonLatToMercator(115.86, -31.95); // Perth
  assert.equal(core.intersects(fp, { xmin: bx - 1, xmax: bx + 1, ymin: by - 1, ymax: by + 1 }), true);
  assert.equal(core.intersects(fp, { xmin: px - 1e5, xmax: px + 1e5, ymin: py - 1e5, ymax: py + 1e5 }), false);
});

test('stormAlpha keeps storm colours and drops the basemap', () => {
  const keep = [[245, 189, 138], [204, 120, 51], [216, 171, 126], [240, 178, 122]];
  const drop = [[229, 222, 201], [191, 219, 238], [223, 237, 247], [153, 153, 153], [0, 0, 0], [51, 51, 51], [255, 255, 255], [242, 239, 228]];
  for (const c of keep) assert.ok(core.stormAlpha(...c) > 0.3, `keep ${c}`);
  for (const c of drop) assert.equal(core.stormAlpha(...c), 0, `drop ${c}`);
  assert.ok(core.stormAlpha(204, 120, 51) > core.stormAlpha(245, 189, 138), 'lines more opaque than fill');
});

test('chromaKey makes background transparent and can recolour', () => {
  const px = new Uint8ClampedArray([229, 222, 201, 255, 204, 120, 51, 255]);
  const kept = core.chromaKey(px, 'magenta');
  assert.equal(kept, 1);
  assert.equal(px[3], 0);
  assert.deepEqual([...px.slice(4, 7)], [214, 0, 170]);
  assert.ok(px[7] > 200);
});

function synth(w, h, blobs) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([229, 222, 201, 255], i * 4);
  for (const [cx, cy, r] of blobs) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) d.set([245, 189, 138, 255], (y * w + x) * 4);
    }
  }
  return d;
}

test('countCells counts filled storm cells and ignores specks', () => {
  assert.equal(core.countCells(synth(100, 100, []), 100, 100), 0);
  assert.equal(core.countCells(synth(100, 100, [[20, 20, 8], [70, 70, 10], [50, 10, 1]]), 100, 100), 2);
});

test('formatAge', () => {
  assert.equal(core.formatAge(10_000), 'just now');
  assert.equal(core.formatAge(5 * 60_000), '5 min ago');
  assert.equal(core.formatAge(125 * 60_000), '2 h 5 min ago');
});

test('userscript header is consistent with package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const header = SRC.slice(0, SRC.indexOf('// ==/UserScript=='));
  const meta = (k) => [...header.matchAll(new RegExp(`^// @${k}\\s+(.+)$`, 'gm'))].map((m) => m[1].trim());
  assert.deepEqual(meta('version'), [pkg.version]);
  assert.deepEqual(meta('grant'), ['none']);
  assert.deepEqual(meta('match'), ['https://www.bom.gov.au/location/*'], 'keep @match narrow');
  const raw = 'https://github.com/j0rdsta/seq-thunderstorm-tracker/raw/main/seq-thunderstorm-tracker.user.js';
  assert.deepEqual(meta('updateURL'), [raw]);
  assert.deepEqual(meta('downloadURL'), [raw]);
});

test('formatIssued and formatAgeLong match BoM "Last updated" wording', () => {
  assert.equal(core.formatIssued(new Date('2026-11-03T02:26:40Z')), '12:26 pm AEST');
  assert.equal(core.formatIssued(new Date('2026-11-02T21:05:00Z')), '7:05 am AEST');
  assert.equal(core.formatAgeLong(20_000), 'less than a minute ago');
  assert.equal(core.formatAgeLong(61_000), '1 minute ago');
  assert.equal(core.formatAgeLong(9 * 60_000), '9 minutes ago');
  assert.equal(core.formatAgeLong(125 * 60_000), '2 hours ago');
});

test('parseTimelineLabel reads the radar timeline label', () => {
  const now = new Date('2026-11-03T02:30:00Z');
  assert.equal(core.parseTimelineLabel('Tuesday 3 Nov,  12:20pm AEST', now).toISOString(), '2026-11-03T02:20:00.000Z');
  assert.equal(core.parseTimelineLabel('Tuesday 3 Nov, 9:05am AEDT', now).toISOString(), '2026-11-02T22:05:00.000Z');
  assert.equal(core.parseTimelineLabel('Wednesday 4 Nov', now), null);
  assert.equal(core.parseTimelineLabel('', now), null);
  // Year rollover: a 31 Dec label viewed on 1 Jan belongs to the previous year.
  const jan = new Date('2027-01-01T00:10:00Z');
  assert.equal(core.parseTimelineLabel('Thursday 31 Dec, 11:55pm AEST', jan).getUTCFullYear(), 2026);
});

test('pickTrackerFrame pairs radar frames with the tracker image issued just after them', () => {
  const at = (hhmm) => Date.parse(`2026-11-03T${hhmm}:00+10:00`);
  const saved = ['12:07', '12:13', '12:19', '12:25', '12:31'].map(at);
  assert.equal(core.pickTrackerFrame(saved, at('12:25')), at('12:31'));
  assert.equal(core.pickTrackerFrame(saved, at('12:20')), at('12:25'));
  assert.equal(core.pickTrackerFrame(saved, at('12:05')), at('12:07'));
  // Nothing saved near an older radar frame → null (overlay hidden for that frame).
  assert.equal(core.pickTrackerFrame([at('12:31')], at('11:55')), null);
  assert.equal(core.pickTrackerFrame([], at('12:25')), null);
});

test('findCells returns centroids of filled cells', () => {
  const cells = core.findCells(synth(100, 100, [[20, 30, 8], [70, 60, 10]]), 100, 100);
  assert.equal(cells.length, 2);
  const a = cells.find((c) => c.x < 50);
  assert.ok(Math.abs(a.x - 20) < 0.5 && Math.abs(a.y - 30) < 0.5);
});

test('linkTracks follows two storms moving in parallel and starts a new path for a newcomer', () => {
  const min = 60000;
  // ~2.4 px/min ≈ 60 km/h eastwards for both storms.
  const frames = [0, 6, 12, 18].map((m) => ({
    t: m * min,
    cells: [{ x: 100 + 2.4 * m, y: 100, area: 200 }, { x: 100 + 2.4 * m, y: 300, area: 200 }],
  }));
  frames[3].cells.push({ x: 500, y: 500, area: 100 });
  const tracks = core.linkTracks(frames);
  const long = tracks.filter((t) => t.points.length === 4);
  assert.equal(long.length, 2);
  assert.equal(tracks.length, 3);
  for (const t of long) assert.ok(new Set(t.points.map((p) => Math.round(p.y))).size === 1, 'no cross-linking');
});

test('linkTracks does not link implausibly fast jumps', () => {
  const tracks = core.linkTracks([
    { t: 0, cells: [{ x: 0, y: 0, area: 100 }] },
    { t: 6 * 60000, cells: [{ x: 200, y: 0, area: 100 }] }, // 84 km in 6 min
  ]);
  assert.equal(tracks.length, 2);
});

test('predictTrack extrapolates a steady path and widens uncertainty with lead time', () => {
  const min = 60000;
  const pts = [0, 6, 12, 18].map((m) => ({ t: m * min, x: 100 + 2 * m, y: 200 - 1 * m, area: 200 }));
  const p = core.predictTrack(pts, [30, 60]);
  assert.ok(p);
  assert.ok(Math.abs(p.predictions[1].x - (136 + 120)) < 0.01, `x ${p.predictions[1].x}`);
  assert.ok(Math.abs(p.predictions[1].y - (182 - 60)) < 0.01, `y ${p.predictions[1].y}`);
  assert.ok(p.predictions[1].r > p.predictions[0].r);
  assert.ok(Math.abs(p.speedKmh - Math.hypot(2, 1) * core.KM_PER_PX * 60) < 1e-6);
  // Too short a history → no estimate.
  assert.equal(core.predictTrack(pts.slice(0, 2)), null);
  assert.equal(core.predictTrack(pts.slice(0, 3).map((q, i) => ({ ...q, t: i * 60000 }))), null);
});

test('stormHash ignores colour but changes when the storms move', () => {
  const a = synth(60, 60, [[20, 20, 6]]);
  const b = synth(60, 60, [[20, 20, 6]]);
  const c = synth(60, 60, [[24, 20, 6]]);
  core.chromaKey(a, 'original');
  core.chromaKey(b, 'magenta');
  core.chromaKey(c, 'original');
  assert.equal(core.stormHash(a), core.stormHash(b));
  assert.notEqual(core.stormHash(a), core.stormHash(c));
});
