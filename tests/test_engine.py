"""Unit tests for the engine (plain Python: python -m unittest discover tests)."""

import importlib.util
import pathlib
import sys
import unittest
from datetime import datetime, timedelta

# load engine.py on its own (the package __init__ needs Home Assistant)
_path = pathlib.Path(__file__).parents[1] / "custom_components" / "knit" / "engine.py"
_spec = importlib.util.spec_from_file_location("engine", _path)
engine = importlib.util.module_from_spec(_spec)
sys.modules["engine"] = engine
_spec.loader.exec_module(engine)
Engine, Settings, Action = engine.Engine, engine.Settings, engine.Action
ON, OFF, BRI = engine.ON, engine.OFF, engine.BRIGHTNESS

T0 = datetime(2026, 10, 2, 20, 0, 0)


def at(secs):
    return T0 + timedelta(seconds=secs)


def kinds(actions):
    return [(a.kind, a.brightness) for a in actions]


def make(**settings):
    e = Engine(settings=Settings(**settings))
    e.set_occupied(True, T0)
    e.set_lux(1.0, T0)  # first reading: sets dark without acting
    return e


class Motion(unittest.TestCase):
    def test_presence_turns_on_when_dark(self):
        e = make(dark_below=5)
        e.set_occupied(False, T0)
        self.assertEqual(kinds(e.set_occupied(True, at(1))), [(ON, None)])

    def test_presence_does_nothing_when_light(self):
        e = make(dark_below=0.5)  # lux 1.0 is light
        e.set_occupied(False, T0)
        self.assertEqual(e.set_occupied(True, at(1)), [])

    def test_light_level_off_means_motion_alone(self):
        e = make(dark_below=0.5, light_level=False)
        e.set_occupied(False, T0)
        self.assertEqual(kinds(e.set_occupied(True, at(1))), [(ON, None)])

    def test_motion_off_presence_does_nothing(self):
        e = make(dark_below=5, motion=False)
        e.set_occupied(False, T0)
        self.assertEqual(e.set_occupied(True, at(1)), [])
        e.set_light(True, 200, at(2))
        e.set_occupied(False, at(3))
        self.assertIsNone(e.next_deadline())


class AutoOffSwitch(unittest.TestCase):
    """A candle: presence never turns it on; it goes off once the room is empty."""

    def test_presence_never_turns_it_on(self):
        e = Engine(settings=Settings(turn_on=False, light_level=False, auto_off_secs=600))
        e.dimmable = False
        e.set_occupied(False, T0)
        self.assertEqual(e.set_occupied(True, at(1)), [])

    def test_off_once_empty(self):
        e = Engine(settings=Settings(turn_on=False, light_level=False, auto_off_secs=600))
        e.dimmable = False
        e.set_occupied(True, T0)
        e.set_light(True, None, at(1))
        e.set_occupied(False, at(2))
        self.assertEqual(e.next_deadline(), at(602))
        self.assertEqual(kinds(e.tick(at(602))), [(OFF, None)])


