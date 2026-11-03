# Changelog

All notable changes to this project are documented here. This project uses [Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-11-03

### Changed
- **More cautious experimental storm paths**, based on a backtest against saved tracker images:
  - Storms are only linked between images by an unambiguous mutual-best match on motion and size.
    Paths now end at merges, splits, missed scans or big size changes instead of jumping to a different storm.
  - The estimate starts from the storm's latest position and uses its median recent velocity, which is
    less sensitive to a single wobbly position.
  - The horizon is cut from 60 to **20 minutes** (markers at 10 and 20). Nothing in the data supported 60.
  - In a small backtest (22 outcomes), mean position error fell from 4.17 to 3.94 km. Direction error
    didn't improve (16.5° → 18.3°), so the sample is too small to claim more than that.

## [0.4.0] - 2026-11-03

### Added
- **Tracking description under the map**: the tracker page's plain-English summary ("At 12:00 pm,
  thunderstorms were detected near … forecast to affect … by 12:30 pm") appears below the radar map
  with BoM's own legend icons, in the page's body text styles. It refreshes whenever a new tracker image is published.
- **"About the thunderstorm tracker" accordion** next to BoM's "About this map". It covers what the tracker
  shows, BoM's severe thunderstorm warning criteria, the experimental paths and attribution.
- **Experimental storm paths** (off by default): links storm cells across saved tracker images into
  paths and draws a rough straight-line estimate of where each might be in 60 minutes, as a widening
  cone. It's labelled as unofficial and not for safety decisions everywhere it appears.

### Fixed
- Saved history no longer fills up with duplicates. BoM re-renders the tracker image every minute (only the
  "Issued at" stamp changes), so images are now compared by their storm content and only real updates
  (about every 5 minutes) are kept.

## [0.3.0] - 2026-11-03

### Added
- **Radar loop playback**: each tracker image is saved in the browser (IndexedDB, last 2 hours, up to 30
  images), and the overlay shows the image that matches the radar time on screen as BoM's loop plays or
  you scrub. BoM only publishes the latest image, so history builds up while a BoM page is open. There's
  a "Match the radar timeline" option (on by default) and a "Clear saved images" button.

### Changed
- The tracker status now appears as a line in BoM's **Last updated** block below the map, in the same
  wording as the other lines (`Thunderstorm tracker: 1 minute ago, 12:42 pm AEST (16 storm cells)`).
- Replaced "Hide when paused on an earlier radar time" with the timeline matching above.

## [0.2.0] - 2026-11-03

### Added
- Settings now live in BoM's own **More weather** dialog, under *Map settings*, as a "Thunderstorm tracker (SEQ
  pilot)" section built from the site's checkbox, radio and button styles.
- A tracker status line under the radar timeline, in the same style as BoM's timeline label: issue time
  and age, storm cell count, and *Refresh*, *Hide/Show* and *Settings* links.
- Option to hide the overlay when the radar loop is paused on an earlier radar time. The tracker only
  describes the present, so it shouldn't sit over old radar.

### Changed
- Removed the floating chip on the map. Its controls moved to the dialog and the status line.
- Times are shown the way BoM shows them (e.g. `12:26pm AEST`).
- Refresh interval options are now 1, 2, 5 and 10 minutes.

## [0.1.0] - 2026-11-03

### Added
- First release: overlays the BoM Thunderstorm Tracker (SEQ pilot, `IDA00050.png`) on the bom.gov.au
  ArcGIS radar map, georeferenced to Web Mercator and following pan and zoom.
- Chroma key keeps only the storm cells, movement arrows and forecast arcs.
- Auto-refresh (30 s – 10 min, default 1 min) using ETag checks; pauses in background tabs.
- Status chip showing issue time and age, a stale warning, cell count, and an outside-coverage notice.
- Runs only on bom.gov.au location pages (`/location/*`), where the radar map lives.
- Settings: on/off (Shift+T), opacity, refresh interval, colour mode, coverage box, alignment nudge.
