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
- **Plays along with the radar loop**: as BoM's radar loop plays (or you drag the timeline), the overlay
  switches to the tracker image issued for that radar time, so you can watch storms move. BoM only
  publishes the *latest* tracker image, so the script saves each new storm picture in your
  browser as it arrives. BoM re-renders the image every minute, but the storms only change with each radar
  scan (about every 5 minutes), so duplicate frames are skipped (IndexedDB, last 2 hours, up to 30 images, about 3 MB). That means the history
  only covers time when you had a BoM page open; radar frames without a saved image show no overlay.
- **"Last updated" line**: below the map, alongside BoM's *Observations* and *Forecast* lines, e.g.
  `Thunderstorm tracker: 1 minute ago, 12:42 pm AEST (16 storm cells, 6 images saved for the radar loop)`,
  with *Refresh*, *Hide/Show* and *Settings* links. It turns red if the tracker hasn't updated for 20 minutes.
- **Tracking description**: below the map, the tracker's plain-English summary from the Bureau, e.g.
  *"At 12:00 pm, thunderstorms were detected on the weather radar near Gatton … They are forecast to
  affect Laidley … by 12:15 pm and Ipswich, Toowoomba and Kilcoy by 12:30 pm."*, with the Bureau's legend
  icons. An **About the thunderstorm tracker** accordion sits next to BoM's *About this map*.
- **Experimental storm paths (off by default)**: turn on *Storm paths and 20-minute estimate* in
  settings to see a line showing where each storm has been (from saved tracker images) and a shaded cone
  with a rough guess of where it might be in 10 and 20 minutes. **This is not a Bureau forecast.**
  It's a simple extrapolation that ignores storms growing, decaying, splitting, merging or turning, and it
  needs about 15 minutes of saved images. Don't use it to make safety decisions; follow the Bureau's warnings.
- **Settings in BoM's own dialog**: open **More weather** (or click *Settings* in the status line). Under
  *Map settings* there's a **Thunderstorm tracker (SEQ pilot)** section built from the site's own controls:
  - Thunderstorm tracker on/off (also **Shift+T**)
  - Match the radar timeline (on by default); turn off to always show the latest image
  - Show tracker coverage area (dashed outline)
  - Overlay opacity: 50%, 85% or 100%
  - Storm colour: orange, magenta or black
  - Check for updates every 1, 2, 5 or 10 minutes
  - Adjust alignment in 0.5 km steps, in case the overlay looks slightly off
  - Storm paths and 20-minute estimate (experimental)
  - Clear saved images

  Settings are saved in your browser.
- **Auto-refresh** with a cheap HTTP revalidation, so the image is only downloaded when BoM publishes
  a new one (typically every 5–10 minutes). There are never more than 2 requests a minute, and it pauses
  while the tab is in the background.

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

- **Experimental storm paths are a rough guess.** A storm is only linked between images when the match is
  unambiguous (similar size, consistent with its recent motion, and clearly the best match both ways).
  Paths end at merges, splits or missed scans instead of jumping between storms. The estimate uses the
  median of the storm's recent movements and stops at 20 minutes. In a small backtest (22 outcomes over
  39 minutes of one afternoon), the typical position error was about 4 km at 5–20 minutes ahead. BoM's own
  arrows and 10/20/30-minute arcs remain the better guide.
- The script only runs on bom.gov.au **location pages** (`/location/...`), which is where the radar map is.
  If BoM adds the map to other pages, widen `@match` in the script header.

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