class AutoOff(unittest.TestCase):
    def test_dims_then_off(self):
        e = make(dark_below=5, auto_off_secs=300, dim_secs=60)
        e.set_light(True, 200, T0)
        self.assertEqual(e.set_occupied(False, at(0)), [])
        self.assertEqual(e.next_deadline(), at(240))
        self.assertEqual(kinds(e.tick(at(240))), [(BRI, 100)])
        self.assertEqual(kinds(e.tick(at(300))), [(OFF, None)])

    def test_back_during_dim_restores(self):
        e = make(dark_below=5, auto_off_secs=300, dim_secs=60)
        e.set_light(True, 200, T0)
        e.set_occupied(False, at(0))
        e.tick(at(240))
        self.assertEqual(kinds(e.set_occupied(True, at(250))), [(BRI, 200)])
        self.assertIsNone(e.next_deadline())

    def test_dim_capped_at_75_percent(self):
        e = make(dark_below=5, auto_off_secs=100, dim_secs=1000)
        e.set_light(True, 200, T0)
        e.set_occupied(False, at(0))
        self.assertEqual(e.next_deadline(), at(25))

    def test_zero_is_immediately(self):
        e = make(dark_below=5, auto_off_secs=0)
        e.set_light(True, 200, T0)
        self.assertEqual(kinds(e.set_occupied(False, at(0))), [(OFF, None)])

    def test_switch_light_has_no_dim(self):
        e = make(dark_below=5)
        e.dimmable = False
        e.set_light(True, None, T0)
        e.set_occupied(False, at(0))
        self.assertEqual(e.next_deadline(), at(300))

    def test_auto_off_switched_off_undoes_dim(self):
        e = make(dark_below=5)
        e.set_light(True, 200, T0)
        e.set_occupied(False, at(0))
        e.tick(at(240))
        self.assertEqual(kinds(e.update_settings(at(250), auto_off=False)), [(BRI, 200)])
        self.assertIsNone(e.next_deadline())

    def test_motion_switched_back_on_with_room_empty_counts_down(self):
        e = make(dark_below=5, motion=False)
        e.set_light(True, 200, T0)
        e.set_occupied(False, at(0))
        e.update_settings(at(10), motion=True)
        self.assertEqual(e.next_deadline(), at(250))

    def test_light_off_stops_countdown_and_restores_on_return_at_dim_level(self):
        e = make(dark_below=5)
        e.set_light(True, 200, T0)
        e.set_occupied(False, at(0))
        e.tick(at(240))
        e.set_light(False, None, at(260))
        self.assertIsNone(e.next_deadline())
        self.assertEqual(kinds(e.set_light(True, 100, at(400))), [(BRI, 200)])

    def test_off_dimmed_then_presence_turns_on_at_own_brightness(self):
        e = make(dark_below=5)
        e.set_lux(1, T0)
        e.set_light(True, 200, T0)
        e.set_occupied(False, at(0))
        e.tick(at(240))  # dimmed to 100
        self.assertEqual(kinds(e.tick(at(300))), [(OFF, None)])
        e.set_light(False, None, at(301))
        self.assertEqual(kinds(e.set_occupied(True, at(900))), [(ON, 200)])
        self.assertEqual(kinds(e.set_light(True, 200, at(901))), [])

    def test_restore_kept_through_restart(self):
        e = make(dark_below=5)  # a new engine after a restart, the brightness restored
        e.set_lux(1, T0)
        e.restore = 180
        e.set_occupied(False, T0)
        self.assertEqual(kinds(e.set_occupied(True, at(10))), [(ON, 180)])

    def test_restart_while_dimmed_restores_on_return(self):
        e = make(dark_below=5)  # after a restart: on at the dimmed level, the brightness restored
        e.restore = 200
        e.set_light(True, 100, T0)  # (the restore is checked on start, not here)
        e.restore, e.light_on, e.brightness = 200, True, 100
        e.resume()
        e.set_occupied(False, at(0))
        e.tick(at(240))  # the dim comes round again: not halved a second time
        self.assertEqual(e.brightness, 100)
        self.assertEqual(kinds(e.set_occupied(True, at(250))), [(BRI, 200)])

    def test_resume_forgets_a_brightness_already_put_back(self):
        e = make(dark_below=5)
        e.restore, e.light_on, e.brightness = 200, True, 200
        e.resume()
        self.assertIsNone(e.restore)

    def test_failed_turn_on_keeps_the_brightness(self):
        e = make(dark_below=5)
        e.set_occupied(False, T0)
        e.restore = 200
        self.assertEqual(kinds(e.set_occupied(True, at(10))), [(ON, 200)])
        self.assertEqual(e.restore, 200)  # the light never reported on
        e.set_occupied(False, at(20))
        self.assertEqual(kinds(e.set_occupied(True, at(30))), [(ON, 200)])

    def test_pause_ending_counts_down(self):
        e = make(dark_below=5)
        e.set_light(True, 200, T0)
        e.set_paused(True, at(0))
        e.set_occupied(False, at(10))
        self.assertIsNone(e.next_deadline())
        e.set_paused(False, at(100))
        self.assertEqual(e.next_deadline(), at(100 + 240))

    def test_back_just_as_it_goes_off_turns_it_on(self):
        e = make(dark_below=5)
        e.set_light(True, 200, T0)
        e.set_occupied(False, at(0))
        e.tick(at(240))
        self.assertEqual(kinds(e.tick(at(300))), [(OFF, None)])
        # in before the light has reported off
        self.assertEqual(kinds(e.set_occupied(True, at(300.5))), [(ON, 200)])

    def test_away_presence_does_not_turn_on(self):
        e = make(dark_below=5)
        e.set_occupied(False, T0)
        e.set_away(True, at(1))
        self.assertEqual(kinds(e.set_occupied(True, at(10))), [])  # a pet, the vacuum

    def test_away_still_goes_off(self):
        e = make(dark_below=5)
        e.set_light(True, 200, T0)
        e.set_away(True, at(0))
        e.set_occupied(False, at(1))
        e.tick(at(241))
        self.assertEqual(kinds(e.tick(at(301))), [(OFF, None)])

    def test_away_light_level_does_not_turn_on(self):
        e = make(dark_below=5, motion=False)
        e.set_lux(20, T0)
        e.set_away(True, at(1))
        self.assertEqual(kinds(e.set_lux(1, at(10))), [])

    def test_home_again_to_occupied_dark_room_turns_on(self):
        e = make(dark_below=5)
        e.set_occupied(False, T0)
        e.set_away(True, at(1))
        e.set_occupied(True, at(10))
        self.assertEqual(kinds(e.set_away(False, at(20))), [(ON, None)])

    def test_light_on_by_hand_in_empty_room_counts_down(self):
        e = make(dark_below=5)
        e.set_occupied(False, T0)
        e.set_light(True, 200, at(5))
        self.assertEqual(e.next_deadline(), at(245))


