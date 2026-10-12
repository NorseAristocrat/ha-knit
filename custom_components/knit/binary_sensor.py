"""Occupied (any of the presence sensors) and Dark (as the light level settings judge it)."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, ROLE_DARK, ROLE_OCCUPIED, TYPE_APPLIANCE
from .entity import LiveEntity, features, kind



async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    if kind(entry) == TYPE_APPLIANCE:
        return
    controller = hass.data[DOMAIN][entry.entry_id]
    motion, level = features(entry)
    add(([Occupied(entry, controller, ROLE_OCCUPIED)] if motion else []) + ([Dark(entry, controller, ROLE_DARK)] if level else []))


class Occupied(LiveEntity, BinarySensorEntity):
    _platform = "binary_sensor"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    _attr_device_class = BinarySensorDeviceClass.OCCUPANCY

    @property
    def is_on(self) -> bool | None:
        return self.controller.engine.occupied

    @property
    def extra_state_attributes(self) -> dict:
        return {**super().extra_state_attributes, "sources": self.controller.presence}


class Dark(LiveEntity, BinarySensorEntity):
    _platform = "binary_sensor"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    _attr_icon = "mdi:theme-light-dark"

    @property
    def is_on(self) -> bool | None:
        return self.controller.engine.dark

    @property
    def extra_state_attributes(self) -> dict:
        return {**super().extra_state_attributes, "sources": self.controller.illuminance}
