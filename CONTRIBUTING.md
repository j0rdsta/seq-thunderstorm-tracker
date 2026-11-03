# Contributing

Issues and pull requests are welcome.

## Development

There is no build step. The userscript is the single file `seq-thunderstorm-tracker.user.js`.
Its pure helpers are exported via `module.exports` when it is loaded under Node, so they can be unit-tested:

```sh
npm test
```

To try changes, paste the file into a new Tampermonkey/Violentmonkey script, or paste it into DevTools
on a BoM location page (scroll down so the "Weather map" loads first). `window.__seqThunderstormTracker`
exposes the internal state for debugging.

## Please be kind to the Bureau

- **Don't add scraping, headless-browser or automated access to bom.gov.au.** The Bureau blocks automated
  clients and asks people not to scrape the site. The script only makes the request a person's own
  browser would make while they're viewing the map.
- Keep the minimum refresh interval at 30 s or more. The image changes every few minutes.
- Don't commit BoM imagery to the repo. Tests use synthetic pixels.

## Recalibrating the alignment

If BoM changes the tracker image's extent, update `CORNERS` in the userscript:

1. Find the pixel centres of the town marker dots in `IDA00050.png`.
2. Fit an affine transform from Web Mercator (EPSG:3857) metres to image pixels by least squares.
3. Write the image-pixel → Mercator positions of pixel corners (0,0), (W,0) and (0,H) into `CORNERS`.
4. Update `TOWNS` in `test/core.test.mjs` and run `npm test`.

## Releasing

Bump `@version` in the userscript header **and** `version` in `package.json` (a test checks they match),
add a `CHANGELOG.md` entry, and push to `main`. Userscript managers pick up updates through `@updateURL`.
