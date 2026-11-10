/**
 * <seq-thunderstorm-tracker-card>: the Bureau's Thunderstorm Tracker on a Home Assistant dashboard.
 *
 * The picture comes straight from bom.gov.au, loaded by whoever is looking at the dashboard.
 * If that fails, the card falls back to the picture the bridge userscript last sent to Home
 * Assistant. Distances and the tracking description come from the integration's sensors.
 */

import { Map as LeafletMap, TileLayer, Marker, Circle, DivIcon } from '../../node_modules/leaflet/dist/leaflet-src.esm.js';
import leafletCss from '../../node_modules/leaflet/dist/leaflet.css';
import cardCss from './styles.css';
import { IMAGE_URL, TRACKER_PAGE } from '../../packages/core/georef.js';
import { createTrackerOverlay } from './overlay.js';
import { createRadar } from './radar.js';
import { describeStatus, discover, placeFor } from './status.js';

const VERSION = '__VERSION__';
const TYPE = 'seq-thunderstorm-tracker-card';
const REFRESH_MS = 5 * 60 * 1000;
const TILE_TOKEN_MS = 20 * 60 * 1000;
/** One tracker pixel is about 0.4 km, so zooming in further only magnifies it. */
const MAX_ZOOM = 11;
const SOURCES = ['auto', 'bom', 'home_assistant'];
const COLOURS = ['original', 'magenta', 'black'];

const DEFAULTS = {
  title: 'Thunderstorm tracker',
  entities: ['zone.home'],
  source: 'auto',
  radar: false,
  zoom: 8,
  storm_colour: 'original',
  opacity: 0.85,
  show_description: true,
};

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(url);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = url;
  });
}

class SeqThunderstormTrackerCard extends HTMLElement {
  static getStubConfig() {
    return { type: `custom:${TYPE}`, entities: ['zone.home'] };
  }

