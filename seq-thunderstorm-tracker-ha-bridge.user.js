// ==UserScript==
// @name         BoM SEQ Thunderstorm Tracker: Home Assistant bridge
// @namespace    https://github.com/j0rdsta/seq-thunderstorm-tracker
// @version      0.6.0
// @description  Sends storm positions from the Bureau of Meteorology's Thunderstorm Tracker (Southeast Queensland pilot) to your own Home Assistant, from your browser, while a bom.gov.au tab is open.
// @author       Jordan Gardiner
// @license      MIT
// @match        https://www.bom.gov.au/location/*
// @match        https://www.bom.gov.au/qld/forecasts/brisbane-thunderstorms.shtml
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/j0rdsta/seq-thunderstorm-tracker
// @supportURL   https://github.com/j0rdsta/seq-thunderstorm-tracker/issues
// @updateURL    https://github.com/j0rdsta/seq-thunderstorm-tracker/raw/main/seq-thunderstorm-tracker-ha-bridge.user.js
// @downloadURL  https://github.com/j0rdsta/seq-thunderstorm-tracker/raw/main/seq-thunderstorm-tracker-ha-bridge.user.js
// ==/UserScript==

/* Not affiliated with or endorsed by the Bureau of Meteorology.
 * Tracker imagery © Commonwealth of Australia, Bureau of Meteorology. This script sends it only to
 * the Home Assistant address you give it. `@connect *` is there because that address is yours to
 * choose: your userscript manager asks before the first request to it. */

