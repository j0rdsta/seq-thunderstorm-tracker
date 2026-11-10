/**
 * Optional rain radar underlay from RainViewer's free public API (personal use, past frames,
 * zoom 7 at most). The index is read at most every 10 minutes and the path always comes from
 * it. Off unless the card is configured with `radar: true`.
 */

import { TileLayer } from '../../node_modules/leaflet/dist/leaflet-src.esm.js';
import { radarTileUrl } from './pure.js';

const INDEX_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const REFRESH_MS = 10 * 60 * 1000;

export function createRadar(map, onChange = () => {}) {
  let layer = null;
  let timer = null;
  let stopped = false;

  async function refresh() {
    try {
      const res = await fetch(INDEX_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const frame = radarTileUrl(await res.json());
      if (stopped || !frame) return;
      if (layer) layer.setUrl(frame.url);
      else {
        layer = new TileLayer(frame.url, {
          maxNativeZoom: 7, opacity: 0.55, className: 'radar',
          attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
        }).addTo(map);
      }
      onChange(frame.time);
    } catch (err) {
      console.warn('[SEQ tracker card] rain radar unavailable:', err);
    }
  }

  refresh();
  timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      if (layer) layer.remove();
    },
  };
}
