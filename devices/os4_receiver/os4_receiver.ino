#include <SPI.h>
#include <RF24.h>
#include <Adafruit_NeoPixel.h>

// FW_VERSION: Firmware version tracking for os4_receiver
// v1-v4: Historical versions (not documented, dates unknown)
// v5: Baseline version before tracking system (date unknown)
// v6: 2025-01-XX - Added FW_VERSION tracking system with version history comments
// v7: 2025-01-XX - Migrated from RF24Mesh to pure RF24 with deterministic addressing
// v8: previous baseline
// v9: 2026-04-XX - ACK-payload protocol overhaul (matches dongle FW v4):
//   * Status piggybacks in the auto-ACK FIFO (no separate sendStatus TX path)
//   * Dynamic payloads enabled
//   * Payload bounds-checked on receive
//   * ADDITIONAL_CLOCK_TX_OFFSET now applied to clock_offset
//   * Hot-path Serial prints gated behind DEBUG_PRINT
//   * Show-time LED animations are now non-blocking state machines so radio
//     servicing isn't stalled during them
//   * Configurable rf_channel and rf_system_id (compile-time, matches dongle)
//   * SHOW_LOADN handler (packed multi-cue load)
#define BOARD_VERISON 9
#define FW_VERSION 9
#define NODE_ID 157
const char RECEIVER_IDENT[] = "RX157";

const bool RECEIVER_USES_V1_CUES = false;

// Set to 1 for verbose serial logging (helpful for bringup, costs ms per cmd).
#define DEBUG_PRINT 0
#define DBG_PRINT(x)   do { if (DEBUG_PRINT) Serial.print(x);   } while (0)
#define DBG_PRINTLN(x) do { if (DEBUG_PRINT) Serial.println(x); } while (0)

#if BOARD_VERISON >= 6
  #define RF24_CE_PIN 37
  #define RF24_CSN_PIN 36
#else
  #define RF24_CE_PIN 34
  #define RF24_CSN_PIN 33
#endif

#define FIRE_MS_DURATION 1000

#define LED_PIN 11
#define STATUS_LED_PIN 17
#define STATUS_LED_COUNT 3
#define BATT_VOLTAGE_PIN 3
#define BOARD_CT_PIN 2
int NUM_BOARDS = 1;
int NUM_LEDS = (8 * NUM_BOARDS);

#define SHIFT_OUT_CLOCK 10
#define SHIFT_OUT_LATCH 9
#define SHIFT_OUT_OE 13
#define SHIFT_OUT_DATA 7

#define SHIFT_IN_CLOCK 6
#define SHIFT_IN_LATCH 5
#define SHIFT_IN_DATA 12

const uint16_t INPUT_MODE_INTERVAL = 100;
const uint16_t RX_MESSAGE_FADE_TIME_MS = 1500;
const uint16_t SYNC_LED_FADE_TIME_MS = 1250;

// How often to refresh the ACK payload even without a command, so battery /
// continuity samples stay reasonably fresh. The post-command refresh always
// runs immediately too.
const uint32_t ACK_PAYLOAD_REFRESH_MS = 250;

bool targetFiring[128] = { false };
uint64_t fireStartTime[128] = { 0 };
bool targetFired[128] = { false };

bool gotCommand = false;
bool everConnected = false;
uint64_t lastCmdReceived = 0;
uint64_t lastInputModeRunTime = 0;
uint64_t lastMessageReceivedTime = 0;
uint64_t lastAckPayloadRefresh = 0;

Adafruit_NeoPixel strip(NUM_LEDS, LED_PIN, NEO_GRB + NEO_KHZ800);
Adafruit_NeoPixel statusStrip(STATUS_LED_COUNT, STATUS_LED_PIN, NEO_GRB + NEO_KHZ800);

uint32_t COLOR_CONT_NEEDED = strip.Color(180, 0, 0);
uint32_t COLOR_CONT_ACHIEVED = strip.Color(0, 175, 0);
uint32_t COLOR_CONT_AVAIL = strip.Color(0, 0, 175);
uint32_t COLOR_FIRING = strip.Color(200, 200, 0);
uint32_t COLOR_FIRED = strip.Color(0, 0, 255);

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
  SHOW_LOADN      = 11,
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

struct ReceiverStatusMessage {
  uint8_t type;
  uint8_t nodeID;
  uint8_t batteryLevel;
  uint16_t showState;
  char ident[10];
  uint64_t cont64_0;
  uint64_t cont64_1;
} __attribute__((packed));

// Non-blocking show-time LED animation state machine. Declared near the top
// of the file so Arduino's auto-prototype generator sees the enum before it
// emits prototypes for functions that reference it.
enum AnimType { ANIM_NONE = 0, ANIM_PULSING_YELLOW, ANIM_FLASHING_PURPLE, ANIM_SMOOTH_WAVE, ANIM_SMOOTHER_SWEEP };
AnimType currentAnim = ANIM_NONE;
uint32_t animStartMs = 0;

RF24 radio(RF24_CE_PIN, RF24_CSN_PIN);

