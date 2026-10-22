"""Add a Knit device: a light, a motion-controlled device, an appliance or a charger, from the sensors it follows."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.data_entry_flow import section
from homeassistant.helpers import selector

from .const import (
    CONF_BATTERY,
    CONF_CHARGING,
    CONF_FULL_CHARGE,
    CONF_HOME,
    CONF_PLUG,
    CONF_STATUS_NAMES,
    CONF_DARK_CHECK,
    CONF_DOOR,
    CONF_ILLUMINANCE,
    CONF_LIGHT,
    CONF_MANAGED,
    CONF_OFF_AFTER_OUTAGE,
    CONF_PAUSE,
    CONF_PAUSE_MATCH,
    CONF_POWER,
    CONF_PRESENCE,
    CONF_PRESENCE_OFF,
    CONF_START_ON,
    CONF_TYPE,
    DOMAIN,
    TYPE_APPLIANCE,
    TYPE_CHARGER,
    TYPE_LIGHT,
    TYPE_SWITCH,
)

CONF_NAME = "name"
# the settings most devices never need, folded away in the form (they're saved beside the others)
ADVANCED = "advanced"


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
    TYPE_LIGHT: (CONF_PRESENCE, CONF_PRESENCE_OFF, CONF_ILLUMINANCE, CONF_PAUSE, CONF_PAUSE_MATCH, CONF_DARK_CHECK, CONF_MANAGED),
    TYPE_SWITCH: (CONF_PRESENCE, CONF_PRESENCE_OFF, CONF_PAUSE, CONF_PAUSE_MATCH, CONF_OFF_AFTER_OUTAGE),
    TYPE_APPLIANCE: (CONF_DOOR, *CONF_STATUS_NAMES.values()),
    TYPE_CHARGER: (CONF_PLUG, CONF_CHARGING, CONF_FULL_CHARGE, CONF_HOME),
}

# what each kind of device is built around (its unique id, and what Configure can move it to):
# a light / switch, an appliance's power sensor, a charger's battery
BASE_KEYS = {TYPE_APPLIANCE: CONF_POWER, TYPE_CHARGER: CONF_BATTERY}


def _base_selector(kind: str):
    if kind == TYPE_APPLIANCE:
        return _ent(domain="sensor", device_class="power")
    if kind == TYPE_CHARGER:
        return _ent(domain="sensor", device_class="battery")
    return _ent(domain=BASE_DOMAINS[kind])


def _names_clash(user_input: dict) -> bool:
    """Two of an appliance's statuses given the same name (it couldn't tell them apart)."""
    names = [(user_input.get(key) or "").strip() or status for status, key in CONF_STATUS_NAMES.items()]
    return len({n.casefold() for n in names}) < len(names)


def _schema(kind: str, d: dict) -> tuple[dict, dict]:
    """What a kind of device follows, the same on set-up and in options: the everyday fields,
    and the ones under Advanced options."""
    if kind == TYPE_APPLIANCE:
        # what its statuses are called (blank: Empty, Running, Full)
        names = {
            vol.Optional(key, description={"suggested_value": d.get(key) or status}): selector.TextSelector()
            for status, key in CONF_STATUS_NAMES.items()
        }
        return {_opt(d, CONF_DOOR): _ent(domain="binary_sensor")}, names
    if kind == TYPE_CHARGER:
        main = {
            vol.Required(CONF_PLUG, **({"default": d[CONF_PLUG]} if d.get(CONF_PLUG) else {})): _ent(domain=["switch", "input_boolean"]),
            _opt(d, CONF_CHARGING): _ent(domain=["sensor", "binary_sensor"]),
        }
        advanced = {
            _opt(d, CONF_FULL_CHARGE): _ent(domain=["schedule", "binary_sensor", "input_boolean"]),
            _opt(d, CONF_HOME): _ent(domain=["person", "device_tracker", "binary_sensor", "input_boolean"]),
        }
        return main, advanced
    # the sensors that turn it on while they're on (motion, an open door)
    main = {_opt(d, CONF_PRESENCE): _ent(domain=TRIGGER_DOMAINS, multiple=True)}
    if kind == TYPE_LIGHT:
        main[_opt(d, CONF_ILLUMINANCE)] = _ent(domain="sensor", device_class="illuminance", multiple=True)
    # the inverted ones, that turn it on while they're off
    advanced = {
        _opt(d, CONF_PRESENCE_OFF): _ent(domain=TRIGGER_DOMAINS, multiple=True),
        _opt(d, CONF_PAUSE): _ent(domain=["input_boolean", "binary_sensor", "switch"], multiple=True),
    }
    # any / all only means something with several pause entities
    if len(_list(d.get(CONF_PAUSE))) > 1:
        advanced[vol.Optional(CONF_PAUSE_MATCH, default=d.get(CONF_PAUSE_MATCH) or "any")] = selector.SelectSelector(
            selector.SelectSelectorConfig(options=["any", "all"], translation_key=CONF_PAUSE_MATCH, mode=selector.SelectSelectorMode.LIST)
        )
    if kind == TYPE_LIGHT:
        advanced[_opt(d, CONF_DARK_CHECK)] = _ent(domain=["binary_sensor", "input_boolean", "schedule", "switch"])
        advanced[vol.Optional(CONF_MANAGED, default=bool(d.get(CONF_MANAGED, False)))] = selector.BooleanSelector()
    if kind == TYPE_SWITCH:
        advanced[vol.Optional(CONF_OFF_AFTER_OUTAGE, default=bool(d.get(CONF_OFF_AFTER_OUTAGE, True)))] = selector.BooleanSelector()
    return main, advanced


def _list(v) -> list:
    return [v] if isinstance(v, str) else list(v or [])


def _advanced_used(d: dict) -> bool:
    """Something under Advanced options is set: the form shows it open."""
    return bool(
        d.get(CONF_PRESENCE_OFF)
        or d.get(CONF_PAUSE)
        or d.get(CONF_DARK_CHECK)
        or d.get(CONF_MANAGED)
        or d.get(CONF_FULL_CHARGE)
        or d.get(CONF_HOME)
        or d.get(CONF_OFF_AFTER_OUTAGE) is False
        or d.get(CONF_START_ON) is False
        # an appliance's status given a name of its own
        or any((d.get(key) or status) != status for status, key in CONF_STATUS_NAMES.items())
    )


def _form(main: dict, advanced: dict, open_: bool) -> vol.Schema:
    return vol.Schema({**main, vol.Required(ADVANCED): section(vol.Schema(advanced), {"collapsed": not open_})})


def _flat(user_input: dict) -> dict:
    """The form's values with the Advanced options beside the others, as they're saved."""
    return {**{k: v for k, v in user_input.items() if k != ADVANCED}, **(user_input.get(ADVANCED) or {})}


class KnitConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return self.async_show_menu(step_id="user", menu_options=[TYPE_LIGHT, TYPE_SWITCH, TYPE_APPLIANCE, TYPE_CHARGER])

    async def _create(self, kind: str, main: str, user_input: dict) -> ConfigFlowResult:
        await self.async_set_unique_id(f"{kind}:{main}")
        self._abort_if_unique_id_configured()
        st = self.hass.states.get(main)
        name = user_input.pop(CONF_NAME, None) or (st and st.attributes.get("friendly_name")) or main
        return self.async_create_entry(title=name, data={CONF_TYPE: kind, **user_input})

    async def _step(self, kind: str, user_input: dict[str, Any] | None) -> ConfigFlowResult:
        errors: dict = {}
        if user_input is not None:
            user_input = _flat(user_input)
            if not _in_both(user_input):
                return await self._create(kind, user_input[CONF_LIGHT], user_input)
            # (on the form itself: an error on a field under Advanced options wouldn't show)
            errors["base"] = "in_both_lists"
        d = user_input or {}
        main, advanced = _schema(kind, d)
        main = {
            vol.Required(CONF_LIGHT, **({"default": d[CONF_LIGHT]} if d.get(CONF_LIGHT) else {})): _ent(domain=BASE_DOMAINS[kind]),
            _opt(d, CONF_NAME): selector.TextSelector(),
            **main,
        }
        advanced[vol.Optional(CONF_START_ON, default=d.get(CONF_START_ON, True))] = selector.BooleanSelector()
        return self.async_show_form(step_id=kind, data_schema=_form(main, advanced, _advanced_used(d)), errors=errors)

    async def async_step_light(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return await self._step(TYPE_LIGHT, user_input)

    async def async_step_auto_off_switch(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return await self._step(TYPE_SWITCH, user_input)

    async def async_step_appliance(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict = {}
        if user_input is not None:
            user_input = _flat(user_input)
            if _names_clash(user_input):
                errors["base"] = "same_names"
            else:
                return await self._create(TYPE_APPLIANCE, user_input[CONF_POWER], user_input)
        d = user_input or {}
        main, advanced = _schema(TYPE_APPLIANCE, d)
        main = {
            vol.Required(CONF_NAME, **({"default": d[CONF_NAME]} if d.get(CONF_NAME) else {})): selector.TextSelector(),
            vol.Required(CONF_POWER, **({"default": d[CONF_POWER]} if d.get(CONF_POWER) else {})): _ent(domain="sensor", device_class="power"),
            **main,
        }
        return self.async_show_form(step_id="appliance", data_schema=_form(main, advanced, bool(errors) or _advanced_used(d)), errors=errors)

    async def async_step_charger(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            user_input = _flat(user_input)
            return await self._create(TYPE_CHARGER, user_input[CONF_BATTERY], user_input)
        d = {}
        main, advanced = _schema(TYPE_CHARGER, d)
        main = {
            vol.Required(CONF_NAME): selector.TextSelector(),
            vol.Required(CONF_BATTERY): _base_selector(TYPE_CHARGER),
            **main,
        }
        advanced[vol.Optional(CONF_START_ON, default=True)] = selector.BooleanSelector()
        return self.async_show_form(step_id="charger", data_schema=_form(main, advanced, False))

    @staticmethod
    @callback
    def async_get_options_flow(entry: ConfigEntry) -> OptionsFlow:
        return KnitOptionsFlow()


class KnitOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry = self.config_entry
        kind = entry.data.get(CONF_TYPE, TYPE_LIGHT)
        # what it's built around: a light / switch, an appliance's power sensor, a charger's battery
        key = BASE_KEYS.get(kind, CONF_LIGHT)
        current = {**entry.data, **entry.options}
        errors: dict = {}
        if user_input is not None:
            user_input = _flat(user_input)
            # the base entity changed: the device moves to it, keeping its entities, settings and cards
            base = user_input.pop(key, None) or current[key]
            # (errors go on the form itself: one on a field under Advanced options wouldn't show)
            if kind == TYPE_APPLIANCE and _names_clash(user_input):
                errors["base"] = "same_names"
            elif _in_both(user_input):
                errors["base"] = "in_both_lists"
            elif base != current[key]:
                unique_id = f"{kind}:{base}"
                taken = any(
                    e.unique_id == unique_id and e.entry_id != entry.entry_id
                    for e in self.hass.config_entries.async_entries(DOMAIN)
                )
                if taken:
                    errors["base"] = "already_configured"
                else:
                    self.hass.config_entries.async_update_entry(
                        entry, data={**entry.data, key: base}, unique_id=unique_id
                    )
            # any / all isn't asked with fewer than two pause entities: it stays as it was
            if CONF_PAUSE_MATCH in OPTION_FIELDS[kind]:
                user_input.setdefault(CONF_PAUSE_MATCH, current.get(CONF_PAUSE_MATCH))
            if not errors:
                # a field cleared in the form is left out of user_input: save it as cleared
                return self.async_create_entry(data={k: user_input.get(k) for k in OPTION_FIELDS[kind]})
            current = {**{k: v for k, v in current.items() if k not in OPTION_FIELDS[kind]}, **user_input, key: base}
        main, advanced = _schema(kind, current)
        # moving it to another light (or plug) is rare: last, under Advanced options
        advanced[vol.Required(key, default=current[key])] = _base_selector(kind)
        open_ = bool(errors) or _advanced_used({k: current.get(k) for k in OPTION_FIELDS[kind]})
        return self.async_show_form(step_id=kind, data_schema=_form(main, advanced, open_), errors=errors)

    # the form is shown under the device kind's own step, for its own labels
    async def async_step_light(self, user_input=None):
        return await self.async_step_init(user_input)

    async def async_step_auto_off_switch(self, user_input=None):
        return await self.async_step_init(user_input)

    async def async_step_appliance(self, user_input=None):
        return await self.async_step_init(user_input)

    async def async_step_charger(self, user_input=None):
        return await self.async_step_init(user_input)


__all__ = ["KnitConfigFlow"]
