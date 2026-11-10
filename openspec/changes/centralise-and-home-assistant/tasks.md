# Tasks

## 1. Repo layout and build
- [x] 1.1 Split the userscript's pure helpers into `packages/core` ES modules
- [x] 1.2 Move the overlay runtime to `userscripts/overlay`, build to the root `.user.js` with Rollup
- [x] 1.3 Move tests to `test/js`, import the core directly, keep all existing tests passing
- [x] 1.4 CI: build is reproducible, JS and Python tests run

## 2. Analysis for Home Assistant
- [x] 2.1 Core: cell ellipses, pixel to lon/lat, forecast points, snapshot builder
- [x] 2.2 Core: SVG filter spec matching `stormAlpha`, tested against the keep and drop colours

## 3. Bridge userscript
- [x] 3.1 Fetch, analyse and post snapshots (one tab, 5-minute cadence, heartbeat without image)
- [x] 3.2 Menu commands for the webhook URL, send now and status

## 4. Home Assistant integration
- [x] 4.1 Pure modules: geo, snapshot validation, proximity, map rendering (Pillow)
- [x] 4.2 Config and options flow, webhook, coordinator with staleness
- [x] 4.3 Sensors, binary sensors, image entities
- [x] 4.4 Serve and register the card
- [x] 4.5 pytest: pure modules and the integration in a test Home Assistant

## 5. Dashboard card
- [x] 5.1 Leaflet map, tracker overlay (SVG filter + affine), markers, alert ring, status
- [x] 5.2 Sources: BoM direct, Home Assistant image, auto fallback; optional rain radar
- [x] 5.3 Visual editor, card picker entry, sizing

## 6. Notifications and iOS
- [x] 6.1 Blueprint: storm within a distance, map attached, quiet time between notifications (the all clear was dropped: "no storms" reads as unknown, so there is no reliable crossing to trigger on)
- [x] 6.2 Scriptable widget

## 7. Verify and document
- [x] 7.1 Rebuilt overlay works on a live BoM location page
- [x] 7.2 End to end on a local Home Assistant: webhook, entities, card in a browser
- [x] 7.3 README, docs, CONTRIBUTING, CHANGELOG, version 0.6.0

## 8. Left for Jordan
- [ ] 8.1 Install the bridge in a real userscript manager and confirm it can post to Home Assistant (only tested with stand-ins for the `GM_*` functions)
- [ ] 8.2 Install on the live Home Assistant after a Proxmox snapshot
- [ ] 8.3 Try the Scriptable widget on a phone (only tested against stand-ins for Scriptable's API)
- [ ] 8.4 Merge to `main` and tag `v0.6.0` when happy: that is what updates every installed overlay
