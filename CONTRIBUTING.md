# Contributing

Issues and pull requests are welcome.

## Layout

| Path | What it is |
|---|---|
| `packages/core/` | Shared, DOM-free JavaScript: georeference, chroma key, storm detection, snapshot builder, SVG key filter. |
| `userscripts/overlay/` | Source of the overlay userscript. Built to `seq-thunderstorm-tracker.user.js` in the repo root. |
| `userscripts/bridge/` | Source of the Home Assistant bridge. Built to `seq-thunderstorm-tracker-ha-bridge.user.js`. |
| `card/` | Source of the dashboard card. Built into `custom_components/seq_thunderstorm_tracker/frontend/`. |
| `custom_components/seq_thunderstorm_tracker/` | The Home Assistant integration (Python). |
| `blueprints/` | The notification blueprint. |
| `ios/` | The Scriptable widget. |
| `scripts/` | The build, and `replay.mjs` for posting a saved tracker image to a webhook. |
| `test/js/`, `test/python/` | Tests. `test/fixtures/georef.json` is read by both, so the Python copy of the georeference cannot drift from the JavaScript one. |

## Development

```sh
npm install
npm run build        # Rollup: the two userscripts (readable, comments kept) and the card (minified)
npm test             # node --test
npm run test:python  # pytest in a throwaway Home Assistant, via uv
```

The built files are committed. The overlay has to stay at the repo root because every installed
copy updates from that address (`@updateURL`), and Home Assistant serves the card from inside the
integration. CI runs `node scripts/build.mjs --check` and fails when a built file is out of date,
so run `npm run build` before you commit.

To try the overlay or the bridge, install the built file in Tampermonkey or Violentmonkey.
`window.__seqThunderstormTracker` exposes the overlay's internal state for debugging. To try the
card without Home Assistant, serve the repo and open `card/preview.html`. To try the integration
on a quiet day, post a saved image with `scripts/replay.mjs`.

## Please be kind to the Bureau

- **Don't add server-side, scraping, headless-browser or automated access to bom.gov.au.** The
  Bureau blocks automated clients and asks people not to scrape the site. Home Assistant must never
  fetch it. Everything here runs in a person's own browser: the overlay and the card while they are
  looking, and the bridge in a tab they chose to leave open.
- Keep the request budgets: the overlay at most twice a minute and paused in background tabs, the
  bridge once every 5 minutes across all tabs, the card once every 5 minutes with an address that
  every viewer shares so the Bureau's cache can answer.
- Don't commit BoM imagery to the repo. Tests use synthetic pixels.
- Old data must never read as clear skies. A stale feed makes things unavailable.

## Recalibrating the alignment

If BoM changes the tracker image's extent, update `CORNERS` in `packages/core/georef.js`:

1. Find the pixel centres of the town marker dots in `IDA00050.png`.
2. Fit an affine transform from Web Mercator (EPSG:3857) metres to image pixels by least squares.
3. Write the image-pixel → Mercator positions of pixel corners (0,0), (W,0) and (0,H) into `CORNERS`.
4. Copy the same three corners into `custom_components/seq_thunderstorm_tracker/geo.py`.
5. Update `TOWNS` in `test/js/towns.mjs`, run `node scripts/make-fixtures.mjs`, then both test suites.

## Releasing

Set the version in `package.json`, `pyproject.toml` and the integration's `manifest.json` (tests
check they match), run `npm run build` so the userscript headers and the card pick it up, add a
`CHANGELOG.md` entry, and push to `main`. Userscript managers pick up updates through `@updateURL`.
Tag the release so Home Assistant offers it as an update.
