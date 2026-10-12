"""Motion and Light level: the switches that turn each feature on or off.

Motion control: with it on, presence turns the light on and the room being empty for the
Motion timeout turns it off.
"""

from __future__ import annotations

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import STATE_ON
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .const import CONF_START_ON, DOMAIN, ROLE_LIGHT_LEVEL, ROLE_MOTION, SETTING, TYPE_APPLIANCE, TYPE_SWITCH
from .entity import KnitEntity, features, kind

ICONS = {ROLE_MOTION: "mdi:motion-sensor", ROLE_LIGHT_LEVEL: "mdi:theme-light-dark"}


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    if kind(entry) == TYPE_APPLIANCE:
        return
    controller = hass.data[DOMAIN][entry.entry_id]
    start_on = entry.data.get(CONF_START_ON, True)
    motion, level = features(entry)
    roles = [r for r, has in ((ROLE_MOTION, motion), (ROLE_LIGHT_LEVEL, level)) if has]
    add([FeatureSwitch(entry, controller, r, start_on) for r in roles])


class FeatureSwitch(KnitEntity, SwitchEntity, RestoreEntity):
    _platform = "switch"

    def __init__(self, entry, controller, role, start_on: bool) -> None:
        super().__init__(entry, controller, role)
        self._attr_icon = ICONS[role]
        self._attr_is_on = start_on
        # a motion-controlled device's switch is its Motion control: presence never turns it on
        self._switch_only = kind(entry) == TYPE_SWITCH and role == ROLE_MOTION
        if self._switch_only:
            self._attr_translation_key = "auto_off"
            self._attr_icon = "mdi:timer-outline"

    @property
    def extra_state_attributes(self) -> dict:
        attrs = super().extra_state_attributes
        if self._switch_only:
            attrs["turns_on"] = False
        return attrs

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        last = await self.async_get_last_state()
        if last is not None:
            self._attr_is_on = last.state == STATE_ON
        self.controller.set_setting(SETTING[self.role], self._attr_is_on)

    async def async_turn_on(self, **kwargs) -> None:
        self._set(True)

    async def async_turn_off(self, **kwargs) -> None:
        self._set(False)

    def _set(self, on: bool) -> None:
        self._attr_is_on = on
        self.controller.set_setting(SETTING[self.role], on)
        self.async_write_ha_state()
