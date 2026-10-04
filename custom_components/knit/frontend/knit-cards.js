/*
 * Smart light card
 *
 * One light (or switch) as a tile: tap to toggle, drag sideways to dim, a ring round the
 * icon drains while a countdown runs. The chevron opens a panel joined to the tile with the
 * light's controls (`attributes`: brightness, colour temperature and colour are small
 * tiles dragged sideways like the main one), then a More controls row with up to two groups:
 *
 *   Motion control  the room's presence (Occupied, Empty · 3mins ago), how long it is empty
 *                before the light goes off, and how much of that it spends dimmed first (On / Off)
 *   Light level  Dark below / Light above (lx) and Off when light after (On / Off)
 *
 * Times are mm:ss (in a box styled as the heating schedule's From / To) and are saved in the helper's own unit (s, min, h,
 * or for the dim a % of the motion timeout). The card only shows and sets helpers: the logic that
 * turns the light on and off lives in Home Assistant (automations).
 *
 *   type: custom:knit-light-card
 *   entity: light.living_room_lamp
 *   name: Living room lamp
 *   icon: mdi:floor-lamp-outline
 *   primary: [216, 196, 151]                 # the card's colour; every other shade is worked out from it
 *                                            # (or color: sand | red | blue | green | teal | steel | purple)
 *   secondary: [state, brightness, countdown]   # the line under the name
 *   secondary_entity: sensor.x               # optional: that entity's state added to the line
 *   timers:                                  # optional: other countdowns that turn it off, shown with
 *     - { entity: timer.x, label: Light }    # the others ("Motion 4:12 · Light 0:40");
 *     - { entities: [timer.a, timer.b], label: Light }   # entities: one countdown to when the last ends
 *   attributes:                              # the panel, in order
 *     - brightness
 *     - color_temp
 *     - color
 *     - effect
 *     - { entity: sensor.lamp_power, name: Power, icon: mdi:flash }
 *   motion:
 *     presence: binary_sensor.x_occupied     # shown in Motion control
 *     enabled: input_boolean.x_motion        # optional: no button on the card; greys Motion control while off
 *   auto_off:
 *     enabled: input_boolean.x_auto_off
 *     duration: input_number.x_auto_off_duration
 *     timer: timer.x_auto_off
 *     dim: input_number.x_dim_time           # optional
 *     hint: Counts down while the room is empty.
 *   light_level:
 *     enabled: input_boolean.x_light_level
 *     dark_below: input_number.x_dark_below
 *     light_above: input_number.x_light_above   # optional: counts as light again above this
 *     illuminance: sensor.x_illuminance
 *     dark: binary_sensor.x_dark             # optional: what counts as dark (else illuminance < Dark below);
 *                                            # with no Dark below / Light above, a threshold helper's
 *                                            # limits show greyed (a sensor shared by several rooms)
 *     off_after: input_number.x_off_when_light_after
 *     timer: timer.x_off_when_light
 *     hint: ...
 * Leave out auto_off / light_level to drop that group. `hidden: true` in a group only
 * stops the card showing it: its helpers keep their values, the automations keep acting on
 * them, and its countdown still shows on the tile.
 *
 * Opened in a sections view, a card narrower than its section spreads its panel across the
 * whole row: the tile and the cards beside it stay where they are, and the panel opens beneath
 * them all. `wide: false` keeps it at its own width.
 */

const SLC_VERSION = "34";
const PENDING_MS = 8000;
const RING = 2 * Math.PI * 19;
// which cards are open (and their More controls), so a redraw (as the editor does) keeps it
const OPEN = new Map();
// a light card opened: the others close
const OPENED_EVENT = "knit-light-card-opened";
const DIM_MAX = 0.75; // the dim is at most this share of the motion timeout

// the wrapper a card sits in, in a sections-view section's grid: { cell, grid }; { edit: true }
// while the section is being edited; undefined outside a section
const gridCell = (el) => {
  let node = el;
  const path = [];
  for (let i = 0; i < 10 && node; i++) {
    path.push(node.tagName || "");
    const parent = node.parentElement;
    const host = parent?.getRootNode()?.host;
    // inside the section's shadow root, climb to the wrapper that sits in its grid: the one
    // whose parent holds the section's cards (or is the top of the section)
    const inSection = parent && host && /SECTION$/.test(host.tagName) && host.tagName.startsWith("HUI-");
    if (inSection && (parent.childElementCount > 1 || parent.parentNode === parent.getRootNode())) {
      return path.some((t) => t.includes("EDIT")) ? { edit: true } : { cell: node, grid: parent };
    }
    node = parent || node.getRootNode()?.host;
  }
  return undefined;
};

// a part-width card opened in a sections view spreads its panel across the whole row beneath
// it: the tile stays where it is, beside the cards on its row (they stay too, at their own
// height), and the panel reaches under them. `wide: false` keeps it at its own width.
let widened; // the open card spread across its row
const widen = (card, open) => {
  const was = card._wide;
  if (was) {
    was.mates.forEach(([el, before]) => (before ? (el.style.alignSelf = before) : el.style.removeProperty("align-self")));
    card.classList.remove("wide", "tab", "at-left", "at-right");
    card._wide = undefined;
    if (widened === card) widened = undefined;
  }
  if (!open || card._config?.wide === false) return;
  // only More controls in the panel, and it's closed: the card keeps its own width
  const parts = card.shadowRoot?.querySelectorAll(".panel > .part") || [];
  if (parts.length === 1 && parts[0].querySelector("[data-ctl]") && !card._ctlOpen) return;
  const at = gridCell(card);
  if (!at?.cell) return;
  const { cell, grid } = at;
  const gs = getComputedStyle(grid);
  if (gs.display !== "grid") return;
  const gap = parseFloat(gs.columnGap) || 0;
  const g = grid.getBoundingClientRect();
  const left = g.left + (parseFloat(gs.paddingLeft) || 0);
  const width = g.width - (parseFloat(gs.paddingLeft) || 0) - (parseFloat(gs.paddingRight) || 0);
  const c = cell.getBoundingClientRect();
  if (!width || c.width > width * 0.9) return; // already (nearly) the whole row
  if (widened && widened !== card) widen(widened, false);
  // the cards beside it, at their own height (not stretched to the open card's)
  const mates = [...grid.children].filter(
    (el) => el !== cell && el.offsetParent && Math.abs(el.getBoundingClientRect().top - c.top) < 2
  );
  const before = mates.map((el) => [el, el.style.alignSelf]);
  mates.forEach((el) => (el.style.alignSelf = "start")); // before measuring them
  const tall = Math.max(0, ...mates.map((el) => el.getBoundingClientRect().height));
  const tile = card.shadowRoot?.querySelector(".tile");
  // the panel's top edge sits 1px above the tile's foot (they overlap): it starts the same gap
  // below the tallest card beside it as there is between the cards
  const foot = (tile?.offsetHeight || 60) - 1;
  card.style.setProperty("--tab-x", `${mates.length ? Math.max(0, tall + gap - foot) : 0}px`);
  card.style.setProperty("--wide-gap", `${gap}px`);
  // where the tile sits, as shares of the row (so it follows the row's width)
  const x = clamp((c.left - left) / (width + gap), 0, 1);
  const w = (c.width + gap) / (width + gap);
  card.style.setProperty("--tile-x", String(x));
  card.style.setProperty("--tile-w", String(w));
  card.classList.add("wide");
  card.classList.toggle("tab", mates.length > 0);
  card.classList.toggle("at-left", x < 0.01);
  card.classList.toggle("at-right", x + w > 0.99);
  card._wide = { mates: before };
  widened = card;
};
// the row's width changed (a rotated phone, a resized window): measured again
const rewiden = (card) => {
  if (!card._wide) return;
  widen(card, false);
  widen(card, true);
};

const PALETTE = {
  sand: { main: [216, 196, 151], main_bg: [157, 142, 114] },
  red: { main: [187, 93, 93], main_bg: [113, 56, 56] },
  blue: { main: [105, 142, 201], main_bg: [62, 84, 121] },
  green: { main: [77, 157, 112], main_bg: [31, 86, 56] },
  teal: { main: [70, 163, 175], main_bg: [36, 85, 92] },
  steel: { main: [96, 146, 173], main_bg: [42, 67, 81] },
  purple: { main: [150, 124, 201], main_bg: [78, 62, 112] },
};
const ATTRS = {
  brightness: ["Brightness", "mdi:brightness-6"],
  color_temp: ["Colour temperature", "mdi:thermometer"],
  color: ["Colour", "mdi:palette-outline"],
  effect: ["Effect", "mdi:creation-outline"],
};
const TOGGLES = ["switch", "light", "input_boolean", "fan", "automation", "siren"];
const NO_VALUE = ["unknown", "unavailable", undefined];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rgb = (c, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
// a length of time in minutes: "45mins", "1h", "1h 30mins"
const dur = (mins) => {
  const m = Math.round(Number(mins));
  const ms = (x) => `${x}min${x === 1 ? "" : "s"}`;
  if (!Number.isFinite(m)) return "—";
  if (m < 60) return ms(m);
  return m % 60 ? `${Math.floor(m / 60)}h ${ms(m % 60)}` : `${Math.floor(m / 60)}h`;
};
// a countdown: "12:34" under an hour; from an hour up no seconds, "2h 59mins"
const clock = (secs) => {
  const s = Math.max(0, Math.round(secs));
  if (s >= 3600) return dur(Math.floor(s / 60));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const secsLeft = (timer) => {
  // a timestamp sensor (Knit's "... ends"): until that time
  if (timer?.attributes.device_class === "timestamp") {
    const left = (Date.parse(timer.state) - Date.now()) / 1000;
    return Number.isFinite(left) && left > 0 ? left : undefined;
  }
  if (timer?.state === "active" && timer.attributes.finishes_at) {
    return Math.max(0, (new Date(timer.attributes.finishes_at) - Date.now()) / 1000);
  }
  if (timer?.state === "paused" && timer.attributes.remaining) {
    const [h, m, s] = timer.attributes.remaining.split(":").map(Number);
    return h * 3600 + m * 60 + s;
  }
  return undefined;
};
const durationSecs = (d) => {
  const [h, m, s] = String(d || "").split(":").map(Number);
  return [h, m, s].every(Number.isFinite) ? h * 3600 + m * 60 + s : undefined;
};
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${dur(Math.floor(s / 60))} ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
};
// seconds per unit of a time helper
const UNIT_SECS = { s: 1, sec: 1, min: 60, h: 3600 };
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? (Math.abs(n) >= 10 ? Math.round(n) : Number(n.toFixed(1))) : "—";
};
// [r, g, b] from [r, g, b], "#rrggbb" or "r, g, b"
const toRgb = (v) => {
  if (Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(Number(x)))) return v.map(Number);
  const h = String(v || "").trim().match(/^#?([0-9a-f]{6})$/i);
  if (h) return [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16));
  const l = String(v || "").split(",").map(Number);
  return l.length === 3 && l.every(Number.isFinite) ? l : undefined;
};
// everything follows the primary colour: the filled parts are a darker shade of it
// ---- the Knit integration --------------------------------------------------------------
// Its entities carry `knit: <light>` and a `role`; for a light it manages, the card
// fills in Motion / Motion control / Light level from them, so only `entity` is needed.
// Anything set in the card's own config wins; a group set to false is left out.
const found = (hass, light) => {
  const out = {};
  for (const st of Object.values(hass?.states || {})) {
    if (st.attributes.knit === light && st.attributes.role) out[st.attributes.role] = st.entity_id;
  }
  return out;
};
const foundKey = (hass, light) => JSON.stringify(found(hass, light));
// the light a Knit device runs (from any of its entities' `knit`)
const lightOfDevice = (hass, device) => {
  for (const e of Object.values(hass?.entities || {})) {
    if (e.device_id !== device) continue;
    const light = hass.states[e.entity_id]?.attributes.knit;
    if (light) return light;
  }
  return undefined;
};
// the Knit device that runs a light
const deviceOfLight = (hass, light) => {
  for (const eid of Object.values(found(hass, light))) {
    const dev = hass?.entities?.[eid]?.device_id;
    if (dev) return dev;
  }
  return undefined;
};
const withFound = (raw, hass) => {
  const f = found(hass, raw.entity);
  if (!Object.keys(f).length) return raw;
  const dark = f.dark && hass.states[f.dark];
  const fill = (key, auto) => {
    if (raw[key] === false) return undefined;
    const merged = { ...auto, ...(raw[key] || {}) };
    Object.keys(merged).forEach((k) => merged[k] === undefined && delete merged[k]);
    return merged;
  };
  const c = {
    ...raw,
    managed: true,
    // Motion is the Motion control switch (it covers the timeout; older versions had a separate one)
    motion: fill("motion", { presence: f.occupied }),
    auto_off: fill("auto_off", {
      enabled: f.motion || f.auto_off,
      duration: f.auto_off_time,
      dim: f.dim_time,
      timer: f.auto_off_ends,
      // a motion-controlled device: presence never turns it on
      switch_only: f.motion && hass.states[f.motion]?.attributes.turns_on === false ? true : undefined,
    }),
    light_level: fill("light_level", {
      enabled: f.light_level,
      dark_below: f.dark_below,
      light_above: f.light_above,
      off_after: f.off_after,
      timer: f.off_when_light_ends,
      dark: f.dark,
      // the average of its light sensors (older versions: the dark sensor's one sensor)
      illuminance: f.illuminance || dark?.attributes.illuminance || undefined,
    }),
  };
  // only the features the integration made for this light (no presence: no Motion control, ...)
  if (c.motion && !c.motion.presence) delete c.motion;
  if (c.auto_off && !c.auto_off.enabled && !c.auto_off.duration) delete c.auto_off;
  if (c.light_level && !c.light_level.enabled && !c.light_level.dark && !c.light_level.dark_below) delete c.light_level;
  ["motion", "auto_off", "light_level"].forEach((k) => c[k] === undefined && delete c[k]);
  return c;
};

// a colour temperature as RGB (Tanner Helland's approximation)
const kelvinRgb = (k) => {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((x) => Math.round(clamp(x, 0, 255)));
};
// the colours a dial runs through, as a CSS gradient
const spectrum = (d, min, max) => {
  const stops = Array.from({ length: 7 }, (_, i) => min + ((max - min) * i) / 6);
  return `linear-gradient(90deg, ${stops.map((v) => (d === "ct" ? rgb(kelvinRgb(v)) : `hsl(${v}, 100%, 50%)`)).join(", ")})`;
};

const colorsOf = (c) => {
  const main = toRgb(c.primary);
  if (main) return { main, main_bg: main.map((x) => Math.round(x * 0.7)) };
  return c.colors ? { ...PALETTE.sand, ...c.colors } : PALETTE[c.color] || PALETTE.sand;
};
const attrKey = (a) => (typeof a === "string" ? a : a?.entity ? "entity" : a?.type);

