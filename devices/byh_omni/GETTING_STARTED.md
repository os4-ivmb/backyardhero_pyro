# Omni Getting Started Guide

> **Note:** This guide covers the BYH Omni module. For information about other components, see the respective getting started guides.

*(Omni photo placeholder)*

## With a Completed Module

A completed v9 module is fairly straightforward to use.

### Powering On and Charging

#### Turning On/Off
The board is powered on with the switch beneath the USB port. When powered, a large green square will illuminate near the side furthest from the antenna, indicating the board is active.

#### Charging
The board can be charged with any USB-PD compatible charger. The charging status is indicated by a lit square to the left of the charge port:
- **Red**: Currently charging
- **Green**: Fully charged

### Flashing New Firmware

The Omni can be flashed using either method:

**Method 1: Arduino IDE**
1. Select `LOLIN S2 MINI` as the board type
2. Select the appropriate serial port (the device will appear as a serial device)
3. Upload the firmware

**Method 2: esptool (Direct)**
- Run `devices/utils/build_omni.sh` to compile `devices/byh_omni/byh_omni.ino`
  into `devices/byh_omni/bin/byh_omni_v<N>.*` artifacts.
- Run `devices/utils/flash_omni.py` for command-line flashing.

**Troubleshooting:**
If the board does not show up as a serial device, force boot flash mode by:
1. Exposing the bare board
2. Hold the BOOT micro button on the board
3. While holding BOOT, press the RESET button
4. Release both buttons - the board should now appear in bootloader mode


### Status Lights
There are 3 status lights located by the output port.

**Startup Sequence:**
On power-up, all 3 LEDs will fade white, then display a battery level indication (red = low, yellow = medium, green = full), followed by a purple fade.

**LED Functions (in order from closest to antenna to farthest):**

**1. Message Indicator (LED #1)**
- **White**: Flashes white for 100ms when a message is received from the dongle, then fades out over 1.5 seconds
- **Off**: No recent messages

**2. Sync/Battery Light (LED #2)**
- **Solid Purple**: Show is currently playing
- **Battery Color Flash**: When not playing, flashes at the end of each 2-second cycle with a color indicating battery level:
  - **Red**: Low battery (~0-33%)
  - **Yellow**: Medium battery (~33-66%)
  - **Green**: High battery (~66-100%)
- Flash duration: 100ms normally, 400ms when show is ready to start
- This allows you to verify omnis are synchronized - all omnis should flash at the same time

**3. Show Run State (LED #3)**
- **Orange**: Loading show (receiving firing instructions)
- **Cyan**: Show loaded, waiting to start
- **Magenta**: Show playing but before start time (waiting for synchronized start)
- **White**: Show is actively running
- **Off**: Standing by (no show loaded)


## Dongle and Hub Modes
With the dongle host module plugged into the output header, the omni boots as a dongle instead of a receiver. The module's 200kΩ resistor on the board-count sense line is what selects this; the serial log prints `Board-count ADC:` and `Role:` at boot so the threshold can be checked. A reading of 7000 or more means the host module is plugged in (`DONGLE_SENSE_ADC_MIN` in `byh_omni.ino`); lower readings boot as a receiver, with the cue-board count taken from the same reading. An omni with nothing plugged into the header also boots as a dongle.

The startup sequence is the same, except the third fade is **yellow** instead of purple.

**USB dongle (hub switch open at boot):** the omni waits for the host to open its USB serial port and then speaks the same protocol as `os4_dongle`.
- **Pulsing blue**: waiting for the host
- **Solid green**: host connected

**Hub dongle (hub switch closed at boot):** the omni starts a WiFi access point instead of waiting for USB, on the channel farthest from the nRF24 channel last used.
- Default network `BYH-Hub-XXXX`, password `backyardhero` (change it!)
- `GET http://192.17.76.1/api/info` describes the hub; a WebSocket at `ws://192.17.76.1/ws` carries the same line protocol as USB serial (one line per message). The AP is `192.17.76.1/24`; joined phones are leased from `.2` up.
- **Pulsing yellow**: network up, no devices joined
- **Flashing green**: a device has joined the WiFi but hasn't opened the WebSocket yet
- **Solid green**: a device is connected over the WebSocket

**WiFi settings commands** (over the WebSocket or USB serial; applied on the next boot):
- `wifi_get` replies with a `wifi_cfg` JSON line. The password is never returned, only `pass_set` / `pass_default`.
- `wifi_set {"ssid":"My Hub","pass":"secret123"}` stores either or both (SSID 1-32 bytes, password 8-63 printable ASCII)
- `wifi_reset` restores the defaults

Host module wiring is configurable at the top of `byh_omni.ino`: input indexes `HOST_IN_ARM_INDEX` (0), `HOST_IN_START_INDEX` (1), `HOST_IN_MANUAL_INDEX` (2), `HOST_IN_HUB_INDEX` (3), the 433MHz output `HOST_OUT_RF433_INDEX` (0), and `HOST_STATUS_PIXEL_COUNT`.


## Building from a Bare Board

If you're building an omni from scratch, you'll need the following components:

### Required Components

**Main Board:**
- V9+ omni board

**RF Components:**
- 2.4GHz antenna
- SMA plug (for antenna connection)

**Power System:**
- 8.4V 18650 battery pack assembly:
  - 2x 18650 batteries
  - 1x 2S battery BMS (Battery Management System)
  - 10k 3950 NTC thermistor (for temperature monitoring)
  - Nickel strip (for battery connections)
  - Heat wrap (for battery pack protection)

**Enclosure:**
- 3D printed housing
- Hardware kit:
  - Screws
  - Standoffs

### Assembly Instructions

> **TODO:** Detailed step-by-step assembly instructions coming soon.