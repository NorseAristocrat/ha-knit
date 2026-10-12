"""Countdowns (when the motion timeout, the off-when-light and an appliance's cycle end), the light
level a light judges, and the light a device runs (for the card)."""

from __future__ import annotations

from datetime import datetime, timedelta

from homeassistant.components.sensor import RestoreSensor, SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import LIGHT_LUX, EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity
from homeassistant.util import dt as dt_util

from .const import DOMAIN, ROLE_AUTO_OFF_ENDS, ROLE_CYCLE_ENDS, ROLE_ILLUMINANCE, ROLE_LIGHT, ROLE_OFF_WHEN_LIGHT_ENDS, TYPE_APPLIANCE
from .engine import Countdown
from .entity import KnitEntity, LiveEntity, features, kind


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    controller = hass.data[DOMAIN][entry.entry_id]
    if kind(entry) == TYPE_APPLIANCE:
        add([CycleEnds(entry, controller, ROLE_CYCLE_ENDS)])
        return
    motion, level = features(entry)
    ends = ([Ends(entry, controller, ROLE_AUTO_OFF_ENDS)] if motion else []) + ([Ends(entry, controller, ROLE_OFF_WHEN_LIGHT_ENDS)] if level else [])
    level = [LightLevel(entry, controller, ROLE_ILLUMINANCE)] if level else []
    add([LightRef(entry, controller, ROLE_LIGHT), *level, *ends])


class LightLevel(LiveEntity, SensorEntity):
    """The light level the settings judge: the average of the light's sensors."""

    _platform = "sensor"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_device_class = SensorDeviceClass.ILLUMINANCE
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = LIGHT_LUX
    _attr_suggested_display_precision = 1

    @property
    def native_value(self) -> float | None:
        return self.controller.engine.lux

    @property
    def extra_state_attributes(self) -> dict:
        return {**super().extra_state_attributes, "sources": self.controller.illuminance}


class LightRef(LiveEntity, SensorEntity, RestoreEntity):
    """The light this device runs: always there, so the card finds the light from the device
    even when it has no Motion or Light level entities.

    It also keeps the brightness from before a dim (`dimmed_from`) through a restart, so a
    light that went off dimmed still comes back at its own brightness afterwards."""

    _platform = "sensor"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_icon = "mdi:lightbulb-outline"

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        last = await self.async_get_last_state()
        bri = last.attributes.get("dimmed_from") if last else None
        engine = getattr(self.controller, "engine", None)
        if isinstance(bri, int) and engine is not None and getattr(engine, "restore", 0) is None:
            engine.restore = bri

    @property
    def native_value(self) -> str:
        return self.controller.light

    @property
    def extra_state_attributes(self) -> dict:
        engine = getattr(self.controller, "engine", None)
        restore = getattr(engine, "restore", None)
        attrs = {**super().extra_state_attributes, **({"dimmed_from": restore} if restore is not None else {})}
        # with a pause entity: whether it's paused now (the card says "Automations paused")
        if getattr(self.controller, "pause", None):
            attrs["paused"] = bool(getattr(engine, "paused", False))
        # with people to follow: whether they're all away (nothing turns it on)
        if getattr(self.controller, "people", None):
            attrs["away"] = bool(getattr(engine, "away", False))
        return attrs


class Ends(LiveEntity, SensorEntity):
    _platform = "sensor"
    _attr_entity_category = EntityCategory.DIAGNOSTIC

    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:timer-sand"

    def _countdown(self) -> Countdown | None:
        e = self.controller.engine
        return e.auto if self.role == ROLE_AUTO_OFF_ENDS else e.light

    @property
    def native_value(self) -> datetime | None:
        cd = self._countdown()
        return cd.ends if cd else None

    @property
    def extra_state_attributes(self) -> dict:
        cd = self._countdown()
        attrs = super().extra_state_attributes
        if cd:
            # as a timer's duration, "H:MM:SS"; and when the dim starts, for the auto-off
            attrs["duration"] = str(timedelta(seconds=round(cd.total)))
            dim_at = self.controller.engine.dim_at if self.role == ROLE_AUTO_OFF_ENDS else None
            if dim_at:
                attrs["dim_at"] = dim_at.isoformat()
        return attrs


class CycleEnds(LiveEntity, RestoreSensor):
    """When an appliance's cycle is expected to end (the card's countdown); kept over a restart."""

    _platform = "sensor"
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:timer-sand"

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        last = await self.async_get_last_state()
        if last is not None and last.state not in ("unknown", "unavailable"):
            ends = dt_util.parse_datetime(last.state)
            total = last.attributes.get("duration")
            secs = None
            if total:
                h, m, s = (int(x) for x in str(total).split(":"))
                secs = h * 3600 + m * 60 + s
            self.controller.restore(None, ends, secs)

    @property
    def native_value(self) -> datetime | None:
        return self.controller.engine.cycle_ends

    @property
    def extra_state_attributes(self) -> dict:
        attrs = super().extra_state_attributes
        e = self.controller.engine
        if e.cycle_ends and e.cycle_total:
            attrs["duration"] = str(timedelta(seconds=round(e.cycle_total)))
        return attrs