// contrast between two colours (WCAG), to keep text readable on either theme
const lum = (c) => {
  const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
// move a colour towards black or white until it reads against `on` at `ratio`
const readable = (c, on, ratio, toward) => {
  let out = c;
  for (let k = 0; k <= 1 && contrast(out, on) < ratio; k += 0.02) out = c.map((v, i) => Math.round(v + (toward[i] - v) * k));
  return out;
};
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
// the card's shades for each theme, all from the primary colour. Dark: the primary as it is
// (lightened if it would be hard to read on a dark card); light: darkened until it reads on
// white. The filled parts (white text on them) are darkened until that text reads.
const shades = (c, dark) => {
  // text is checked against the More controls panel, the most tinted background it sits on
  const main = dark ? readable(c.main, [44, 44, 44], 4.5, WHITE) : readable(c.main, [236, 236, 236], 4.5, BLACK);
  const fill = dark ? readable(c.main_bg, WHITE, 3, BLACK) : readable(main, WHITE, 4.5, BLACK);
  // the panel: lighter than the card in dark mode (the primary, paled), a faint tint of it in light mode
  const panel = dark ? rgb(main.map((v) => Math.round(v + (255 - v) * 0.35)), 0.1) : rgb(c.main, 0.16);
  return `--prime: ${rgb(main)}; --soft: ${rgb(main, 0.6)}; --bg: ${rgb(fill, dark ? 0.8 : 1)}; --tint: ${rgb(dark ? fill : c.main, dark ? 0.25 : 0.2)};
    --line: ${rgb(main, 0.18)}; --edge: ${rgb(main, 0.35)}; --panel: ${panel};
    --well: ${dark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.05)"};`;
};

const CSS = (c) => `
  :host { ${shades(c, true)} }
  :host(.light) { ${shades(c, false)} }
  [hidden] { display: none !important; }
  /* the tile and the panel it opens are one box */
  ha-card {
    overflow: hidden; border-radius: 15px; border: 1px solid var(--edge); color: var(--primary-text-color);
    background: var(--ha-card-background, var(--card-background-color, #1c1c1c)); transition: border-color 0.2s, box-shadow 0.2s;
  }
  ha-card.on { border-color: var(--soft); box-shadow: 0 3px 8px 0 rgba(0, 0, 0, 0.25); }

  .tile {
    position: relative; display: flex; align-items: center; gap: 10px; min-width: 0; height: 60px; box-sizing: border-box;
    padding: 0 6px 0 10px; cursor: pointer; user-select: none; -webkit-user-select: none; touch-action: pan-y; outline: none;
    transition: background 0.2s;
  }
  /* the tile's colour (the tint while on, the brightness fill): its own layer, so an opened
     card can keep it to the tile's own outline */
  .tile .face { position: absolute; inset: 0; pointer-events: none; transition: background 0.2s; }
  .tile.on .face { background: var(--tint); }
  .tile .fill { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--tint); opacity: 0.9; pointer-events: none; transition: width 0.25s; }
  .tile.dragging .fill { transition: none; background: var(--bg); opacity: 0.45; }
  .tile .ic {
    position: relative; flex: none; width: 38px; height: 38px; display: flex; align-items: center; justify-content: center;
    border-radius: 19px; color: var(--secondary-text-color); background: var(--well); --mdc-icon-size: 20px;
  }
  .tile.on .ic { background: var(--bg); color: #fff; }
  .tile .ic svg { position: absolute; inset: -2px; width: 42px; height: 42px; transform: rotate(-90deg); pointer-events: none; }
  .tile .ic circle { fill: none; stroke-width: 2.5; stroke-linecap: round; }
  .tile .ic .rg { stroke: var(--prime); transition: stroke-dashoffset 1s linear; }
  .tile .ic .rd { stroke: color-mix(in srgb, var(--prime) 80%, #000); transition: stroke-dashoffset 1s linear; }
  /* while on, the countdown sits just inside the icon's fill; in light mode the fill is as dark as
     the ring would be, so it's white there, its dim half way between white and the fill */
  .tile.on .ic svg { transform: rotate(-90deg) scale(0.84); }
  :host(.light) .tile.on .ic .rg { stroke: #fff; }
  :host(.light) .tile.on .ic .rd { stroke: color-mix(in srgb, #fff 50%, var(--bg)); }
  .tile .txt { position: relative; min-width: 0; flex: 1; }
  .tile .n { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tile .s { font-size: 11px; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tile.on .s { color: var(--prime); opacity: 1; }
  .tile .exp {
    position: relative; flex: none; width: 30px; height: 30px; border-radius: 15px; border: none; background: none; padding: 0;
    color: var(--secondary-text-color); cursor: pointer; display: flex; align-items: center; justify-content: center;
    --mdc-icon-size: 20px; transition: transform 0.2s;
  }
  ha-card.open .tile .exp { transform: rotate(180deg); color: var(--prime); }

  .panel { border-top: 1px solid var(--line); padding: 10px 12px 12px; }
  /* opened at its own width: the tile's foot is a dashed line over its colour (as when it's
     spread across the row), not a separate edge on the panel, so no gap shows between them */
  :host(:not(.wide)) ha-card.open .panel { border-top: none; }
  :host(:not(.wide)) ha-card.open .tile::after {
    content: ""; position: absolute; left: 0; right: 0; bottom: 0; border-top: 1px dashed var(--wedge); pointer-events: none;
  }

  /* opened across the whole row (a part-width card in a sections view): the tile keeps its
     width and place, the panel spans the row beneath it, joined to the tile as one shape */
  :host(.wide) ha-card, :host(.wide) ha-card.on { overflow: visible; border: none; background: none; box-shadow: none; }
  :host(.wide) ha-card.on { filter: drop-shadow(0 3px 4px rgba(0, 0, 0, 0.2)); }
  :host(.wide) .tile {
    height: calc(60px + var(--tab-x)); padding-bottom: var(--tab-x); margin-bottom: -1px; z-index: 1; overflow: visible;
    transition: none; /* its fill at once, covering the panel's top edge */
    border: 1px solid var(--edge); border-bottom: none; border-radius: 15px 15px 0 0;
    background-color: var(--ha-card-background, var(--card-background-color, #1c1c1c));
  }
  /* the row is (card width + gap) / its share wide; the panel starts at the row's left edge */
  :host(.wide) .panel {
    box-sizing: border-box; width: calc((100% + var(--wide-gap)) / var(--tile-w) - var(--wide-gap));
    margin-left: calc((100% + var(--wide-gap)) / var(--tile-w) * var(--tile-x) * -1);
    border: 1px solid var(--edge); border-radius: 15px;
    background: var(--ha-card-background, var(--card-background-color, #1c1c1c));
  }
  :host(.wide.at-left) .panel { border-top-left-radius: 0; }
  :host(.wide.at-right) .panel { border-top-right-radius: 0; }
  /* the curved inside corners where the tile meets the panel. Offsets are from the panel's
     padding box (its width less the 2px border), where the row is (100% + 2px + gap) wide */
  ha-card { --wedge: var(--edge); }
  ha-card.on { --wedge: var(--soft); }
  :host(.wide) .panel { position: relative; }
  /* each over a solid backing that hides the straight edges beneath it, so they end where the
     curve takes over instead of showing through it */
  :host(.wide) .panel::before, :host(.wide) .panel::after {
    content: ""; position: absolute; top: -16px; width: 16px; height: 16px; z-index: 2; pointer-events: none;
    --fill: var(--ha-card-background, var(--card-background-color, #1c1c1c));
  }
  :host(.wide) .panel::before {
    left: calc(var(--tile-x) * (100% + 2px + var(--wide-gap)) - 16px); /* over the tile's border */
    background: radial-gradient(circle at 0 0, transparent 15px, var(--wedge) 15px, var(--wedge) 16px, transparent 16px),
      radial-gradient(circle at 0 0, transparent 15px, var(--fill) 15px);
  }
  :host(.wide) .panel::after {
    left: calc((var(--tile-x) + var(--tile-w)) * (100% + 2px + var(--wide-gap)) - var(--wide-gap) - 2px);
    background: radial-gradient(circle at 100% 0, transparent 15px, var(--wedge) 15px, var(--wedge) 16px, transparent 16px),
      radial-gradient(circle at 100% 0, transparent 15px, var(--fill) 15px);
  }
  :host(.wide.at-left) .panel::before, :host(.wide.at-right) .panel::after { display: none; }
  /* the tile's own outline is kept at its own height: dashed along the foot it has while closed
     (the part with no line of its own, across the tab) */
  :host(.wide) .tile .face { border-radius: 14px 14px 0 0; overflow: hidden; }
  /* down under the dashed foot (it's drawn over the colour), so no gap shows between them */
  /* (its corners curve round the same centre as the dashed foot's: 14px across, 15px down) */
  :host(.wide.tab) .tile .face { bottom: auto; height: 61px; border-radius: 14px 14px 14px 14px / 14px 14px 15px 15px; }
  /* on the tile's side borders (1px out from its padding box): the ends meet them */
  :host(.wide.tab) .tile::after {
    content: ""; position: absolute; left: -1px; right: -1px; top: 45px; height: 16px; box-sizing: border-box; pointer-events: none;
    border: 1px dashed var(--wedge); border-top: none; border-radius: 0 0 15px 15px;
    clip-path: inset(0 1px); /* not over the solid side borders: it starts where it leaves them */
  }
  :host(.wide) ha-card.on .tile, :host(.wide) ha-card.on .panel { border-color: var(--soft); }
  .panel > .part + .part { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }

  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 32px; }
  .row .end { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .title {
    display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; font-weight: 500;
    color: var(--secondary-text-color); --mdc-icon-size: 20px;
  }
  .title span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .val { font-size: 13px; font-weight: 600; color: var(--prime); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .hint { font-size: 12px; opacity: 0.7; margin: 2px 0 0 28px; }
  /* an On / Off button: "On", filled, while on; "Off", outlined, while off */
  .offb {
    flex: none; min-width: 56px; height: 32px; padding: 0 12px; box-sizing: border-box; cursor: pointer;
    font: inherit; font-size: 12px; font-weight: 600; border-radius: 15px;
    border: 1px solid var(--soft); background: transparent; color: var(--prime);
  }
  .offb::before { content: "Off"; }
  .offb.on { background: var(--bg); border-color: var(--bg); color: #fff; }
  .offb.on::before { content: "On"; }
  .offb[disabled] { opacity: 0.45; cursor: default; }

  .chips { display: grid; grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr)); gap: 6px; margin-top: 8px; }
  .chip {
    min-width: 0; height: 32px; box-sizing: border-box; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
    display: flex; align-items: center; justify-content: center; background: transparent; color: var(--prime);
    border: 1px solid var(--soft); border-radius: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 6px;
  }
  .chip.on { background: var(--bg); border-color: var(--bg); color: #fff; }

  /* More controls */
  .xrow {
    width: 100%; display: flex; align-items: center; gap: 8px; padding: 0; min-height: 32px; cursor: pointer;
    background: none; border: none; font: inherit; font-size: 14px; font-weight: 500;
    color: var(--secondary-text-color); --mdc-icon-size: 20px; text-align: left;
  }
  .xrow .lb { flex: 1; }
  .xrow .chev { transition: transform 0.2s; }
  .xrow[aria-expanded="true"] .chev { transform: rotate(180deg); color: var(--prime); }
  /* More controls sits on a lighter panel of its own */
  .mset { margin: 10px 0 0; padding: 12px; border-radius: 12px; background: var(--panel); }
  .grp + .grp { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
  /* a section: row 1 icon + title | state + On / Off; then its sentence (and any note) across,
     stopping where the button starts. Narrow cards: one column */
  .mset { container-type: inline-size; }
  .grp { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 10px; row-gap: 2px; align-items: center; }
  .grp > .title { grid-column: 1; min-height: 32px; color: var(--primary-text-color); }
  .grp > .end { grid-column: 2; justify-self: end; display: flex; align-items: center; gap: 10px; min-width: 0; }
  /* level with the icon above, not indented to the title */
  .grp > .sent, .grp > .note { grid-column: 1 / -1; margin: 0 var(--btnw, 56px) 0 0; }
  .note { font-size: 12px; opacity: 0.7; }
  @container (max-width: 300px) {
    .grp { grid-template-columns: minmax(0, 1fr); }
    .grp > .end { grid-column: 1; justify-self: start; margin-left: 28px; }
    .grp > .sent, .grp > .note { margin-right: 0; }
  }
  .sub { margin: 8px 0 0 28px; transition: opacity 0.2s; }
  .sub .title { font-size: 12px; }
  .grp.off .sub, .grp.off .hint { opacity: 0.45; }
  .grp.blocked > .end .offb, .grp.blocked > .title { opacity: 0.45; }

  /* times: mm:ss in one box, styled as the heating schedule's From / To time picker; each
     part is typed, or stepped with the arrow keys */
  .tin { display: inline-flex; align-items: center; gap: 6px; flex: none; }
  /* time and lx boxes: the same size and the same padding all round */
  .tbox {
    display: inline-flex; align-items: center; font-size: 13px; font-variant-numeric: tabular-nums;
    border: 1px solid var(--soft); border-radius: 8px; padding: 2px; line-height: 18px; color: var(--primary-text-color);
  }
  .tbox:focus-within { border-color: var(--prime); }
  .tbox input {
    width: 2.2ch; padding: 0; border: none; outline: none; background: transparent; text-align: center;
    font: inherit; color: inherit; border-radius: 4px; -moz-appearance: textfield; caret-color: transparent;
  }
  .tbox input.mm { width: 2.2ch; }
  .tbox input:focus { background: var(--bg); color: #fff; }
  .tbox input::-webkit-outer-spin-button, .tbox input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .tbox input[disabled] { cursor: default; }
  .tbox .colon { padding: 0 1px; }
  /* a group's settings as one sentence, the values typed in place */
  .sent { font-size: 13px; line-height: 26px; color: var(--secondary-text-color); }
  .sent .tin, .sent .num { vertical-align: middle; margin: 0 1px; }
  .grp.off .sent .tin, .grp.off .sent .num { opacity: 0.45; }
  /* a typed number with its unit (other entities' input_numbers) */
  .num { display: inline-flex; align-items: center; gap: 4px; }
  /* wide enough for 1000 or 1.3 */
  .num input {
    width: calc(4ch + 4px); font: inherit; font-size: 13px; line-height: 18px; text-align: center; color: var(--primary-text-color); background: transparent;
    border: 1px solid var(--soft); border-radius: 8px; padding: 2px; -moz-appearance: textfield;
  }
  .num input::-webkit-outer-spin-button, .num input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .num .u { font-size: 12px; opacity: 0.75; }

  /* Dark below / Light above: two typed values on one row */
  .lvlrow { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
  .lvf { display: flex; align-items: center; gap: 8px; }
  .grp.off .num input, .num input[disabled] { opacity: 0.45; }

  /* brightness / colour temperature / colour: small tiles in the main tile's style, dragged
     sideways (or tapped, or arrow keys) to set them */
  .part.dtp + .part.dtp { border-top: none; padding-top: 0; margin-top: 8px; }
  .dt {
    position: relative; overflow: hidden; display: flex; align-items: center; gap: 10px; height: 52px; box-sizing: border-box;
    padding: 0 12px 0 8px; border-radius: 15px; cursor: ew-resize; outline: none; touch-action: pan-y; user-select: none; -webkit-user-select: none;
    border: 1px solid var(--edge); background: var(--ha-card-background, var(--card-background-color, #1c1c1c));
  }
  .dt:focus-visible { border-color: var(--prime); }
  .dt .fill { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--tint); opacity: 0.9; pointer-events: none; transition: width 0.25s; }
  .dt.dragging .fill { transition: none; background: var(--bg); opacity: 0.45; }
  .dt .dic {
    position: relative; flex: none; width: 32px; height: 32px; border-radius: 16px; display: flex; align-items: center; justify-content: center;
    color: var(--secondary-text-color); background: var(--well); --mdc-icon-size: 18px;
  }
  .dt.on .dic { background: var(--bg); color: #fff; }
  /* name · value on one line */
  .dt .tx { position: relative; min-width: 0; display: flex; align-items: baseline; gap: 5px; white-space: nowrap; }
  .dt .ln { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .dt .dot { opacity: 0.6; }
  .dt .lv { font-size: 13px; opacity: 0.8; font-variant-numeric: tabular-nums; }
  .dt.on .lv { color: var(--prime); opacity: 1; }
  /* colour temperature / colour: the range faintly behind, the colours up to the value in full */
  .dt.spec::before { content: ""; position: absolute; inset: 0; background: var(--spec); opacity: 0.12; pointer-events: none; }
  .dt.spec .fill { opacity: 0.5; transition: clip-path 0.25s; }
  .dt.spec.dragging .fill { opacity: 0.7; background: var(--spec); transition: none; }

`;

class SmartLightCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("knit-light-card-editor");
  }

  static getStubConfig(hass) {
    // a Knit light if there is one, else the first light
    const managed = Object.values(hass?.states || {}).find((st) => st.attributes.knit);
    if (managed) {
      const light = managed.attributes.knit;
      const ok = supportedAttrs(hass.states[light]).map((o) => o.value).filter((k) => k === "brightness" || k === "color_temp");
      return { device: hass.entities?.[managed.entity_id]?.device_id, entity: light, attributes: ok };
    }
    const light = Object.keys(hass?.states || {}).find((id) => id.startsWith("light.")) || "light.example";
    return { entity: light, attributes: ["brightness", "color_temp"] };
  }

  setConfig(config) {
    if (!config?.entity && !config?.device) throw new Error("Pick a Knit device (device) or a light (entity)");
    this._raw = { secondary: ["state", "brightness", "countdown"], attributes: [], ...config };
    this._config = withFound(this._raw, this._hass);
    this._pending = {};
    const mem = OPEN.get(config.device || config.entity);
    this._open = mem?.open ?? this._open ?? false;
    this._ctlOpen = mem?.ctl ?? this._ctlOpen ?? false;
    this._dom();
  }

  // the markup uses entity names, so it's drawn again once hass first arrives
  _dom() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._raw.entity) {
      this.shadowRoot.innerHTML = `<ha-card style="padding:16px">Waiting for the Knit device…</ha-card>`;
      return;
    }
    this._drawnWithHass = Boolean(this._hass);
    this._config = withFound(this._raw, this._hass);
    this._foundKey = foundKey(this._hass, this._raw.entity);
    this.shadowRoot.innerHTML = `<style>${CSS(colorsOf(this._config))}</style><ha-card>${this._html()}</ha-card>`;
    this._bind();
    this._setOpen(this._open);
    if (this._ctlOpen) this._showCtl(true);
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    // only a Knit device given: the light it runs
    if (!this._raw.entity && this._raw.device) {
      this._raw.entity = lightOfDevice(hass, this._raw.device);
      if (!this._raw.entity) return;
      this._drawnWithHass = false;
    }
    // drawn again once hass arrives, and when the integration's entities for this light change
    if (!this._drawnWithHass || foundKey(hass, this._raw.entity) !== this._foundKey) this._dom();
    else this._render();
  }

  connectedCallback() {
    this._tick = setInterval(() => this._hass && this._config && this._render(), 1000);
    // another light card opened: close this one (unless collapse_others: false)
    this._onOther = (e) => {
      if (e.detail !== this && this._open && this._config?.collapse_others !== false) this._setOpen(false);
    };
    window.addEventListener(OPENED_EVENT, this._onOther);
    // open before it was in the dashboard: widened once it's in its place
    requestAnimationFrame(() => this._open && widen(this, true));
    this._onResize = () => requestAnimationFrame(() => rewiden(this));
    window.addEventListener("resize", this._onResize);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
    window.removeEventListener(OPENED_EVENT, this._onOther);
    window.removeEventListener("resize", this._onResize);
    widen(this, false);
  }

  getCardSize() {
    return this._open ? 6 : 1;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  // ---- helpers ------------------------------------------------------------------------

  $(sel) {
    return this.shadowRoot.querySelector(sel);
  }

  $$(sel) {
    return this.shadowRoot.querySelectorAll(sel);
  }

  _st(id) {
    return id ? this._hass?.states[id] : undefined;
  }

  _call(domain, service, data) {
    return this._hass.callService(domain, service, data).catch((err) => {
      this.dispatchEvent(
        new CustomEvent("hass-notification", {
          detail: { message: `${domain}.${service} failed: ${err.message || err}` },
          bubbles: true,
          composed: true,
        })
      );
      throw err;
    });
  }

  // value shown while HA catches up with a change we just sent
  _hold(key, value, actual) {
    const p = this._pending[key];
    if (p) {
      if (actual === p.value || Date.now() > p.until) delete this._pending[key];
      else return p.value;
    }
    return value;
  }

  // send, show the new value straight away, fall back if the call fails
  _optimistic(key, value, call) {
    this._pending[key] = { value, until: Date.now() + PENDING_MS };
    this._render();
    call().catch(() => {
      delete this._pending[key];
      this._render();
    });
  }

  _isOnId(id) {
    const on = this._st(id)?.state === "on";
    return this._hold(`sw:${id}`, on, on);
  }

  _toggleId(id) {
    const on = this._isOnId(id);
    this._optimistic(`sw:${id}`, !on, () => this._call("homeassistant", on ? "turn_off" : "turn_on", { entity_id: id }));
  }

  _setNumber(id, v) {
    const domain = id.split(".")[0] === "number" ? "number" : "input_number";
    this._optimistic(`num:${id}`, v, () => this._call(domain, "set_value", { entity_id: id, value: v }));
  }

  _number(id) {
    const actual = Number(this._st(id)?.state);
    return this._hold(`num:${id}`, actual, actual);
  }

  _isOn() {
    return this._isOnId(this._config.entity);
  }

  _dimmable() {
    const modes = this._st(this._config.entity)?.attributes.supported_color_modes || [];
    return this._config.entity.startsWith("light.") && modes.some((m) => m !== "onoff");
  }

  // a dim before off, for a light that can be dimmed
  _hasDim() {
    return Boolean(this._config.auto_off?.dim) && this._dimmable();
  }

  _brightness() {
    const b = this._st(this._config.entity)?.attributes.brightness;
    const actual = b != null ? Math.round((b / 255) * 100) : undefined;
    return this._hold("bri", actual, actual);
  }

  // ---- times: helpers in s / min / h, the dim also as a % of the motion timeout -----------------

  _timeId(key) {
    const c = this._config;
    return { auto: c.auto_off?.duration, dim: c.auto_off?.dim, after: c.light_level?.off_after }[key];
  }

  _unit(id) {
    return this._st(id)?.attributes.unit_of_measurement || "min";
  }

  _secs(key) {
    const id = this._timeId(key);
    const v = this._number(id);
    if (!Number.isFinite(v)) return undefined;
    const unit = this._unit(id);
    if (key === "dim" && unit === "%") return Math.round(((this._secs("auto") || 0) * v) / 100);
    return Math.round(v * (UNIT_SECS[unit] ?? 60));
  }

  // the dim actually used: at most DIM_MAX of the motion timeout
  _dimSecs() {
    const d = this._secs("dim");
    const a = this._secs("auto");
    return d === undefined ? 0 : Math.min(d, Math.floor((a || 0) * DIM_MAX));
  }

  // the smallest step the helper can save, in seconds (a minutes helper can't hold seconds)
  _grain(key) {
    const id = this._timeId(key);
    const a = this._st(id)?.attributes || {};
    const step = Number(a.step) || 1;
    const unit = this._unit(id);
    if (key === "dim" && unit === "%") return ((this._secs("auto") || 0) * step) / 100;
    return (UNIT_SECS[unit] ?? 60) * step;
  }

  _writeSecs(key, secs) {
    const id = this._timeId(key);
    const st = this._st(id);
    if (!st) return;
    const a = st.attributes;
    const unit = this._unit(id);
    if (key === "dim") secs = Math.min(secs, Math.floor((this._secs("auto") || 0) * DIM_MAX));
    let v = key === "dim" && unit === "%" ? (100 * secs) / (this._secs("auto") || 1) : secs / (UNIT_SECS[unit] ?? 60);
    const step = Number(a.step) || 1;
    v = clamp(Math.round(v / step) * step, Number(a.min ?? 0), Number(a.max ?? Infinity));
    v = Number(v.toFixed(4));
    this._setNumber(id, v);
  }

  _focused(el) {
    return el.contains(this.shadowRoot.activeElement);
  }

  // ---- markup -------------------------------------------------------------------------

  // the title: the card's own, else the Knit device's name, else the light's
  _title() {
    const c = this._config;
    if (c.name) return c.name;
    const dev = this._hass?.devices?.[c.device || deviceOfLight(this._hass, c.entity)];
    return dev?.name_by_user || dev?.name || this._st(c.entity)?.attributes.friendly_name || c.entity;
  }

  _html() {
    const c = this._config;
    const title = this._title();
    const arc = (cls) => `<circle class="${cls}" cx="21" cy="21" r="19" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"></circle>`;
    const panel = this._panelHtml();
    return `
      <div class="tile" role="button" tabindex="0" aria-label="${esc(title)}">
        <div class="face"><div class="fill"></div></div>
        <div class="ic"><svg viewBox="0 0 42 42" aria-hidden="true">${arc("rg")}${this._hasDim() ? arc("rd") : ""}</svg><ha-icon icon="${esc(c.icon || "mdi:lightbulb-outline")}"></ha-icon></div>
        <div class="txt"><div class="n">${esc(title)}</div><div class="s"></div></div>
        ${panel ? `<button class="exp" aria-label="More for ${esc(title)}" aria-expanded="false"><ha-icon icon="mdi:chevron-down"></ha-icon></button>` : ""}
      </div>
      ${panel ? `<div class="panel" hidden>${panel}</div>` : ""}`;
  }

  _panelHtml() {
    const c = this._config;
    const parts = (c.attributes || []).map((a, j) => this._attrHtml(a, j)).filter(Boolean);
    // hidden groups aren't drawn (their countdowns still show on the tile)
    const shown = (g) => (c[g] && !c[g].hidden ? this[`_${{ motion: "motion", auto_off: "auto", light_level: "level" }[g]}Html`]() : "");
    const groups = [shown("auto_off"), shown("light_level")].filter(Boolean);
    if (groups.length) {
      parts.push(`<button class="xrow" data-ctl aria-expanded="false"><ha-icon icon="mdi:tune-variant"></ha-icon><span class="lb">More controls</span><ha-icon class="chev" icon="mdi:chevron-down"></ha-icon></button>
        <div class="mset" hidden>${groups.join("")}</div>`);
    }
    // slider tiles (with or without the colour spectrum) sit together, without dividers
    return parts.map((p) => `<div class="part${/class="dt[ "]/.test(p) ? " dtp" : ""}">${p}</div>`).join("");
  }

  _attrHtml(a, j) {
    const key = attrKey(a);
    const head = (name, icon, end) =>
      `<div class="row"><div class="title"><ha-icon icon="${esc(icon)}"></ha-icon><span>${esc(name)}</span></div><div class="end">${end}</div></div>`;
    const name = (dflt) => (typeof a === "object" && a.name) || dflt;
    const icon = (dflt) => (typeof a === "object" && a.icon) || dflt;
    if (ATTRS[key]) {
      const [n, i] = ATTRS[key];
      if (key === "effect") return `<div data-a="effect">${head(name(n), icon(i), `<span class="val" data-av="effect"></span>`)}<div class="chips" data-fx></div></div>`;
      const d = { brightness: "bri", color_temp: "ct", color: "hue" }[key];
      // colour temperature and colour show the light's actual colours, unless use_primary
      const spec = d !== "bri" && !(typeof a === "object" && a.use_primary) ? " spec" : "";
      return `<div data-a="${key}"><div class="dt${spec}" data-d="${d}" role="slider" tabindex="0" aria-label="${esc(name(n))}"><div class="fill"></div><div class="dic"><ha-icon icon="${esc(icon(i))}"></ha-icon></div><span class="tx"><span class="ln">${esc(name(n))}</span><span class="dot">·</span><span class="lv"></span></span></div></div>`;
    }
    if (key !== "entity") return "";
    const id = a.entity;
    const domain = id.split(".")[0];
    const label = name(this._st(id)?.attributes.friendly_name || id);
    const ic = icon(this._st(id)?.attributes.icon || "mdi:information-outline");
    let end = `<span class="val" data-ev="${j}"></span>`;
    let below = "";
    if (TOGGLES.includes(domain)) end = `<button class="offb" data-etog="${esc(id)}" role="switch" aria-label="${esc(label)}"></button>`;
    else if (domain === "input_number" || domain === "number")
      end = `<span class="num"><input type="number" data-enum="${esc(id)}" aria-label="${esc(label)}"><span class="u" data-eu="${j}"></span></span>`;
    else if (domain === "input_select" || domain === "select") below = `<div class="chips" data-esel="${esc(id)}"></div>`;
    return `<div data-e="${j}">${head(label, ic, end)}${below}</div>`;
  }

  _tinHtml(key, label) {
    return `<span class="tin" data-tin="${key}"><span class="tbox"><input class="mm" type="number" inputmode="numeric" min="0" data-tm aria-label="${esc(label)} minutes"><span class="colon">:</span><input type="number" inputmode="numeric" min="0" max="59" data-ts aria-label="${esc(label)} seconds"></span></span>`;
  }

  // row 1: icon + title | state + On / Off (the grid's two cells)
  _groupHead(g, icon, label, sw) {
    return `<div class="title"><ha-icon icon="${icon}"></ha-icon><span>${esc(label)}</span></div><div class="end"><span class="val" data-gv="${g}"></span>${
      sw ? `<button class="offb" data-gsw="${g}" role="switch" aria-label="${esc(label)}"></button>` : ""
    }</div>`;
  }

  // a sentence with values typed in place: text slots between the inputs, filled in by
  // _sentence() as the switches change ("Motion detected turns the light on, it goes off
  // after [05:00] mins, and will dim [01:00] mins before turning off.")
  _sentHtml(key, inputs) {
    const slot = (i) => `<span data-sp="${i}"></span>`;
    return `<div class="sent" data-sent="${key}">${slot(0)}${inputs.map((h, i) => h + slot(i + 1)).join("")}</div>`;
  }

  _sentence(key, tokens) {
    const box = this.$(`[data-sent="${key}"]`);
    if (!box) return;
    // tokens: text and input keys, in the inputs' order; the text between them goes in the slots
    const texts = [""];
    tokens.forEach((t) => (typeof t === "string" ? (texts[texts.length - 1] += t) : texts.push("")));
    box.querySelectorAll("[data-sp]").forEach((sp, i) => {
      const t = texts[i] ?? "";
      if (sp.textContent !== t) sp.textContent = t;
    });
  }

  _autoHtml() {
    const x = this._config.auto_off;
    if (!x) return "";
    // a light that can't be dimmed (a switch, an on / off light) has no dim before off
    const inputs = [x.duration && this._tinHtml("auto", "Off after"), this._hasDim() && this._tinHtml("dim", "Dim before off")].filter(Boolean);
    return `<div class="grp" data-g="auto">${this._groupHead("auto", "mdi:timer-outline", "Motion control", x.enabled)}${
      inputs.length ? this._sentHtml("auto", inputs) : ""
    }${x.hint ? `<div class="note">${esc(x.hint)}</div>` : ""}</div>`;
  }

  _levelHtml() {
    const x = this._config.light_level;
    if (!x) return "";
    const num = (attrs, label) => `<span class="num"><input type="number" ${attrs} aria-label="${label}"><span class="u"></span></span>`;
    // no settings of its own (a threshold helper as its dark sensor): its limits, greyed
    const ro = !x.dark_below && !x.light_above && x.dark;
    const inputs = [
      (x.dark_below || ro) && num(ro ? 'disabled data-ro="0"' : 'inputmode="decimal" data-lvl="dark"', "Dark below"),
      (x.light_above || ro) && num(ro ? 'disabled data-ro="1"' : 'inputmode="decimal" data-lvl="above"', "Light above"),
      x.off_after && this._tinHtml("after", "Off when light after"),
    ].filter(Boolean);
    return `<div class="grp" data-g="level">${this._groupHead("level", "mdi:theme-light-dark", "Light level", x.enabled)}${
      inputs.length ? this._sentHtml("level", inputs) : ""
    }${ro ? `<div class="note" data-roh></div>` : ""}${x.hint ? `<div class="note">${esc(x.hint)}</div>` : ""}</div>`;
  }

  // the Light level sentence for the switches' state, with only the values it has
  _levelTokens(lvlOn, motionCtl, has) {
    const D = 0, A = 1, T = 2; // the inputs, as tokens (numbers)
    const tail = (start, light, lightFor) => {
      if (has.above && has.after) return [start, D, light, A, " for ", T, " mins."];
      if (has.after) return [start, D, lightFor, T, " mins."];
      if (has.above) return [start, D, light, A, "."];
      return [start, D, "."];
    };
    if (!lvlOn) {
      const t = ["Light level is ignored. When on, darker than ", D, " counts as dark"];
      if (has.above && has.after) return [...t, ", and lighter than ", A, " for ", T, " mins turns it off."];
      if (has.after) return [...t, ", and ", T, " mins of light turns it off."];
      if (has.above) return [...t, ", and lighter than ", A, " as light."];
      return [...t, "."];
    }
    return motionCtl
      ? tail("Motion only turns the light on when darker than ", ", and it goes off when lighter than ", ", and it goes off once it has been light for ")
      : tail("Turns the light on when darker than ", ", and off when lighter than ", ", and off once it has been light for ");
  }

  _lvlId(k) {
    return { dark: this._config.light_level?.dark_below, above: this._config.light_level?.light_above }[k];
  }

  // a level's limits, and a value snapped to its step (Dark below stays under Light above)
  _lvlRange(k) {
    const own = this._st(this._lvlId(k))?.attributes || {};
    return {
      lo: Number(own.min ?? 0),
      hi: Number(own.max ?? 10),
      step: Number(own.step) || 0.1,
      unit: own.unit_of_measurement || "lx",
    };
  }

  _lvlSnap(k, v) {
    const { step } = this._lvlRange(k);
    let { lo, hi } = this._lvlRange(k);
    const other = this._number(this._lvlId(k === "dark" ? "above" : "dark"));
    if (Number.isFinite(other) && k === "dark" && this._lvlId("above")) hi = Math.min(hi, other);
    if (Number.isFinite(other) && k === "above" && this._lvlId("dark")) lo = Math.max(lo, other);
    return Number(clamp(Math.round(v / step) * step, lo, hi).toFixed(4));
  }

  // a small tile dragged sideways to set a value: spec { range() -> { min, max }, snap(v), show(v), commit(v) }
  _bindDrag(el, spec) {
    let drag;
    const at = (e) => {
      const { min, max } = spec.range();
      const r = el.getBoundingClientRect();
      return spec.snap(min + clamp((e.clientX - r.left) / r.width, 0, 1) * (max - min));
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button === 0) drag = { x: e.clientX, y: e.clientY, on: false };
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.on && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(e.clientY - drag.y)) {
        drag.on = true;
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
      }
      if (drag.on) spec.show((drag.v = at(e)));
    });
    el.addEventListener("pointerup", (e) => {
      if (!drag) return;
      const d = drag;
      drag = undefined;
      el.classList.remove("dragging");
      // a drag sets where it ends; a tap sets where it lands
      const v = d.on ? d.v : at(e);
      if (Number.isFinite(v)) spec.commit(v);
    });
    el.addEventListener("pointercancel", () => {
      drag = undefined;
      el.classList.remove("dragging");
      this._render();
    });
    el.addEventListener("keydown", (e) => {
      const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      const cur = spec.value();
      if (!dir || !Number.isFinite(cur)) return;
      e.preventDefault();
      spec.commit(spec.snap(cur + dir * spec.step));
    });
  }

  // brightness %, colour temperature K, hue °: { min, max, step, value, fmt }
  _dial(d) {
    const a = this._st(this._config.entity)?.attributes || {};
    if (d === "bri") return { min: 1, max: 100, step: 1, value: this._brightness(), fmt: (v) => `${v}%` };
    if (d === "ct") {
      const k = this._hold("ct", a.color_temp_kelvin, a.color_temp_kelvin);
      return { min: a.min_color_temp_kelvin ?? 2000, max: a.max_color_temp_kelvin ?? 6500, step: 50, value: k, fmt: (v) => `${v} K` };
    }
    const hue = a.hs_color ? Math.round(a.hs_color[0]) : undefined;
    return { min: 0, max: 359, step: 1, value: this._hold("hue", hue, hue), fmt: (v) => `${v}°` };
  }

  _showDial(el, d, v, on) {
    const { min, max, fmt } = this._dial(d);
    const pct = on && Number.isFinite(v) ? clamp(((v - min) / (max - min || 1)) * 100, 0, 100) : 0;
    const fill = el.querySelector(".fill");
    if (el.classList.contains("spec")) {
      // the whole range faintly behind, the part up to the value in full
      const grad = spectrum(d, min, max);
      el.style.setProperty("--spec", grad);
      fill.style.background = grad;
      fill.style.width = "100%";
      fill.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    } else fill.style.width = `${pct}%`;
    el.querySelector(".lv").textContent = on && Number.isFinite(v) ? fmt(Math.round(v)) : "Off";
    el.classList.toggle("on", on);
    el.setAttribute("aria-valuenow", String(v));
  }

  // ---- events -------------------------------------------------------------------------

  _bind() {
    const c = this._config;
    const tile = this.$(".tile");
    this._bindTile(tile);
    this.$(".exp")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !this._open;
      // the others close first, so this one is measured beside them closed
      if (open && this._config.collapse_others !== false) window.dispatchEvent(new CustomEvent(OPENED_EVENT, { detail: this }));
      this._setOpen(open);
    });
    this.$("[data-ctl]")?.addEventListener("click", (e) => {
      const b = e.currentTarget;
      const open = b.getAttribute("aria-expanded") !== "true";
      b.setAttribute("aria-expanded", String(open));
      this._showCtl(open);
    });

    // brightness / colour temperature / colour tiles (setting one turns the light on)
    const send = {
      bri: (v) => this._call("light", "turn_on", { entity_id: c.entity, brightness_pct: v }),
      ct: (v) => this._call("light", "turn_on", { entity_id: c.entity, color_temp_kelvin: v }),
      hue: (v) => this._call("light", "turn_on", { entity_id: c.entity, hs_color: [v, 100] }),
    };
    this.$$("[data-d]").forEach((el) => {
      const d = el.dataset.d;
      this._bindDrag(el, {
        range: () => this._dial(d),
        step: this._dial(d).step,
        value: () => this._dial(d).value,
        snap: (v) => {
          const { min, max, step } = this._dial(d);
          return clamp(Math.round(v / step) * step, min, max);
        },
        show: (v) => this._showDial(el, d, v, true),
        commit: (v) => {
          this._pending[`sw:${c.entity}`] = { value: true, until: Date.now() + PENDING_MS };
          this._optimistic(d, v, () => send[d](v));
        },
      });
    });
    this.$("[data-fx]")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-opt]");
      if (b) this._optimistic("fx", b.dataset.opt, () => this._call("light", "turn_on", { entity_id: c.entity, effect: b.dataset.opt }));
    });

    // other entities
    this.$$("[data-etog]").forEach((b) => b.addEventListener("click", () => this._toggleId(b.dataset.etog)));
    this.$$("[data-enum]").forEach((inp) =>
      inp.addEventListener("change", () => {
        const v = Number(inp.value);
        const a = this._st(inp.dataset.enum)?.attributes || {};
        if (Number.isFinite(v)) this._setNumber(inp.dataset.enum, clamp(v, Number(a.min ?? -Infinity), Number(a.max ?? Infinity)));
      })
    );
    this.$$("[data-esel]").forEach((box) =>
      box.addEventListener("click", (e) => {
        const b = e.target.closest("[data-opt]");
        if (!b) return;
        const id = box.dataset.esel;
        const domain = id.split(".")[0];
        this._optimistic(`sel:${id}`, b.dataset.opt, () => this._call(domain, "select_option", { entity_id: id, option: b.dataset.opt }));
      })
    );

    // groups
    const swId = { motion: c.motion?.enabled, auto: c.auto_off?.enabled, level: c.light_level?.enabled };
    this.$$("[data-gsw]").forEach((b) => b.addEventListener("click", () => this._toggleId(swId[b.dataset.gsw])));
    // times: mm:ss; 75 seconds typed is 1:15; ↑ / ↓ step the part in focus (seconds roll over
    // into minutes); saved when a part changes
    this.$$("[data-tin]").forEach((box) => {
      const mm = box.querySelector("[data-tm]");
      const ss = box.querySelector("[data-ts]");
      const secs = () => Math.max(0, Math.floor(Number(mm.value) || 0)) * 60 + Math.max(0, Math.floor(Number(ss.value) || 0));
      const show = (t) => {
        mm.value = String(Math.floor(t / 60)).padStart(2, "0");
        ss.value = String(t % 60).padStart(2, "0");
      };
      const commit = () => {
        const t = secs();
        show(t);
        this._writeSecs(box.dataset.tin, t);
      };
      [mm, ss].forEach((inp) => {
        inp.addEventListener("focus", () => inp.select());
        inp.addEventListener("change", commit);
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") inp.blur();
          const dir = { ArrowUp: 1, ArrowDown: -1 }[e.key];
          if (!dir) return;
          e.preventDefault();
          show(Math.max(0, secs() + dir * (inp === mm ? 60 : 1)));
          inp.select();
          commit();
        });
        // two digits typed in the minutes moves on to the seconds
        inp.addEventListener("input", () => {
          if (inp === mm && mm.value.length >= 2 && this.shadowRoot.activeElement === mm) ss.focus();
        });
      });
    });
    this.$$("[data-lvl]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const v = Number(inp.value);
        if (inp.value !== "" && Number.isFinite(v)) this._setNumber(this._lvlId(inp.dataset.lvl), this._lvlSnap(inp.dataset.lvl, v));
        else this._render();
      });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") inp.blur();
      });
    });
  }

  _showCtl(open) {
    this._ctlOpen = open;
    const b = this.$("[data-ctl]");
    if (!b) return;
    b.setAttribute("aria-expanded", String(open));
    b.querySelector(".lb").textContent = open ? "Less controls" : "More controls";
    this.$(".mset").hidden = !open;
    this._remember();
    if (this._open) widen(this, true); // More controls open: across the row
  }

  _remember() {
    OPEN.set(this._raw?.device || this._raw?.entity, { open: this._open, ctl: this._ctlOpen });
  }

  _setOpen(open) {
    this._open = open;
    this._remember();
    const p = this.$(".panel");
    if (p) p.hidden = !open;
    this.$("ha-card").classList.toggle("open", open);
    this.$(".exp")?.setAttribute("aria-expanded", String(open));
    widen(this, open);
    if (this._hass) this._render();
  }

  // tap = toggle, sideways drag = brightness (dimmable lights)
  _bindTile(el) {
    const c = this._config;
    let start;
    const reset = () => {
      el.classList.remove("dragging");
      start = undefined;
    };
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".exp")) return;
      start = { x: e.clientX, y: e.clientY, drag: false, moved: false };
    });
    el.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!start.drag && this._dimmable() && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
        start.drag = true;
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
      }
      if (start.drag) {
        const r = el.getBoundingClientRect();
        start.pct = clamp(Math.round(((e.clientX - r.left) / r.width) * 100), 1, 100);
        el.querySelector(".fill").style.width = `${start.pct}%`;
        el.querySelector(".s").textContent = `${start.pct}%`;
      } else if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        start.moved = true;
      }
    });
    el.addEventListener("pointerup", () => {
      if (!start) return;
      const s = start;
      reset();
      if (s.drag) {
        if (s.pct) this._optimistic("bri", s.pct, () => this._call("light", "turn_on", { entity_id: c.entity, brightness_pct: s.pct }));
        this._pending[`sw:${c.entity}`] = { value: true, until: Date.now() + PENDING_MS };
      } else if (!s.moved) this._toggleId(c.entity);
    });
    el.addEventListener("pointercancel", reset);
    el.addEventListener("keydown", (e) => {
      if (e.target !== el) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this._toggleId(c.entity);
      }
    });
  }

  // ---- render -------------------------------------------------------------------------

  // the countdowns that will turn the light off: [{ label, left, total, auto }]
  _running() {
    const c = this._config;
    const out = [];
    const add = (id, label, auto) => {
      const t = this._st(id);
      const left = secsLeft(t);
      if (left !== undefined) out.push({ label, left, total: durationSecs(t.attributes.duration), auto });
    };
    if (c.auto_off?.timer) add(c.auto_off.timer, "Motion", true);
    if (c.light_level?.timer && (!c.light_level.enabled || this._isOnId(c.light_level.enabled))) add(c.light_level.timer, "Light", false);
    // timers: other countdowns; entities: [..] is one countdown that ends when the last does
    (c.timers || []).forEach((x) => {
      const all = (x.entities || [x.entity])
        .map((id) => this._st(id))
        .map((t) => ({ left: secsLeft(t), total: durationSecs(t?.attributes.duration) }))
        .filter((y) => y.left !== undefined);
      if (!all.length) return;
      const last = all.reduce((a, b) => (b.left > a.left ? b : a));
      out.push({ label: x.label || "Off", left: last.left, total: last.total, auto: false });
    });
    return out;
  }

  // light or dark shades: from the card's own background (a view can have its own theme),
  // else HA's dark mode, else the device's
  _theme() {
    const m = getComputedStyle(this.$("ha-card")).backgroundColor.match(/rgba?\(([^)]+)\)/);
    const v = m ? m[1].split(",").map((x) => Number(x)) : [];
    const dark =
      v.length >= 3 && (v[3] === undefined || v[3] > 0.5)
        ? lum(v) < 0.4
        : this._hass?.themes?.darkMode ?? window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
    if (this.classList.contains("light") === dark) this.classList.toggle("light", !dark);
  }

  _render() {
    if (!this._hass || !this.$(".tile")) return;
    this._theme();
    const c = this._config;
    const st = this._st(c.entity);
    const tile = this.$(".tile");
    const on = this._isOn();
    const dim = this._dimmable();
    const pct = this._brightness();
    const running = on ? this._running() : [];

    // the line under the name
    const sec = c.secondary || [];
    let sub;
    if (!st || st.state === "unavailable") sub = "Unavailable";
    else if (sec.includes("countdown") && running.length)
      // with more than one running, the one that ends first
      sub = `Off in ${clock(Math.min(...running.map((x) => x.left)))}`;
    else {
      const bits = [];
      if (sec.includes("state")) bits.push(on ? "On" : "Off");
      if (sec.includes("brightness") && on && dim && pct) bits.push(`${pct}%`);
      const se = this._st(c.secondary_entity);
      if (se && !NO_VALUE.includes(se.state)) bits.push(`${num(se.state) === "—" ? se.state : num(se.state)}${se.attributes.unit_of_measurement ? ` ${se.attributes.unit_of_measurement}` : ""}`);
      sub = bits.join(" · ");
    }
    this.$("ha-card").classList.toggle("on", on);
    tile.classList.toggle("on", on);
    if (!tile.classList.contains("dragging")) {
      tile.querySelector(".s").textContent = sub;
      tile.querySelector(".fill").style.width = `${on && dim && pct ? pct : 0}%`;
    }

    // the ring follows whichever countdown runs out first; the dim is a darker stretch at its end
    const soon = running.length ? running.reduce((a, b) => (b.left < a.left ? b : a)) : undefined;
    const ring = soon?.total ? soon.left / soon.total : 0;
    this.$(".ic .rg").style.strokeDashoffset = String(RING * (1 - clamp(ring, 0, 1)));
    const rd = this.$(".ic .rd");
    if (rd) {
      const frac = soon?.auto && soon.total ? this._dimSecs() / soon.total : 0;
      rd.style.strokeDashoffset = String(RING * (1 - clamp(Math.min(ring, frac), 0, 1)));
    }

    if (this._open) {
      this._renderAttrs(st, on);
      this._renderGroups(on);
    }
  }

  _renderAttrs(st, on) {
    const c = this._config;
    const a = st?.attributes || {};
    const modes = a.supported_color_modes || [];
    const show = (key, ok) => {
      const el = this.$(`[data-a="${key}"]`);
      if (el) el.closest(".part").hidden = !ok;
      return el && ok;
    };
    const dial = (key, d, ok) => {
      if (!show(key, ok)) return;
      const el = this.$(`[data-d="${d}"]`);
      if (el.classList.contains("dragging")) return;
      // colour reads Off while the light is on a white (colour temperature)
      this._showDial(el, d, this._dial(d).value, on && !(d === "hue" && a.color_mode === "color_temp"));
    };
    dial("brightness", "bri", this._dimmable());
    dial("color_temp", "ct", modes.includes("color_temp"));
    dial("color", "hue", modes.some((m) => ["hs", "rgb", "rgbw", "rgbww", "xy"].includes(m)));
    const list = a.effect_list || [];
    if (show("effect", list.length > 0)) {
      const box = this.$("[data-fx]");
      const key = list.join("|");
      if (box.dataset.key !== key) {
        box.dataset.key = key;
        box.innerHTML = list.map((o) => `<button class="chip" data-opt="${esc(o)}">${esc(o)}</button>`).join("");
      }
      const cur = this._hold("fx", a.effect, a.effect);
      box.querySelectorAll("[data-opt]").forEach((b) => b.classList.toggle("on", b.dataset.opt === cur));
      this.$('[data-av="effect"]').textContent = on && cur && cur !== "off" && cur !== "None" ? cur : "";
    }

    (c.attributes || []).forEach((x, j) => {
      if (attrKey(x) !== "entity") return;
      const es = this._st(x.entity);
      const v = this.$(`[data-ev="${j}"]`);
      if (v) {
        const u = es?.attributes.unit_of_measurement;
        v.textContent = !es || NO_VALUE.includes(es.state) ? "—" : `${num(es.state) === "—" ? (es.state === "on" ? "On" : es.state === "off" ? "Off" : es.state) : num(es.state)}${u ? ` ${u}` : ""}`;
      }
      const tog = this.$(`[data-etog="${x.entity}"]`);
      if (tog) {
        const ison = this._isOnId(x.entity);
        tog.classList.toggle("on", ison);
        tog.setAttribute("aria-checked", String(ison));
      }
      const inp = this.$(`[data-enum="${x.entity}"]`);
      if (inp && !this._focused(inp) && es) {
        inp.min = String(es.attributes.min ?? "");
        inp.max = String(es.attributes.max ?? "");
        inp.step = String(es.attributes.step ?? "any");
        const n = this._number(x.entity);
        inp.value = Number.isFinite(n) ? String(n) : "";
        this.$(`[data-eu="${j}"]`).textContent = es.attributes.unit_of_measurement || "";
      }
      const sel = this.$(`[data-esel="${x.entity}"]`);
      if (sel && es) {
        const opts = es.attributes.options || [];
        const key = opts.join("|");
        if (sel.dataset.key !== key) {
          sel.dataset.key = key;
          sel.style.setProperty("--cols", String(Math.min(opts.length, 4) || 1));
          sel.innerHTML = opts.map((o) => `<button class="chip" data-opt="${esc(o)}">${esc(o)}</button>`).join("");
        }
        const cur = this._hold(`sel:${x.entity}`, es.state, es.state);
        sel.querySelectorAll("[data-opt]").forEach((b) => b.classList.toggle("on", b.dataset.opt === cur));
      }
    });
  }

  _renderTin(key, disabled) {
    const box = this.$(`[data-tin="${key}"]`);
    if (!box) return;
    const secs = key === "dim" ? this._dimSecs() : this._secs(key);
    const mm = box.querySelector("[data-tm]");
    const ss = box.querySelector("[data-ts]");
    mm.disabled = disabled;
    // seconds only where the helper can hold them
    ss.disabled = disabled || this._grain(key) % 60 === 0;
    ss.title = this._grain(key) % 60 === 0 ? "This setting is in whole minutes" : "";
    if (this._focused(box) || secs === undefined) return;
    mm.value = String(Math.floor(secs / 60)).padStart(2, "0");
    ss.value = String(secs % 60).padStart(2, "0");
  }

  _renderGroups(on) {
    const c = this._config;
    const setSw = (g, id, disabled) => {
      const b = this.$(`[data-gsw="${g}"]`);
      if (!b) return;
      const v = this._isOnId(id);
      b.classList.toggle("on", v);
      b.setAttribute("aria-checked", String(v));
      b.disabled = Boolean(disabled);
    };
    const val = (g, text) => {
      const el = this.$(`[data-gv="${g}"]`);
      if (el) el.textContent = text;
    };

    // Motion: no section of its own; its switch (if any) still greys Motion control while off
    const motionOn = !c.motion?.enabled || this._isOnId(c.motion.enabled);

    // Motion control
    const x = c.auto_off;
    if (x) {
      const autoOn = !x.enabled || this._isOnId(x.enabled);
      const live = autoOn && motionOn;
      setSw("auto", x.enabled, !motionOn);
      const g = this.$('[data-g="auto"]');
      g?.classList.toggle("off", !live);
      g?.classList.toggle("blocked", !motionOn);
      const left = on ? secsLeft(this._st(x.timer)) : undefined;
      // the room first ("Occupied", "Empty · 3mins ago"), then the countdown while it runs
      const p = this._st(c.motion?.presence);
      const room = !p || NO_VALUE.includes(p.state) ? "" : p.state === "on" ? "Occupied" : "Empty";
      const status = !motionOn ? "Motion off" : live && left !== undefined ? `Off in ${clock(left)}` : room === "Empty" ? ago(p.last_changed) : "";
      val("auto", [room, status].filter(Boolean).join(" · "));
      this._renderTin("auto", !live);
      this._renderTin("dim", !live);
      const dim = this._hasDim() ? [", and will dim ", 1, " mins before turning off."] : ["."];
      this._sentence(
        "auto",
        x.switch_only
          ? [live ? "It goes off once the room has been empty for " : "Motion control is off. When on, it goes off once the room has been empty for ", 0, " mins", ...dim]
          : [live ? "Motion detected turns the light on, it goes off after " : "Motion is ignored. When on, it goes off after ", 0, " mins", ...dim]
      );
    }
    // Motion control on: presence turns the light on (Light level decides when)
    const motionCtl = Boolean(x) && motionOn && (!x.enabled || this._isOnId(x.enabled));

    // Light level
    const y = c.light_level;
    if (y) {
      const lvlOn = !y.enabled || this._isOnId(y.enabled);
      setSw("level", y.enabled);
      this.$('[data-g="level"]')?.classList.toggle("off", !lvlOn);
      const lux = this._st(y.illuminance);
      const below = this._number(y.dark_below);
      const darkSt = this._st(y.dark);
      const isDark = darkSt && !NO_VALUE.includes(darkSt.state) ? darkSt.state === "on" : Number(lux?.state) < below;
      const left = on && lvlOn ? secsLeft(this._st(y.timer)) : undefined;
      // the light level now, on or off ("Dark · 0.8 lx"; "avg" when it's several sensors' average)
      const avg = (lux?.attributes.sources || []).length > 1 ? "avg " : "";
      const reading = lux && !NO_VALUE.includes(lux.state) ? `${isDark ? "Dark" : "Light"} · ${avg}${num(lux.state)}${lux.attributes.unit_of_measurement ? ` ${lux.attributes.unit_of_measurement}` : ""}` : "";
      val("level", [reading, left !== undefined ? `Off in ${clock(left)}` : ""].filter(Boolean).join(" · "));
      const ro = Boolean(this.$("[data-ro]"));
      this._sentence(
        "level",
        this._levelTokens(lvlOn, motionCtl, {
          above: ro || Boolean(this.$('[data-lvl="above"]')),
          after: Boolean(this.$('[data-tin="after"]')),
        })
      );
      // a threshold helper as the dark sensor: dark below lower - hysteresis, light above lower + hysteresis
      if (ro) {
        const da = darkSt?.attributes || {};
        const ok = da.type === "lower" && Number.isFinite(Number(da.lower));
        if (ok) {
          const h = Number(da.hysteresis) || 0;
          const unit = this._st(da.illuminance || da.entity_id)?.attributes.unit_of_measurement || lux?.attributes.unit_of_measurement || "lx";
          this.$('[data-ro="0"]').value = String(num(Number(da.lower) - h));
          this.$('[data-ro="1"]').value = String(num(Number(da.lower) + h));
          this.$$("[data-ro]").forEach((i) => (i.nextElementSibling.textContent = unit));
          const src = this._st(da.source || y.dark);
          this.$("[data-roh]").textContent = `Set in ${src?.attributes.friendly_name || da.source || y.dark}, shared with other rooms.`;
        }
      }
      this.$$("[data-lvl]").forEach((inp) => {
        const k = inp.dataset.lvl;
        const ls = this._st(this._lvlId(k));
        inp.disabled = !lvlOn;
        inp.nextElementSibling.textContent = ls?.attributes.unit_of_measurement || "lx";
        if (!ls || this._focused(inp)) return;
        const { lo, hi, step } = this._lvlRange(k);
        inp.min = String(lo);
        inp.max = String(hi);
        inp.step = String(step);
        const v = this._number(this._lvlId(k));
        inp.value = Number.isFinite(v) ? String(v) : "";
      });
      this._renderTin("after", !lvlOn);
    }
  }
}

