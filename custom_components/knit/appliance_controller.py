"""Connects one appliance's engine to Home Assistant: power and door in, status and events out.

The status lives on the device's Status select (automations can follow it, and the events).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from homeassistant.const import STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_point_in_utc_time, async_track_state_change_event
from homeassistant.util import dt as dt_util

from .appliance import STATUSES, Appliance
from .const import CONF_DOOR, CONF_POWER, EVENT_APPLIANCE, SIGNAL_UPDATE

_LOGGER = logging.getLogger(__name__)
NO_VALUE = (STATE_UNAVAILABLE, STATE_UNKNOWN, None)


class ApplianceController:
    def __init__(self, hass: HomeAssistant, entry_id: str, name: str, conf: dict) -> None:
        self.hass = hass
        self.entry_id = entry_id
        self.name = name
        self.power: str = conf[CONF_POWER]
        self.door: str | None = conf.get(CONF_DOOR) or None
        self.anchor = self.power  # what the card finds this device's entities by
        self.engine = Appliance()
        self._unsubs: list = []
        self._wake = None
        self._started = False
        self._status_since: datetime | None = None  # when the restored status was set

    # ---- set up / tear down -------------------------------------------------------------

    @callback
    def start(self) -> None:
        """Read the current states, then follow changes."""
        e = self.engine
        now = dt_util.utcnow()
        # only a running cycle has a countdown
        if e.status != "Running":
            e.cycle_ends = e.cycle_total = None
        e.set_power(self._power(), now)
        e.door_open = self._door()
        # the door open at start-up: counted from when it opened, if that was after the status
        # was set (opened to empty it). Open since before then, it read open through the cycle
        # (a sensor that missed the door closing): left as checked, as it would have been
        st = self.hass.states.get(self.door) if self.door else None
        if e.door_open and st:
            opened = min(st.last_changed, now)
            e.door_since = opened
            e.door_checked = bool(self._status_since and opened < self._status_since)
        watch = [self.power] + ([self.door] if self.door else [])
        self._unsubs.append(async_track_state_change_event(self.hass, watch, self._changed))
        self._started = True
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
    def restore(
        self, status: str | None, cycle_ends: datetime | None, cycle_total: float | None, since: datetime | None = None
    ) -> None:
        """The Status select (and when it was set) and the countdown, as they were before a restart."""
        if status in STATUSES:
            self.engine.status = status
            self._status_since = since
        if cycle_ends and cycle_total:
            self.engine.cycle_ends = cycle_ends
            self.engine.cycle_total = cycle_total

    @callback
    def set_setting(self, name: str, value) -> None:
        if not self._started:
            setattr(self.engine.settings, name, value)
            return
        self._fire(self.engine.update_settings(dt_util.utcnow(), **{name: value}))

    @callback
    def set_status(self, status: str) -> None:
        """A correction from the Status select (or the card)."""
        self._fire(self.engine.set_status(status, dt_util.utcnow()))

    @callback
    def _changed(self, event: Event[EventStateChangedData]) -> None:
        eid = event.data["entity_id"]
        now = dt_util.utcnow()
        e = self.engine
        out: list[str] = []
        if eid == self.power:
            out += e.set_power(self._power(), now)
        if eid == self.door:
            out += e.set_door(self._door(), now)
        self._fire(out)

    # ---- readings -----------------------------------------------------------------------

    def _power(self) -> float | None:
        st = self.hass.states.get(self.power)
        try:
            return float(st.state) if st and st.state not in NO_VALUE else None
        except ValueError:
            return None

    def _door(self) -> bool | None:
        st = self.hass.states.get(self.door) if self.door else None
        return None if not st or st.state in NO_VALUE else st.state == STATE_ON

    # ---- outputs ------------------------------------------------------------------------

    @callback
    def _fire(self, events: list[str]) -> None:
        for ev in events:
            self.hass.bus.async_fire(
                EVENT_APPLIANCE.format(ev), {"device": self.name, "entry_id": self.entry_id, "status": self.engine.status}
            )
        self._update()

    @callback
    def _update(self) -> None:
        if self._wake:
            self._wake()
            self._wake = None
        nxt = self.engine.next_deadline()
        if nxt:
            # a moment after, so the time has passed when the engine looks
            self._wake = async_track_point_in_utc_time(self.hass, self._tick, nxt + timedelta(milliseconds=50))
        async_dispatcher_send(self.hass, SIGNAL_UPDATE.format(self.entry_id))

    @callback
    def _tick(self, now: datetime) -> None:
        self._wake = None
        self._fire(self.engine.tick(dt_util.utcnow()))
