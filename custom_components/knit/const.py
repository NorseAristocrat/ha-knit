"""Constants for Knit."""

DOMAIN = "knit"

# the kind of device an entry is
CONF_TYPE = "type"
TYPE_LIGHT = "light"  # motion control (with dim) and light level
TYPE_SWITCH = "auto_off_switch"  # a motion-controlled device: off once the room is empty, never turned on
TYPE_APPLIANCE = "appliance"  # a dishwasher, a washing machine: status from power and the door

# config entry data / options
CONF_LIGHT = "light"  # lights and motion-controlled devices: the light / switch it runs
CONF_PRESENCE = "presence"  # one or more binary sensors: occupied while any is on
CONF_ILLUMINANCE = "illuminance"  # one or more light level sensors (lx): their average is judged
CONF_PAUSE = "pause"  # while these entities are on (any / all of them), nothing happens (e.g. guests)
CONF_PAUSE_MATCH = "pause_match"  # "any" (default) or "all" of the pause entities
CONF_PEOPLE = "people"  # people / trackers: while all of them are away, nothing turns the light on
CONF_START_ON = "start_on"  # turn the automatic features on when it's set up
CONF_OFF_AFTER_OUTAGE = "off_after_outage"  # motion-controlled device: off again if it comes back on after a power cut
CONF_POWER = "power"  # appliance: its plug's power sensor (W)
CONF_DOOR = "door"  # appliance: its door sensor (on = open)

# the role of each entity, as an attribute the card finds them by
ATTR_DEVICE = "knit"  # the entity the device runs (a light), or its status (an appliance)
ATTR_ROLE = "role"

ROLE_MOTION = "motion"
ROLE_LIGHT_LEVEL = "light_level"
ROLE_AUTO_OFF_TIME = "auto_off_time"
ROLE_DIM_TIME = "dim_time"
ROLE_DARK_BELOW = "dark_below"
ROLE_LIGHT_ABOVE = "light_above"
ROLE_OFF_AFTER = "off_after"
ROLE_OCCUPIED = "occupied"
ROLE_DARK = "dark"
ROLE_AUTO_OFF_ENDS = "auto_off_ends"
ROLE_OFF_WHEN_LIGHT_ENDS = "off_when_light_ends"
ROLE_ILLUMINANCE = "illuminance"  # the average light level of its sensors
ROLE_LIGHT = "light"  # always there on a light / switch: names what this device runs (for the card)
# appliances
ROLE_STATUS = "status"
# what an appliance's three statuses are called (its Status select's options), by status
CONF_STATUS_NAMES = {"Empty": "empty_name", "Running": "running_name", "Full": "full_name"}
ROLE_RUNNING_ABOVE = "running_above"
ROLE_RUNNING_AFTER = "running_after"
ROLE_FINISHED_AFTER = "finished_after"
ROLE_CYCLE_LENGTH = "cycle_length"
ROLE_EMPTY_AFTER = "empty_after"
ROLE_CYCLE_ENDS = "cycle_ends"

# settings in the engines, by role
SETTING = {
    ROLE_MOTION: "motion",
    ROLE_LIGHT_LEVEL: "light_level",
    ROLE_AUTO_OFF_TIME: "auto_off_secs",
    ROLE_DIM_TIME: "dim_secs",
    ROLE_DARK_BELOW: "dark_below",
    ROLE_LIGHT_ABOVE: "light_above",
    ROLE_OFF_AFTER: "off_after_secs",
    ROLE_RUNNING_ABOVE: "running_above",
    ROLE_RUNNING_AFTER: "running_after",
    ROLE_FINISHED_AFTER: "finished_after",
    ROLE_CYCLE_LENGTH: "cycle_secs",
    ROLE_EMPTY_AFTER: "empty_after",
}

# fired for an appliance: {"device": name, "entry_id": ..., "status": ...}
EVENT_APPLIANCE = f"{DOMAIN}_appliance_{{}}"  # .format(started | finished | emptied)

SIGNAL_UPDATE = f"{DOMAIN}_update_{{}}"  # .format(entry_id)

CARD_FILE = "knit-cards.js"
CARD_URL = f"/{DOMAIN}_static"
