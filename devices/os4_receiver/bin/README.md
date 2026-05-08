# Receiver firmware binaries

Build artifacts produced by `devices/utils/build_receiver.sh` land here.

Per `FW_VERSION` we keep four files, exactly the ones the Arduino IDE
flashes when it pushes a build:

- `os4_receiver_v<N>.bin` -- app partition (~340 KB). Flashed at
  **0x10000**. This is the only file `flash_receiver.py` writes for a
  routine update.
- `os4_receiver_v<N>.bootloader.bin` -- chip bootloader. Flashed at
  **0x1000** during a `--full` first-time flash.
- `os4_receiver_v<N>.partitions.bin` -- partition table. Flashed at
  **0x8000** during a `--full` first-time flash.
- `os4_receiver_v<N>.boot_app0.bin` -- OTA "next-app" pointer (static
  arduino-esp32 file, copied here so the flash helper doesn't have to
  dig through `~/Library/Arduino15`). Flashed at **0xe000** during a
  `--full` first-time flash.

NVS lives at `0x9000-0xdfff` in the default ESP32-S2 partition table --
in the gap between the partition table and `boot_app0`. `flash_receiver.py`
never writes anything in that gap, so **NODE_ID and RECEIVER_IDENT
survive both routine flashes and `--full` flashes**.

Symlinks:

- `latest.bin` -> newest `os4_receiver_v<N>.bin`
- `latest.bootloader.bin` -> newest `os4_receiver_v<N>.bootloader.bin`
- `latest.partitions.bin` -> newest `os4_receiver_v<N>.partitions.bin`
- `latest.boot_app0.bin` -> newest `os4_receiver_v<N>.boot_app0.bin`

`FW_VERSION` is read from `#define FW_VERSION` in `os4_receiver.ino` at
build time. Re-building at the same `FW_VERSION` overwrites all four
files; bump `FW_VERSION` in the sketch to keep multiple versions
side-by-side.

`.bin` files are gitignored -- these are local build artifacts. Tag
releases in git if you want to pin a particular firmware version.

See `devices/utils/README.md` for the flash workflow.
