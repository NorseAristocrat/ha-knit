# Knit

Knit your sensors into smart devices, then put each device on your dashboard with its own card.
Set a device up once: no helpers, automations or scripts.

## Devices

**Light**: follows the presence sensor(s) and light sensor(s) you pick.

- **Motion control**: presence turns the light on (only when it's dark, while Light level is on),
  and once the room has been empty for the Motion timeout it goes off. For the last part of that (Motion dim
  before off, at most 75%) it's dimmed to half as a warning; someone coming back puts the
  brightness back. A light that can't be dimmed has no dim.
- **Light level**: once the room has been light (above Light above) for Off after, the light goes
  off. With Motion off, it turns the light on when it gets dark instead. Several light sensors are
  averaged, so a room with no sensor of its own can follow the rooms around it.
- **Pause**: optionally, nothing happens while an entity you pick is on (guests, for example).

**Motion-controlled device**: a device that should go off once nobody's around: off once the
room has been empty for its Motion timeout; presence never turns it on. Optionally it's switched
off again if it comes back on after a power cut.

**Appliance**: a dishwasher, washing machine or dryer on a smart plug that reports power.

- **Running** once the power has been above Running above for Running after; a cycle countdown
  starts (Cycle length).
- **Full** once it has been below it for Finished after, so pauses between wash phases don't end it.
- **Empty** once the door has been open for Emptied after while it isn't drawing power (or, if the
  door sensor missed the door closing, when it closes again while Full).
- The status (a Status select: Empty / Running / Full) can be corrected by hand. Automations can
  follow it, or the events `knit_appliance_started`, `knit_appliance_finished` and
  `knit_appliance_emptied`, for your own notifications.
- The three statuses can be renamed per appliance (Configure: e.g. Clean / Washing / Ready). The
  select's options are the new names; its `status` attribute is always Empty, Running or Full,
  so an automation can follow that instead of the names.

A device only gets the entities for the sensors it's given. Every entity id starts `knit_` and the
device's name, e.g. `switch.knit_living_room_lamp_motion`. Settings are under Configuration on the
device page, and on the device's card.

## Cards

The integration loads the cards on every dashboard itself, and adds them as a dashboard resource so
apps that keep the page cached get them too (dashboards with resources in YAML need it added by
hand: `/knit_static/knit-cards.js`).

```yaml
type: custom:knit-light-card       # a light or a motion-controlled device
device: <the Knit device>          # the editor's "Knit device" picker
```

```yaml
type: custom:knit-appliance-card
device: <the Knit appliance>
```

Opening a card closes any other open one (`collapse_others: false` to opt out).

### The section card

A collapsible section header. Put it at the top of a section in a sections view: its title folds
away the cards below it in that section (up to the next section card), so they can be laid out in
the section's grid as you like. Everything shows while the dashboard is being edited.

```yaml
type: custom:knit-section
title: Lights
subtitle: Click to expand          # while folded away; or subtitle_entity: an entity's state, always
collapsed_by_default: false        # true: starts collapsed on every load (otherwise as last left)
expand_on:                         # optional: opens by itself while triggered, then folds back
  entity: binary_sensor.person     #   while in this state (default on) ...
  state: "on"
  minutes: 10                      #   ... and for this long after; for a time entity
  minutes_entity: input_number.x   #   (input_datetime / timestamp), for this long after that time
button:                            # optional pill on the right
  entity: [light.a, switch.b]      # any entities: automations run, scripts / scenes start,
  name: All off                    #   buttons press, anything else gets the action
  action: turn_off                 # toggle | turn_on | turn_off
  show: when_on                    # always | when_on
```

## Install

HACS → ⋮ → Custom repositories → add `https://github.com/NorseAristocrat/ha-knit` (type
Integration), install Knit, restart Home Assistant, then Settings → Devices & services → Add
integration → Knit, once per device. The cards come with it: nothing to add as a resource.

If an automation already controls a light, untick "Turn its automatic features on now" when adding
it, and switch them on once that automation is turned off, so the two don't both act.

## Development

The decisions live in `custom_components/knit/engine.py` (lights) and `appliance.py`, with no Home
Assistant in them:

```sh
python3 -m unittest discover tests
```

## Licence

MIT: see [LICENSE](LICENSE).