// ---- editor -------------------------------------------------------------------------------
/*
 * Device, then the main card (name, icon, colour, the line under the name), then the rows
 * in the panel (add / remove / reorder), then Motion control and Light level, each added
 * or removed with its Include switch. Built from HA's own ha-form.
 */
const EDITOR_CSS = `
  .sec { margin-top: 20px; }
  .sec:first-child { margin-top: 0; }
  .sec[hidden] { display: none; }
  .sec > h3 { margin: 0 0 8px; font-size: 15px; font-weight: 500; }
  .sec > p { margin: -4px 0 10px; font-size: 12px; color: var(--secondary-text-color); }
  .attr { display: flex; align-items: flex-start; gap: 6px; padding: 8px; margin-bottom: 8px; border: 1px solid var(--divider-color); border-radius: 12px; }
  .attr ha-form { flex: 1; min-width: 0; }
  .ib {
    flex: none; width: 34px; height: 34px; border-radius: 17px; border: none; background: none; cursor: pointer; padding: 0;
    color: var(--secondary-text-color); display: flex; align-items: center; justify-content: center; --mdc-icon-size: 20px; margin-top: 10px;
  }
  .ib[disabled] { opacity: 0.3; cursor: default; }
  .add { display: flex; flex-wrap: wrap; gap: 6px; }
  .add button, .grp-h button {
    height: 32px; padding: 0 12px; border-radius: 16px; cursor: pointer; font: inherit; font-size: 13px;
    border: 1px solid var(--divider-color); background: none; color: var(--primary-color);
  }
  .add .dev { color: var(--primary-text-color); }
  .grp { border: 1px solid var(--divider-color); border-radius: 12px; padding: 10px 12px; margin-bottom: 10px; }
  .grp-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .grp-h b { font-weight: 500; }
  .grp-h span { font-size: 12px; color: var(--secondary-text-color); display: block; font-weight: 400; }
  .grp ha-form { display: block; margin-top: 10px; }
`;
const ATTR_OPTIONS = [
  { value: "brightness", label: "Brightness" },
  { value: "color_temp", label: "Colour temperature" },
  { value: "color", label: "Colour" },
  { value: "effect", label: "Effect" },
];
// the panel rows a light can use, from what it supports
const supportedAttrs = (st) => {
  const a = st?.attributes || {};
  const modes = a.supported_color_modes || [];
  const ok = {
    brightness: modes.some((m) => m !== "onoff"),
    color_temp: modes.includes("color_temp"),
    color: modes.some((m) => ["hs", "rgb", "rgbw", "rgbww", "xy"].includes(m)),
    effect: (a.effect_list || []).length > 0,
  };
  return ATTR_OPTIONS.filter((o) => ok[o.value]);
};
const LABELS = {
  name: "Title",
  icon: "Icon",
  primary: "Primary colour",
  collapse_others: "Close other light cards when this one opens",
  use_primary: "Use the primary colour (instead of the light's colours)",
  secondary: "Shows",
  secondary_entity: "Also show this entity's state",
  type: "Row",
  enabled: "On / Off switch (input_boolean)",
  presence: "Presence / occupancy sensor",
  duration: "Motion timeout (input_number, s or min)",
  timer: "Countdown timer",
  dim: "Dim before off (input_number, s or %)",
  dark_below: "Dark below (input_number, lx)",
  light_above: "Light above (input_number, lx)",
  illuminance: "Light level sensor",
  dark: "Dark sensor (optional)",
  off_after: "Off when light after (input_number, s or min)",
  hint: "Hint",
  hidden: "Hide this section on the card once you've settled on the settings you want (its settings keep working after)",
  device: "Knit device",
  entity: "Or a light without Knit",
};
const HIDE = { name: "hidden", selector: { boolean: {} } };
const GROUPS = [
  {
    key: "motion",
    title: "Presence",
    desc: "The room's presence sensor, shown in Motion control (Occupied, Empty · 3mins ago).",
    schema: [
      { name: "presence", selector: { entity: { domain: "binary_sensor" } } },
      { name: "enabled", selector: { entity: { domain: "input_boolean" } } },
    ],
  },
  {
    key: "auto_off",
    title: "Motion control",
    desc: "Off after the room has been empty for a while, dimming first.",
    schema: [
      HIDE,
      { name: "enabled", selector: { entity: { domain: "input_boolean" } } },
      { name: "duration", selector: { entity: { domain: ["input_number", "number"] } } },
      { name: "timer", selector: { entity: { domain: "timer" } } },
      { name: "dim", selector: { entity: { domain: ["input_number", "number"] } } },
      { name: "hint", selector: { text: {} } },
    ],
  },
  {
    key: "light_level",
    title: "Light level",
    desc: "Only on when dark, and off once it has been light for a while.",
    schema: [
      HIDE,
      { name: "enabled", selector: { entity: { domain: "input_boolean" } } },
      { name: "illuminance", selector: { entity: { domain: "sensor" } } },
      { name: "dark_below", selector: { entity: { domain: ["input_number", "number"] } } },
      { name: "light_above", selector: { entity: { domain: ["input_number", "number"] } } },
      { name: "dark", selector: { entity: { domain: "binary_sensor" } } },
      { name: "off_after", selector: { entity: { domain: ["input_number", "number"] } } },
      { name: "timer", selector: { entity: { domain: "timer" } } },
      { name: "hint", selector: { text: {} } },
    ],
  },
];

