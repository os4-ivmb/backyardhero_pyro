#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <math.h>

// Hub dongle transport: a WiFi AP with a single HTTP listener on port 80.
//
//   GET /api/info       -> JSON describing the hub (no secrets)
//   GET /ws (Upgrade)   -> WebSocket carrying the dongle line protocol
//
// Every WebSocket text (or binary) message is split on CR/LF and each line is
// handed to the dongle exactly as if it had arrived over USB serial. Every
// line the dongle emits is sent to each connected client as one text
// message (no trailing newline).
//
// All socket I/O is non-blocking and runs from loop(); a stalled client
// fills its own transmit buffer and starts dropping lines rather than
// stalling the radio.

namespace omni_hub {

typedef void (*LineHandler)(char* line);

struct HubConfig {
  const char* ident;
  uint16_t    fwVersion;
  uint8_t     nrfChannel;  // used to pick the AP channel farthest from it
  LineHandler onLine;
};

bool begin(const HubConfig& cfg);
void loop();

uint8_t clientCount();
// Devices associated with the AP, whether or not they've opened a WebSocket.
uint8_t stationCount();
// Queue one line (without newline) to every connected client. Returns the
// number of clients it was queued for.
uint8_t sendLine(const char* data, size_t len);
// Smallest free transmit space across connected clients; 0 when none.
int writeSpace();
// Drain transmit buffers for up to timeoutMs (used before a reboot).
void flush(uint32_t timeoutMs);

// Persisted WiFi AP settings. These work in any dongle role (so a forgotten
// password can be reset over USB) and take effect on the next hub boot.
// wifiSet: a null ssid or pass keeps the current value.
void wifiDescribe(JsonDocument& out);
// txPowerDbm: AP transmit power in dBm (mapped to the nearest supported
// step, applied at once if the hub is running, and stored); NAN keeps it.
bool wifiSet(const char* ssid, const char* pass, const char** err, float txPowerDbm = NAN);
void wifiReset();

// Last nRF24 channel the host selected, persisted so the next hub boot can
// place the AP away from it before any host has connected.
uint8_t storedNrfChannel(uint8_t fallback);
void noteNrfChannel(uint8_t ch);
uint8_t apChannel();

}  // namespace omni_hub
