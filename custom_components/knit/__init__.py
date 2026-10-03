"""Knit: knit your sensors into smart devices (lights, motion-controlled devices, appliances), with cards."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

from .appliance_controller import ApplianceController
from .const import CARD_FILE, CARD_URL, CONF_TYPE, DOMAIN, TYPE_APPLIANCE
from .controller import LightController

_LOGGER = logging.getLogger(__name__)
PLATFORMS = [Platform.SWITCH, Platform.NUMBER, Platform.BINARY_SENSOR, Platform.SENSOR, Platform.SELECT]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Serve the cards and load them on every dashboard (no resource to add by hand)."""
    from homeassistant.components.http import StaticPathConfig

    version = (await async_get_integration(hass, DOMAIN)).version
    url = f"{CARD_URL}/{CARD_FILE}?v={version}"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL, str(Path(__file__).parent / "frontend"), True)]
    )
    # loaded as a dashboard resource only: injected into the page as well, a cached copy ran
    # before the frontend's (scoped) element registry was set up on a refresh, and the cards
    # were "not found"
    await _ensure_resource(hass, url)
    return True


async def _ensure_resource(hass: HomeAssistant, url: str) -> None:
    """Add the cards as a dashboard resource, or move an older one to this version.

    Dashboards with their resources in YAML are left alone (they're added by hand there).
    """
    try:
        resources = getattr(hass.data.get("lovelace"), "resources", None)
        if resources is None or not hasattr(resources, "async_create_item"):
            return
        await resources.async_get_info()  # loads the stored resources
        base = url.split("?")[0]
        for item in resources.async_items():
            if str(item.get("url", "")).split("?")[0] == base:
                if item["url"] != url:
                    await resources.async_update_item(item["id"], {"url": url})
                return
        await resources.async_create_item({"res_type": "module", "url": url})
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning("Couldn't add the Knit cards as a dashboard resource (add %s by hand): %s", url, err)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    conf = {**entry.data, **entry.options}
    if entry.data.get(CONF_TYPE) == TYPE_APPLIANCE:
        controller = ApplianceController(hass, entry.entry_id, entry.title, conf)
    else:
        controller = LightController(hass, entry.entry_id, conf)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = controller
    # the entities restore their settings into the controller as they're added
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    controller.start()
    entry.async_on_unload(controller.stop)
    entry.async_on_unload(entry.add_update_listener(_reload))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return ok


async def _reload(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)