// Must match the dongle scheme. With rfSystemId == 0 (default) the addresses
// are byte-identical to the pre-v9 receiver firmware, so a v9 receiver can
// still talk to either a v3 or v4 dongle on the same channel.
const uint8_t rfChannel = 85;
const uint8_t rfSystemId = 0;
#define MASTER_WRITE_BASE 0x0000000000ULL
#define RECEIVER_BASE     0x0000000001ULL
static inline uint64_t systemSalt() {
  return ((uint64_t)rfSystemId) << 32;
}
static inline uint64_t masterWriteAddress() {
  return MASTER_WRITE_BASE | systemSalt();
}
static inline uint64_t receiverReadAddress() {
  return RECEIVER_BASE | systemSalt() | (uint64_t)NODE_ID;
}

// ADDITIONAL_CLOCK_TX_OFFSET (ms): empirical compensation for the time between
// the dongle stamping the timestamp and the receiver applying it. Tune by
// observing show-firing alignment between receivers.
const int64_t ADDITIONAL_CLOCK_TX_OFFSET = 2;

int64_t clock_offset = 0;
uint32_t targetTimes[257];
bool targetLoaded[257];
uint8_t expectedTargets = 0;
uint16_t currentShowId = 0;
bool loadComplete = false;
bool startReady = false;
uint64_t showStartTime = 0;
uint64_t showPauseTimeAcc = 0;

bool isPlaying = false;
bool isPaused = false;
uint64_t timePaused = 0;

uint64_t syncFlashStartTime = 0;
bool fireChanged = false;

// (AnimType enum + state declared near the top of the file so Arduino's
// auto-prototype generator sees it. The boot-time animations testLEDStrip*
// are still blocking — that's fine, they only run once at power-up. The
// runtime ones used to block 1–2 seconds inside the radio loop; now they're
// frame-driven by updateNonBlockingAnim() which the main loop calls every
// iteration.)

void zeroTargets() {
  memset(targetTimes, 0, sizeof(targetTimes));
  memset(targetLoaded, 0, sizeof(targetLoaded));
  memset(targetFiring, 0, sizeof(targetFiring));
  memset(fireStartTime, 0, sizeof(fireStartTime));
  memset(targetFired, 0, sizeof(targetFired));
}

uint64_t getSynchronizedTime() {
  return ((uint64_t)millis()) + clock_offset;
}

void requestAnim(AnimType a) {
  currentAnim = a;
  animStartMs = millis();
}

// Non-blocking animation tick. Returns true if it touched the strip this frame
// (caller already calls strip.show() at end if needed).
bool updateNonBlockingAnim() {
  if (currentAnim == ANIM_NONE) return false;
  uint32_t elapsed = millis() - animStartMs;

  switch (currentAnim) {
    case ANIM_PULSING_YELLOW: {
      // Three pulses, ~200ms each (in/out together = 200ms), total 600ms.
      const uint32_t TOTAL = 600;
      if (elapsed >= TOTAL) { strip.clear(); strip.show(); currentAnim = ANIM_NONE; return true; }
      uint32_t cyc = elapsed % 200;
      uint8_t b = (cyc < 100) ? (uint8_t)((cyc * 255) / 100) : (uint8_t)(((200 - cyc) * 255) / 100);
      for (int i = 0; i < NUM_LEDS; i++) strip.setPixelColor(i, strip.Color(b, b, 0));
      strip.show();
      return true;
    }
    case ANIM_FLASHING_PURPLE: {
      // 1 second of 50ms-on / 50ms-off purple.
      const uint32_t TOTAL = 1000;
      if (elapsed >= TOTAL) { strip.clear(); strip.show(); currentAnim = ANIM_NONE; return true; }
      bool on = ((elapsed / 50) % 2) == 0;
      uint32_t color = on ? strip.Color(128, 0, 128) : 0;
      for (int i = 0; i < NUM_LEDS; i++) strip.setPixelColor(i, color);
      strip.show();
      return true;
    }
    case ANIM_SMOOTH_WAVE: {
      // Sky-blue wave sweep. 50ms per "centerLed" step. NUM_LEDS + 2*GRADIENT_STEPS steps.
      const int GRADIENT_STEPS = 5;
      const uint32_t STEP_MS = 50;
      int totalSteps = NUM_LEDS + 2 * GRADIENT_STEPS;
      uint32_t step = elapsed / STEP_MS;
      if ((int)step >= totalSteps) { strip.clear(); strip.show(); currentAnim = ANIM_NONE; return true; }
      int centerLed = -GRADIENT_STEPS + (int)step;
      strip.clear();
      uint32_t skyBlue = strip.Color(0, 100, 255);
      if (centerLed >= 0 && centerLed < NUM_LEDS) strip.setPixelColor(centerLed, skyBlue);
      for (int i = 1; i <= GRADIENT_STEPS; i++) {
        int li = centerLed - i;
        if (li >= 0 && li < NUM_LEDS) {
          uint8_t br = 255 * (GRADIENT_STEPS - i) / GRADIENT_STEPS;
          strip.setPixelColor(li, strip.Color(0, (100 * br) / 255, br));
        }
        int ri = centerLed + i;
        if (ri >= 0 && ri < NUM_LEDS) {
          uint8_t br = 255 * (GRADIENT_STEPS - i) / GRADIENT_STEPS;
          strip.setPixelColor(ri, strip.Color(0, (100 * br) / 255, br));
        }
      }
      strip.show();
      return true;
    }
    case ANIM_SMOOTHER_SWEEP: {
      // Two sweeps (green then blue), 15ms per step, NUM_LEDS+TAIL steps each.
      const int TAIL = 4;
      const uint32_t STEP_MS = 15;
      int stepsPerSweep = NUM_LEDS + TAIL;
      uint32_t step = elapsed / STEP_MS;
      if ((int)step >= stepsPerSweep * 2) { strip.clear(); strip.show(); currentAnim = ANIM_NONE; return true; }
      bool secondHalf = (int)step >= stepsPerSweep;
      int local = secondHalf ? ((int)step - stepsPerSweep) : (int)step;
      int head = -TAIL + local;
      strip.clear();
      for (int t = 0; t <= TAIL; t++) {
        int li = head - t;
        if (li >= 0 && li < NUM_LEDS) {
          uint8_t br = 255 * (TAIL - t) / TAIL;
          if (secondHalf) strip.setPixelColor(li, strip.Color(0, 0, (210 * br) / 255));
          else            strip.setPixelColor(li, strip.Color(0, (210 * br) / 255, 0));
        }
      }
      strip.show();
      return true;
    }
    default: currentAnim = ANIM_NONE; return false;
  }
}

