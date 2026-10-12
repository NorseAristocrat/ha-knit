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
    CONF_PAUSE_MATCH,
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
    # one entity (entries made before several could be picked): shown as a list now
    if key in (CONF_ILLUMINANCE, CONF_PAUSE) and isinstance(v, str):
        v = [v]
    return vol.Optional(key, description={"suggested_value": v} if v not in (None, "", []) else None)


def _ent(**kw):
    return selector.EntitySelector(selector.EntitySelectorConfig(**kw))


# what each kind of device can be built around (its base entity)
BASE_DOMAINS = {
    TYPE_LIGHT: ["light", "switch"],
    TYPE_SWITCH: ["switch", "light", "fan", "input_boolean"],
}

# the fields each kind of device can change later (options), besides its base entity
OPTION_FIELDS = {
    TYPE_LIGHT: (CONF_PRESENCE, CONF_ILLUMINANCE, CONF_PAUSE, CONF_PAUSE_MATCH),
    TYPE_SWITCH: (CONF_PRESENCE, CONF_PAUSE, CONF_PAUSE_MATCH, CONF_OFF_AFTER_OUTAGE),
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
    fields[_opt(d, CONF_PAUSE)] = _ent(domain=["input_boolean", "binary_sensor", "switch"], multiple=True)
    fields[vol.Optional(CONF_PAUSE_MATCH, default=d.get(CONF_PAUSE_MATCH) or "any")] = selector.SelectSelector(
        selector.SelectSelectorConfig(options=["any", "all"], translation_key=CONF_PAUSE_MATCH, mode=selector.SelectSelectorMode.LIST)
    )
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
            vol.Required(CONF_LIGHT): _ent(domain=BASE_DOMAINS[TYPE_LIGHT]),
            vol.Optional(CONF_NAME): selector.TextSelector(),
            **_schema(TYPE_LIGHT, {}),
            vol.Optional(CONF_START_ON, default=True): selector.BooleanSelector(),
        }
        return self.async_show_form(step_id="light", data_schema=vol.Schema(schema))

    async def async_step_auto_off_switch(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return await self._create(TYPE_SWITCH, user_input[CONF_LIGHT], user_input)
        schema = {
            vol.Required(CONF_LIGHT): _ent(domain=BASE_DOMAINS[TYPE_SWITCH]),
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
        entry = self.config_entry
        kind = entry.data.get(CONF_TYPE, TYPE_LIGHT)
        # what it's built around: a light / switch, or an appliance's power sensor
        key = CONF_POWER if kind == TYPE_APPLIANCE else CONF_LIGHT
        current = {**entry.data, **entry.options}
        errors: dict = {}
        if user_input is not None:
            base = user_input.get(key) or current[key]
            if kind == TYPE_APPLIANCE and _names_clash(user_input):
                errors["base"] = "same_names"
            elif base != current[key]:
                # the base entity changed: the device moves to it, keeping its entities, settings and cards
                unique_id = f"{kind}:{base}"
                taken = any(
                    e.unique_id == unique_id and e.entry_id != entry.entry_id
                    for e in self.hass.config_entries.async_entries(DOMAIN)
                )
                if taken:
                    errors[key] = "already_configured"
                else:
                    self.hass.config_entries.async_update_entry(
                        entry, data={**entry.data, key: base}, unique_id=unique_id
                    )
            if not errors:
                # a field cleared in the form is left out of user_input: save it as cleared
                return self.async_create_entry(data={k: user_input.get(k) for k in OPTION_FIELDS[kind]})
            current = {**current, **user_input}
        base_selector = _ent(domain="sensor", device_class="power") if kind == TYPE_APPLIANCE else _ent(domain=BASE_DOMAINS[kind])
        schema = {vol.Required(key, default=current[key]): base_selector, **_schema(kind, current)}
        return self.async_show_form(step_id=kind, data_schema=vol.Schema(schema), errors=errors)

    # the form is shown under the device kind's own step, for its own labels
    async def async_step_light(self, user_input=None):
        return await self.async_step_init(user_input)

    async def async_step_auto_off_switch(self, user_input=None):
        return await self.async_step_init(user_input)

    async def async_step_appliance(self, user_input=None):
        return await self.async_step_init(user_input)


__all__ = ["KnitConfigFlow"]
