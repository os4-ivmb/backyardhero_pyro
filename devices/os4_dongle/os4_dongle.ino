#include <SPI.h>
#include <RF24.h>
#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>

// FW_VERSION: Firmware version tracking for os4_dongle
// v1: Initial version - Basic mesh networking and command queuing (date unknown)
// v2: 2025-01-XX - Added FW_VERSION tracking system with version history comments
// v3: 2025-01-XX - Migrated from RF24Mesh to pure RF24 with deterministic addressing
// v4: 2026-04-XX - ACK-payload protocol overhaul:
//   * Status piggybacks in the auto-ACK (single round trip per command)
//   * Dynamic payloads enabled (smaller frames take less air time)
//   * Non-blocking dispatcher (no inner busy-wait, no per-cmd 150ms stall)
//   * TDMA-style status polling cycle (round-robin every clockSyncIntervalMs)
//   * Soft recovery (flush_tx/rx + channel scrub instead of powerDown)
//   * Payload bounds-checking on receive
//   * MAX_RECEIVERS bumped to 32, command queue to 128
//   * Packed SHOW_LOADN (up to 6 cues per RF frame)
//   * Configurable rf_channel and rf_system_id at runtime
#define FW_VERSION 4

#define RF24_CE_PIN 37
#define RF24_CSN_PIN 36
#define RF_PIN 4

#define CONTINUITY_INDEX_CT 2
#define MAX_LATENCY_SAMPLES 10
#define MAX_SUCCESS_SAMPLES 64

#define SWITCH_START_STOP_PIN 9
#define SWITCH_ARMING_PIN 8
#define SWITCH_MAN_FIRE_PIN 7

#define LED_PIN 5
#define NUM_PIXELS 7

enum MessageType {
  MANUAL_FIRE     = 1,
  CLOCK_SYNC      = 2,
  START_LOAD      = 3,
  SHOW_LOAD       = 4,
  GENERIC_PLAY    = 5,
  GENERIC_STOP    = 6,
  GENERIC_RESET   = 7,
  GENERIC_PAUSE   = 8,
  SHOW_START      = 9,
  RECEIVER_STATUS = 10,
  SHOW_LOADN      = 11,  // Packed multi-cue load (up to 6 cues per frame)
  RESET_DVC       = 12
};

struct ManualFireMessage {
  uint8_t type;
  uint8_t position;
} __attribute__((packed));

struct ClockSyncMessage {
  uint8_t type;
  uint64_t timestamp;
} __attribute__((packed));

struct StartLoadMessage {
  uint8_t type;
  uint8_t numTargetsToFire;
  uint16_t showId;
} __attribute__((packed));

struct ShowLoadMessage {
  uint8_t type;
  uint32_t time_1;
  uint8_t position_1;
  uint32_t time_2;
  uint8_t position_2;
} __attribute__((packed));

// SHOW_LOADN: pack up to SHOW_LOADN_MAX_CUES (time, position) pairs per frame.
// 1 (type) + 1 (count) + 6*(4+1) = 32 bytes — fills the whole nRF24 payload.
#define SHOW_LOADN_MAX_CUES 6
struct ShowLoadNCue {
  uint32_t time;
  uint8_t position;
} __attribute__((packed));

struct ShowLoadNMessage {
  uint8_t type;
  uint8_t count;
  ShowLoadNCue cues[SHOW_LOADN_MAX_CUES];
} __attribute__((packed));

struct GenericMessage {
  uint8_t type;
} __attribute__((packed));

struct ShowStartMessage {
  uint8_t type;
  uint64_t targetStartTime;
  uint8_t numTargetsToFire;
  uint16_t showId;
} __attribute__((packed));

// Status piggybacks in the auto-ACK from receiver -> master.
// Must stay <= 32 bytes (nRF24 max payload). Currently 31 bytes packed.
struct ReceiverStatusMessage {
  uint8_t type;
  uint8_t nodeID;
  uint8_t batteryLevel;
  uint16_t showState;
  char ident[10];
  uint64_t cont64_0;
  uint64_t cont64_1;
} __attribute__((packed));

struct ReceiverInfo {
  uint8_t nodeID;
  String ident;
  uint8_t batteryLevel;
  uint16_t showId;
  bool loadComplete;
  bool startReady;
  uint64_t lastMessageTime;
  uint64_t continuity[CONTINUITY_INDEX_CT];

  uint32_t latencies[MAX_LATENCY_SAMPLES];
  uint8_t latencyNextIndex;
  uint8_t latencySampleCount;

  // Success tracking: circular buffer of command results (1 = success, 0 = failure/timeout)
  bool successHistory[MAX_SUCCESS_SAMPLES];
  uint8_t successHead;
  uint8_t successCount;

  uint8_t consecutiveFailures;
};

// Bumped from 10 to 32 to support 20+ receivers per the throughput target.
#define MAX_RECEIVERS 32
ReceiverInfo receivers[MAX_RECEIVERS];
uint8_t numReceivers = 0;

// Effectively disables proactive pruning: with the ACK-payload protocol
// receivers no longer self-announce, so once we know about a receiver we
// keep polling it indefinitely. The host decides "online vs offline" from
// the per-receiver lastMessageTime in the JSON status. If you really want
// to drop a receiver you can lower this via JSON config.
uint32_t receiverInactivityTimeoutMs = 3600000UL;  // 1 hour
// commandResponseTimeoutMs is now mostly informational. With ACK payloads the
// auto-ACK either arrives within ~22ms (5 retries * ARD~3.75ms) or it doesn't —
// the long 150ms application-level wait is gone.
uint32_t commandResponseTimeoutMs = 50UL;
uint32_t clockSyncIntervalMs = 2000UL;
uint8_t debugMode = 0;

// Runtime-tunable RF parameters. Defaults preserve previous behavior.
uint8_t rfChannel = 85;
// rfSystemId salts the RF base address so two independent firing systems on
// the same channel don't collide. 0 = legacy behavior.
uint8_t rfSystemId = 0;

struct QueuedCommand {
  uint8_t targetNodeID;
  MessageType messageType;

  uint8_t fire_position;
  uint64_t sync_timestamp;
  uint8_t startload_numTargets;
  uint16_t startload_showId;
  uint32_t showload_time_1;
  uint8_t  showload_position_1;
  uint32_t showload_time_2;
  uint8_t  showload_position_2;
  uint64_t showstart_targetStartTime;
  uint8_t  showstart_numTargetsToFire;
  uint16_t showstart_showId;
  uint8_t repeat_count;

