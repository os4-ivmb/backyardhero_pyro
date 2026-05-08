# devices/utils

Host-side helpers for building and provisioning OS4 firmware.

## Receiver flow (FW v14+)

Pre-v14 each receiver needed its own custom build because `NODE_ID` and
`RECEIVER_IDENT` were `#define`s in the sketch. v14 moves identity into
the chip's NVS partition (`byh_rx` namespace) so one binary serves the
whole fleet, and identity is written over USB serial after flashing.

The flash workflow is built around **NVS preservation**: routine firmware
updates write only the app partition, so once a receiver has been
provisioned, its `NODE_ID` and ident persist forever -- through every
firmware update, until you explicitly wipe them.

### One-time setup (host)

```bash
brew install arduino-cli
```

That's it. `arduino-cli` reuses your existing `~/Library/Arduino15`
install for the ESP32 core, so you don't have to reinstall anything if
you've ever built via the Arduino IDE on this machine.

`flash_receiver.py` self-bootstraps a Python venv at `devices/utils/.venv`
on first run and installs `pyserial` + `esptool` into it -- you don't
need to deal with Homebrew Python's PEP 668 protection or manage
dependencies by hand. To rebuild the venv from scratch (e.g. after a
Python upgrade), just `rm -rf devices/utils/.venv` and run the script
again.

### Build

```bash
devices/utils/build_receiver.sh
```

- Reads `#define FW_VERSION` from `devices/os4_receiver/os4_receiver.ino`.
- Compiles for `esp32:esp32:lolin_s2_mini` via `arduino-cli`.
- Writes the same four files the Arduino IDE produces, into
  `devices/os4_receiver/bin/`:
  - `os4_receiver_v<N>.bin` -- app partition (~340 KB). Flashed at
    `0x10000` for routine updates.
  - `os4_receiver_v<N>.bootloader.bin` -- chip bootloader. Flashed at
    `0x1000` during `--full`.
  - `os4_receiver_v<N>.partitions.bin` -- partition table. Flashed at
    `0x8000` during `--full`.
  - `os4_receiver_v<N>.boot_app0.bin` -- OTA next-app pointer (static
    arduino-esp32 file). Flashed at `0xe000` during `--full`.
- Updates `bin/latest.*` symlinks.

To produce new artifacts alongside the old ones, bump `FW_VERSION` in
the sketch (and add notes to the version-history block at the top of the
file). Re-running at the same `FW_VERSION` overwrites the existing bins.

### Flash + provision

Three modes, picked via flags. The script always picks the
highest-versioned matching bin (override with `--bin <path>`).

#### Routine update (already-provisioned receiver)

```bash
devices/utils/flash_receiver.py
```

App-only flash at `0x10000` -- exactly what the Arduino IDE does for an
upload to a board that's already been flashed. Preserves `NODE_ID` and
ident. After the flash, the script reads the boot banner over serial
and confirms the receiver came back up with its previous identity.

#### First-time flash (virgin chip / recovery)

```bash
devices/utils/flash_receiver.py --full
```

Writes bootloader + partitions + boot_app0 + app in one esptool
invocation -- exactly the four-file layout the Arduino IDE writes for a
fresh upload. **Also preserves NVS**, because the default ESP32-S2
partition table puts NVS at `0x9000-0xdfff`, in the gap between the
partition table (`0x8000-0x8fff`) and `boot_app0` (`0xe000-0xffff`),
and we don't write anything in that gap.

After the flash, prompts for receiver number 1-254 and sends `SETID
<node_id> RX<node_id>` over serial to provision the new identity. (For
a brand-new chip, NVS is empty after this flash and the receiver boots
into UNPROVISIONED mode -- which is exactly what `SETID` resolves.)

Use this for:
- A brand new ESP32-S2 chip that has never been flashed.
- Recovery after a corrupt partition table or other surgery.
- Whenever the partition layout itself changes (e.g. you added or
  resized a partition in `partitions.csv`).

#### Re-provision (change the receiver number on an existing unit)

```bash
devices/utils/flash_receiver.py --set-id
```

App-only flash followed by an interactive `SETID`. Use this to renumber
a receiver in the field (or to provision one that ended up
unprovisioned for any reason) without wiping the rest of NVS.

Equivalent to `flash_receiver.py` followed by manually sending a
`SETID` command -- but in one step.

#### Skip the prompts

```bash
devices/utils/flash_receiver.py --full --port /dev/tty.usbmodem01 --node 146
# (ident defaults to RX146; pass --ident to override)
```

`--node` and `--ident` work with both `--full` and `--set-id`.

### Re-provisioning a unit in the field (no flash)

You don't need to re-flash to change `NODE_ID`. Use the dedicated
helper:

```bash
devices/utils/set_node_id.py                            # prompts for everything
devices/utils/set_node_id.py --node 146                 # ident defaults to RX146
devices/utils/set_node_id.py --get                      # just read current ID
devices/utils/set_node_id.py --wipe                     # back to UNPROVISIONED
```

This is the right tool when the chip already has working firmware and
you just need to renumber it. (`flash_receiver.py --set-id` does the
same thing but also re-flashes the app first.)

Under the hood, both scripts open the receiver's USB serial port at
115200 8N1 and send one of these commands -- which the firmware accepts
at any time:

```
GETID
SETID <node_id> <ident>
WIPEID
```

`SETID` and `WIPEID` reboot the chip after writing.

### Behavior summary

| Mode       | Files written              | NVS  | Auto SETID    | When to use            |
| ---------- | -------------------------- | ---- | ------------- | ---------------------- |
| (default)  | app @ 0x10000              | kept | no            | routine updates        |
| `--full`   | bootloader + partitions + boot_app0 + app | kept | yes (prompt) | virgin chip / recovery |
| `--set-id` | app @ 0x10000              | kept | yes (prompt)  | renumber a unit        |

### Troubleshooting

**`Could not configure port: (6, 'Device not configured')` or
`Connecting...` hangs at the "connecting" step.**

The lolin_s2_mini runs its user firmware over USB-CDC, and the chip's
ability to respond to esptool's auto-reset signals (DTR/RTS over USB)
depends on what the user app is doing at the moment esptool tries to
talk. When auto-reset fails, the script automatically prompts you to
put the chip into ROM bootloader mode by hand:

1. Press and HOLD the BOOT button on the receiver.
2. While still holding BOOT, press and release RESET.
3. Release BOOT.
4. Press Enter at the prompt.

The script then retries with `--before no_reset` and the flash
proceeds. Once the new firmware boots, auto-reset usually works again
for the next flash.

If the retry also fails:
- Unplug and replug the receiver to recycle the USB endpoint.
- Make sure nothing else is holding the serial port (Arduino IDE Serial
  Monitor, `screen`, another terminal, etc.).
- Try a different USB cable -- some "charging" cables don't carry data.

**`esptool not found` or `pyserial not installed`.**

`flash_receiver.py` self-bootstraps a venv at `devices/utils/.venv` on
first run. If something is wrong with the venv, just delete it and
re-run:

    rm -rf devices/utils/.venv

### Future: OTA

The same app-only artifact (`os4_receiver_v<N>.bin`) is what an OTA
flow will push -- both paths land at offset `0x10000` and preserve NVS,
so a unit can be provisioned once over USB and updated indefinitely
over the air.
