"""Connects one light's (or motion-controlled device's) engine to Home Assistant: state changes in,
service calls out."""

from __future__ import annotations

import logging
from datetime import datetime

from homeassistant.const import STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_point_in_utc_time, async_track_state_change_event
from homeassistant.util import dt as dt_util

from .const import (
    CONF_ILLUMINANCE,
    CONF_LIGHT,
    CONF_OFF_AFTER_OUTAGE,
    CONF_PAUSE,
    CONF_PRESENCE,
    CONF_TYPE,
    SIGNAL_UPDATE,
    TYPE_SWITCH,
)
from .engine import BRIGHTNESS, OFF, ON, Action, Engine
from .entity import dimmable

_LOGGER = logging.getLogger(__name__)
NO_VALUE = (STATE_UNAVAILABLE, STATE_UNKNOWN, None)


class LightController:
    """One light (or motion-controlled device): listens, asks the engine, carries out what it says."""

    def __init__(self, hass: HomeAssistant, entry_id: str, conf: dict) -> None:
        self.hass = hass
        self.entry_id = entry_id
        self.light: str = conf[CONF_LIGHT]
        self.anchor = self.light  # what the card finds this device's entities by
        self.switch_only = conf.get(CONF_TYPE) == TYPE_SWITCH
        self.off_after_outage = bool(conf.get(CONF_OFF_AFTER_OUTAGE))
        presence = conf.get(CONF_PRESENCE) or []
        self.presence: list[str] = [presence] if isinstance(presence, str) else list(presence)
        lux = conf.get(CONF_ILLUMINANCE) or []
        # one or more light sensors (a single one in entries made before 0.3)
        self.illuminance: list[str] = [lux] if isinstance(lux, str) else list(lux)
        self.pause: str | None = conf.get(CONF_PAUSE) or None
        self.engine = Engine()
        # a feature with no sensor is off (and has no switch): with only a light sensor, the
        # light follows the light level (on when dark, off when light)
        self.engine.settings.motion = bool(self.presence)
        self.engine.settings.light_level = bool(self.illuminance) and not self.switch_only
        # a motion-controlled device: presence never turns it on, and it has no light level
        self.engine.settings.turn_on = not self.switch_only
        self._unsubs: list = []
        self._wake = None
        self._started = False

    # ---- set up / tear down -------------------------------------------------------------

    @callback
    def start(self) -> None:
        """Read the current states (without acting on them), then follow changes."""
        e = self.engine
        now = dt_util.utcnow()
        st = self.hass.states.get(self.light)
        # from the registry too: at start-up the light may not have reported in yet
        e.dimmable = dimmable(self.hass, self.light)
        e.light_on = bool(st and st.state == STATE_ON)
        e.brightness = st.attributes.get("brightness") if st and e.light_on else None
        # still dimmed from before a restart? (someone coming back then puts it back)
        e.resume()
        e.occupied = self._occupied()
        e.paused = self._is_on(self.pause)
        e.set_lux(self.lux(), now)
        watch = [self.light, *self.presence, *self.illuminance]
        if self.pause:
            watch.append(self.pause)
        self._unsubs.append(async_track_state_change_event(self.hass, watch, self._changed))
        self._started = True
        # the light on in an empty room when it starts: count down
        if e.light_on and e.occupied is False:
            self._do(e.start_if_empty(now))
        self._update()

    @callback
    def stop(self) -> None:
        for u in self._unsubs:
            u()
        self._unsubs.clear()
        if self._wake:
            self._wake()
            self._wake = None

    # ---- inputs -------------------------------------------------------------------------

    @callback
    def set_setting(self, name: str, value) -> None:
        """A switch or number changed (or was restored before start)."""
        if not self._started:
            setattr(self.engine.settings, name, value)
            return
        self._do(self.engine.update_settings(dt_util.utcnow(), **{name: value}))

    @callback
    def _changed(self, event: Event[EventStateChangedData]) -> None:
        eid = event.data["entity_id"]
        new = event.data["new_state"]
        now = dt_util.utcnow()
        e = self.engine
        out: list[Action] = []
        if eid == self.light:
            if new is None or new.state in NO_VALUE:
                return
            # back from a power cut (or a Wi-Fi drop) switched on: off again, if asked to
            old = event.data["old_state"]
            if self.off_after_outage and new.state == STATE_ON and old is not None and old.state in (STATE_UNAVAILABLE,):
                self.hass.async_create_task(self._call(self.light.split(".")[0], "turn_off", {}))
            on = new.state == STATE_ON
            bri = new.attributes.get("brightness")
            # what it can do, once it has reported in
            modes = new.attributes.get("supported_color_modes")
            if modes:
                e.dimmable = self.light.startswith("light.") and any(m != "onoff" for m in modes)
            if on == e.light_on:
                e.set_brightness(bri)
            else:
                out = e.set_light(on, bri, now)
        if eid in self.presence:
            out += e.set_occupied(self._occupied(), now)
        if eid in self.illuminance:
            out += e.set_lux(self.lux(), now)
        if eid == self.pause:
            out += e.set_paused(self._is_on(self.pause), now)
        self._do(out)

    # ---- readings -----------------------------------------------------------------------

    def _occupied(self) -> bool | None:
        states = [self.hass.states.get(p) for p in self.presence]
        known = [s for s in states if s and s.state not in NO_VALUE]
        if not known:
            return None
        return any(s.state == STATE_ON for s in known)

    def lux(self) -> float | None:
        """The average of the light sensors that have a reading (None when none do)."""
        values = []
        for eid in self.illuminance:
            st = self.hass.states.get(eid)
            try:
                if st and st.state not in NO_VALUE:
                    values.append(float(st.state))
            except ValueError:
                continue
        return sum(values) / len(values) if values else None

    def _is_on(self, eid: str | None) -> bool:
        st = self.hass.states.get(eid) if eid else None
        return bool(st and st.state == STATE_ON)

    # ---- outputs ------------------------------------------------------------------------

    @callback
    def _do(self, actions: list[Action]) -> None:
        domain = self.light.split(".")[0]
        for a in actions:
            if a.kind == OFF:
                self.hass.async_create_task(self._call(domain, "turn_off", {}))
            elif a.kind == ON:
                data = {"brightness": a.brightness} if a.brightness and domain == "light" else {}
                self.hass.async_create_task(self._call(domain, "turn_on", data))
            elif a.kind == BRIGHTNESS and domain == "light" and a.brightness:
                self.hass.async_create_task(self._call("light", "turn_on", {"brightness": a.brightness}))
        self._update()

    async def _call(self, domain: str, service: str, data: dict) -> None:
        try:
            await self.hass.services.async_call(domain, service, {"entity_id": self.light, **data}, blocking=True)
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("%s: %s.%s failed: %s", self.light, domain, service, err)

    @callback
    def _update(self) -> None:
        """Wake at the next deadline, and tell the entities to redraw."""
        if self._wake:
            self._wake()
            self._wake = None
        nxt = self.engine.next_deadline()
        if nxt:
            self._wake = async_track_point_in_utc_time(self.hass, self._tick, nxt)
        async_dispatcher_send(self.hass, SIGNAL_UPDATE.format(self.entry_id))

    @callback
    def _tick(self, now: datetime) -> None:
        self._wake = None
        self._do(self.engine.tick(dt_util.utcnow()))
