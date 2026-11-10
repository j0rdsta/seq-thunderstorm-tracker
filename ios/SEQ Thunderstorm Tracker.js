// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: orange; icon-glyph: bolt;

/*
 * SEQ Thunderstorm Tracker widget for Scriptable (https://scriptable.app).
 *
 * Shows the map and the distance to the nearest tracked storm from your Home Assistant, which
 * gets them from the bridge userscript. It talks only to your Home Assistant, never to
 * bom.gov.au.
 *
 * Setting up:
 *   1. In Home Assistant, open your profile, Security, and create a long-lived access token.
 *   2. Add this script to Scriptable and run it once. It asks for your Home Assistant address
 *      and the token, and keeps them in the iOS Keychain.
 *   3. Add a Scriptable widget to your Home Screen or Lock Screen and choose this script.
 *
 * To watch another place, put its entity names in the widget's Parameter field, separated by
 * commas: the map image, then the "Nearest storm" sensor. For example:
 *   image.thunderstorms_near_jordan_map, sensor.thunderstorms_near_jordan_nearest_storm
 *
 * Not affiliated with the Bureau of Meteorology. Not a warning service.
 */

const DEFAULTS = {
  map: 'image.thunderstorms_near_home_map',
  distance: 'sensor.thunderstorms_near_home_nearest_storm',
  bridge: 'binary_sensor.seq_thunderstorm_tracker_bridge',
  open: 'https://www.bom.gov.au/qld/forecasts/brisbane-thunderstorms.shtml',
};
const KEY_URL = 'seq-thunderstorm-tracker.url';
const KEY_TOKEN = 'seq-thunderstorm-tracker.token';
const REFRESH_MINUTES = 5;
const ORANGE = new Color('#cc7833');

/** What to say, given the sensor and bridge states (null when one could not be read). */
function summarise(distance, bridge) {
  const live = bridge && bridge.state === 'on';
  if (!distance && !bridge) {
    return { headline: 'No connection', detail: 'Home Assistant did not answer', tone: 'off' };
  }
  if (!live) {
    return { headline: 'No tracker data', detail: 'Open a BoM tab with the bridge running', tone: 'off' };
  }
  const attrs = (distance && distance.attributes) || {};
  const issued = attrs.issued ? formatTime(new Date(attrs.issued)) : null;
  const stamp = issued ? `Tracker ${issued}` : 'Thunderstorm Tracker';
  if (attrs.in_coverage === false) {
    return { headline: 'Out of area', detail: 'Tracker covers Southeast Queensland', tone: 'quiet' };
  }
  const km = distance ? Number(distance.state) : NaN;
  if (!Number.isFinite(km)) {
    return { headline: 'No storms', detail: stamp, tone: 'quiet' };
  }
  return {
    headline: `${Math.round(km)} km${attrs.direction ? ` ${attrs.direction}` : ''}`,
    detail: `Nearest storm · ${stamp}`,
    tone: 'storm',
  };
}

function formatTime(date) {
  const f = new DateFormatter();
  f.dateFormat = 'h:mm a';
  return f.string(date).toLowerCase();
}

async function credentials() {
  if (Keychain.contains(KEY_URL) && Keychain.contains(KEY_TOKEN)) {
    return { url: Keychain.get(KEY_URL), token: Keychain.get(KEY_TOKEN) };
  }
  if (config.runsInWidget) return null;
  const ask = new Alert();
  ask.title = 'Home Assistant';
  ask.message = 'Your Home Assistant address (as you reach it away from home) and a long-lived access token. Both stay in the iOS Keychain on this device.';
  ask.addTextField('https://example.ui.nabu.casa');
  ask.addSecureTextField('Long-lived access token');
  ask.addAction('Save');
  ask.addCancelAction('Cancel');
  if ((await ask.present()) === -1) return null;
  const url = ask.textFieldValue(0).trim().replace(/\/+$/, '');
  const token = ask.textFieldValue(1).trim();
  if (!/^https?:\/\//.test(url) || !token) return null;
  Keychain.set(KEY_URL, url);
  Keychain.set(KEY_TOKEN, token);
  return { url, token };
}

async function readState(ha, entityId) {
  try {
    const req = new Request(`${ha.url}/api/states/${entityId}`);
    req.headers = { Authorization: `Bearer ${ha.token}` };
    req.timeoutInterval = 15;
    const state = await req.loadJSON();
    return state && typeof state.state === 'string' ? state : null;
  } catch (_) {
    return null;
  }
}

async function readImage(ha, entityId) {
  try {
    const req = new Request(`${ha.url}/api/image_proxy/${entityId}`);
    req.headers = { Authorization: `Bearer ${ha.token}` };
    req.timeoutInterval = 20;
    return await req.loadImage();
  } catch (_) {
    return null;
  }
}

/** The map with a dark band along the bottom, so the text stays readable over it. */
function withBand(image) {
  const size = image.size;
  const ctx = new DrawContext();
  ctx.size = size;
  ctx.opaque = true;
  ctx.respectScreenScale = false;
  ctx.drawImageInRect(image, new Rect(0, 0, size.width, size.height));
  ctx.setFillColor(new Color('#000000', 0.55));
  ctx.fillRect(new Rect(0, size.height * 0.68, size.width, size.height * 0.32));
  return ctx.getImage();
}

function addText(stack, text, font, colour, lines = 1) {
  const t = stack.addText(text);
  t.font = font;
  t.textColor = colour;
  t.lineLimit = lines;
  t.minimumScaleFactor = 0.6;
  return t;
}

async function build() {
  const params = String(args.widgetParameter || '').split(',').map((p) => p.trim()).filter(Boolean);
  const entities = { ...DEFAULTS, map: params[0] || DEFAULTS.map, distance: params[1] || DEFAULTS.distance };
  const family = config.widgetFamily || 'medium';
  const lockScreen = family.startsWith('accessory');

  const widget = new ListWidget();
  widget.url = entities.open;
  widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);

  const ha = await credentials();
  if (!ha) {
    addText(widget, 'Thunderstorm tracker', Font.semiboldSystemFont(13), Color.white());
    addText(widget, 'Open this script in Scriptable to set it up', Font.systemFont(11), Color.lightGray(), 3);
    widget.backgroundColor = new Color('#1c1c1e');
    return widget;
  }

  const [distance, bridge] = await Promise.all([readState(ha, entities.distance), readState(ha, entities.bridge)]);
  const say = summarise(distance, bridge);

  if (lockScreen) {
    if (family === 'accessoryInline') {
      addText(widget, `⚡ ${say.headline}`, Font.systemFont(12), Color.white());
    } else {
      addText(widget, say.tone === 'storm' ? `⚡ ${say.headline}` : say.headline, Font.semiboldSystemFont(family === 'accessoryCircular' ? 12 : 16), Color.white(), 2);
      if (family === 'accessoryRectangular') addText(widget, say.detail, Font.systemFont(11), Color.white(), 2);
    }
    return widget;
  }

  const image = say.tone === 'off' ? null : await readImage(ha, entities.map);
  if (image) widget.backgroundImage = withBand(image);
  else widget.backgroundColor = new Color('#1c1c1e');

  widget.setPadding(10, 12, 10, 12);
  widget.addSpacer();
  addText(widget, say.headline, Font.boldSystemFont(family === 'small' ? 20 : 26), say.tone === 'storm' ? ORANGE : Color.white());
  addText(widget, say.detail, Font.systemFont(family === 'small' ? 10 : 12), Color.white(), 2);
  return widget;
}

const widget = await build();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