  static getConfigForm() {
    return {
      schema: [
        { name: 'title', selector: { text: {} } },
        { name: 'entities', selector: { entity: { multiple: true, filter: [{ domain: 'zone' }, { domain: 'person' }, { domain: 'device_tracker' }] } } },
        {
          type: 'grid',
          name: '',
          schema: [
            { name: 'zoom', selector: { number: { min: 6, max: MAX_ZOOM, step: 0.5, mode: 'box' } } },
            { name: 'alert_radius', selector: { number: { min: 1, max: 150, step: 1, mode: 'box', unit_of_measurement: 'km' } } },
            {
              name: 'source',
              selector: { select: { mode: 'dropdown', options: [
                { value: 'auto', label: 'Bureau first, then Home Assistant' },
                { value: 'bom', label: 'Bureau only (live in this browser)' },
                { value: 'home_assistant', label: 'Home Assistant only (sent by the bridge)' },
              ] } },
            },
            {
              name: 'storm_colour',
              selector: { select: { mode: 'dropdown', options: [
                { value: 'original', label: 'Orange' },
                { value: 'magenta', label: 'Magenta' },
                { value: 'black', label: 'Black' },
              ] } },
            },
          ],
        },
        { name: 'show_description', selector: { boolean: {} } },
        { name: 'radar', selector: { boolean: {} } },
      ],
      computeLabel: (field) => ({
        title: 'Title',
        entities: 'Places to show (the first is the centre and gets the alert ring)',
        zoom: 'Zoom',
        alert_radius: 'Alert ring',
        source: 'Tracker picture from',
        storm_colour: 'Storm colour',
        show_description: 'Show the Bureau’s tracking description',
        radar: 'Rain radar underneath (RainViewer)',
      })[field.name],
      computeHelper: (field) => ({
        alert_radius: 'Leave empty to use the integration’s alert distance.',
        radar: 'A second opinion from another service, not the Bureau’s radar.',
      })[field.name],
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = { ...DEFAULTS };
    this._markers = new Map();
    this._found = { hub: {}, places: {} };
    this._shown = null; // 'bom' | 'home_assistant' | null
    this._loading = true;
    this._loadedAt = null;
  }

  setConfig(config) {
    if (!config || typeof config !== 'object') throw new Error('Invalid configuration');
    const next = { ...DEFAULTS, ...config };
    if (!Array.isArray(next.entities)) next.entities = next.entities ? [next.entities] : [];
    if (!SOURCES.includes(next.source)) throw new Error(`source must be one of ${SOURCES.join(', ')}`);
    if (!COLOURS.includes(next.storm_colour)) throw new Error(`storm_colour must be one of ${COLOURS.join(', ')}`);
    next.zoom = Math.min(MAX_ZOOM, Math.max(5, Number(next.zoom) || DEFAULTS.zoom));
    next.opacity = Math.min(1, Math.max(0.2, Number(next.opacity) || DEFAULTS.opacity));
    const previous = this._config;
    this._config = next;
    if (!this._map) return;
    this._overlay.setColour(next.storm_colour);
    this._overlay.setOpacity(next.opacity);
    this._title.textContent = next.title || '';
    this._title.hidden = !next.title;
    if (next.zoom !== previous.zoom) this._map.setZoom(next.zoom);
    if (!!next.radar !== !!previous.radar) this._setRadar(next.radar);
    if (next.source !== previous.source) this._refresh();
    if (JSON.stringify(next.entities) !== JSON.stringify(previous.entities)) this._centred = false;
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    if (hass.entities !== this._entities) {
      this._entities = hass.entities;
      this._found = discover(hass.entities);
    }
    if (this._map) this._update();
  }

  getCardSize() {
    return 8;
  }

  getGridOptions() {
    return { columns: 12, rows: 7, min_columns: 6, min_rows: 4 };
  }

  connectedCallback() {
    if (!this._map) this._build();
    this._timer = setInterval(() => { if (!document.hidden) this._refresh(); }, REFRESH_MS);
    this._onVisible = () => {
      if (!document.hidden && (!this._loadedAt || Date.now() - this._loadedAt > REFRESH_MS)) this._refresh();
    };
    document.addEventListener('visibilitychange', this._onVisible);
    this._resize = new ResizeObserver(() => this._map && this._map.invalidateSize());
    this._resize.observe(this._mapEl);
    this._refresh();
    if (this._hass) this._update();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    clearInterval(this._tileTimer);
    document.removeEventListener('visibilitychange', this._onVisible);
    if (this._resize) this._resize.disconnect();
  }

  // ----- building ---------------------------------------------------------------

  _build() {
    const root = this.shadowRoot;
    root.innerHTML = `<style>${leafletCss}\n${cardCss}</style>
      <ha-card>
        <div class="title"></div>
        <div class="map"></div>
        <div class="footer">
          <div class="status" aria-live="polite"></div>
          <div class="description"></div>
          <div class="note">Not a warning: check the Bureau’s current warnings.
            <a href="${TRACKER_PAGE}" target="_blank" rel="noopener">Thunderstorm Tracker</a>
            © Bureau of Meteorology, Southeast Queensland pilot. Unofficial card.</div>
        </div>
      </ha-card>`;
    this._title = root.querySelector('.title');
    this._mapEl = root.querySelector('.map');
    this._status = root.querySelector('.status');
    this._description = root.querySelector('.description');
    this._title.textContent = this._config.title || '';
    this._title.hidden = !this._config.title;

    this._map = new LeafletMap(this._mapEl, {
      center: [-27.47, 153.02],
      zoom: this._config.zoom,
      minZoom: 5,
      maxZoom: MAX_ZOOM,
      zoomSnap: 0.5,
      attributionControl: true,
    });
    this._map.attributionControl.setPrefix(false);
    this._overlay = createTrackerOverlay({ colour: this._config.storm_colour, opacity: this._config.opacity });
    this._overlay.layer.addTo(this._map);
    this._setRadar(this._config.radar);
  }

  /**
   * Base map: OpenStreetMap's standard tiles. Home Assistant 2026.10+ proxies them for its own
   * map card (so the request does not carry your Home Assistant address); use that when it is
   * there, and OpenStreetMap directly on older versions.
   */
  async _setBaseLayer() {
    if (this._base || !this._hass || this._baseStarted) return;
    this._baseStarted = true;
    const options = {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      className: 'base',
      maxZoom: MAX_ZOOM,
    };
    const token = async () => (await this._hass.callWS({ type: 'map_tiles/access_token' })).token;
    const proxied = (t) => `/api/map_tiles/raster/{z}/{x}/{y}.png?token=${encodeURIComponent(t)}`;
    try {
      this._base = new TileLayer(proxied(await token()), options);
      // The proxy's tokens rotate, so keep the address fresh while the dashboard stays open.
      this._tileTimer = setInterval(async () => {
        try { this._base.setUrl(proxied(await token()), true); } catch (_) { /* keep the old one */ }
      }, TILE_TOKEN_MS);
    } catch (_) {
      this._base = new TileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', options);
    }
    this._base.addTo(this._map).bringToBack();
  }

  _setRadar(on) {
    if (this._radar) { this._radar.stop(); this._radar = null; }
    if (on && this._map) this._radar = createRadar(this._map);
  }

  _applyTheme() {
    // The tiles only come in a light style, so dark mode recolours them in CSS.
    this._mapEl.classList.toggle('dark', !!this._dark);
  }

  // ----- the tracker picture -------------------------------------------------------

  _haImageUrl() {
    const state = this._hass && this._hass.states[this._config.image_entity || this._found.hub.tracker];
    if (!state || state.state === 'unavailable' || !state.attributes.entity_picture) return null;
    return this._hass.hassUrl ? this._hass.hassUrl(state.attributes.entity_picture) : state.attributes.entity_picture;
  }

  async _refresh() {
    if (!this._map || this._refreshing) return;
    this._refreshing = true;
    const source = this._config.source;
    const attempts = [];
    // The same address for everyone inside a 5-minute window, so the Bureau's cache can answer.
    if (source !== 'home_assistant') attempts.push(['bom', `${IMAGE_URL}?seq=${Math.floor(Date.now() / REFRESH_MS)}`]);
    this._haTried = source !== 'bom' ? this._haImageUrl() : null;
    if (this._haTried) attempts.push(['home_assistant', this._haTried]);
    let shown = null;
    for (const [name, url] of attempts) {
      try {
        this._overlay.show(await loadImage(url));
        shown = name;
        break;
      } catch (_) { /* try the next source */ }
    }
    if (!shown) this._overlay.hide();
    this._shown = shown;
    this._shownUrl = shown ? attempts.find(([name]) => name === shown)[1] : null;
    this._loading = false;
    this._loadedAt = Date.now();
    this._refreshing = false;
    this._update();
  }

  // ----- following Home Assistant ----------------------------------------------------

  _position(entityId) {
    const state = this._hass.states[entityId];
    if (!state) return null;
    let { latitude, longitude } = state.attributes;
    if ((latitude == null || longitude == null) && state.state === 'home') {
      ({ latitude, longitude } = this._hass.config);
    }
    return typeof latitude === 'number' && typeof longitude === 'number' ? [latitude, longitude] : null;
  }

  _name(entityId) {
    const state = this._hass.states[entityId];
    return (state && state.attributes.friendly_name) || entityId;
  }

  _update() {
    const hass = this._hass;
    if (!hass || !this._map) return;
    const dark = !!(hass.themes && hass.themes.darkMode);
    if (dark !== this._dark) { this._dark = dark; this._applyTheme(); }
    this._setBaseLayer();

    // A picture held by Home Assistant changes its address when a new one arrives.
    if (this._shown === 'home_assistant' && this._haImageUrl() !== this._shownUrl) this._refresh();
    // Nothing could be shown earlier and Home Assistant has a picture it did not have then.
    // (Only then: this runs on every state change, and must not turn into a retry loop.)
    if (!this._shown && !this._loading && this._config.source !== 'bom'
        && this._haImageUrl() && this._haImageUrl() !== this._haTried) this._refresh();

    const wanted = new Set(this._config.entities);
    for (const [id, marker] of this._markers) {
      if (!wanted.has(id)) { marker.remove(); this._markers.delete(id); }
    }
    this._config.entities.forEach((id) => {
      const at = this._position(id);
      let marker = this._markers.get(id);
      if (!at) { if (marker) { marker.remove(); this._markers.delete(id); } return; }
      if (!marker) {
        marker = new Marker(at, { icon: this._icon(id), interactive: true, keyboard: false, title: this._name(id) });
        marker.addTo(this._map);
        this._markers.set(id, marker);
      } else marker.setLatLng(at);
    });

    const first = this._config.entities[0] || null;
    const centre = first ? this._position(first) : null;
    const place = first ? placeFor(this._found, hass.states, first) : null;
    const nearby = place && hass.states[place.storm_nearby];
    const radius = Number(this._config.alert_radius) || (nearby && Number(nearby.attributes.radius_km)) || null;
    if (centre && radius) {
      if (!this._ring) {
        this._ring = new Circle(centre, {
          radius: radius * 1000, color: '#1a73e8', weight: 2, fillOpacity: 0.06, interactive: false,
        }).addTo(this._map);
      } else { this._ring.setLatLng(centre); this._ring.setRadius(radius * 1000); }
    } else if (this._ring) { this._ring.remove(); this._ring = null; }

    if (!this._centred) {
      this._map.setView(centre || [hass.config.latitude, hass.config.longitude], this._config.zoom, { animate: false });
      this._centred = true;
    }

    const status = describeStatus({
      shown: this._shown,
      loading: this._loading,
      found: this._found,
      states: hass.states,
      target: first,
      targetName: first ? this._name(first) : '',
    });
    this._status.textContent = status.text;
    this._status.classList.toggle('warn', status.warn);
    const description = this._config.show_description ? status.description : null;
    this._description.textContent = description || '';
    this._description.hidden = !description;
  }

  _icon(entityId) {
    const state = this._hass.states[entityId];
    const el = document.createElement('div');
    el.className = 'place';
    const picture = state && state.attributes.entity_picture;
    if (picture) {
      el.style.backgroundImage = `url("${this._hass.hassUrl ? this._hass.hassUrl(picture) : picture}")`;
    } else if (entityId.startsWith('zone.')) {
      const icon = document.createElement('ha-icon');
      icon.setAttribute('icon', (state && state.attributes.icon) || 'mdi:home');
      el.appendChild(icon);
    } else {
      el.textContent = this._name(entityId).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    }
    return new DivIcon({ html: el, className: '', iconSize: [30, 30], iconAnchor: [15, 15] });
  }
}

if (!customElements.get(TYPE)) {
  customElements.define(TYPE, SeqThunderstormTrackerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: TYPE,
    name: 'SEQ Thunderstorm Tracker',
    description: 'The Bureau of Meteorology’s Thunderstorm Tracker (Southeast Queensland pilot) on a map, with your places and alert distance.',
    preview: false,
    documentationURL: 'https://github.com/j0rdsta/seq-thunderstorm-tracker/blob/main/docs/home-assistant.md',
  });
  console.info(`%c SEQ Thunderstorm Tracker card %c ${VERSION} `, 'background:#cc7833;color:#fff', 'background:#333;color:#fff');
}
