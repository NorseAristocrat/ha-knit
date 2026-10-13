# Appliances (in development)

Appliances are on the `developer` branch only.

A dishwasher, washing machine or dryer on a smart plug that reports power becomes a device with a
status and a cycle countdown.

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
- Its power sensor can be changed in Configure, as a light's light can.

```yaml
type: custom:knit-appliance-card
device: <the Knit appliance>       # or entity: select.knit_washing_machine_status
```

In the set-up form, the name, power sensor and door sensor are up front; the status names are
under **Advanced options**, as is moving the appliance to another power sensor in Configure.

[← Back to the README](../README.md)