  // For SHOW_LOADN
  uint8_t loadn_count;
  ShowLoadNCue loadn_cues[SHOW_LOADN_MAX_CUES];
};

// Bumped from 40 to 128 — show-start can enqueue ~300 commands at once.
#define MAX_COMMANDS_IN_QUEUE 128
QueuedCommand commandBuffer[MAX_COMMANDS_IN_QUEUE];
int cmdQueueHead = 0;
int cmdQueueTail = 0;
int cmdQueueCount = 0;

// Aggregate latency stats (not per-receiver).
uint32_t latencies[MAX_LATENCY_SAMPLES];
uint8_t latencyNextIndex = 0;
uint8_t latencySampleCount = 0;

// TDMA-style polling: round-robin index across receivers for clock-sync/poll.
uint8_t nextPollReceiverIdx = 0;
uint64_t lastPollDispatchTime = 0;

uint8_t lastStartStopState = HIGH;
uint8_t lastArmingState = HIGH;
uint8_t lastManFireState = HIGH;
unsigned long lastGpioCheckTime = 0;

Adafruit_NeoPixel pixels(NUM_PIXELS, LED_PIN, NEO_GRB + NEO_KHZ800);

unsigned long lastBlinkTime = 0;
bool blinkState = false;
unsigned long lastPulseTime = 0;
int pulseValue = 0;
int pulseDirection = 1;
uint8_t ledBrightness = 90;

uint32_t COLOR_OFF = pixels.Color(0, 0, 0);
uint32_t COLOR_GREEN = pixels.Color(0, 255, 0);
uint32_t COLOR_YELLOW = pixels.Color(255, 255, 0);
uint32_t COLOR_RED = pixels.Color(255, 0, 0);
uint32_t COLOR_BLUE = pixels.Color(0, 0, 255);
uint32_t COLOR_PURPLE = pixels.Color(255, 0, 255);
uint32_t COLOR_WHITE = pixels.Color(255, 255, 255);
uint32_t COLOR_CYAN = pixels.Color(0, 255, 255);

uint8_t ledStates[NUM_PIXELS] = {0};
uint8_t ledEffects[NUM_PIXELS] = {0};

uint64_t tsOffset = 0;
uint64_t lastPrintTime = 0;

#define SERIAL_BUFFER_SIZE 512
char serialLineBuffer[SERIAL_BUFFER_SIZE];
uint16_t serialBufferIndex = 0;

RF24 radio(RF24_CE_PIN, RF24_CSN_PIN);

// RF24 addressing (Star Topology):
// Master listens on pipe 0 at masterReadAddress(); receivers each listen on
// receiverAddress(nodeID). The rfSystemId is salted into the high bytes so
// two independent firing systems on the same channel won't collide. With
// rfSystemId == 0 (the default) the addresses are byte-identical to the
// pre-v4 scheme — old receivers can keep talking to a new dongle and
// vice-versa during a rolling upgrade.
//   rfSystemId=0:   master_read=0x0000000000, receiver_N=0x0000000001+N
//   rfSystemId=k:   master_read=k*0x0100000000, receiver_N=k*0x0100000000 + 1 + N
// Note: with the ACK-payload protocol, master rarely listens — it sends
// commands and receives status back as the ACK payload. Reading-pipe is only
// kept for legacy / out-of-band messages.
#define MASTER_READ_BASE   0x0000000000ULL
#define RECEIVER_BASE      0x0000000001ULL

static inline uint64_t systemSalt() {
  // 4-byte left-shift so the system ID lives in the high 32 bits and never
  // collides with the 0..255 nodeID range in the low byte.
  return ((uint64_t)rfSystemId) << 32;
}
static inline uint64_t masterReadAddress() {
  return MASTER_READ_BASE | systemSalt();
}
static inline uint64_t receiverAddress(uint8_t nodeID) {
  return RECEIVER_BASE | systemSalt() | (uint64_t)nodeID;
}

bool isQueueFull() { return cmdQueueCount >= MAX_COMMANDS_IN_QUEUE; }
bool isQueueEmpty() { return cmdQueueCount == 0; }

void enqueueCommand(const QueuedCommand& cmd) {
  if (isQueueFull()) {
    Serial.println(F("ERR: Command queue full. Command dropped."));
    return;
  }
  commandBuffer[cmdQueueTail] = cmd;
  cmdQueueTail = (cmdQueueTail + 1) % MAX_COMMANDS_IN_QUEUE;
  cmdQueueCount++;
}

bool dequeueCommand(QueuedCommand& cmd) {
  if (isQueueEmpty()) return false;
  cmd = commandBuffer[cmdQueueHead];
  cmdQueueHead = (cmdQueueHead + 1) % MAX_COMMANDS_IN_QUEUE;
  cmdQueueCount--;
  return true;
}

void setupLEDs() {
  pixels.begin();
  pixels.setBrightness(map(ledBrightness, 0, 100, 0, 255));
  pixels.clear();
  pixels.setPixelColor(0, COLOR_GREEN);
  pixels.show();
}

void updateLEDs() {
  unsigned long currentMillis = millis();

  if (currentMillis - lastBlinkTime >= 500) {
    blinkState = !blinkState;
    lastBlinkTime = currentMillis;
  }

  if (currentMillis - lastPulseTime >= 50) {
    pulseValue += pulseDirection * 5;
    if (pulseValue >= 100) { pulseValue = 100; pulseDirection = -1; }
    else if (pulseValue <= 0) { pulseValue = 0; pulseDirection = 1; }
    lastPulseTime = currentMillis;
  }

  for (int i = 0; i < NUM_PIXELS; i++) {
    uint32_t color;

    switch (ledStates[i]) {
      case 0: color = COLOR_OFF; break;
      case 1: color = COLOR_GREEN; break;
      case 2: color = COLOR_YELLOW; break;
      case 3: color = COLOR_RED; break;
      case 4: color = COLOR_BLUE; break;
      case 5: color = COLOR_PURPLE; break;
      case 6: color = COLOR_WHITE; break;
      case 7: color = COLOR_CYAN; break;
      default: color = COLOR_OFF;
    }

    if (ledEffects[i] == 1) {
      if (!blinkState) color = COLOR_OFF;
    } else if (ledEffects[i] == 2) {
      uint8_t r = ((color >> 16) & 0xFF) * pulseValue / 100;
      uint8_t g = ((color >> 8) & 0xFF) * pulseValue / 100;
      uint8_t b = (color & 0xFF) * pulseValue / 100;
      color = pixels.Color(r, g, b);
    }

    pixels.setPixelColor(i, color);
  }

  pixels.show();
}

