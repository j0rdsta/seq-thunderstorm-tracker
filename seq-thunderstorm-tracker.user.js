// ==UserScript==
// @name         BoM SEQ Thunderstorm Tracker Overlay
// @namespace    https://github.com/j0rdsta/seq-thunderstorm-tracker
// @version      0.5.0
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
   * Operates on the ORIGINAL pixels. Returns [{ x, y, area }] with centroids in image px.
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
      while (stack.length) {
        const q = stack.pop();
        const x = q % w;
        const y = (q - x) / w;
        size++; sx += x; sy += y;
        if (x > 0 && mask[q - 1] === 1) { mask[q - 1] = 2; stack.push(q - 1); }
        if (x < w - 1 && mask[q + 1] === 1) { mask[q + 1] = 2; stack.push(q + 1); }
        if (y > 0 && mask[q - w] === 1) { mask[q - w] = 2; stack.push(q - w); }
        if (y < h - 1 && mask[q + w] === 1) { mask[q + w] = 2; stack.push(q + w); }
      }
      if (size >= minPixels) cells.push({ x: sx / size, y: sy / size, area: size });
    }
    return cells;
  }

  function countCells(data, w, h, minPixels = 40) {
    return findCells(data, w, h, minPixels).length;
  }

  // ----- Experimental storm paths ------------------------------------------------
  // Our own rough estimate, NOT a Bureau product: link storm cells across saved tracker
  // images into paths, then extrapolate in a straight line with a widening uncertainty cone.

  const KM_PER_PX = 0.42; // ground distance of one tracker-image pixel at ~27.5°S

  const TRACK_DEFAULTS = {
    maxSpeedKmh: 120, // faster than this between images = not the same storm
    slackKm: 3, // allowance for the ellipse centre wobbling between images
    maxGapMin: 10, // end paths after a missing scan
  };

  /**
   * Link mutual-best motion/area matches; end paths at ambiguous merges or splits.
   * @param {{t:number, cells:{x:number,y:number,area:number}[]}[]} frameList epoch-ms frames
   * @returns {{points:{t:number,x:number,y:number,area:number}[]}[]}
   */
  function linkTracks(frameList, opts = {}) {
    const o = { ...TRACK_DEFAULTS, ...opts };
    const last = (tr) => tr.points[tr.points.length - 1];
    const tracks = [];
    let open = [];
    for (const f of [...frameList].sort((a, b) => a.t - b.t)) {
      const pairs = [];
      open.forEach((tr, ti) => {
        const z = last(tr);
        const dt = (f.t - z.t) / 60000;
        if (dt <= 0 || dt > o.maxGapMin) return;
        let vx = 0;
        let vy = 0;
        if (tr.points.length > 1) {
          const p = tr.points[tr.points.length - 2];
          const span = (z.t - p.t) / 60000;
          vx = (z.x - p.x) / span;
          vy = (z.y - p.y) / span;
        }
        f.cells.forEach((c, ci) => {
          const ratio = c.area / z.area;
          const distance = Math.hypot(c.x - z.x, c.y - z.y);
          const residual = Math.hypot(c.x - z.x - vx * dt, c.y - z.y - vy * dt);
          if (ratio < 0.4 || ratio > 2.5 ||
              distance > (o.maxSpeedKmh / 60 * dt + o.slackKm) / KM_PER_PX ||
              residual > (o.slackKm + 0.7 * dt) / KM_PER_PX) return;
          pairs.push({ ti, ci, cost: residual + 8 * Math.abs(Math.log(ratio)) });
        });
      });
      // Only an unambiguous mutual best match continues a path. Retiring all other
      // paths avoids forcing an identity through a merge, split or missing detection.
      const next = [];
      const used = new Set();
      for (let ti = 0; ti < open.length; ti++) {
        const choices = pairs.filter((p) => p.ti === ti).sort((a, b) => a.cost - b.cost);
        if (!choices.length || (choices[1] && choices[1].cost - choices[0].cost < 5)) continue;
        const q = choices[0];
        const rivals = pairs.filter((p) => p.ci === q.ci).sort((a, b) => a.cost - b.cost);
        if (rivals[0] !== q || (rivals[1] && rivals[1].cost - q.cost < 5)) continue;
        const tr = open[ti];
        tr.points.push({ t: f.t, ...f.cells[q.ci] });
        next.push(tr);
        used.add(q.ci);
      }
      f.cells.forEach((c, ci) => {
        if (used.has(ci)) return;
        const tr = { points: [{ t: f.t, ...c }] };
        tracks.push(tr);
        next.push(tr);
      });
      open = next;
    }
    return tracks;
  }

  /**
   * Recent median velocity of a path's recent points, extrapolated forward.
   * Needs >= minPoints spanning >= minSpanMin. Uncertainty radius grows with lead time,
   * distance travelled and how badly the points fit a straight line.
   * @returns {null | {vx:number, vy:number, speedKmh:number, predictions:{min:number,x:number,y:number,r:number}[]}}
   */
  function predictTrack(points, horizonsMin = [10, 20], opts = {}) {
    const o = { minPoints: 3, minSpanMin: 10, maxFit: 6, ...TRACK_DEFAULTS, ...opts };
    if (points.length < o.minPoints) return null;
    const pts = points.slice(-o.maxFit);
    if (pts.some((p, i) => i && p.t <= pts[i - 1].t)) return null;
    const t0 = pts[pts.length - 1].t;
    const ts = pts.map((p) => (p.t - t0) / 60000);
    if (-ts[0] < o.minSpanMin) return null;
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const mt = mean(ts);
    const stt = ts.reduce((s, t) => s + (t - mt) ** 2, 0);
    const fit = (vals) => {
      const mv = mean(vals);
      const slope = ts.reduce((s, t, i) => s + (t - mt) * (vals[i] - mv), 0) / stt;
      return { slope, at: (t) => mv + slope * (t - mt) };
    };
    const fx = fit(pts.map((p) => p.x));
    const fy = fit(pts.map((p) => p.y));
    const speedKmh = Math.hypot(fx.slope, fy.slope) * KM_PER_PX * 60;
    if (speedKmh > o.maxSpeedKmh) return null;
    const rms = Math.sqrt(mean(pts.map((p, i) => (p.x - fx.at(ts[i])) ** 2 + (p.y - fy.at(ts[i])) ** 2)));
    // Median interval velocity limits the influence of a single centroid wobble.
    // Keep the fit residual in the uncertainty allowance; anchor at the observed centre.
    const recent = pts.slice(-4);
    const velocities = recent.slice(1).map((p, i) => {
      const dt = (p.t - recent[i].t) / 60000;
      return [(p.x - recent[i].x) / dt, (p.y - recent[i].y) / dt];
    });
    const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const vx = median(velocities.map((v) => v[0]));
    const vy = median(velocities.map((v) => v[1]));
    const robustSpeed = Math.hypot(vx, vy) * KM_PER_PX * 60;
    if (!Number.isFinite(robustSpeed) || robustSpeed > o.maxSpeedKmh) return null;
    const last = pts[pts.length - 1];
    const predictions = horizonsMin.filter((min) => min > 0 && min <= 20).map((min) => {
      const dist = Math.hypot(fx.slope, fy.slope) * min;
      const r = 3 / KM_PER_PX + 0.35 * dist + 2 * rms + 0.05 * min / KM_PER_PX;
      return { min, x: last.x + vx * min, y: last.y + vy * min, r };
    });
    return predictions.length ? { vx, vy, speedKmh: robustSpeed, predictions } : null;
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

  /**
   * Choose the saved tracker image that belongs with a radar frame.
   * The tracker is issued every ~6 min from the latest radar scans, so the image for the radar
   * frame at time F is typically issued a few minutes after F. Picks the issue time closest to
   * F + leadMs, within toleranceMs; returns null when nothing saved is close enough.
   * @param {number[]} issuedTimes epoch ms
   * @param {number} frameMs epoch ms of the radar frame
   */
  function pickTrackerFrame(issuedTimes, frameMs, leadMs = 5 * 60000, toleranceMs = 7 * 60000) {
    let best = null;
    let bestDiff = Infinity;
    for (const t of issuedTimes) {
      const diff = Math.abs(t - (frameMs + leadMs));
      if (diff <= toleranceMs && diff < bestDiff) { best = t; bestDiff = diff; }
    }
    return best;
  }

  const core = {
    IMAGE_URL, TRACKER_PAGE, IMAGE_W, IMAGE_H, CORNERS,
    lonLatToMercator, imageToMercatorAffine, applyAffine, invertAffine, imageToScreenTransform,
    footprintBounds, intersects, rgbToHs, stormAlpha, chromaKey, stormHash, isCellFill, countCells, findCells,
    KM_PER_PX, linkTracks, predictTrack,
    looksLikeMapView, findMapViewFromElement, viewExtent, formatAge, formatAgeLong, formatIssued,
    parseTimelineLabel, pickTrackerFrame,
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
    syncTimeline: true, // show the saved tracker image matching the radar frame on screen
    showTracks: false, // experimental storm paths + straight-line estimate (not a Bureau product)
    nudge: { dx: 0, dy: 0 },
  };
  const STALE_MS = 20 * 60 * 1000;
  const MIN_REQUEST_GAP_MS = 30 * 1000;
  const FETCH_TIMEOUT_MS = 20 * 1000;
  const HISTORY_MS = 2 * 60 * 60 * 1000; // keep tracker images for the last 2 hours
  const HISTORY_MAX = 30;

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
    bitmap: null, // keyed canvas of the latest image
    etag: null,
    issued: null,
    cells: null,
    fetchedAt: null,
    error: null,
    timer: null,
    inflight: false,
    lastRequestAt: 0,
    badSize: null,
    description: null, // "Current Tracking Description" text from the tracker page
    frameT: null, // key (epoch ms) of the saved frame holding the latest storm drawing
  };

  /** @type {Map<object, Attachment>} */
  const attachments = new Map();

  /** Saved tracker images by issue time (epoch ms): { blob, canvas (keyed), cells }. */
  const frames = new Map();

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
        state.cells = null;
        state.badSize = `${bmp.width}×${bmp.height}`;
        throw new Error(`tracker image changed size (${state.badSize}); overlay disabled until the script is updated`);
      }
      state.badSize = null;
      const issued = lm ? new Date(lm) : new Date();
      const frame = { blob, ...keyBitmap(bmp) };
      const prevT = latestFrameTime();
      const prev = prevT !== null ? frames.get(prevT) : null;
      const changed = !prev || prev.hash !== frame.hash;
      if (changed) {
        // New storm drawing: save it, keyed by when it first appeared.
        frames.set(issued.getTime(), frame);
        pruneFrames();
        history.put({ issued: issued.getTime(), blob, hash: frame.hash });
        state.frameT = issued.getTime();
      } else {
        state.frameT = prevT; // same storms, just a newer "Issued at" stamp
      }
      state.etag = etag;
      state.issued = issued;
      state.cells = frame.cells;
      state.bitmap = frames.get(state.frameT).canvas;
      state.error = null;
      if (changed || !state.description) fetchDescription();
    } catch (err) {
      state.error = err && err.name === 'AbortError' ? 'request timed out' : String(err && err.message || err);
      console.warn('[SEQ tracker] refresh failed:', err);
    } finally {
      clearTimeout(timeout);
      state.inflight = false;
      updateAll(true);
    }
  }

  /** Decode → chroma-key → canvas, plus the storm cell count. */
  function keyBitmap(bmp) {
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const cellList = findCells(img.data, c.width, c.height);
    chromaKey(img.data, settings.colour);
    ctx.putImageData(img, 0, 0);
    return { canvas: c, cells: cellList.length, cellList, hash: stormHash(img.data) };
  }

  /** Re-key every saved image (after a colour change). */
  async function rekey() {
    for (const [t, f] of frames) {
      try {
        const { canvas } = keyBitmap(await createImageBitmap(f.blob));
        f.canvas = canvas;
        if (t === state.frameT) state.bitmap = canvas;
      } catch (_) { frames.delete(t); }
    }
    updateAll(true);
  }

  function latestFrameTime() {
    let best = null;
    for (const t of frames.keys()) if (best === null || t > best) best = t;
    return best;
  }

  /** Keep only the first frame of each run of identical storm drawings. */
  function dedupeFrames() {
    let lastHash = null;
    for (const t of [...frames.keys()].sort((a, b) => a - b)) {
      const f = frames.get(t);
      if (f.hash === lastHash) {
        frames.delete(t);
        if (state.frameT === t) state.frameT = latestFrameTime();
      } else lastHash = f.hash;
    }
    if (state.frameT !== null && !frames.has(state.frameT)) state.frameT = latestFrameTime();
    if (state.frameT !== null) state.bitmap = frames.get(state.frameT).canvas;
  }

  function pruneFrames() {
    const cutoff = Date.now() - HISTORY_MS;
    const times = [...frames.keys()].sort((a, b) => a - b);
    times.forEach((t, i) => {
      if (t < cutoff || i < times.length - HISTORY_MAX) frames.delete(t);
    });
  }

  // ----- saved history (IndexedDB) ----------------------------------------------
  // BoM only publishes the latest tracker image, so the script keeps its own short history
  // to play back alongside the radar loop. Images are only saved while a BoM page is open.

  const history = (() => {
    const DB = 'seq-thunderstorm-tracker';
    const STORE = 'frames';
    let dbp = null;
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    function open() {
      if (!dbp) {
        dbp = new Promise((res, rej) => {
          const r = indexedDB.open(DB, 1);
          r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'issued' });
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        }).catch((err) => { console.warn('[SEQ tracker] history unavailable:', err); return null; });
      }
      return dbp;
    }
    async function store(mode) {
      const db = await open();
      return db ? db.transaction(STORE, mode).objectStore(STORE) : null;
    }
    return {
      async put(rec) {
        try {
          const s = await store('readwrite');
          if (!s) return;
          await req(s.put(rec));
          await req(s.delete(IDBKeyRange.upperBound(Date.now() - HISTORY_MS)));
        } catch (err) { console.warn('[SEQ tracker] could not save image:', err); }
      },
      async all() {
        try {
          const s = await store('readonly');
          return s ? await req(s.getAll(IDBKeyRange.lowerBound(Date.now() - HISTORY_MS))) : [];
        } catch (_) { return []; }
      },
      async clear() {
        try { const s = await store('readwrite'); if (s) await req(s.clear()); } catch (_) { /* ignore */ }
      },
    };
  })();

  async function loadHistory() {
    for (const rec of await history.all()) {
      if (frames.has(rec.issued)) continue;
      try {
        const bmp = await createImageBitmap(rec.blob);
        if (bmp.width !== IMAGE_W || bmp.height !== IMAGE_H) continue;
        frames.set(rec.issued, { blob: rec.blob, ...keyBitmap(bmp) });
      } catch (_) { /* skip unreadable */ }
    }
    dedupeFrames();
    pruneFrames();
    updateAll(true);
  }

  async function clearHistory() {
    await history.clear();
    for (const t of [...frames.keys()]) if (t !== state.frameT) frames.delete(t);
    updateAll(true);
  }

  /** Which saved image ({ t, canvas }) to draw for a radar frame time (null = nothing to show). */
  function imageForFrame(frameTime) {
    const latest = state.bitmap && state.frameT !== null ? { t: state.frameT, canvas: state.bitmap } : null;
    if (!settings.syncTimeline || !frameTime) return latest;
    const f = frameTime.getTime();
    const t = pickTrackerFrame([...frames.keys()], f);
    if (t !== null) return { t, canvas: frames.get(t).canvas };
    // Newest radar frames (or a radar feed running a little behind the tracker): use the latest image.
    if (latest && f >= latest.t - 12 * 60000 && f <= latest.t + 30 * 60000) {
      return latest;
    }
    return null;
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

  // ----- tracking description (text from the tracker page) ---------------------

  async function fetchDescription() {
    try {
      const res = await fetch(TRACKER_PAGE, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // The tracker page is an older Latin-1 page; DOMParser documents are inert (no scripts/images).
      const html = new TextDecoder('windows-1252').decode(await res.arrayBuffer());
      const node = new DOMParser().parseFromString(html, 'text/html').getElementById('forecasttext');
      state.description = node ? node.textContent.replace(/\s+/g, ' ').trim() : null;
    } catch (err) {
      console.warn('[SEQ tracker] could not load tracking description:', err);
    }
    updateAll(false);
  }

  // ----- experimental storm paths (drawing) ---------------------------------------

  let tracksKey = '';
  let tracksCache = [];
  function getTracks() {
    const key = [...frames.keys()].sort((a, b) => a - b).join(',');
    if (key !== tracksKey) {
      tracksKey = key;
      tracksCache = linkTracks([...frames].map(([t, f]) => ({ t, cells: f.cellList || [] })));
    }
    return tracksCache;
  }

  /** Draw paths (up to the displayed frame) and straight-line estimate cones, in screen space. */
  function drawTracks(ctx, t, dpr, frameT) {
    const S = (x, y) => [(t.a * x + t.c * y + t.e) * dpr, (t.b * x + t.d * y + t.f) * dpr];
    const scale = Math.hypot(t.a, t.b) * dpr; // device px per image px
    const ink = '30,30,30';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const tr of getTracks()) {
      const pts = tr.points.filter((p) => p.t <= frameT);
      if (!pts.length || pts[pts.length - 1].t !== frameT) continue;
      const last = pts[pts.length - 1];
      const [lx, ly] = S(last.x, last.y);
      const pred = predictTrack(pts);
      if (pred) {
        const far = pred.predictions[pred.predictions.length - 1];
        const [fx, fy] = S(far.x, far.y);
        const r0 = (3 / KM_PER_PX) * scale;
        const r1 = far.r * scale;
        const d = Math.hypot(fx - lx, fy - ly);
        ctx.beginPath();
        if (d > Math.abs(r1 - r0)) {
          const th = Math.atan2(fy - ly, fx - lx);
          const phi = Math.asin((r1 - r0) / d);
          ctx.arc(fx, fy, r1, th - Math.PI / 2 - phi, th + Math.PI / 2 + phi);
          ctx.arc(lx, ly, r0, th + Math.PI / 2 + phi, th + Math.PI * 1.5 - phi);
        } else {
          ctx.arc(fx, fy, Math.max(r0, r1), 0, Math.PI * 2);
        }
        ctx.closePath();
        ctx.fillStyle = `rgba(${ink},0.10)`;
        ctx.fill();
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.lineWidth = 1.25 * dpr;
        ctx.strokeStyle = `rgba(${ink},0.55)`;
        ctx.stroke();
        // centre line and lead-time markers
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(fx, fy);
        ctx.stroke();
        ctx.setLineDash([]);
        for (const pr of pred.predictions) {
          const [px, py] = S(pr.x, pr.y);
          ctx.beginPath();
          ctx.arc(px, py, 2.5 * dpr, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${ink},0.7)`;
          ctx.fill();
        }
        ctx.font = `${11 * dpr}px Inter, Inter-fallback, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3 * dpr;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.fillStyle = `rgb(${ink})`;
        const label = `~${far.min} min?`;
        ctx.strokeText(label, fx + 4 * dpr, fy);
        ctx.fillText(label, fx + 4 * dpr, fy);
      }
      if (pts.length > 1) {
        ctx.beginPath();
        pts.forEach((p, i) => { const [x, y] = S(p.x, p.y); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.lineWidth = 4.5 * dpr;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.stroke();
        ctx.lineWidth = 2 * dpr;
        ctx.strokeStyle = `rgb(${ink})`;
        ctx.stroke();
        for (const p of pts.slice(0, -1)) {
          const [x, y] = S(p.x, p.y);
          ctx.beginPath();
          ctx.arc(x, y, 2.5 * dpr, 0, Math.PI * 2);
          ctx.fillStyle = `rgb(${ink})`;
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

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
      if (!statusLine.root.isConnected) placeStatus();
      if (!info.root.isConnected || !info.about.isConnected) placeInfo(this);
      if (c) {
        const key = `${c.x}|${c.y}|${v.resolution}|${v.width}|${v.height}|${v.rotation}|${this.timelineText()}`;
        if (key !== this.last) {
          this.last = key;
          this.draw();
        }
      }
      this.raf = requestAnimationFrame(this.loop);
    }

    timelineText() {
      const label = this.section && this.section.querySelector('.bom-scrub-display-label');
      return label ? label.textContent : '';
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
      const image = imageForFrame(parseTimelineLabel(this.timelineText()));
      this.frameHidden = !!state.bitmap && !image;
      if (!settings.enabled || !e || !this.inCoverage) return;
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
      if (image) {
        ctx.globalAlpha = settings.opacity;
        ctx.drawImage(image.canvas, 0, 0);
        ctx.globalAlpha = 1;
        if (settings.showTracks) drawTracks(ctx, t, dpr, image.t);
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
      attachments.delete(this.view);
      if (!attachments.size) { statusLine.root.remove(); info.root.remove(); info.about.remove(); }
      schedule();
    }
  }

  // ----- UI (reuses bom.gov.au markup and classes) ---------------------------

  const CSS = `
  .seq-ts-info{margin:24px 0 8px}
  .seq-ts-info[hidden]{display:none}
  .seq-ts-info h3{margin:0 0 4px}
  .seq-ts-info__legend{list-style:none;padding:0;margin:12px 0 0;display:flex;flex-wrap:wrap;gap:8px 24px;
    font-size:14px;line-height:20px;color:#4a4a4a}
  .seq-ts-info__legend li{display:flex;align-items:center;gap:8px;margin:0}
  .seq-ts-info__legend li[hidden]{display:none}
  .seq-ts-info__legend img,.seq-ts-info__legend svg{height:24px;width:auto;flex:none}
  .seq-ts-info .seq-ts-info__meta{margin-top:8px;font-size:14px;line-height:20px}
  .seq-ts-meta__warn{color:#b3261e}
  .seq-ts-meta__actions{display:inline-flex;gap:10px;margin-left:10px}
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

  /**
   * One line in BoM's "Last updated" block below the map, written like its other lines
   * ("Observations: 9 minutes ago, 12:20 pm AEST"). Falls back to just under the map.
   */
  function buildStatusLine() {
    const text = el('span', { 'aria-live': 'polite' });
    const refreshBtn = el('button', { type: 'button', class: 'seq-ts-linkbtn', text: 'Refresh', onclick: () => refresh(true) });
    const toggleBtn = el('button', { type: 'button', class: 'seq-ts-linkbtn', onclick: () => setEnabled(!settings.enabled) });
    const settingsBtn = el('button', { type: 'button', class: 'seq-ts-linkbtn', text: 'Settings', onclick: openMoreWeather });
    const root = el('div', { class: 'seq-ts-meta', 'data-seq-ts': '' }, [
      text, el('span', { class: 'seq-ts-meta__actions' }, [refreshBtn, toggleBtn, settingsBtn]),
    ]);

    function update() {
      const att = attachments.values().next().value;
      let msg;
      let warn = false;
      if (!settings.enabled) msg = 'Thunderstorm tracker: hidden';
      else if (state.error && !state.bitmap) { msg = `Thunderstorm tracker: unavailable (${state.error})`; warn = true; }
      else if (!state.bitmap) msg = 'Thunderstorm tracker: loading…';
      else {
        msg = 'Thunderstorm tracker: ';
        if (state.issued) {
          const age = Date.now() - state.issued.getTime();
          msg += `${formatAgeLong(age)}, ${formatIssued(state.issued)}`;
          if (age > STALE_MS) warn = true;
        }
        const extra = [];
        if (att && att.inCoverage === false) extra.push('map is outside Southeast Queensland');
        else extra.push(state.cells === 0 ? 'no tracked storms' : `${state.cells} storm cell${state.cells === 1 ? '' : 's'}`);
        if (settings.syncTimeline && frames.size > 1) extra.push(`${frames.size} images saved for the radar loop`);
        if (settings.showTracks) {
          extra.push(frames.size < 3 ? 'storm paths need about 15 minutes of saved images' : 'experimental storm paths on');
        }
        if (state.error) { extra.push('refresh failed'); warn = true; }
        msg += ` (${extra.join(', ')})`;
      }
      text.textContent = msg;
      text.className = warn ? 'seq-ts-meta__warn' : '';
      text.title = state.fetchedAt ? `Last checked ${formatIssued(state.fetchedAt)}` : '';
      toggleBtn.textContent = settings.enabled ? 'Hide' : 'Show';
      toggleBtn.setAttribute('aria-label', settings.enabled ? 'Hide thunderstorm tracker' : 'Show thunderstorm tracker');
      refreshBtn.hidden = !settings.enabled;
      refreshBtn.setAttribute('aria-label', 'Refresh thunderstorm tracker');
      settingsBtn.setAttribute('aria-label', 'Thunderstorm tracker settings');
    }

    return { root, update };
  }

  const statusLine = buildStatusLine();

  function placeStatus() {
    ensureStyles();
    const meta = document.querySelector('.C07_WeatherMetadata .metadata__container, .metadata__container');
    if (meta) { meta.appendChild(statusLine.root); return; }
    const att = attachments.values().next().value;
    if (!att) return;
    const anchor = (att.section && att.section.querySelector('.bom-scrub')) || att.container;
    if (anchor.parentElement) anchor.insertAdjacentElement('afterend', statusLine.root);
  }

  // ----- Tracking description + "About the thunderstorm tracker" accordion ------

  const REPO_URL = 'https://github.com/j0rdsta/seq-thunderstorm-tracker';
  const ABOUT_PAGE = 'https://www.bom.gov.au/weather-services/about/thunderstorm-tracker.shtml';

  function pathSwatch() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 48 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = '<path d="M30 12 L44 4 A9 9 0 0 1 44 20 Z" fill="rgba(30,30,30,.1)" stroke="rgba(30,30,30,.55)" stroke-dasharray="3 3"/>' +
      '<path d="M4 16 L16 13 L28 12" fill="none" stroke="#1e1e1e" stroke-width="2" stroke-linecap="round"/>' +
      '<circle cx="4" cy="16" r="2.5" fill="#1e1e1e"/><circle cx="16" cy="13" r="2.5" fill="#1e1e1e"/>';
    return svg;
  }

  function buildInfo() {
    const desc = el('p', {});
    const meta = el('p', { class: 'seq-ts-info__meta' });
    const pathItem = el('li', {}, [pathSwatch(), 'Storm path and rough 20-minute estimate (experimental, not from the Bureau)']);
    const root = el('div', { class: 'seq-ts-info bom-body', 'data-seq-ts': '' }, [
      el('h3', { class: 'bom-typo bom-typo--s-heading-xs bom-typo--responsive', text: 'Thunderstorm tracker' }),
      desc,
      el('ul', { class: 'seq-ts-info__legend' }, [
        el('li', {}, [el('img', { src: '/images/patifs/storm_cell.png', alt: '' }), 'Tracked thunderstorms']),
        el('li', {}, [el('img', { src: '/images/patifs/storm_direction.png', alt: '' }), 'Estimated movement and positions in 10, 20 and 30 minutes']),
        pathItem,
      ]),
      meta,
    ]);

    // Accordion: clone BoM's "About this map" header so icons/caret match, then wire our own toggle.
    const panelId = 'seq-ts-about-panel';
    const panel = el('div', { class: 'bom-accordion-panel', id: panelId, 'data-seq-ts': '' }, [
      el('div', { class: 'bom-body' }, [el('div', {}, [
        el('h4', { text: 'What the tracker shows' }),
        el('p', { text: 'The Thunderstorm Tracker is an automated pilot product from the Bureau of Meteorology. It looks for ' +
          'areas of intense rainfall in the last two to three radar scans and shows likely thunderstorms as ovals. ' +
          'Arrows show the direction each storm is heading, and the three curves ahead of it show its expected ' +
          'position in 10, 20 and 30 minutes. It updates every 6 minutes, covers Southeast Queensland only, and is not a warning.' }),
        el('h4', { text: 'Severe thunderstorm warnings' }),
        el('p', { text: 'The Bureau issues Severe Thunderstorm Warnings when storms are expected to produce any of the following:' }),
        el('ul', {}, [
          el('li', { text: 'damaging wind gusts (90 km/h or more)' }),
          el('li', { text: 'large hail (2 cm diameter or more)' }),
          el('li', { text: 'very heavy rainfall that could cause flash flooding' }),
          el('li', { text: 'tornadoes' }),
        ]),
        el('p', { text: 'All thunderstorms produce lightning, and many produce gusty winds, brief heavy showers and hail.' }),
        el('h4', { text: 'Experimental storm paths' }),
        el('p', { text: 'If you turn on storm paths in Map settings, a dark line shows where each tracked storm has been ' +
          'and a shaded cone shows a rough straight-line estimate of where it might be in 20 minutes. This is a ' +
          'simple calculation by an unofficial browser script, not a Bureau forecast. Storms can speed up, slow ' +
          'down, turn, split, merge, grow or collapse within minutes, so the estimate can be badly wrong. Do not use ' +
          'it to make safety decisions; follow the Bureau’s warnings.' }),
        el('h4', { text: 'About this add-on' }),
        el('p', {}, [
          'The overlay, this section and the storm paths are added by ',
          el('a', { href: REPO_URL, target: '_blank', rel: 'noopener', text: 'an unofficial open-source browser script' }),
          '. It is not affiliated with or endorsed by the Bureau. Tracker images and text © Commonwealth of Australia, Bureau of Meteorology. See the ',
          el('a', { href: TRACKER_PAGE, target: '_blank', rel: 'noopener', text: 'official Thunderstorm Tracker' }),
          ' and ',
          el('a', { href: ABOUT_PAGE, target: '_blank', rel: 'noopener', text: 'how it works' }),
          '.',
        ]),
      ])]),
    ]);
    let header = null;
    function makeHeader() {
      const tpl = document.querySelector('.about-map-accordion.bom-accordion-header');
      let h;
      if (tpl) {
        h = tpl.cloneNode(true);
        h.classList.remove('about-map-accordion', 'bom-accordion-header--open');
        h.removeAttribute('data-testid');
        const title = h.querySelector('.accordion-title');
        const textNode = title && [...title.childNodes].reverse().find((n) => n.nodeType === 3);
        if (textNode) textNode.textContent = 'About the thunderstorm tracker';
        else if (title) title.append('About the thunderstorm tracker');
      } else {
        h = el('div', { class: 'bom-accordion-header' }, [
          el('div', { class: 'bom-accordion-header__label' }, [el('span', { class: 'accordion-title', text: 'About the thunderstorm tracker' })]),
        ]);
      }
      h.classList.add('seq-ts-about');
      h.setAttribute('data-seq-ts', '');
      h.setAttribute('role', 'button');
      h.setAttribute('tabindex', '0');
      h.setAttribute('aria-controls', panelId);
      h.setAttribute('aria-expanded', 'false');
      const toggle = (ev) => {
        ev.stopPropagation();
        const open = h.getAttribute('aria-expanded') !== 'true';
        h.setAttribute('aria-expanded', String(open));
        h.classList.toggle('bom-accordion-header--open', open);
        panel.classList.toggle('bom-accordion-panel--open', open);
      };
      h.addEventListener('click', toggle);
      h.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(ev); }
      });
      return h;
    }
    const about = el('div', { class: 'seq-ts-about-wrap', 'data-seq-ts': '' });

    function update() {
      root.hidden = !settings.enabled;
      about.hidden = !settings.enabled;
      if (!header) { header = makeHeader(); about.append(header, panel); }
      desc.textContent = state.description ||
        (state.error && !state.bitmap ? 'The tracking description is unavailable right now.' : 'Loading the tracking description…');
      pathItem.hidden = !settings.showTracks;
      meta.textContent = state.issued
        ? `From the Bureau’s Thunderstorm Tracker, ${formatIssued(state.issued)}. Not a warning – check current warnings for your area.`
        : '';
    }
    return { root, about, update };
  }

  const info = buildInfo();

  /** Description under the map; "About" accordion after BoM's "About this map". */
  function placeInfo(att) {
    ensureStyles();
    const section = att.section;
    if (!section) return;
    const wrapper = section.querySelector('.bom-spatial-map__wrapper') || att.container;
    if (!info.root.isConnected && wrapper.parentElement) wrapper.insertAdjacentElement('afterend', info.root);
    const bomPanel = section.querySelector('#about-map-accordion');
    if (!info.about.isConnected) {
      info.update();
      if (bomPanel) bomPanel.insertAdjacentElement('afterend', info.about);
      else info.root.insertAdjacentElement('afterend', info.about);
    }
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
    const sync = makeCheckbox('seq-ts-sync', 'Match the radar timeline', settings.syncTimeline, (v) => {
      settings.syncTimeline = v; saveSettings(); updateAll(true);
    });
    const tracks = makeCheckbox('seq-ts-tracks', 'Storm paths and 20-minute estimate (experimental)', settings.showTracks, (v) => {
      settings.showTracks = v; saveSettings(); updateAll(true);
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

    const savedOut = el('span');
    const clearBtn = tertiaryButton('Clear saved images', 'Clear saved thunderstorm tracker images', () => clearHistory());
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
    const historyGroup = el('div', { class: 'seq-ts-group' }, [clearBtn]);

    const fieldset = el('fieldset', { class: 'seq-ts-fieldset', 'data-seq-ts': '' }, [
      el('legend', {}, [el('h3', { class: 'bom-typo bom-typo--s-heading-xs bom-typo--responsive', text: 'Thunderstorm tracker (SEQ pilot)' })]),
      show.wrap, sync.wrap,
      el('div', { class: 'overlay-description bom-typo bom-typo--s-caption bom-typo--responsive' }, [
        'Shows the tracker image that goes with each radar time as you play or scrub the loop. BoM only ' +
        'publishes the latest image, so earlier ones are saved in this browser while the page is open (last 2 hours). ',
        savedOut,
      ]),
      tracks.wrap,
      el('div', { class: 'overlay-description bom-typo bom-typo--s-caption bom-typo--responsive', text:
        'Our own rough straight-line guess from where each storm has been, not a Bureau forecast. Storms can ' +
        'change speed or direction, split, merge or collapse quickly. Don’t rely on it; follow the Bureau’s warnings. ' +
        'Needs at least 10 minutes of saved tracker images. Estimates stop at 20 minutes and may disappear when matching is uncertain.' }),
      area.wrap,
      opacity.group, colour.group, interval.group, nudgeGroup, historyGroup,
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
      sync.input.checked = settings.syncTimeline;
      tracks.input.checked = settings.showTracks;
      savedOut.textContent = `${frames.size} image${frames.size === 1 ? '' : 's'} saved.`;
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
    }
    statusLine.update();
    info.update();
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
      placeStatus();
      if (!historyLoaded) { historyLoaded = true; loadHistory(); }
      placeInfo(attachments.get(view));
      if (!state.bitmap && settings.enabled) refresh();
      schedule();
      updateAll(false);
    });
  }

  let historyLoaded = false;
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
  window.__seqThunderstormTracker = { core, settings, state, attachments, frames, refresh };
})();
