/** Where the tracker image sits on the Earth: constants, Web Mercator and the affine georeference. */

export const IMAGE_URL = 'https://www.bom.gov.au/fwo/IDA00050.png';
export const TRACKER_PAGE = 'https://www.bom.gov.au/qld/forecasts/brisbane-thunderstorms.shtml';
export const IMAGE_W = 600;
export const IMAGE_H = 643;

/**
 * Georeference of IDA00050.png in Web Mercator (EPSG:3857) metres.
 * Derived by least-squares affine fit of 13 town markers on the image
 * (see README "How the overlay is aligned"). Corner = image pixel corner.
 */
export const CORNERS = {
  tl: [16852901.89, -3018857.35], // pixel (0, 0)
  tr: [17134364.43, -3020336.98], // pixel (IMAGE_W, 0)
  bl: [16852265.34, -3301850.42], // pixel (0, IMAGE_H)
};

export const R = 6378137;
export function lonLatToMercator(lon, lat) {
  return [
    (lon * Math.PI / 180) * R,
    Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R,
  ];
}

export function mercatorToLonLat(x, y) {
  return [
    (x / R) * 180 / Math.PI,
    (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI,
  ];
}

/** Affine image-pixel -> mercator: X = a*px + c*py + e ; Y = b*px + d*py + f */
export function imageToMercatorAffine(corners = CORNERS, w = IMAGE_W, h = IMAGE_H, nudge = { dx: 0, dy: 0 }) {
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

export function applyAffine(m, x, y) {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

/** Inverse of an affine (mercator -> image pixel). */
export function invertAffine(m) {
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
export function imageToScreenTransform(g, extent, width, height) {
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
export function footprintBounds(g, w = IMAGE_W, h = IMAGE_H) {
  const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => applyAffine(g, x, y));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys) };
}

export function intersects(a, b) {
  return a.xmin < b.xmax && a.xmax > b.xmin && a.ymin < b.ymax && a.ymax > b.ymin;
}
