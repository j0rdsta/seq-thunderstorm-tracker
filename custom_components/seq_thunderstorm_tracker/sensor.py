"""Sensors: how many storms are tracked, and how far the nearest is from each tracked place."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.const import EntityCategory, UnitOfLength
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .entity import TrackerEntity
from .hub import TrackerConfigEntry, TrackerHub


async def async_setup_entry(
    hass: HomeAssistant, entry: TrackerConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    """Set up the sensors."""
    hub = entry.runtime_data
    entities: list[SensorEntity] = [StormCountSensor(hub), IssuedSensor(hub)]
    for target in hub.targets:
        entities.append(NearestStormSensor(hub, target))
        entities.append(NearestForecastTrackSensor(hub, target))
    async_add_entities(entities)


class StormCountSensor(TrackerEntity, SensorEntity):
    """How many storm cells the tracker is following."""

    _attr_translation_key = "storms"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_suggested_display_precision = 0
    _unrecorded_attributes = frozenset({"description", "cells"})

    def __init__(self, hub: TrackerHub) -> None:
        super().__init__(hub, "storms")

    @property
    def native_value(self) -> int | None:
        return len(self.hub.snapshot.cells) if self.hub.snapshot else None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        snapshot = self.hub.snapshot
        if snapshot is None:
            return None
        return {
            "issued": snapshot.issued.isoformat(),
            "description": snapshot.description,
            "cells": [
                {
                    "latitude": cell.lat,
                    "longitude": cell.lon,
                    "area_km2": cell.area_km2,
                    "major_km": cell.major_km,
                    "minor_km": cell.minor_km,
                    "bearing": cell.bearing,
                }
                for cell in snapshot.cells
            ],
        }


class IssuedSensor(TrackerEntity, SensorEntity):
    """When the Bureau issued the tracker image behind the current numbers."""

    _attr_translation_key = "issued"
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, hub: TrackerHub) -> None:
        super().__init__(hub, "issued")

    @property
    def available(self) -> bool:
        """Stays readable when stale, so you can see how old the last picture is."""
        return self.hub.snapshot is not None

    @property
    def native_value(self) -> datetime | None:
        return self.hub.snapshot.issued if self.hub.snapshot else None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        if self.hub.snapshot is None:
            return None
        return {
            "received": self.hub.received.isoformat() if self.hub.received else None,
            "source": self.hub.snapshot.source,
        }


class _PlaceSensor(TrackerEntity, SensorEntity):
    """A distance from a tracked place."""

    _attr_device_class = SensorDeviceClass.DISTANCE
    _attr_native_unit_of_measurement = UnitOfLength.KILOMETERS
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_suggested_display_precision = 0

    @property
    def available(self) -> bool:
        return self.hub.proximity(self.target) is not None


class NearestStormSensor(_PlaceSensor):
    """Distance to the edge of the nearest tracked storm cell."""

    _attr_translation_key = "nearest_storm"

    def __init__(self, hub: TrackerHub, target: str) -> None:
        super().__init__(hub, "nearest_storm", target)

    @property
    def native_value(self) -> float | None:
        seen = self.hub.proximity(self.target)
        return None if seen is None or seen.distance_km is None else round(seen.distance_km, 1)

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        seen = self.hub.proximity(self.target)
        if seen is None:
            return {"target": self.target, "measures": "storm"}
        return {
            "target": self.target,
            "measures": "storm",
            "in_coverage": seen.in_coverage,
            "storms": seen.storms,
            "direction": seen.direction,
            "bearing": None if seen.bearing is None else round(seen.bearing),
            "storm_latitude": seen.storm_lat,
            "storm_longitude": seen.storm_lon,
            "issued": self.hub.snapshot.issued.isoformat() if self.hub.snapshot else None,
        }


class NearestForecastTrackSensor(_PlaceSensor):
    """Distance to the nearest part of the Bureau's forecast track (arrows and 10 to 30 minute arcs)."""

    _attr_translation_key = "nearest_forecast_track"

    def __init__(self, hub: TrackerHub, target: str) -> None:
        super().__init__(hub, "nearest_forecast_track", target)

    @property
    def native_value(self) -> float | None:
        seen = self.hub.proximity(self.target)
        return None if seen is None or seen.forecast_km is None else round(seen.forecast_km, 1)

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        seen = self.hub.proximity(self.target)
        if seen is None:
            return {"target": self.target, "measures": "forecast_track"}
        return {
            "target": self.target,
            "measures": "forecast_track",
            "in_coverage": seen.in_coverage,
            "direction": seen.forecast_direction,
            "bearing": None if seen.forecast_bearing is None else round(seen.forecast_bearing),
            "issued": self.hub.snapshot.issued.isoformat() if self.hub.snapshot else None,
        }
