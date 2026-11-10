/**
 * The tracker picture as a Leaflet layer.
 *
 * The image is the Bureau's, loaded by this browser. It is keyed with an SVG filter (the pixels
 * of a cross-origin image cannot be read, but they can be filtered while painting) and placed
 * with the same affine georeference as the userscript. Leaflet stretches the SVG linearly
 * between its corners, which is exact in Web Mercator, so the SVG's own coordinates are
 * Mercator metres measured from the footprint's north-west corner.
 */

import { SVGOverlay } from '../../node_modules/leaflet/dist/leaflet-src.esm.js';
import { IMAGE_W, IMAGE_H } from '../../packages/core/georef.js';
import { overlayGeometry } from './pure.js';
import { keyFilterMarkup } from '../../packages/core/keyfilter.js';

const NS = 'http://www.w3.org/2000/svg';
const FILTER_ID = 'seq-ts-key';

export function createTrackerOverlay({ colour = 'original', opacity = 0.85 } = {}) {
  const geometry = overlayGeometry();
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${geometry.width} ${geometry.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('tracker');
  const defs = document.createElementNS(NS, 'defs');
  svg.appendChild(defs);
  const image = document.createElementNS(NS, 'image');
  image.setAttribute('width', IMAGE_W);
  image.setAttribute('height', IMAGE_H);
  image.setAttribute('preserveAspectRatio', 'none');
  image.setAttribute('transform', geometry.transform);
  image.setAttribute('filter', `url(#${FILTER_ID})`);
  svg.appendChild(image);

  const layer = new SVGOverlay(svg, geometry.bounds, { opacity, interactive: false });

  return {
    layer,
    bounds: geometry.bounds,
    setColour(mode) { defs.innerHTML = keyFilterMarkup(FILTER_ID, mode); },
    setOpacity(value) { layer.setOpacity(value); },
    /** Show a picture that has already loaded (so the swap never flashes a broken image). */
    show(url) { image.setAttribute('href', url); svg.style.visibility = ''; },
    hide() { svg.style.visibility = 'hidden'; },
    init() { this.setColour(colour); this.hide(); return this; },
  }.init();
}