class LightLevel(unittest.TestCase):
    def test_hysteresis_and_off_when_light(self):
        e = make(dark_below=1.3, light_above=2.0, off_after_secs=120)
        e.set_light(True, 200, T0)
        self.assertTrue(e.dark)
        e.set_lux(1.8, at(10))  # between: still dark
        self.assertTrue(e.dark)
        e.set_lux(2.1, at(20))  # light
        self.assertFalse(e.dark)
        self.assertEqual(e.next_deadline(), at(140))
        self.assertEqual(kinds(e.tick(at(140))), [(OFF, None)])

    def test_dark_again_cancels(self):
        e = make(dark_below=1.3, light_above=2.0)
        e.set_light(True, 200, T0)
        e.set_lux(2.1, at(20))
        e.set_lux(1.0, at(30))
        self.assertIsNone(e.next_deadline())

    def test_light_level_off_never_turns_off_for_light(self):
        e = make(dark_below=1.3, light_above=2.0, light_level=False)
        e.set_light(True, 200, T0)
        e.set_lux(2.1, at(20))
        self.assertIsNone(e.next_deadline())

    def test_default_light_above_is_one_and_a_half_dark_below(self):
        e = make(dark_below=2.0)
        self.assertEqual(e.light_above(), 3.0)

    def test_motion_off_turns_on_when_dark(self):
        e = make(dark_below=1.3, light_above=2.0, motion=False)
        e.set_lux(2.5, at(1))  # light
        e.set_occupied(False, at(2))
        self.assertEqual(kinds(e.set_lux(1.0, at(3))), [(ON, None)])

    def test_motion_off_follows_light_level_alone(self):
        # Motion off: on when it gets dark, off once it has been light for the time, whoever is there
        e = make(dark_below=1.3, light_above=2.0, off_after_secs=120, motion=False)
        e.set_lux(2.5, at(1))  # light
        self.assertEqual(kinds(e.set_lux(1.0, at(10))), [(ON, None)])  # dark: on
        e.set_light(True, 200, at(11))
        e.set_occupied(False, at(12))  # nobody: no auto-off with Motion off
        self.assertIsNone(e.next_deadline())
        e.set_lux(2.5, at(20))  # light: counts down
        self.assertEqual(e.next_deadline(), at(140))
        self.assertEqual(kinds(e.tick(at(140))), [(OFF, None)])
        e.set_light(False, None, at(141))
        self.assertEqual(kinds(e.set_lux(1.0, at(200))), [(ON, None)])  # dark again: on again

    def test_switching_motion_off_while_dark_turns_on(self):
        e = make(dark_below=5)
        self.assertEqual(kinds(e.update_settings(at(1), motion=False)), [(ON, None)])

    def test_shared_dark_sensor(self):
        e = Engine(settings=Settings(motion=False))
        e.set_shared_dark(False, T0)
        self.assertEqual(kinds(e.set_shared_dark(True, at(5))), [(ON, None)])


class Paused(unittest.TestCase):
    def test_paused_does_nothing(self):
        e = make(dark_below=5)
        e.set_paused(True, T0)
        e.set_occupied(False, at(1))
        self.assertEqual(e.set_occupied(True, at(2)), [])
        e.set_light(True, 200, at(3))
        e.set_occupied(False, at(4))
        self.assertIsNone(e.next_deadline())

    def test_pausing_during_dim_restores(self):
        e = make(dark_below=5)
        e.set_light(True, 200, T0)
        e.set_occupied(False, at(0))
        e.tick(at(240))
        self.assertEqual(kinds(e.set_paused(True, at(245))), [(BRI, 200)])


if __name__ == "__main__":
    unittest.main()
