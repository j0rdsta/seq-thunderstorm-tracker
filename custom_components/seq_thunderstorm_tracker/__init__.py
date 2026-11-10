"""SEQ Thunderstorm Tracker: storm positions from the Bureau's tracker, sent by your browser.

Home Assistant never fetches bom.gov.au. A bridge userscript running in a browser tab posts
snapshots to this integration's webhook, and everything here is worked out from those.
"""

from __future__ import annotations

from http import HTTPStatus
import logging
from pathlib import Path

from aiohttp import web

from homeassistant.components import webhook
from homeassistant.components.frontend import add_extra_js_url, remove_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.loader import async_get_integration

from .const import CARD_FILE, CONF_WEBHOOK_ID, DOMAIN, FRONTEND_URL, MAX_BODY_BYTES, NAME
from .entity import place_identifier
from .hub import TrackerConfigEntry, TrackerHub
from .model import SnapshotError

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.BINARY_SENSOR, Platform.IMAGE, Platform.SENSOR]
_STATIC_REGISTERED = f"{DOMAIN}_static_registered"


async def async_setup_entry(hass: HomeAssistant, entry: TrackerConfigEntry) -> bool:
    """Set up the tracker from its config entry."""
    hub = TrackerHub(hass, entry)
    entry.runtime_data = hub

    _remove_dropped_places(hass, entry, hub)
    await _async_register_card(hass, entry)

    async def handle(hass: HomeAssistant, webhook_id: str, request: web.Request) -> web.Response:
        return await _async_handle_webhook(hub, request)

    webhook.async_register(
        hass,
        DOMAIN,
        NAME,
        entry.data[CONF_WEBHOOK_ID],
        handle,
        allowed_methods=["POST"],
        local_only=False,
    )
    entry.async_on_unload(lambda: webhook.async_unregister(hass, entry.data[CONF_WEBHOOK_ID]))

    hub.async_start()
    entry.async_on_unload(hub.async_stop)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: TrackerConfigEntry) -> bool:
    """Unload the tracker."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_handle_webhook(hub: TrackerHub, request: web.Request) -> web.Response:
    """Take a snapshot from the bridge userscript."""
    if request.content_length is not None and request.content_length > MAX_BODY_BYTES:
        return web.json_response(
            {"ok": False, "error": "the body is too large"},
            status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
        )
    try:
        body = await request.read()
        if len(body) > MAX_BODY_BYTES:
            raise SnapshotError("the body is too large")
        payload = await request.json()
    except SnapshotError as err:
        return web.json_response({"ok": False, "error": str(err)}, status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
    except ValueError:
        return web.json_response({"ok": False, "error": "the body is not JSON"}, status=HTTPStatus.BAD_REQUEST)
    try:
        result = await hub.async_handle_payload(payload)
    except SnapshotError as err:
        _LOGGER.warning("Rejected a tracker snapshot: %s", err)
        return web.json_response({"ok": False, "error": str(err)}, status=HTTPStatus.BAD_REQUEST)
    return web.json_response(result)


async def _async_register_card(hass: HomeAssistant, entry: TrackerConfigEntry) -> None:
    """Serve the dashboard card that ships with the integration and load it on every dashboard."""
    if not hass.data.get(_STATIC_REGISTERED):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(FRONTEND_URL, str(Path(__file__).parent / "frontend"), cache_headers=False)]
        )
        hass.data[_STATIC_REGISTERED] = True
    integration = await async_get_integration(hass, DOMAIN)
    url = f"{FRONTEND_URL}/{CARD_FILE}?v={integration.version}"
    add_extra_js_url(hass, url)
    entry.async_on_unload(lambda: remove_extra_js_url(hass, url))


def _remove_dropped_places(hass: HomeAssistant, entry: TrackerConfigEntry, hub: TrackerHub) -> None:
    """Remove the devices of places that are no longer tracked."""
    keep = {(DOMAIN, entry.entry_id)} | {(DOMAIN, place_identifier(entry, target)) for target in hub.targets}
    registry = dr.async_get(hass)
    for device in dr.async_entries_for_config_entry(registry, entry.entry_id):
        if not device.identifiers & keep:
            registry.async_remove_device(device.id)