(function () {
  'use strict';

  /** Where the tracker image sits on the Earth: constants, Web Mercator and the affine georeference. */

  const IMAGE_URL = 'https://www.bom.gov.au/fwo/IDA00050.png';
  const TRACKER_PAGE = 'https://www.bom.gov.au/qld/forecasts/brisbane-thunderstorms.shtml';
  const IMAGE_W = 600;
  const IMAGE_H = 643;

  /**
   * Georeference of IDA00050.png in Web Mercator (EPSG:3857) metres.
   * Derived by least-squares affine fit of 13 town markers on the image
   * (see README "How the overlay is aligned"). Corner = image pixel corner.
   */
  const CORNERS = {
    tl: [16852901.89, -3018857.35], // pixel (0, 0)
    tr: [17134364.43, -3020336.98], // pixel (IMAGE_W, 0)
    bl: [16852265.34, -3301850.42], // pixel (0, IMAGE_H)
  };

  const R = 6378137;

  function mercatorToLonLat(x, y) {
    return [
      (x / R) * 180 / Math.PI,
      (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI,
    ];
  }

  /** Affine image-pixel -> mercator: X = a*px + c*py + e ; Y = b*px + d*py + f */
  function imageToMercatorAffine(corners = CORNERS, w = IMAGE_W, h = IMAGE_H, nudge = { dx: 0, dy: 0 }) {
    const [tlx, tly] = corners.tl;
    return {
      a: (corners.tr[0] - tlx) / w,
      b: (corners.tr[1] - tly) / w,
      c: (corners.bl[0] - tlx) / h,
      d: (corners.bl[1] - tly) / h,
      e: tlx + (nudge.dx || 0),
      f: tly + (nudge.dy || 0),
    };
  }

  function applyAffine(m, x, y) {
    return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  }

  /** Times the way BoM writes them, and matching tracker images to radar frames. */


  /** Format like BoM's "Last updated" lines: "12:26 pm AEST" (Queensland time, no daylight saving). */
  function formatIssued(date) {
    const t = date.toLocaleTimeString('en-AU', {
      timeZone: 'Australia/Brisbane', hour: 'numeric', minute: '2-digit', hour12: true,
    });
    return `${t.replace(/\s+/g, ' ').toLowerCase()} AEST`;
  }

  /** Relative age in BoM's wording: "9 minutes ago", "2 hours ago". */
  function formatAgeLong(ms) {
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'less than a minute ago';
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const h = Math.floor(mins / 60);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }

  /** Telling storms from basemap: the chroma key, the storm fingerprint and cell detection. */

  function rgbToHs(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const s = max === 0 ? 0 : delta / max;
    let h = 0;
    if (delta !== 0) {
      if (max === r) h = 60 * (((g - b) / delta) % 6);
      else if (max === g) h = 60 * ((b - r) / delta + 2);
      else h = 60 * ((r - g) / delta + 4);
    }
    if (h < 0) h += 360;
    return [h, s];
  }

  /**
   * Storm-feature alpha (0..1) for a tracker pixel. The tracker draws storms in orange
   * (fill ≈ 245,189,138; lines ≈ 204,120,51) on a desaturated tan/blue basemap, so we key on
   * orange hue + saturation. Fill ends up semi-transparent, lines opaque.
   */
  function stormAlpha(r, g, b) {
    const [h, s] = rgbToHs(r, g, b);
    if (h < 8 || h > 42) return 0;
    if (s < 0.2) return 0;
    if (r < 120) return 0;
    return Math.min(1, (s - 0.2) / 0.4);
  }

  const COLOUR_MODES = {
    original: null,
    magenta: [214, 0, 170],
    black: [20, 20, 20],
  };

  /** Chroma-key RGBA pixel buffer in place. Returns number of storm pixels. */
  function chromaKey(data, mode = 'original') {
    const tint = COLOUR_MODES[mode] || null;
    let kept = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] === 0 ? 0 : stormAlpha(data[i], data[i + 1], data[i + 2]);
      if (a === 0) {
        data[i + 3] = 0;
        continue;
      }
      kept++;
      if (tint) {
        data[i] = tint[0];
        data[i + 1] = tint[1];
        data[i + 2] = tint[2];
      }
      data[i + 3] = Math.round(a * 255);
    }
    return kept;
  }

  /**
   * Fingerprint of the storm drawing in a chroma-keyed RGBA buffer (FNV-1a over which pixels are
   * storm pixels). BoM re-renders the image every minute with a new "Issued at" stamp, but the
   * storms only change with each new radar scan (~5 min); this tells those apart.
   */
  function stormHash(keyed) {
    let h = 0x811c9dc5;
    for (let i = 3, p = 0; i < keyed.length; i += 4, p++) {
      if (keyed[i]) {
        h ^= p & 0xff; h = Math.imul(h, 0x01000193);
        h ^= p >>> 8; h = Math.imul(h, 0x01000193);
      }
    }
    return (h >>> 0).toString(16);
  }

  /** Is this pixel part of a storm cell's filled ellipse (current position)? */
  function isCellFill(r, g, b) {
    const [h, s] = rgbToHs(r, g, b);
    return h >= 18 && h <= 38 && s >= 0.3 && s <= 0.55 && r >= 200;
  }

  /**
   * Find filled storm cells (current positions) as connected components of the fill colour.
   * Operates on the ORIGINAL pixels. Returns [{ x, y, area, vxx, vyy, vxy }]: centroid and area in
   * image px, plus the spread of the cell's pixels about its centroid (variances and covariance,
   * px²), which is enough to recover the drawn ellipse (see cellEllipse in analysis.js).
   */
  function findCells(data, w, h, minPixels = 40) {
    const mask = new Uint8Array(w * h);
    for (let i = 0, p = 0; p < w * h; i += 4, p++) {
      if (data[i + 3] && isCellFill(data[i], data[i + 1], data[i + 2])) mask[p] = 1;
    }
    const cells = [];
    const stack = [];
    for (let p = 0; p < w * h; p++) {
      if (mask[p] !== 1) continue;
      mask[p] = 2;
      stack.push(p);
      let size = 0;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      while (stack.length) {
        const q = stack.pop();
        const x = q % w;
        const y = (q - x) / w;
        size++; sx += x; sy += y;
        sxx += x * x; syy += y * y; sxy += x * y;
        if (x > 0 && mask[q - 1] === 1) { mask[q - 1] = 2; stack.push(q - 1); }
        if (x < w - 1 && mask[q + 1] === 1) { mask[q + 1] = 2; stack.push(q + 1); }
        if (y > 0 && mask[q - w] === 1) { mask[q - w] = 2; stack.push(q - w); }
        if (y < h - 1 && mask[q + w] === 1) { mask[q + w] = 2; stack.push(q + w); }
      }
      if (size >= minPixels) {
        const x = sx / size;
        const y = sy / size;
        cells.push({ x, y, area: size, vxx: sxx / size - x * x, vyy: syy / size - y * y, vxy: sxy / size - x * y });
      }
    }
    return cells;
  }

  /**
   * Turning a tracker image into numbers: where each storm is on the ground, how big it is, and
   * where the Bureau's arrows and arcs say it is heading. Home Assistant measures distances from
   * this, so everything here comes from the Bureau's own drawing and nothing is extrapolated.
   */


  const SNAPSHOT_VERSION = 1;
  /** Forecast-track pixels are thinned to one point per FORECAST_GRID_PX square (about 2.5 km). */
  const FORECAST_GRID_PX = 6;

  const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

  function pixelToLonLat(g, px, py) {
    const [X, Y] = applyAffine(g, px, py);
    return mercatorToLonLat(X, Y);
  }

  /**
   * The drawn ellipse of a cell, on the ground. The image's pixels are not square on the ground
   * (about 0.42 km wide by 0.39 km tall near Brisbane), so the pixel spread is first carried into
   * east/north kilometres through the georeference, then split into its two axes.
   * @returns {{ major_km:number, minor_km:number, bearing:number, area_km2:number }} semi-axes,
   *   and the major axis as a compass bearing in [0, 180)
   */
  function cellEllipse(cell, g, lat) {
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
  function analyseImage(data, w = IMAGE_W, h = IMAGE_H, g = imageToMercatorAffine()) {
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
  function buildSnapshot({ issued, analysis, description = null, png = null, source = 'unknown' }) {
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

  /**
   * What the bridge does, with the browser kept at arm's length so it can be tested in Node:
   * every POLL_MS it looks at the tracker image, works out where the storms are and posts a
   * snapshot to a Home Assistant webhook.
   *
   * Being gentle with the Bureau: one conditional image request per POLL_MS across every open
   * tab (the time of the last look is kept in shared storage), and the description page is only
   * fetched when the storms have changed.
   */


  const POLL_MS = 5 * 60 * 1000;

  function isWebhookUrl(value) {
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
  function createBridge({ store, fetchTracker, fetchDescription, post, now = Date.now, source = 'bridge', onStatus = () => {} }) {
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

  /**
   * The Home Assistant bridge userscript. Built to ../../seq-thunderstorm-tracker-ha-bridge.user.js.
   *
   * Home Assistant cannot fetch the tracker itself: the Bureau turns away anything that is not a
   * browser. This script runs in your browser on a bom.gov.au tab instead, reads the same image
   * the page shows, and posts where the storms are to your Home Assistant.
   */


  const VERSION = '0.6.0';
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

})();