// Forward declaration so parseLedJSON can poke RF settings.
void applyRfConfig();

void parseLedJSON(const String& json) {
  StaticJsonDocument<1024> doc;
  DeserializationError error = deserializeJson(doc, json);
  if (error) {
    Serial.print(F("deserializeJson() failed: "));
    Serial.print(error.f_str());
    Serial.print(F(" JSON length: "));
    Serial.println(json.length());
    return;
  }

  if (doc.containsKey("led_brightness")) {
    ledBrightness = doc["led_brightness"].as<int>();
    if (ledBrightness < 1) ledBrightness = 1;
    if (ledBrightness > 100) ledBrightness = 100;
    pixels.setBrightness(map(ledBrightness, 0, 100, 0, 255));
  }
  if (doc.containsKey("daemon_act"))     ledStates[0] = doc["daemon_act"].as<int>() ? 1 : 0;
  if (doc.containsKey("web_act_state"))  ledStates[1] = doc["web_act_state"].as<int>();
  if (doc.containsKey("tx_active"))      ledStates[2] = doc["tx_active"].as<int>();
  if (doc.containsKey("show_load_state"))ledStates[3] = doc["show_load_state"].as<int>();
  if (doc.containsKey("show_run_state")) {
    int runState = doc["show_run_state"].as<int>();
    ledStates[4] = runState;
    if (runState == 1)      ledEffects[4] = 2;
    else if (runState == 2) ledEffects[4] = 1;
    else if (runState == 8) ledEffects[4] = 1;
    else if (runState == 7) ledEffects[4] = 1;
    else                    ledEffects[4] = 0;
  }
  if (doc.containsKey("error_state"))    ledStates[5] = doc["error_state"].as<int>();
  if (doc.containsKey("arm_state")) {
    int armState = doc["arm_state"].as<int>();
    if (armState == 1) { ledStates[6] = 3; ledEffects[6] = 2; }
    else               { ledStates[6] = 4; ledEffects[6] = 0; }
  }

  if (doc.containsKey("receiver_timeout_ms"))    receiverInactivityTimeoutMs = doc["receiver_timeout_ms"].as<uint32_t>();
  if (doc.containsKey("response_timeout_ms"))    commandResponseTimeoutMs    = doc["response_timeout_ms"].as<uint32_t>();
  if (doc.containsKey("clock_sync_interval_ms")) clockSyncIntervalMs         = doc["clock_sync_interval_ms"].as<uint32_t>();
  if (doc.containsKey("debug_mode"))             debugMode                   = doc["debug_mode"].as<uint8_t>();

  bool rfChanged = false;
  if (doc.containsKey("rf_channel")) {
    uint8_t newCh = doc["rf_channel"].as<uint8_t>();
    if (newCh <= 125 && newCh != rfChannel) { rfChannel = newCh; rfChanged = true; }
  }
  if (doc.containsKey("rf_system_id")) {
    uint8_t newSid = doc["rf_system_id"].as<uint8_t>();
    if (newSid != rfSystemId) { rfSystemId = newSid; rfChanged = true; }
  }
  if (rfChanged) applyRfConfig();
}

void checkGpioStatus() {
  uint8_t startStopState = digitalRead(SWITCH_START_STOP_PIN);
  uint8_t armingState = digitalRead(SWITCH_ARMING_PIN);
  uint8_t manFireState = digitalRead(SWITCH_MAN_FIRE_PIN);

  if (startStopState != lastStartStopState ||
      armingState != lastArmingState ||
      manFireState != lastManFireState ||
      millis() - lastGpioCheckTime > 10000) {
    if (millis() - lastGpioCheckTime > 200) {
      lastStartStopState = startStopState;
      lastArmingState = armingState;
      lastManFireState = manFireState;
      lastGpioCheckTime = millis();
      StaticJsonDocument<200> doc;
      doc["gpio"] = "gpio_status";
      doc["start_stop"] = (startStopState);
      doc["armed"] = (armingState);
      doc["man_fire"] = (manFireState);
      String jsonString;
      serializeJson(doc, jsonString);
      Serial.println(jsonString);
    }
  }
}

// Convention: receiver ident always has the form "RX<nodeID>" (e.g. "RX161").
// We exploit this so the dongle can address a freshly-known receiver before
// receiving its first status frame. Returns 0 if the ident doesn't match the
// pattern.
uint8_t nodeIDFromIdent(const String &ident) {
  if (ident.length() < 3) return 0;
  if (ident.charAt(0) != 'R' || ident.charAt(1) != 'X') return 0;
  long val = 0;
  for (uint16_t i = 2; i < ident.length(); i++) {
    char c = ident.charAt(i);
    if (c < '0' || c > '9') return 0;
    val = val * 10 + (c - '0');
    if (val > 255) return 0;
  }
  return (uint8_t)val;
}

ReceiverInfo* getReceiverByIdent(const String &ident, bool createIfNotExist) {
  if (ident.length() == 0 || ident.charAt(0) != 'R') return nullptr;

  for (uint8_t i = 0; i < numReceivers; i++) {
    if (receivers[i].ident == ident) return &receivers[i];
  }
  if (!createIfNotExist) return nullptr;

  if (numReceivers < MAX_RECEIVERS) {
    ReceiverInfo &r = receivers[numReceivers];
    r.ident = ident;
    // Bootstrap nodeID from the ident pattern so we can address the receiver
    // before its first ACK-payload status comes back. The next ACK payload
    // will overwrite this with the receiver's authoritative value.
    r.nodeID = nodeIDFromIdent(ident);
    r.batteryLevel = 0;
    r.showId = 0;
    r.loadComplete = false;
    r.startReady = false;
    r.lastMessageTime = millis() + tsOffset;
    for (uint8_t j = 0; j < CONTINUITY_INDEX_CT; j++) r.continuity[j] = 0;
    r.latencyNextIndex = 0;
    r.latencySampleCount = 0;
    for (uint8_t k = 0; k < MAX_LATENCY_SAMPLES; k++) r.latencies[k] = 0;
    r.successHead = 0;
    r.successCount = 0;
    for (uint8_t k = 0; k < MAX_SUCCESS_SAMPLES; k++) r.successHistory[k] = false;
    r.consecutiveFailures = 0;
    numReceivers++;
    return &receivers[numReceivers - 1];
  }

  Serial.println(F("ERR: Max receivers reached. Cannot add new."));
  return nullptr;
}