void handleManualFire(ManualFireMessage* msg) {
  DBG_PRINT("Manual Fire: position ");
  DBG_PRINTLN(msg->position);
  fireTarget(msg->position);
}

void handleClockSync(ClockSyncMessage* msg) {
  // Apply ADDITIONAL_CLOCK_TX_OFFSET to compensate for the residual TX-to-RX
  // latency that was previously unaccounted for.
  uint64_t localTime64 = (uint64_t)millis();
  clock_offset = (int64_t)msg->timestamp - (int64_t)localTime64 + ADDITIONAL_CLOCK_TX_OFFSET;
}

void handleStartLoad(StartLoadMessage* msg) {
  resetSystem();
  expectedTargets = msg->numTargetsToFire;
  currentShowId = msg->showId;
  zeroTargets();
  DBG_PRINT("Begin show load: show ");
  DBG_PRINT(currentShowId);
  DBG_PRINT(", expecting ");
  DBG_PRINT(expectedTargets);
  DBG_PRINTLN(" targets.");
}

// Bounds-checked single-cue add (used by both SHOW_LOAD and SHOW_LOADN).
void loadOneCue(uint32_t time, uint8_t position) {
  if (position >= 128) return;
  if (position > (NUM_BOARDS * 8)) {
    DBG_PRINTLN("LOAD ERR: TARGET EXCEEDS AVAILABLE.");
    return;
  }
  if (time == 0) return;
  targetTimes[position] = time;
  targetLoaded[position] = true;
}

void recheckLoadComplete() {
  uint8_t cnt = 0;
  for (uint8_t i = 0; i < 128; i++) if (targetLoaded[i]) cnt++;
  if (cnt >= expectedTargets) {
    if (!loadComplete) DBG_PRINTLN("Show load complete.");
    loadComplete = true;
  }
}

void handleShowLoad(ShowLoadMessage* msg) {
  loadOneCue(msg->time_1, msg->position_1);
  loadOneCue(msg->time_2, msg->position_2);
  recheckLoadComplete();
}

void handleShowLoadN(ShowLoadNMessage* msg, uint8_t msgSize) {
  uint8_t count = msg->count;
  if (count > SHOW_LOADN_MAX_CUES) count = SHOW_LOADN_MAX_CUES;
  // Each cue is sizeof(ShowLoadNCue); the wire size is 2 + count*sizeof(cue).
  uint8_t expected = 2 + count * sizeof(ShowLoadNCue);
  if (msgSize < expected) {
    DBG_PRINTLN("ShowLoadN: short payload");
    return;
  }
  for (uint8_t i = 0; i < count; i++) {
    loadOneCue(msg->cues[i].time, msg->cues[i].position);
  }
  recheckLoadComplete();
}

void handleShowStart(ShowStartMessage* msg) {
  if (msg->showId == currentShowId && loadComplete) {
    startReady = true;
    showStartTime = msg->targetStartTime;
    DBG_PRINT("Show Start confirmed. start=");
    DBG_PRINTLN((uint32_t)showStartTime);
  } else {
    DBG_PRINTLN("Show Start rejected.");
  }
}

void resetSystem() {
  expectedTargets = 0;
  currentShowId = 0;
  loadComplete = false;
  startReady = false;
  showStartTime = 0;
  zeroTargets();
}

void fireTarget(uint8_t target_pos) {
  targetFiring[target_pos] = true;
  fireStartTime[target_pos] = millis();
  refreshFiring();
}

