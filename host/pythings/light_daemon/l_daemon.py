import time
import board
import neopixel_spi
import os
import json

# LED positions
DAEMON_ACT_POS = 0
WEB_ACT_POS = 1
TX_ACTIVE_POS = 2
SHOW_LOADED_POS = 3
SHOW_RUNNING_POS = 4
ERROR_POS = 5

# Configuration
NUM_PIXELS = 6
SPI_PORT = board.SPI()
BRIGHTNESS = int(0.5 * 255)
FADE_FACTOR = 0.7

# Colors
COLORS = {
    "off": (0, 0, 0),
    "green": (255, 0, 0),
    "yellow": (255, 255, 0),
    "red": (0, 255, 0),
    "blue": (0, 0, 255),
    "cyan": (0, 255, 255),
    "purple": (148, 0, 211),
    "white": (255, 255, 255)
}

RAINBOW_COLORS = [
    (255, 0, 0), (255, 127, 0), (255, 255, 0),
    (0, 255, 0), (0, 0, 255), (75, 0, 130), (148, 0, 211)
]

# LED state file
LED_STATE_FILE = "/home/jeezy/proj/firework/host/data/ledstate"

# Initialize NeoPixel strip
pixels = neopixel_spi.NeoPixel_SPI(SPI_PORT, NUM_PIXELS, pixel_order=neopixel_spi.RGB, auto_write=False)

def adjust_brightness(color, brightness):
    scale = brightness / 100.0
    return fade_color(color, scale)

def fade_color(color, scale):
    return tuple(int(c * scale) for c in color)

def clear_pixels():
    pixels.fill(COLORS["off"])
    pixels.show()

def run_sweep():
    direction = 1
    position = 0
    current_color_index = 0
    while not os.path.exists(LED_STATE_FILE):
        pixels.fill(COLORS["off"])
        for trail in range(6):
            trail_position = position - trail * direction
            if 0 <= trail_position < NUM_PIXELS:
                pixels[trail_position] = fade_color(RAINBOW_COLORS[current_color_index], FADE_FACTOR ** trail)
        pixels.show()
        position += direction
        if position >= NUM_PIXELS + 5 or position < -5:
            direction *= -1
            position += direction
            current_color_index = (current_color_index + 1) % len(RAINBOW_COLORS)
        time.sleep(0.025)

# Timing variables for animations
last_update_time = time.time()
pulse_step = 0
blink_state = False

def apply_led_states(state, current_time):
    global pulse_step, blink_state, last_update_time

    brightness = state.get("led_brightness", 100)

    # Create a brightness-adjusted copy of COLORS
    adjusted_colors = {key: adjust_brightness(value, brightness) for key, value in COLORS.items()}

    pixels[DAEMON_ACT_POS] = adjusted_colors["green"] if state.get("daemon_act") == 1 else adjusted_colors["off"]

    web_act_state = state.get("web_act_state", 0) 
    pixels[WEB_ACT_POS] = adjusted_colors["green"] if web_act_state == 1 else \
                          adjusted_colors["yellow"] if web_act_state == 2 else \
                          adjusted_colors["red"] if web_act_state == 3 else \
                          adjusted_colors["off"]

    pixels[TX_ACTIVE_POS] = adjusted_colors["yellow"] if state.get("tx_active") == 1 else \
                          adjusted_colors["green"] if state.get("tx_active") == 2 else \
                          adjusted_colors["red"] if state.get("tx_active") == 3 else \
                          adjusted_colors["off"]

    show_load_state = state.get("show_load_state", 0)
    pixels[SHOW_LOADED_POS] = adjusted_colors["green"] if show_load_state == 1 else \
                               adjusted_colors["yellow"] if show_load_state == 2 else \
                               adjusted_colors["red"] if show_load_state == 3 else \
                               adjusted_colors["off"]

    show_run_state = state.get("show_run_state", 0)
    if show_run_state == 1:  # Pulsing green - running
        time_since_last_update = current_time - last_update_time
        if time_since_last_update > 0.05:  # Adjust timing for smooth animation
            pulse_step = (pulse_step + 1) % 20  # Pulse cycle length
            scale = pulse_step / 10 if pulse_step <= 10 else (20 - pulse_step) / 10
            pixels[SHOW_RUNNING_POS] = fade_color(adjusted_colors["green"], scale)
            last_update_time = current_time

    elif show_run_state == 2:  # Manual Fire
        time_since_last_update = current_time - last_update_time
        if time_since_last_update > 0.5:  # Toggle every 0.5 seconds
            blink_state = not blink_state
            pixels[SHOW_RUNNING_POS] = adjusted_colors["yellow"] if blink_state else adjusted_colors["off"]
            last_update_time = current_time
    elif show_run_state == 3:  # Stopped
        pixels[SHOW_RUNNING_POS] = adjusted_colors["red"]
    elif show_run_state == 4:  # Paused
        pixels[SHOW_RUNNING_POS] = adjusted_colors["purple"]
    elif show_run_state == 5:  # Armed
        pixels[SHOW_RUNNING_POS] = adjusted_colors["white"]
    elif show_run_state == 6:  # Waiting for delegated start
        pixels[SHOW_RUNNING_POS] = adjusted_colors["blue"]
    elif show_run_state == 7:  # PreChecking
        time_since_last_update = current_time - last_update_time
        if time_since_last_update > 0.35:  # Toggle every 0.5 seconds
            blink_state = not blink_state
            pixels[SHOW_RUNNING_POS] = adjusted_colors["cyan"] if blink_state else adjusted_colors["purple"]
            last_update_time = current_time
    elif show_run_state == 8:  # Countdown
        time_since_last_update = current_time - last_update_time
        if time_since_last_update > 0.25:  # Toggle every 0.5 seconds
            blink_state = not blink_state
            pixels[SHOW_RUNNING_POS] = adjusted_colors["green"] if blink_state else adjusted_colors["off"]
            last_update_time = current_time
    else:
        pixels[SHOW_RUNNING_POS] = adjusted_colors["off"]

    error_state = state.get("error_state", 0) #Red-Daemon #Yellow-RF Frontend #purple Sockets
    pixels[ERROR_POS] = adjusted_colors["red"] if error_state == 1 else \
                        adjusted_colors["yellow"] if error_state == 2 else \
                        adjusted_colors["purple"] if error_state == 3 else \
                        adjusted_colors["off"]

    pixels.show()

try:
    # Remove the LED state file on startup
    if os.path.exists(LED_STATE_FILE):
        os.remove(LED_STATE_FILE)

    # Run the sweep until the file appears
    run_sweep()

    while True:
        current_time = time.time()  # Get the current time once per loop

        if os.path.exists(LED_STATE_FILE):
            with open(LED_STATE_FILE, "r") as f:
                try:
                    state = json.load(f)
                except json.JSONDecodeError:
                    continue

            # Apply the LED states (non-blocking animations)
            apply_led_states(state, current_time)

        time.sleep(0.01)  # Small sleep to avoid high CPU usage

except KeyboardInterrupt:
    clear_pixels()
