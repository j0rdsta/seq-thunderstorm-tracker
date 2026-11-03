// ==UserScript==
// @name         BoM SEQ Thunderstorm Tracker Overlay
// @namespace    https://github.com/j0rdsta/seq-thunderstorm-tracker
// @version      0.2.0
// @description  Overlays the Bureau of Meteorology's "Thunderstorm Tracker – Southeast Queensland Pilot" onto the interactive radar map on bom.gov.au, with auto-refresh.
// @author       j0rdsta
// @license      MIT
// @match        https://www.bom.gov.au/location/*
// @grant        none
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/j0rdsta/seq-thunderstorm-tracker
// @supportURL   https://github.com/j0rdsta/seq-thunderstorm-tracker/issues
// @updateURL    https://github.com/j0rdsta/seq-thunderstorm-tracker/raw/main/seq-thunderstorm-tracker.user.js
// @downloadURL  https://github.com/j0rdsta/seq-thunderstorm-tracker/raw/main/seq-thunderstorm-tracker.user.js
// ==/UserScript==

/* Not affiliated with or endorsed by the Bureau of Meteorology.
 * Tracker imagery © Commonwealth of Australia, Bureau of Meteorology; it is fetched live by your browser. */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Pure helpers (exported for Node tests)
  // ---------------------------------------------------------------------------

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
  function lonLatToMercator(lon, lat) {
    return [
      (lon * Math.PI / 180) * R,
      Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R,
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

  /** Inverse of an affine (mercator -> image pixel). */
  function invertAffine(m) {
    const det = m.a * m.d - m.b * m.c;
    return {
      a: m.d / det,
      b: -m.b / det,
      c: -m.c / det,
      d: m.a / det,
      e: (m.c * m.f - m.d * m.e) / det,
      f: (m.b * m.e - m.a * m.f) / det,
    };
  }

  /**
   * Compose image-px -> screen-px given a north-up view extent (mercator) and size in CSS px.
   * Returns params for CanvasRenderingContext2D.setTransform(a, b, c, d, e, f).
   */
  function imageToScreenTransform(g, extent, width, height) {
    const sx = width / (extent.xmax - extent.xmin);
    const sy = height / (extent.ymax - extent.ymin);
    return {
      a: g.a * sx,
      b: -g.b * sy,
      c: g.c * sx,
      d: -g.d * sy,
      e: (g.e - extent.xmin) * sx,
      f: (extent.ymax - g.f) * sy,
    };
  }

  /** Mercator bounding box of the image footprint. */
  function footprintBounds(g, w = IMAGE_W, h = IMAGE_H) {
    const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => applyAffine(g, x, y));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys) };
  }

  function intersects(a, b) {
    return a.xmin < b.xmax && a.xmax > b.xmin && a.ymin < b.ymax && a.ymax > b.ymin;
  }

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

  /** Is this pixel part of a storm cell's filled ellipse (current position)? */
  function isCellFill(r, g, b) {
    const [h, s] = rgbToHs(r, g, b);
    return h >= 18 && h <= 38 && s >= 0.3 && s <= 0.55 && r >= 200;
  }

  /** Count filled storm cells (connected components above minPixels). Operates on the ORIGINAL pixels. */
  function countCells(data, w, h, minPixels = 40) {
    const mask = new Uint8Array(w * h);
    for (let i = 0, p = 0; p < w * h; i += 4, p++) {
      if (data[i + 3] && isCellFill(data[i], data[i + 1], data[i + 2])) mask[p] = 1;
    }
    let count = 0;
    const stack = [];
    for (let p = 0; p < w * h; p++) {
      if (mask[p] !== 1) continue;
      mask[p] = 2;
      stack.push(p);
      let size = 0;
      while (stack.length) {
        const q = stack.pop();
        size++;
        const x = q % w;
        const y = (q - x) / w;
        if (x > 0 && mask[q - 1] === 1) { mask[q - 1] = 2; stack.push(q - 1); }
        if (x < w - 1 && mask[q + 1] === 1) { mask[q + 1] = 2; stack.push(q + 1); }
        if (y > 0 && mask[q - w] === 1) { mask[q - w] = 2; stack.push(q - w); }
        if (y < h - 1 && mask[q + w] === 1) { mask[q + w] = 2; stack.push(q + w); }
      }
      if (size >= minPixels) count++;
    }
    return count;
  }

  /** Duck-type check for an ArcGIS JS 4.x MapView. */
  function looksLikeMapView(v) {
    try {
      return !!v && typeof v === 'object' && !!v.extent && typeof v.zoom === 'number' &&
        typeof v.toScreen === 'function' && 'container' in v;
    } catch (_) {
      return false;
    }
  }

  /** Walk React fibers upward from a DOM element looking for a MapView in hooks/props. */
  function findMapViewFromElement(el, maxDomDepth = 12, maxFiberDepth = 80) {
    for (let d = 0; el && d < maxDomDepth; d++, el = el.parentElement) {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
      if (!key) continue;
      let fiber = el[key];
      for (let i = 0; fiber && i < maxFiberDepth; i++, fiber = fiber.return) {
        let hook = fiber.memoizedState;
        for (let j = 0; hook && typeof hook === 'object' && j < 60; j++, hook = hook.next) {
          const ms = hook.memoizedState;
          if (looksLikeMapView(ms)) return ms;
          if (ms && typeof ms === 'object' && looksLikeMapView(ms.current)) return ms.current;
        }
        const props = fiber.memoizedProps;
        if (props && typeof props === 'object') {
          for (const k in props) if (looksLikeMapView(props[k])) return props[k];
        }
        if (fiber.stateNode && looksLikeMapView(fiber.stateNode.view)) return fiber.stateNode.view;
      }
      return null; // only need the nearest React-managed ancestor
    }
    return null;
  }

  /**
   * Current north-up extent of a MapView, derived from center + resolution + size.
   * (view.extent can lag behind the rendered state, e.g. in background tabs; center/resolution
   * are what toScreen()/toMap() use.) Falls back to view.extent.
   */
  function viewExtent(view, width, height) {
    const c = view.center;
    const res = view.resolution;
    if (c && typeof c.x === 'number' && typeof res === 'number' && res > 0 && width && height) {
      const hw = (width / 2) * res;
      const hh = (height / 2) * res;
      return { xmin: c.x - hw, xmax: c.x + hw, ymin: c.y - hh, ymax: c.y + hh, spatialReference: c.spatialReference };
    }
    const e = view.extent;
    return e ? { xmin: e.xmin, xmax: e.xmax, ymin: e.ymin, ymax: e.ymax, spatialReference: e.spatialReference } : null;
  }

  function formatAge(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const h = Math.floor(mins / 60);
    return `${h} h ${mins % 60} min ago`;
  }

  /** Format like BoM's own labels: "12:26pm AEST" (Queensland time, no daylight saving). */
  function formatIssued(date) {
    const t = date.toLocaleTimeString('en-AU', {
      timeZone: 'Australia/Brisbane', hour: 'numeric', minute: '2-digit', hour12: true,
    });
    return `${t.replace(/\s+/g, '').toLowerCase()} AEST`;
  }

  const TZ_OFFSETS_MIN = { AEST: 600, AEDT: 660, ACST: 570, ACDT: 630, AWST: 480 };
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  /**
   * Parse the radar timeline label, e.g. "Tuesday 3 Nov,  12:20pm AEST", into a Date.
   * The year isn't shown, so pick the one that puts the date closest to `now`.
   */
  function parseTimelineLabel(text, now = new Date()) {
    const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{1,2}):(\d{2})\s*(am|pm)\s+(AEST|AEDT|ACST|ACDT|AWST)/i.exec(text || '');
    if (!m) return null;
    const month = MONTHS.indexOf(m[2].toLowerCase());
    if (month < 0) return null;
    let hour = +m[3] % 12;
    if (m[5].toLowerCase() === 'pm') hour += 12;
    const offset = TZ_OFFSETS_MIN[m[6].toUpperCase()];
    let best = null;
    for (const y of [now.getUTCFullYear() - 1, now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
      const d = new Date(Date.UTC(y, month, +m[1], hour, +m[4]) - offset * 60000);
      if (!best || Math.abs(d - now) < Math.abs(best - now)) best = d;
    }
    return best;
  }

  /** Does a radar frame time match the tracker issue time closely enough to overlay it? */
  function frameMatchesTracker(frame, issued, toleranceMs = 15 * 60000) {
    if (!frame || !issued) return true; // unknown → don't hide
    return Math.abs(frame.getTime() - issued.getTime()) <= toleranceMs;
  }

  const core = {
    IMAGE_URL, TRACKER_PAGE, IMAGE_W, IMAGE_H, CORNERS,
    lonLatToMercator, imageToMercatorAffine, applyAffine, invertAffine, imageToScreenTransform,
    footprintBounds, intersects, rgbToHs, stormAlpha, chromaKey, isCellFill, countCells,
    looksLikeMapView, findMapViewFromElement, viewExtent, formatAge, formatIssued,
    parseTimelineLabel, frameMatchesTracker,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
    return;
  }

  // ---------------------------------------------------------------------------
  // Browser runtime
  // ---------------------------------------------------------------------------

  const STORE_KEY = 'seqThunderstormTracker.v1';
  const DEFAULTS = {
    enabled: true,
    opacity: 0.85,
    intervalSec: 60,
    colour: 'original',
    showFootprint: false,
    onlyLatest: true, // hide while the radar loop is paused on a past/forecast frame
    nudge: { dx: 0, dy: 0 },
  };
  const STALE_MS = 20 * 60 * 1000;
  const MIN_REQUEST_GAP_MS = 30 * 1000;
  const FETCH_TIMEOUT_MS = 20 * 1000;

  const settings = loadSettings();
  function loadSettings() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (_) { /* ignore */ }
  }

  const state = {
    bitmap: null, // keyed canvas
    rawData: null, // ImageData of original image (for re-keying on colour change)
    etag: null,
    issued: null,
    cells: null,
    fetchedAt: null,
    error: null,
    timer: null,
    inflight: false,
    lastRequestAt: 0,
    badSize: null,
  };

  /** @type {Map<object, Attachment>} */
  const attachments = new Map();

  function geo() {
    return imageToMercatorAffine(CORNERS, IMAGE_W, IMAGE_H, settings.nudge);
  }

  // ----- fetching -----------------------------------------------------------

  /**
   * Fetch the tracker image if it changed. Uses the stable URL with HTTP revalidation
   * (cache: 'no-cache' → conditional request, 304 from BoM's CDN when unchanged).
   * Automatic refreshes are rate-limited to one request per MIN_REQUEST_GAP_MS;
   * a manual refresh (manual = true) bypasses the gap but not an in-flight request.
   */
  async function refresh(manual = false) {
    if (state.inflight) return;
    if (!manual && state.lastRequestAt && Date.now() - state.lastRequestAt < MIN_REQUEST_GAP_MS) return;
    state.inflight = true;
    state.lastRequestAt = Date.now();
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(IMAGE_URL, { cache: 'no-cache', signal: ctrl.signal });
      state.fetchedAt = new Date();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const etag = res.headers.get('etag');
      const lm = res.headers.get('last-modified');
      if (etag && etag === state.etag && (state.bitmap || state.badSize)) {
        state.error = null;
        return;
      }
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      if (bmp.width !== IMAGE_W || bmp.height !== IMAGE_H) {
        // The georeference only holds for the known image layout; don't draw misplaced storms.
        state.etag = etag;
        state.bitmap = null;
        state.rawData = null;
        state.cells = null;
        state.badSize = `${bmp.width}×${bmp.height}`;
        throw new Error(`tracker image changed size (${state.badSize}); overlay disabled until the script is updated`);
      }
      state.badSize = null;
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      state.rawData = ctx.getImageData(0, 0, c.width, c.height);
      state.etag = etag;
      state.issued = lm ? new Date(lm) : null;
      state.cells = countCells(state.rawData.data, c.width, c.height);
      rekey();
      state.error = null;
    } catch (err) {
      state.error = err && err.name === 'AbortError' ? 'request timed out' : String(err && err.message || err);
      console.warn('[SEQ tracker] refresh failed:', err);
    } finally {
      clearTimeout(timeout);
      state.inflight = false;
      updateAll(true);
    }
  }

  function rekey() {
    if (!state.rawData) return;
    const copy = new ImageData(new Uint8ClampedArray(state.rawData.data), state.rawData.width, state.rawData.height);
    chromaKey(copy.data, settings.colour);
    const c = document.createElement('canvas');
    c.width = copy.width;
    c.height = copy.height;
    c.getContext('2d').putImageData(copy, 0, 0);
    state.bitmap = c;
  }

  function schedule() {
    clearInterval(state.timer);
    state.timer = null;
    if (!settings.enabled || document.hidden || attachments.size === 0) return;
    state.timer = setInterval(() => refresh(), Math.max(30, settings.intervalSec) * 1000);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && settings.enabled && attachments.size &&
        Date.now() - state.lastRequestAt >= settings.intervalSec * 1000) refresh();
    schedule();
  });

  // ----- per-view attachment -------------------------------------------------

  class Attachment {
    constructor(view) {
      this.view = view;
      this.container = view.container;
      this.last = '';
      this.raf = 0;

      this.canvas = document.createElement('canvas');
      this.canvas.className = 'seq-ts-overlay';
      Object.assign(this.canvas.style, {
        position: 'absolute', inset: '0', width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: '1',
      });
      const surface = this.container.querySelector('.esri-view-surface');
      if (surface && surface.parentElement) surface.parentElement.insertBefore(this.canvas, surface.nextSibling);
      else this.container.appendChild(this.canvas);

      this.section = this.container.closest('.bom-spatial-map') || this.container.parentElement;
      this.status = buildStatusLine(this);
      this.placeStatus();
      this.frameHidden = false;

      this.loop = this.loop.bind(this);
      this.raf = requestAnimationFrame(this.loop);
    }

    alive() {
      return this.container && this.container.isConnected && !this.view.destroyed &&
        this.view.container === this.container;
    }

    loop() {
      if (!this.alive()) { this.destroy(); return; }
      const v = this.view;
      const c = v.center;
      if (!this.status.root.isConnected) this.placeStatus();
      if (c) {
        const key = `${c.x}|${c.y}|${v.resolution}|${v.width}|${v.height}|${v.rotation}|${this.timelineText()}|${this.timelinePlaying()}`;
        if (key !== this.last) {
          this.last = key;
          this.draw();
        }
      }
      this.raf = requestAnimationFrame(this.loop);
    }

    /** Put the status line directly under the radar timeline (or under the map as a fallback). */
    placeStatus() {
      const scrub = this.section && this.section.querySelector('.bom-scrub');
      const anchor = scrub || this.container;
      if (anchor.parentElement) anchor.insertAdjacentElement('afterend', this.status.root);
    }

    timelineText() {
      const label = this.section && this.section.querySelector('.bom-scrub-display-label');
      return label ? label.textContent : '';
    }

    /** BoM's play/pause button reads "Pause" while the radar loop is animating. */
    timelinePlaying() {
      const btn = this.section && this.section.querySelector('.bom-scrub-action__label');
      return !!btn && /pause/i.test(btn.textContent);
    }

    draw() {
      const v = this.view;
      const w = v.width || this.container.clientWidth;
      const h = v.height || this.container.clientHeight;
      const e = viewExtent(v, w, h);
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.round(w * dpr);
      const ch = Math.round(h * dpr);
      if (this.canvas.width !== cw || this.canvas.height !== ch) {
        this.canvas.width = cw;
        this.canvas.height = ch;
      }
      const ctx = this.canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      // The center/resolution box is only exact for north-up views; don't cull rotated ones.
      this.inCoverage = !!e && (!!v.rotation || intersects(footprintBounds(geo()), e));
      this.frameTime = parseTimelineLabel(this.timelineText());
      // While the loop plays, keep the overlay steady rather than blinking on the newest frame only.
      this.frameHidden = settings.onlyLatest && !this.timelinePlaying() && !!state.issued &&
        !frameMatchesTracker(this.frameTime, state.issued);
      this.status.update();
      if (!settings.enabled || !e || !this.inCoverage || this.frameHidden) return;
      if (e.spatialReference && e.spatialReference.wkid && ![102100, 3857, 900913].includes(e.spatialReference.wkid)) return;

      const g = geo();
      let t;
      if (v.rotation) {
        // Rotated view: map 3 image corners through the view's own projection.
        const p = (x, y) => {
          const [X, Y] = applyAffine(g, x, y);
          return v.toScreen({ x: X, y: Y, spatialReference: e.spatialReference, type: 'point' });
        };
        const o = p(0, 0); const r = p(IMAGE_W, 0); const b = p(0, IMAGE_H);
        if (!o || !r || !b) return;
        t = { a: (r.x - o.x) / IMAGE_W, b: (r.y - o.y) / IMAGE_W, c: (b.x - o.x) / IMAGE_H, d: (b.y - o.y) / IMAGE_H, e: o.x, f: o.y };
      } else {
        t = imageToScreenTransform(g, e, w, h);
      }
      ctx.setTransform(t.a * dpr, t.b * dpr, t.c * dpr, t.d * dpr, t.e * dpr, t.f * dpr);
      ctx.imageSmoothingEnabled = true;
      if (state.bitmap) {
        ctx.globalAlpha = settings.opacity;
        ctx.drawImage(state.bitmap, 0, 0);
        ctx.globalAlpha = 1;
      }
      if (settings.showFootprint) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.beginPath();
        const corner = (x, y) => [(t.a * x + t.c * y + t.e) * dpr, (t.b * x + t.d * y + t.f) * dpr];
        const pts = [corner(0, 0), corner(IMAGE_W, 0), corner(IMAGE_W, IMAGE_H), corner(0, IMAGE_H)];
        ctx.moveTo(...pts[0]);
        pts.slice(1).forEach((pt) => ctx.lineTo(...pt));
        ctx.closePath();
        ctx.setLineDash([6 * dpr, 4 * dpr]);
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeStyle = 'rgba(204,120,51,0.9)';
        ctx.stroke();
        ctx.restore();
      }
    }

    destroy() {
      cancelAnimationFrame(this.raf);
      this.canvas.remove();
      this.status.root.remove();
      attachments.delete(this.view);
      schedule();
    }
  }

  // ----- UI (reuses bom.gov.au markup and classes) ---------------------------

  const CSS = `
  .seq-ts-status{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:2px 12px;
    padding:6px 0 0;font-family:Inter,Inter-fallback,sans-serif;font-size:12px;line-height:16px;color:#4a4a4a}
  .seq-ts-status__swatch{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;
    vertical-align:-1px;background:#f5bd8a;box-shadow:inset 0 0 0 1.5px #cc7833}
  .seq-ts-status__text--warn{color:#b3261e}
  .seq-ts-linkbtn{all:unset;cursor:pointer;text-decoration:underline;text-underline-offset:2px;color:inherit}
  .seq-ts-linkbtn:hover{text-decoration-thickness:2px}
  .seq-ts-linkbtn:focus-visible{outline:2px solid currentColor;outline-offset:2px;border-radius:2px}
  .seq-ts-fieldset{margin-top:24px}
  .seq-ts-group{margin:12px 0 0}
  .seq-ts-group__label{margin:0 0 4px}
  .seq-ts-radios{display:flex;flex-wrap:wrap;gap:0 20px}
  .seq-ts-nudge{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
  .seq-ts-fieldset .overlay-description a{color:inherit}
  `;

  function ensureStyles() {
    if (document.getElementById('seq-ts-style')) return;
    const s = document.createElement('style');
    s.id = 'seq-ts-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    children.forEach((c) => c && n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  }

  function openMoreWeather() {
    const btn = document.getElementById('bom-tab-more-weather') || document.querySelector('[data-testid="more-weather"]');
    if (btn) btn.click();
  }

  /** Status line under the radar timeline, styled like BoM's timeline label. */
  function buildStatusLine(att) {
    ensureStyles();
    const text = el('span', { 'aria-live': 'polite' });
    const refreshBtn = el('button', { type: 'button', class: 'seq-ts-linkbtn', text: 'Refresh', onclick: () => refresh(true) });
    const toggleBtn = el('button', { type: 'button', class: 'seq-ts-linkbtn', onclick: () => setEnabled(!settings.enabled) });
    const settingsBtn = el('button', { type: 'button', class: 'seq-ts-linkbtn', text: 'Settings', onclick: openMoreWeather });
    const root = el('div', { class: 'seq-ts-status', 'data-seq-ts': '' }, [
      el('span', {}, [el('span', { class: 'seq-ts-status__swatch', 'aria-hidden': 'true' }), text]),
      refreshBtn, toggleBtn, settingsBtn,
    ]);

    function update() {
      let msg;
      let warn = false;
      if (!settings.enabled) msg = 'Thunderstorm tracker off';
      else if (state.error && !state.bitmap) { msg = `Thunderstorm tracker unavailable (${state.error})`; warn = true; }
      else if (!state.bitmap) msg = 'Thunderstorm tracker loading…';
      else {
        const parts = [];
        if (state.issued) {
          const age = Date.now() - state.issued.getTime();
          parts.push(`Thunderstorm tracker ${formatIssued(state.issued)} (${formatAge(age)})`);
          if (age > STALE_MS) { parts.push('not recently updated'); warn = true; }
        } else parts.push('Thunderstorm tracker');
        if (att.inCoverage === false) parts.push('outside Southeast Queensland');
        else if (att.frameHidden) parts.push('hidden for this earlier radar time');
        else parts.push(state.cells === 0 ? 'no tracked storms' : `${state.cells} storm cell${state.cells === 1 ? '' : 's'}`);
        if (state.error) { parts.push('refresh failed'); warn = true; }
        msg = parts.join(' · ');
      }
      text.textContent = msg;
      text.className = warn ? 'seq-ts-status__text--warn' : '';
      text.title = state.fetchedAt ? `Last checked ${formatIssued(state.fetchedAt)}` : '';
      toggleBtn.textContent = settings.enabled ? 'Hide' : 'Show';
      toggleBtn.setAttribute('aria-label', settings.enabled ? 'Hide thunderstorm tracker' : 'Show thunderstorm tracker');
      refreshBtn.hidden = !settings.enabled;
    }

    update();
    return { root, update };
  }

  // ----- "More weather" modal section -----------------------------------------

  let modalUpdate = null;

  /** Clone one of BoM's own checkboxes so icons and styling match exactly. */
  function makeCheckbox(id, label, checked, onChange) {
    const tpl = document.querySelector('.more-weather .bom-form-checkbox');
    let wrap;
    if (tpl) {
      wrap = tpl.cloneNode(true);
      wrap.querySelectorAll('[id],[for],[data-testid]').forEach((n) => {
        n.removeAttribute('data-testid');
      });
    } else {
      wrap = el('div', { class: 'bom-form-checkbox show-checkbox' }, [
        el('input', { class: 'bom-form-checkbox__input', type: 'checkbox' }),
        el('label', { class: 'bom-form-checkbox__label' }, [el('span', { class: 'bom-form-checkbox__label-text' })]),
      ]);
    }
    const input = wrap.querySelector('input');
    const lab = wrap.querySelector('label');
    input.id = id;
    input.removeAttribute('name');
    input.removeAttribute('data-value');
    input.checked = checked;
    lab.setAttribute('for', id);
    const t = wrap.querySelector('.bom-form-checkbox__label-text') || lab;
    t.textContent = label;
    input.addEventListener('change', () => onChange(input.checked));
    return { wrap, input };
  }

  function makeRadioGroup(name, label, options, current, onChange) {
    const inputs = [];
    const radios = el('div', { class: 'seq-ts-radios', role: 'radiogroup', 'aria-label': label },
      options.map(([value, text]) => {
        const input = el('input', { type: 'radio', name, value: String(value) });
        input.checked = String(value) === String(current);
        input.addEventListener('change', () => input.checked && onChange(value));
        inputs.push(input);
        return el('label', { class: 'bom-form-radio' }, [input, text]);
      }));
    const group = el('div', { class: 'seq-ts-group' }, [
      el('p', { class: 'seq-ts-group__label bom-typo bom-typo--s-caption bom-typo--responsive', text: label }),
      radios,
    ]);
    return { group, set: (v) => inputs.forEach((i) => { i.checked = i.value === String(v); }) };
  }

  function tertiaryButton(text, aria, onclick) {
    return el('button', { type: 'button', class: 'bom-button bom-button--tertiary bom-button--condensed', 'aria-label': aria, onclick }, [
      el('span', { class: 'bom-button__label', text }),
    ]);
  }

  function enhanceModal() {
    const host = document.querySelector('.more-weather .more-weather__overlays') ||
      document.querySelector('.more-weather .more-weather__right-panel__inner');
    if (!host || host.querySelector('.seq-ts-fieldset')) return;
    ensureStyles();

    const show = makeCheckbox('seq-ts-enabled', 'Thunderstorm tracker', settings.enabled, (v) => setEnabled(v));
    const latest = makeCheckbox('seq-ts-latest', 'Hide when paused on an earlier radar time', settings.onlyLatest, (v) => {
      settings.onlyLatest = v; saveSettings(); updateAll(true);
    });
    const area = makeCheckbox('seq-ts-area', 'Show tracker coverage area', settings.showFootprint, (v) => {
      settings.showFootprint = v; saveSettings(); updateAll(true);
    });
    const opacity = makeRadioGroup('seq-ts-opacity', 'Overlay opacity',
      [[0.5, '50%'], [0.85, '85%'], [1, '100%']], settings.opacity, (v) => {
        settings.opacity = +v; saveSettings(); updateAll(true);
      });
    const colour = makeRadioGroup('seq-ts-colour', 'Storm colour',
      [['original', 'Orange'], ['magenta', 'Magenta'], ['black', 'Black']], settings.colour, (v) => {
        settings.colour = v; saveSettings(); rekey(); updateAll(true);
      });
    const interval = makeRadioGroup('seq-ts-interval', 'Check for updates every',
      [[60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min']], settings.intervalSec, (v) => {
        settings.intervalSec = +v; saveSettings(); schedule();
      });

    const STEP = 500; // metres
    const nudgeOut = el('span', { class: 'bom-typo bom-typo--s-caption' });
    const nudge = (dx, dy) => () => {
      settings.nudge = dx === null ? { dx: 0, dy: 0 } : { dx: settings.nudge.dx + dx, dy: settings.nudge.dy + dy };
      saveSettings(); updateAll(true);
    };
    const nudgeGroup = el('div', { class: 'seq-ts-group' }, [
      el('p', { class: 'seq-ts-group__label bom-typo bom-typo--s-caption bom-typo--responsive', text: 'Adjust alignment (0.5 km steps)' }),
      el('div', { class: 'seq-ts-nudge' }, [
        tertiaryButton('←', 'Move overlay west', nudge(-STEP, 0)),
        tertiaryButton('→', 'Move overlay east', nudge(STEP, 0)),
        tertiaryButton('↑', 'Move overlay north', nudge(0, STEP)),
        tertiaryButton('↓', 'Move overlay south', nudge(0, -STEP)),
        tertiaryButton('Reset', 'Reset overlay alignment', nudge(null, null)),
        nudgeOut,
      ]),
    ]);

    const fieldset = el('fieldset', { class: 'seq-ts-fieldset', 'data-seq-ts': '' }, [
      el('legend', {}, [el('h3', { class: 'bom-typo bom-typo--s-heading-xs bom-typo--responsive', text: 'Thunderstorm tracker (SEQ pilot)' })]),
      show.wrap, latest.wrap, area.wrap,
      opacity.group, colour.group, interval.group, nudgeGroup,
      el('div', { class: 'overlay-description bom-typo bom-typo--s-caption bom-typo--responsive' }, [
        'Estimated storm positions in 10, 20 and 30 minutes, from the ',
        el('a', { href: TRACKER_PAGE, target: '_blank', rel: 'noopener', text: 'Thunderstorm Tracker' }),
        '. Southeast Queensland only. Added by an unofficial browser script, not the Bureau.',
      ]),
    ]);
    // Keep the host React app from seeing events on nodes it doesn't own.
    ['click', 'change', 'input'].forEach((t) => fieldset.addEventListener(t, (ev) => ev.stopPropagation()));
    host.appendChild(fieldset);

    modalUpdate = () => {
      if (!fieldset.isConnected) { modalUpdate = null; return; }
      show.input.checked = settings.enabled;
      latest.input.checked = settings.onlyLatest;
      area.input.checked = settings.showFootprint;
      opacity.set(settings.opacity);
      colour.set(settings.colour);
      interval.set(settings.intervalSec);
      const { dx, dy } = settings.nudge;
      nudgeOut.textContent = dx || dy ? `${(dx / 1000).toFixed(1)} km E, ${(dy / 1000).toFixed(1)} km N` : '';
    };
    modalUpdate();
  }

  function updateAll(redraw) {
    for (const att of attachments.values()) {
      if (redraw) { att.last = ''; att.draw(); }
      att.status.update();
    }
    if (modalUpdate) modalUpdate();
  }

  function setEnabled(on) {
    settings.enabled = on;
    saveSettings();
    if (on) refresh();
    schedule();
    updateAll(true);
  }

  // ----- discovery --------------------------------------------------------------

  function scan() {
    document.querySelectorAll('.esri-view').forEach((node) => {
      if (node.__seqTsView && attachments.has(node.__seqTsView)) return;
      if (node.__seqTsChecked && node.__seqTsChecked > Date.now() - 2000) return;
      node.__seqTsChecked = Date.now();
      const view = findMapViewFromElement(node);
      if (!view || !view.container || !view.extent) return;
      node.__seqTsView = view;
      if (attachments.has(view)) return;
      attachments.set(view, new Attachment(view));
      if (!state.bitmap && settings.enabled) refresh();
      schedule();
      updateAll(false);
    });
  }

  let scanQueued = false;
  const mo = new MutationObserver(() => {
    if (attachments.size && document.querySelector('.more-weather')) enhanceModal();
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; scan(); }, 250);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  // The MapView finishes initialising a little after its DOM appears; poll briefly as a backstop.
  setInterval(scan, 3000);
  scan();

  // Refresh the "x min ago" text.
  setInterval(() => updateAll(false), 30000);

  document.addEventListener('keydown', (ev) => {
    if (!ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey || ev.key !== 'T') return;
    const t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!attachments.size) return;
    setEnabled(!settings.enabled);
  });

  // Small debug handle for troubleshooting from DevTools.
  window.__seqThunderstormTracker = { core, settings, state, attachments, refresh };
})();