void handleGeneric(GenericMessage* msg) {
  switch (msg->type) {
    case GENERIC_PLAY:
      if (isPlaying) { DBG_PRINTLN("dup play"); break; }
      isPlaying = true;
      if (isPaused) {
        showPauseTimeAcc = showPauseTimeAcc + (getSynchronizedTime() - timePaused);
        timePaused = 0;
      }
      isPaused = false;
      break;
    case GENERIC_STOP:
      isPlaying = false;
      break;
    case GENERIC_RESET:
      resetSystem();
      break;
    case GENERIC_PAUSE:
      isPlaying = false;
      isPaused = true;
      timePaused = getSynchronizedTime();
      break;
    default:
      DBG_PRINTLN("Unknown Generic Cmd");
      break;
  }
}

// Calculate battery level (returns 5-253).
uint8_t calculateBatteryLevel() {
  int bval = analogRead(BATT_VOLTAGE_PIN) / 2;
  if (bval > 3700)      return 253;
  else if (bval < 2350) return 5;
  else                  return ((bval - 2320) / 15.38) * 2.5;
}

void getBatteryColorRGB(uint8_t batteryLevel, uint8_t *r, uint8_t *g, uint8_t *b) {
  uint16_t level = batteryLevel - 5;
  if (level < 124) {
    *r = 255;
    *g = (level * 255) / 124;
    *b = 0;
  } else {
    *r = 255 - ((level - 124) * 255) / 124;
    *g = 255;
    *b = 0;
  }
}

// Build a fresh ReceiverStatusMessage capturing current state. This is the
// payload that piggybacks in the next auto-ACK back to the dongle.
void buildStatus(ReceiverStatusMessage* msg) {
  uint8_t bval = calculateBatteryLevel();
  msg->type = RECEIVER_STATUS;
  msg->nodeID = NODE_ID;
  msg->batteryLevel = bval;

  uint16_t s = currentShowId & 0x3FFF;
  if (loadComplete) s |= (1 << 14);
  if (startReady)   s |= (1 << 15);
  msg->showState = s;
  strncpy(msg->ident, RECEIVER_IDENT, sizeof(msg->ident));
  msg->ident[sizeof(msg->ident) - 1] = '\0';

  uint8_t shiftInput[NUM_BOARDS];
  readInputShiftRegister(shiftInput, NUM_BOARDS);
  msg->cont64_0 = 0;
  msg->cont64_1 = 0;
  for (uint8_t i = 0; i < 8; i++) {
    if (i < NUM_BOARDS) msg->cont64_0 |= ((uint64_t)shiftInput[i]) << (i * 8);
  }
  for (uint8_t i = 0; i < 8; i++) {
    uint8_t boardIdx = i + 8;
    if (boardIdx < NUM_BOARDS) msg->cont64_1 |= ((uint64_t)shiftInput[boardIdx]) << (i * 8);
  }
}

// Refresh the ACK-payload FIFO so the next incoming command's auto-ACK carries
// fresh status. Call after every command processed and periodically.
void refreshAckPayload() {
  ReceiverStatusMessage msg;
  buildStatus(&msg);
  // writeAckPayload silently drops if FIFO is full; we keep the FIFO at 1 by
  // refreshing only after a command is consumed (which frees a slot) plus a
  // periodic refresh that's harmless if the slot is still occupied.
  radio.writeAckPayload(0, &msg, sizeof(msg));
  lastAckPayloadRefresh = millis();
}

void sendToShiftRegister(uint64_t pos1, uint64_t pos2) {}

void runPlayLoop() {
  if (isPlaying && !isPaused) {
    uint64_t now = getSynchronizedTime();
    now = now - showPauseTimeAcc;
    if (now > showStartTime) {
      uint64_t elapsed = now - showStartTime;

      for (uint8_t i = 0; i < 128; i++) {
        if (targetLoaded[i]) {
          if (!targetFiring[i] && !targetFired[i] && elapsed >= targetTimes[i]) {
            targetFiring[i] = true;
            fireStartTime[i] = millis();
            targetFired[i] = true;
            fireChanged = true;
          } else if (targetFiring[i]) {
            if (millis() - fireStartTime[i] >= FIRE_MS_DURATION) {
              targetFiring[i] = false;
              fireChanged = true;
            }
          }
        }
      }

      if (fireChanged) {
        refreshFiring();
        fireChanged = false;
      }

      bool allFired = true;
      for (uint8_t i = 0; i < 128; i++) {
        if (targetLoaded[i] && !targetFired[i]) { allFired = false; break; }
      }

      if (allFired) {
        isPlaying = false;
        startReady = false;
        currentShowId = 0;
        requestAnim(ANIM_PULSING_YELLOW);
        DBG_PRINTLN("Show complete.");
      }
    }
  }
}

