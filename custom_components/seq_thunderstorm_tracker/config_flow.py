"""Config flow: which places to measure from, and how close counts as nearby."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import webhook
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlowWithReload
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import selector
from homeassistant.helpers.network import NoURLAvailableError, get_url

from .const import (
    CONF_MAP_SPAN_KM,
    CONF_RADIUS_KM,
    CONF_STALE_MINUTES,
    CONF_TARGETS,
    CONF_WEBHOOK_ID,
    DEFAULT_MAP_SPAN_KM,
    DEFAULT_RADIUS_KM,
    DEFAULT_STALE_MINUTES,
    DEFAULT_TARGETS,
    DOMAIN,
    NAME,
)

TARGETS_SELECTOR = selector.EntitySelector(
    selector.EntitySelectorConfig(domain=["zone", "person", "device_tracker"], multiple=True)
)
RADIUS_SELECTOR = selector.NumberSelector(
    selector.NumberSelectorConfig(min=1, max=150, step=1, unit_of_measurement="km", mode=selector.NumberSelectorMode.BOX)
)


def webhook_urls(hass: HomeAssistant, webhook_id: str) -> str:
    """The addresses the bridge can post to, best first (the browser may be away from home)."""
    path = webhook.async_generate_path(webhook_id)
    urls: list[str] = []
    for kwargs in (
        {"allow_internal": False, "prefer_external": True},
        {"allow_external": False, "allow_cloud": False},
    ):
        try:
            url = f"{get_url(hass, **kwargs)}{path}"
        except NoURLAvailableError:
            continue
        if url not in urls:
            urls.append(url)
    return "\n\n".join(f"`{url}`" for url in urls) or f"`<your Home Assistant address>{path}`"


class TrackerConfigFlow(ConfigFlow, domain=DOMAIN):
    """Set the tracker up."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Ask which places to measure from."""
        if user_input is not None:
            webhook_id = webhook.async_generate_id()
            return self.async_create_entry(
                title=NAME,
                data={CONF_WEBHOOK_ID: webhook_id},
                options={
                    CONF_TARGETS: user_input[CONF_TARGETS],
                    CONF_RADIUS_KM: user_input[CONF_RADIUS_KM],
                    CONF_STALE_MINUTES: DEFAULT_STALE_MINUTES,
                    CONF_MAP_SPAN_KM: DEFAULT_MAP_SPAN_KM,
                },
                description_placeholders={"webhook_url": webhook_urls(self.hass, webhook_id)},
            )
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_TARGETS, default=DEFAULT_TARGETS): TARGETS_SELECTOR,
                    vol.Required(CONF_RADIUS_KM, default=DEFAULT_RADIUS_KM): RADIUS_SELECTOR,
                }
            ),
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> TrackerOptionsFlow:
        """Options: the same choices, plus the webhook address to copy."""
        return TrackerOptionsFlow()


class TrackerOptionsFlow(OptionsFlowWithReload):
    """Change the tracked places and distances. Shows the webhook address for the bridge."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Show and save the options."""
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        options = self.config_entry.options
        schema = vol.Schema(
            {
                vol.Required(CONF_TARGETS, default=options.get(CONF_TARGETS, DEFAULT_TARGETS)): TARGETS_SELECTOR,
                vol.Required(CONF_RADIUS_KM, default=options.get(CONF_RADIUS_KM, DEFAULT_RADIUS_KM)): RADIUS_SELECTOR,
                vol.Required(
                    CONF_STALE_MINUTES, default=options.get(CONF_STALE_MINUTES, DEFAULT_STALE_MINUTES)
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=10, max=60, step=1, unit_of_measurement="min", mode=selector.NumberSelectorMode.BOX
                    )
                ),
                vol.Required(
                    CONF_MAP_SPAN_KM, default=options.get(CONF_MAP_SPAN_KM, DEFAULT_MAP_SPAN_KM)
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=30, max=280, step=10, unit_of_measurement="km", mode=selector.NumberSelectorMode.BOX
                    )
                ),
            }
        )
        return self.async_show_form(
            step_id="init",
            data_schema=schema,
            description_placeholders={
                "webhook_url": webhook_urls(self.hass, self.config_entry.data[CONF_WEBHOOK_ID])
            },
        )
