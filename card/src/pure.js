/**
 * The card's arithmetic, kept apart from Leaflet and the DOM so Node can test it.
 */

import {
  imageToMercatorAffine, footprintBounds, imageToScreenTransform, mercatorToLonLat,
} from '../../packages/core/georef.js';

/** Geometry of the overlay: Leaflet bounds, SVG viewBox size and the image's transform. */
export function overlayGeometry(g = imageToMercatorAffine()) {
  const fp = footprintBounds(g);
  const width = fp.xmax - fp.xmin;
  const height = fp.ymax - fp.ymin;
  const t = imageToScreenTransform(g, fp, width, height); // 1 unit per metre
  const [west, south] = mercatorToLonLat(fp.xmin, fp.ymin);
  const [east, north] = mercatorToLonLat(fp.xmax, fp.ymax);
  return {
    bounds: [[south, west], [north, east]],
    width,
    height,
    transform: `matrix(${t.a} ${t.b} ${t.c} ${t.d} ${t.e} ${t.f})`,
  };
}

/** Tile URL template for the newest past frame in a RainViewer index, or null. */
export function radarTileUrl(index) {
  const frames = index && index.radar && Array.isArray(index.radar.past) ? index.radar.past : [];
  const latest = frames[frames.length - 1];
  if (!latest || typeof latest.path !== 'string' || typeof index.host !== 'string') return null;
  // 256 px tiles, colour scheme 2 (the only one on the free tier), smoothed, no snow colours.
  return { url: `${index.host}${latest.path}/256/{z}/{x}/{y}/2/1_0.png`, time: latest.time };
}