// Boot-time animations (still blocking — only run once at power-up).
void testLEDStrip() {
  for (int i = 0; i < NUM_LEDS; i++) {
    strip.clear();
    if (i > 3) {
      strip.setPixelColor(i - 3, strip.Color(0, 40, 0));
      strip.setPixelColor(i - 2, strip.Color(0, 80, 0));
      strip.setPixelColor(i - 1, strip.Color(0, 130, 0));
    }
    strip.setPixelColor(i, strip.Color(0, 210, 0));
    strip.show();
    delay(30);
  }
  for (int i = 0; i < NUM_LEDS; i++) {
    strip.clear();
    if (i > 3) {
      strip.setPixelColor(i - 3, strip.Color(0, 0, 20));
      strip.setPixelColor(i - 2, strip.Color(0, 0, 60));
      strip.setPixelColor(i - 1, strip.Color(0, 0, 130));
    }
    strip.setPixelColor(i, strip.Color(0, 0, 210));
    strip.show();
    delay(30);
  }
  strip.clear();
  strip.show();
}

void testLEDStrip_pulsingGreen() {
  int pulseDuration = 2000 / 3;
  int steps = 40;
  int delayTime = (pulseDuration / 2) / steps;
  for (int p = 0; p < 3; p++) {
    for (int j = 0; j <= steps; j++) {
      uint8_t b = (j * 255) / steps;
      for (int i = 0; i < NUM_LEDS; i++) strip.setPixelColor(i, strip.Color(0, b, 0));
      strip.show();
      delay(delayTime);
    }
    for (int j = steps; j >= 0; j--) {
      uint8_t b = (j * 255) / steps;
      for (int i = 0; i < NUM_LEDS; i++) strip.setPixelColor(i, strip.Color(0, b, 0));
      strip.show();
      delay(delayTime);
    }
  }
  strip.clear();
  strip.show();
}

void statusLEDStartupSequence() {
  int purpleSteps = 50;
  int purpleDelay = 15;
  for (int j = 0; j <= purpleSteps; j++) {
    uint8_t b = (j * 255) / purpleSteps;
    for (int i = 0; i < STATUS_LED_COUNT; i++) statusStrip.setPixelColor(i, statusStrip.Color(b, 0, b));
    statusStrip.show();
    delay(purpleDelay);
  }
  for (int j = purpleSteps; j >= 0; j--) {
    uint8_t b = (j * 255) / purpleSteps;
    for (int i = 0; i < STATUS_LED_COUNT; i++) statusStrip.setPixelColor(i, statusStrip.Color(b, 0, b));
    statusStrip.show();
    delay(purpleDelay);
  }
  statusStrip.clear();
  statusStrip.show();
  delay(100);

  uint8_t batteryLevel = calculateBatteryLevel();
  uint8_t threshold1 = 5 + 82;
  uint8_t threshold2 = 5 + 165;
  uint8_t numLEDsToLight = 1;
  if (batteryLevel >= threshold2)      numLEDsToLight = 3;
  else if (batteryLevel >= threshold1) numLEDsToLight = 2;
  else                                 numLEDsToLight = 1;

  uint8_t batR, batG, batB;
  getBatteryColorRGB(batteryLevel, &batR, &batG, &batB);

  int batSteps = 30;
  int batDelay = 5;
  for (int j = 0; j <= batSteps; j++) {
    uint8_t b = (j * 255) / batSteps;
    statusStrip.clear();
    for (int i = 0; i < numLEDsToLight; i++) {
      statusStrip.setPixelColor(i, statusStrip.Color((batR * b) / 255, (batG * b) / 255, (batB * b) / 255));
    }
    statusStrip.show();
    delay(batDelay);
  }

  delay(1500);

  int whiteSteps = 50;
  int whiteDelay = 30;
  for (int j = 0; j <= whiteSteps; j++) {
    uint8_t b = (j * 255) / whiteSteps;
    for (int i = 0; i < STATUS_LED_COUNT; i++) statusStrip.setPixelColor(i, statusStrip.Color(b, b, b));
    statusStrip.show();
    delay(whiteDelay);
  }

  statusStrip.clear();
  statusStrip.show();
}

