/**
 * What the card says under the map. Pure, so it can be tested without a browser.
 */

import { formatIssued } from '../../packages/core/time.js';

export const DOMAIN = 'seq_thunderstorm_tracker';

const UNUSABLE = new Set(['unavailable', 'unknown', undefined, null, '']);
const usable = (state) => !!state && !UNUSABLE.has(state.state);

/**
 * Find the integration's entities in the frontend's entity registry.
 * @returns {{ hub: Record<string,string>, places: Record<string, Record<string,string>> }}
 *   `hub` maps translation keys to entity ids; `places` does the same per device.
 */
export function discover(entities) {
  const found = { hub: {}, places: {} };
  for (const e of Object.values(entities || {})) {
    if (!e || e.platform !== DOMAIN || !e.translation_key) continue;
    if (['storms', 'issued', 'bridge', 'tracker'].includes(e.translation_key)) found.hub[e.translation_key] = e.entity_id;
    else if (e.device_id) (found.places[e.device_id] = found.places[e.device_id] || {})[e.translation_key] = e.entity_id;
  }
  return found;
}

/** The place device whose sensors measure from `target`, if its sensors say so. */
export function placeFor(found, states, target) {
  for (const place of Object.values(found.places)) {
    for (const id of Object.values(place)) {
      const state = states[id];
      if (state && state.attributes && state.attributes.target === target) return place;
    }
  }
  return null;
}

/**
 * @param {object} o
 * @param {'bom'|'home_assistant'|null} o.shown which picture is on the map (null: none loaded)
 * @param {boolean} o.loading
 * @param {ReturnType<typeof discover>} o.found
 * @param {Record<string, any>} o.states hass.states
 * @param {string|null} o.target entity id of the first place on the card
 * @param {string} o.targetName
 * @returns {{ text:string, warn:boolean, description:string|null }}
 */
export function describeStatus({ shown, loading = false, found, states, target, targetName }) {
  const installed = Object.keys(found.hub).length > 0;
  const bridge = states[found.hub.bridge];
  const storms = states[found.hub.storms];
  const issued = states[found.hub.issued];
  const current = !!bridge && bridge.state === 'on' && usable(storms);
  const issuedText = usable(issued) ? formatIssued(new Date(issued.state)) : null;

  if (!shown && !loading) {
    return { text: 'The thunderstorm tracker picture could not be loaded.', warn: true, description: null };
  }
  if (!installed || !current) {
    const lead = shown === 'bom' || loading
      ? 'Live picture from the Bureau’s Thunderstorm Tracker.'
      : `Picture from the Bureau’s Thunderstorm Tracker${issuedText ? `, issued ${issuedText}` : ''}.`;
    if (!installed) return { text: lead, warn: false, description: null };
    return {
      text: `${lead} Distances are unavailable: the Home Assistant bridge ${issuedText ? `last sent a picture issued ${issuedText}` : 'has not sent anything yet'}.`,
      warn: true,
      description: null,
    };
  }

  const count = Number(storms.state);
  const parts = [`Tracker issued ${issuedText || 'recently'}`];
  parts.push(count === 0 ? 'no tracked storms' : `${count} storm cell${count === 1 ? '' : 's'}`);
  const place = target ? placeFor(found, states, target) : null;
  const nearest = place && states[place.nearest_storm];
  const track = place && states[place.nearest_forecast_track];
  const km = (state) => `${Math.round(Number(state.state))} km`;
  if (usable(nearest)) {
    parts.push(`nearest ${km(nearest)} ${nearest.attributes.direction || ''} of ${targetName}`.replace('  ', ' '));
    if (usable(track) && Number(track.state) < Number(nearest.state) - 1) {
      parts.push(`forecast track within ${km(track)}`);
    }
  } else if (nearest && nearest.attributes && nearest.attributes.in_coverage === false) {
    parts.push(`${targetName} is outside Southeast Queensland`);
  }
  return {
    text: parts.join(' · '),
    warn: false,
    description: (storms.attributes && storms.attributes.description) || null,
  };
}
