"""The decisions behind one appliance (a dishwasher, a washing machine), with no Home Assistant in it.

The controller feeds it the power, the door and the time; it keeps the status and returns the
events to fire. It also says when it next needs the time (`next_deadline`).

  Running   once the power has been above `running_above` W for `running_after` seconds
            (from any status), and a cycle countdown of `cycle_secs` starts.
  Full      once, while Running, the power has been below it for `finished_after` seconds,
            so the pauses between wash phases don't end it.
  Empty     when the door has been open for `empty_after` seconds (checked once, at that
            moment) and it isn't drawing power; or, if the door sensor missed the door closing (it read open through a
            cycle), when the door closes after reading open that long while Full.
  The status can also be set by hand (a correction): Running starts the countdown, anything
  else stops it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

EMPTY = "Empty"
RUNNING = "Running"
FULL = "Full"
STATUSES = [EMPTY, RUNNING, FULL]

STARTED = "started"
FINISHED = "finished"
EMPTIED = "emptied"


@dataclass
class ApplianceSettings:
    running_above: float = 20  # W
    running_after: float = 60  # s above it before it counts as running
    finished_after: float = 300  # s below it before a cycle counts as finished
    cycle_secs: float = 7200  # how long a cycle usually takes (the countdown)
    empty_after: float = 60  # s with the door open before it counts as emptied


@dataclass
class Appliance:
    settings: ApplianceSettings = field(default_factory=ApplianceSettings)
    status: str = EMPTY
    power: float | None = None
    door_open: bool | None = None
    above_since: datetime | None = None  # power above the threshold since
    below_since: datetime | None = None  # power below it since
    door_since: datetime | None = None  # door open since
    door_checked: bool = False  # the "open for empty_after" moment has been checked
    cycle_ends: datetime | None = None
    cycle_total: float | None = None

    # ---- derived ----------------------------------------------------------------------

    def drawing(self) -> bool:
        return self.power is not None and self.power > self.settings.running_above

    def next_deadline(self) -> datetime | None:
        s = self.settings
        times = []
        if self.above_since and self.status != RUNNING:
            times.append(self.above_since + timedelta(seconds=s.running_after))
        if self.below_since and self.status == RUNNING:
            times.append(self.below_since + timedelta(seconds=s.finished_after))
        if self.door_since and not self.door_checked:
            times.append(self.door_since + timedelta(seconds=s.empty_after))
        return min(times) if times else None

    # ---- inputs ---------------------------------------------------------------------------

    def set_power(self, power: float | None, now: datetime) -> list[str]:
        if power is None:
            return []  # a dropout: keep counting from what it was
        was = self.drawing()
        self.power = power
        if self.drawing() and not was:
            self.above_since, self.below_since = now, None
        elif not self.drawing() and (was or self.below_since is None):
            self.below_since, self.above_since = now, None
        return self.tick(now)

    def set_door(self, door_open: bool | None, now: datetime) -> list[str]:
        if door_open is None or door_open == self.door_open:
            self.door_open = door_open if door_open is not None else self.door_open
            return []
        out: list[str] = []
        was_open_since = self.door_since
        self.door_open = door_open
        if door_open:
            self.door_since = now
            self.door_checked = False
        else:
            self.door_since = None
            # the sensor missed the door closing (read open through the cycle): closing after
            # reading open long enough while Full means it has been emptied
            if (
                self.status == FULL
                and was_open_since
                and (now - was_open_since).total_seconds() >= self.settings.empty_after
            ):
                out += self._set(EMPTY, now)
        return out + self.tick(now)

    def set_status(self, status: str, now: datetime) -> list[str]:
        """A correction by hand. Set to Empty or Full while it draws power (a dishwasher drying),
        it isn't counted as running again until the power has dropped and risen again."""
        if status not in STATUSES or status == self.status:
            return []
        if status != RUNNING:
            self.above_since = None
        return self._set(status, now)

    def update_settings(self, now: datetime, **changes) -> list[str]:
        for k, v in changes.items():
            setattr(self.settings, k, v)
        # a running countdown follows a new cycle length
        if "cycle_secs" in changes and self.status == RUNNING and self.cycle_ends and self.cycle_total:
            started = self.cycle_ends - timedelta(seconds=self.cycle_total)
            self.cycle_total = float(self.settings.cycle_secs)
            self.cycle_ends = started + timedelta(seconds=self.cycle_total)
        # a threshold change can make the power count as on or off
        if "running_above" in changes and self.power is not None:
            p, self.power = self.power, None
            return self.set_power(p, now)
        return self.tick(now)

    def tick(self, now: datetime) -> list[str]:
        s = self.settings
        out: list[str] = []
        if self.status != RUNNING and self.above_since and now >= self.above_since + timedelta(seconds=s.running_after):
            out += self._set(RUNNING, now)
        if self.status == RUNNING and self.below_since and now >= self.below_since + timedelta(seconds=s.finished_after):
            out += self._set(FULL, now)
        # the door open for empty_after: checked once, at that moment (a sensor stuck reading
        # open doesn't empty it the moment a cycle ends)
        if self.door_open and self.door_since and not self.door_checked and now >= self.door_since + timedelta(seconds=s.empty_after):
            self.door_checked = True
            if self.status != EMPTY and not self.drawing():
                out += self._set(EMPTY, now)
        return out

    # ---- internals ------------------------------------------------------------------------

    def _set(self, status: str, now: datetime) -> list[str]:
        before = self.status
        self.status = status
        if status == RUNNING:
            self.cycle_total = float(self.settings.cycle_secs)
            self.cycle_ends = now + timedelta(seconds=self.cycle_total) if self.cycle_total > 0 else None
            # it has been running a while already: don't wait out "finished after" from before
            if not self.drawing():
                self.below_since = now
            return [STARTED]
        self.cycle_ends = None
        self.cycle_total = None
        if status == FULL and before == RUNNING:
            return [FINISHED]
        if status == EMPTY and before != EMPTY:
            return [EMPTIED]
        return []