void updateStatusLEDs() {
  uint64_t now = getSynchronizedTime();
  uint64_t currentMillis = millis();

  if (lastMessageReceivedTime > 0) {
    uint64_t timeSinceMessage = currentMillis - lastMessageReceivedTime;
    uint16_t totalFadeDuration = 100 + RX_MESSAGE_FADE_TIME_MS;
    if (timeSinceMessage < 100) {
      statusStrip.setPixelColor(0, statusStrip.Color(255, 255, 255));
    } else if (timeSinceMessage < totalFadeDuration) {
      uint16_t fadeTime = timeSinceMessage - 100;
      uint8_t b = 255 - ((fadeTime * 255) / RX_MESSAGE_FADE_TIME_MS);
      statusStrip.setPixelColor(0, statusStrip.Color(b, b, b));
    } else {
      statusStrip.setPixelColor(0, statusStrip.Color(0, 0, 0));
      lastMessageReceivedTime = 0;
    }
  } else {
    statusStrip.setPixelColor(0, statusStrip.Color(0, 0, 0));
  }

  uint8_t batteryLevel = calculateBatteryLevel();
  uint8_t batR, batG, batB;
  getBatteryColorRGB(batteryLevel, &batR, &batG, &batB);

  if (isPlaying) {
    statusStrip.setPixelColor(1, statusStrip.Color(128, 0, 128));
    syncFlashStartTime = 0;
  } else {
    uint16_t lst = 2000;
    uint16_t flashTime = 100;
    if (startReady) flashTime = 400;
    uint64_t cyclePos = now % lst;
    if (cyclePos >= (lst - flashTime)) {
      if (syncFlashStartTime == 0 || (now - syncFlashStartTime) >= SYNC_LED_FADE_TIME_MS) {
        syncFlashStartTime = now;
      }
    }
    uint8_t brightness = 0;
    if (syncFlashStartTime > 0) {
      uint64_t fadeElapsed = now - syncFlashStartTime;
      if (fadeElapsed < SYNC_LED_FADE_TIME_MS) {
        brightness = 255 - ((fadeElapsed * 255) / SYNC_LED_FADE_TIME_MS);
      } else {
        brightness = 0;
        syncFlashStartTime = 0;
      }
    }
    if (brightness > 0) {
      statusStrip.setPixelColor(1, statusStrip.Color(
        (batR * brightness) / 255,
        (batG * brightness) / 255,
        (batB * brightness) / 255));
    } else {
      statusStrip.setPixelColor(1, statusStrip.Color(0, 0, 0));
    }
  }

  if (expectedTargets > 0 && !loadComplete) {
    statusStrip.setPixelColor(2, statusStrip.Color(255, 165, 0));
  } else if (loadComplete && !startReady) {
    statusStrip.setPixelColor(2, statusStrip.Color(0, 255, 255));
  } else if (isPlaying && now < showStartTime) {
    statusStrip.setPixelColor(2, statusStrip.Color(255, 0, 255));
  } else if (isPlaying && now >= showStartTime) {
    statusStrip.setPixelColor(2, statusStrip.Color(255, 255, 255));
  } else {
    statusStrip.setPixelColor(2, statusStrip.Color(0, 0, 0));
  }

  statusStrip.show();
}

void setBoardCount() {
  int targetY = analogRead(BOARD_CT_PIN);
  if (targetY > 8000) {
    NUM_BOARDS = 1;
    NUM_LEDS = (8 * NUM_BOARDS);
    DBG_PRINTLN("No Cue board detected. Defaulting to 1");
  } else {
    if      (targetY < 1000) NUM_BOARDS = 1;
    else if (targetY < 1900) NUM_BOARDS = 2;
    else if (targetY < 2500) NUM_BOARDS = 3;
    else if (targetY < 3150) NUM_BOARDS = 4;
    else if (targetY < 3500) NUM_BOARDS = 5;
    else if (targetY < 4000) NUM_BOARDS = 6;
    else if (targetY < 4400) NUM_BOARDS = 7;
    else                     NUM_BOARDS = 8;
    NUM_LEDS = (8 * NUM_BOARDS);
  }
}

void myShiftOut(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder, uint8_t val) {
  for (uint8_t i = 0; i < 8; i++) {
    if (bitOrder == LSBFIRST) digitalWrite(dataPin, !!(val & (1 << i)));
    else                      digitalWrite(dataPin, !!(val & (1 << (7 - i))));
    delayMicroseconds(30);
    digitalWrite(clockPin, HIGH);
    delayMicroseconds(30);
    digitalWrite(clockPin, LOW);
    delayMicroseconds(30);
  }
}

void writeOutputShiftRegister(uint8_t targets[], size_t numTargets) {
  uint8_t numBytes = NUM_BOARDS;
  uint8_t shiftData[numBytes];
  memset(shiftData, 0, numBytes);

  for (size_t i = 0; i < numTargets; i++) {
    uint8_t index = targets[i];
    uint8_t boardIndex = index / 8;
    uint8_t position = index % 8;
    if (boardIndex >= NUM_BOARDS) continue;
    shiftData[boardIndex] |= (1 << position);
  }

  if (BOARD_VERISON >= 8) digitalWrite(SHIFT_OUT_OE, HIGH);
  else                    digitalWrite(SHIFT_OUT_OE, LOW);
  digitalWrite(SHIFT_OUT_LATCH, LOW);
  for (int i = NUM_BOARDS - 1; i >= 0; i--) {
    myShiftOut(SHIFT_OUT_DATA, SHIFT_OUT_CLOCK, MSBFIRST, shiftData[i]);
  }
  digitalWrite(SHIFT_OUT_LATCH, HIGH);
}

void latchShiftRegister() {
  digitalWrite(SHIFT_IN_LATCH, LOW);
  delayMicroseconds(30);
  digitalWrite(SHIFT_IN_LATCH, HIGH);
  delayMicroseconds(30);
}

