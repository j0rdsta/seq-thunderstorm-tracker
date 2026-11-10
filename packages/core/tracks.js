// ----- Experimental storm paths ------------------------------------------------
// Our own rough estimate, NOT a Bureau product: link storm cells across saved tracker
// images into paths, then extrapolate in a straight line with a widening uncertainty cone.

export const KM_PER_PX = 0.42; // ground distance of one tracker-image pixel at ~27.5°S

export const TRACK_DEFAULTS = {
  maxSpeedKmh: 120, // faster than this between images = not the same storm
  slackKm: 3, // allowance for the ellipse centre wobbling between images
  maxGapMin: 10, // end paths after a missing scan
};

/**
 * Link mutual-best motion/area matches; end paths at ambiguous merges or splits.
 * @param {{t:number, cells:{x:number,y:number,area:number}[]}[]} frameList epoch-ms frames
 * @returns {{points:{t:number,x:number,y:number,area:number}[]}[]}
 */
export function linkTracks(frameList, opts = {}) {
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
export function predictTrack(points, horizonsMin = [10, 20], opts = {}) {
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
