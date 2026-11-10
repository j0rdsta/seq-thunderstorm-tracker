import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as core from '../../packages/core/index.js';
import { createBridge, isWebhookUrl, POLL_MS } from '../../userscripts/bridge/bridge.js';

const URL_OK = 'https://example.ui.nabu.casa/api/webhook/abc123';

function image(blobs = [[300, 300, 10]]) {
  const d = new Uint8ClampedArray(core.IMAGE_W * core.IMAGE_H * 4);
  for (let i = 0; i < core.IMAGE_W * core.IMAGE_H; i++) d.set([229, 222, 201, 255], i * 4);
  for (const [cx, cy, r] of blobs) {
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) d.set([245, 189, 138, 255], (y * core.IMAGE_W + x) * 4);
    }
  }
  return d;
}

/** A bridge wired to fakes, with a clock the test moves. */
function rig({ url = URL_OK, answer = () => ({ status: 200, json: { ok: true } }) } = {}) {
  const values = new Map([['webhookUrl', url]]);
  const r = {
    t: 1_000_000_000_000,
    looks: 0,
    descriptions: 0,
    posts: [],
    frame: { data: image(), w: core.IMAGE_W, h: core.IMAGE_H },
    values,
  };
  r.bridge = createBridge({
    store: { get: (k, d) => (values.has(k) ? values.get(k) : d), set: (k, v) => values.set(k, v) },
    fetchTracker: async () => { r.looks++; return { issued: r.t - 60000, ...r.frame, png: async () => 'UE5H' }; },
    fetchDescription: async () => { r.descriptions++; return 'At 12:00 pm, thunderstorms were detected near Gatton.'; },
    post: async (to, body) => { r.posts.push({ to, body }); return answer(body, r.posts.length); },
    now: () => r.t,
    source: 'test/1',
  });
  return r;
}

test('isWebhookUrl accepts Home Assistant webhook addresses only', () => {
  assert.ok(isWebhookUrl(URL_OK));
  assert.ok(isWebhookUrl('http://homeassistant.local:8123/api/webhook/abc'));
  for (const bad of ['', 'abc', 'https://example.com/', 'ftp://x/api/webhook/abc', 'https://x/api/webhook/', 'javascript:alert(1)']) {
    assert.equal(isWebhookUrl(bad), false, bad);
  }
});

test('the bridge does nothing until a webhook address is set', async () => {
  const r = rig({ url: '' });
  assert.equal((await r.bridge.tick()).state, 'setup');
  assert.equal(r.looks, 0);
  assert.equal(r.posts.length, 0);
});

test('first look posts a full snapshot with the image', async () => {
  const r = rig();
  const status = await r.bridge.tick();
  assert.equal(status.state, 'sent');
  assert.equal(status.cells, 1);
  assert.equal(r.posts.length, 1);
  const { to, body } = r.posts[0];
  assert.equal(to, URL_OK);
  assert.equal(body.v, 1);
  assert.equal(body.source, 'test/1');
  assert.equal(body.issued, r.t - 60000);
  assert.deepEqual(body.image, { w: 600, h: 643, png: 'UE5H' });
  assert.equal(body.cells.length, 1);
  assert.match(body.description, /Gatton/);
});

test('it looks at the tracker at most once every five minutes', async () => {
  const r = rig();
  await r.bridge.tick();
  for (let i = 0; i < 4; i++) { r.t += 60000; await r.bridge.tick(); }
  assert.equal(r.looks, 1);
  assert.equal(r.posts.length, 1);
  r.t += 60000;
  await r.bridge.tick();
  assert.equal(r.looks, 2);
  // A second tab shares the stored time of the last look, so it waits too.
  assert.equal(r.values.get('lastPollAt'), r.t);
});

test('unchanged storms are sent as a heartbeat without the image or a new description fetch', async () => {
  const r = rig();
  await r.bridge.tick();
  r.t += POLL_MS;
  await r.bridge.tick();
  assert.equal(r.posts.length, 2);
  assert.equal(r.posts[1].body.image, null);
  assert.equal(r.posts[1].body.hash, r.posts[0].body.hash);
  assert.equal(r.posts[1].body.issued, r.t - 60000);
  assert.equal(r.descriptions, 1);
});

test('changed storms send the new image and fetch the description again', async () => {
  const r = rig();
  await r.bridge.tick();
  r.t += POLL_MS;
  r.frame = { ...r.frame, data: image([[320, 300, 10]]) };
  await r.bridge.tick();
  assert.ok(r.posts[1].body.image);
  assert.notEqual(r.posts[1].body.hash, r.posts[0].body.hash);
  assert.equal(r.descriptions, 2);
});

test('the image is sent again when Home Assistant asks for it', async () => {
  const r = rig({ answer: (body, n) => ({ status: 200, json: { ok: true, need_image: n === 2 } }) });
  await r.bridge.tick();
  r.t += POLL_MS;
  await r.bridge.tick();
  assert.equal(r.posts.length, 3);
  assert.equal(r.posts[1].body.image, null);
  assert.ok(r.posts[2].body.image);
});

test('a failed post is retried on the next tick without another look at the tracker', async () => {
  let fail = true;
  const r = rig({ answer: () => (fail ? { status: 502, json: null } : { status: 200, json: { ok: true } }) });
  assert.equal((await r.bridge.tick()).state, 'error');
  fail = false;
  r.t += 60000;
  assert.equal((await r.bridge.tick()).state, 'sent');
  assert.equal(r.looks, 1);
  assert.equal(r.posts.length, 2);
  assert.ok(r.posts[1].body.image, 'the retry still carries the image');
});

test('an image of another size is refused rather than misplaced', async () => {
  const r = rig();
  r.frame = { data: new Uint8ClampedArray(4), w: 1, h: 1 };
  const status = await r.bridge.tick();
  assert.equal(status.state, 'error');
  assert.match(status.error, /changed size/);
  assert.equal(r.posts.length, 0);
});

test('bridge userscript header: own grants, narrow matches, version in step', () => {
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const src = read('seq-thunderstorm-tracker-ha-bridge.user.js');
  const pkg = JSON.parse(read('package.json'));
  const header = src.slice(0, src.indexOf('// ==/UserScript=='));
  const meta = (k) => [...header.matchAll(new RegExp(`^// @${k}\\s+(.+)$`, 'gm'))].map((m) => m[1].trim());
  assert.deepEqual(meta('version'), [pkg.version]);
  assert.deepEqual(meta('grant'), ['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand']);
  assert.deepEqual(meta('match'), [
    'https://www.bom.gov.au/location/*',
    'https://www.bom.gov.au/qld/forecasts/brisbane-thunderstorms.shtml',
  ]);
  const raw = 'https://github.com/j0rdsta/seq-thunderstorm-tracker/raw/main/seq-thunderstorm-tracker-ha-bridge.user.js';
  assert.deepEqual(meta('updateURL'), [raw]);
  assert.deepEqual(meta('downloadURL'), [raw]);
  assert.ok(!src.includes('__VERSION__'));
});