class SmartLightCardEditor extends HTMLElement {
  setConfig(config) {
    // HA hands back each change we send: don't redraw for those, or fields lose focus
    const ours = this._sent && JSON.stringify(config) === JSON.stringify(this._sent);
    this._config = { ...config };
    if (!ours) this._build();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._ready) {
      this._ready = true;
      this._loadForm();
    }
    this.shadowRoot?.querySelectorAll("ha-form").forEach((f) => (f.hass = hass));
  }

  // ha-form is loaded with HA's own card editors; make sure it's there
  async _loadForm() {
    if (!customElements.get("ha-form")) {
      try {
        const helpers = await window.loadCardHelpers?.();
        const el = helpers?.createCardElement({ type: "entities", entities: [] });
        await el?.constructor?.getConfigElement?.();
      } catch (e) {
        // the form still appears once HA has loaded it
      }
    }
    this._build();
  }

  _changed(config) {
    this._config = config;
    this._sent = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }

  _form(schema, data, onChange) {
    const f = document.createElement("ha-form");
    f.hass = this._hass;
    f.schema = schema;
    f.data = data;
    f.computeLabel = (s) => LABELS[s.name] || s.name;
    f.addEventListener("value-changed", (e) => {
      e.stopPropagation();
      onChange(e.detail.value);
    });
    return f;
  }

  _build() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const c = this._config;
    const root = this.shadowRoot;
    root.innerHTML = `<style>${EDITOR_CSS}</style>
      <div class="sec" data-s="device"><h3>Knit device</h3><p>The light set up in the Knit integration. Its switches, settings and countdowns come with it. A light without Knit works too, but then you point the card at your own helpers below.</p></div>
      <div class="sec" data-s="main"><h3>Main card</h3><p>The tile: its title, icon and colour (every other shade is worked out from it).</p></div>
      <div class="sec" data-s="secondary"><h3>Secondary information</h3><p>The line under the title on the tile: what it shows, joined with a dot ("On · 35%"). A countdown, while one runs, replaces the rest ("Off in 4:12").</p></div>
      <div class="sec" data-s="attrs"><h3>Expanded panel</h3><p>The rows under the tile when it's opened, in order.</p><div data-list></div><div class="add" data-add></div></div>
      <div class="sec" data-s="groups"><h3>More controls</h3><p>Each needs helpers for the card to set, and automations in Home Assistant to act on them.</p></div>`;

    // the Knit device (or a plain light)
    const pick = [
      { name: "device", selector: { device: { integration: "knit" } } },
      { name: "entity", selector: { entity: { domain: ["light", "switch"] } } },
    ];
    const devData = { device: c.device || deviceOfLight(this._hass, c.entity), entity: c.device ? undefined : c.entity };
    root.querySelector('[data-s="device"]').appendChild(
      this._form(pick, devData, (v) => {
        const next = { ...this._config };
        if ((v.device || undefined) !== (devData.device || undefined)) {
          // a Knit device picked (its light comes with it), or cleared (and its light with it)
          delete next.device;
          delete next.entity;
          if (v.device) {
            next.device = v.device;
            next.entity = lightOfDevice(this._hass, v.device);
          }
        } else if ((v.entity || undefined) !== (devData.entity || undefined)) {
          delete next.device;
          delete next.entity;
          if (v.entity) next.entity = v.entity;
        } else return;
        // keep only the panel rows the new light can use
        if (next.entity && next.entity !== this._config.entity) next.attributes = this._fitAttrs(next.entity);
        this._changed(next);
        this._build();
      })
    );

    // main card
    const main = [
      {
        type: "grid",
        name: "",
        schema: [
          { name: "name", selector: { text: {} } },
          { name: "icon", selector: { icon: {} } },
        ],
      },
      { name: "primary", selector: { color_rgb: {} } },
      { name: "collapse_others", selector: { boolean: {} } },
    ];
    const secondary = [
      {
        name: "secondary",
        selector: {
          select: {
            multiple: true,
            options: [
              { value: "state", label: "On / Off" },
              { value: "brightness", label: "Brightness" },
              { value: "countdown", label: "Countdown (replaces the rest while it runs)" },
            ],
          },
        },
      },
      { name: "secondary_entity", selector: { entity: {} } },
    ];
    const secData = { secondary: ["state", "brightness", "countdown"], ...c };
    root.querySelector('[data-s="secondary"]').appendChild(
      this._form(secondary, secData, (v) => {
        const next = { ...this._config, ...v };
        Object.keys(next).forEach((k) => (next[k] === "" || next[k] === undefined) && delete next[k]);
        this._changed(next);
      })
    );
    // the colour shown is the primary, or the main shade of the named colour
    const data = { secondary: ["state", "brightness", "countdown"], ...c, primary: colorsOf(c).main, collapse_others: c.collapse_others !== false };
    root.querySelector('[data-s="main"]').appendChild(
      this._form(main, data, (v) => {
        const next = { ...this._config, ...v };
        // a picked primary replaces a named colour
        if (v.primary && JSON.stringify(v.primary) !== JSON.stringify(colorsOf(this._config).main)) {
          delete next.color;
          delete next.colors;
        } else if (!this._config.primary) delete next.primary;
        // on is the default: only false is saved
        if (v.collapse_others) delete next.collapse_others;
        else next.collapse_others = false;
        Object.keys(next).forEach((k) => (next[k] === "" || next[k] === undefined) && delete next[k]);
        this._changed(next);
      })
    );

    this._buildAttrs();
    this._buildGroups();
  }

  // the panel rows kept when the light changes: the ones it supports (else its first two)
  _fitAttrs(light) {
    const ok = supportedAttrs(this._hass?.states[light]).map((o) => o.value);
    const kept = (this._config.attributes || []).filter((a) => attrKey(a) === "entity" || ok.includes(attrKey(a)));
    return kept.length ? kept : ok.filter((k) => k === "brightness" || k === "color_temp");
  }

  _buildAttrs() {
    const root = this.shadowRoot;
    // nothing for this light to show in the panel: no section
    const supported = supportedAttrs(this._hass?.states[this._config.entity]);
    const entityRows = (this._config.attributes || []).some((a) => attrKey(a) === "entity");
    root.querySelector('[data-s="attrs"]').hidden = !supported.length && !entityRows;
    const list = root.querySelector("[data-list]");
    const attrs = [...(this._config.attributes || [])];
    const save = (next) => {
      this._changed({ ...this._config, attributes: next });
      this._buildAttrs();
    };
    list.innerHTML = "";
    attrs.forEach((a, j) => {
      const row = document.createElement("div");
      row.className = "attr";
      const type = attrKey(a) || "brightness";
      const opts = supportedAttrs(this._hass?.states[this._config.entity]);
      if (type !== "entity" && !opts.some((o) => o.value === type)) {
        const o = ATTR_OPTIONS.find((x) => x.value === type);
        if (o) opts.push({ value: type, label: `${o.label} (not supported by this light)` });
      }
      const schema = type === "entity" ? [{ name: "entity", selector: { entity: {} } }] : [{ name: "type", selector: { select: { mode: "dropdown", options: opts } } }];
      if (type === "color_temp" || type === "color") schema.push({ name: "use_primary", selector: { boolean: {} } });
      schema.push({
        type: "grid",
        name: "",
        schema: [
          { name: "name", selector: { text: {} } },
          { name: "icon", selector: { icon: {} } },
        ],
      });
      const data = typeof a === "string" ? { type: a } : { type, ...a };
      row.appendChild(
        this._form(schema, data, (v) => {
          const next = [...(this._config.attributes || [])];
          const extra = {};
          if (v.name) extra.name = v.name;
          if (v.icon) extra.icon = v.icon;
          if (v.use_primary && (v.type === "color_temp" || v.type === "color")) extra.use_primary = true;
          next[j] = type === "entity" ? { entity: v.entity || "", ...extra } : Object.keys(extra).length ? { type: v.type, ...extra } : v.type;
          this._changed({ ...this._config, attributes: next });
          if (v.type !== type) this._buildAttrs();
        })
      );
      const btn = (icon, label, disabled, fn) => {
        const b = document.createElement("button");
        b.className = "ib";
        b.title = label;
        b.disabled = disabled;
        b.innerHTML = `<ha-icon icon="${icon}"></ha-icon>`;
        b.addEventListener("click", fn);
        row.appendChild(b);
      };
      btn("mdi:arrow-up", "Move up", j === 0, () => {
        const next = [...attrs];
        [next[j - 1], next[j]] = [next[j], next[j - 1]];
        save(next);
      });
      btn("mdi:arrow-down", "Move down", j === attrs.length - 1, () => {
        const next = [...attrs];
        [next[j + 1], next[j]] = [next[j], next[j + 1]];
        save(next);
      });
      btn("mdi:close", "Remove", false, () => save(attrs.filter((_, k) => k !== j)));
      list.appendChild(row);
    });

    // add: the light's own controls, then the other entities of the same device
    const add = root.querySelector("[data-add]");
    add.innerHTML = "";
    const addBtn = (label, value, cls) => {
      const b = document.createElement("button");
      b.textContent = `+ ${label}`;
      if (cls) b.className = cls;
      b.addEventListener("click", () => save([...(this._config.attributes || []), value]));
      add.appendChild(b);
    };
    supportedAttrs(this._hass?.states[this._config.entity]).forEach((o) => {
      if (!attrs.some((a) => attrKey(a) === o.value)) addBtn(o.label, o.value);
    });
    const ent = this._hass?.entities?.[this._config.entity];
    if (ent?.device_id) {
      Object.values(this._hass.entities)
        .filter((e) => e.device_id === ent.device_id && e.entity_id !== this._config.entity && !e.hidden && !e.entity_category)
        .filter((e) => !attrs.some((a) => a?.entity === e.entity_id))
        .forEach((e) => addBtn(this._hass.states[e.entity_id]?.attributes.friendly_name || e.entity_id, { entity: e.entity_id }, "dev"));
    }
  }

  _buildGroups() {
    const box = this.shadowRoot.querySelector('[data-s="groups"]');
    const f = found(this._hass, this._config.entity);
    if (Object.keys(f).length) {
      box.querySelector("p").textContent = "Set up by Knit: its switches and settings appear here by themselves. Hide a section to keep it off the card (it keeps working).";
      [
        ["auto_off", "Motion control", f.motion || f.auto_off],
        ["light_level", "Light level", f.light_level],
      ].forEach(([key, title, has]) => {
        if (!has) return;
        const el = document.createElement("div");
        el.className = "grp";
        el.innerHTML = `<div class="grp-h"><b>${title}</b></div>`;
        const cur = this._config[key] || {};
        el.appendChild(
          this._form([HIDE], { hidden: Boolean(cur.hidden) }, (v) => {
            const next = { ...this._config };
            if (v.hidden) next[key] = { ...cur, hidden: true };
            else {
              const rest = { ...cur };
              delete rest.hidden;
              if (Object.keys(rest).length) next[key] = rest;
              else delete next[key];
            }
            this._changed(next);
          })
        );
        box.appendChild(el);
      });
      return;
    }
    GROUPS.forEach((g) => {
      const el = document.createElement("div");
      el.className = "grp";
      const included = Boolean(this._config[g.key]);
      el.innerHTML = `<div class="grp-h"><b>${g.title}<span>${g.desc}</span></b><button>${included ? "Remove" : "Add"}</button></div>`;
      el.querySelector("button").addEventListener("click", () => {
        const next = { ...this._config };
        if (included) delete next[g.key];
        else next[g.key] = {};
        this._changed(next);
        this._build();
      });
      if (included)
        el.appendChild(
          this._form(g.schema, this._config[g.key], (v) => {
            const val = { ...v };
            Object.keys(val).forEach((k) => (val[k] === "" || val[k] === undefined || (k === "hidden" && !val[k])) && delete val[k]);
            this._changed({ ...this._config, [g.key]: val });
          })
        );
      box.appendChild(el);
    });
  }
}