void readInputShiftRegister(uint8_t *buffer, uint8_t numBytes) {
  latchShiftRegister();
  for (int i = numBytes - 1; i >= 0; i--) {
    uint8_t pos = numBytes - i - 1;
    buffer[pos] = 0;
    for (int bit = 7; bit >= 0; bit--) {
      uint8_t reading = digitalRead(SHIFT_IN_DATA);
      if (RECEIVER_USES_V1_CUES) {
        if (NUM_BOARDS % 2 == 1 && i % 2 == 1) reading = !reading;
        else if (NUM_BOARDS % 2 == 0 && i % 2 == 0) reading = !reading;
      }
      if (reading) buffer[pos] |= (1 << bit);
      digitalWrite(SHIFT_IN_CLOCK, HIGH);
      delayMicroseconds(20);
      digitalWrite(SHIFT_IN_CLOCK, LOW);
      delayMicroseconds(20);
    }
  }
}

uint8_t inputPinToBitPosition(uint8_t physicalPin) { return physicalPin - 1; }
uint8_t bitPositionToInputPin(uint8_t bitPosition) { return bitPosition + 1; }

void displayInputStates(uint8_t *shiftInput) {
  for (int i = 0; i < NUM_LEDS; i++) strip.setPixelColor(i, 0);
  for (int boardIndex = 0; boardIndex < NUM_BOARDS; boardIndex++) {
    for (int bitPosition = 0; bitPosition < 8; bitPosition++) {
      uint8_t physicalPin = bitPositionToInputPin(bitPosition);
      uint8_t ledIndex = (boardIndex * 8) + (physicalPin - 1);
      if (targetFiring[ledIndex]) {
        strip.setPixelColor(ledIndex, COLOR_FIRING);
      } else if (targetFired[ledIndex]) {
        strip.setPixelColor(ledIndex, COLOR_FIRED);
      } else {
        if (shiftInput[boardIndex] & (1 << bitPosition)) {
          if (targetLoaded[(boardIndex * 8) + bitPosition]) strip.setPixelColor(ledIndex, COLOR_CONT_ACHIEVED);
          else                                              strip.setPixelColor(ledIndex, COLOR_CONT_AVAIL);
        } else if (targetLoaded[(boardIndex * 8) + bitPosition]) {
          strip.setPixelColor(ledIndex, COLOR_CONT_NEEDED);
        }
      }
    }
  }
  strip.show();
}

void refreshFiring() {
  int targetCount = 0;
  for (int i = 0; i < 128; i++) if (targetFiring[i]) targetCount++;
  uint8_t targets[targetCount > 0 ? targetCount : 1];
  int index = 0;
  for (int i = 0; i < 128; i++) {
    if (targetFiring[i]) {
      if (i < NUM_LEDS) strip.setPixelColor(i, COLOR_FIRING);
      targets[index++] = i;
    }
  }
  strip.show();
  writeOutputShiftRegister(targets, targetCount);
}

void handleInputMode() {
  // While a non-blocking animation is playing, leave the strip alone — the
  // animation owns it. Status is still serviced separately.
  if (currentAnim != ANIM_NONE) return;
  uint8_t shiftInput[NUM_BOARDS];
  readInputShiftRegister(shiftInput, NUM_BOARDS);
  displayInputStates(shiftInput);
}

void setup() {
  pinMode(SHIFT_OUT_OE, OUTPUT);
  if (BOARD_VERISON >= 8) digitalWrite(SHIFT_OUT_OE, LOW);
  else                    digitalWrite(SHIFT_OUT_OE, HIGH);

  pinMode(SHIFT_OUT_CLOCK, OUTPUT);
  pinMode(SHIFT_OUT_LATCH, OUTPUT);
  pinMode(SHIFT_OUT_DATA, OUTPUT);

  digitalWrite(SHIFT_OUT_LATCH, LOW);
  for (int i = 7; i >= 0; i--) myShiftOut(SHIFT_OUT_DATA, SHIFT_OUT_CLOCK, MSBFIRST, 0);
  digitalWrite(SHIFT_OUT_LATCH, HIGH);

  if (BOARD_VERISON >= 8) digitalWrite(SHIFT_OUT_OE, HIGH);
  else                    digitalWrite(SHIFT_OUT_OE, LOW);

  Serial.begin(115200);
  delay(1000);

  setBoardCount();

  pinMode(SHIFT_IN_CLOCK, OUTPUT);
  pinMode(SHIFT_IN_LATCH, OUTPUT);
  pinMode(SHIFT_IN_DATA, INPUT);

  Serial.print(F("Board Version: ")); Serial.println(BOARD_VERISON);
  Serial.print(F("FW Version: "));    Serial.println(FW_VERSION);
  Serial.print(F("Ident: "));         Serial.println(RECEIVER_IDENT);

  statusStrip.begin();
  statusStrip.clear();
  statusStrip.show();
  statusLEDStartupSequence();

  strip.begin();
  strip.clear();
  strip.show();
  strip.updateLength(NUM_LEDS);

  testLEDStrip();

  if (BOARD_VERISON < 6) SPI.begin(36, 37, 35);
  else                   SPI.begin(35, 33, 34);

  while (!radio.begin()) {
    Serial.println(F("ERROR: Radio not responding!"));
    delay(5000);
  }
  radio.setDataRate(RF24_250KBPS);
  if (BOARD_VERISON < 6) radio.setPALevel(RF24_PA_HIGH);
  else                   radio.setPALevel(RF24_PA_MAX);
  radio.setChannel(rfChannel);
  radio.setRetries(15, 5);
  radio.setCRCLength(RF24_CRC_16);
  radio.setAutoAck(true);
  radio.setAutoAck(0, true);

  // Enable dynamic payloads + ACK payloads. The receiver pre-loads its status
  // into the ACK FIFO; the dongle reads it back as the response to each cmd.
  radio.enableDynamicPayloads();
  radio.enableAckPayload();

  pinMode(15, OUTPUT);

  radio.openReadingPipe(0, receiverReadAddress());
  radio.startListening();

  Serial.print(F("Receiver address: 0x"));
  Serial.println((uint32_t)receiverReadAddress(), HEX);

  zeroTargets();
  testLEDStrip_pulsingGreen();
  Serial.println(F("SUCCESS: Receiver started!"));
  Serial.print(F("My name is "));
  Serial.println(RECEIVER_IDENT);

  // Pre-load an initial ACK payload so the very first command we receive can
  // ACK back with current status.
  refreshAckPayload();
}

