# Centralise the repo and add Home Assistant, notifications and an iOS widget

## Why

The project is one userscript. Jordan wants the same tracker on a Home Assistant dashboard, on an
iPhone, and as a notification when a storm is within a set distance of where he is.

## What we found first

- BoM answers non-browser clients with `403` for `IDA00050.png`, and the image is not on the
  anonymous FTP server. Home Assistant cannot fetch it without dodging that block, so it does not.
- A browser on another origin can display the image (`<img>` loads) but cannot read its pixels
  (no CORS header). So a dashboard card can show the live tracker, but cannot measure anything.
- BoM's page CSP (`connect-src`) stops page scripts calling other hosts, so the overlay userscript
  (`@grant none`) cannot post to Home Assistant.

## What changes

- **Repo layout**: shared `packages/core` (ES modules), `userscripts/overlay`, `userscripts/bridge`,
  `card`, `custom_components/seq_thunderstorm_tracker`, `blueprints`, `ios`. Rollup builds the two
  userscripts and the card. The built overlay stays at the repo root so `@updateURL` keeps working.
- **Overlay userscript**: same behaviour, now built from the shared core.
- **Bridge userscript** (new, opt-in): runs in the person's own browser on BoM pages, reads the
  tracker image same-origin, works out storm positions and posts a snapshot to a Home Assistant
  webhook with `GM_xmlhttpRequest`. At most one image request every 5 minutes, one tab at a time.
- **Home Assistant integration** (new): webhook receiver, distance sensors per tracked zone or
  person, a "storm nearby" binary sensor, a bridge status sensor, image entities (raw tracker image
  and a cropped map with a marker and alert ring). Entities go unavailable when the feed is stale.
- **Dashboard card** (new, shipped inside the integration): Leaflet map with the tracker overlay
  keyed out by an SVG filter and georeferenced with the same affine as the userscript. Loads the
  image straight from BoM in the viewer's browser, and falls back to the image the bridge sent.
- **Notification blueprint** (new): alert when the nearest storm is closer than a chosen distance,
  with the map attached.
- **iOS** (new): a Scriptable widget that reads the map image and distance from Home Assistant.

## Decisions

- No server-side or headless access to bom.gov.au, as before. The bridge is a real browser tab.
- The bridge is a separate script so the overlay keeps `@grant none` and its page-context access.
- Analysis happens once, in JavaScript (the existing core). Python only measures distances and draws.
- Distances use the Bureau's own drawing: cell ellipses for "nearest storm", and its arrows and
  10/20/30-minute arcs for "nearest forecast track". The experimental paths are not used.
- Stale data is shown as unavailable, never as "no storms".
- Nothing is deployed to the live Home Assistant from this change: the smart-home repo requires a
  Proxmox snapshot first, and that tool is not available here.
