# With Adaptive Lighting (or your own brightness automations)

If something else decides how bright a light should be, such as
[Adaptive Lighting](https://github.com/basnijholt/adaptive-lighting) or an automation of your own,
tick **Brightness is managed by something else** when you add the light (or later, in Configure).
Knit then keeps to switching:

- It turns the light on plain, with no brightness, so the other thing picks the level.
- It still dims to half as the warning before turning off.
- After a dim it hands the brightness back: Adaptive Lighting is told the light is its own again
  and applies its settings straight away. Without Adaptive Lighting, the brightness from before the
  dim is put back.
- A light that went off dimmed comes back at whatever is right now, not at its old brightness.

In Adaptive Lighting, leave *take over control* on, so it leaves the dim alone while it lasts.

The switch is under **Advanced options**.

[← Back to the README](../README.md)