ReceiverInfo* getReceiverByNodeID(uint8_t nodeID) {
  if (nodeID == 0) return nullptr;
  for (uint8_t i = 0; i < numReceivers; i++) {
    if (receivers[i].nodeID == nodeID) return &receivers[i];
  }
  return nullptr;
}

void pushCommandResult(ReceiverInfo* rinfo, bool success) {
  if (!rinfo) return;
  rinfo->successHistory[rinfo->successHead] = success;
  rinfo->successHead = (rinfo->successHead + 1) % MAX_SUCCESS_SAMPLES;
  if (rinfo->successCount < MAX_SUCCESS_SAMPLES) rinfo->successCount++;
}

uint8_t calculateSuccessPercent(ReceiverInfo* rinfo) {
  if (!rinfo || rinfo->successCount == 0) return 0;
  uint8_t cnt = 0;
  uint8_t startIdx = 0;
  if (rinfo->successCount == MAX_SUCCESS_SAMPLES) startIdx = rinfo->successHead;
  for (uint8_t i = 0; i < rinfo->successCount; i++) {
    uint8_t idx = (startIdx + i) % MAX_SUCCESS_SAMPLES;
    if (rinfo->successHistory[idx]) cnt++;
  }
  return (uint8_t)((cnt * 100) / rinfo->successCount);
}

// Process a status message (whether received as an ACK payload or unsolicited).
// Validates length first.
void ingestStatusFrame(const uint8_t* buf, uint8_t len, uint64_t now) {
  if (len < sizeof(ReceiverStatusMessage)) {
    if (debugMode > 0) {
      Serial.print(F("WARN: short status frame, len=")); Serial.println(len);
    }
    return;
  }

  const ReceiverStatusMessage* status = (const ReceiverStatusMessage*)buf;
  if (status->type != RECEIVER_STATUS) {
    if (debugMode > 0) {
      Serial.print(F("WARN: ack payload type mismatch=")); Serial.println(status->type);
    }
    return;
  }

  // ident must be a printable, NUL-terminated string starting with 'R'.
  char identBuf[sizeof(status->ident) + 1];
  memcpy(identBuf, status->ident, sizeof(status->ident));
  identBuf[sizeof(status->ident)] = '\0';
  if (identBuf[0] != 'R') {
    if (debugMode > 0) {
      Serial.print(F("WARN: bogus ident in status: ")); Serial.println(identBuf);
    }
    return;
  }

  ReceiverInfo* r = getReceiverByIdent(String(identBuf), true);
  if (!r) {
    Serial.print(F("ERR: Status from unknown ident/node ")); Serial.println(status->nodeID);
    return;
  }

  r->nodeID = status->nodeID;
  r->batteryLevel = status->batteryLevel;
  r->showId = status->showState & 0x3FFF;
  r->loadComplete = (status->showState & (1 << 14)) ? true : false;
  r->startReady   = (status->showState & (1 << 15)) ? true : false;
  r->lastMessageTime = now;
  r->continuity[0] = status->cont64_0;
  r->continuity[1] = status->cont64_1;
}

// Soft recovery: clear the radio FIFOs and reapply config without a power-cycle.
// Avoids the previous 20+ ms stall that blocked all other receivers.
void softRadioRecovery() {
  if (debugMode > 0) Serial.println(F("INFO: soft radio recovery"));
  radio.flush_tx();
  radio.flush_rx();
  // Re-apply core settings in case a glitch corrupted a register.
  radio.setChannel(rfChannel);
  radio.setRetries(15, 5);
  radio.setPALevel(RF24_PA_MAX);
  radio.setDataRate(RF24_250KBPS);
  radio.setCRCLength(RF24_CRC_16);
  radio.setAutoAck(true);
  radio.setAutoAck(0, true);
  // Re-arm dynamic payloads + ACK-payload features so a soft recovery doesn't
  // silently demote us to the legacy single-frame protocol.
  radio.enableDynamicPayloads();
  radio.enableAckPayload();
}

// Apply current rfChannel/rfSystemId to the live radio without a full reboot.
void applyRfConfig() {
  if (debugMode > 0) {
    Serial.print(F("INFO: RF reconfigure ch=")); Serial.print(rfChannel);
    Serial.print(F(" sid=")); Serial.println(rfSystemId);
  }
  radio.stopListening();
  radio.setChannel(rfChannel);
  radio.openReadingPipe(0, masterReadAddress());
  radio.startListening();
}

