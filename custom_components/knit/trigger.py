"""What turns a device on: its trigger sensors, with no Home Assistant in it.

A sensor counts as active while it's on (motion, an open door, vibration), or, for the ones in
the device's inverted list, while it's off (a closed door, no motion). The device is "occupied"
while any of them is active. `describe` says what kind they are, so the card can word itself.
"""

from __future__ import annotations

MOTION = "motion"
CONTACT = "contact"
VIBRATION = "vibration"
SENSOR = "sensor"  # anything else, or a mix

KINDS = {
    "motion": MOTION,
    "occupancy": MOTION,
    "presence": MOTION,
    "door": CONTACT,
    "window": CONTACT,
    "garage_door": CONTACT,
    "opening": CONTACT,
    "vibration": VIBRATION,
    "moving": VIBRATION,
}
NOUNS = {"door": "door", "window": "window", "garage_door": "garage door"}


def active(states: list[tuple[bool | None, bool]]) -> bool | None:
    """Whether any sensor is active, from (on, inverted) for each; on is None with no reading.
    None when none of them has a reading."""
    known = [(on, inverted) for on, inverted in states if on is not None]
    if not known:
        return None
    return any(on != inverted for on, inverted in known)


def describe(sensors: list[tuple[str | None, bool]]) -> dict:
    """The kind of the sensors, from (device class, inverted) for each: `trigger` (motion,
    contact, vibration or sensor), `noun` for a contact (door, window, garage door) and
    `inverted`. A mix of kinds, or of inverted and not, is a plain "sensor"."""
    if not sensors:
        return {}
    kinds = {KINDS.get(dc or "", SENSOR) for dc, _ in sensors}
    flags = {inv for _, inv in sensors}
    if len(kinds) > 1 or len(flags) > 1:
        return {"trigger": SENSOR, "inverted": len(flags) == 1 and flags.pop()}
    kind = kinds.pop()
    out = {"trigger": kind, "inverted": flags.pop()}
    if kind == CONTACT:
        nouns = {NOUNS.get(dc or "", "door") for dc, _ in sensors}
        out["noun"] = nouns.pop() if len(nouns) == 1 else "door"
    return out
