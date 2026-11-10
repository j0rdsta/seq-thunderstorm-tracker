import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../../packages/core/index.js';
import { overlayGeometry, radarTileUrl } from '../../card/src/pure.js';
import { describeStatus, discover, placeFor, DOMAIN } from '../../card/src/status.js';
import { TOWNS } from './towns.mjs';

test('overlay geometry puts every control town where Leaflet will draw it', () => {
  const geo = overlayGeometry();
  const [[south, west], [north, east]] = geo.bounds;
  assert.ok(south < -28.3 && north > -26.2 && west < 151.5 && east > 153.8, JSON.stringify(geo.bounds));
  const [a, b, c, d, e, f] = geo.transform.match(/-?[\d.]+(?:e-?\d+)?/g).map(Number);
  // Leaflet stretches the SVG linearly in Web Mercator between the bounds' corners.
  const [x0, y1] = core.lonLatToMercator(west, north);
  for (const [name, px, py, lat, lon] of TOWNS) {
    const svgX = a * px + c * py + e;
    const svgY = b * px + d * py + f;
    const [X, Y] = core.lonLatToMercator(lon, lat);
    const errMetres = Math.hypot(x0 + svgX - X, y1 - svgY - Y);
    assert.ok(errMetres < 4 * 470, `${name}: ${Math.round(errMetres)} m`);
  }
  assert.ok(Math.abs(geo.width - (core.lonLatToMercator(east, 0)[0] - x0)) < 1);
});

test('radarTileUrl takes the newest past frame and never builds a path itself', () => {
  const index = { host: 'https://tilecache.rainviewer.com', radar: { past: [{ time: 1, path: '/v2/radar/a' }, { time: 2, path: '/v2/radar/b' }] } };
  assert.deepEqual(radarTileUrl(index), { url: 'https://tilecache.rainviewer.com/v2/radar/b/256/{z}/{x}/{y}/2/1_0.png', time: 2 });
  for (const bad of [null, {}, { host: 'x', radar: { past: [] } }, { radar: { past: [{ path: '/p' }] } }]) {
    assert.equal(radarTileUrl(bad), null);
  }
});

const reg = (id, key, device) => [id, { entity_id: id, platform: DOMAIN, translation_key: key, device_id: device }];
const ENTITIES = Object.fromEntries([
  reg('sensor.storms', 'storms'), reg('sensor.issued', 'issued'), reg('binary_sensor.bridge', 'bridge'), reg('image.tracker', 'tracker'),
  reg('sensor.home_nearest', 'nearest_storm', 'd-home'), reg('sensor.home_track', 'nearest_forecast_track', 'd-home'),
  reg('binary_sensor.home_nearby', 'storm_nearby', 'd-home'),
  reg('sensor.jordan_nearest', 'nearest_storm', 'd-jordan'),
  ['light.kitchen', { entity_id: 'light.kitchen', platform: 'hue', translation_key: null }],
]);
const ISSUED = '2026-11-10T05:42:00+00:00'; // 3:42 pm in Brisbane

function states(over = {}) {
  return {
    'sensor.storms': { state: '14', attributes: { description: 'At 3:40 pm, thunderstorms were detected near Ipswich.' } },
    'sensor.issued': { state: ISSUED, attributes: {} },
    'binary_sensor.bridge': { state: 'on', attributes: {} },
    'sensor.home_nearest': { state: '12.4', attributes: { target: 'zone.home', direction: 'NW', in_coverage: true } },
    'sensor.home_track': { state: '3.2', attributes: { target: 'zone.home', direction: 'W' } },
    'binary_sensor.home_nearby': { state: 'on', attributes: { target: 'zone.home', radius_km: 20 } },
    'sensor.jordan_nearest': { state: 'unknown', attributes: { target: 'person.jordan', in_coverage: false } },
    ...over,
  };
}
const status = (over = {}, opts = {}) => describeStatus({
  shown: 'bom', found: discover(ENTITIES), states: states(over), target: 'zone.home', targetName: 'Home', ...opts,
});