// ---- knit-section ---------------------------------------------------------------
/*
 * A collapsible section header, as the Home page's "Lights  Click to expand". Put it at the
 * top of a section in a sections view: its title folds away the cards below it in that
 * section (up to the next section card), which sit in the section's grid as you like. While
 * the dashboard is being edited they all show.
 *
 *   type: custom:knit-section
 *   title: Lights
 *   subtitle: Click to expand            # shown while collapsed (default "Click to expand")
 *   subtitle_entity: sensor.x            # or: that entity's state instead, shown all the time
 *   collapsed_by_default: false          # true: starts collapsed on every load (not remembered);
 *                                        # otherwise it opens as it was last left
 *   expand_on:                           # optional: expands itself while this is true, then folds back
 *     entity: binary_sensor.x            # in this state (state, default on), or, for a time
 *     state: "on"                        # (input_datetime / timestamp sensor): for minutes after it
 *     minutes: 10                        # how long it stays expanded (after the state ends, or after
 *     minutes_entity: input_number.x     # the time); minutes_entity, if set, gives the minutes
 *   button:
 *     entity: light.x                    # one or more entities (a list), any domain
 *     name: All off
 *     icon: mdi:power
 *     action: turn_off                   # toggle | turn_on | turn_off (lights, switches, ...);
 *                                        # automations run, scripts / scenes start, buttons press
 *     show: when_on                      # always | when_on (while any of them is on)
 *   color: sand                          # or primary: [r, g, b]
 */
