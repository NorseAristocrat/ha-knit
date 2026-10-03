"""An appliance's Status: Empty, Running or Full (or the names given to them in its options).
Set by the power and the door, and correctable."""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.restore_state import RestoreEntity

from .appliance import STATUSES
from .const import CONF_STATUS_NAMES, DOMAIN, ROLE_STATUS, TYPE_APPLIANCE
from .entity import LiveEntity, kind

ICONS = {"Empty": "mdi:checkbox-blank-circle-outline", "Running": "mdi:play-circle-outline", "Full": "mdi:check-circle-outline"}


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    if kind(entry) != TYPE_APPLIANCE:
        return
    conf = {**entry.data, **entry.options}
    names = {s: (conf.get(key) or "").strip() or s for s, key in CONF_STATUS_NAMES.items()}
    add([Status(entry, hass.data[DOMAIN][entry.entry_id], ROLE_STATUS, names)])


class Status(LiveEntity, SelectEntity, RestoreEntity):
    _platform = "select"

    def __init__(self, entry, controller, role, names: dict[str, str]) -> None:
        super().__init__(entry, controller, role)
        self._names = names  # by status (Empty, Running, Full): what it's called
        self._statuses = {v: k for k, v in names.items()}
        self._attr_options = [names[s] for s in STATUSES]

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        last = await self.async_get_last_state()
        if last is None:
            return
        # its status attribute (Empty, Running or Full whatever they were called then); before
        # that was kept, by its name now, or the status itself
        status = last.attributes.get("status")
        if status not in STATUSES:
            status = self._statuses.get(last.state) or (last.state if last.state in STATUSES else None)
        if status:
            self.controller.restore(status, None, None, last.last_changed)

    @property
    def current_option(self) -> str:
        return self._names[self.controller.engine.status]

    @property
    def icon(self) -> str:
        return ICONS.get(self.controller.engine.status, "mdi:list-status")

    @property
    def extra_state_attributes(self) -> dict:
        c = self.controller
        # status: Empty, Running or Full whatever they're called (the card goes by it)
        return {**super().extra_state_attributes, "power": c.power, "door": c.door, "status": c.engine.status}

    async def async_select_option(self, option: str) -> None:
        self.controller.set_status(self._statuses.get(option, option))