// Core send-and-collect-status routine. With ACK-payloads enabled, radio.write()
// returns true once the receiver auto-ACKs. If that ACK carried a payload
// (which it should, since the receiver pre-loads its status), we read it out
// and ingest it as a status update.
bool sendCommandFrame(uint8_t nodeID, const void* msg, uint8_t msgLen, uint64_t now) {
  if (!radio.isChipConnected()) {
    if (debugMode > 0) {
      Serial.print(F("TX ERR: radio not connected, N")); Serial.println(nodeID);
    }
    return false;
  }

  // Master is normally in PRX mode (listening). RF24 library handles the
  // transition for us inside write(); no manual stopListening/startListening
  // needed in the common path. We do still need to point at the right writing
  // pipe per-target.
  radio.stopListening();
  radio.openWritingPipe(receiverAddress(nodeID));

  uint64_t txStart = now;
  bool ok = radio.write(msg, msgLen);

  // Drain anything in the RX FIFO. With ACK payloads enabled, a successful
  // write deposits the receiver's status here. Use radio.available() rather
  // than isAckPayloadAvailable() so we also pick up rare stale entries
  // (legacy unsolicited frames during the migration window).
  while (radio.available()) {
    uint8_t ackBuf[32];
    uint8_t ackLen = radio.getDynamicPayloadSize();
    if (ackLen == 0 || ackLen > sizeof(ackBuf)) {
      // Library can return 0xFF on corrupt frames; flush and bail.
      radio.flush_rx();
      break;
    }
    radio.read(ackBuf, ackLen);
    ingestStatusFrame(ackBuf, ackLen, now);
  }

  // Return to RX standby for inbound traffic from receivers we haven't polled
  // yet, e.g. legacy unsolicited frames during transition.
  radio.startListening();

  if (ok) {
    uint32_t latency = (uint32_t)(millis() + tsOffset - txStart);
    latencies[latencyNextIndex] = latency;
    latencyNextIndex = (latencyNextIndex + 1) % MAX_LATENCY_SAMPLES;
    if (latencySampleCount < MAX_LATENCY_SAMPLES) latencySampleCount++;

    ReceiverInfo* r = getReceiverByNodeID(nodeID);
    if (r) {
      r->latencies[r->latencyNextIndex] = latency;
      r->latencyNextIndex = (r->latencyNextIndex + 1) % MAX_LATENCY_SAMPLES;
      if (r->latencySampleCount < MAX_LATENCY_SAMPLES) r->latencySampleCount++;
      pushCommandResult(r, true);
      r->consecutiveFailures = 0;
    }
  } else {
    if (debugMode > 0) {
      Serial.print(F("TX FAIL: N")); Serial.println(nodeID);
    }
    ReceiverInfo* r = getReceiverByNodeID(nodeID);
    if (r) {
      pushCommandResult(r, false);
      r->consecutiveFailures++;
      const uint8_t RECOVERY_THRESHOLD = 10;
      if (r->consecutiveFailures >= RECOVERY_THRESHOLD) {
        softRadioRecovery();
        r->consecutiveFailures = 0;
      }
    }
  }
  return ok;
}

bool sendManualFire(uint8_t nodeID, uint8_t position, uint64_t now) {
  ManualFireMessage msg = { (uint8_t)MANUAL_FIRE, position };
  return sendCommandFrame(nodeID, &msg, sizeof(msg), now);
}

bool sendClockSync(uint8_t nodeID, uint64_t timestamp, uint64_t now) {
  // Stamp timestamp as late as possible to minimize the offset the receiver
  // must compensate for. The receiver applies ADDITIONAL_CLOCK_TX_OFFSET to
  // account for residual TX/decode latency.
  ClockSyncMessage msg;
  msg.type = CLOCK_SYNC;
  msg.timestamp = timestamp ? timestamp : (millis() + tsOffset);
  return sendCommandFrame(nodeID, &msg, sizeof(msg), now);
}

bool sendStartLoad(uint8_t nodeID, uint8_t numTargets, uint16_t showId, uint64_t now) {
  StartLoadMessage msg = { (uint8_t)START_LOAD, numTargets, showId };
  return sendCommandFrame(nodeID, &msg, sizeof(msg), now);
}

bool sendShowLoad(uint8_t nodeID, uint32_t t1, uint8_t p1, uint32_t t2, uint8_t p2, uint64_t now) {
  ShowLoadMessage msg = { (uint8_t)SHOW_LOAD, t1, p1, t2, p2 };
  return sendCommandFrame(nodeID, &msg, sizeof(msg), now);
}

bool sendShowLoadN(uint8_t nodeID, const ShowLoadNCue* cues, uint8_t count, uint64_t now) {
  if (count == 0) return false;
  if (count > SHOW_LOADN_MAX_CUES) count = SHOW_LOADN_MAX_CUES;
  ShowLoadNMessage msg;
  msg.type = SHOW_LOADN;
  msg.count = count;
  for (uint8_t i = 0; i < count; i++) msg.cues[i] = cues[i];
  // Send only the meaningful prefix (saves air time vs. always sending 32 bytes).
  uint8_t bytesUsed = 2 + count * sizeof(ShowLoadNCue);
  return sendCommandFrame(nodeID, &msg, bytesUsed, now);
}

bool sendShowStart(uint8_t nodeID, uint64_t startTime, uint8_t numTargets, uint16_t showId, uint64_t now) {
  ShowStartMessage msg = { (uint8_t)SHOW_START, startTime, numTargets, showId };
  return sendCommandFrame(nodeID, &msg, sizeof(msg), now);
}

bool sendGeneric(uint8_t nodeID, uint8_t commandType, uint64_t now) {
  GenericMessage msg = { commandType };
  return sendCommandFrame(nodeID, &msg, sizeof(msg), now);
}

// 433 MHz Bilusocn TX path (unchanged).
bool isValidMessage(const String &message) {
  return message.startsWith(">>") && message.endsWith("<<") && message.indexOf(':') != -1;
}

String parseBinaryString(const String &message) {
  int start = message.indexOf(">>") + 2;
  int colon = message.indexOf(':');
  return message.substring(start, colon);
}

int parseRepetitions(const String &message) {
  int colon = message.indexOf(':');
  int end = message.indexOf("<<");
  return message.substring(colon + 1, end).toInt();
}

void sendOneMessage() {
  digitalWrite(RF_PIN, HIGH);
  delayMicroseconds(376);
  digitalWrite(RF_PIN, LOW);
  delayMicroseconds(1030);
}

void sendZeroMessage() {
  digitalWrite(RF_PIN, HIGH);
  delayMicroseconds(1032);
  digitalWrite(RF_PIN, LOW);
  delayMicroseconds(566);
}

void sendBinaryString(const String &binaryString) {
  for (int i = 0; i < binaryString.length(); i++) {
    if (binaryString[i] == '1')      sendOneMessage();
    else if (binaryString[i] == '0') sendZeroMessage();
  }
  digitalWrite(RF_PIN, HIGH);
  delayMicroseconds(400);
  digitalWrite(RF_PIN, LOW);
  delay(10);
}

