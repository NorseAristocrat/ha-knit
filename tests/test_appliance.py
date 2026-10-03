"""Unit tests for the appliance engine (plain Python: python -m unittest discover tests)."""

import importlib.util
import pathlib
import sys
import unittest
from datetime import datetime, timedelta

_path = pathlib.Path(__file__).parents[1] / "custom_components" / "knit" / "appliance.py"
_spec = importlib.util.spec_from_file_location("appliance", _path)
appliance = importlib.util.module_from_spec(_spec)
sys.modules["appliance"] = appliance
_spec.loader.exec_module(appliance)
A, Settings = appliance.Appliance, appliance.ApplianceSettings
EMPTY, RUNNING, FULL = appliance.EMPTY, appliance.RUNNING, appliance.FULL

T0 = datetime(2026, 10, 3, 9, 0, 0)


def at(s):
    return T0 + timedelta(seconds=s)


def make(**kw):
    a = A(settings=Settings(**{"running_above": 20, "running_after": 60, "finished_after": 300, "cycle_secs": 3600, "empty_after": 60, **kw}))
    a.set_power(0, T0)
    a.set_door(False, T0)
    return a


class Cycle(unittest.TestCase):
    def test_runs_after_power_for_the_time(self):
        a = make()
        a.set_power(1500, at(10))
        self.assertEqual(a.status, EMPTY)
        self.assertEqual(a.next_deadline(), at(70))
        self.assertEqual(a.tick(at(70)), ["started"])
        self.assertEqual(a.status, RUNNING)
        self.assertEqual(a.cycle_ends, at(70 + 3600))

    def test_short_spike_does_not_start(self):
        a = make()
        a.set_power(1500, at(10))
        a.set_power(2, at(30))
        self.assertEqual(a.tick(at(100)), [])
        self.assertEqual(a.status, EMPTY)

    def test_pause_between_phases_does_not_finish(self):
        a = make()
        a.set_power(1500, at(0))
        a.tick(at(60))
        a.set_power(3, at(600))  # a pause
        a.set_power(1200, at(800))  # heating again, before 300 s below
        self.assertEqual(a.tick(at(1000)), [])
        self.assertEqual(a.status, RUNNING)

    def test_finishes_after_quiet(self):
        a = make()
        a.set_power(1500, at(0))
        a.tick(at(60))
        a.set_power(3, at(1000))
        self.assertEqual(a.next_deadline(), at(1300))
        self.assertEqual(a.tick(at(1300)), ["finished"])
        self.assertEqual(a.status, FULL)
        self.assertIsNone(a.cycle_ends)


class Door(unittest.TestCase):
    def full(self):
        a = make()
        a.set_power(1500, at(0))
        a.tick(at(60))
        a.set_power(3, at(1000))
        a.tick(at(1300))
        return a

    def test_door_open_a_minute_empties(self):
        a = self.full()
        a.set_door(True, at(2000))
        self.assertEqual(a.tick(at(2030)), [])
        self.assertEqual(a.tick(at(2060)), ["emptied"])
        self.assertEqual(a.status, EMPTY)

    def test_quick_peek_does_not_empty(self):
        a = self.full()
        a.set_door(True, at(2000))
        a.set_door(False, at(2010))
        self.assertEqual(a.status, FULL)

    def test_door_open_while_drawing_power_does_not_empty(self):
        a = make()
        a.set_power(1500, at(0))
        a.tick(at(60))
        a.set_door(True, at(100))
        self.assertEqual(a.tick(at(400)), [])
        self.assertEqual(a.status, RUNNING)

    def test_missed_close_empties_when_it_finally_closes(self):
        # the sensor read open all through the cycle
        a = make()
        a.set_door(True, at(0))
        a.set_power(1500, at(5))
        a.tick(at(65))
        a.set_power(2, at(1000))
        a.tick(at(1300))
        self.assertEqual(a.status, FULL)  # the stuck "open" doesn't empty it when the cycle ends
        self.assertEqual(a.set_door(False, at(2000)), ["emptied"])  # closing after reading open: emptied
        self.assertEqual(a.status, EMPTY)


class ByHand(unittest.TestCase):
    def test_set_running_starts_countdown(self):
        a = make()
        self.assertEqual(a.set_status(RUNNING, at(5)), ["started"])
        self.assertEqual(a.cycle_ends, at(5 + 3600))
        # not drawing: it finishes after the quiet time unless power comes
        self.assertEqual(a.next_deadline(), at(305))

    def test_full_by_hand_while_drawing_stays_full(self):
        a = make()
        a.set_power(1500, at(0))
        a.tick(at(60))  # running
        self.assertEqual(a.set_status(FULL, at(100)), ["finished"])
        self.assertEqual(a.tick(at(200)), [])  # still drawing (drying): not running again
        self.assertEqual(a.status, FULL)
        a.set_power(0, at(300))
        a.set_power(1500, at(400))  # a new cycle
        self.assertEqual(a.tick(at(460)), ["started"])

    def test_set_empty_stops_countdown(self):
        a = make()
        a.set_status(RUNNING, at(5))
        self.assertEqual(a.set_status(EMPTY, at(10)), ["emptied"])
        self.assertIsNone(a.cycle_ends)

    def test_cycle_length_change_moves_the_countdown(self):
        a = make()
        a.set_status(RUNNING, at(0))
        a.update_settings(at(100), cycle_secs=1800)
        self.assertEqual(a.cycle_ends, at(1800))


if __name__ == "__main__":
    unittest.main()
