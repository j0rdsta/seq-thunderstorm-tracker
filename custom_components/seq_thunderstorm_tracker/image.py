"""Image entities: the tracker image as received, and a marked crop around each tracked place."""

from __future__ import annotations

from datetime import datetime

from homeassistant.components.image import ImageEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import dt as dt_util

from .entity import TrackerEntity
from .hub import TrackerConfigEntry, TrackerHub


async def async_setup_entry(
    hass: HomeAssistant, entry: TrackerConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    """Set up the image entities."""
    hub = entry.runtime_data
    entities: list[ImageEntity] = [TrackerImage(hass, hub)]
    entities.extend(PlaceMapImage(hass, hub, target) for target in hub.targets)
    async_add_entities(entities)


class _HubImage(TrackerEntity, ImageEntity):
    """An image that changes when the hub's picture does."""

    _attr_content_type = "image/png"

    def __init__(self, hass: HomeAssistant, hub: TrackerHub, key: str, target: str | None = None) -> None:
        TrackerEntity.__init__(self, hub, key, target)
        ImageEntity.__init__(self, hass)
        self._attr_image_last_updated = hub.image_updated

    @property
    def available(self) -> bool:
        return self.hub.current and self.hub.image_png is not None

    def _stamp(self) -> datetime | None:
        return self.hub.image_updated

    @callback
    def _handle_hub_update(self) -> None:
        self._attr_image_last_updated = self._stamp()
        self.async_write_ha_state()


class TrackerImage(_HubImage):
    """The Bureau's tracker image, exactly as the browser received it."""

    _attr_translation_key = "tracker"

    def __init__(self, hass: HomeAssistant, hub: TrackerHub) -> None:
        super().__init__(hass, hub, "tracker")

    async def async_image(self) -> bytes | None:
        return self.hub.image_png


class PlaceMapImage(_HubImage):
    """The tracker image cropped around a tracked place, with the place and alert distance marked."""

    _attr_translation_key = "map"

    def __init__(self, hass: HomeAssistant, hub: TrackerHub, target: str) -> None:
        super().__init__(hass, hub, "map", target)
        self._seen: tuple | None = None
        self._moved: datetime | None = None

    def _stamp(self) -> datetime | None:
        """The picture changes when the tracker image does or when the place moves."""
        place = self.hub.place(self.target)
        seen = (self.hub.image_updated, place.lat, place.lon)
        if seen != self._seen:
            self._seen = seen
            self._moved = dt_util.utcnow() if self.hub.image_updated else None
        return self._moved

    async def async_image(self) -> bytes | None:
        return await self.hub.async_map(self.target)
