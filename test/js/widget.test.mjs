import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../../ios/SEQ Thunderstorm Tracker.js', import.meta.url), 'utf8');
const AsyncFunction = (async () => {}).constructor;

/** Run the Scriptable script against stand-ins for Scriptable's globals and a made-up Home Assistant. */
async function run({ family = 'medium', states = {}, image = true, keys = true, parameter = null, inWidget = true } = {}) {
  const calls = { requests: [], set: null, presented: false };
  class Color { constructor(hex, alpha = 1) { this.hex = hex; this.alpha = alpha; } static white() { return new Color('#fff'); } static lightGray() { return new Color('#ccc'); } }
  const font = (name) => (size) => ({ name, size });
  const Font = { semiboldSystemFont: font('semibold'), systemFont: font('regular'), boldSystemFont: font('bold') };
  class ListWidget {
    constructor() { this.texts = []; }
    addText(text) { const t = { text }; this.texts.push(t); return t; }
    addSpacer() {}
    setPadding() {}
    async presentMedium() { calls.presented = true; }
  }
  class Request {
    constructor(url) { this.url = url; calls.requests.push(this); }
    async loadJSON() {
      const id = this.url.split('/api/states/')[1];
      if (!(id in states)) throw new Error('404');
      return states[id];
    }
    async loadImage() { if (!image) throw new Error('no image'); return { size: { width: 720, height: 720 } }; }
  }
  class DrawContext { drawImageInRect() {} setFillColor() {} fillRect() {} getImage() { return { banded: true }; } }
  class Rect { constructor(...a) { this.a = a; } }
  class DateFormatter { string(d) { return d.toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane', hour: 'numeric', minute: '2-digit', hour12: true }); } }
  class Alert {}
  const store = keys ? { 'seq-thunderstorm-tracker.url': 'https://ha.example', 'seq-thunderstorm-tracker.token': 'tok' } : {};
  const Keychain = { contains: (k) => k in store, get: (k) => store[k], set: (k, v) => { store[k] = v; } };
  const Script = { setWidget: (w) => { calls.set = w; }, complete() {} };
  const config = { runsInWidget: inWidget, widgetFamily: family };
  const args = { widgetParameter: parameter };
  const names = { Color, Font, ListWidget, Request, DrawContext, Rect, DateFormatter, Alert, Keychain, Script, config, args };
  await new AsyncFunction(...Object.keys(names), SOURCE)(...Object.values(names));
  return { widget: calls.set, texts: calls.set ? calls.set.texts.map((t) => t.text) : [], calls };
}

const BRIDGE = 'binary_sensor.seq_thunderstorm_tracker_bridge';
const NEAREST = 'sensor.thunderstorms_near_home_nearest_storm';
const on = { state: 'on', attributes: {} };
const near = { state: '12.4', attributes: { direction: 'NW', in_coverage: true, issued: '2026-11-10T05:42:00+00:00' } };

test('widget shows the distance over the map and asks only Home Assistant', async () => {
  const { widget, texts, calls } = await run({ states: { [BRIDGE]: on, [NEAREST]: near } });
  assert.deepEqual(texts, ['12 km NW', 'Nearest storm · Tracker 3:42 pm']);
  assert.deepEqual(widget.backgroundImage, { banded: true });
  assert.ok(widget.refreshAfterDate > new Date());
  assert.match(widget.url, /^https:\/\/www\.bom\.gov\.au\//);
  assert.ok(calls.requests.length === 3 && calls.requests.every((r) => r.url.startsWith('https://ha.example/api/')));
  assert.ok(calls.requests.every((r) => r.headers.Authorization === 'Bearer tok'));
  assert.ok(calls.requests.some((r) => r.url.endsWith('/api/image_proxy/image.thunderstorms_near_home_map')));
});

test('widget: no storms, stale bridge, out of area and no connection', async () => {
  const none = await run({ states: { [BRIDGE]: on, [NEAREST]: { state: 'unknown', attributes: { in_coverage: true, issued: '2026-11-10T05:42:00+00:00' } } } });
  assert.deepEqual(none.texts, ['No storms', 'Tracker 3:42 pm']);
  const stale = await run({ states: { [BRIDGE]: { state: 'off', attributes: {} }, [NEAREST]: { state: 'unavailable', attributes: {} } } });
  assert.deepEqual(stale.texts, ['No tracker data', 'Open a BoM tab with the bridge running']);
  assert.equal(stale.widget.backgroundImage, undefined, 'no old map behind a stale reading');
  assert.equal(stale.calls.requests.length, 2);
  const away = await run({ states: { [BRIDGE]: on, [NEAREST]: { state: 'unknown', attributes: { in_coverage: false } } } });
  assert.equal(away.texts[0], 'Out of area');
  const down = await run({ states: {} });
  assert.deepEqual(down.texts, ['No connection', 'Home Assistant did not answer']);
});

test('widget: lock screen sizes, another place from the parameter, and first-run setup', async () => {
  const states = { [BRIDGE]: on, [NEAREST]: near };
  assert.deepEqual((await run({ family: 'accessoryInline', states })).texts, ['⚡ 12 km NW']);
  assert.deepEqual((await run({ family: 'accessoryRectangular', states })).texts, ['⚡ 12 km NW', 'Nearest storm · Tracker 3:42 pm']);
  const other = await run({
    parameter: 'image.thunderstorms_near_jordan_map, sensor.thunderstorms_near_jordan_nearest_storm',
    states: { [BRIDGE]: on, 'sensor.thunderstorms_near_jordan_nearest_storm': { state: '40', attributes: { direction: 'W' } } },
  });
  assert.equal(other.texts[0], '40 km W');
  assert.ok(other.calls.requests.some((r) => r.url.endsWith('/api/image_proxy/image.thunderstorms_near_jordan_map')));
  const unset = await run({ keys: false });
  assert.match(unset.texts[1], /set it up/);
  assert.equal(unset.calls.requests.length, 0);
});
