import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "custom_components", "knit"))

from trigger import active, describe  # noqa: E402


class TestActive(unittest.TestCase):
    def test_no_reading(self):
        self.assertIsNone(active([]))
        self.assertIsNone(active([(None, False), (None, True)]))

    def test_on_is_active(self):
        self.assertTrue(active([(False, False), (True, False)]))
        self.assertFalse(active([(False, False), (False, False)]))

    def test_inverted_is_active_while_off(self):
        self.assertTrue(active([(False, True)]))
        self.assertFalse(active([(True, True)]))

    def test_mix(self):
        # motion clear, the inverted door open (clear): nothing active
        self.assertFalse(active([(False, False), (True, True)]))
        # the door closes: active
        self.assertTrue(active([(False, False), (False, True)]))
        # a sensor with no reading is left out
        self.assertFalse(active([(None, True), (False, False)]))


class TestDescribe(unittest.TestCase):
    def test_none(self):
        self.assertEqual(describe([]), {})

    def test_motion(self):
        self.assertEqual(describe([("occupancy", False), ("motion", False)]), {"trigger": "motion", "inverted": False})

    def test_contact(self):
        self.assertEqual(describe([("door", False)]), {"trigger": "contact", "inverted": False, "noun": "door"})
        self.assertEqual(describe([("garage_door", True)]), {"trigger": "contact", "inverted": True, "noun": "garage door"})
        self.assertEqual(describe([("window", False), ("door", False)])["noun"], "door")
        self.assertEqual(describe([("opening", False)])["noun"], "door")

    def test_vibration(self):
        self.assertEqual(describe([("vibration", True)]), {"trigger": "vibration", "inverted": True})

    def test_mix_is_a_sensor(self):
        self.assertEqual(describe([("motion", False), ("door", False)]), {"trigger": "sensor", "inverted": False})
        self.assertEqual(describe([("door", False), ("door", True)]), {"trigger": "sensor", "inverted": False})
        self.assertEqual(describe([(None, False)]), {"trigger": "sensor", "inverted": False})
        self.assertEqual(describe([(None, True), ("plug", True)]), {"trigger": "sensor", "inverted": True})


if __name__ == "__main__":
    unittest.main()