const SECTION_CSS = (c) => `
  :host { ${shades(c, true)} display: block; }
  :host(.light) { ${shades(c, false)} }
  .sh { display: flex; align-items: center; gap: 8px; margin: 0 4px; min-height: 30px; }
  .st {
    display: flex; align-items: center; gap: 2px; background: none; border: none; padding: 0; cursor: pointer; min-width: 0;
    font: inherit; font-size: 16px; font-weight: 600; color: var(--primary-text-color); --mdc-icon-size: 22px; text-align: left;
  }
  .st .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .st .chev { flex: none; color: var(--secondary-text-color); transition: transform 0.2s; }
  :host(.collapsed) .st .chev { transform: rotate(-90deg); }
  .st .ch { margin-left: 6px; font-size: 12px; font-weight: 400; color: var(--secondary-text-color); white-space: nowrap; }
  .st .ch.when-collapsed { display: none; }
  :host(.collapsed) .st .ch.when-collapsed { display: inline; }
  .sx { flex: 1; display: flex; justify-content: flex-end; }
  .pill {
    height: 28px; box-sizing: border-box; padding: 0 10px; border-radius: 14px; display: inline-flex; align-items: center; gap: 6px; flex: none;
    font: inherit; font-size: 12px; font-weight: 600; white-space: nowrap; --mdc-icon-size: 16px; cursor: pointer;
    background: var(--tint); color: var(--prime); border: 1px solid var(--soft);
  }
  .pill[hidden] { display: none; }
`;
const ON_STATES = ["on", "open", "playing", "home", "heat", "cool", "cleaning"];
// a state that's a time (input_datetime with a date, or a timestamp sensor)
const timeOf = (st) => {
  if (!st) return undefined;
  if (st.attributes.timestamp != null) return new Date(st.attributes.timestamp * 1000);
  if (st.attributes.device_class === "timestamp" || /^\d{4}-\d\d-\d\d[ T]/.test(st.state)) {
    const t = new Date(st.state);
    return Number.isNaN(t.getTime()) ? undefined : t;
  }
  return undefined;
};

