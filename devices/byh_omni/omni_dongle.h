#pragma once

#include <Arduino.h>
#include <Adafruit_NeoPixel.h>

struct OmniDongleConfig {
  uint8_t  boardVersion;
  uint16_t fwVersion;
  const char* ident;
  // true: WiFi AP + WebSocket host link. false: USB serial host link.
  bool     hubMode;
  // The omni's on-board status LEDs (connection indicator in dongle roles).
  Adafruit_NeoPixel* statusStrip;
  uint8_t  statusLedCount;
  // Status pixels on the host module, driven from LED_PIN.
  uint8_t  hostPixelCount;
  // Bit indexes on the host module's input (74HC165) / output (74HC595)
  // shift registers.
  uint8_t  armInputIndex;
  uint8_t  startInputIndex;
  uint8_t  manualInputIndex;
  uint8_t  rf433OutputIndex;
  // Offered every USB serial line before the dongle parser; returns true if
  // it consumed the line (GETID / SETID / SETBOARD / ...). Not offered lines
  // that arrive over WiFi.
  bool (*provisioningHook)(const char* line);
};

namespace omni_dongle {

// Snapshot of the host module's input shift register. Bit N = input N,
// 1 = switch closed. Requires the SHIFT_IN pins to be configured.
uint8_t readHostInputs();

// Blocks until the host link is ready to run (USB serial opened, or the
// WiFi AP is up) and the radio responds.
void setup(const OmniDongleConfig& cfg);
void loop();

}  // namespace omni_dongle
