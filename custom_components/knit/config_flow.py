"""Add a Knit device: a light or a motion-controlled device, from the sensors it follows."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_ILLUMINANCE,
    CONF_LIGHT,
    CONF_MANAGED,
    CONF_OFF_AFTER_OUTAGE,
    CONF_PAUSE,
    CONF_PAUSE_MATCH,
    CONF_PRESENCE,
    CONF_PRESENCE_OFF,
    CONF_START_ON,
    CONF_TYPE,
    DOMAIN,
    TYPE_LIGHT,
    TYPE_SWITCH,
)

CONF_NAME = "name"


def _opt(defaults: dict, key: str):
    v = defaults.get(key)
    # one entity (entries made before several could be picked): shown as a list now
    if key in (CONF_PRESENCE, CONF_PRESENCE_OFF, CONF_ILLUMINANCE, CONF_PAUSE) and isinstance(v, str):
        v = [v]
    return vol.Optional(key, description={"suggested_value": v} if v not in (None, "", []) else None)


def _ent(**kw):
    return selector.EntitySelector(selector.EntitySelectorConfig(**kw))


TRIGGER_DOMAINS = ["binary_sensor", "input_boolean"]


def _in_both(user_input: dict) -> bool:
    """A sensor picked both ways round: it would always count as active."""
    return bool(set(user_input.get(CONF_PRESENCE) or []) & set(user_input.get(CONF_PRESENCE_OFF) or []))


# what each kind of device can be built around (its base entity)
BASE_DOMAINS = {
    TYPE_LIGHT: ["light", "switch"],
    TYPE_SWITCH: ["switch", "light", "fan", "input_boolean"],
}

# the fields each kind of device can change later (options), besides its base entity
OPTION_FIELDS = {
    TYPE_LIGHT: (CONF_PRESENCE, CONF_PRESENCE_OFF, CONF_ILLUMINANCE, CONF_PAUSE, CONF_PAUSE_MATCH, CONF_MANAGED),
    TYPE_SWITCH: (CONF_PRESENCE, CONF_PRESENCE_OFF, CONF_PAUSE, CONF_PAUSE_MATCH, CONF_OFF_AFTER_OUTAGE),
}


def _schema(kind: str, d: dict) -> dict:
    """The sensors a kind of device follows: the same on set-up and in options."""
    # the sensors that turn it on: while on (motion, an open door), and the inverted ones, while off
    fields = {
        _opt(d, CONF_PRESENCE): _ent(domain=TRIGGER_DOMAINS, multiple=True),
        _opt(d, CONF_PRESENCE_OFF): _ent(domain=TRIGGER_DOMAINS, multiple=True),
    }
    if kind == TYPE_LIGHT:
        fields[_opt(d, CONF_ILLUMINANCE)] = _ent(domain="sensor", device_class="illuminance", multiple=True)
    fields[_opt(d, CONF_PAUSE)] = _ent(domain=["input_boolean", "binary_sensor", "switch"], multiple=True)
    fields[vol.Optional(CONF_PAUSE_MATCH, default=d.get(CONF_PAUSE_MATCH) or "any")] = selector.SelectSelector(
        selector.SelectSelectorConfig(options=["any", "all"], translation_key=CONF_PAUSE_MATCH, mode=selector.SelectSelectorMode.LIST)
    )
    if kind == TYPE_LIGHT:
        fields[vol.Optional(CONF_MANAGED, default=bool(d.get(CONF_MANAGED, False)))] = selector.BooleanSelector()
    if kind == TYPE_SWITCH:
        fields[vol.Optional(CONF_OFF_AFTER_OUTAGE, default=bool(d.get(CONF_OFF_AFTER_OUTAGE, True)))] = selector.BooleanSelector()
    return fields


class KnitConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return self.async_show_menu(step_id="user", menu_options=[TYPE_LIGHT, TYPE_SWITCH])

    async def _create(self, kind: str, main: str, user_input: dict) -> ConfigFlowResult:
        await self.async_set_unique_id(f"{kind}:{main}")
        self._abort_if_unique_id_configured()
        st = self.hass.states.get(main)
        name = user_input.pop(CONF_NAME, None) or (st and st.attributes.get("friendly_name")) or main
        return self.async_create_entry(title=name, data={CONF_TYPE: kind, **user_input})

    async def _step(self, kind: str, user_input: dict[str, Any] | None) -> ConfigFlowResult:
        errors: dict = {}
        if user_input is not None:
            if not _in_both(user_input):
                return await self._create(kind, user_input[CONF_LIGHT], user_input)
            errors[CONF_PRESENCE_OFF] = "in_both_lists"
        d = user_input or {}
        schema = {
            vol.Required(CONF_LIGHT, **({"default": d[CONF_LIGHT]} if d.get(CONF_LIGHT) else {})): _ent(domain=BASE_DOMAINS[kind]),
            _opt(d, CONF_NAME): selector.TextSelector(),
            **_schema(kind, d),
            vol.Optional(CONF_START_ON, default=d.get(CONF_START_ON, True)): selector.BooleanSelector(),
        }
        return self.async_show_form(step_id=kind, data_schema=vol.Schema(schema), errors=errors)

    async def async_step_light(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return await self._step(TYPE_LIGHT, user_input)

    async def async_step_auto_off_switch(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return await self._step(TYPE_SWITCH, user_input)

    @staticmethod
    @callback
    def async_get_options_flow(entry: ConfigEntry) -> OptionsFlow:
        return KnitOptionsFlow()


class KnitOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry = self.config_entry
        kind = entry.data.get(CONF_TYPE, TYPE_LIGHT)
        current = {**entry.data, **entry.options}
        errors: dict = {}
        if user_input is not None:
            # the base entity changed: the device moves to it, keeping its entities, settings and cards
            base = user_input.get(CONF_LIGHT) or current[CONF_LIGHT]
            if _in_both(user_input):
                errors[CONF_PRESENCE_OFF] = "in_both_lists"
            elif base != current[CONF_LIGHT]:
                unique_id = f"{kind}:{base}"
                taken = any(
                    e.unique_id == unique_id and e.entry_id != entry.entry_id
                    for e in self.hass.config_entries.async_entries(DOMAIN)
                )
                if taken:
                    errors[CONF_LIGHT] = "already_configured"
                else:
                    self.hass.config_entries.async_update_entry(
                        entry, data={**entry.data, CONF_LIGHT: base}, unique_id=unique_id
                    )
            if not errors:
                # a field cleared in the form is left out of user_input: save it as cleared
                return self.async_create_entry(data={k: user_input.get(k) for k in OPTION_FIELDS[kind]})
            current = {**{k: v for k, v in current.items() if k not in OPTION_FIELDS[kind]}, **user_input}
        schema = {
            vol.Required(CONF_LIGHT, default=current[CONF_LIGHT]): _ent(domain=BASE_DOMAINS[kind]),
            **_schema(kind, current),
        }
        return self.async_show_form(step_id=kind, data_schema=vol.Schema(schema), errors=errors)

    # the form is shown under the device kind's own step, for its own labels
    async def async_step_light(self, user_input=None):
        return await self.async_step_init(user_input)

    async def async_step_auto_off_switch(self, user_input=None):
        return await self.async_step_init(user_input)


__all__ = ["KnitConfigFlow"]
