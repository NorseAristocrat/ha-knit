"""The base for every Knit entity: one device per entry, found by the card by role."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity
from homeassistant.util import slugify

from .const import ATTR_DEVICE, ATTR_ROLE, CONF_TYPE, DOMAIN, SIGNAL_UPDATE, TYPE_APPLIANCE, TYPE_LIGHT, TYPE_SWITCH

# the end of each entity id: <domain>.knit_<device name>_<this>
OBJECT_IDS = {
    "auto_off_time": "motion_timeout",
    "illuminance": "light_level",
    "dim_time": "dim_before_off",
    "off_after": "off_when_light_after",
}
MODELS = {
    TYPE_LIGHT: "Light",
    TYPE_SWITCH: "Motion-controlled device",
    TYPE_APPLIANCE: "Appliance",
}


def kind(entry: ConfigEntry) -> str:
    return entry.data.get(CONF_TYPE, TYPE_LIGHT)


def features(entry: ConfigEntry) -> tuple[bool, bool]:
    """(Motion, Light level): which features a light (or motion-controlled device) has, from its sensors.

    No presence sensor: no Motion entities. No light sensor: no Light level ones. A motion-
    controlled device has no light level.
    """
    conf = {**entry.data, **entry.options}
    level = bool(conf.get("illuminance")) and kind(entry) == TYPE_LIGHT
    return bool(conf.get("presence")), level


def dimmable(hass, light: str) -> bool:
    """Whether the light can be dimmed: a light with a colour mode other than on / off.

    Read from the entity registry's capabilities too, so it's known before the light is up.
    """
    if not light.startswith("light."):
        return False
    from homeassistant.helpers import entity_registry as er

    st = hass.states.get(light)
    modes = (st.attributes.get("supported_color_modes") if st else None) or []
    if not modes:
        entry = er.async_get(hass).async_get(light)
        modes = ((entry.capabilities or {}).get("supported_color_modes") if entry else None) or []
    # nothing known yet: assume it dims (the controller checks again when it starts)
    return any(m != "onoff" for m in modes) if modes else True


class KnitEntity(Entity):
    _attr_has_entity_name = True
    _platform = ""  # set per platform: switch, number, ...

    def __init__(self, entry: ConfigEntry, controller, role: str) -> None:
        self.controller = controller
        self.role = role
        # every entity id starts knit_ and the device's name (used when it's first added; renames are kept)
        self.entity_id = f"{self._platform}.{DOMAIN}_{slugify(entry.title)}_{OBJECT_IDS.get(role, role)}"
        self._attr_translation_key = role
        self._attr_unique_id = f"{entry.entry_id}_{role}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="Knit",
            model=f"{MODELS.get(kind(entry), 'Device')}: change its settings here or on its Knit card",
        )

    @property
    def extra_state_attributes(self) -> dict:
        return {ATTR_DEVICE: self.controller.anchor, ATTR_ROLE: self.role}


class LiveEntity(KnitEntity):
    """An entity that shows the controller's state: redrawn whenever it changes."""

    _attr_should_poll = False

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_UPDATE.format(self.controller.entry_id), self._redraw)
        )

    @callback
    def _redraw(self) -> None:
        self.async_write_ha_state()
