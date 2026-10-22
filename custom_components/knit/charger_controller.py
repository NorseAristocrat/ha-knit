"""Connects one charger's engine to Home Assistant: the battery, charging state, plug, full-charge
schedule and person in, the plug turned on and off.
"""

from __future__ import annotations

import logging
import time

from homeassistant.const import STATE_HOME, STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_state_change_event

from .charger import OFF, ON, Charger
from .const import CONF_BATTERY, CONF_CHARGING, CONF_FULL_CHARGE, CONF_HOME, CONF_PLUG, SIGNAL_UPDATE

_LOGGER = logging.getLogger(__name__)
NO_VALUE = (STATE_UNAVAILABLE, STATE_UNKNOWN, None)
# what a charging-state sensor says while it's charging (Android: charging, full)
CHARGING_STATES = ("charging", "full", STATE_ON)
# the same command isn't sent again this soon while the plug hasn't changed
RESEND_SECS = 30


class ChargerController:
    def __init__(self, hass: HomeAssistant, entry_id: str, name: str, conf: dict) -> None:
        self.hass = hass
        self.entry_id = entry_id
        self.name = name
        self.battery: str = conf[CONF_BATTERY]
        self.plug: str = conf[CONF_PLUG]
        self.charging: str | None = conf.get(CONF_CHARGING) or None
        self.full_charge: str | None = conf.get(CONF_FULL_CHARGE) or None
        self.home: str | None = conf.get(CONF_HOME) or None
        self.anchor = self.battery  # what the card finds this device's entities by
        self.engine = Charger()
        self._unsubs: list = []
        self._started = False
        self._sent: tuple[str, float] | None = None  # the last command and when

    # ---- set up / tear down -------------------------------------------------------------

    @callback
    def start(self) -> None:
        self._read()
        watch = [x for x in (self.battery, self.charging, self.plug, self.full_charge, self.home) if x]
        self._unsubs.append(async_track_state_change_event(self.hass, watch, self._changed))
        self._started = True
        self._act()

    @callback
    def stop(self) -> None:
        for u in self._unsubs:
            u()
        self._unsubs.clear()

    # ---- inputs -------------------------------------------------------------------------

    @callback
    def set_setting(self, name: str, value) -> None:
        setattr(self.engine.settings, name, value)
        if self._started:
            self._act()

    @callback
    def _changed(self, event: Event[EventStateChangedData]) -> None:
        if event.data["entity_id"] == self.plug:
            self._sent = None  # it changed: a command may be needed again
        self._read()
        self._act()

    # ---- readings -----------------------------------------------------------------------

    def _state(self, entity: str | None) -> str | None:
        st = self.hass.states.get(entity) if entity else None
        return None if not st or st.state in NO_VALUE else st.state

    @callback
    def _read(self) -> None:
        e = self.engine
        level = self._state(self.battery)
        try:
            e.level = float(level) if level is not None else None
        except ValueError:
            e.level = None
        # with a charging state: on while it says charging / full (unreadable counts as not charging,
        # so an unknown state never lets a stale level turn the plug off)
        if self.charging:
            e.charging = (self._state(self.charging) or "").lower() in CHARGING_STATES
        else:
            e.charging = None
        plug = self._state(self.plug)
        e.plug_on = None if plug is None else plug == STATE_ON
        e.full = self._state(self.full_charge) == STATE_ON if self.full_charge else False
        if self.home:
            st = self._state(self.home)
            e.home = st in (STATE_HOME, STATE_ON)
        else:
            e.home = True

    # ---- outputs ------------------------------------------------------------------------

    @callback
    def _act(self) -> None:
        cmd = self.engine.decide()
        if cmd:
            self._call(cmd)
        async_dispatcher_send(self.hass, SIGNAL_UPDATE.format(self.entry_id))

    @callback
    def _call(self, cmd: str) -> None:
        now = time.monotonic()
        if self._sent and self._sent[0] == cmd and now - self._sent[1] < RESEND_SECS:
            return
        self._sent = (cmd, now)
        domain = self.plug.split(".")[0]
        service = "turn_on" if cmd == ON else "turn_off"
        _LOGGER.debug("%s: plug %s (battery %s%%)", self.name, cmd, self.engine.level)
        self.hass.async_create_task(
            self.hass.services.async_call(domain, service, {"entity_id": self.plug}, blocking=False)
        )
