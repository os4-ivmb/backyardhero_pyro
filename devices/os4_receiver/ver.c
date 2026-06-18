/*
 * ver.c -- override the ESP-IDF application descriptor so the receiver's
 * firmware image carries a meaningful project_name.
 *
 * Why this file exists:
 *   arduino-esp32 links a precompiled esp_app_desc whose project_name is
 *   "arduino-lib-builder" (the name of the tool Espressif used to build the
 *   core). That name is identical for EVERY Arduino sketch, so the host-side
 *   OTA guard (OtaFlashDriver.EXPECTED_PROJECT_NAME == "os4_receiver") could
 *   never match an arduino-cli build and refused to flash valid images.
 *
 *   In arduino-esp32 v3.x the IDF's esp_app_desc symbol is `weak`, so a
 *   strong definition here overrides it. This restores a working
 *   project_name check (and one that actually distinguishes the receiver
 *   firmware from the dongle firmware).
 *
 * Requirements / gotchas:
 *   - This MUST be a .c file. The IDF symbol has C linkage; a .cpp/.ino
 *     definition would not override it.
 *   - The struct layout below mirrors esp_app_desc_t for the installed core
 *     (idf-release_v5.3, esp_app_desc.h). Keep it in sync if the core is
 *     upgraded.
 *   - `app_elf_sha256` is patched into the binary post-link by the image
 *     tool regardless of who defines the symbol, so it is left zeroed here.
 *   - `version` is cosmetic on the host side (the receiver reports its
 *     integer FW_VERSION over telemetry separately); it is not compared.
 */

#include <stdint.h>
#include "esp_app_desc.h"

#ifndef IDF_VER
#define IDF_VER ""
#endif

#if defined(__APPLE__) && defined(CONFIG_IDF_TARGET_LINUX)
__attribute__((section("__RODATA_DESC,.rodata_desc")))
#else
__attribute__((section(".rodata_desc")))
#endif
const esp_app_desc_t esp_app_desc = {
    .magic_word = ESP_APP_DESC_MAGIC_WORD,
    .secure_version = 0,
    .reserv1 = {0, 0},
    .version = "byh-receiver",
    .project_name = "os4_receiver",
    .time = __TIME__,
    .date = __DATE__,
    .idf_ver = IDF_VER,
};
