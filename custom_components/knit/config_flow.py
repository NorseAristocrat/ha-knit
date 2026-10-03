"""Add a Knit device: a light, a motion-controlled device or an appliance, from the sensors it follows."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_STATUS_NAMES,
    CONF_DOOR,
    CONF_ILLUMINANCE,
    CONF_LIGHT,
    CONF_OFF_AFTER_OUTAGE,
    CONF_PAUSE,
    CONF_POWER,
    CONF_PRESENCE,
    CONF_START_ON,
    CONF_TYPE,
    DOMAIN,
    TYPE_APPLIANCE,
    TYPE_LIGHT,
    TYPE_SWITCH,
)

CONF_NAME = "name"


def _opt(defaults: dict, key: str):
    v = defaults.get(key)
    # one light sensor (entries made before several could be picked): shown as a list now
    if key == CONF_ILLUMINANCE and isinstance(v, str):
        v = [v]
    return vol.Optional(key, description={"suggested_value": v} if v not in (None, "", []) else None)


def _ent(**kw):
    return selector.EntitySelector(selector.EntitySelectorConfig(**kw))


# the fields each kind of device can change later (options)
OPTION_FIELDS = {
    TYPE_LIGHT: (CONF_PRESENCE, CONF_ILLUMINANCE, CONF_PAUSE),
    TYPE_SWITCH: (CONF_PRESENCE, CONF_PAUSE, CONF_OFF_AFTER_OUTAGE),
    TYPE_APPLIANCE: (CONF_DOOR, *CONF_STATUS_NAMES.values()),
}


def _names_clash(user_input: dict) -> bool:
    """Two of an appliance's statuses given the same name (it couldn't tell them apart)."""
    names = [(user_input.get(key) or "").strip() or status for status, key in CONF_STATUS_NAMES.items()]
    return len({n.casefold() for n in names}) < len(names)


def _schema(kind: str, d: dict) -> dict:
    """The sensors a kind of device follows: the same on set-up and in options."""
    if kind == TYPE_APPLIANCE:
        fields = {_opt(d, CONF_DOOR): _ent(domain="binary_sensor")}
        # what its statuses are called (blank: Empty, Running, Full)
        for status, key in CONF_STATUS_NAMES.items():
            fields[vol.Optional(key, description={"suggested_value": d.get(key) or status})] = selector.TextSelector()
        return fields
    fields = {_opt(d, CONF_PRESENCE): _ent(domain="binary_sensor", multiple=True)}
    if kind == TYPE_LIGHT:
        fields[_opt(d, CONF_ILLUMINANCE)] = _ent(domain="sensor", device_class="illuminance", multiple=True)
    fields[_opt(d, CONF_PAUSE)] = _ent(domain=["input_boolean", "binary_sensor", "switch"])
    if kind == TYPE_SWITCH:
        fields[vol.Optional(CONF_OFF_AFTER_OUTAGE, default=bool(d.get(CONF_OFF_AFTER_OUTAGE, True)))] = selector.BooleanSelector()
    return fields


class KnitConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return self.async_show_menu(step_id="user", menu_options=[TYPE_LIGHT, TYPE_SWITCH, TYPE_APPLIANCE])

    async def _create(self, kind: str, main: str, user_input: dict) -> ConfigFlowResult:
        await self.async_set_unique_id(f"{kind}:{main}")
        self._abort_if_unique_id_configured()
        st = self.hass.states.get(main)
        name = user_input.pop(CONF_NAME, None) or (st and st.attributes.get("friendly_name")) or main
        return self.async_create_entry(title=name, data={CONF_TYPE: kind, **user_input})

    async def async_step_light(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return await self._create(TYPE_LIGHT, user_input[CONF_LIGHT], user_input)
        schema = {
            vol.Required(CONF_LIGHT): _ent(domain=["light", "switch"]),
            vol.Optional(CONF_NAME): selector.TextSelector(),
            **_schema(TYPE_LIGHT, {}),
            vol.Optional(CONF_START_ON, default=True): selector.BooleanSelector(),
        }
        return self.async_show_form(step_id="light", data_schema=vol.Schema(schema))

    async def async_step_auto_off_switch(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return await self._create(TYPE_SWITCH, user_input[CONF_LIGHT], user_input)
        schema = {
            vol.Required(CONF_LIGHT): _ent(domain=["switch", "light", "fan", "input_boolean"]),
            vol.Optional(CONF_NAME): selector.TextSelector(),
            **_schema(TYPE_SWITCH, {}),
            vol.Optional(CONF_START_ON, default=True): selector.BooleanSelector(),
        }
        return self.async_show_form(step_id="auto_off_switch", data_schema=vol.Schema(schema))

    async def async_step_appliance(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict = {}
        if user_input is not None:
            if _names_clash(user_input):
                errors["base"] = "same_names"
            else:
                return await self._create(TYPE_APPLIANCE, user_input[CONF_POWER], user_input)
        schema = {
            vol.Required(CONF_NAME): selector.TextSelector(),
            vol.Required(CONF_POWER): _ent(domain="sensor", device_class="power"),
            **_schema(TYPE_APPLIANCE, user_input or {}),
        }
        return self.async_show_form(step_id="appliance", data_schema=vol.Schema(schema), errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(entry: ConfigEntry) -> OptionsFlow:
        return KnitOptionsFlow()


class KnitOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        kind = self.config_entry.data.get(CONF_TYPE, TYPE_LIGHT)
        errors: dict = {}
        if user_input is not None:
            if kind == TYPE_APPLIANCE and _names_clash(user_input):
                errors["base"] = "same_names"
            else:
                # a field cleared in the form is left out of user_input: save it as cleared
                return self.async_create_entry(data={k: user_input.get(k) for k in OPTION_FIELDS[kind]})
        current = {**self.config_entry.data, **self.config_entry.options, **(user_input or {})}
        return self.async_show_form(step_id=kind, data_schema=vol.Schema(_schema(kind, current)), errors=errors)

    # the form is shown under the device kind's own step, for its own labels
    async def async_step_light(self, user_input=None):
        return await self.async_step_init(user_input)

    async def async_step_auto_off_switch(self, user_input=None):
        return await self.async_step_init(user_input)

    async def async_step_appliance(self, user_input=None):
        return await self.async_step_init(user_input)


__all__ = ["KnitConfigFlow"]
