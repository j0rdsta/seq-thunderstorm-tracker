"""Binary sensors: is the bridge sending, and is a storm near a tracked place."""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .entity import TrackerEntity
from .hub import TrackerConfigEntry, TrackerHub


async def async_setup_entry(
    hass: HomeAssistant, entry: TrackerConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    """Set up the binary sensors."""
    hub = entry.runtime_data
    entities: list[BinarySensorEntity] = [BridgeSensor(hub)]
    entities.extend(StormNearbySensor(hub, target) for target in hub.targets)
    async_add_entities(entities)


class BridgeSensor(TrackerEntity, BinarySensorEntity):
    """On while a browser is sending tracker data that is recent enough to use."""

    _attr_translation_key = "bridge"
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    def __init__(self, hub: TrackerHub) -> None:
        super().__init__(hub, "bridge")

    @property
    def available(self) -> bool:
        return True

    @property
    def is_on(self) -> bool:
        return self.hub.current

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "received": self.hub.received.isoformat() if self.hub.received else None,
            "stale_after_minutes": self.hub.stale_after.total_seconds() / 60,
        }


class StormNearbySensor(TrackerEntity, BinarySensorEntity):
    """On when a tracked storm cell is within the alert distance of a place."""

    _attr_translation_key = "storm_nearby"
    _attr_device_class = BinarySensorDeviceClass.SAFETY

    def __init__(self, hub: TrackerHub, target: str) -> None:
        super().__init__(hub, "storm_nearby", target)

    @property
    def available(self) -> bool:
        return self.hub.proximity(self.target) is not None

    @property
    def is_on(self) -> bool | None:
        seen = self.hub.proximity(self.target)
        if seen is None or not seen.in_coverage:
            return None
        return seen.distance_km is not None and seen.distance_km <= self.hub.radius_km

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        attrs: dict[str, Any] = {"target": self.target, "radius_km": self.hub.radius_km}
        seen = self.hub.proximity(self.target)
        if seen is not None:
            attrs["in_coverage"] = seen.in_coverage
            attrs["storms_within_radius"] = seen.storms_within_radius
            attrs["forecast_track_within_radius"] = (
                seen.forecast_km is not None and seen.forecast_km <= self.hub.radius_km
            )
        return attrs
