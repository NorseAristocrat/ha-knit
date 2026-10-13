# Setting up and changing a device

Settings → Devices & services → Add integration → **Knit**, once per device. A device only gets
the features for the sensors you give it: no light sensor, no light-level settings to get wrong.

![Adding a light in Knit](../images/demo/setup.gif)

The form asks for three things, and only the light is required:

| Field | What to pick |
|---|---|
| Light or switch | The light, or the switch of a plug-in lamp |
| Sensors that turn it on | Motion, presence, a door or window contact, vibration: it's on while any of them is on |
| Light level sensors | One or more, averaged. Leave empty and the light ignores daylight |

Everything else is folded away under **Advanced options**, which most lights never need:

| Advanced option | What it's for |
|---|---|
| Sensors that turn it on while off (inverted) | The other way round: on while a door is closed, or while nothing is moving |
| Pause while these are on | Guest mode, a "nobody home" helper: Knit leaves the light alone meanwhile. With two or more, Configure asks whether any or all of them pause it |
| Brightness is managed by something else | Tick it for a light run by Adaptive Lighting or your own brightness automations |
| Turn its automatic features on now | Untick it if an automation still controls the light |

Advanced options opens by itself in Configure when a device uses any of them. (The recording was
made before 0.9.2, when every field was on one page.)

Already have an automation running the light? Untick "Turn its automatic features on now" when you
add it, switch your automation off, then turn Knit's Motion control and Light level on, so the two
never both act on it.

## Changing a device

**Configure** on the device changes its sensors and light sensors, and under **Advanced options**
its inverted sensors, pause entities and what it runs (*Move to another light*): the device moves
to the light you pick, keeping its settings, entities and cards. Cards set up with the device
picker follow it; a card given only `entity:` needs that changed by hand.

## What a light gets

Every entity id starts `knit_` and the device's name, e.g. `switch.knit_living_room_lamp_motion`.
A device only has the entities for the sensors it was given.

| Entity | What it is | Default |
|---|---|---|
| `switch.…_motion` | Motion control (Door control, Vibration control ...) on / off | on |
| `number.…_motion_timeout` | Seconds after its sensors clear before the light goes off | 300 |
| `number.…_dim_before_off` | Seconds of that spent dimmed to half (at most 75% of the timeout) | 60 |
| `switch.…_light_level` | Light level on / off | on |
| `number.…_dark_below` | Dark below this many lx | 10 |
| `number.…_light_above` | Light above this many lx | 15 |
| `number.…_off_when_light_after` | Seconds of light before the light goes off | 300 |
| `binary_sensor.…_occupied` | Any of its trigger sensors active (on, or off for an inverted one); attributes `trigger`, `inverted` | |
| `binary_sensor.…_dark` | Dark, as its light level settings judge it | |
| `sensor.…_light_level` | The average of its light sensors (lx) | |
| `sensor.…_auto_off_ends` | When the motion timeout ends (a timestamp) | |
| `sensor.…_off_when_light_ends` | When the off-when-light countdown ends | |
| `sensor.…_light` | The light it runs; attributes `paused` and `dimmed_from` | |

The numbers and switches are under Configuration on the device page as well as on the card.

Everything Knit knows is an entity, so your own automations, scripts and dashboards can use it:
the settings, whether the room counts as occupied or dark, the averaged light level, and when each
countdown ends.

[← Back to the README](../README.md)
