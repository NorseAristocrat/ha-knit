"""Unit tests for the charger engine (plain Python: python -m unittest discover tests)."""

import importlib.util
import pathlib
import sys
import unittest

_path = pathlib.Path(__file__).parents[1] / "custom_components" / "knit" / "charger.py"
_spec = importlib.util.spec_from_file_location("charger", _path)
charger = importlib.util.module_from_spec(_spec)
sys.modules["charger"] = charger
_spec.loader.exec_module(charger)
C, Settings = charger.Charger, charger.ChargerSettings
ON, OFF = charger.ON, charger.OFF


def make(level, plug_on=False, charging=None, **kw):
    s = {k: kw.pop(k) for k in list(kw) if k in ("stop_at", "start_below", "automatic", "full_below")}
    return C(settings=Settings(**{"stop_at": 80, "start_below": 30, **s}), level=level, plug_on=plug_on, charging=charging, **kw)


class Decide(unittest.TestCase):
    def test_on_under_start_below(self):
        self.assertEqual(make(29).decide(), ON)
        self.assertIsNone(make(30).decide())

    def test_left_alone_between_the_levels(self):
        # off stays off, on (charging) stays on until the target
        self.assertIsNone(make(50).decide())
        self.assertIsNone(make(50, plug_on=True, charging=True).decide())

    def test_off_at_stop_when_charging(self):
        self.assertEqual(make(80, plug_on=True, charging=True).decide(), OFF)

    def test_an_old_reading_doesnt_turn_it_off(self):
        # turned on to wake a device that's off the Wi-Fi: its last reading was above the target
        # and not charging; it stays on until the device reports
        self.assertIsNone(make(93, plug_on=True, charging=False).decide())

    def test_without_a_charging_state_the_level_alone(self):
        self.assertEqual(make(85, plug_on=True, charging=None).decide(), OFF)

    def test_only_while_home(self):
        self.assertIsNone(make(10, home=False).decide())
        # a charge already going carries on to the target while they're out
        self.assertEqual(make(80, plug_on=True, charging=True, home=False).decide(), OFF)
        self.assertIsNone(make(60, plug_on=True, charging=True, home=False).decide())

    def test_full_charge(self):
        self.assertEqual(make(90, full=True).decide(), ON)
        self.assertIsNone(make(96, full=True).decide())  # over full_below: not started
        self.assertIsNone(make(90, plug_on=True, charging=True, full=True).decide())  # on to 100
        self.assertEqual(make(100, plug_on=True, charging=True, full=True).decide(), OFF)

    def test_manual_and_no_reading(self):
        self.assertIsNone(make(10, automatic=False).decide())
        self.assertIsNone(make(None).decide())
        self.assertIsNone(C(level=10, plug_on=None).decide())


class Status(unittest.TestCase):
    def test_statuses(self):
        self.assertEqual(make(None).status(), charger.NO_READING)
        self.assertEqual(make(50, automatic=False).status(), charger.MANUAL)
        self.assertEqual(make(50, plug_on=True, charging=True).status(), charger.CHARGING)
        self.assertEqual(make(50, plug_on=True, charging=False).status(), charger.NOT_CHARGING)
        self.assertEqual(make(50).status(), charger.IDLE)
        self.assertEqual(make(20, home=False).status(), charger.AWAY)


if __name__ == "__main__":
    unittest.main()
