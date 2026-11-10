/**
 * The Home Assistant bridge userscript. Built to ../../seq-thunderstorm-tracker-ha-bridge.user.js.
 *
 * Home Assistant cannot fetch the tracker itself: the Bureau turns away anything that is not a
 * browser. This script runs in your browser on a bom.gov.au tab instead, reads the same image
 * the page shows, and posts where the storms are to your Home Assistant.
 */

/* global GM_xmlhttpRequest, GM_getValue, GM_setValue, GM_registerMenuCommand */

import { IMAGE_URL, TRACKER_PAGE } from '../../packages/core/georef.js';
import { formatIssued, formatAgeLong } from '../../packages/core/time.js';
import { createBridge, isWebhookUrl } from './bridge.js';

const VERSION = '__VERSION__';
const TICK_MS = 60 * 1000;
const POST_TIMEOUT_MS = 20 * 1000;
const log = (...args) => console.info('[SEQ tracker bridge]', ...args);

const store = {
  get: (key, fallback) => GM_getValue(key, fallback),
  set: (key, value) => GM_setValue(key, value),
};

async function fetchTracker() {
  const res = await fetch(IMAGE_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`the Bureau answered ${res.status} for the tracker image`);
  const modified = res.headers.get('last-modified');
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return {
    issued: modified ? Date.parse(modified) : Date.now(),
    data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    w: canvas.width,
    h: canvas.height,
    png: () => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }),
  };
}

async function fetchDescription() {
  const res = await fetch(TRACKER_PAGE, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // The tracker page is an older Latin-1 page; DOMParser documents are inert (no scripts/images).
  const html = new TextDecoder('windows-1252').decode(await res.arrayBuffer());
  const node = new DOMParser().parseFromString(html, 'text/html').getElementById('forecasttext');
  return node ? node.textContent.replace(/\s+/g, ' ').trim() : null;
}

/** The userscript manager makes this request, so the page's CSP and CORS do not apply. */
function post(url, body) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(body),
      anonymous: true,
      timeout: POST_TIMEOUT_MS,
      onload: (r) => {
        let json = null;
        try { json = JSON.parse(r.responseText); } catch (_) { /* not JSON */ }
        resolve({ status: r.status, json });
      },
      onerror: () => reject(new Error('could not reach Home Assistant')),
      ontimeout: () => reject(new Error('Home Assistant took too long to answer')),
    });
  });
}

// ----- status line ------------------------------------------------------------

const line = document.createElement('div');
line.setAttribute('data-seq-ts-bridge', '');
line.style.cssText = 'font-size:14px;line-height:20px;margin-top:4px';

function describe(status) {
  switch (status.state) {
    case 'setup':
      return 'Home Assistant bridge: not set up. Open your userscript manager’s menu and choose “Set Home Assistant webhook address”.';
    case 'sent':
      return `Home Assistant bridge: sent ${formatAgeLong(Date.now() - status.at)}, tracker issued ${formatIssued(new Date(status.issued))} ` +
        `(${status.cells === 0 ? 'no tracked storms' : `${status.cells} storm cell${status.cells === 1 ? '' : 's'}`})`;
    case 'error':
      return `Home Assistant bridge: ${status.error}`;
    default:
      return 'Home Assistant bridge: waiting for the next look at the tracker';
  }
}

function render() {
  const status = bridge.status();
  line.textContent = describe(status);
  line.style.color = status.state === 'error' ? '#b3261e' : '';
  if (line.isConnected) return;
  const home = document.querySelector('.C07_WeatherMetadata .metadata__container, .metadata__container') ||
    (document.getElementById('forecasttext') || {}).parentElement;
  if (home) home.appendChild(line);
}

const bridge = createBridge({
  store,
  fetchTracker,
  fetchDescription,
  post,
  source: `bridge-userscript/${VERSION}`,
  onStatus: (status) => { if (status.state === 'error') log(status.error); },
});

// ----- running ------------------------------------------------------------------

async function tick(manual = false) {
  if (!manual && document.hidden && !store.get('background', true)) return;
  await bridge.tick(manual);
  render();
}

function start() {
  log(`version ${VERSION} is the sending tab`);
  setTimeout(tick, 3000);
  setInterval(tick, TICK_MS);
}

// One tab does the work. The others queue for the lock and take over when that tab closes.
if (navigator.locks && navigator.locks.request) {
  navigator.locks.request('seq-thunderstorm-tracker-ha-bridge', () => { start(); return new Promise(() => {}); });
} else {
  start();
}
render();
setInterval(render, 30000);

GM_registerMenuCommand('Set Home Assistant webhook address', () => {
  const entered = prompt(
    'Paste the webhook address from Home Assistant (Settings, Devices & services, SEQ Thunderstorm Tracker, Configure).\n' +
    'Leave it empty to stop sending.',
    store.get('webhookUrl', ''),
  );
  if (entered === null) return;
  const url = entered.trim();
  if (url && !isWebhookUrl(url)) {
    alert('That does not look like a Home Assistant webhook address. It should end in /api/webhook/ and a long code.');
    return;
  }
  store.set('webhookUrl', url);
  store.set('sentHash', null);
  tick(true);
});

GM_registerMenuCommand('Send to Home Assistant now', () => tick(true));

GM_registerMenuCommand('Background tabs: turn sending on or off', () => {
  const on = !store.get('background', true);
  store.set('background', on);
  alert(on
    ? 'The bridge keeps sending while this tab is in the background (one look at the tracker every 5 minutes).'
    : 'The bridge only sends while a bom.gov.au tab is on screen.');
});

GM_registerMenuCommand('Bridge status', () => alert(describe(bridge.status())));
