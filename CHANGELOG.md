# Changelog

All notable changes to this project are documented here. This project uses [Semantic Versioning](https://semver.org/).

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