// Parse a `showloadn IDENT COUNT t1 p1 t2 p2 ... [REPEAT]` command.
// Returns false on parse error.
bool parseShowLoadN(const String& argsAfterIdent, QueuedCommand& qc) {
  qc.messageType = SHOW_LOADN;
  qc.repeat_count = 1;

  String s = argsAfterIdent;
  s.trim();

  // Split into tokens.
  const int MAX_TOKENS = 2 + SHOW_LOADN_MAX_CUES * 2 + 1;
  String tokens[MAX_TOKENS];
  int tokenCount = 0;
  int idx = 0;
  while (idx < (int)s.length() && tokenCount < MAX_TOKENS) {
    int sp = s.indexOf(' ', idx);
    if (sp < 0) sp = s.length();
    tokens[tokenCount++] = s.substring(idx, sp);
    idx = sp + 1;
  }

  if (tokenCount < 1) return false;
  uint8_t count = (uint8_t)tokens[0].toInt();
  if (count == 0 || count > SHOW_LOADN_MAX_CUES) return false;

  // Need at least: 1 (count) + count*2 tokens. Optional trailing token = repeat.
  int needed = 1 + count * 2;
  if (tokenCount < needed) return false;
  if (tokenCount > needed) {
    int rep = tokens[needed].toInt();
    if (rep > 0) qc.repeat_count = (uint8_t)rep;
  }

  qc.loadn_count = count;
  for (uint8_t i = 0; i < count; i++) {
    qc.loadn_cues[i].time = (uint32_t)tokens[1 + i*2].toInt();
    qc.loadn_cues[i].position = (uint8_t)tokens[1 + i*2 + 1].toInt();
  }
  return true;
}

void processSerialCommand(String inStr) {
  inStr.trim();
  if (inStr.length() == 0) return;

  if (inStr.startsWith("{")) { parseLedJSON(inStr); return; }

  int firstSpace = inStr.indexOf(' ');
  if (firstSpace < 0) { Serial.println(F("C?NFS")); return; }
  String cmdStr = inStr.substring(0, firstSpace);
  String args = inStr.substring(firstSpace + 1);

  if (cmdStr == "433fire") {
    if (isValidMessage(args)) {
      String binaryString = parseBinaryString(args);
      int repetitions = parseRepetitions(args);
      if (debugMode > 0) {
        Serial.print(F("Processing 433MHz: ")); Serial.print(binaryString);
        Serial.print(F(" x")); Serial.println(repetitions);
      }
      for (int i = 0; i < repetitions; i++) sendBinaryString(binaryString);
      if (debugMode > 0) Serial.println(F("C+ 433"));
    } else {
      Serial.println(F("CV 433"));
    }
    return;
  }

  int secondSpace = args.indexOf(' ');
  if (secondSpace < 0 && cmdStr != "msync") { Serial.println(F("C?NSS")); return; }

  String ident = (secondSpace > 0) ? args.substring(0, secondSpace) : args;
  String paramsStr = (secondSpace > 0) ? args.substring(secondSpace + 1) : "";

  if (cmdStr == "msync") {
    uint64_t ts = atoll(paramsStr.c_str());
    tsOffset = ts - millis();
    Serial.println(F("C+ msync"));
    return;
  }

  ReceiverInfo* rinfo = getReceiverByIdent(ident, true);
  if (!rinfo) { Serial.println(F("CV RNE")); return; }

  // Drop the previous "if nodeID==0 then targetNodeID=1" footgun. If we don't
  // know the receiver's nodeID yet (haven't heard from it), we can't address
  // it. Tell the operator clearly instead of misfiring on N1.
  if (rinfo->nodeID == 0) {
    Serial.print(F("CV NID0 ")); Serial.println(ident);
    return;
  }
  uint8_t targetNodeID = rinfo->nodeID;

  QueuedCommand qc = {0};
  qc.targetNodeID = targetNodeID;
  qc.repeat_count = 1;

  if (cmdStr == "fire") {
    qc.messageType = MANUAL_FIRE;
    int lastSpace = paramsStr.lastIndexOf(' ');
    if (lastSpace > 0) {
      qc.fire_position = paramsStr.substring(0, lastSpace).toInt();
      int rep = paramsStr.substring(lastSpace + 1).toInt();
      qc.repeat_count = rep > 0 ? rep : 1;
    } else {
      qc.fire_position = paramsStr.toInt();
    }
  } else if (cmdStr == "sync") {
    qc.messageType = CLOCK_SYNC;
    int lastSpace = paramsStr.lastIndexOf(' ');
    if (lastSpace > 0) {
      qc.sync_timestamp = atoll(paramsStr.substring(0, lastSpace).c_str());
      int rep = paramsStr.substring(lastSpace + 1).toInt();
      qc.repeat_count = rep > 0 ? rep : 1;
    } else {
      qc.sync_timestamp = atoll(paramsStr.c_str());
    }
  } else if (cmdStr == "startload") {
    qc.messageType = START_LOAD;
    int lastSpace = paramsStr.lastIndexOf(' ');
    String mainParams = paramsStr;
    if (lastSpace > 0) {
      String lastToken = paramsStr.substring(lastSpace + 1);
      int lastTokenVal = lastToken.toInt();
      if (lastTokenVal > 0 && lastTokenVal <= 10) {
        mainParams = paramsStr.substring(0, lastSpace);
        qc.repeat_count = lastTokenVal;
      }
    }
    int spaceIdx = mainParams.indexOf(' ');
    if (spaceIdx < 0) { Serial.println(F("CV startload")); return; }
    qc.startload_numTargets = mainParams.substring(0, spaceIdx).toInt();
    qc.startload_showId = mainParams.substring(spaceIdx + 1).toInt();
  } else if (cmdStr == "showload") {
    qc.messageType = SHOW_LOAD;
    int lastSpace = paramsStr.lastIndexOf(' ');
    String mainParams = paramsStr;
    if (lastSpace > 0) {
      mainParams = paramsStr.substring(0, lastSpace);
      int rep = paramsStr.substring(lastSpace + 1).toInt();
      qc.repeat_count = rep > 0 ? rep : 1;
    }
    int tokens[4];
    int currentIdx = 0;
    for (uint8_t i = 0; i < 4; i++) {
      int sp = mainParams.indexOf(' ', currentIdx);
      if (sp < 0) sp = mainParams.length();
      tokens[i] = mainParams.substring(currentIdx, sp).toInt();
      currentIdx = sp + 1;
    }
    qc.showload_time_1 = tokens[0];
    qc.showload_position_1 = tokens[1];
    qc.showload_time_2 = tokens[2];
    qc.showload_position_2 = tokens[3];
  } else if (cmdStr == "showloadn") {
    if (!parseShowLoadN(paramsStr, qc)) { Serial.println(F("CV showloadn")); return; }
  } else if (cmdStr == "showstart") {
    qc.messageType = SHOW_START;
    int lastSpace = paramsStr.lastIndexOf(' ');
    String mainParams = paramsStr;
    if (lastSpace > 0) {
      mainParams = paramsStr.substring(0, lastSpace);
      int rep = paramsStr.substring(lastSpace + 1).toInt();
      qc.repeat_count = rep > 0 ? rep : 1;
    }
    uint64_t ts_param = 0;
    int int_tokens[2] = {0, 0};
    int currentIdx = 0;
    for (uint8_t i = 0; i < 3; i++) {
      int sp = mainParams.indexOf(' ', currentIdx);
      if (sp < 0) sp = mainParams.length();
      String valStr = mainParams.substring(currentIdx, sp);
      if (i == 0) ts_param = atoll(valStr.c_str());
      else        int_tokens[i - 1] = atoi(valStr.c_str());
      currentIdx = sp + 1;
      if (currentIdx >= (int)mainParams.length() && i < 2) break;
    }
    qc.showstart_targetStartTime = ts_param;
    qc.showstart_numTargetsToFire = int_tokens[0];
    qc.showstart_showId = int_tokens[1];
  } else if (cmdStr == "play" || cmdStr == "stop" || cmdStr == "reset" || cmdStr == "pause") {
    if (cmdStr == "play")       qc.messageType = GENERIC_PLAY;
    else if (cmdStr == "stop")  qc.messageType = GENERIC_STOP;
    else if (cmdStr == "reset") qc.messageType = GENERIC_RESET;
    else                        qc.messageType = GENERIC_PAUSE;
    int lastSpace = paramsStr.lastIndexOf(' ');
    if (lastSpace > 0) {
      int rep = paramsStr.substring(lastSpace + 1).toInt();
      qc.repeat_count = rep > 0 ? rep : 1;
    }
  } else {
    Serial.println(F("C?UK"));
    return;
  }

  if (qc.messageType != 0) {
    enqueueCommand(qc);
    if (debugMode > 0) {
      Serial.print(F("C+ Q (repeat=")); Serial.print(qc.repeat_count); Serial.println(F(")"));
    }
  } else {
    Serial.println(F("C? PE"));
  }
}

