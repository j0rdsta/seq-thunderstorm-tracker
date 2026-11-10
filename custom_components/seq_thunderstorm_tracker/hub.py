"""The integration's memory: the newest snapshot and what it means for each tracked place."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_LATITUDE, ATTR_LONGITUDE, STATE_HOME
from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_track_point_in_utc_time, async_track_state_change_event
from homeassistant.util import dt as dt_util

from .const import (
    CONF_MAP_SPAN_KM,
    CONF_RADIUS_KM,
    CONF_STALE_MINUTES,
    CONF_TARGETS,
    DEFAULT_MAP_SPAN_KM,
    DEFAULT_RADIUS_KM,
    DEFAULT_STALE_MINUTES,
    DEFAULT_TARGETS,
)
from .model import Proximity, Snapshot, SnapshotError, parse_snapshot, proximity
from .render import ImageError, check_tracker_png, render_map

_LOGGER = logging.getLogger(__name__)

type TrackerConfigEntry = ConfigEntry[TrackerHub]


@dataclass(frozen=True, slots=True)
class Place:
    """A tracked zone, person or device and where it is now."""

    entity_id: str
    name: str
    lat: float | None
    lon: float | None


class TrackerHub:
    """Holds the newest snapshot and tells entities when something changed."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        options = entry.options
        self.targets: list[str] = list(options.get(CONF_TARGETS, DEFAULT_TARGETS))
        self.radius_km: float = float(options.get(CONF_RADIUS_KM, DEFAULT_RADIUS_KM))
        self.span_km: float = float(options.get(CONF_MAP_SPAN_KM, DEFAULT_MAP_SPAN_KM))
        self.stale_after = timedelta(minutes=float(options.get(CONF_STALE_MINUTES, DEFAULT_STALE_MINUTES)))

        self.snapshot: Snapshot | None = None
        self.received: datetime | None = None
        self.image_png: bytes | None = None
        self.image_hash: str | None = None
        self.image_updated: datetime | None = None

        self._listeners: list[CALLBACK_TYPE] = []
        self._unsub_expiry: CALLBACK_TYPE | None = None
        self._unsub_targets: CALLBACK_TYPE | None = None
        self._maps: dict[str, tuple[tuple[Any, ...], bytes]] = {}

    # ----- lifecycle -------------------------------------------------------------

    @callback
    def async_start(self) -> None:
        """Follow the tracked places as they move."""
        if self.targets:
            self._unsub_targets = async_track_state_change_event(
                self.hass, self.targets, self._handle_target_change
            )

    @callback
    def async_stop(self) -> None:
        """Stop listening."""
        for unsub in (self._unsub_expiry, self._unsub_targets):
            if unsub:
                unsub()
        self._unsub_expiry = self._unsub_targets = None

    @callback
    def async_add_listener(self, update: CALLBACK_TYPE) -> CALLBACK_TYPE:
        """Call ``update`` whenever the snapshot, its freshness or a tracked place changes."""
        self._listeners.append(update)

        @callback
        def remove() -> None:
            self._listeners.remove(update)

        return remove

    @callback
    def _notify(self) -> None:
        for update in list(self._listeners):
            update()

    @callback
    def _handle_target_change(self, event: Event[EventStateChangedData]) -> None:
        self._notify()

    # ----- what entities read ---------------------------------------------------

    @property
    def current(self) -> bool:
        """Whether the newest snapshot is recent enough to trust.

        Old data must never read as "no storms", so everything goes unavailable instead.
        """
        return self.snapshot is not None and dt_util.utcnow() - self.snapshot.issued <= self.stale_after

    def place(self, entity_id: str) -> Place:
        """Where a tracked entity is. Someone who is home without GPS is at Home Assistant's location."""
        state = self.hass.states.get(entity_id)
        if state is None:
            return Place(entity_id, entity_id, None, None)
        lat = state.attributes.get(ATTR_LATITUDE)
        lon = state.attributes.get(ATTR_LONGITUDE)
        if (lat is None or lon is None) and state.state == STATE_HOME:
            lat, lon = self.hass.config.latitude, self.hass.config.longitude
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            lat = lon = None
        return Place(entity_id, state.name, lat, lon)

    def proximity(self, entity_id: str) -> Proximity | None:
        """Storms as seen from a tracked entity, or None while there is nothing to go on."""
        if not self.current or self.snapshot is None:
            return None
        place = self.place(entity_id)
        if place.lat is None or place.lon is None:
            return None
        return proximity(self.snapshot, place.lat, place.lon, self.radius_km)

    async def async_map(self, entity_id: str) -> bytes | None:
        """The tracker image cropped around a tracked entity, redrawn only when something moved."""
        if self.image_png is None:
            return None
        place = self.place(entity_id)
        key = (
            self.image_hash,
            None if place.lat is None else round(place.lat, 4),
            None if place.lon is None else round(place.lon, 4),
            self.radius_km,
            self.span_km,
        )
        cached = self._maps.get(entity_id)
        if cached and cached[0] == key:
            return cached[1]
        png = await self.hass.async_add_executor_job(
            lambda: render_map(
                self.image_png,
                lat=place.lat,
                lon=place.lon,
                radius_km=self.radius_km,
                span_km=self.span_km,
            )
        )
        self._maps[entity_id] = (key, png)
        return png

    # ----- what the webhook writes ----------------------------------------------

    async def async_handle_payload(self, payload: Any) -> dict[str, Any]:
        """Take a webhook payload. Raises SnapshotError when it cannot be used."""
        snapshot = parse_snapshot(payload, now=dt_util.utcnow())
        if snapshot.image_png is not None:
            try:
                await self.hass.async_add_executor_job(check_tracker_png, snapshot.image_png)
            except ImageError as err:
                raise SnapshotError(str(err)) from err

        if self.snapshot is not None and snapshot.issued < self.snapshot.issued:
            # Two browsers can both be bridging. The newer picture wins.
            return {"ok": True, "ignored": "older than the snapshot already held", "need_image": False}

        if snapshot.image_png is not None:
            self.image_png = snapshot.image_png
            self.image_hash = snapshot.hash
            self.image_updated = dt_util.utcnow()
        elif self.image_hash != snapshot.hash:
            # The storms changed but the picture did not come with them: an old picture would
            # disagree with the numbers, so drop it and ask the bridge for the new one.
            self.image_png = None
            self.image_hash = None
            self.image_updated = dt_util.utcnow()

        self.snapshot = snapshot
        self.received = dt_util.utcnow()
        self._schedule_expiry()
        self._notify()
        return {"ok": True, "need_image": self.image_png is None}

    @callback
    def _schedule_expiry(self) -> None:
        if self._unsub_expiry:
            self._unsub_expiry()
            self._unsub_expiry = None
        if self.snapshot is None:
            return

        @callback
        def expired(_now: datetime) -> None:
            self._unsub_expiry = None
            _LOGGER.debug("Tracker snapshot issued %s is now stale", self.snapshot and self.snapshot.issued)
            self._notify()

        when = self.snapshot.issued + self.stale_after + timedelta(seconds=1)
        if when > dt_util.utcnow():
            self._unsub_expiry = async_track_point_in_utc_time(self.hass, expired, when)
