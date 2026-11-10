"""Constants for the SEQ Thunderstorm Tracker integration."""

from __future__ import annotations

DOMAIN = "seq_thunderstorm_tracker"
NAME = "SEQ Thunderstorm Tracker"

CONF_WEBHOOK_ID = "webhook_id"
CONF_TARGETS = "targets"
CONF_RADIUS_KM = "radius_km"
CONF_STALE_MINUTES = "stale_minutes"
CONF_MAP_SPAN_KM = "map_span_km"

DEFAULT_TARGETS = ["zone.home"]
DEFAULT_RADIUS_KM = 20
DEFAULT_STALE_MINUTES = 15
DEFAULT_MAP_SPAN_KM = 120

TRACKER_PAGE = "https://www.bom.gov.au/qld/forecasts/brisbane-thunderstorms.shtml"
ATTRIBUTION = "Thunderstorm Tracker © Bureau of Meteorology"

FRONTEND_URL = f"/{DOMAIN}/frontend"
CARD_FILE = "seq-thunderstorm-tracker-card.js"

# A snapshot with the image is about 80 kB of JSON. This leaves room and stops abuse.
MAX_BODY_BYTES = 2 * 1024 * 1024