test('discover finds the integration entities and groups places by device', () => {
  const found = discover(ENTITIES);
  assert.deepEqual(found.hub, { storms: 'sensor.storms', issued: 'sensor.issued', bridge: 'binary_sensor.bridge', tracker: 'image.tracker' });
  assert.deepEqual(Object.keys(found.places), ['d-home', 'd-jordan']);
  assert.equal(placeFor(found, states(), 'zone.home').storm_nearby, 'binary_sensor.home_nearby');
  assert.equal(placeFor(found, states(), 'person.jordan').nearest_storm, 'sensor.jordan_nearest');
  assert.equal(placeFor(found, states(), 'zone.work'), null);
  assert.deepEqual(discover(undefined), { hub: {}, places: {} });
});

test('status: storms near the first place, with the forecast track when it is closer', () => {
  const s = status();
  assert.equal(s.text, 'Tracker issued 3:42 pm AEST · 14 storm cells · nearest 12 km NW of Home · forecast track within 3 km');
  assert.equal(s.warn, false);
  assert.match(s.description, /Ipswich/);
  assert.equal(status({ 'sensor.home_track': { state: '12.4', attributes: { target: 'zone.home' } } }).text,
    'Tracker issued 3:42 pm AEST · 14 storm cells · nearest 12 km NW of Home');
});

test('status: no storms, one storm, and a place outside coverage', () => {
  const none = { 'sensor.storms': { state: '0', attributes: {} }, 'sensor.home_nearest': { state: 'unknown', attributes: { target: 'zone.home', in_coverage: true } } };
  assert.equal(status(none).text, 'Tracker issued 3:42 pm AEST · no tracked storms');
  assert.equal(status({ 'sensor.storms': { state: '1', attributes: {} } }).text.includes('1 storm cell ·'), true);
  assert.equal(status({}, { target: 'person.jordan', targetName: 'Jordan' }).text,
    'Tracker issued 3:42 pm AEST · 14 storm cells · Jordan is outside Southeast Queensland');
});

test('status: a stale bridge is said plainly and never reads as no storms', () => {
  const stale = { 'binary_sensor.bridge': { state: 'off', attributes: {} }, 'sensor.storms': { state: 'unavailable', attributes: {} } };
  const live = status(stale);
  assert.equal(live.warn, true);
  assert.match(live.text, /^Live picture from the Bureau’s Thunderstorm Tracker\. Distances are unavailable: the Home Assistant bridge last sent a picture issued 3:42 pm AEST\.$/);
  assert.equal(live.description, null);
  assert.ok(!/no tracked storms/.test(live.text));
  const never = status({ ...stale, 'sensor.issued': { state: 'unavailable', attributes: {} } });
  assert.match(never.text, /has not sent anything yet/);
});

test('status: without the integration, and when nothing could be loaded', () => {
  const bare = describeStatus({ shown: 'bom', found: discover({}), states: {}, target: 'zone.home', targetName: 'Home' });
  assert.deepEqual(bare, { text: 'Live picture from the Bureau’s Thunderstorm Tracker.', warn: false, description: null });
  const failed = describeStatus({ shown: null, loading: false, found: discover({}), states: {}, target: null, targetName: '' });
  assert.equal(failed.warn, true);
  assert.match(failed.text, /could not be loaded/);
  const loading = describeStatus({ shown: null, loading: true, found: discover({}), states: {}, target: null, targetName: '' });
  assert.equal(loading.warn, false);
});

test('built card is in step with package.json and registers itself', () => {
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const pkg = JSON.parse(read('package.json'));
  const card = read('custom_components/seq_thunderstorm_tracker/frontend/seq-thunderstorm-tracker-card.js');
  assert.ok(card.startsWith(`/*! SEQ Thunderstorm Tracker card ${pkg.version} `));
  assert.ok(card.includes('seq-thunderstorm-tracker-card'));
  assert.ok(card.includes('customCards'));
  assert.ok(!card.includes('__VERSION__'));
  const manifest = JSON.parse(read('custom_components/seq_thunderstorm_tracker/manifest.json'));
  assert.equal(manifest.version, pkg.version);
  assert.match(read('pyproject.toml'), new RegExp(`^version = "${pkg.version.replaceAll('.', '\\.')}"$`, 'm'));
});
