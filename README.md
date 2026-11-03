# BoM SEQ Thunderstorm Tracker Overlay

A userscript that draws the Bureau of Meteorology's
[**Thunderstorm Tracker – Southeast Queensland Pilot**](https://www.bom.gov.au/qld/forecasts/brisbane-thunderstorms.shtml)
directly on the interactive radar map on bom.gov.au location pages (e.g.
[Clayfield](https://www.bom.gov.au/location/australia/queensland/southeast-coast/o4388484015-clayfield#today)).
You see BoM's tracked storm cells and their estimated positions at +10, +20 and +30 minutes on top of the
live rain radar. The overlay follows the map as you pan and zoom, and refreshes itself automatically.

> **Unofficial.** Not affiliated with or endorsed by the Bureau of Meteorology. The tracker is a BoM
> *pilot* product and only covers Southeast Queensland. Always check BoM's official warnings.

## Install

1. Install a userscript manager:
   [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Edge, Firefox, Safari) or
   [Violentmonkey](https://violentmonkey.github.io/) (Chrome, Edge, Firefox).
   - **Chrome / Edge:** userscripts need extra permission there. Open the extension's details page
     (`chrome://extensions` → Tampermonkey → *Details*) and turn on **Allow User Scripts**.
     On older Chrome versions, turn on **Developer mode** in `chrome://extensions` instead.
2. Click **[Install the userscript](https://github.com/j0rdsta/seq-thunderstorm-tracker/raw/main/seq-thunderstorm-tracker.user.js)**
   and confirm in the userscript manager.
3. Open any bom.gov.au location page in Southeast Queensland and scroll to **Weather map**.

Updates install automatically through your userscript manager.

## Features

- **Aligned overlay**: storm cells, movement arrows and forecast arcs are drawn on the radar map in the
  right place at every zoom level. The tracker's basemap (land, sea, borders, labels) is keyed out, so
  you still see the radar underneath.
- **Auto-refresh** every 1 minute by default (configurable from 30 s to 10 min). It uses a cheap ETag
  check, so the image is only downloaded when BoM publishes a new one, and it pauses while the tab is in
  the background.
- **Status chip** on the map: issue time and age (e.g. `2:40 pm (3 min ago)`), the number of tracked
  cells or *no tracked storms*, a red **stale** warning if the tracker is more than 20 minutes old, and
  *outside SEQ coverage* when you've panned away.
- **Settings** (⚙): on/off switch (also **Shift+T**), opacity, refresh interval, colour (original orange,
  high-contrast magenta, or black), a dashed **coverage box** showing the tracker's extent, and **alignment
  nudge** buttons in 0.5 km steps. Settings are saved in your browser.
- **↻** forces an immediate refresh.

## How it works

- The new bom.gov.au map is an [ArcGIS Maps SDK for JavaScript](https://developers.arcgis.com/javascript/)
  `MapView` in Web Mercator. The script finds that view through React's internal fiber tree on the
  `.esri-view` element. That's why it runs in the page context (`@grant none`).
- It fetches `https://www.bom.gov.au/fwo/IDA00050.png`, the same image the tracker page shows. That's a
  normal same-origin request from your own browser.
- The image's basemap is removed with a hue/saturation key: storms are drawn in orange, the basemap is
  desaturated tan/blue/grey.
- **Alignment:** the image's position was found by locating 13 town marker dots on it (Noosa Heads,
  Kingaroy, Maroochydore, Caloundra, Caboolture, Redcliffe, Brisbane CBD, Cleveland, Toowoomba, Ipswich,
  Logan, Beenleigh, Warwick) and fitting an affine transform to their real coordinates in Web Mercator.
  The fit residual is about 1.5 px RMS on the source image (roughly 0.7 km). The live overlay was checked
  against ArcGIS's own `view.toScreen()` to within a pixel at regional zoom levels. The image appears to
  use a slightly different projection, so expect up to ~1–2 km of error in the corners. Use the nudge
  buttons if it looks off.

## Limitations

- **Southeast Queensland only.** As far as we know, no other region has a Thunderstorm Tracker product.
- It depends on undocumented internals of bom.gov.au (React fiber layout, ArcGIS `MapView`) and on
  the tracker image's fixed extent. If BoM redesigns either, the overlay may stop appearing or drift.
  Please [open an issue](https://github.com/j0rdsta/seq-thunderstorm-tracker/issues) if that happens.
- The tracker is a pilot product and may change or be withdrawn by BoM at any time.

## Development

```sh
npm test    # unit tests (Node ≥ 20, no dependencies)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Please don't add automated or headless access to bom.gov.au.
The Bureau blocks it and asks people not to scrape the site.

## Licence and attribution

Code: [MIT](LICENSE) © 2026 j0rdsta.

Thunderstorm Tracker imagery and radar data © Commonwealth of Australia, Bureau of Meteorology.
This project does not host or redistribute BoM content. The script only displays what your browser loads
from bom.gov.au while you view it. See BoM's [copyright notice](https://www.bom.gov.au/other/copyright.shtml).