void loop() {
  runPlayLoop();

  uint64_t now = getSynchronizedTime();

  while (radio.available()) {
    uint8_t buf[32];
    uint8_t msgSize = radio.getDynamicPayloadSize();
    if (msgSize == 0 || msgSize > sizeof(buf)) {
      // Corrupted dynamic payload size — flush and bail.
      radio.flush_rx();
      break;
    }
    radio.read(&buf, msgSize);
    uint8_t mType = buf[0];
    gotCommand = true;
    everConnected = true;
    lastMessageReceivedTime = millis();

    // Bounds-check each message struct against the wire size before casting.
    switch (mType) {
      case MANUAL_FIRE:
        if (msgSize >= sizeof(ManualFireMessage)) handleManualFire((ManualFireMessage*)buf);
        break;
      case CLOCK_SYNC:
        if (msgSize >= sizeof(ClockSyncMessage)) handleClockSync((ClockSyncMessage*)buf);
        break;
      case START_LOAD:
        if (msgSize >= sizeof(StartLoadMessage)) handleStartLoad((StartLoadMessage*)buf);
        break;
      case SHOW_LOAD:
        if (msgSize >= sizeof(ShowLoadMessage)) handleShowLoad((ShowLoadMessage*)buf);
        break;
      case SHOW_LOADN:
        if (msgSize >= 2) handleShowLoadN((ShowLoadNMessage*)buf, msgSize);
        break;
      case SHOW_START:
        if (msgSize >= sizeof(ShowStartMessage)) handleShowStart((ShowStartMessage*)buf);
        break;
      case GENERIC_PLAY:
      case GENERIC_STOP:
      case GENERIC_RESET:
      case GENERIC_PAUSE:
        if (msgSize >= sizeof(GenericMessage)) handleGeneric((GenericMessage*)buf);
        break;
      case RESET_DVC:
        resetSystem();
        break;
      default:
        DBG_PRINT("Unknown message type: ");
        DBG_PRINTLN(mType);
        break;
    }

    // Refresh the ACK payload immediately so the next command's auto-ACK
    // carries fresh status. This replaces the old sendStatus() TX pattern.
    refreshAckPayload();

    // Trigger non-blocking decorative animations on certain commands.
    if (mType == SHOW_START)         requestAnim(ANIM_SMOOTH_WAVE);
    else if (mType == GENERIC_RESET) requestAnim(ANIM_SMOOTHER_SWEEP);

    lastCmdReceived = now;
  }

  // Periodic ACK payload refresh so battery/continuity stays current even
  // during quiet periods.
  if (millis() - lastAckPayloadRefresh > ACK_PAYLOAD_REFRESH_MS) {
    refreshAckPayload();
  }

  updateNonBlockingAnim();
  updateStatusLEDs();

  // Disconnect detection.
  if (now - lastCmdReceived > 10000 && gotCommand) {
    DBG_PRINTLN("Disconnect detected.");
    if (isPlaying) {
      requestAnim(ANIM_FLASHING_PURPLE);
      isPlaying = false;
    }
    gotCommand = false;
    // Re-arm the radio in case it's stuck in a weird state.
    radio.flush_tx();
    radio.flush_rx();
    radio.openReadingPipe(0, receiverReadAddress());
    radio.startListening();
    refreshAckPayload();
  }

  // Auto-clear stale firing state if the show loop didn't (defensive).
  bool doRefresh = false;
  for (uint8_t i = 0; i < 128; i++) {
    if (targetFiring[i]) {
      if (millis() - fireStartTime[i] >= FIRE_MS_DURATION) {
        targetFiring[i] = false;
        doRefresh = true;
      }
    }
  }
  if (doRefresh) refreshFiring();

  if ((millis() - lastInputModeRunTime > INPUT_MODE_INTERVAL)) {
    handleInputMode();
    lastInputModeRunTime = millis();
  }
}
