# Chargers (in development)

Chargers are on the `developer` branch only, beside appliances.

A device on battery (a music player in its dock, a tablet) charged from a smart plug: Knit keeps
its battery between two levels by turning the plug on and off.

- **On** once the battery drops under **Start below** (only while its person is home, if one is
  picked), or during a **full charge** (while the full-charge schedule is on) if it's under 95%.
- **Off** once it has reached **Stop at** (100% during a full charge) and the device says it's
  charging. With a charging-state sensor, an old reading (the device off the network, still showing
  its last level) never turns the plug off: a plug turned on to wake the device stays on until it
  reports.
- In between the plug is left as it is, so a charge carries on up to Stop at.
- **Automatic** (a switch) off: the plug is left as it is.
- A **Status** sensor says what it's doing: Charging, Not charging (plug on, the device isn't
  charging), Idle, Away (low, but its person is out), Manual (Automatic off) or No reading.

Set-up: a name, the battery level sensor, the plug, and optionally the device's charging-state
sensor (`charging` / `full`, or on / off). Under **Advanced options**: the full-charge schedule
(a Schedule helper, or any on / off entity) and the person (or any home / on entity).

```yaml
type: custom:knit-appliance-card
device: <the Knit charger>       # or entity: sensor.knit_m300_dap_status
icon: mdi:music-box-outline
media: { session: sensor.x_media_session, notify: notify.mobile_app_x, art: image.x_cover_art }   # optional: now playing (a hero with the cover, with art:) + controls
timers:                          # optional: countdowns on the tile while they run
  - { entity: timer.x, label: Music pauses in, while: sensor.x_media_session, while_state: Playing }
settings:                        # optional: other helpers as sentences under More controls
  - name: Pause and resume
    icon: mdi:play-pause
    sentence: "The music pauses once the office has been empty for {input_number.x | time} mins."
```

The tile fills to the battery level and says what it's doing ("Charging · 43% → 80%"). Opened:
Now playing (with `media:`), then More controls in tabs: **Charging** (the plug, On / Off, and why
it's as it is, the battery and charging state, Automatic with "Charges to [80]% once it drops under
[30]%."), **Full charge** (the schedule), and a tab per `settings:` `tab`. The full-charge schedule (day tabs and a bar of
quarter-hours: tap a block to change it, a gap to add one; Copy schedule copies the day shown,
then Paste schedule on another day tab, or on another Knit card's schedule, replaces that day with it). Editing the schedule needs an admin user (Home Assistant's schedule/update).

[← Back to the README](../README.md)
