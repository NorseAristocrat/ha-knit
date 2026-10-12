"""The times (in seconds) and light levels (in lx) each feature uses."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.components.number import NumberMode, RestoreNumber
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import LIGHT_LUX, EntityCategory, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    DOMAIN,
    ROLE_AUTO_OFF_TIME,
    ROLE_DARK_BELOW,
    ROLE_DIM_TIME,
    ROLE_LIGHT_ABOVE,
    ROLE_OFF_AFTER,
    SETTING,
)
from .entity import KnitEntity, dimmable, features


@dataclass(frozen=True)
class Spec:
    role: str
    unit: str
    low: float
    high: float
    step: float
    default: float
    icon: str


MOTION = [
    Spec(ROLE_AUTO_OFF_TIME, UnitOfTime.SECONDS, 0, 3600, 1, 300, "mdi:timer-outline"),
    Spec(ROLE_DIM_TIME, UnitOfTime.SECONDS, 0, 2700, 1, 60, "mdi:brightness-5"),
]
OFF_AFTER = Spec(ROLE_OFF_AFTER, UnitOfTime.SECONDS, 0, 3600, 1, 300, "mdi:weather-sunny")
LEVELS = [
    Spec(ROLE_DARK_BELOW, LIGHT_LUX, 0, 2000, 0.1, 10, "mdi:weather-sunset-down"),
    Spec(ROLE_LIGHT_ABOVE, LIGHT_LUX, 0, 2000, 0.1, 15, "mdi:weather-sunny"),
]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    controller = hass.data[DOMAIN][entry.entry_id]
    motion, level = features(entry)
    specs = list(MOTION) if motion else []
    # a light that can't be dimmed (a switch, an on / off light) has no dim before off
    if not dimmable(hass, controller.light):
        specs = [s for s in specs if s.role != ROLE_DIM_TIME]
    if level:
        specs += [OFF_AFTER, *LEVELS]
    add([Setting(entry, controller, s) for s in specs])


class Setting(KnitEntity, RestoreNumber):
    _platform = "number"
    # listed under Configuration on the device page (also set on the device's Knit card)
    _attr_entity_category = EntityCategory.CONFIG

    _attr_mode = NumberMode.BOX

    def __init__(self, entry, controller, spec: Spec) -> None:
        super().__init__(entry, controller, spec.role)
        self._attr_native_unit_of_measurement = spec.unit
        self._attr_native_min_value = spec.low
        self._attr_native_max_value = spec.high
        self._attr_native_step = spec.step
        self._attr_native_value = spec.default
        self._attr_icon = spec.icon

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        last = await self.async_get_last_number_data()
        if last is not None and last.native_value is not None:
            self._attr_native_value = last.native_value
        self.controller.set_setting(SETTING[self.role], self._attr_native_value)

    async def async_set_native_value(self, value: float) -> None:
        self._attr_native_value = value
        self.controller.set_setting(SETTING[self.role], value)
        self.async_write_ha_state()