class SmartLightSection extends HTMLElement {
  static getConfigElement() {
    return document.createElement("knit-section-editor");
  }

  static getStubConfig() {
    return { title: "Lights", subtitle: "Click to expand" };
  }

  setConfig(config) {
    this._config = { subtitle: "Click to expand", ...config };
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const c = this._config;
    const b = c.button;
    this.shadowRoot.innerHTML = `<style>${SECTION_CSS(colorsOf(c))}</style>
      <div class="sh">
        <button class="st" aria-expanded="true"><span class="t">${esc(c.title || "")}</span><ha-icon class="chev" icon="mdi:chevron-down"></ha-icon><span class="ch${
          c.subtitle_entity ? "" : " when-collapsed"
        }"></span></button>
        <span class="sx">${
          b?.entity ? `<button class="pill" hidden><ha-icon icon="${esc(b.icon || "mdi:power")}"></ha-icon>${esc(b.name || "")}</button>` : ""
        }</span>
      </div>`;
    this.$(".st").addEventListener("click", () => this._collapse(!this.classList.contains("collapsed"), true));
    this.$(".pill")?.addEventListener("click", () => this._press());
    // collapsed by default or opened by a trigger: the card decides, so it isn't remembered
    this._remember = !c.collapsed_by_default && !c.expand_on?.entity;
    this._triggered = undefined;
    this._collapse(this._remember ? this._remembered() === "closed" : Boolean(c.collapsed_by_default), false);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 1;
  }

  getGridOptions() {
    return { columns: "full", rows: "auto" };
  }

  $(sel) {
    return this.shadowRoot.querySelector(sel);
  }

  _key() {
    return `knit-section:${this._config.title || ""}`;
  }

  _remembered() {
    try {
      return localStorage.getItem(this._key());
    } catch (e) {
      return null;
    }
  }

  _collapse(collapsed, byHand) {
    this.classList.toggle("collapsed", collapsed);
    this.$(".st").setAttribute("aria-expanded", String(!collapsed));
    if (byHand && this._remember) {
      try {
        localStorage.setItem(this._key(), collapsed ? "closed" : "open");
      } catch (e) {
        // storage blocked: not remembered
      }
    }
    this._fold();
  }

  // the cards below this one in its section (each card's wrapper in the section's grid), or
  // undefined when it isn't in a sections-view section; { edit: true } while it's being edited
  _below() {
    const at = gridCell(this);
    if (!at || at.edit) return at;
    const out = [];
    for (let el = at.cell.nextElementSibling; el; el = el.nextElementSibling) {
      if (el.querySelector("knit-section")) break; // the next section card starts its own
      out.push(el);
    }
    return { cards: out };
  }

  _fold() {
    const below = this._below();
    const show = (el) => el.style.removeProperty("display");
    if (!below || below.edit) {
      (this._folded || []).forEach(show);
      this._folded = [];
      return;
    }
    const collapsed = this.classList.contains("collapsed");
    (this._folded || []).filter((el) => !below.cards.includes(el)).forEach(show);
    below.cards.forEach((el) => (collapsed ? el.style.setProperty("display", "none", "important") : show(el)));
    this._folded = collapsed ? below.cards : [];
  }

  connectedCallback() {
    // the section draws its cards after this one: fold them once they're there
    requestAnimationFrame(() => this._fold());
    setTimeout(() => this._fold(), 500);
    // a trigger with minutes runs out by itself: check now and then
    this._tick = setInterval(() => this._hass && this._trigger(), 15000);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
    (this._folded || []).forEach((el) => el.style.removeProperty("display"));
    this._folded = [];
  }

  // expand_on: is it triggered now?
  _isTriggered() {
    const t = this._config.expand_on;
    const st = t?.entity && this._hass.states[t.entity];
    if (!st) return false;
    const m = Number(t.minutes_entity ? this._hass.states[t.minutes_entity]?.state : t.minutes);
    const mins = Number.isFinite(m) ? m : 0;
    // a time: for the minutes after it
    const at = timeOf(st);
    if (at) return mins > 0 && Date.now() - at.getTime() < mins * 60000 && Date.now() >= at.getTime();
    // a state: while it's in it, and the minutes after it leaves it
    if (st.state === String(t.state ?? "on")) {
      this._matchedAt = Date.now();
      return true;
    }
    return Boolean(this._matchedAt) && Date.now() - this._matchedAt < mins * 60000;
  }

  // expand when triggered, fold back (to how it starts) when it ends
  _trigger() {
    if (!this._config.expand_on?.entity) return;
    const on = this._isTriggered();
    if (on === this._triggered) return;
    const first = this._triggered === undefined;
    this._triggered = on;
    if (on) this._collapse(false, false);
    else if (!first) this._collapse(Boolean(this._config.collapsed_by_default), false);
  }

  _ids() {
    const e = this._config.button?.entity;
    return Array.isArray(e) ? e : e ? [e] : [];
  }

  _render() {
    if (!this._hass || !this._config) return;
    const c = this._config;
    // light-theme shades when HA is in light mode
    this.classList.toggle("light", this._hass.themes?.darkMode === false);
    this._trigger();
    this._fold();
    const ch = this.$(".ch");
    if (c.subtitle_entity) {
      const st = this._hass.states[c.subtitle_entity];
      const u = st?.attributes.unit_of_measurement;
      ch.textContent = st ? `${st.state}${u ? ` ${u}` : ""}` : "";
    } else ch.textContent = c.subtitle || "";
    const pill = this.$(".pill");
    if (pill) {
      const anyOn = this._ids().some((id) => ON_STATES.includes(this._hass.states[id]?.state));
      pill.hidden = c.button.show === "when_on" && !anyOn;
    }
  }

  // run the button: by domain (automations run, scripts / scenes start, buttons press), else the action
  _press() {
    const byDomain = {};
    this._ids().forEach((id) => (byDomain[id.split(".")[0]] ||= []).push(id));
    const action = this._config.button.action || "toggle";
    for (const [domain, entity_id] of Object.entries(byDomain)) {
      const [svcDomain, service] =
        domain === "automation" ? ["automation", "trigger"]
        : domain === "script" || domain === "scene" ? [domain, "turn_on"]
        : domain === "button" || domain === "input_button" ? [domain, "press"]
        : ["homeassistant", action];
      this._hass.callService(svcDomain, service, { entity_id });
    }
  }
}

class SmartLightSectionEditor extends HTMLElement {
  setConfig(config) {
    const ours = this._sent && JSON.stringify(config) === JSON.stringify(this._sent);
    this._config = { ...config };
    if (!ours) this._build();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._ready) {
      this._ready = true;
      this._build();
    }
    this.shadowRoot?.querySelectorAll("ha-form").forEach((f) => (f.hass = hass));
  }

  _changed(config) {
    this._config = config;
    this._sent = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }

  _build() {
    if (!this._config || !this._hass) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const c = this._config;
    this.shadowRoot.innerHTML = `<style>${EDITOR_CSS}</style>
      <div class="sec" data-s="head"><h3>Header</h3><p>Put this card at the top of a section: its title folds away the cards below it in the section (up to the next section card). The subtitle shows while it's folded away, unless it's an entity's state, which shows all the time.</p></div>
      <div class="sec" data-s="open"><h3>Opening</h3><p>How it starts, and whether something can open it by itself.</p></div>
      <div class="sec" data-s="button"><h3>Button</h3><p>A pill on the right. Automations run, scripts and scenes start, buttons press; anything else does the action.</p></div>`;
    const labels = {
      title: "Title",
      subtitle: "Subtitle",
      subtitle_entity: "Or an entity's state as the subtitle",
      collapsed_by_default: "Collapsed by default",
      expand: "Expand on trigger",
      t_entity: "Trigger entity",
      t_state: "While it's in this state (not for a time entity)",
      t_minutes: "Stay expanded for (minutes)",
      t_minutes_entity: "Or take the minutes from",
      entity: "Entities",
      name: "Label",
      icon: "Icon",
      action: "Action",
      show: "Show",
    };
    const form = (schema, data, onChange) => {
      const f = document.createElement("ha-form");
      f.hass = this._hass;
      f.schema = schema;
      f.data = data;
      f.computeLabel = (x) => labels[x.name] || x.name;
      f.addEventListener("value-changed", (e) => {
        e.stopPropagation();
        onChange(e.detail.value);
      });
      return f;
    };
    const clean = (o) => {
      Object.keys(o).forEach((k) => (o[k] === "" || o[k] === undefined || o[k] === null || (Array.isArray(o[k]) && !o[k].length)) && delete o[k]);
      return o;
    };
    this.shadowRoot.querySelector('[data-s="head"]').appendChild(
      form(
        [
          { name: "title", selector: { text: {} } },
          { name: "subtitle", selector: { text: {} } },
          { name: "subtitle_entity", selector: { entity: {} } },
        ],
        c,
        (v) => this._changed(clean({ ...this._config, ...v }))
      )
    );

    // opening: collapsed by default, expand on trigger (and the trigger)
    const t = c.expand_on || {};
    const triggerOn = Boolean(c.expand_on);
    const openSchema = [
      { name: "collapsed_by_default", selector: { boolean: {} } },
      { name: "expand", selector: { boolean: {} } },
    ];
    if (triggerOn)
      openSchema.push(
        { name: "t_entity", selector: { entity: {} } },
        { name: "t_state", selector: { text: {} } },
        {
          type: "grid",
          name: "",
          schema: [
            { name: "t_minutes", selector: { number: { min: 0, max: 1440, step: 1, mode: "box", unit_of_measurement: "min" } } },
            { name: "t_minutes_entity", selector: { entity: { domain: ["input_number", "number"] } } },
          ],
        }
      );
    this.shadowRoot.querySelector('[data-s="open"]').appendChild(
      form(
        openSchema,
        {
          collapsed_by_default: Boolean(c.collapsed_by_default),
          expand: triggerOn,
          t_entity: t.entity,
          t_state: t.state ?? "on",
          t_minutes: t.minutes,
          t_minutes_entity: t.minutes_entity,
        },
        (v) => {
          const next = { ...this._config };
          if (v.collapsed_by_default) next.collapsed_by_default = true;
          else delete next.collapsed_by_default;
          if (v.expand) {
            const trig = clean({ entity: v.t_entity, state: v.t_state, minutes: v.t_minutes, minutes_entity: v.t_minutes_entity });
            if (trig.state === "on") delete trig.state;
            next.expand_on = trig;
          } else delete next.expand_on;
          this._changed(next);
          if (Boolean(v.expand) !== triggerOn) this._build();
        }
      )
    );

    const b = c.button || {};
    this.shadowRoot.querySelector('[data-s="button"]').appendChild(
      form(
        [
          { name: "entity", selector: { entity: { multiple: true } } },
          { type: "grid", name: "", schema: [{ name: "name", selector: { text: {} } }, { name: "icon", selector: { icon: {} } }] },
          {
            type: "grid",
            name: "",
            schema: [
              { name: "action", selector: { select: { mode: "dropdown", options: [{ value: "toggle", label: "Toggle" }, { value: "turn_on", label: "Turn on" }, { value: "turn_off", label: "Turn off" }] } } },
              { name: "show", selector: { select: { mode: "dropdown", options: [{ value: "always", label: "Always" }, { value: "when_on", label: "While any is on" }] } } },
            ],
          },
        ],
        { action: "toggle", show: "always", ...b, entity: Array.isArray(b.entity) ? b.entity : b.entity ? [b.entity] : [] },
        (v) => {
          const btn = clean({ ...v });
          const next = { ...this._config };
          if (btn.entity) next.button = btn;
          else delete next.button;
          this._changed(next);
        }
      )
    );
  }
}

// ---- knit-appliance-card -----------------------------------------------------------------
/*
 * A Knit appliance (a dishwasher, a washing machine) as a tile: its status and the cycle's
 * countdown ("Running · 0:45 left"), filling as the cycle goes and pulsing while it's Full.
 * Opening it shows buttons to correct the status, its power and door, and under More controls
 * how it tells running / finished / emptied, as one sentence with the values in place.
 *
 *   type: custom:knit-appliance-card
 *   device: <the Knit appliance>          # or entity: select.knit_washing_machine_status (any of its entities)
 *   name: Washing machine                # optional: else the device's name
 *   icon: mdi:washing-machine
 *   color: blue                          # or primary: [r, g, b]
 */
const APPLIANCE_ICONS = { empty: "mdi:checkbox-blank-circle-outline", running: "mdi:play-circle-outline", full: "mdi:check-circle-outline" };
const APPLIANCE_CSS = `
  .tile.full .face { animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 50% { box-shadow: inset 0 0 0 2px var(--soft); } }
  .srcs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .srcs .tr { display: flex; align-items: center; gap: 8px; min-width: 0; --mdc-icon-size: 18px; }
  .srcs .tr ha-icon { flex: none; opacity: 0.8; }
  .srcs .tr.ok ha-icon { opacity: 1; color: var(--prime); }
  .srcs .tx { min-width: 0; display: flex; flex-direction: column; }
  .srcs .l { font-size: 12px; font-weight: 600; }
  .srcs .v { font-size: 11px; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chips .chip ha-icon { --mdc-icon-size: 16px; margin-right: 4px; }
  /* no On / Off button here: the sentence can use the whole width */
  .grp.nobtn > .sent { margin-right: 0; }
`;

class KnitApplianceCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("knit-appliance-card-editor");
  }

  static getStubConfig(hass) {
    const st = Object.values(hass?.states || {}).find((s) => s.attributes.role === "status" && s.attributes.knit);
    return st ? { device: hass.entities?.[st.entity_id]?.device_id } : { device: "" };
  }

  setConfig(config) {
    if (!config?.device && !config?.entity) throw new Error("Pick a Knit appliance (device), or one of its entities (entity)");
    this._config = { ...config };
    this._pending = {};
    const mem = OPEN.get(config.device || config.entity);
    this._open = mem?.open ?? this._open ?? false;
    this._ctlOpen = mem?.ctl ?? this._ctlOpen ?? false;
    this._drawn = false;
    if (this._hass) this._dom();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    // given one of its entities (e.g. its Status): the device it belongs to
    if (!this._config.device && this._config.entity) {
      const device = hass.entities?.[this._config.entity]?.device_id;
      if (!device) {
        if (!this.shadowRoot) this.attachShadow({ mode: "open" });
        this.shadowRoot.innerHTML = `<ha-card style="padding:16px">Waiting for the Knit appliance…</ha-card>`;
        return;
      }
      this._config.device = device;
    }
    if (!this._drawn) this._dom();
    else this._render();
  }

  connectedCallback() {
    this._tick = setInterval(() => this._hass && this._drawn && this._render(), 1000);
    this._onOther = (e) => {
      if (e.detail !== this && this._open && this._config?.collapse_others !== false) this._setOpen(false);
    };
    window.addEventListener(OPENED_EVENT, this._onOther);
    // open before it was in the dashboard: widened once it's in its place
    requestAnimationFrame(() => this._open && widen(this, true));
    this._onResize = () => requestAnimationFrame(() => rewiden(this));
    window.addEventListener("resize", this._onResize);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
    window.removeEventListener(OPENED_EVENT, this._onOther);
    window.removeEventListener("resize", this._onResize);
    widen(this, false);
  }

  getCardSize() {
    return this._open ? 5 : 1;
  }

  getGridOptions() {
    return { columns: 6, min_columns: 4, rows: "auto" };
  }

  $(sel) {
    return this.shadowRoot.querySelector(sel);
  }

  $$(sel) {
    return this.shadowRoot.querySelectorAll(sel);
  }

  _st(id) {
    return id ? this._hass?.states[id] : undefined;
  }

  // the device's entities, by role
  _roles() {
    const out = {};
    for (const e of Object.values(this._hass?.entities || {})) {
      if (e.device_id !== this._config.device) continue;
      const role = this._hass.states[e.entity_id]?.attributes.role;
      if (role) out[role] = e.entity_id;
    }
    return out;
  }

  _hold(key, actual) {
    const p = this._pending[key];
    if (p) {
      if (actual === p.value || Date.now() > p.until) delete this._pending[key];
      else return p.value;
    }
    return actual;
  }

  _send(key, value, domain, service, data) {
    this._pending[key] = { value, until: Date.now() + PENDING_MS };
    this._render();
    this._hass.callService(domain, service, data).catch(() => {
      delete this._pending[key];
      this._render();
    });
  }

  _title() {
    if (this._config.name) return this._config.name;
    const dev = this._hass?.devices?.[this._config.device];
    return dev?.name_by_user || dev?.name || "Appliance";
  }

  _tin(key, label) {
    return `<span class="tin" data-tin="${key}"><span class="tbox"><input class="mm" type="number" inputmode="numeric" min="0" data-tm aria-label="${esc(label)} minutes"><span class="colon">:</span><input type="number" inputmode="numeric" min="0" max="59" data-ts aria-label="${esc(label)} seconds"></span></span>`;
  }

  _dom() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const r = (this._r = this._roles());
    if (!r.status) {
      this.shadowRoot.innerHTML = `<ha-card style="padding:16px">Waiting for the Knit appliance…</ha-card>`;
      return;
    }
    this._drawn = true;
    const c = this._config;
    const st = this._st(r.status);
    const door = st?.attributes.door;
    const title = this._title();
    // what its statuses are called (they can be renamed in Knit), in order: Empty, Running, Full
    const statuses = st?.attributes.options || ["Empty", "Running", "Full"];
    // "Running once over [20] W for [01:00] mins, and finished once under it for [05:00] mins. ..."
    const num = `<span class="num"><input type="number" inputmode="decimal" data-n="running_above" aria-label="Running above"><span class="u">W</span></span>`;
    const sentence = [
      `Running once over ${num} for ${this._tin("running_after", "Running after")} mins, and finished once under it for ${this._tin("finished_after", "Finished after")} mins.`,
      ` A cycle takes about ${this._tin("cycle_length", "Cycle length")} mins.`,
      door ? ` Emptied once the door has been open ${this._tin("empty_after", "Emptied after")} mins.` : "",
    ].join("");
    this.shadowRoot.innerHTML = `<style>${CSS(colorsOf(c))}${APPLIANCE_CSS}</style><ha-card>
      <div class="tile" role="button" tabindex="0" aria-label="${esc(title)}">
        <div class="face"><div class="fill"></div></div>
        <div class="ic"><ha-icon icon="${esc(c.icon || "mdi:washing-machine")}"></ha-icon></div>
        <div class="txt"><div class="n">${esc(title)}</div><div class="s"></div></div>
        <button class="exp" aria-label="More for ${esc(title)}" aria-expanded="false"><ha-icon icon="mdi:chevron-down"></ha-icon></button>
      </div>
      <div class="panel" hidden>
        <div class="part"><div class="row"><div class="title"><ha-icon icon="mdi:list-status"></ha-icon><span>Status</span></div></div>
          <div class="chips" style="--cols: ${statuses.length}">${statuses
            .map((o, i) => `<button class="chip" data-opt="${esc(o)}"><ha-icon icon="${APPLIANCE_ICONS[["empty", "running", "full"][i]] || "mdi:circle-outline"}"></ha-icon>${esc(o)}</button>`)
            .join("")}</div></div>
        <div class="part"><div class="srcs">
          <div class="tr" data-src="power"><ha-icon icon="mdi:flash-outline"></ha-icon><span class="tx"><span class="l">Power</span><span class="v"></span></span></div>
          ${door ? `<div class="tr" data-src="door"><ha-icon icon="mdi:door"></ha-icon><span class="tx"><span class="l">Door</span><span class="v"></span></span></div>` : ""}
        </div></div>
        <div class="part"><button class="xrow" data-ctl aria-expanded="false"><ha-icon icon="mdi:tune-variant"></ha-icon><span class="lb">More controls</span><ha-icon class="chev" icon="mdi:chevron-down"></ha-icon></button>
          <div class="mset" hidden><div class="grp nobtn"><div class="title"><ha-icon icon="mdi:auto-fix"></ha-icon><span>Detection</span></div><div class="end"></div>
            <div class="sent">${sentence}</div></div></div></div>
      </div></ha-card>`;
    this._bind();
    this._setOpen(this._open);
    if (this._ctlOpen) this._showCtl(true);
  }

  _bind() {
    const r = this._r;
    const toggle = () => this._setOpen(!this._open, true);
    this.$(".tile").addEventListener("click", toggle);
    this.$(".tile").addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    this.$(".exp").addEventListener("click", (e) => {
      e.stopPropagation();
      toggle();
    });
    this.$("[data-ctl]").addEventListener("click", () => this._showCtl(!this._ctlOpen));
    this.$(".chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-opt]");
      if (b) this._send("status", b.dataset.opt, "select", "select_option", { entity_id: r.status, option: b.dataset.opt });
    });
    // times: mm:ss, saved in seconds
    this.$$("[data-tin]").forEach((box) => {
      const mm = box.querySelector("[data-tm]");
      const ss = box.querySelector("[data-ts]");
      const id = r[box.dataset.tin];
      const commit = () => {
        const t = Math.max(0, Math.floor(Number(mm.value) || 0)) * 60 + Math.max(0, Math.floor(Number(ss.value) || 0));
        const a = this._st(id)?.attributes || {};
        const step = Number(a.step) || 1;
        const v = clamp(Math.round(t / step) * step, Number(a.min ?? 0), Number(a.max ?? Infinity));
        this._send(`n:${id}`, v, "number", "set_value", { entity_id: id, value: v });
      };
      [mm, ss].forEach((inp) => {
        inp.addEventListener("focus", () => inp.select());
        inp.addEventListener("change", commit);
        inp.addEventListener("keydown", (e) => e.key === "Enter" && inp.blur());
      });
    });
    const w = this.$('[data-n="running_above"]');
    w?.addEventListener("change", () => {
      const v = Number(w.value);
      if (w.value !== "" && Number.isFinite(v)) this._send(`n:${r.running_above}`, v, "number", "set_value", { entity_id: r.running_above, value: v });
    });
    w?.addEventListener("keydown", (e) => e.key === "Enter" && w.blur());
  }

  _setOpen(open, byUser) {
    this._open = open;
    OPEN.set(this._config.device, { open, ctl: this._ctlOpen });
    // the others close first, so this one is measured beside them closed
    if (open && byUser && this._config.collapse_others !== false) window.dispatchEvent(new CustomEvent(OPENED_EVENT, { detail: this }));
    this.$(".panel").hidden = !open;
    this.$("ha-card").classList.toggle("open", open);
    this.$(".exp").setAttribute("aria-expanded", String(open));
    widen(this, open);
    this._render();
  }

  _showCtl(open) {
    this._ctlOpen = open;
    OPEN.set(this._config.device, { open: this._open, ctl: open });
    const b = this.$("[data-ctl]");
    b.setAttribute("aria-expanded", String(open));
    b.querySelector(".lb").textContent = open ? "Less controls" : "More controls";
    this.$(".mset").hidden = !open;
    if (this._open) widen(this, true); // More controls open: across the row
  }

  _render() {
    if (!this._hass || !this._drawn) return;
    // light or dark shades, as the light card picks them
    SmartLightCard.prototype._theme.call(this);
    const r = this._r;
    const st = this._st(r.status);
    const status = this._hold("status", st?.state);
    // Empty, Running or Full, whatever it's called: from the select's attribute, or (a status
    // just picked here) its place among the options
    const opts = st?.attributes.options || ["Empty", "Running", "Full"];
    const key = status === st?.state && st?.attributes.status ? st.attributes.status : ["Empty", "Running", "Full"][opts.indexOf(status)] || status;
    const tile = this.$(".tile");
    const ends = this._st(r.cycle_ends);
    const left = key === "Running" ? secsLeft(ends) : undefined;
    const total = durationSecs(ends?.attributes.duration);
    let sub = !st || NO_VALUE.includes(st.state) ? "Unavailable" : status;
    if (left !== undefined) sub = `${status} · ${clock(left)} left`;
    tile.querySelector(".s").textContent = sub;
    tile.classList.toggle("on", key !== "Empty" && Boolean(st));
    tile.classList.toggle("full", key === "Full");
    tile.querySelector(".fill").style.width = left !== undefined && total ? `${clamp(100 * (1 - left / total), 0, 100)}%` : "0%";
    this.$("ha-card").classList.toggle("on", key !== "Empty" && Boolean(st));
    if (!this._open) return;
    this.$$(".chips [data-opt]").forEach((b) => b.classList.toggle("on", b.dataset.opt === status));
    // power and door
    const p = this._st(st?.attributes.power);
    const pv = Number(p?.state);
    const pEl = this.$('[data-src="power"]');
    pEl.querySelector(".v").textContent = !p || NO_VALUE.includes(p.state) ? "No reading" : `${Number.isFinite(pv) ? Math.round(pv) : p.state} ${p.attributes.unit_of_measurement || "W"}`;
    const above = Number(this._st(r.running_above)?.state);
    pEl.classList.toggle("ok", Number.isFinite(pv) && Number.isFinite(above) && pv > above);
    const d = this._st(st?.attributes.door);
    const dEl = this.$('[data-src="door"]');
    if (dEl) {
      dEl.querySelector(".v").textContent = !d || NO_VALUE.includes(d.state) ? "Offline" : `${d.state === "on" ? "Open" : "Closed"} · ${ago(d.last_changed)}`;
      dEl.classList.toggle("ok", d?.state === "on");
      dEl.querySelector("ha-icon").setAttribute("icon", d?.state === "on" ? "mdi:door-open" : "mdi:door-closed");
    }
    // the settings
    const focused = (el) => el.contains(this.shadowRoot.activeElement);
    this.$$("[data-tin]").forEach((box) => {
      const id = r[box.dataset.tin];
      const actual = Number(this._st(id)?.state);
      const secs = Math.round(this._hold(`n:${id}`, actual));
      if (focused(box) || !Number.isFinite(secs)) return;
      box.querySelector("[data-tm]").value = String(Math.floor(secs / 60)).padStart(2, "0");
      box.querySelector("[data-ts]").value = String(secs % 60).padStart(2, "0");
    });
    const w = this.$('[data-n="running_above"]');
    if (w && !focused(w)) {
      const v = this._hold(`n:${r.running_above}`, Number(this._st(r.running_above)?.state));
      w.value = Number.isFinite(v) ? String(v) : "";
    }
  }
}

class KnitApplianceCardEditor extends HTMLElement {
  setConfig(config) {
    const ours = this._sent && JSON.stringify(config) === JSON.stringify(this._sent);
    this._config = { ...config };
    if (!ours) this._build();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._ready) {
      this._ready = true;
      this._build();
    }
    this.shadowRoot?.querySelectorAll("ha-form").forEach((f) => (f.hass = hass));
  }

  _build() {
    if (!this._config || !this._hass) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const c = this._config;
    this.shadowRoot.innerHTML = `<style>${EDITOR_CSS}</style>
      <div class="sec"><h3>Knit appliance</h3><p>The appliance set up in Knit: its status, countdown and settings come with it.</p></div>`;
    const labels = { device: "Knit appliance", name: "Title", icon: "Icon", primary: "Primary colour", collapse_others: "Close other Knit cards when this one opens" };
    const f = document.createElement("ha-form");
    f.hass = this._hass;
    f.schema = [
      { name: "device", selector: { device: { integration: "knit" } } },
      { type: "grid", name: "", schema: [{ name: "name", selector: { text: {} } }, { name: "icon", selector: { icon: {} } }] },
      { name: "primary", selector: { color_rgb: {} } },
      { name: "collapse_others", selector: { boolean: {} } },
    ];
    f.data = { ...c, primary: colorsOf(c).main, collapse_others: c.collapse_others !== false };
    f.computeLabel = (x) => labels[x.name] || x.name;
    f.addEventListener("value-changed", (e) => {
      e.stopPropagation();
      const v = e.detail.value;
      const next = { ...this._config, ...v };
      if (v.primary && JSON.stringify(v.primary) !== JSON.stringify(colorsOf(this._config).main)) {
        delete next.color;
        delete next.colors;
      } else if (!this._config.primary) delete next.primary;
      if (v.collapse_others) delete next.collapse_others;
      else next.collapse_others = false;
      Object.keys(next).forEach((k) => (next[k] === "" || next[k] === undefined) && delete next[k]);
      this._config = next;
      this._sent = next;
      this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: next }, bubbles: true, composed: true }));
    });
    this.shadowRoot.querySelector(".sec").appendChild(f);
  }
}

if (!customElements.get("knit-appliance-card")) customElements.define("knit-appliance-card", KnitApplianceCard);
if (!customElements.get("knit-appliance-card-editor")) customElements.define("knit-appliance-card-editor", KnitApplianceCardEditor);

if (!customElements.get("knit-section")) customElements.define("knit-section", SmartLightSection);
if (!customElements.get("knit-section-editor")) customElements.define("knit-section-editor", SmartLightSectionEditor);
if (!customElements.get("knit-light-card")) customElements.define("knit-light-card", SmartLightCard);
if (!customElements.get("knit-light-card-editor")) customElements.define("knit-light-card-editor", SmartLightCardEditor);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "knit-appliance-card"))
  window.customCards.push({
    type: "knit-appliance-card",
    name: "Knit Appliance Card",
    description: "A Knit appliance (dishwasher, washing machine): status, cycle countdown, corrections and its detection settings.",
  });
if (!window.customCards.some((c) => c.type === "knit-section"))
  window.customCards.push({
    type: "knit-section",
    name: "Knit Section",
    description: "A collapsible section header (title, subtitle, a button) that folds away the cards below it in a section.",
  });
if (!window.customCards.some((c) => c.type === "knit-light-card"))
  window.customCards.push({
    type: "knit-light-card",
    name: "Knit Light Card",
    description: "A light as a tile (tap, drag to dim) that opens its controls, with motion control and light level settings.",
    preview: true,
  });
console.info(`%c KNIT-CARDS %c v${SLC_VERSION} `, "background:#9d8e72;color:#fff;border-radius:3px 0 0 3px", "background:#333;color:#fff;border-radius:0 3px 3px 0");
