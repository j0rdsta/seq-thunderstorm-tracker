/**
 * Writes test/fixtures/georef.json from the JavaScript core. Both test suites read it, so the
 * Python copy of the georeference and distance maths has to agree with the JavaScript one.
 * Run it only when the georeference is recalibrated on purpose.
 */

import { writeFileSync } from 'node:fs';
import * as core from '../packages/core/index.js';

const g = core.imageToMercatorAffine();
const pixels = [[0, 0], [600, 0], [0, 643], [600, 643], [300, 321.5], [387.2, 369], [134.9, 396.1], [50.5, 600.25]];

const fixture = {
  image: { w: core.IMAGE_W, h: core.IMAGE_H },
  corners: core.CORNERS,
  pixel_to_lonlat: pixels.map(([x, y]) => ({ px: [x, y], lonlat: core.pixelToLonLat(g, x, y) })),
  km_per_pixel_at_brisbane: (() => {
    const lat = -27.47;
    const k = Math.cos((lat * Math.PI) / 180) / 1000;
    return { lat, across: Math.hypot(g.a, g.b) * k, down: Math.hypot(g.c, g.d) * k };
  })(),
};

writeFileSync(new URL('../test/fixtures/georef.json', import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
console.log('wrote test/fixtures/georef.json');
