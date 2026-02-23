# Receiver Getting Started Guide

> **Note:** This guide covers the OS4 receiver module. For information about other components, see the respective getting started guides.

*(Receiver photo placeholder)*

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

The receiver can be flashed using either method:

**Method 1: Arduino IDE**
1. Select `LOLIN S2 MINI` as the board type
2. Select the appropriate serial port (the device will appear as a serial device)
3. Upload the firmware

**Method 2: esptool (Direct)**
- Use esptool directly for command-line flashing

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
- This allows you to verify receivers are synchronized - all receivers should flash at the same time

**3. Show Run State (LED #3)**
- **Orange**: Loading show (receiving firing instructions)
- **Cyan**: Show loaded, waiting to start
- **Magenta**: Show playing but before start time (waiting for synchronized start)
- **White**: Show is actively running
- **Off**: Standing by (no show loaded)


## Building from a Bare Board

If you're building a receiver from scratch, you'll need the following components:

### Required Components

**Main Board:**
- V9+ receiver board

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