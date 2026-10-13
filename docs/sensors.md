# Doors, vibration and other sensors

Motion is only one way to say "someone's here". Anything that is on or off can turn a light on, and
the same countdown and dim follow once it clears. The card names and words itself for the sensor:
**Door control**, "Opening the door turns the light on, it goes off `05:00` mins after it closes,
and will dim `01:00` mins before turning off."

| Sensor | Good for | Why the countdown and dim help |
|---|---|---|
| Door or window contact | A cupboard, wardrobe, pantry or shed: on while the door is open | A short timeout covers a door pushed to; the dim shows it's about to go off |
| Front or garage door | The hallway light when you come in (Light level keeps it for after dark) | A 5 minute timeout gives you time to take your coat off |
| Vibration sensor | A desk, workbench or armchair: on while there's movement | The timeout bridges the still moments; the dim is the nudge to move |
| Bed or chair pressure sensor | A reading lamp that's on while you're sat there | The lamp fades out a little after you get up, not the moment you lean forward |
| Doorbell or button | A porch light for a few minutes after it's pressed | The sensor is only on for a moment; the timeout is the whole point |
| Anything else | A TV's bias light, a desk lamp while the PC is on | The light outlasts a short standby instead of flicking off with it |

Every sensor can also be used **the other way round**. The set-up form has two lists (the second under Advanced options): *Sensors
that turn it on* (while they're on: motion, an open door, vibration) and *Sensors that turn it on
while off (inverted)*: a bathroom light that's on while the door is shut, a night light that comes
on when the bed sensor clears, a light that's on while nothing is moving. Sensors from both lists
can share a light: it's on while any of them says so, and counts down once none does.

What the card says for each:

| Sensor | Group | Beside it |
|---|---|---|
| Motion, presence | Motion control | Occupied / Empty · 3mins ago |
| Door, window, garage door | Door control (Window, Garage door) | Open / Closed · 3mins ago |
| Vibration | Vibration control | Vibration / Still · 3mins ago |
| Anything else, or a mix | Sensor control | Active / Clear · 3mins ago |

Not a binary sensor? An `input_boolean` helper works directly, and a threshold or template helper
makes one out of anything else (a plug's power, a media player's state).

[← Back to the README](../README.md)