// Dispatch one command from the queue. With ACK payloads, this is non-blocking
// in the sense that radio.write() returns within ~3ms (success) to ~22ms
// (all-retry failure) — no 150ms application-level wait, no busy-poll loop.
void dispatchOneCommand(uint64_t now) {
  if (isQueueEmpty()) return;

  QueuedCommand cmd;
  if (!dequeueCommand(cmd)) return;

  if (cmd.targetNodeID == 0 && cmd.messageType != CLOCK_SYNC) {
    Serial.print(F("WARN: cmd for N0 dropped, type=")); Serial.println(cmd.messageType);
    return;
  }

  bool gotAck = false;
  for (uint8_t r = 0; r < cmd.repeat_count && !gotAck; r++) {
    bool ok = false;
    switch (cmd.messageType) {
      case MANUAL_FIRE:
        ok = sendManualFire(cmd.targetNodeID, cmd.fire_position, now); break;
      case CLOCK_SYNC:
        ok = sendClockSync(cmd.targetNodeID, cmd.sync_timestamp, now); break;
      case START_LOAD:
        ok = sendStartLoad(cmd.targetNodeID, cmd.startload_numTargets, cmd.startload_showId, now); break;
      case SHOW_LOAD:
        ok = sendShowLoad(cmd.targetNodeID, cmd.showload_time_1, cmd.showload_position_1,
                          cmd.showload_time_2, cmd.showload_position_2, now); break;
      case SHOW_LOADN:
        ok = sendShowLoadN(cmd.targetNodeID, cmd.loadn_cues, cmd.loadn_count, now); break;
      case SHOW_START:
        ok = sendShowStart(cmd.targetNodeID, cmd.showstart_targetStartTime,
                           cmd.showstart_numTargetsToFire, cmd.showstart_showId, now); break;
      case GENERIC_PLAY:
      case GENERIC_STOP:
      case GENERIC_RESET:
      case GENERIC_PAUSE:
      case RESET_DVC:
        ok = sendGeneric(cmd.targetNodeID, cmd.messageType, now); break;
      default:
        Serial.print(F("ERR: unknown cmd type=")); Serial.println(cmd.messageType);
        return;
    }
    if (ok) gotAck = true;
  }
}

// TDMA-style poll: round-robin one receiver per pollInterval. The "poll"
// itself is just a CLOCK_SYNC — its ACK carries the receiver's status.
// This means status freshness is bounded by (numReceivers * pollInterval),
// and the master never bursts all syncs at once.
void maybePollNextReceiver(uint64_t now) {
  if (numReceivers == 0) return;
  // Spread one poll per (clockSyncIntervalMs / numReceivers).
  uint32_t pollSpacingMs = clockSyncIntervalMs / numReceivers;
  if (pollSpacingMs < 5) pollSpacingMs = 5;
  if (now - lastPollDispatchTime < pollSpacingMs) return;

  // Find the next receiver with a known nodeID.
  uint8_t tries = 0;
  while (tries < numReceivers) {
    if (nextPollReceiverIdx >= numReceivers) nextPollReceiverIdx = 0;
    ReceiverInfo &r = receivers[nextPollReceiverIdx];
    nextPollReceiverIdx++;
    tries++;
    if (r.nodeID == 0) continue;

    // Don't double-poll if there's already a queued command for this node;
    // the queued command's ACK will carry status. Advance to the next slot.
    bool alreadyQueued = false;
    int idx = cmdQueueHead;
    for (int k = 0; k < cmdQueueCount; k++) {
      if (commandBuffer[idx].targetNodeID == r.nodeID) { alreadyQueued = true; break; }
      idx = (idx + 1) % MAX_COMMANDS_IN_QUEUE;
    }
    if (alreadyQueued) continue;

    QueuedCommand qc = {0};
    qc.targetNodeID = r.nodeID;
    qc.messageType = CLOCK_SYNC;
    qc.sync_timestamp = 0;  // 0 = stamp at TX time
    qc.repeat_count = 1;
    enqueueCommand(qc);
    lastPollDispatchTime = now;
    return;
  }
}

