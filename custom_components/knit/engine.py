"""The decisions behind one light (or motion-controlled device), with no Home Assistant in it.

The controller feeds it what happens (presence, the light, the light level, the settings,
the time) and carries out what it returns: turn the light on, off, or to a brightness.
It also says when it next needs the time (`next_deadline`), so the controller can wake it.

Behaviour, per light:

  Motion       on: presence turns the light on (only when dark while Light level is on)
               and turns it off again. Off: presence does nothing.
  Motion timeout  with Motion on, once the room is empty the light goes off after `auto_off`
               seconds; the last `dim` seconds of that (at most 75%) it is dimmed to half,
               and someone coming back puts the brightness back.
  Light level  on: once it has counted as light (above Light above) for `off_after`
               seconds the light goes off. With Motion off it also turns the light on when
               it gets dark. Off: the light level is ignored.
  Paused       (an entity such as guests being on): nothing happens at all.
  turn_on      False for a motion-controlled device: presence never turns it on,
               it only goes off once the room has been empty for the timeout.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

DIM_MAX = 0.75  # the dim is at most this share of the auto-off

ON = "on"
OFF = "off"
BRIGHTNESS = "brightness"


@dataclass
class Action:
    """What the controller should do: ON (brightness or None), OFF, or BRIGHTNESS."""

    kind: str
    brightness: int | None = None


@dataclass
class Settings:
    motion: bool = True
    turn_on: bool = True  # presence turns it on (False: a motion-controlled device)
    auto_off: bool = True
    light_level: bool = True
    auto_off_secs: float = 300
    dim_secs: float = 60
    dark_below: float = 10
    light_above: float | None = None  # None: 1.5 x dark_below
    off_after_secs: float = 300


@dataclass
class Countdown:
    ends: datetime
    total: float


@dataclass
class Engine:
    settings: Settings = field(default_factory=Settings)
    dimmable: bool = True
    occupied: bool | None = None
    light_on: bool = False
    brightness: int | None = None
    lux: float | None = None
    shared_dark: bool | None = None  # a dark sensor shared with other rooms, instead of lux
    paused: bool = False
    dark: bool | None = None
    auto: Countdown | None = None  # the auto-off, dim included
    dim_at: datetime | None = None
    dimmed: bool = False
    restore: int | None = None  # the brightness from before the dim, to put back
    light: Countdown | None = None  # off when light

    # ---- derived ----------------------------------------------------------------------

    def light_above(self) -> float:
        s = self.settings
        above = s.light_above if s.light_above is not None else s.dark_below * 1.5
        return max(above, s.dark_below)

    def next_deadline(self) -> datetime | None:
        times = [t for t in (self.dim_at, self.auto and self.auto.ends, self.light and self.light.ends) if t]
        return min(times) if times else None

    # ---- inputs ---------------------------------------------------------------------------

    def set_occupied(self, occupied: bool | None, now: datetime) -> list[Action]:
        if occupied is None or occupied == self.occupied:
            self.occupied = occupied if occupied is not None else self.occupied
            return []
        self.occupied = occupied
        out: list[Action] = []
        if self.paused:
            return out
        if occupied:
            out += self._cancel_auto(restore=True)
            s = self.settings
            if s.motion and s.turn_on and not self.light_on and (not s.light_level or self.dark):
                out.append(self._turn_on())
        else:
            out += self._maybe_start_auto(now)
        return out

    def set_light(self, on: bool, brightness: int | None, now: datetime) -> list[Action]:
        was = self.light_on
        self.light_on = on
        self.brightness = brightness if on else None
        out: list[Action] = []
        if on == was:
            return out
        if not on:
            # it waits for the light to come back on at the dimmed level (restore stays)
            self.auto = None
            self.dim_at = None
            self.dimmed = False
            self.light = None
            return out
        # came on at (or below) the dimmed level while a brightness is waiting: put it back
        if self.restore is not None:
            if brightness is not None and brightness <= self.restore // 2 + 3:
                out.append(Action(BRIGHTNESS, self.restore))
                self.brightness = self.restore
            self.restore = None
        if not self.paused and self.occupied is False:
            out += self._maybe_start_auto(now)
        return out

    def set_brightness(self, brightness: int | None) -> None:
        if self.light_on:
            self.brightness = brightness

    def set_lux(self, lux: float | None, now: datetime) -> list[Action]:
        self.lux = lux
        return self._update_dark(now)

    def set_shared_dark(self, dark: bool | None, now: datetime) -> list[Action]:
        self.shared_dark = dark
        return self._update_dark(now)

    def set_paused(self, paused: bool, now: datetime) -> list[Action]:
        if paused == self.paused:
            return []
        self.paused = paused
        if paused:
            self.light = None
            return self._cancel_auto(restore=True)
        # the pause is over: a light left on in an empty room counts down, and one on while it
        # counts as light starts its off-when-light countdown, as if they'd just happened
        out: list[Action] = []
        if self.occupied is False:
            out += self._maybe_start_auto(now)
        if self.light_on and self.dark is False:
            out += self._start_light(now)
        return out

    def update_settings(self, now: datetime, **changes) -> list[Action]:
        s = self.settings
        before = Settings(**vars(s))
        for k, v in changes.items():
            setattr(s, k, v)
        out: list[Action] = []
        if self.paused:
            return out
        # Motion or Auto-off off: stop the countdown, undo the dim
        if (before.motion and not s.motion) or (before.auto_off and not s.auto_off):
            out += self._cancel_auto(restore=True)
        # back on with the room empty and the light on: count down from now
        if (not before.motion and s.motion) or (not before.auto_off and s.auto_off):
            if self.occupied is False:
                out += self._maybe_start_auto(now)
        if before.light_level and not s.light_level:
            self.light = None
        # the light level setting moved: the room may now count as dark or light
        if (before.dark_below, before.light_above) != (s.dark_below, s.light_above):
            out += self._update_dark(now)
        # Motion off / Light level on while it's already dark: on
        if (before.motion and not s.motion) or (not before.light_level and s.light_level):
            out += self._on_when_dark()
        return out

    def resume(self) -> None:
        """At start-up, with a brightness from before a dim restored: the light still on at the
        dimmed level is still dimmed (someone coming back puts it back); on at any other
        brightness, the dim was undone some other way and there's nothing to put back."""
        if self.restore is None or not self.light_on:
            return
        if self.brightness is not None and self.brightness <= self.restore // 2 + 3:
            self.dimmed = True
        else:
            self.restore = None

    def start_if_empty(self, now: datetime) -> list[Action]:
        """At start-up: the light already on in an empty room counts down."""
        if self.paused or self.occupied is not False:
            return []
        return self._maybe_start_auto(now)

    def tick(self, now: datetime) -> list[Action]:
        out: list[Action] = []
        if self.dim_at and now >= self.dim_at:
            self.dim_at = None
            if self.light_on and self.brightness and not self.dimmed:
                if self.restore is None:
                    self.restore = self.brightness
                half = max(self.brightness // 2, 1)
                out.append(Action(BRIGHTNESS, half))
                self.brightness = half
                self.dimmed = True
        if self.auto and now >= self.auto.ends:
            self.auto = None
            self.dimmed = False
            if self.light_on:
                out.append(self._off())
        if self.light and now >= self.light.ends:
            self.light = None
            if self.light_on and self.settings.light_level and not self.paused:
                out.append(self._off())
        return out

    # ---- internals ------------------------------------------------------------------------

    def _maybe_start_auto(self, now: datetime) -> list[Action]:
        s = self.settings
        if not (s.motion and s.auto_off and self.light_on) or self.auto:
            return []
        total = max(float(s.auto_off_secs), 0)
        if total == 0:
            return [self._off()]
        dim = min(float(s.dim_secs), total * DIM_MAX) if self.dimmable else 0
        self.auto = Countdown(now + timedelta(seconds=total), total)
        self.dim_at = now + timedelta(seconds=total - dim) if dim >= 1 else None
        return []

    def _cancel_auto(self, restore: bool) -> list[Action]:
        out: list[Action] = []
        self.auto = None
        self.dim_at = None
        if restore and self.dimmed and self.light_on and self.restore is not None:
            out.append(Action(BRIGHTNESS, self.restore))
            self.brightness = self.restore
            self.restore = None
        self.dimmed = False
        return out

    def _on_when_dark(self) -> list[Action]:
        s = self.settings
        if not self.paused and not s.motion and s.light_level and self.dark and not self.light_on:
            return [self._turn_on()]
        return []

    def _turn_on(self) -> Action:
        """On, at the brightness from before a dim if it went off dimmed (a light keeps the last
        brightness it had, so it would come back dimmed). That brightness is kept until the light
        reports on, so a turn-on that fails doesn't lose it."""
        return Action(ON, self.restore)

    def _off(self) -> Action:
        """Off, counted as off straight away: someone coming in before the light reports off
        turns it back on, instead of being taken as finding it on. (Were the off to fail, the
        light's next report puts this right.)"""
        self.light_on = False
        self.brightness = None
        self.auto = None
        self.dim_at = None
        self.dimmed = False
        self.light = None
        return Action(OFF)

    def _start_light(self, now: datetime) -> list[Action]:
        """It counts as light with the light on: off after Off when light after."""
        if not self.settings.light_level or not self.light_on or self.paused or self.light:
            return []
        total = max(float(self.settings.off_after_secs), 0)
        if total == 0:
            return [self._off()]
        self.light = Countdown(now + timedelta(seconds=total), total)
        return []

    def _update_dark(self, now: datetime) -> list[Action]:
        was = self.dark
        if self.shared_dark is not None:
            self.dark = self.shared_dark
        elif self.lux is not None:
            if self.dark is None:
                self.dark = self.lux < self.settings.dark_below
            elif self.dark and self.lux > self.light_above():
                self.dark = False
            elif not self.dark and self.lux < self.settings.dark_below:
                self.dark = True
        if self.dark == was or self.dark is None or was is None:
            return []
        out: list[Action] = []
        if self.dark:
            self.light = None
            out += self._on_when_dark()
        else:
            out += self._start_light(now)
        return out
