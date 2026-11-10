/**
 * What the bridge does, with the browser kept at arm's length so it can be tested in Node:
 * every POLL_MS it looks at the tracker image, works out where the storms are and posts a
 * snapshot to a Home Assistant webhook.
 *
 * Being gentle with the Bureau: one conditional image request per POLL_MS across every open
 * tab (the time of the last look is kept in shared storage), and the description page is only
 * fetched when the storms have changed.
 */

import { IMAGE_W, IMAGE_H } from '../../packages/core/georef.js';
import { analyseImage, buildSnapshot } from '../../packages/core/analysis.js';

export const POLL_MS = 5 * 60 * 1000;

export function isWebhookUrl(value) {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && /\/api\/webhook\/[^/]+$/.test(u.pathname);
  } catch (_) {
    return false;
  }
}

/**
 * @param {object} deps
 * @param {{ get(key:string, fallback:any):any, set(key:string, value:any):void }} deps.store
 *   storage shared by every tab running the bridge
 * @param {() => Promise<{ issued:number, data:Uint8ClampedArray, w:number, h:number, png:() => Promise<string> }>} deps.fetchTracker
 * @param {() => Promise<string|null>} deps.fetchDescription
 * @param {(url:string, body:object) => Promise<{ status:number, json:any }>} deps.post
 * @param {() => number} [deps.now]
 * @param {string} [deps.source]
 * @param {(status:object) => void} [deps.onStatus]
 */
export function createBridge({ store, fetchTracker, fetchDescription, post, now = Date.now, source = 'bridge', onStatus = () => {} }) {
  let busy = false;
  let current = null; // { issued, analysis, description, png }
  let unsent = false;
  let status = { state: 'idle' };

  function set(next) {
    status = { ...next, at: now() };
    onStatus(status);
    return status;
  }

  async function look() {
    store.set('lastPollAt', now());
    const img = await fetchTracker();
    if (img.w !== IMAGE_W || img.h !== IMAGE_H) {
      // The georeference only holds for the known layout: say nothing rather than misplace storms.
      throw new Error(`the tracker image changed size (${img.w}×${img.h}); the bridge needs an update`);
    }
    const analysis = analyseImage(img.data, img.w, img.h);
    let description = current && current.description;
    if (!current || current.analysis.hash !== analysis.hash || !description) {
      try { description = await fetchDescription(); } catch (_) { /* keep the last one */ }
    }
    current = { issued: img.issued, analysis, description: description || null, png: img.png };
    unsent = true;
  }

  async function send(url) {
    const snapshot = async (withImage) => buildSnapshot({
      issued: current.issued,
      analysis: current.analysis,
      description: current.description,
      png: withImage ? await current.png() : null,
      source,
    });
    // Home Assistant already holds the picture for this storm drawing: send a heartbeat.
    const withImage = current.analysis.hash !== store.get('sentHash', null);
    let res = await post(url, await snapshot(withImage));
    if (res.status === 200 && res.json && res.json.need_image && !withImage) {
      res = await post(url, await snapshot(true)); // e.g. Home Assistant restarted and lost it
    }
    if (res.status !== 200) throw new Error(`Home Assistant answered ${res.status}`);
    store.set('sentHash', current.analysis.hash);
    unsent = false;
    set({ state: 'sent', issued: current.issued, cells: current.analysis.cells.length });
  }

  /** Call about once a minute. `manual` skips the wait between looks at the tracker. */
  async function tick(manual = false) {
    if (busy) return status;
    const url = store.get('webhookUrl', '');
    if (!isWebhookUrl(url)) return set({ state: 'setup' });
    busy = true;
    try {
      if (manual || now() - store.get('lastPollAt', 0) >= POLL_MS) await look();
      if (current && unsent) await send(url);
    } catch (err) {
      set({ state: 'error', error: String((err && err.message) || err) });
    } finally {
      busy = false;
    }
    return status;
  }

  return { tick, status: () => status };
}
