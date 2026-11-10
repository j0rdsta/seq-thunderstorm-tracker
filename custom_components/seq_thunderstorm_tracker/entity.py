"""Shared entity plumbing."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import ATTRIBUTION, DOMAIN, NAME, TRACKER_PAGE
from .hub import TrackerHub


def place_identifier(entry: ConfigEntry, target: str) -> str:
    """Device identifier for a tracked place."""
    return f"{entry.entry_id}_{target}"


class TrackerEntity(Entity):
    """An entity that follows the hub."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_attribution = ATTRIBUTION

    def __init__(self, hub: TrackerHub, key: str, target: str | None = None) -> None:
        self.hub = hub
        self.target = target
        entry = hub.entry
        if target is None:
            self._attr_unique_id = f"{entry.entry_id}_{key}"
            self._attr_device_info = DeviceInfo(
                identifiers={(DOMAIN, entry.entry_id)},
                name=NAME,
                manufacturer="Bureau of Meteorology (unofficial)",
                model="Thunderstorm Tracker, Southeast Queensland pilot",
                entry_type=DeviceEntryType.SERVICE,
                configuration_url=TRACKER_PAGE,
            )
        else:
            self._attr_unique_id = f"{place_identifier(entry, target)}_{key}"
            self._attr_device_info = DeviceInfo(
                identifiers={(DOMAIN, place_identifier(entry, target))},
                name=f"Thunderstorms near {hub.place(target).name}",
                manufacturer="Bureau of Meteorology (unofficial)",
                model="Tracked place",
                entry_type=DeviceEntryType.SERVICE,
            )

    async def async_added_to_hass(self) -> None:
        """Follow the hub."""
        self.async_on_remove(self.hub.async_add_listener(self._handle_hub_update))

    @callback
    def _handle_hub_update(self) -> None:
        self.async_write_ha_state()

    @property
    def available(self) -> bool:
        """Unavailable whenever the tracker data is too old to trust."""
        return self.hub.current
