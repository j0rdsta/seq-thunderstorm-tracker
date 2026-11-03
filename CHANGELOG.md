# Changelog

All notable changes to this project are documented here. This project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-03

### Added
- First release: overlays the BoM Thunderstorm Tracker (SEQ pilot, `IDA00050.png`) on the bom.gov.au
  ArcGIS radar map, georeferenced to Web Mercator and following pan and zoom.
- Chroma key keeps only the storm cells, movement arrows and forecast arcs.
- Auto-refresh (30 s – 10 min, default 1 min) using ETag checks; pauses in background tabs.
- Status chip showing issue time and age, a stale warning, cell count, and an outside-coverage notice.
- Settings: on/off (Shift+T), opacity, refresh interval, colour mode, coverage box, alignment nudge.
