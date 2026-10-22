"""The decisions behind one charger (a device on a smart plug that charges it), with no Home Assistant in it.

The controller feeds it the battery level, whether the device says it's charging, the plug, the
full-charge schedule and whether its person is home; it says what the plug should do.

  On      when the battery drops under `start_below` (only while its person is home), or a
          full charge is due (the full-charge schedule is on) and it's under `full_below`.
  Off     once the battery has reached the target (`stop_at`, or 100% during a full charge)
          and the device says it's charging (or full). A level that's only an old reading
          (the device off the Wi-Fi) never turns it off while the device isn't seen charging.
  Between the two it's left as it is, so a charge carries on up to the target, and a plug
  turned on by hand or by something else (to wake the device) stays on until the device
  reports. With Automatic off nothing is changed.
"""

from __future__ import annotations

from dataclasses import dataclass, field

ON = "on"
OFF = "off"

# what the card and the Status sensor say
CHARGING = "charging"  # the plug is on and the device is charging
NOT_CHARGING = "not_charging"  # the plug is on, the device isn't charging (off its dock, or not reporting)
IDLE = "idle"  # the plug is off: it turns on once the battery is low
AWAY = "away"  # the plug is off, the battery is low, and its person is out
MANUAL = "manual"  # Automatic is off: the plug is left as it is
NO_READING = "no_reading"  # no battery level
STATUSES = [CHARGING, NOT_CHARGING, IDLE, AWAY, MANUAL, NO_READING]


@dataclass
class ChargerSettings:
    stop_at: float = 80  # %
    start_below: float = 30  # %
    automatic: bool = True
    full_below: float = 95  # % : a full charge only starts under this


@dataclass
class Charger:
    settings: ChargerSettings = field(default_factory=ChargerSettings)
    level: float | None = None
    charging: bool | None = None  # the device's own charging state (None: it has none)
    plug_on: bool | None = None
    full: bool = False  # the full-charge schedule is on
    home: bool = True  # its person is home (always, without one)

    # ---- derived ----------------------------------------------------------------------

    def target(self) -> float:
        return 100.0 if self.full else float(self.settings.stop_at)

    def wants_start(self) -> bool:
        s = self.settings
        if self.level is None or not self.home:
            return False
        return self.level < s.start_below or (self.full and self.level < s.full_below)

    def reached(self) -> bool:
        """At the target, and seen charging (a device without a charging state: the level alone)."""
        if self.level is None or self.level < self.target():
            return False
        return self.charging is not False

    def decide(self) -> str | None:
        """ON / OFF for the plug, or None to leave it."""
        if not self.settings.automatic or self.level is None or self.plug_on is None:
            return None
        start = self.wants_start()
        if start and not self.plug_on:
            return ON
        if not start and self.plug_on and self.reached():
            return OFF
        return None

    def status(self) -> str:
        if self.level is None:
            return NO_READING
        if not self.settings.automatic:
            return MANUAL
        if self.plug_on:
            return NOT_CHARGING if self.charging is False else CHARGING
        if not self.home and self.level < self.settings.start_below:
            return AWAY
        return IDLE
