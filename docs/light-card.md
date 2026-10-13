# The light card

Tap the tile to switch the light, drag across it to dim. The chevron opens the card in place:
sliders for brightness, colour temperature and colour, a dropdown for effects, and any other
entities you want alongside (a power reading, a scene picker).

![Opening a light card](../images/demo/card-open.gif)

**More controls** holds the settings, written as sentences you can edit: "Motion detected turns
the light on, it goes off after `05:00` mins, and will dim `01:00` mins before turning off."
Change a time, flip Motion control or Light level off for the evening: it takes effect at once.
The group is named and worded for the sensor behind it, so a cupboard light reads **Door control**,
"Opening the door turns the light on, it goes off `05:00` mins after it closes". Once a room is
tuned, either group can be hidden from the card and carries on working.

![Changing the settings on the card](../images/demo/card-settings.gif)

An open card keeps its tile's outline, dashed, so it's clear which card the panel belongs to. A
half-width card spreads its panel across the whole row while it's open, and puts everything back
when it closes.

![A half-width card opening across the row](../images/demo/card-spread.gif)

## Editor and YAML

The visual editor shows the Knit device, the title, icon and colour. **Panel rows** (the controls
in the open card) and **Advanced options** (corner radius, the line under the title, hiding a
group of settings, lights without Knit) fold away beneath. The YAML underneath:

```yaml
type: custom:knit-light-card       # a light or a motion-controlled device
device: <the Knit device>          # the editor's "Knit device" picker
name: Living room lamp             # optional: else the light's name
icon: mdi:floor-lamp-outline
primary: [216, 192, 151]           # the card's colour (every shade is worked out from it),
                                   # or color: sand | red | blue | green | teal | steel | purple
radius: 15                         # the card's corner radius in px (0 to 30; 15 unless set)
secondary: [state, brightness, countdown]   # the line under the name
attributes:                        # the rows in the open card, in order
  - brightness
  - color_temp
  - color
  - effect                         # a dropdown of the light's effects
  - entity: sensor.lamp_power      # any other entity: a reading, a switch, a number, a select
    name: Power
motion_control:
  hidden: true                     # keep Motion control off the card (it keeps working)
light_level:
  hidden: true
collapse_others: true              # opening this card closes the other Knit cards
wide: true                         # false: never spread across the row when open
```

Without the integration, the same card can be pointed at your own helpers (`motion:` takes
`presence`, the sensor that turns it on, and `inverted: true` if it counts while off; `motion_control:` and
`light_level:` take `enabled`, `duration`, `timer`, `dim`, `dark_below`, `light_above`,
`illuminance`, `off_after`); the editor lists them.

[← Back to the README](../README.md)