void setup() {
  Serial.begin(115200);
  while (!Serial);
  delay(1000);

  serialBufferIndex = 0;
  serialLineBuffer[0] = '\0';

  SPI.begin(35, 33, 34);
  pinMode(RF_PIN, OUTPUT);
  pinMode(SWITCH_START_STOP_PIN, INPUT_PULLUP);
  pinMode(SWITCH_ARMING_PIN, INPUT_PULLUP);
  pinMode(SWITCH_MAN_FIRE_PIN, INPUT_PULLUP);

  setupLEDs();

  Serial.println(F("Initializing Radio..."));
  while (!radio.begin()) {
    Serial.println(F("ERROR: Radio hardware not responding!"));
    pixels.setPixelColor(5, COLOR_RED); pixels.show();
    delay(5000);
  }
  radio.setDataRate(RF24_250KBPS);
  radio.setPALevel(RF24_PA_MAX);
  radio.setChannel(rfChannel);
  // Retry config: 5 retries × 3.75ms ARD = ~22ms max blocking on a failed write.
  // Was (15,15) = ~64ms; ARD must be >= ACK packet on-air time, which at
  // 250kbps with a 32-byte ACK payload is ~1.3ms, so 3.75ms is plenty.
  radio.setRetries(15, 5);
  radio.setCRCLength(RF24_CRC_16);
  radio.setAutoAck(true);
  radio.setAutoAck(0, true);

  // Critical: enable dynamic payloads + ACK payloads. With these on, each
  // command write returns the receiver's status piggybacked in the ACK,
  // collapsing what used to be a 4-frame transaction into 2 frames.
  radio.enableDynamicPayloads();
  radio.enableAckPayload();

  radio.openReadingPipe(0, masterReadAddress());
  radio.startListening();

  Serial.println(F("M+ (RF24 Master Hub Online v4: ACK-payloads)"));

  for (int i = 0; i < NUM_PIXELS; i++) {
    pixels.setPixelColor(i, COLOR_GREEN); pixels.show(); delay(50);
    pixels.setPixelColor(i, COLOR_OFF); pixels.show();
  }
  pixels.setPixelColor(0, COLOR_GREEN);
  pixels.show();
  ledStates[0] = 1;
  for (int i = 1; i < NUM_PIXELS; i++) { ledStates[i] = 0; ledEffects[i] = 0; }

  Serial.setTimeout(1);
}

void loop() {
  uint64_t now = millis() + tsOffset;

  checkGpioStatus();
  updateLEDs();

  // Prune inactive receivers.
  for (uint8_t i = 0; i < numReceivers; ) {
    if ((now - receivers[i].lastMessageTime) > receiverInactivityTimeoutMs) {
      Serial.print(F("INFO: Pruning inactive receiver: ")); Serial.println(receivers[i].ident);
      for (uint8_t j = i; j < numReceivers - 1; ++j) receivers[j] = receivers[j + 1];
      numReceivers--;
    } else {
      i++;
    }
  }

  // Drain any unsolicited inbound frames (e.g. from legacy receivers that
  // haven't been upgraded yet, or ACK payloads we missed).
  while (radio.available()) {
    uint8_t buf[32];
    uint8_t msgSize = radio.getDynamicPayloadSize();
    if (msgSize == 0 || msgSize > sizeof(buf)) {
      radio.flush_rx();
      break;
    }
    radio.read(&buf, msgSize);
    if (msgSize > 0 && buf[0] == RECEIVER_STATUS) {
      ingestStatusFrame(buf, msgSize, now);
    } else if (msgSize > 0) {
      if (debugMode > 0) {
        Serial.print(F("WARN: unexpected inbound type=")); Serial.println(buf[0]);
      }
    }
  }

  // TDMA-style status polling — spreads one CLOCK_SYNC per slot across the
  // configured interval so all known receivers get updated regularly without
  // bursting.
  maybePollNextReceiver(now);

  // One queued command per loop iteration. radio.write() blocks at most
  // ~22ms on a failed write (5 retries × ~3.75ms ARD), and ~3ms on success.
  // No busy-poll, no inner timeout loop.
  if (!isQueueEmpty()) dispatchOneCommand(now);

  // Per-second status JSON for the host.
  if (now - lastPrintTime >= 1000) {
    lastPrintTime = now;
    DynamicJsonDocument doc(1024 + (numReceivers * 256));
    doc["timestamp"] = now;
    doc["q"] = cmdQueueCount;
    doc["fw"] = FW_VERSION;

    uint32_t totalLat = 0; int avgLat = 0;
    if (latencySampleCount > 0) {
      for (uint8_t i = 0; i < latencySampleCount; i++) totalLat += latencies[i];
      avgLat = round((float)totalLat / latencySampleCount);
    }
    doc["l"] = avgLat;

    JsonArray arr = doc.createNestedArray("receivers");
    for (uint8_t i = 0; i < numReceivers; i++) {
      JsonObject ro = arr.createNestedObject();
      ro["i"] = receivers[i].ident;
      ro["n"] = receivers[i].nodeID;
      ro["b"] = receivers[i].batteryLevel;
      ro["s"] = receivers[i].showId;
      ro["l"] = receivers[i].loadComplete ? 1 : 0;
      ro["r"] = receivers[i].startReady   ? 1 : 0;
      ro["t"] = receivers[i].lastMessageTime;

      uint32_t rsum = 0; int rAvg = 0;
      if (receivers[i].latencySampleCount > 0) {
        for (uint8_t k = 0; k < receivers[i].latencySampleCount; k++) rsum += receivers[i].latencies[k];
        rAvg = round((float)rsum / receivers[i].latencySampleCount);
      }
      ro["x"] = rAvg;
      ro["sp"] = calculateSuccessPercent(&receivers[i]);

      JsonArray ca = ro.createNestedArray("c");
      for (uint8_t j = 0; j < CONTINUITY_INDEX_CT; j++) ca.add(receivers[i].continuity[j]);
    }
    String out;
    serializeJson(doc, out);
    Serial.println(out);
  }

  // Non-blocking serial input.
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialBufferIndex > 0) {
        serialLineBuffer[serialBufferIndex] = '\0';
        String s = String(serialLineBuffer);
        processSerialCommand(s);
        serialBufferIndex = 0;
      }
      if (c == '\r' && Serial.available() > 0 && Serial.peek() == '\n') Serial.read();
    } else if (serialBufferIndex < (SERIAL_BUFFER_SIZE - 1)) {
      serialLineBuffer[serialBufferIndex++] = c;
    } else {
      serialBufferIndex = 0;
      if (debugMode > 0) Serial.println(F("WARN: Serial buffer overflow"));
    }
  }
}
