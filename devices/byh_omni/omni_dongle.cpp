// Dongle role for the BYH Omni: a port of os4_dongle.ino (FW v30) running on
// receiver hardware with the dongle host module plugged into the output
// header. Protocol, queueing, polling, and OTA relay are unchanged from the
// dongle; see that file's FW_VERSION history for the vNN / H# tags below.
//
// Hardware differences from the stand-alone dongle:
//   * Arm / start / manual switches are read from the host module's 74HC165
//     on the continuity shift-in chain (active high, pulldowns). They are
//     reported to the host inverted, matching the dongle's active-low pins.
//   * The 433MHz transmitter is keyed by one output of the host module's
//     74HC595 on the cue shift-out chain, clocked at full speed per edge.
//   * The host module's status pixels hang off the cue LED data pin.
//   * The omni's three on-board status LEDs show the host link: pulsing blue
//     while waiting, solid green once a host is connected.
//   * In hub mode the host link is a WebSocket served over a WiFi AP
//     (omni_hub.cpp) instead of USB serial.

#include "omni_dongle.h"
#include "omni_hub.h"
#include "omni_pins.h"

#include <SPI.h>
#include <RF24.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include <esp_system.h>   // esp_restart() for the host-requested soft reboot
#include <esp_timer.h>
#include <soc/gpio_reg.h>

// Max pixels on the host module; the configured count is clamped to this.
#define MAX_HOST_PIXELS 16
// How often the host module's input register is sampled.
#define HOST_INPUT_POLL_MS 10
// Disable interrupts for each 433MHz bit (~1.5ms) so WiFi / USB interrupts
// can't stretch the pulse widths the receivers decode.
#define RF433_ATOMIC_BITS 1
// Longest line the hub link will frame as one WebSocket message.
#define HOST_LINE_CAPACITY 8192

#define CONTINUITY_INDEX_CT 2
#define MAX_LATENCY_SAMPLES 10
#define MAX_SUCCESS_SAMPLES 64

static_assert(SHIFT_OUT_DATA < 32 && SHIFT_OUT_CLOCK < 32 && SHIFT_OUT_LATCH < 32,
              "fast host-output writes use GPIO_OUT_W1TS_REG (GPIO 0-31)");

namespace omni_dongle {

OmniDongleConfig dcfg;
#define FW_VERSION (dcfg.fwVersion)
// See BOARD_TYPE_* in byh_omni.ino: an omni acting as dongle is type 1.
#define DONGLE_BOARD_TYPE 1

// ---------------------------------------------------------------------------
// Host link: everything the dongle prints goes through `Host`. Over USB it
// is a thin pass-through to Serial. In hub mode it collects bytes into lines
// and hands each finished line to the WebSocket clients, mirroring to USB
// only when that can be done without blocking.
// ---------------------------------------------------------------------------
// Hub mode batches host lines into one WebSocket message (T21): each
// message is its own WiFi transmission a few centimetres from the nRF24
// front end, so a burst of rxupd lines used to mean a burst of WiFi frames
// while the nRF was listening for ACKs. A batch is flushed when the next
// line would not fit, HUB_BATCH_MAX_AGE_MS after its first line, on
// flush(), or at once for urgent lines (command acks, switch state, errors).
// Both clients split a message on newlines.
#define HUB_BATCH_CAPACITY   1400
#define HUB_BATCH_MAX_AGE_MS 20

class HostLink : public Print {
 public:
  void beginHub() {
    hub = true;
    line = (char*)malloc(HOST_LINE_CAPACITY);
    lineLen = 0;
    batch = (char*)malloc(HUB_BATCH_CAPACITY);
    batchLen = 0;
  }

  size_t write(uint8_t c) override { return write(&c, 1); }

  size_t write(const uint8_t* buf, size_t n) override {
    if (!hub) return Serial.write(buf, n);
    if (line == nullptr) return n;
    for (size_t i = 0; i < n; i++) {
      char c = (char)buf[i];
      if (c == '\r') continue;
      if (c == '\n') { emitLine(); continue; }
      if (lineLen < HOST_LINE_CAPACITY) line[lineLen++] = c;
    }
    return n;
  }

  int availableForWrite() override {
    if (!hub) return Serial.availableForWrite();
    return omni_hub::writeSpace();
  }

  void flush() override {
    if (!hub) { Serial.flush(); return; }
    if (lineLen > 0) emitLine();
    flushBatch();
    omni_hub::flush(200);
  }

  // Called every loop pass: enforces the batch age limit.
  void poll() {
    if (hub && batchLen > 0 && millis() - batchStartMs >= HUB_BATCH_MAX_AGE_MS) flushBatch();
  }

 private:
  static bool urgent(const char* l, size_t n) {
    if (n >= 2 && l[0] == 'K' && l[1] == ' ') return true;          // command ack
    if (n >= 3 && strncmp(l, "ERR", 3) == 0) return true;
    // {"gpio":"gpio_status",...}: look for "gpio" near the start.
    if (n < 8 || l[0] != '{') return false;
    size_t lim = n < 32 ? n : 32;
    for (size_t i = 0; i + 4 <= lim; i++) {
      if (l[i] == 'g' && l[i + 1] == 'p' && l[i + 2] == 'i' && l[i + 3] == 'o') return true;
    }
    return false;
  }

  void flushBatch() {
    if (batchLen == 0) return;
    omni_hub::sendLine(batch, batchLen);
    batchLen = 0;
  }

  void emitLine() {
    // The USB mirror stays one line at a time.
    if (Serial && Serial.availableForWrite() > (int)lineLen) {
      Serial.write((const uint8_t*)line, lineLen);
      Serial.write('\n');
    }
    if (batch == nullptr || lineLen + 1 > HUB_BATCH_CAPACITY) {
      // Too long to batch: keep ordering, then send it on its own.
      flushBatch();
      omni_hub::sendLine(line, lineLen);
      lineLen = 0;
      return;
    }
    if (batchLen > 0 && batchLen + 1 + lineLen > HUB_BATCH_CAPACITY) flushBatch();
    if (batchLen == 0) {
      batchStartMs = millis();
    } else {
      batch[batchLen++] = '\n';
    }
    memcpy(batch + batchLen, line, lineLen);
    batchLen += lineLen;
    bool now = urgent(line, lineLen);
    lineLen = 0;
    if (now) flushBatch();
  }

  bool     hub = false;
  char*    line = nullptr;
  size_t   lineLen = 0;
  char*    batch = nullptr;
  size_t   batchLen = 0;
  uint32_t batchStartMs = 0;
};

HostLink Host;

// ---------------------------------------------------------------------------
// Host module I/O
// ---------------------------------------------------------------------------

uint8_t hostOutShadow = 0;
uint8_t rf433Mask = 0x01;
portMUX_TYPE rf433Mux = portMUX_INITIALIZER_UNLOCKED;

static inline void fastPinWrite(uint8_t pin, bool high) {
  if (high) REG_WRITE(GPIO_OUT_W1TS_REG, 1UL << pin);
  else      REG_WRITE(GPIO_OUT_W1TC_REG, 1UL << pin);
}

// ~65ns at 240MHz: covers 74HC595 setup / pulse-width minimums at 5V plus
// the level shifter.
#define HOST_SR_SETTLE() __asm__ __volatile__("nop; nop; nop; nop; nop; nop; nop; nop; nop; nop; nop; nop; nop; nop; nop; nop")

// Shift one byte into the host module's 74HC595 (bit 0 lands on QA) and
// latch it. Every call takes the same time, so edge-to-edge spacing of the
// latched output matches the caller's timing exactly.
void shiftHostOutput(uint8_t value) {
  fastPinWrite(SHIFT_OUT_LATCH, false);
  for (int8_t bit = 7; bit >= 0; bit--) {
    fastPinWrite(SHIFT_OUT_DATA, (value >> bit) & 1);
    HOST_SR_SETTLE();
    fastPinWrite(SHIFT_OUT_CLOCK, true);
    HOST_SR_SETTLE();
    fastPinWrite(SHIFT_OUT_CLOCK, false);
  }
  HOST_SR_SETTLE();
  fastPinWrite(SHIFT_OUT_LATCH, true);
}

void rf433Set(bool on) {
  if (on) hostOutShadow |= rf433Mask;
  else    hostOutShadow &= ~rf433Mask;
  shiftHostOutput(hostOutShadow);
}

static inline void busyWaitUntilUs(int64_t deadline) {
  while (esp_timer_get_time() < deadline) {}
}

// One PWM bit: high for highUs, then low for lowUs. Timed against absolute
// deadlines from the rising edge so the shift-out time doesn't add up.
void rf433SendPulse(uint32_t highUs, uint32_t lowUs) {
#if RF433_ATOMIC_BITS
  portENTER_CRITICAL(&rf433Mux);
#endif
  int64_t t0 = esp_timer_get_time();
  rf433Set(true);
  busyWaitUntilUs(t0 + highUs);
  rf433Set(false);
  busyWaitUntilUs(t0 + highUs + lowUs);
#if RF433_ATOMIC_BITS
  portEXIT_CRITICAL(&rf433Mux);
#endif
}

uint8_t readHostInputs() {
  // Same sequence and timing as the receiver's continuity read.
  digitalWrite(SHIFT_IN_LATCH, LOW);
  delayMicroseconds(30);
  digitalWrite(SHIFT_IN_LATCH, HIGH);
  delayMicroseconds(30);
  uint8_t value = 0;
  for (int8_t bit = 7; bit >= 0; bit--) {
    if (digitalRead(SHIFT_IN_DATA)) value |= (1 << bit);
    digitalWrite(SHIFT_IN_CLOCK, HIGH);
    delayMicroseconds(20);
    digitalWrite(SHIFT_IN_CLOCK, LOW);
    delayMicroseconds(20);
  }
  return value;
}

// On-board status LEDs.
//   USB dongle: pulsing blue until the host opens the port, then solid green.
//   Hub dongle: pulsing yellow while the AP has no devices, flashing green
//               once a device joins the WiFi, solid green once it opens the
//               WebSocket.
void updateConnectionLEDs() {
  static uint32_t lastUpdate = 0;
  uint32_t nowMs = millis();
  if (nowMs - lastUpdate < 30) return;
  lastUpdate = nowMs;
  Adafruit_NeoPixel* s = dcfg.statusStrip;
  if (s == nullptr) return;
  uint32_t cyc = nowMs % 1500;
  uint8_t pulse = (cyc < 750) ? (uint8_t)((cyc * 180) / 750) : (uint8_t)(((1500 - cyc) * 180) / 750);
  uint32_t color;
  if (dcfg.hubMode) {
    if (omni_hub::clientCount() > 0) {
      color = s->Color(0, 160, 0);
    } else if (omni_hub::stationCount() > 0) {
      color = ((nowMs / 250) & 1) ? s->Color(0, 160, 0) : 0;
    } else {
      color = s->Color(pulse, (uint8_t)((pulse * 140) / 180), 0);
    }
  } else if (Serial) {
    color = s->Color(0, 160, 0);
  } else {
    color = s->Color(0, 0, pulse);
  }
  for (uint8_t i = 0; i < dcfg.statusLedCount; i++) s->setPixelColor(i, color);
  s->show();
}
enum MessageType {
  MANUAL_FIRE              = 1,
  CLOCK_SYNC               = 2,
  START_LOAD               = 3,
  SHOW_LOAD                = 4,
  GENERIC_PLAY             = 5,
  GENERIC_STOP             = 6,
  GENERIC_RESET            = 7,
  GENERIC_PAUSE            = 8,
  SHOW_START               = 9,
  RECEIVER_STATUS          = 10,
  SHOW_LOADN               = 11,  // Packed multi-cue load (up to 6 cues per frame)
  RESET_DVC                = 12,
  OTA_BEGIN                = 13,
  OTA_DATA                 = 14,
  OTA_END                  = 15,
  OTA_ABORT                = 16,
  RECEIVER_OTA_STATUS      = 17,
  RECEIVER_CONFIG_QUERY    = 18,  // dongle -> receiver (paired with FW v22+)
  RECEIVER_CONFIG_RESPONSE = 19,  // receiver -> dongle (in ACK payload)
  BCAST_CONTROL            = 20   // T27: dongle -> every receiver, no ACK
};

// Bit flags for ReceiverConfigSetMessage.flags. flags == 0 is a pure
// fetch (no settings written). New writable knobs add new flag bits and
// new field slots in ReceiverConfigSetMessage; the receiver dispatch is
// msgSize-checked so older firmware just ignores trailing bytes.
#define CFG_FLAG_SET_FIRE_DURATION 0x01

struct ManualFireMessage {
  uint8_t type;
  uint8_t position;
} __attribute__((packed));

struct ClockSyncMessage {
  uint8_t type;
  uint64_t timestamp;
  // T23: bumped on every msync so receivers drop their sync window at a
  // host clock step. Receivers read it only when the frame is >= 10 bytes;
  // older receivers ignore the trailing byte.
  uint8_t epoch;
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

// T25: PLAY / PAUSE with the synchronized time they take effect at. Sent
// when the host gives a non-zero timestamp; older receivers read only the
// type byte.
struct GenericTimedMessage {
  uint8_t  type;
  uint64_t at;
} __attribute__((packed));

// T27 broadcast control frame (see the receiver for the semantics).
struct BroadcastControlMessage {
  uint8_t  type;     // BCAST_CONTROL
  uint8_t  op;       // 1 stop, 2 pause, 3 play, 4 show_start
  uint8_t  seq;      // same on every repeat of one command
  uint16_t showId;   // 0 = every receiver
  uint64_t at;
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
  uint8_t nodeID;            // low byte; legacy offset preserved
  uint8_t batteryLevel;
  uint16_t showState;
  // ident used to be char[10]; receivers always NUL-terminated it at [9]
  // and idents are at most 8 characters, so the last byte now carries
  // state flags (T12). A pre-T12 receiver sends 0 there; only trust the
  // flags once the config response advertises RX_CAP_STATUS_FLAGS.
  char ident[9];             // NUL-terminated, max 8 characters
  uint8_t stateFlags;        // STATE_FLAG_*
  uint64_t cont64_0;
  uint64_t cont64_1;
  uint8_t nodeIDHigh;        // v30 optional trailing byte
} __attribute__((packed));

#define LEGACY_RECEIVER_STATUS_SIZE 31
#define STATE_FLAG_PLAYING 0x01
#define STATE_FLAG_PAUSED  0x02
// ReceiverConfigResponseMessage.reserved[3] capability bits (T12).
#define RX_CAP_STATUS_FLAGS 0x01
#define RX_CAP_TIMED_PAUSE  0x02
#define RX_CAP_RF_CONFIG    0x04   // reserved[4] channel, reserved[5] system ID
static_assert(sizeof(ReceiverStatusMessage) == 32, "receiver status wire layout changed");

// dongle -> receiver: fetch config (and optionally apply settings).
// flags == 0 is a pure fetch. Wire layout is append-only -- new knobs
// add new flag bits + new trailing fields, and older receiver firmware
// (which size-checks against its compiled struct) safely ignores them.
struct ReceiverConfigSetMessage {
  uint8_t  type;              // RECEIVER_CONFIG_QUERY
  uint8_t  flags;             // bit 0: SET_FIRE_DURATION
  uint16_t fire_duration_ms;  // applied when flags & CFG_FLAG_SET_FIRE_DURATION
} __attribute__((packed));

// receiver -> dongle: piggybacks in the same ACK FIFO as
// RECEIVER_STATUS. Routed by leading type byte. `reserved` is
// zero-padded for future fields without a wire bump.
struct ReceiverConfigResponseMessage {
  uint8_t  type;              // RECEIVER_CONFIG_RESPONSE
  uint8_t  nodeID;            // low byte; legacy offset preserved
  uint8_t  fwVersion;
  uint8_t  boardVersion;
  uint8_t  numBoards;         // 0 if noBoardsDetected, else detected NUM_BOARDS
  uint8_t  noBoardsDetected;  // 0 or 1
  uint8_t  cuesAvailable;     // 0 if noBoardsDetected, else NUM_BOARDS * 8
  uint16_t fireDurationMs;    // currently-effective fire pulse width (ms)
  uint8_t  reserved[8];       // reserved[0] = v30 nodeID high byte
                              // reserved[1] = board type (0 dedicated, 1 omni)
                              // reserved[3] = capability bits (RX_CAP_*)
} __attribute__((packed));

static_assert(sizeof(ReceiverConfigResponseMessage) == 17, "config response wire layout changed");

// ---------------------------------------------------------------------------
// OTA flash protocol -- mirrors os4_receiver.ino. See FW_VERSION v10 notes.
// ---------------------------------------------------------------------------
struct OtaBeginMessage {
  uint8_t  type;         // OTA_BEGIN
  uint32_t totalSize;
  uint16_t totalChunks;
  uint8_t  dataRate;     // 0=250k, 1=1M, 2=2M
  uint32_t crc32;
} __attribute__((packed));

struct OtaDataMessage {
  uint8_t  type;         // OTA_DATA
  uint16_t chunkIdx;
  // Followed by up to (32 - sizeof(this)) bytes of raw firmware data.
} __attribute__((packed));

struct OtaEndMessage {
  uint8_t type;          // OTA_END
} __attribute__((packed));

struct OtaAbortMessage {
  uint8_t type;          // OTA_ABORT
} __attribute__((packed));

// receiver -> dongle status (in ACK payload while in flash mode)
struct ReceiverOtaStatusMessage {
  uint8_t  type;             // RECEIVER_OTA_STATUS
  uint8_t  state;            // 0=idle 1=prep_ok 2=running 3=done 4=error
  uint16_t lastChunk;
  uint32_t bytesReceived;
  uint8_t  errorCode;
  uint8_t  nodeID;           // low byte; legacy offset preserved
  uint8_t  nodeIDHigh;       // v30 optional trailing byte
} __attribute__((packed));

#define LEGACY_RECEIVER_OTA_STATUS_SIZE 10
static_assert(sizeof(ReceiverOtaStatusMessage) == 11, "OTA status wire layout changed");

// Maximum data bytes per OTA_DATA frame. 32-byte nRF payload minus the
// 3-byte OtaDataMessage header. Must match the host's chunk size.
#define OTA_MAX_CHUNK_BYTES (32 - (uint8_t)sizeof(OtaDataMessage))

// How long to keep pinging the receiver post-flash_end before declaring
// the reflash dead. The receiver's Update.end + reboot is typically
// ~1-2s, so 30s is generous.
#define OTA_REJOIN_TIMEOUT_MS 30000UL

// Receiver idents are "RX<nodeID>" (at most 7 characters for 16-bit IDs);
// the table stores them inline instead of as a heap String (T11).
#define RECEIVER_IDENT_CAP 10

struct ReceiverInfo {
  uint16_t nodeID;
  char ident[RECEIVER_IDENT_CAP];
  uint8_t batteryLevel;
  uint16_t showId;
  bool loadComplete;
  bool startReady;
  uint64_t lastMessageTime;
  uint64_t continuity[CONTINUITY_INDEX_CT];

  // Radio round-trip samples in ms (single digits in practice).
  uint16_t latencies[MAX_LATENCY_SAMPLES];
  uint8_t latencyNextIndex;
  uint8_t latencySampleCount;

  // Success tracking: the last MAX_SUCCESS_SAMPLES command results as a
  // shift register, newest in bit 0 (1 = success).
  uint64_t successBits;
  uint8_t successCount;

  // T12: STATE_FLAG_* from the latest status frame, and the receiver's
  // capability bits from its config response (RX_CAP_*).
  uint8_t stateFlags;
  uint8_t caps;
  // T26: the receiver's stored RF channel / system ID (valid with
  // RX_CAP_RF_CONFIG). It answered us, so they match ours today; reported so
  // the host can show and persist them.
  uint8_t rxRfChannel;
  uint8_t rxRfSystemId;

  uint8_t consecutiveFailures;

  // T08 poll backoff: polls in a row that went unanswered, and how many
  // more poll rounds to skip before trying this receiver again. Any
  // successful exchange zeroes both.
  uint8_t  pollMisses;
  uint8_t  skipRounds;
  // T13: moving average of auto-retries per delivered frame, scaled x16.
  uint16_t retryAvg16;
  // T09: millis() at which a follow-up poll is due (0 = none) so a state
  // change (loadComplete, startReady) reaches the host without waiting a
  // full poll cycle.
  uint32_t followUpDueMs;

  // FW v16: cached receiver-side config from the most recent
  // RECEIVER_CONFIG_RESPONSE. configValid is false until the first
  // response lands, so the per-second status JSON can omit these
  // fields rather than emit zeros and confuse the host. configQueryPending
  // is set when a receiver is freshly auto-created (initial connect or
  // post-prune re-discovery) -- maybePollNextReceiver substitutes a
  // CONFIG_QUERY for the next CLOCK_SYNC poll for that receiver, and
  // the flag clears once the response is ingested.
  bool     configValid;
  bool     configQueryPending;
  uint8_t  fwVersion;
  uint8_t  boardVersion;
  uint8_t  boardType;        // config resp reserved[1]; 0 dedicated, 1 omni
  uint8_t  numBoards;
  uint8_t  noBoardsDetected;
  uint8_t  cuesAvailable;
  uint16_t fireDurationMs;

  // M2: rxupd emit rate-limiting. The high-frequency latency/success-only
  // churn (one rxupd per successful poll) is throttled to
  // RXUPD_MIN_INTERVAL_MS, but an operator-visible change (load / start /
  // showId / battery / continuity) emits immediately. These cache the last
  // *emitted* values for the change comparison.
  uint32_t lastRxUpdMs;
  bool     rxUpdEverEmitted;
  uint8_t  lastEmitBattery;
  uint16_t lastEmitShowId;
  bool     lastEmitLoad;
  bool     lastEmitReady;
  uint8_t  lastEmitFlags;
  uint64_t lastEmitContinuity[CONTINUITY_INDEX_CT];
};

// M2: minimum spacing between rxupd lines for a given receiver when only
// the latency/success fields changed. Operator-visible changes bypass this.
#define RXUPD_MIN_INTERVAL_MS 100UL

// Bumped from 10 to 32 to support 20+ receivers per the throughput target,
// then to 128 once the table was slimmed and the status tick sliced (T11).
// numReceivers / nextPollReceiverIdx are uint8_t, so stay below 256.
#define MAX_RECEIVERS 128
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

// Sanity bounds for the runtime-tunable timing knobs. The previous code
// accepted anything (incl. 0), which silently broke polling math --
// pollSpacingMs = clockSyncIntervalMs / numReceivers underflows to 0,
// which the floor at 5ms then masked but in a way that decoupled cadence
// from configured intent. Clamping at parse time keeps the live values
// in a regime the rest of the firmware was tested against.
//
//   clockSyncIntervalMs:     50..30000ms
//   commandResponseTimeoutMs: 5..500ms
//   receiverInactivityTimeoutMs: 60_000..21_600_000ms (1min..6h)
//
// Implemented as a macro (not a function) so we don't introduce a
// top-level function before the QueuedCommand struct -- Arduino's
// ctags-based auto-prototype generator hoists prototypes to the
// location of the FIRST top-level function in the .ino, which would
// land before QueuedCommand and break compilation of the queue helpers.
#define CSIM_MIN_MS  50UL
#define CSIM_MAX_MS  30000UL
#define CRTM_MIN_MS  5UL
#define CRTM_MAX_MS  500UL
#define RITM_MIN_MS  60000UL
#define RITM_MAX_MS  21600000UL

#define CLAMP_U32(v, lo, hi) \
  ((uint32_t)((v) < (lo) ? (lo) : ((v) > (hi) ? (hi) : (v))))

// Runtime-tunable RF parameters. Defaults preserve previous behavior.
uint8_t rfChannel = 85;
// rfSystemId salts the RF base address so two independent firing systems on
// the same channel don't collide. 0 = legacy behavior.
uint8_t rfSystemId = 0;

struct QueuedCommand {
  uint16_t targetNodeID;
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

  // For RECEIVER_CONFIG_QUERY (FW v16+). cfg_flags is the bitset that
  // gates which trailing fields actually get applied on the receiver;
  // 0 means a pure fetch.
  uint8_t  cfg_flags;
  uint16_t cfg_fire_duration_ms;

  // QF_* bits: where the command came from. Background polls are counted
  // toward a receiver's poll backoff (T08); follow-up polls are not (T09).
  uint8_t  qflags;
  // T14: host sequence number (0 = none). The command's K line is emitted
  // when it is dispatched, dropped or scrubbed.
  uint16_t seq;
};
#define QF_POLL      0x01
#define QF_FOLLOWUP  0x02

// Bumped from 40 to 128 — show-start can enqueue ~300 commands at once.
// 256 since T11: one fan-out to 128 receivers alone would fill 128.
#define MAX_COMMANDS_IN_QUEUE 256
QueuedCommand commandBuffer[MAX_COMMANDS_IN_QUEUE];
int cmdQueueHead = 0;
int cmdQueueTail = 0;
int cmdQueueCount = 0;

// Aggregate latency stats (not per-receiver).
uint16_t latencies[MAX_LATENCY_SAMPLES];
uint8_t latencyNextIndex = 0;
uint8_t latencySampleCount = 0;

// TDMA-style polling: round-robin index across receivers for clock-sync/poll.
uint8_t nextPollReceiverIdx = 0;
uint64_t lastPollDispatchTime = 0;

// ---------------------------------------------------------------------------
// OTA flash mode state. While `otaActive` is true:
//   * maybePollNextReceiver / dispatchOneCommand are skipped (the dongle is
//     pinned to one receiver),
//   * the radio data rate is whatever the host requested (1M or 2M),
//   * the only serial commands serviced are flash_data / flash_end /
//     flash_abort -- everything else is rejected with `CV BUSY OTA`.
//
// `otaPhase`:
//   0 = inactive
//   1 = streaming chunks
//   2 = flash_end issued, waiting for receiver to reboot back onto 250kbps
// ---------------------------------------------------------------------------
bool     otaActive            = false;
uint8_t  otaPhase             = 0;
uint16_t otaTargetNodeID      = 0;
String   otaTargetIdent       = "";
uint8_t  otaDataRate          = 2;       // 0=250k, 1=1M, 2=2M
uint32_t otaTotalSize         = 0;
uint16_t otaTotalChunks       = 0;
uint16_t otaLastAckedChunk    = 0xFFFF;  // last chunkIdx the receiver acked
uint16_t otaChunksAttempted   = 0;       // # of `flash_data` calls received
uint16_t otaChunksAcked       = 0;       // # that completed with PREP_OK ack
uint16_t otaHwRetryBursts     = 0;       // # chunks needing >1 dongle attempt
uint8_t  otaLastFrame[32];               // last OTA_DATA frame, for recovery
uint8_t  otaLastFrameLen      = 0;
uint16_t otaLastFrameChunk    = 0xFFFF;
// FW v15: count of OTA hot-path emit calls that were dropped because
// the USB-CDC TX ring buffer didn't have room. The host can read this
// from the OS heartbeat to spot persistent backpressure; individual
// drops are harmless because the host has retry/timeout fallback for
// every dropped event type (OA acks, ON nacks, OP pongs).
uint32_t otaSerialDropped     = 0;
uint64_t otaLastChunkSentMs   = 0;
uint64_t otaRejoinDeadlineMs  = 0;
// Per-chunk RF retry budget on the dongle side, on top of the radio's own
// auto-retry (5 internal retries per write call). Lets a flaky channel
// recover without bouncing to the host every time.
//
// FW v14: dropped from 6 to 4. Each radio.write blocks ~95ms (RF24
// FAILURE_HANDLING) when the link is down; 6 retries = ~570ms of
// solid radio.write blocking with no chance for the USB-CDC service
// task to drain the dongle's TX ring buffer. By the time we returned,
// any subsequent Host.print would hit a clogged TX FIFO and stall
// the main loop for seconds via setTxTimeoutMs(50) per byte. 4 retries
// + per-write yield() keeps worst-case wall time under ~400ms.
#define OTA_PER_CHUNK_RETRIES 4
// If a chunk fails the normal retry burst, try to self-heal before handing
// the failure back to the host. The usual failure mode is a transient RF24
// state/link hiccup: the receiver is still in OTA mode, still expecting this
// chunk, but the dongle has lost the ACK stream for a short window. These
// recovery rounds re-assert radio configuration, clear stale FIFOs, and resend
// the same idempotent chunk. The receiver safely handles both cases:
//   * chunk not applied yet -> writes it, ACKs lastChunk=idx
//   * chunk applied but ACK lost -> treats duplicate idx as already applied,
//     refreshes ACK, and reports lastChunk=idx
//
// FW v14: dropped from 4 rounds to 2. Same reasoning as above -- the
// host's escalating `flash_recover` (levels 0/1/2) does the deeper
// recovery work; this in-band path just absorbs single-burst losses.
#define OTA_RECOVERY_ROUNDS 2
#define OTA_RECOVERY_ATTEMPTS_PER_ROUND 3

// Hardware task watchdog timeout (seconds). The OTA path is the only
// place the loop can plausibly exceed a few seconds (radio.write +
// Host.print backpressure under a hostile RF link). If we ever do
// truly hang for >10s, the watchdog soft-resets the chip so the host
// can detect the dongle disappeared, the bridge re-opens the serial
// port, and the OTA driver bails the job cleanly.
//
// FW v15: dropped from 20s to 10s. With non-blocking OTA serial writes
// (drop-on-full instead of block-with-timeout) the legitimate worst-case
// loop iteration is now ~600ms (one chunk + recovery burst). 10s gives
// 16x headroom for that and keeps the dongle silence window short
// enough that the host's retry budget can actually save the transfer.
#define OTA_DONGLE_WDT_TIMEOUT_S 10

// `flash_recover` level: how aggressively to try to revive the link
// before bouncing the failure back to the host. Each escalation costs
// more wall time but recovers a strictly larger set of failure modes.
#define OTA_RECOVER_LEVEL_REPLAY    0  // re-send stored frame, 1 round
#define OTA_RECOVER_LEVEL_SOFT      1  // softRadioRecovery + replay
#define OTA_RECOVER_LEVEL_FULL      2  // radio.begin() + replay + 250k probe

uint8_t lastStartStopState = HIGH;
uint8_t lastArmingState = HIGH;
uint8_t lastManFireState = HIGH;
unsigned long lastGpioCheckTime = 0;

// Host module status pixels share the cue LED data pin. Sized for the max;
// setupLEDs() trims to the configured count.
uint8_t numPixels = 7;
Adafruit_NeoPixel pixels(MAX_HOST_PIXELS, LED_PIN, NEO_GRB + NEO_KHZ800);

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

uint8_t ledStates[MAX_HOST_PIXELS] = {0};
uint8_t ledEffects[MAX_HOST_PIXELS] = {0};
// T07: set whenever a pixel state, effect or the brightness changes;
// updateLEDs() only pushes pixels when this is set or an active blink /
// pulse effect ticks.
bool ledDirty = true;

uint64_t tsOffset = 0;
// T23: incremented on every msync, carried in each CLOCK_SYNC.
uint8_t clockEpoch = 0;
uint64_t lastPrintTime = 0;

#define SERIAL_BUFFER_SIZE 512
char serialLineBuffer[SERIAL_BUFFER_SIZE];
uint16_t serialBufferIndex = 0;

// Pins and PA level depend on the omni board version; set in setup().
RF24 radio;
uint8_t rfCePin = RF24_CE_PIN_V6_PLUS;
uint8_t rfCsnPin = RF24_CSN_PIN_V6_PLUS;
rf24_pa_dbm_e rfPaLevel = RF24_PA_MAX;

// RF24 addressing (Star Topology):
// Master listens on pipe 0 at masterReadAddress(); receivers each listen on
// receiverAddress(nodeID). The rfSystemId is salted into the high bytes so
// two independent firing systems on the same channel won't collide.
//
// IMPORTANT (FW v8+): the low-byte math is *arithmetic addition*, not
// bitwise OR. The pre-v8 firmware used `RECEIVER_BASE | nodeID`, which
// for any even nodeID set the LSB (giving nodeID+1) but for any odd
// nodeID was a no-op (giving nodeID). That collapsed every (even N,
// odd N+1) pair onto the *same* radio address -- e.g. RX162 (even) and
// RX163 (odd) both ended up listening on address 163. Result: when the
// dongle thought it was talking to one of the pair, the other actually
// answered, and any newly-registered odd-paired receiver was silently
// invisible to the radio. Switching to `+` gives every nodeID a
// unique address. Receivers and dongle MUST be running matching firmware
// (v8+ on dongle, v10+ on receiver) for the math to agree.
//
//   rfSystemId=0:   master_read=0x0000000000, receiver_N = 0x0000000001 + N
//   rfSystemId=k:   master_read=k*0x0100000000, receiver_N = k*0x0100000000 + 1 + N
//
// Note: with the ACK-payload protocol, master rarely listens — it sends
// commands and receives status back as the ACK payload. Reading-pipe is only
// kept for legacy / out-of-band messages.
#define MASTER_READ_BASE   0x0000000000ULL
#define RECEIVER_BASE      0x0000000001ULL

// H8: high-entropy address mask. The plain `salt + base + nodeID` scheme
// produces 5-byte addresses that are almost all 0x00 -- and nRF24 uses the
// address bytes for hardware match detection, where long runs of 0x00/0xFF
// look like preamble/noise and measurably raise false matches + silent
// packet loss (worst at 250kbps). XOR'ing the computed address with this
// constant scatters the upper bytes while the low byte (mask = 0x00 there)
// still carries the per-node delta, so every nodeID keeps a unique address.
//
// BREAKING RF CHANGE: the receiver firmware applies the IDENTICAL mask, so
// dongle and receiver MUST ship together (dongle FW v20+ / receiver FW v24+,
// see the version-gate note at RECEIVER_BASE above for the precedent).
//
// NOTE: the v25 and v27 RESCUE releases temporarily set this to 0x0 (pre-v20
// unmasked addressing) to reach stranded v23 receivers. v26 and v28 restore
// the real mask -- they are the normal builds and only talk to v24+ receivers.
#define RF_ADDR_ENTROPY_MASK 0xA3C5E1B400ULL

static inline uint64_t systemSalt() {
  // 4-byte left-shift so the system ID lives in the high 32 bits and never
  // collides with the 0..65535 nodeID range in the low two bytes.
  return ((uint64_t)rfSystemId) << 32;
}
static inline uint64_t masterReadAddress() {
  // MASTER_READ_BASE is 0 so `|` and `+` are equivalent here; using `|`
  // makes the salt-merge intent explicit.
  return MASTER_READ_BASE | systemSalt();
}
// T27: shared address all receivers also listen on (pipe 1).
#define BROADCAST_BASE 0x7EB14CD39AULL
static inline uint64_t broadcastAddress() {
  return BROADCAST_BASE ^ systemSalt();
}
static inline uint64_t receiverAddress(uint16_t nodeID) {
  // See the IMPORTANT note above re: arithmetic add vs. bitwise OR, and
  // RF_ADDR_ENTROPY_MASK for the H8 entropy XOR (applied on both ends).
  return RF_ADDR_ENTROPY_MASK ^ (systemSalt() + RECEIVER_BASE + (uint64_t)nodeID);
}

// ---------------------------------------------------------------------------
// Auto-retry policy (v32/v36). ARD is the auto-retransmit delay in 250us
// steps, ARC the retry count. The nRF24L01+ minimum ARD for a 32-byte ACK
// payload at 250kbps is 1.5ms; (7 + 1) * 250us = 2ms keeps margin. Polls to
// a dead receiver get few retries (one costs ~6ms instead of ~24ms); real
// commands get more (8 retries at 2ms spans ~22ms, the same window as the
// old 5 x 4ms). All three are settable from the JSON config line
// (`rf_ard`, `rf_arc_poll`, `rf_arc_cmd`) for field comparison. The OTA path
// keeps its own fixed values.
// ---------------------------------------------------------------------------
#define RF_ARD_STEPS_DEFAULT   7
#define RF_ARC_POLL_DEFAULT    2
#define RF_ARC_COMMAND_DEFAULT 8
#define RF_OTA_ARD             15
#define RF_OTA_ARC             5
uint8_t rfArdSteps = RF_ARD_STEPS_DEFAULT;
uint8_t rfArcPoll  = RF_ARC_POLL_DEFAULT;
uint8_t rfArcCmd   = RF_ARC_COMMAND_DEFAULT;
static uint8_t currentArd = 0xFF;
static uint8_t currentArc = 0xFF;

// One SPI register write, only when the policy actually changes.
static inline void applyRetries(uint8_t ard, uint8_t arc) {
  if (ard == currentArd && arc == currentArc) return;
  radio.setRetries(ard, arc);
  currentArd = ard;
  currentArc = arc;
}
static inline void setRetryPolicy(uint8_t arc) { applyRetries(rfArdSteps, arc); }
// Call after anything that rewrites SETUP_RETR behind applyRetries' back
// (radio.begin(), a raw setRetries) so the next frame re-applies its policy.
static inline void invalidateRetryPolicy() { currentArd = 0xFF; currentArc = 0xFF; }

// ---------------------------------------------------------------------------
// Radio mode (v32/v36). The dongle never needs to be in RX mode: status
// arrives as the ACK payload, which lands in the RX FIFO in TX mode too. It
// stays in TX standby so each frame skips stopListening()'s ~0.5ms settle
// delay at 250kbps. Only the RF scan listens. Every listen / stop-listen
// goes through these so the cached state stays correct.
// ---------------------------------------------------------------------------
static bool radioListening = false;
static inline void radioEnterTx() {
  if (radioListening) { radio.stopListening(); radioListening = false; }
}
static inline void radioEnterRx() { radio.startListening(); radioListening = true; }

// T14 command-ack state; see processSerialCommand.
#define CMD_NOT_DELIVERED 0
#define CMD_HANDLED       1
#define CMD_DROPPED       2
#define CMD_REJECTED      3
#define DONGLE_CAPS_CMD_ACKS   0x01
#define DONGLE_CAPS_TIMED_PAUSE 0x02   // forwards `play/pause IDENT <at>` (T25)
#define DONGLE_CAPS_BCAST       0x04   // `bcast <op> <showId> <at>` (T27)
uint16_t pendingSeq = 0;
uint8_t  cmdResult = CMD_HANDLED;

void emitCmdResult(uint16_t seq, uint8_t result) {
  if (seq == 0) return;
  char buf[32];
  int n = snprintf(buf, sizeof(buf), "K %u %u %d\n", (unsigned)seq, (unsigned)result, cmdQueueCount);
  if (n > 0 && n < (int)sizeof(buf)) Host.write((const uint8_t*)buf, (size_t)n);
}

bool isQueueFull() { return cmdQueueCount >= MAX_COMMANDS_IN_QUEUE; }
bool isQueueEmpty() { return cmdQueueCount == 0; }

void enqueueCommand(const QueuedCommand& cmd) {
  if (isQueueFull()) {
    // A sequenced command is reported (and retried) through its K line.
    if (cmd.seq != 0) emitCmdResult(cmd.seq, CMD_DROPPED);
    else Host.println(F("ERR: Command queue full. Command dropped."));
    return;
  }
  commandBuffer[cmdQueueTail] = cmd;
  cmdQueueTail = (cmdQueueTail + 1) % MAX_COMMANDS_IN_QUEUE;
  cmdQueueCount++;
}

// STOP, PAUSE and MANUAL_FIRE jump the queue (enqueuePriorityCommand) and
// are never evicted to make room for another command.
static inline bool isPriorityType(uint8_t t) {
  return t == MANUAL_FIRE || t == GENERIC_STOP || t == GENERIC_PAUSE;
}

// Queue full: make room for a priority command by dropping the newest
// non-priority entry (walking back from the tail). Returns false when every
// queued entry is itself a priority command.
bool evictNewestNonPriority() {
  int idx = (cmdQueueTail - 1 + MAX_COMMANDS_IN_QUEUE) % MAX_COMMANDS_IN_QUEUE;
  for (int k = 0; k < cmdQueueCount; k++) {
    if (!isPriorityType(commandBuffer[idx].messageType)) {
      if (commandBuffer[idx].seq != 0) {
        emitCmdResult(commandBuffer[idx].seq, CMD_DROPPED);
      } else {
        Host.print(F("ERR: Command queue full. Evicted queued command type="));
        Host.print((int)commandBuffer[idx].messageType);
        Host.print(F(" N"));
        Host.println(commandBuffer[idx].targetNodeID);
      }
      // Close the gap: shift every newer entry one slot toward the head.
      int cur = idx;
      int next = (cur + 1) % MAX_COMMANDS_IN_QUEUE;
      while (next != cmdQueueTail) {
        commandBuffer[cur] = commandBuffer[next];
        cur = next;
        next = (next + 1) % MAX_COMMANDS_IN_QUEUE;
      }
      cmdQueueTail = cur;
      cmdQueueCount--;
      return true;
    }
    idx = (idx - 1 + MAX_COMMANDS_IN_QUEUE) % MAX_COMMANDS_IN_QUEUE;
  }
  return false;
}

void enqueuePriorityCommand(const QueuedCommand& cmd) {
  if (isQueueFull() && !evictNewestNonPriority()) {
    Host.println(F("ERR: Command queue full. Priority command dropped."));
    emitCmdResult(cmd.seq, CMD_DROPPED);
    return;
  }
  cmdQueueHead = (cmdQueueHead - 1 + MAX_COMMANDS_IN_QUEUE) % MAX_COMMANDS_IN_QUEUE;
  commandBuffer[cmdQueueHead] = cmd;
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
  pixels.updateLength(numPixels);
  pixels.begin();
  pixels.setBrightness(map(ledBrightness, 0, 100, 0, 255));
  pixels.clear();
  pixels.setPixelColor(0, COLOR_GREEN);
  pixels.show();
}

// Minimum spacing between pixels.show() calls. Each show() holds the loop
// for the strip's latch gap plus the data time (~0.3-0.5ms), which used to
// be paid on every loop pass.
#define LED_SHOW_MIN_INTERVAL_MS 20

void updateLEDs() {
  static unsigned long lastLedShowMs = 0;
  unsigned long currentMillis = millis();
  bool blinkTick = false;
  bool pulseTick = false;

  if (currentMillis - lastBlinkTime >= 500) {
    blinkState = !blinkState;
    lastBlinkTime = currentMillis;
    blinkTick = true;
  }

  if (currentMillis - lastPulseTime >= 50) {
    pulseValue += pulseDirection * 5;
    if (pulseValue >= 100) { pulseValue = 100; pulseDirection = -1; }
    else if (pulseValue <= 0) { pulseValue = 0; pulseDirection = 1; }
    lastPulseTime = currentMillis;
    pulseTick = true;
  }

  bool usesBlink = false;
  bool usesPulse = false;
  for (int i = 0; i < numPixels; i++) {
    if (ledEffects[i] == 1) usesBlink = true;
    else if (ledEffects[i] == 2) usesPulse = true;
  }
  if ((blinkTick && usesBlink) || (pulseTick && usesPulse)) ledDirty = true;
  if (!ledDirty) return;
  if (currentMillis - lastLedShowMs < LED_SHOW_MIN_INTERVAL_MS) return;  // stays dirty
  ledDirty = false;
  lastLedShowMs = currentMillis;

  for (int i = 0; i < numPixels; i++) {
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

// Forward declarations so parseLedJSON can poke RF settings.
void applyRfConfig();
void noteHubNrfChannel();

void parseLedJSON(const String& json) {
  StaticJsonDocument<1024> doc;
  DeserializationError error = deserializeJson(doc, json);
  if (error) {
    Host.print(F("deserializeJson() failed: "));
    Host.print(error.f_str());
    Host.print(F(" JSON length: "));
    Host.println(json.length());
    return;
  }

  if (doc.containsKey("led_brightness") || doc.containsKey("daemon_act") ||
      doc.containsKey("web_act_state") || doc.containsKey("tx_active") ||
      doc.containsKey("show_load_state") || doc.containsKey("show_run_state") ||
      doc.containsKey("error_state") || doc.containsKey("arm_state")) {
    ledDirty = true;
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

  if (doc.containsKey("receiver_timeout_ms")) {
    receiverInactivityTimeoutMs = CLAMP_U32(
      doc["receiver_timeout_ms"].as<uint32_t>(), RITM_MIN_MS, RITM_MAX_MS);
  }
  if (doc.containsKey("response_timeout_ms")) {
    commandResponseTimeoutMs = CLAMP_U32(
      doc["response_timeout_ms"].as<uint32_t>(), CRTM_MIN_MS, CRTM_MAX_MS);
  }
  if (doc.containsKey("clock_sync_interval_ms")) {
    uint32_t newCsim = CLAMP_U32(
      doc["clock_sync_interval_ms"].as<uint32_t>(), CSIM_MIN_MS, CSIM_MAX_MS);
    if (newCsim != clockSyncIntervalMs) {
      clockSyncIntervalMs = newCsim;
      // Reset the round-robin clock so the next poll fires promptly under
      // the new cadence rather than honoring the old spacing's deadline.
      lastPollDispatchTime = 0;
    }
  }
  if (doc.containsKey("debug_mode"))             debugMode                   = doc["debug_mode"].as<uint8_t>();

  // Auto-retry policy (T05). ARD in 250us steps, counts are retries per
  // frame; all are 4-bit fields on the chip. The ARD floor keeps it at or
  // above the 1.5ms the datasheet requires for a 32-byte ACK at 250kbps.
  bool retryChanged = false;
  if (doc.containsKey("rf_ard")) {
    rfArdSteps = (uint8_t)CLAMP_U32(doc["rf_ard"].as<uint32_t>(), 5UL, 15UL);
    retryChanged = true;
  }
  if (doc.containsKey("rf_arc_poll")) {
    rfArcPoll = (uint8_t)CLAMP_U32(doc["rf_arc_poll"].as<uint32_t>(), 0UL, 15UL);
    retryChanged = true;
  }
  if (doc.containsKey("rf_arc_cmd")) {
    rfArcCmd = (uint8_t)CLAMP_U32(doc["rf_arc_cmd"].as<uint32_t>(), 1UL, 15UL);
    retryChanged = true;
  }
  if (retryChanged) invalidateRetryPolicy();

  bool rfChanged = false;
  if (doc.containsKey("rf_channel")) {
    uint8_t newCh = doc["rf_channel"].as<uint8_t>();
    if (newCh <= 125 && newCh != rfChannel) { rfChannel = newCh; rfChanged = true; }
  }
  if (doc.containsKey("rf_system_id")) {
    uint8_t newSid = doc["rf_system_id"].as<uint8_t>();
    if (newSid != rfSystemId) { rfSystemId = newSid; rfChanged = true; }
  }
  if (rfChanged) {
    applyRfConfig();
    if (dcfg.hubMode) noteHubNrfChannel();
  }
}

// Hub mode only: remember the host's nRF channel so the next boot can place
// the AP away from it, and warn if it now overlaps the running AP.
void noteHubNrfChannel() {
  omni_hub::noteNrfChannel(rfChannel);
  int apMhz = 2407 + 5 * omni_hub::apChannel();
  int nrfMhz = 2400 + rfChannel;
  if (abs(apMhz - nrfMhz) < 12) {
    StaticJsonDocument<192> d;
    d["type"] = "hub_warn";
    d["msg"] = "nRF channel overlaps the WiFi AP; reboot the hub to move the AP";
    d["rf_channel"] = rfChannel;
    d["ap_channel"] = omni_hub::apChannel();
    serializeJson(d, Host);
    Host.write('\n');
  }
}

// Inputs 5–8 are shift-register indexes 4–7. A new level is accepted only
// after it has held still this long, so contact bounce is one edge.
#define AUX_DEBOUNCE_MS 50

// Switch states come from the host module's input register (closed = 1).
// They're reported inverted so the host sees the same active-low levels as
// the stand-alone dongle's INPUT_PULLUP switches. `inputs` is all 8 lines,
// active-low (0 = closed). Indexes 4–7 are the debounced momentary buttons.
void checkGpioStatus() {
  static uint32_t lastInputRead = 0;
  static uint8_t hostInputs = 0;
  static uint8_t auxDebounced = 0;
  static uint8_t auxCandidate = 0;
  static uint32_t auxCandidateSince = 0;
  static bool auxAnnounced = false;
  static bool auxPending = false;
  if (millis() - lastInputRead >= HOST_INPUT_POLL_MS) {
    hostInputs = readHostInputs();
    lastInputRead = millis();
    uint8_t aux = hostInputs & 0xF0;
    if (aux != auxCandidate) {
      auxCandidate = aux;
      auxCandidateSince = millis();
    } else if (millis() - auxCandidateSince >= AUX_DEBOUNCE_MS) {
      if (!auxAnnounced || aux != auxDebounced) {
        auxDebounced = aux;
        auxAnnounced = true;
        auxPending = true;
      }
    }
  }
  uint8_t startStopState = ((hostInputs >> dcfg.startInputIndex) & 1) ? LOW : HIGH;
  uint8_t armingState    = ((hostInputs >> dcfg.armInputIndex) & 1) ? LOW : HIGH;
  uint8_t manFireState   = ((hostInputs >> dcfg.manualInputIndex) & 1) ? LOW : HIGH;

  bool switchChanged = startStopState != lastStartStopState ||
      armingState != lastArmingState ||
      manFireState != lastManFireState;
  bool heartbeat = millis() - lastGpioCheckTime > 10000;
  // Aux edges flush immediately. A short tap would otherwise be gone by the
  // time the 200ms switch gate opened, and the host would never see it.
  if ((switchChanged || heartbeat || auxPending) &&
      (auxPending || millis() - lastGpioCheckTime > 200)) {
    lastStartStopState = startStopState;
    lastArmingState = armingState;
    lastManFireState = manFireState;
    lastGpioCheckTime = millis();
    bool sendInputs = auxAnnounced;
    auxPending = false;
    StaticJsonDocument<320> doc;
    doc["gpio"] = "gpio_status";
    doc["start_stop"] = (startStopState);
    doc["armed"] = (armingState);
    doc["man_fire"] = (manFireState);
    if (sendInputs) {
      uint8_t reported = (hostInputs & 0x0F) | auxDebounced;
      JsonArray inputs = doc.createNestedArray("inputs");
      for (uint8_t i = 0; i < 8; i++) inputs.add(((reported >> i) & 1) ? 0 : 1);
    }
    String jsonString;
    serializeJson(doc, jsonString);
    Host.println(jsonString);
  }
}

// Convention: receiver ident always has the form "RX<nodeID>" (e.g. "RX161").
// We exploit this so the dongle can address a freshly-known receiver before
// receiving its first status frame. Returns 0 if the ident doesn't match the
// pattern.
uint16_t nodeIDFromIdent(const String &ident) {
  if (ident.length() < 3) return 0;
  if (ident.charAt(0) != 'R' || ident.charAt(1) != 'X') return 0;
  long val = 0;
  for (uint16_t i = 2; i < ident.length(); i++) {
    char c = ident.charAt(i);
    if (c < '0' || c > '9') return 0;
    val = val * 10 + (c - '0');
    if (val > 65535) return 0;
  }
  return (uint16_t)val;
}

ReceiverInfo* getReceiverByIdent(const String &ident, bool createIfNotExist) {
  if (ident.length() == 0 || ident.charAt(0) != 'R') return nullptr;

  for (uint8_t i = 0; i < numReceivers; i++) {
    if (strcmp(receivers[i].ident, ident.c_str()) == 0) return &receivers[i];
  }
  if (!createIfNotExist) return nullptr;
  if (ident.length() >= RECEIVER_IDENT_CAP) {
    Host.print(F("ERR: ident too long: ")); Host.println(ident);
    return nullptr;
  }

  if (numReceivers < MAX_RECEIVERS) {
    uint16_t newNodeID = nodeIDFromIdent(ident);
    // Defensive: refuse to register a receiver whose radio address would
    // collide with one we already know about. A collision means radio
    // writes to the new receiver land on the old one (RX162 ACKs for
    // RX163 etc.), which manifests as silent retries plus duplicated
    // status emits. The old `|`-based address math used to make this
    // happen for every (even N, odd N+1) pair; v8+ uses `+`, but the
    // check is cheap and protects against future regressions.
    if (newNodeID != 0) {
      uint64_t newAddr = receiverAddress(newNodeID);
      for (uint8_t i = 0; i < numReceivers; i++) {
        if (receivers[i].nodeID == 0) continue;
        if (receiverAddress(receivers[i].nodeID) == newAddr) {
          Host.print(F("ERR: RF addr collision adding "));
          Host.print(ident);
          Host.print(F(" (N"));
          Host.print(newNodeID);
          Host.print(F(") with "));
          Host.print(receivers[i].ident);
          Host.print(F(" (N"));
          Host.print(receivers[i].nodeID);
          Host.println(F(") -- registration refused"));
          return nullptr;
        }
      }
    }

    ReceiverInfo &r = receivers[numReceivers];
    memset(&r, 0, sizeof(r));
    strlcpy(r.ident, ident.c_str(), sizeof(r.ident));
    // Bootstrap nodeID from the ident pattern so we can address the receiver
    // before its first ACK-payload status comes back. The next ACK payload
    // will overwrite this with the receiver's authoritative value.
    r.nodeID = newNodeID;
    r.batteryLevel = 0;
    r.showId = 0;
    r.loadComplete = false;
    r.startReady = false;
    r.lastMessageTime = millis() + tsOffset;
    for (uint8_t j = 0; j < CONTINUITY_INDEX_CT; j++) r.continuity[j] = 0;
    r.latencyNextIndex = 0;
    r.latencySampleCount = 0;
    for (uint8_t k = 0; k < MAX_LATENCY_SAMPLES; k++) r.latencies[k] = 0;
    r.successBits = 0;
    r.successCount = 0;
    r.stateFlags = 0;
    r.caps = 0;
    r.consecutiveFailures = 0;
    r.pollMisses = 0;
    r.skipRounds = 0;
    r.retryAvg16 = 0;
    r.followUpDueMs = 0;
    // FW v16: queue an automatic CONFIG_QUERY for the next poll slot
    // assigned to this receiver. Covers initial connect AND post-prune
    // re-discovery (the operator turned the unit off, swapped a cue
    // board, turned it back on -- we want the new NUM_BOARDS *and* any
    // operator-set fire_duration_ms reflected on the host immediately).
    r.configValid = false;
    r.configQueryPending = true;
    r.fwVersion = 0;
    r.boardVersion = 0;
    r.boardType = 0;
    r.numBoards = 0;
    r.noBoardsDetected = 0;
    r.cuesAvailable = 0;
    r.fireDurationMs = 0;
    // M2: rxupd throttle state. rxUpdEverEmitted=false forces the first
    // emit (and seeds the caches) regardless of timing.
    r.lastRxUpdMs = 0;
    r.rxUpdEverEmitted = false;
    r.lastEmitBattery = 0;
    r.lastEmitShowId = 0;
    r.lastEmitLoad = false;
    r.lastEmitReady = false;
    r.lastEmitFlags = 0;
    for (uint8_t j = 0; j < CONTINUITY_INDEX_CT; j++) r.lastEmitContinuity[j] = 0;
    numReceivers++;
    return &receivers[numReceivers - 1];
  }

  Host.println(F("ERR: Max receivers reached. Cannot add new."));
  return nullptr;
}

ReceiverInfo* getReceiverByNodeID(uint16_t nodeID) {
  if (nodeID == 0) return nullptr;
  for (uint8_t i = 0; i < numReceivers; i++) {
    if (receivers[i].nodeID == nodeID) return &receivers[i];
  }
  return nullptr;
}

// Drop every queued command targeting `nodeID`. Used by `forget` so a
// disabled receiver doesn't keep eating radio time on retries that will
// never succeed. Compacts the ring in-place to preserve queue ordering
// for everyone else.
//
// `typeMask` selects which message types are dropped (bit = 1 << type);
// SCRUB_ALL_TYPES drops everything for the node.
//
// Returns the number of commands dropped.
#define SCRUB_ALL_TYPES 0xFFFFFFFFUL
#define TYPE_BIT(t) (1UL << (uint8_t)(t))
uint16_t scrubQueueForNodeTypes(uint16_t nodeID, uint32_t typeMask) {
  if (cmdQueueCount == 0 || nodeID == 0) return 0;
  uint16_t dropped = 0;
  // Walk the live range and copy survivors back to a fresh head.
  // This works even with the wrap-around layout because we read in
  // order and write in order to indices we've already read past.
  int readIdx = cmdQueueHead;
  int writeIdx = cmdQueueHead;
  int remaining = cmdQueueCount;
  while (remaining-- > 0) {
    QueuedCommand& src = commandBuffer[readIdx];
    if (src.targetNodeID == nodeID && (typeMask & TYPE_BIT(src.messageType))) {
      dropped++;
      emitCmdResult(src.seq, CMD_DROPPED);
    } else {
      if (writeIdx != readIdx) commandBuffer[writeIdx] = src;
      writeIdx = (writeIdx + 1) % MAX_COMMANDS_IN_QUEUE;
    }
    readIdx = (readIdx + 1) % MAX_COMMANDS_IN_QUEUE;
  }
  cmdQueueTail = writeIdx;
  cmdQueueCount -= dropped;
  return dropped;
}

uint16_t scrubQueueForNode(uint16_t nodeID) {
  return scrubQueueForNodeTypes(nodeID, SCRUB_ALL_TYPES);
}

// Remove a receiver by ident. Used for the host-driven `forget IDENT` serial
// command (host edited the Receivers DB table, told us this one is no longer
// in scope). Returns true if the receiver was found and removed. Also
// scrubs any pending queued commands targeting the removed receiver --
// otherwise dispatchOneCommand would keep retrying them and silently
// burn ~22ms of radio time per cmd on TX-FAIL retries.
bool removeReceiverByIdent(const String &ident) {
  for (uint8_t i = 0; i < numReceivers; i++) {
    if (strcmp(receivers[i].ident, ident.c_str()) == 0) {
      uint16_t goneNodeID = receivers[i].nodeID;
      // Shift the tail down to keep the array compact.
      for (uint8_t j = i; j < numReceivers - 1; ++j) receivers[j] = receivers[j + 1];
      numReceivers--;
      // Reset the round-robin pointer to a safe slot — it might have pointed
      // past the end after the shift.
      if (nextPollReceiverIdx >= numReceivers) nextPollReceiverIdx = 0;
      uint16_t dropped = scrubQueueForNode(goneNodeID);
      if (dropped > 0 && debugMode > 0) {
        Host.print(F("INFO: forget scrubbed ")); Host.print(dropped);
        Host.print(F(" queued cmd(s) for N")); Host.println(goneNodeID);
      }
      return true;
    }
  }
  return false;
}

void pushCommandResult(ReceiverInfo* rinfo, bool success) {
  if (!rinfo) return;
  rinfo->successBits = (rinfo->successBits << 1) | (success ? 1ULL : 0ULL);
  if (rinfo->successCount < MAX_SUCCESS_SAMPLES) rinfo->successCount++;
}

uint8_t calculateSuccessPercent(const ReceiverInfo* rinfo) {
  if (!rinfo || rinfo->successCount == 0) return 0;
  uint64_t mask = (rinfo->successCount >= 64) ? ~0ULL
                                              : ((1ULL << rinfo->successCount) - 1ULL);
  uint32_t cnt = (uint32_t)__builtin_popcountll(rinfo->successBits & mask);
  return (uint8_t)((cnt * 100) / rinfo->successCount);
}

// Mean of a receiver's latency samples, rounded (ms).
uint16_t receiverAvgLatency(const ReceiverInfo* r) {
  if (r->latencySampleCount == 0) return 0;
  uint32_t sum = 0;
  for (uint8_t k = 0; k < r->latencySampleCount; k++) sum += r->latencies[k];
  return (uint16_t)((sum + r->latencySampleCount / 2) / r->latencySampleCount);
}

// Average auto-retries per delivered frame x10 (T13), for the `rt` key.
static inline uint16_t receiverRetryAvgX10(const ReceiverInfo* r) {
  return (uint16_t)(((uint32_t)r->retryAvg16 * 10U + 8U) / 16U);
}

// Stream a single-receiver update line to the host the instant we have
// fresh data. This collapses the 0..1s latency that the per-second status
// dump used to impose. Field names match the per-second `receivers[]`
// array entries so the host can ingest both shapes through the same
// abbreviated-key map.
//
// What lives in rxupd vs. the per-second tick:
//   * `x` (latest single-sample radio RTT) — included when caller has
//     just landed a TX/ACK pair, NULL when emitted from the unsolicited
//     path. Host adds samples to a sliding window and recomputes the
//     averaged `lat` per rxupd.
//   * `sp` (rolling success%) — included so the daemon-side rate of
//     successful TX matches reality between aggregate ticks.
//   * `q`/`ch`/`fw` (dongle housekeeping) — stay on the slow tick.
void emitRxUpd(const ReceiverInfo* r, bool includeFreshLatency) {
  if (!r) return;

  // M2: rate-limit latency/success-only churn. Decide whether an
  // operator-visible field changed; if not, and we emitted recently, skip
  // this line. The per-second aggregate status tick still carries the
  // averaged latency/success, so the host loses nothing but write volume.
  ReceiverInfo* rw = (ReceiverInfo*)r;  // same const-cast pattern used below
  uint32_t nowMs = millis();
  bool material = !rw->rxUpdEverEmitted
               || rw->loadComplete != rw->lastEmitLoad
               || rw->startReady   != rw->lastEmitReady
               || rw->showId       != rw->lastEmitShowId
               || rw->batteryLevel != rw->lastEmitBattery
               || ((rw->caps & RX_CAP_STATUS_FLAGS) && rw->stateFlags != rw->lastEmitFlags);
  if (!material) {
    for (uint8_t j = 0; j < CONTINUITY_INDEX_CT; j++) {
      if (rw->continuity[j] != rw->lastEmitContinuity[j]) { material = true; break; }
    }
  }
  if (!material && (nowMs - rw->lastRxUpdMs) < RXUPD_MIN_INTERVAL_MS) {
    return;
  }
  rw->lastRxUpdMs = nowMs;
  rw->rxUpdEverEmitted = true;
  rw->lastEmitLoad = rw->loadComplete;
  rw->lastEmitReady = rw->startReady;
  rw->lastEmitShowId = rw->showId;
  rw->lastEmitBattery = rw->batteryLevel;
  rw->lastEmitFlags = rw->stateFlags;
  for (uint8_t j = 0; j < CONTINUITY_INDEX_CT; j++) {
    rw->lastEmitContinuity[j] = rw->continuity[j];
  }

  StaticJsonDocument<256> d;
  d["type"] = "rxupd";
  d["i"]    = r->ident;
  d["n"]    = r->nodeID;
  d["b"]    = r->batteryLevel;
  d["s"]    = r->showId;
  d["l"]    = r->loadComplete ? 1 : 0;
  d["r"]    = r->startReady   ? 1 : 0;
  d["t"]    = r->lastMessageTime;
  if (includeFreshLatency && r->latencySampleCount > 0) {
    // Most-recent single-sample RTT lives one slot behind the write head.
    uint8_t lastIdx = (r->latencyNextIndex + MAX_LATENCY_SAMPLES - 1) %
                      MAX_LATENCY_SAMPLES;
    d["x"] = r->latencies[lastIdx];
  }
  d["sp"] = calculateSuccessPercent(r);
  // Playing / paused flags only from receivers that advertise them; without
  // the capability the host can't tell "not playing" from "unknown" (T12).
  if (r->caps & RX_CAP_STATUS_FLAGS) d["pf"] = r->stateFlags;
  d["rt"] = receiverRetryAvgX10(r);
  JsonArray ca = d.createNestedArray("c");
  for (uint8_t j = 0; j < CONTINUITY_INDEX_CT; j++) ca.add(r->continuity[j]);
  serializeJson(d, Host);
  Host.write('\n');
}

// Process a status message (whether received as an ACK payload or unsolicited).
// Validates length first.
//
// Returns the ReceiverInfo* we updated, or NULL if the frame was rejected.
// Caller is responsible for pushing a follow-up `rxupd` line — we deliberately
// don't emit here so the caller can record post-ACK bookkeeping (latency,
// success%) before the line goes out, ensuring rxupd carries the freshest
// possible sample for that TX.
ReceiverInfo* ingestStatusFrame(const uint8_t* buf, uint8_t len, uint64_t now) {
  if (len < LEGACY_RECEIVER_STATUS_SIZE) {
    if (debugMode > 0) {
      Host.print(F("WARN: short status frame, len=")); Host.println(len);
    }
    return NULL;
  }

  const ReceiverStatusMessage* status = (const ReceiverStatusMessage*)buf;
  if (status->type != RECEIVER_STATUS) {
    if (debugMode > 0) {
      Host.print(F("WARN: ack payload type mismatch=")); Host.println(status->type);
    }
    return NULL;
  }

  // ident must be a printable, NUL-terminated string starting with 'R'.
  // Copy 9 bytes: the 10th wire byte is stateFlags (T12). A pre-T12
  // receiver NUL-terminates at [9], so its idents (max 8 chars) fit too.
  char identBuf[sizeof(status->ident) + 1];
  memcpy(identBuf, status->ident, sizeof(status->ident));
  identBuf[sizeof(status->ident)] = '\0';
  if (identBuf[0] != 'R') {
    if (debugMode > 0) {
      Host.print(F("WARN: bogus ident in status: ")); Host.println(identBuf);
    }
    return NULL;
  }

  ReceiverInfo* r = getReceiverByIdent(String(identBuf), true);
  if (!r) {
    Host.print(F("ERR: Status from unknown ident/node ")); Host.println(status->nodeID);
    return NULL;
  }

  // Reconnect re-query (FW v29): a receiver that drops and comes back *within*
  // receiverInactivityTimeoutMs (default 1h) keeps its table entry, so the
  // autocreate-path auto-query above never re-fires -- the host would miss a
  // board/fire-duration change made while it was powered off. If the receiver
  // has been silent long enough that the host considers it offline, treat this
  // fresh status frame as a reconnect and re-arm a CONFIG_QUERY (same rationale
  // as the initial-connect/post-prune auto-query). The threshold tracks the
  // poll cadence (4 missed cycles) with an 8s floor so a single dropped poll
  // can't trip it and it still holds if clockSyncIntervalMs is retuned. The
  // configQueryPending guard skips freshly-registered receivers (flag already
  // set, lastMessageTime just seeded) and avoids redundant re-arms.
  uint32_t reconnectGapMs = clockSyncIntervalMs * 4UL;
  if (reconnectGapMs < 8000UL) reconnectGapMs = 8000UL;
  if (!r->configQueryPending && now > r->lastMessageTime &&
      (now - r->lastMessageTime) > reconnectGapMs) {
    r->configQueryPending = true;
  }

  uint16_t wireNodeID = status->nodeID;
  if (len >= sizeof(ReceiverStatusMessage)) {
    wireNodeID |= ((uint16_t)status->nodeIDHigh) << 8;
  }
  r->nodeID = wireNodeID;
  r->batteryLevel = status->batteryLevel;
  r->showId = status->showState & 0x3FFF;
  r->loadComplete = (status->showState & (1 << 14)) ? true : false;
  r->startReady   = (status->showState & (1 << 15)) ? true : false;
  r->lastMessageTime = now;
  r->continuity[0] = status->cont64_0;
  r->continuity[1] = status->cont64_1;
  r->stateFlags = status->stateFlags;
  return r;
}

// FW v16: emit a single `rxcfg` JSON line summarizing the latest
// CONFIG_RESPONSE for a receiver. Mirrors emitRxUpd's compact key
// scheme so the host parser can stay symmetric:
//   i=ident n=nodeID fw=fwVersion bv=boardVersion nb=numBoards
//   nbd=noBoardsDetected ca=cuesAvailable fd=fireDurationMs t=lastMsgTime
void emitRxCfg(const ReceiverInfo* r) {
  if (!r || !r->configValid) return;
  StaticJsonDocument<256> d;
  d["type"] = "rxcfg";
  d["i"]    = r->ident;
  d["n"]    = r->nodeID;
  d["fw"]   = r->fwVersion;
  d["bv"]   = r->boardVersion;
  d["bt"]   = r->boardType;
  d["nb"]   = r->numBoards;
  d["nbd"]  = r->noBoardsDetected;
  d["ca"]   = r->cuesAvailable;
  d["fd"]   = r->fireDurationMs;
  d["rc"]   = r->caps;
  if (r->caps & RX_CAP_RF_CONFIG) {
    d["ch"]  = r->rxRfChannel;
    d["sid"] = r->rxRfSystemId;
  }
  d["t"]    = r->lastMessageTime;
  serializeJson(d, Host);
  Host.write('\n');
}

// FW v16: ingest a RECEIVER_CONFIG_RESPONSE arrived via the ACK FIFO.
// Routed to from ingestAckPayload(). Updates the cached config fields,
// clears configQueryPending so future polls go back to CLOCK_SYNC, and
// emits the `rxcfg` line so the host can persist the new values.
ReceiverInfo* ingestConfigResponse(const uint8_t* buf, uint8_t len, uint64_t now) {
  if (len < sizeof(ReceiverConfigResponseMessage)) {
    if (debugMode > 0) {
      Host.print(F("WARN: short cfg resp, len=")); Host.println(len);
    }
    return NULL;
  }
  const ReceiverConfigResponseMessage* cr = (const ReceiverConfigResponseMessage*)buf;
  uint16_t wireNodeID = (uint16_t)cr->nodeID
      | (((uint16_t)cr->reserved[0]) << 8);
  if (wireNodeID == 0) {
    if (debugMode > 0) Host.println(F("WARN: cfg resp nodeID=0"));
    return NULL;
  }
  ReceiverInfo* r = getReceiverByNodeID(wireNodeID);
  if (!r) {
    // Unknown nodeID -- we don't have an ident here so we can't auto-create.
    // The next normal status frame will register the receiver, after which a
    // fresh config query (auto- or operator-driven) will succeed.
    if (debugMode > 0) {
      Host.print(F("WARN: cfg resp from unknown N")); Host.println(wireNodeID);
    }
    return NULL;
  }
  r->configValid       = true;
  r->configQueryPending = false;
  r->fwVersion         = cr->fwVersion;
  r->boardVersion      = cr->boardVersion;
  r->boardType         = cr->reserved[1];
  r->caps              = cr->reserved[3];
  r->rxRfChannel       = cr->reserved[4];
  r->rxRfSystemId      = cr->reserved[5];
  r->numBoards         = cr->numBoards;
  r->noBoardsDetected  = cr->noBoardsDetected;
  r->cuesAvailable     = cr->cuesAvailable;
  r->fireDurationMs    = cr->fireDurationMs;
  r->lastMessageTime   = now;
  emitRxCfg(r);
  return r;
}

// FW v16: dispatch an ACK-payload frame by leading type byte. Lets the
// receiver multiplex RECEIVER_STATUS and RECEIVER_CONFIG_RESPONSE
// across the same single ACK FIFO without a separate transport. New
// ACK payload types add new cases here.
ReceiverInfo* ingestAckPayload(const uint8_t* buf, uint8_t len, uint64_t now) {
  if (len == 0) return NULL;
  switch (buf[0]) {
    case RECEIVER_STATUS:
      return ingestStatusFrame(buf, len, now);
    case RECEIVER_CONFIG_RESPONSE:
      return ingestConfigResponse(buf, len, now);
    default:
      if (debugMode > 0) {
        Host.print(F("WARN: unknown ack type=")); Host.println(buf[0]);
      }
      return NULL;
  }
}

// Soft recovery: clear the radio FIFOs and reapply config without a power-cycle.
// Avoids the previous 20+ ms stall that blocked all other receivers.
void softRadioRecovery() {
  if (debugMode > 0) Host.println(F("INFO: soft radio recovery"));
  radio.flush_tx();
  radio.flush_rx();
  // Re-apply core settings in case a glitch corrupted a register.
  radio.setChannel(rfChannel);
  invalidateRetryPolicy();
  setRetryPolicy(rfArcCmd);
  radio.setPALevel(rfPaLevel);
  radio.setDataRate(RF24_250KBPS);
  radio.setCRCLength(RF24_CRC_16);
  radio.setAutoAck(true);
  radio.setAutoAck(0, true);
  // Re-arm dynamic payloads + ACK-payload features so a soft recovery doesn't
  // silently demote us to the legacy single-frame protocol.
  radio.enableDynamicPayloads();
  radio.enableAckPayload();
  radio.enableDynamicAck();   // broadcast frames are sent without auto-ACK (T27)
}

// Apply current rfChannel/rfSystemId to the live radio without a full reboot.
void applyRfConfig() {
  if (debugMode > 0) {
    Host.print(F("INFO: RF reconfigure ch=")); Host.print(rfChannel);
    Host.print(F(" sid=")); Host.println(rfSystemId);
  }
  radioEnterTx();
  radio.setChannel(rfChannel);
  // The reading pipe is kept for legacy unsolicited frames, but the dongle
  // stays in TX mode (see radioEnterTx).
  radio.openReadingPipe(0, masterReadAddress());
}

// Spectrum scan using the nRF24L01+'s RPD (Received Power Detector) register.
// RPD latches if any signal stronger than ~-64 dBm appeared during the last
// RX window — protocol-agnostic, so it sees Wi-Fi, BLE, microwaves, other
// nRF systems, etc. A single channel sample takes ~180us (1us PRX entry +
// ~130us settle + a small margin); a full 126-channel × 10-pass sweep is
// ~230ms. We block the main loop for the duration — fine for an explicitly
// host-initiated diagnostic, but the daemon must gate this behind
// !show_loaded && !armed.
//
// Output is a single JSON line so the host can parse one read.
void runRadioScan(uint16_t passes, uint8_t chStart, uint8_t chEnd) {
  if (chEnd > 125) chEnd = 125;
  if (chStart > chEnd) chStart = chEnd;
  if (passes == 0) passes = 1;
  if (passes > 50) passes = 50;  // hard cap to keep scan under ~1.2s

  const uint16_t nCh = (chEnd - chStart + 1);
  // Per-channel hit count buffer. 126 * uint16_t = 252B max — fine on stack.
  uint16_t hits[126];
  for (uint16_t i = 0; i < nCh; i++) hits[i] = 0;

  uint64_t startMs = millis();

  // Park the radio in a known state. Drain any pending TX/RX so leftover
  // ACK payloads don't pollute the first-channel RPD reading.
  radioEnterTx();
  radio.flush_tx();
  radio.flush_rx();

  for (uint16_t p = 0; p < passes; p++) {
    for (uint16_t i = 0; i < nCh; i++) {
      uint8_t ch = chStart + i;
      radio.setChannel(ch);
      radioEnterRx();
      // Trx2rx is ~130us on nRF24L01+. 180us gives us the settle + a
      // ~50us RPD latch window with margin.
      delayMicroseconds(180);
      if (radio.testRPD()) hits[i]++;
      radioEnterTx();
    }
  }

  uint64_t durMs = millis() - startMs;

  // Restore the radio to live operation BEFORE we spend time serializing
  // JSON, so polling resumes ASAP.
  applyRfConfig();

  // Emit a single JSON line. We size the doc generously: 126 channels × ~22B
  // per entry = ~2.8KB, plus headroom for the wrapper.
  DynamicJsonDocument doc(4096);
  doc["type"]        = "scan_result";
  doc["fw"]          = FW_VERSION;
  doc["passes"]      = passes;
  doc["ch_start"]    = chStart;
  doc["ch_end"]      = chEnd;
  doc["current_ch"]  = rfChannel;
  doc["started_ms"]  = startMs;
  doc["duration_ms"] = durMs;
  JsonArray arr = doc.createNestedArray("results");
  for (uint16_t i = 0; i < nCh; i++) {
    JsonObject o = arr.createNestedObject();
    o["ch"]   = chStart + i;
    o["hits"] = hits[i];
  }
  String out;
  serializeJson(doc, out);
  Host.println(out);
}

// Link-health bookkeeping for the global radio-recovery trigger (T08). A
// single powered-off receiver used to trigger softRadioRecovery() every 10
// polls although the radio was fine; recovery now needs a run of failures
// that spans at least two receivers with no success in between.
#define RECOVERY_FAIL_STREAK    20
static uint16_t globalFailStreak = 0;
static uint16_t globalFailFirstNode = 0;
static bool     globalFailMultiNode = false;

// isChipConnected() is an SPI round trip; check it once a second or right
// after a failed write instead of before every frame (T06).
static uint32_t lastChipCheckMs = 0;
static bool     chipConnected = true;

// Debug-only throughput stats (debugMode > 0): time spent in
// sendCommandFrame per frame and frames per second over 100 frames.
static uint32_t txStatFrames = 0;
static uint64_t txStatUs = 0;
static uint32_t txStatStartMs = 0;

// Core send-and-collect-status routine. With ACK-payloads enabled, radio.write()
// returns true once the receiver auto-ACKs. If that ACK carried a payload
// (which it should, since the receiver pre-loads its status), we read it out
// and ingest it as a status update.
bool sendCommandFrame(uint16_t nodeID, const void* msg, uint8_t msgLen, uint64_t now) {
  int64_t fnStartUs = esp_timer_get_time();
  uint32_t nowMs = millis();
  if (!chipConnected || nowMs - lastChipCheckMs >= 1000) {
    chipConnected = radio.isChipConnected();
    lastChipCheckMs = nowMs;
  }
  if (!chipConnected) {
    if (debugMode > 0) {
      Host.print(F("TX ERR: radio not connected, N")); Host.println(nodeID);
    }
    return false;
  }

  // Polls (CLOCK_SYNC) get the short retry policy, everything else the long
  // one. The dongle stays in TX mode between frames (radioEnterTx is a
  // no-op unless an RF scan left it listening).
  uint8_t msgType = ((const uint8_t*)msg)[0];
  setRetryPolicy(msgType == CLOCK_SYNC ? rfArcPoll : rfArcCmd);
  radioEnterTx();
  radio.openWritingPipe(receiverAddress(nodeID));

  // A CLOCK_SYNC queued with timestamp 0 is stamped here, as late as
  // possible, from the microsecond timer rounded to the nearest ms (T23).
  uint8_t frame[32];
  const void* txMsg = msg;
  if (msgType == CLOCK_SYNC && msgLen >= 9 && msgLen <= sizeof(frame) &&
      ((const ClockSyncMessage*)msg)->timestamp == 0) {
    memcpy(frame, msg, msgLen);
    uint64_t stamp = (uint64_t)((esp_timer_get_time() + 500) / 1000) + tsOffset;
    memcpy(frame + 1, &stamp, sizeof(stamp));
    txMsg = frame;
  }

  // Latency is the radio exchange only, not LED / host-input time earlier
  // in this loop pass.
  int64_t txStartUs = esp_timer_get_time();
  bool ok = radio.write(txMsg, msgLen);
  int64_t txEndUs = esp_timer_get_time();
  // Auto-retries the last frame needed (OBSERVE_TX ARC_CNT).
  uint8_t arc = radio.getARC();

  // Drain anything in the RX FIFO. With ACK payloads enabled, a successful
  // write deposits the receiver's status here. Use radio.available() rather
  // than isAckPayloadAvailable() so we also pick up rare stale entries
  // (legacy unsolicited frames during the migration window).
  ReceiverInfo* updatedR = NULL;
  while (radio.available()) {
    uint8_t ackBuf[32];
    uint8_t ackLen = radio.getDynamicPayloadSize();
    if (ackLen == 0 || ackLen > sizeof(ackBuf)) {
      // Library can return 0xFF on corrupt frames; flush and bail.
      radio.flush_rx();
      break;
    }
    radio.read(ackBuf, ackLen);
    ReceiverInfo* maybeR = ingestAckPayload(ackBuf, ackLen, now);
    if (maybeR) updatedR = maybeR;
  }

  if (ok) {
    globalFailStreak = 0;
    globalFailMultiNode = false;
    uint32_t latency = (uint32_t)((txEndUs - txStartUs + 500) / 1000);
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
      // Any successful exchange ends a backoff (T08).
      r->pollMisses = 0;
      r->skipRounds = 0;
      // Moving average of auto-retries per delivered frame, x16 (T13).
      r->retryAvg16 = r->retryAvg16 - r->retryAvg16 / 8 + arc * 2;
    }
    // Emit AFTER the latency/success bookkeeping so the just-arrived
    // sample is what the host sees. Prefer the pointer the ACK actually
    // came from, fall back to the node-id lookup.
    ReceiverInfo* emit = updatedR ? updatedR : r;
    if (emit) emitRxUpd(emit, true);
  } else {
    if (debugMode > 0) {
      Host.print(F("TX FAIL: N")); Host.println(nodeID);
    }
    chipConnected = radio.isChipConnected();
    lastChipCheckMs = millis();
    if (globalFailStreak == 0) {
      globalFailFirstNode = nodeID;
      globalFailMultiNode = false;
    } else if (nodeID != globalFailFirstNode) {
      globalFailMultiNode = true;
    }
    if (globalFailStreak < 0xFFFF) globalFailStreak++;
    if (globalFailStreak >= RECOVERY_FAIL_STREAK && globalFailMultiNode) {
      softRadioRecovery();
      globalFailStreak = 0;
      globalFailMultiNode = false;
    }
    ReceiverInfo* r = getReceiverByNodeID(nodeID);
    if (r) {
      pushCommandResult(r, false);
      if (r->consecutiveFailures < 0xFF) r->consecutiveFailures++;
      // Push the success% delta to the host even on TX fail, so the
      // displayed success rate dips in real time. Skip the fresh latency
      // sample (we don't have one) and don't update lmt — freshness is
      // still bounded by the most recent successful poll.
      emitRxUpd(r, false);
    }
  }

  if (debugMode > 0) {
    if (txStatFrames == 0) txStatStartMs = millis();
    txStatUs += (uint64_t)(esp_timer_get_time() - fnStartUs);
    if (++txStatFrames >= 100) {
      uint32_t spanMs = millis() - txStatStartMs;
      Host.print(F("INFO: txstat n=100 avg_us="));
      Host.print((uint32_t)(txStatUs / txStatFrames));
      Host.print(F(" fps="));
      Host.println(spanMs > 0 ? (uint32_t)(100000UL / spanMs) : 0);
      txStatFrames = 0;
      txStatUs = 0;
    }
  }
  return ok;
}

bool sendManualFire(uint16_t nodeID, uint8_t position, uint64_t now) {
  ManualFireMessage msg = { (uint8_t)MANUAL_FIRE, position };
  return sendCommandFrame(nodeID, &msg, sizeof(msg), now);
}

bool sendClockSync(uint16_t nodeID, uint64_t timestamp, uint64_t now) {
  // timestamp 0 = stamp at TX time: sendCommandFrame writes it immediately
  // before radio.write (T23), so the switch to TX and any queueing don't
  // make it stale. The receiver applies ADDITIONAL_CLOCK_TX_OFFSET for the
  // residual stamp-to-apply latency.
  ClockSyncMessage msg;
  msg.type = CLOCK_SYNC;
  msg.timestamp = timestamp;
  msg.epoch = clockEpoch;
  return sendCommandFrame(nodeID, &msg, sizeof(msg), now);
}

bool sendStartLoad(uint16_t nodeID, uint8_t numTargets, uint16_t showId, uint64_t now) {
  StartLoadMessage msg = { (uint8_t)START_LOAD, numTargets, showId };
  return sendCommandFrame(nodeID, &msg, sizeof(msg), now);
}

bool sendShowLoad(uint16_t nodeID, uint32_t t1, uint8_t p1, uint32_t t2, uint8_t p2, uint64_t now) {
  ShowLoadMessage msg = { (uint8_t)SHOW_LOAD, t1, p1, t2, p2 };
  return sendCommandFrame(nodeID, &msg, sizeof(msg), now);
}

bool sendShowLoadN(uint16_t nodeID, const ShowLoadNCue* cues, uint8_t count, uint64_t now) {
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

bool sendShowStart(uint16_t nodeID, uint64_t startTime, uint8_t numTargets, uint16_t showId, uint64_t now) {
  ShowStartMessage msg = { (uint8_t)SHOW_START, startTime, numTargets, showId };
  return sendCommandFrame(nodeID, &msg, sizeof(msg), now);
}

bool sendGeneric(uint16_t nodeID, uint8_t commandType, uint64_t now) {
  GenericMessage msg = { commandType };
  return sendCommandFrame(nodeID, &msg, sizeof(msg), now);
}

// PLAY / PAUSE with a synchronized effect time (T25); `at` 0 = legacy form.
bool sendGenericTimed(uint16_t nodeID, uint8_t commandType, uint64_t at, uint64_t now) {
  if (at == 0) return sendGeneric(nodeID, commandType, now);
  GenericTimedMessage msg = { commandType, at };
  return sendCommandFrame(nodeID, &msg, sizeof(msg), now);
}

// FW v16: send a RECEIVER_CONFIG_QUERY. Its auto-ACK carries the
// receiver's previously-loaded RECEIVER_STATUS (ingested as normal); the
// receiver then loads its CONFIG_RESPONSE into the ACK FIFO and keeps it
// there until the next inbound frame. dispatchOneCommand arms a follow-up
// poll (CONFIG_FOLLOWUP_MS later, T09) whose auto-ACK carries the response;
// ingestAckPayload routes it to ingestConfigResponse, which emits `rxcfg`.
// This used to block the loop with delay(8) between the two frames.
//
// If the follow-up is lost, configQueryPending stays set and the next poll
// slot for the receiver re-issues the query.
bool sendConfigQuery(uint16_t nodeID, uint8_t flags, uint16_t fire_dur_ms, uint64_t now) {
  ReceiverConfigSetMessage q;
  q.type = RECEIVER_CONFIG_QUERY;
  q.flags = flags;
  q.fire_duration_ms = fire_dur_ms;
  return sendCommandFrame(nodeID, &q, sizeof(q), now);
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
  rf433SendPulse(376, 1030);
}

void sendZeroMessage() {
  rf433SendPulse(1032, 566);
}

void sendBinaryString(const String &binaryString) {
  for (int i = 0; i < binaryString.length(); i++) {
    if (binaryString[i] == '1')      sendOneMessage();
    else if (binaryString[i] == '0') sendZeroMessage();
  }
  rf433SendPulse(400, 0);
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

// ---------------------------------------------------------------------------
// OTA flash mode driver.
// ---------------------------------------------------------------------------

// Translate an `otaDataRate` byte to the matching RF24 enum. Mirrors the
// receiver's otaWireRate(); duplicated here so we don't need a shared
// header.
rf24_datarate_e otaWireRate(uint8_t b) {
  if (b == 1) return RF24_1MBPS;
  if (b == 2) return RF24_2MBPS;
  return RF24_250KBPS;
}

// Hex helpers. We use raw 0..9a..fA..F in the wire protocol so a
// `flash_data` line is one printable token after the chunk index.
inline int hexNyb(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
  if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
  return -1;
}

// Parse 2*N hex characters from `s` into `out`. Returns the number of
// bytes decoded, or -1 on any malformed nibble. Caller pre-allocates
// `out` for at least N bytes; we cap at OTA_MAX_CHUNK_BYTES so a
// runaway line can't blow past the radio frame.
int parseHexBlob(const String& s, uint8_t* out, uint8_t outCap) {
  int len = s.length();
  if (len & 1) return -1;
  int bytes = len / 2;
  if (bytes > outCap) return -1;
  for (int i = 0; i < bytes; i++) {
    int hi = hexNyb(s.charAt(i * 2));
    int lo = hexNyb(s.charAt(i * 2 + 1));
    if (hi < 0 || lo < 0) return -1;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  return bytes;
}

int parseHexBlobC(const char* s, uint8_t* out, uint8_t outCap) {
  size_t len = strlen(s);
  while (len > 0 && (s[len - 1] == '\r' || s[len - 1] == '\n' || s[len - 1] == ' ')) {
    len--;
  }
  if (len & 1) return -1;
  size_t bytes = len / 2;
  if (bytes > outCap) return -1;
  for (size_t i = 0; i < bytes; i++) {
    int hi = hexNyb(s[i * 2]);
    int lo = hexNyb(s[i * 2 + 1]);
    if (hi < 0 || lo < 0) return -1;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  return (int)bytes;
}

// Drain the radio's RX FIFO and return the most recent ACK payload that
// looked like a RECEIVER_OTA_STATUS, or false if none was present. Same
// pattern sendCommandFrame uses for the normal status piggyback, just
// dispatched on the OTA type byte.
bool readOtaAckPayload(ReceiverOtaStatusMessage* outMsg) {
  bool found = false;
  while (radio.available()) {
    uint8_t buf[32];
    uint8_t len = radio.getDynamicPayloadSize();
    if (len == 0 || len > sizeof(buf)) {
      radio.flush_rx();
      break;
    }
    radio.read(buf, len);
    if (len >= LEGACY_RECEIVER_OTA_STATUS_SIZE &&
        buf[0] == RECEIVER_OTA_STATUS) {
      memset(outMsg, 0, sizeof(*outMsg));
      uint8_t copyLen = len < sizeof(*outMsg) ? len : sizeof(*outMsg);
      memcpy(outMsg, buf, copyLen);
      found = true;
    }
  }
  return found;
}

// Emit a single-line JSON event so the host can parse OTA state changes
// without re-using the per-second status frame. extras is merged shallowly
// at the top level (callers stuff per-event fields like idx / bytes / err
// into it).
void emitOtaEvent(const char* phase, JsonDocument& extras) {
  StaticJsonDocument<256> d;
  d["type"] = "ota";
  d["phase"] = phase;
  if (otaTargetIdent.length() > 0) d["ident"] = otaTargetIdent;
  d["n"] = otaTargetNodeID;
  JsonObject src = extras.as<JsonObject>();
  for (JsonPair kv : src) {
    d[kv.key().c_str()] = kv.value();
  }
  serializeJson(d, Host);
  Host.write('\n');
}

// Hot-path OTA ACK/NACK events use a compact line protocol instead of JSON.
// A full JSON ACK is ~80-100 bytes; over a 13k chunk image that is >1MB of
// dongle->host serial/log traffic on the same path that paces the transfer.
// These compact lines are ~18-35 bytes and avoid ArduinoJson work per chunk.
//
//   OA <idx> <state> <bytes> <attempts>
//   ON <idx> <rf_ok> <got_ack> <state> <err> <last> <bytes> <fatal>
//
// Lifecycle events (begin_ok/error/end_sent/done) stay JSON for readability.
// Non-blocking OTA line emitter. Builds the full line into a stack
// buffer, then writes it only if the USB-CDC TX ring buffer has space
// for the *whole* thing. Otherwise drops the line and bumps
// `otaSerialDropped`. This is the ONLY way to make Serial output safe
// from a slow/backed-up host: even with setTxTimeoutMs(20),
// Host.print does a per-byte loop that can block 20ms × N on a full
// FIFO -- chained, that's how the dongle main loop ends up wedged
// long enough to trip the watchdog.
//
// Returns the number of bytes written (0 if dropped). Always yields so
// the USB-CDC service task gets a chance to drain.
static inline size_t otaEmitLineNonBlocking(const char* buf, size_t len) {
  if (len == 0) return 0;
  // availableForWrite() returns 0 if the device isn't enumerated /
  // connected -- treat that the same as "no room", drop silently.
  int avail = Host.availableForWrite();
  if (avail <= 0 || (size_t)avail < len) {
    otaSerialDropped++;
    yield();
    return 0;
  }
  size_t n = Host.write((const uint8_t*)buf, len);
  yield();
  return n;
}

void emitOtaAckCompact(uint16_t idx, uint8_t state, uint32_t bytes, uint8_t attempts) {
  char buf[48];
  int n = snprintf(buf, sizeof(buf), "OA %u %u %u %u\n",
                   (unsigned)idx, (unsigned)state, (unsigned)bytes,
                   (unsigned)attempts);
  if (n > 0 && n < (int)sizeof(buf)) {
    otaEmitLineNonBlocking(buf, (size_t)n);
  }
}

void emitOtaNackCompact(uint16_t idx, bool rfOk, bool gotAck,
                        uint8_t state, uint8_t err, uint16_t last,
                        uint32_t bytes, uint8_t fatal) {
  char buf[64];
  int n = snprintf(buf, sizeof(buf), "ON %u %u %u %u %u %u %u %u\n",
                   (unsigned)idx, rfOk ? 1u : 0u, gotAck ? 1u : 0u,
                   (unsigned)state, (unsigned)err, (unsigned)last,
                   (unsigned)bytes, (unsigned)fatal);
  if (n > 0 && n < (int)sizeof(buf)) {
    otaEmitLineNonBlocking(buf, (size_t)n);
  }
}

// Liveness reply for `flash_ping`. Emits a ~40B compact line so the host
// can confirm the dongle's main loop is making progress without
// consuming a chunk-retry slot. Non-blocking: if the TX buffer is full
// we drop the pong (host treats that as a wedge anyway).
//   `OP <millis> <attempted> <acked> <retries> <last> <dropped>\n`
void emitOtaPongCompact() {
  char buf[64];
  int n = snprintf(buf, sizeof(buf), "OP %lu %u %u %u %u %lu\n",
                   (unsigned long)millis(),
                   (unsigned)otaChunksAttempted,
                   (unsigned)otaChunksAcked,
                   (unsigned)otaHwRetryBursts,
                   (unsigned)otaLastAckedChunk,
                   (unsigned long)otaSerialDropped);
  if (n > 0 && n < (int)sizeof(buf)) {
    otaEmitLineNonBlocking(buf, (size_t)n);
  }
}

// Send one OTA frame to the pinned target receiver. Mirrors the inner
// half of sendCommandFrame -- swap to TX, point at the right writing
// pipe, write, drain ACK FIFO, swap back to RX. Caller decides what to
// do with the ACK payload (or its absence).
bool sendOtaFrame(const void* payload, uint8_t payloadLen,
                  ReceiverOtaStatusMessage* ackOut, bool* gotAck) {
  *gotAck = false;
  if (otaTargetNodeID == 0) return false;
  applyRetries(RF_OTA_ARD, RF_OTA_ARC);
  radioEnterTx();
  radio.openWritingPipe(receiverAddress(otaTargetNodeID));
  bool ok = radio.write(payload, payloadLen);
  ReceiverOtaStatusMessage tmp;
  if (readOtaAckPayload(&tmp)) {
    if (ackOut) *ackOut = tmp;
    *gotAck = true;
  }
  // radio.write blocks up to ~95ms on a failed link (RF24 FAILURE_HANDLING
  // backstop). Yield so the USB-CDC service task can drain the dongle's
  // TX ring buffer between attempts -- otherwise multiple back-to-back
  // failed writes monopolize the loop task and Host.print stalls.
  // Also feed the WDT so the watchdog doesn't trip during a long but
  // legitimate recovery burst.
  esp_task_wdt_reset();
  yield();
  return ok;
}

void otaReassertRadioConfig(rf24_datarate_e rate) {
  radioEnterTx();
  radio.flush_tx();
  radio.flush_rx();
  radio.setChannel(rfChannel);
  radio.setDataRate(rate);
  radio.setPALevel(rfPaLevel);
  invalidateRetryPolicy();
  applyRetries(RF_OTA_ARD, RF_OTA_ARC);
  radio.setCRCLength(RF24_CRC_16);
  radio.setAutoAck(true);
  radio.setAutoAck(0, true);
  radio.enableDynamicPayloads();
  radio.enableAckPayload();
  radio.enableDynamicAck();
  radio.openReadingPipe(0, masterReadAddress());
  radio.openWritingPipe(receiverAddress(otaTargetNodeID));
  esp_task_wdt_reset();
  yield();
}

// Aggressive radio re-init: full radio.begin() restart from scratch.
// Used by `flash_recover` level 2 when the link has been silent long
// enough that the RF24 chip itself may be wedged (rare but does happen
// on a hostile RF environment with strong adjacent-channel transmitters).
//
// Returns true if begin() reported the radio is responding.
bool otaFullRadioRestart(rf24_datarate_e rate) {
  radioEnterTx();
  radio.powerDown();
  delay(10);
  bool ok = radio.begin(&SPI, rfCePin, rfCsnPin);
  if (!ok) {
    // Try once more with a longer settle.
    delay(30);
    ok = radio.begin(&SPI, rfCePin, rfCsnPin);
  }
  // begin() leaves the chip in TX standby with its default retry setting.
  radioListening = false;
  invalidateRetryPolicy();
  if (ok) {
    otaReassertRadioConfig(rate);
  }
  esp_task_wdt_reset();
  yield();
  return ok;
}

// Recover a chunk at the OTA rate. `rounds` and `attemptsPerRound`
// control how aggressively we retry in this window. Each round
// re-asserts radio config (cheap: ~5ms of SPI) before the attempts.
bool otaRecoverChunkAtCurrentRate(const void* payload, uint8_t payloadLen,
                                  uint16_t chunkIdx,
                                  ReceiverOtaStatusMessage* ackOut,
                                  bool* gotAckOut,
                                  uint8_t* attemptsOut,
                                  uint8_t rounds,
                                  uint8_t attemptsPerRound) {
  if (gotAckOut) *gotAckOut = false;
  if (attemptsOut) *attemptsOut = 0;

  for (uint8_t round = 0; round < rounds; round++) {
    // Reapply config each round. RF24 clones and long transfers can get into
    // stale FIFO / lost pipe states; this is cheap compared with aborting a
    // 200KB+ transfer.
    otaReassertRadioConfig(otaWireRate(otaDataRate));
    delay(5 + (round * 10));

    for (uint8_t attempt = 0; attempt < attemptsPerRound; attempt++) {
      ReceiverOtaStatusMessage ack;
      bool gotAck = false;
      bool ok = sendOtaFrame(payload, payloadLen, &ack, &gotAck);
      if (attemptsOut) (*attemptsOut)++;

      if (gotAckOut && gotAck) *gotAckOut = true;
      if (gotAck && ackOut) *ackOut = ack;

      if (ok && gotAck && ack.lastChunk == chunkIdx) {
        return true;
      }

      // The receiver is alive in OTA mode but hasn't accepted this chunk yet
      // (or ACK payload is one frame behind). Keep trying in this recovery
      // window instead of bouncing all the way back to the host.
      if (ok || gotAck) {
        delay(5);
      } else {
        delay(10);
      }
    }
  }

  otaReassertRadioConfig(otaWireRate(otaDataRate));
  return false;
}

// Best-effort cleanup before starting a new OTA session. A prior failed
// begin can leave the receiver parked at the target OTA rate until its
// inactivity watchdog fires. Sending OTA_ABORT at both possible rates pulls
// that half-open session back to normal polling before we try OTA_BEGIN again.
bool otaSendAbortAtRate(rf24_datarate_e rate) {
  OtaAbortMessage abortMsg;
  abortMsg.type = OTA_ABORT;

  ReceiverOtaStatusMessage ack;
  bool gotAck = false;
  otaReassertRadioConfig(rate);
  delay(5);
  bool ok = sendOtaFrame(&abortMsg, sizeof(abortMsg), &ack, &gotAck);
  delay(15);
  return ok || gotAck;
}

bool otaProbeReceiverAtNormalRate(const void* payload, uint8_t payloadLen) {
  otaReassertRadioConfig(RF24_250KBPS);
  delay(5);

  ReceiverOtaStatusMessage probeAck;
  bool probeGotAck = false;
  bool probeOk = sendOtaFrame(payload, payloadLen, &probeAck, &probeGotAck);

  // Restore OTA rate for any caller that decides to keep the session alive.
  otaReassertRadioConfig(otaWireRate(otaDataRate));

  // If radio.write succeeds at 250kbps, the node is reachable at normal rate.
  // It may ACK with regular RECEIVER_STATUS (not RECEIVER_OTA_STATUS), so
  // probeGotAck is not required.
  return probeOk;
}

// Tear down OTA mode without rebooting the dongle. Hops the radio back
// to the standard 250kbps so the rest of the fleet resumes polling
// promptly.
void otaFinishMode(const char* phase, const char* extraKey, const char* extraVal) {
  StaticJsonDocument<128> e;
  if (extraKey && extraVal) e[extraKey] = extraVal;
  emitOtaEvent(phase, e);

  otaActive = false;
  otaPhase = 0;
  otaTargetNodeID = 0;
  otaTargetIdent = "";
  otaTotalSize = 0;
  otaTotalChunks = 0;
  otaLastAckedChunk = 0xFFFF;
  otaLastChunkSentMs = 0;
  otaRejoinDeadlineMs = 0;

  // Always restore the channel + standard 250kbps so the rest of the
  // fleet can be polled normally even if we left flash mode mid-stream.
  radio.setDataRate(RF24_250KBPS);
  radio.openReadingPipe(0, masterReadAddress());
  radioEnterTx();
  // Bounce the radio's gap estimate by clearing TX/RX FIFOs.
  radio.flush_tx();
  radio.flush_rx();
}

// Service the post-`flash_end` rejoin window. Periodically pings the
// receiver at 250kbps and watches for a normal RECEIVER_STATUS ACK
// (which only the rebooted-into-new-firmware receiver will produce).
// Emits `ota_done` on success or `ota_timeout` after OTA_REJOIN_TIMEOUT_MS.
void serviceOtaRejoin(uint64_t now) {
  if (otaPhase != 2) return;

  // Send a no-op CLOCK_SYNC to the target every ~250ms.
  static uint64_t lastRejoinPing = 0;
  if (now - lastRejoinPing >= 250) {
    lastRejoinPing = now;
    applyRetries(RF_OTA_ARD, RF_OTA_ARC);
    radioEnterTx();
    radio.openWritingPipe(receiverAddress(otaTargetNodeID));
    ClockSyncMessage msg;
    msg.type = CLOCK_SYNC;
    msg.timestamp = now;
    msg.epoch = clockEpoch;
    bool ok = radio.write(&msg, sizeof(msg));
    // If a normal-status ACK came back, the rebooted receiver is alive
    // again. Anything that ingestStatusFrame accepts counts.
    if (ok) {
      while (radio.available()) {
        uint8_t buf[32];
        uint8_t len = radio.getDynamicPayloadSize();
        if (len == 0 || len > sizeof(buf)) {
          radio.flush_rx();
          break;
        }
        radio.read(buf, len);
        if (len > 0 && buf[0] == RECEIVER_STATUS) {
          ReceiverInfo* r = ingestStatusFrame(buf, len, now);
          if (r) emitRxUpd(r, false);
          // otaFinishMode below restores 250kbps.
          otaFinishMode("done", nullptr, nullptr);
          return;
        }
      }
    }
  }

  if (now > otaRejoinDeadlineMs) {
    otaFinishMode("timeout", nullptr, nullptr);
  }
}

// Handle the `flash_begin <ident> <size> <chunks> <crc32_hex> [<rate>]`
// serial command. Switches the dongle into OTA mode pinned to that
// receiver and sends the OTA_BEGIN frame at the standard 250kbps so the
// receiver has a chance to ACK before its own rate hop.
void handleFlashBegin(const String& args) {
  if (otaActive) { Host.println(F("CV BUSY OTA")); return; }

  // Parse: <ident> <size> <chunks> <crc32_hex> [<rate>]
  int sp1 = args.indexOf(' ');
  if (sp1 < 0) { Host.println(F("CV flash_begin: ident missing")); return; }
  String ident = args.substring(0, sp1);
  String rest = args.substring(sp1 + 1);
  int sp2 = rest.indexOf(' ');
  if (sp2 < 0) { Host.println(F("CV flash_begin: size missing")); return; }
  uint32_t totalSize = (uint32_t)atoll(rest.substring(0, sp2).c_str());
  rest = rest.substring(sp2 + 1);
  int sp3 = rest.indexOf(' ');
  if (sp3 < 0) { Host.println(F("CV flash_begin: chunks missing")); return; }
  uint16_t totalChunks = (uint16_t)atoi(rest.substring(0, sp3).c_str());
  rest = rest.substring(sp3 + 1);
  int sp4 = rest.indexOf(' ');
  String crcStr = (sp4 < 0) ? rest : rest.substring(0, sp4);
  uint32_t crc32 = (uint32_t)strtoul(crcStr.c_str(), NULL, 16);
  uint8_t rate = 2;  // default 2Mbps
  if (sp4 > 0) {
    int v = rest.substring(sp4 + 1).toInt();
    if (v == 0 || v == 1 || v == 2) rate = (uint8_t)v;
  }

  if (totalSize == 0 || totalChunks == 0) {
    Host.println(F("CV flash_begin: zero size/chunks")); return;
  }

  ReceiverInfo* r = getReceiverByIdent(ident, false);
  if (!r) { Host.println(F("CV flash_begin: RNE")); return; }
  if (r->nodeID == 0) {
    Host.print(F("CV flash_begin: NID0 ")); Host.println(ident); return;
  }

  // Drop any queued commands targeting this receiver -- we're about to
  // monopolize the radio for it, and stale queued cmds would just spew
  // post-OTA when the receiver comes back.
  scrubQueueForNode(r->nodeID);

  otaActive = true;
  otaPhase = 1;
  otaTargetNodeID = r->nodeID;
  otaTargetIdent = ident;
  otaDataRate = rate;
  otaTotalSize = totalSize;
  otaTotalChunks = totalChunks;
  otaLastAckedChunk = 0xFFFF;
  otaChunksAttempted = 0;
  otaChunksAcked = 0;
  otaHwRetryBursts = 0;

  OtaBeginMessage msg;
  msg.type = OTA_BEGIN;
  msg.totalSize = totalSize;
  msg.totalChunks = totalChunks;
  msg.dataRate = rate;
  msg.crc32 = crc32;

  // Start from a known radio state and clear any half-open OTA session left
  // behind by a previous failed begin. Target-rate abort is the important
  // one: after Phase A succeeds, a receiver immediately hops to the requested
  // OTA rate, so a quick user retry would otherwise start at 250kbps while
  // the receiver is still listening at 1M/2M.
  otaReassertRadioConfig(RF24_250KBPS);
  otaSendAbortAtRate(RF24_250KBPS);
  if (rate != 0) {
    otaSendAbortAtRate(otaWireRate(rate));
  }
  otaReassertRadioConfig(RF24_250KBPS);

  // OTA_BEGIN handshake -- two-phase, retried on a marginal link.
  //
  // Why two phases: the very first OTA_BEGIN we send at 250kbps causes the
  // receiver's NRF24 to auto-ACK at the hardware level *before* its CPU
  // processes the message. That auto-ACK carries whatever was previously
  // in the receiver's TX FIFO -- i.e. its regular RECEIVER_STATUS payload,
  // not OTA_PREP_OK. The receiver only loads PREP_OK into the FIFO and
  // hops the data rate *after* the auto-ACK has fired. So we cannot
  // confirm OTA prep from the first attempt's ACK alone, and a naive
  // retry at 250kbps would fail because the receiver has now hopped.
  //
  //   Phase A: send OTA_BEGIN at 250kbps. Goal is just to get the receiver
  //            into OTA mode. ACK payload contents don't matter here.
  //   Phase B: hop the dongle to the target rate, send OTA_BEGIN again
  //            (idempotent on the receiver side -- it just refreshes the
  //            ACK payload), and *now* read PREP_OK out of the ACK. This
  //            confirms (a) Update.begin() succeeded on the receiver and
  //            (b) the rate hop is symmetric.
  //
  // Loop strategy:
  //   * Phase A is needed only ONCE per OTA session. After it succeeds
  //     once, the receiver is in OTA mode at the target rate; we stay at
  //     the target rate and keep retrying Phase B until PREP_OK arrives.
  //   * If Phase A itself misses at 250kbps, also probe at the target
  //     rate. This catches the common retry-after-failure case where the
  //     receiver was already pushed into OTA mode by the previous attempt
  //     and has not hit its 30s inactivity watchdog yet.
  //   * If Phase A succeeded but Phase B never sees PREP_OK, the receiver
  //     will tear itself down via OTA_INACTIVITY_TIMEOUT_MS (30s) and
  //     rejoin normal polling. Operator can retry.
  ReceiverOtaStatusMessage ack;
  bool gotAck = false;
  bool got_prep_ok = false;
  bool any_tx_ok = false;
  bool receiver_pushed = false;  // Phase A succeeded at least once
  bool dongle_at_target = false;
  bool tried_target_recovery = false;
  const uint8_t BEGIN_HOST_RETRIES = 16;
  for (uint8_t attempt = 0; attempt < BEGIN_HOST_RETRIES; attempt++) {
    if (!receiver_pushed) {
      // Phase A: send OTA_BEGIN at 250kbps to push the receiver into
      // OTA mode. ACK payload contents don't matter on this attempt --
      // the receiver hadn't processed the message yet when its auto-ACK
      // fired (auto-ACK rides whatever was in the TX FIFO, i.e. the
      // pre-OTA RECEIVER_STATUS payload).
      if (dongle_at_target) {
        radio.setDataRate(RF24_250KBPS);
        dongle_at_target = false;
        delay(2);
      }
      bool ok_a = sendOtaFrame(&msg, sizeof(msg), &ack, &gotAck);
      if (ok_a) {
        any_tx_ok = true;
        receiver_pushed = true;
        // radio.write() returns after the hardware auto-ACK, before the
        // receiver CPU has necessarily finished Update.begin() and hopped.
        // Give flash prep real breathing room before the target-rate probe.
        delay(80);
      } else {
        // TX failed at 250kbps. This can be a genuinely marginal link, but
        // it can also mean a previous begin already pushed the receiver to
        // the target OTA rate. Probe there before declaring no begin ACK.
        if (rate != 0) {
          tried_target_recovery = true;
          radio.setDataRate(otaWireRate(rate));
          dongle_at_target = true;
          delay(5);
          bool ok_recover = sendOtaFrame(&msg, sizeof(msg), &ack, &gotAck);
          if (ok_recover) {
            any_tx_ok = true;
            receiver_pushed = true;
            delay(40);
          } else {
            radio.setDataRate(RF24_250KBPS);
            dongle_at_target = false;
            delay(40);
            continue;
          }
        } else {
          delay(40);
          continue;
        }
      }
    }

    // Phase B: probe at the target rate to read a fresh PREP_OK ACK.
    if (!dongle_at_target) {
      radio.setDataRate(otaWireRate(rate));
      dongle_at_target = true;
      delay(2);
    }
    bool ok_b = sendOtaFrame(&msg, sizeof(msg), &ack, &gotAck);
    if (ok_b) any_tx_ok = true;

    if (ok_b && gotAck && ack.state == /*PREP_OK*/1) {
      got_prep_ok = true;
      break;
    }
    if (ok_b && gotAck && ack.state != /*PREP_OK*/1) {
      // Receiver responded but rejected the BEGIN (Update.begin()
      // failed -- likely oversize or no OTA partition). No amount
      // of retrying will fix this; bail with the receiver's own
      // error code.
      radio.setDataRate(RF24_250KBPS);
      static char errBuf[24];
      snprintf(errBuf, sizeof(errBuf), "rx_err_%u", (unsigned)ack.errorCode);
      otaFinishMode("error", "err", errBuf);
      return;
    }
    // Probe TX failed or ACK was lost. Stay at target rate and try
    // Phase B again on next iteration -- the receiver is in OTA mode
    // at the target rate now, so dropping back to 250kbps would just
    // make us miss it entirely.
    delay(40);
  }

  if (!got_prep_ok) {
    // Restore standard rate before bailing so the rest of the fleet
    // can resume polling. If the receiver was successfully pushed into
    // OTA mode but we couldn't confirm via Phase B, it'll tear itself
    // down via OTA_INACTIVITY_TIMEOUT_MS (30s) and rejoin normally.
    if (dongle_at_target) radio.setDataRate(RF24_250KBPS);
    const char* errStr;
    if (!any_tx_ok) {
      errStr = tried_target_recovery ? "no_begin_ack_250_or_target" : "no_begin_ack_250";
    } else if (!receiver_pushed) {
      errStr = tried_target_recovery ? "no_begin_ack_250_or_target" : "no_begin_ack_250";
    } else {
      errStr = "no_prep_ok_ack";
    }
    otaFinishMode("error", "err", errStr);
    return;
  }

  StaticJsonDocument<128> e;
  e["size"] = totalSize;
  e["chunks"] = totalChunks;
  e["rate"] = rate;
  emitOtaEvent("begin_ok", e);
}

bool sendPreparedOtaDataFrame(uint16_t chunkIdx, uint8_t* buf, uint8_t totalLen) {
  memcpy(otaLastFrame, buf, totalLen);
  otaLastFrameLen = totalLen;
  otaLastFrameChunk = chunkIdx;

  otaChunksAttempted++;

  ReceiverOtaStatusMessage ack;
  bool gotAck = false;
  bool ok = false;
  uint8_t usedAttempts = 0;
  for (uint8_t attempt = 0; attempt <= OTA_PER_CHUNK_RETRIES; attempt++) {
    usedAttempts = attempt + 1;
    ok = sendOtaFrame(buf, totalLen, &ack, &gotAck);
    if (ok && gotAck && ack.lastChunk == chunkIdx) break;
    // Brief pause between dongle-side retries so the receiver has time
    // to push a fresh ACK payload after each attempt.
    delay(2);
  }
  if (usedAttempts > 1) otaHwRetryBursts++;

  if (ok && gotAck && ack.lastChunk == chunkIdx) {
    otaLastAckedChunk = chunkIdx;
    otaChunksAcked++;
    emitOtaAckCompact(chunkIdx, ack.state, ack.bytesReceived, usedAttempts);
    return true;
  }

  // Normal retry burst failed. Try to self-remediate (level 0 recovery)
  // before handing the failure to the host: reassert RF24 config + resend
  // the idempotent chunk at the OTA rate. This recovers transient stalls
  // where the receiver is still alive and expecting this same chunk.
  //
  // FW v14: do NOT do the heavy 250kbps probe here. That hops the radio
  // twice (20-50ms wall time) and isn't useful in the common case
  // (single failed chunk). The host-side OtaFlashDriver will escalate
  // to `flash_recover <idx> 1`/`2` if multiple consecutive chunks fail,
  // and *those* paths do the probe.
  uint8_t recoveryAttempts = 0;
  bool recoveryGotAck = gotAck;
  ReceiverOtaStatusMessage recoveryAck = ack;
  bool recovered = otaRecoverChunkAtCurrentRate(
    buf, totalLen, chunkIdx, &recoveryAck, &recoveryGotAck, &recoveryAttempts,
    OTA_RECOVERY_ROUNDS, OTA_RECOVERY_ATTEMPTS_PER_ROUND
  );
  otaHwRetryBursts++;
  if (recovered) {
    otaLastAckedChunk = chunkIdx;
    otaChunksAcked++;
    emitOtaAckCompact(
      chunkIdx,
      recoveryAck.state,
      recoveryAck.bytesReceived,
      usedAttempts + recoveryAttempts
    );
    return true;
  }

  // Still failed. Report a recoverable NACK so the host's retry loop
  // can decide whether to resend, escalate to `flash_recover <idx> 1`,
  // or eventually give up. We do NOT do the 250kbps probe here -- that's
  // explicitly a level-2 recover behavior.
  uint8_t nackState = recoveryGotAck ? recoveryAck.state : 0;
  uint8_t nackErr = recoveryGotAck ? recoveryAck.errorCode : 0;
  uint16_t nackLast = recoveryGotAck ? recoveryAck.lastChunk : 0xFFFF;
  uint32_t nackBytes = recoveryGotAck ? recoveryAck.bytesReceived : 0;
  emitOtaNackCompact(chunkIdx, ok, recoveryGotAck, nackState, nackErr,
                     nackLast, nackBytes, 0);
  return false;
}

// Handle `flash_data <chunkIdx> <hex_payload>` -- one OTA_DATA frame to
// the pinned target. Auto-retries up to OTA_PER_CHUNK_RETRIES times on
// no-ACK before reporting failure to the host.
void handleFlashDataC(const char* args) {
  if (!otaActive || otaPhase != 1) {
    Host.println(F("CV flash_data: not in OTA stream phase"));
    return;
  }
  char* endPtr = nullptr;
  unsigned long idxUl = strtoul(args, &endPtr, 10);
  if (endPtr == args || *endPtr != ' ') {
    Host.println(F("CV flash_data: hex missing"));
    return;
  }
  uint16_t chunkIdx = (uint16_t)idxUl;
  const char* hex = endPtr + 1;

  uint8_t buf[32];
  // First two bytes after the type byte hold chunkIdx; we'll fill them
  // with the OtaDataMessage header below.
  uint8_t* dataDest = buf + sizeof(OtaDataMessage);
  int dataLen = parseHexBlobC(hex, dataDest,
                              sizeof(buf) - sizeof(OtaDataMessage));
  if (dataLen < 0 || dataLen == 0) {
    Host.println(F("CV flash_data: bad hex"));
    return;
  }

  OtaDataMessage* hdr = (OtaDataMessage*)buf;
  hdr->type = OTA_DATA;
  hdr->chunkIdx = chunkIdx;

  uint8_t totalLen = (uint8_t)(sizeof(OtaDataMessage) + dataLen);
  sendPreparedOtaDataFrame(chunkIdx, buf, totalLen);
  otaLastChunkSentMs = (uint64_t)(millis() + tsOffset);
}

void handleFlashData(const String& args) {
  handleFlashDataC(args.c_str());
}

// `flash_recover <idx> [<level>]` -- escalating link-recovery for a
// stuck chunk. Levels are independent; the host typically calls
// level 0 first, then 1, then 2 across host-side retries.
//
//   Level 0 (REPLAY, ~150ms wall time):
//     * Idempotent fast-ack: if idx is already <= otaLastAckedChunk we
//       have nothing to do, ack immediately from cached state.
//     * Otherwise reassert RF24 config + replay the stored frame for
//       2 rounds * 3 attempts = up to 6 sendOtaFrame calls.
//
//   Level 1 (SOFT, ~250ms wall time):
//     * softRadioRecovery() (flush_tx/rx + reapply core registers).
//     * Reassert OTA-rate config.
//     * Replay stored frame, 3 rounds * 3 attempts = up to 9 calls.
//
//   Level 2 (FULL, ~400-600ms wall time):
//     * Full radio.begin() restart + reapply config.
//     * Replay stored frame, 3 rounds * 3 attempts.
//     * If still failing, probe the receiver at 250kbps to detect
//       receiver-side OTA teardown (fatal -- host must give up).
void handleFlashRecoverC(const char* args) {
  if (!otaActive || otaPhase != 1) {
    Host.println(F("CV flash_recover: not in OTA stream phase"));
    return;
  }
  char* endPtr = nullptr;
  unsigned long idxUl = strtoul(args, &endPtr, 10);
  uint16_t chunkIdx = (uint16_t)idxUl;
  if (endPtr == args) {
    emitOtaNackCompact(chunkIdx, false, false, 0, 0, otaLastAckedChunk, 0, 0);
    return;
  }
  uint8_t level = OTA_RECOVER_LEVEL_REPLAY;
  if (*endPtr == ' ') {
    unsigned long lvl = strtoul(endPtr + 1, nullptr, 10);
    if (lvl <= OTA_RECOVER_LEVEL_FULL) level = (uint8_t)lvl;
  }

  // Idempotent fast-ack: if the receiver has already applied this chunk
  // (we just lost the ACK on the way back to the host) re-ack immediately
  // from cached state. No radio work, no risk of triggering a fresh
  // wedge. The receiver's OTA path treats duplicate idx as a no-op.
  if (otaLastAckedChunk != 0xFFFF && chunkIdx <= otaLastAckedChunk) {
    emitOtaAckCompact(chunkIdx, /*RUNNING*/2,
                      (uint32_t)(otaLastAckedChunk + 1) *
                          (uint32_t)OTA_MAX_CHUNK_BYTES,
                      0);
    return;
  }

  // We need a stored frame matching this idx to replay. If it doesn't
  // line up, the host got out of sync (rare); report a non-fatal NACK so
  // the host's normal retry loop can resync via `flash_data`.
  if (otaLastFrameLen == 0 || otaLastFrameChunk != chunkIdx) {
    emitOtaNackCompact(chunkIdx, false, false, 0, 0, otaLastAckedChunk, 0, 0);
    return;
  }

  // Per-level pre-recovery setup.
  if (level == OTA_RECOVER_LEVEL_SOFT) {
    softRadioRecovery();
    otaReassertRadioConfig(otaWireRate(otaDataRate));
  } else if (level == OTA_RECOVER_LEVEL_FULL) {
    bool ok = otaFullRadioRestart(otaWireRate(otaDataRate));
    if (!ok) {
      // Radio chip itself is unresponsive. This is a hardware-level
      // failure -- bail out of OTA mode so the host stops trying. The
      // dongle's main loop will keep running; the operator can re-init
      // by re-flashing or power-cycling.
      emitOtaNackCompact(chunkIdx, false, false, 0, 0, otaLastAckedChunk,
                         0, 1);
      otaFinishMode("error", "err", "radio_dead");
      return;
    }
  }

  uint8_t rounds = (level == OTA_RECOVER_LEVEL_REPLAY) ? 2 : 3;
  uint8_t attemptsPerRound = OTA_RECOVERY_ATTEMPTS_PER_ROUND;
  uint8_t attempts = 0;
  bool gotAck = false;
  ReceiverOtaStatusMessage ack;
  bool recovered = otaRecoverChunkAtCurrentRate(
    otaLastFrame, otaLastFrameLen, chunkIdx, &ack, &gotAck, &attempts,
    rounds, attemptsPerRound
  );
  otaHwRetryBursts++;
  if (recovered) {
    otaLastAckedChunk = chunkIdx;
    otaChunksAcked++;
    emitOtaAckCompact(chunkIdx, ack.state, ack.bytesReceived, attempts);
    otaLastChunkSentMs = (uint64_t)(millis() + tsOffset);
    return;
  }

  // Level 2 only: if recovery at OTA rate failed, probe at 250kbps to
  // tell the host whether the receiver tore down OTA mode (fatal) or
  // the link is just deeply lossy (recoverable).
  bool fatal = false;
  if (level == OTA_RECOVER_LEVEL_FULL) {
    if (otaProbeReceiverAtNormalRate(otaLastFrame, otaLastFrameLen)) {
      fatal = true;
    }
  }
  emitOtaNackCompact(
    chunkIdx,
    false,
    gotAck,
    gotAck ? ack.state : 0,
    gotAck ? ack.errorCode : 0,
    gotAck ? ack.lastChunk : otaLastAckedChunk,
    gotAck ? ack.bytesReceived : 0,
    fatal ? 1 : 0
  );
  if (fatal) {
    otaFinishMode("error", "err", "rx_dropped_ota");
  }
}

void handleFlashRecover(const String& args) {
  handleFlashRecoverC(args.c_str());
}

// `flash_ping` -- liveness probe. Emits OP <millis> <attempted> <acked>
// <retries> <last>. Doesn't touch the radio. Useful for the host to
// verify the dongle's main loop is making progress when chunk acks
// are stuck.
void handleFlashPing() {
  emitOtaPongCompact();
}

// Handle `flash_end` -- send OTA_END to the receiver, then enter the
// post-end rejoin watch.
void handleFlashEnd() {
  if (!otaActive || otaPhase != 1) {
    Host.println(F("CV flash_end: not in OTA stream phase"));
    return;
  }
  OtaEndMessage msg;
  msg.type = OTA_END;
  ReceiverOtaStatusMessage ack;
  bool gotAck = false;
  bool ok = false;

  // Same reasoning as handleFlashBegin: a single OTA_END that's lost on
  // a marginal link means the receiver never calls Update.end(true), so
  // it sits in OTA_STATE_RUNNING until its inactivity watchdog tears it
  // down -- and the new firmware is never committed. Retry until either
  // the receiver acks DONE or we exhaust attempts.
  const uint8_t END_HOST_RETRIES = 6;
  for (uint8_t attempt = 0; attempt < END_HOST_RETRIES; attempt++) {
    ok = sendOtaFrame(&msg, sizeof(msg), &ack, &gotAck);
    // The receiver reboots almost immediately after Update.end(true),
    // so on the *successful* attempt we may not get an ACK back at all
    // (it rebooted before its NRF24 could push the ACK). Treat
    // rf_ok=true as success even without an ACK; we'll confirm post-
    // reboot via serviceOtaRejoin.
    if (ok) break;
    delay(8);
  }

  StaticJsonDocument<128> e;
  e["rf_ok"] = ok;
  e["got_ack"] = gotAck;
  if (gotAck) {
    e["state"] = ack.state;
    e["err"] = ack.errorCode;
  }
  emitOtaEvent("end_sent", e);

  // Hop the radio back to 250kbps for the rejoin window. The receiver
  // is mid-reboot at this point and will come back at 250kbps.
  delay(20);
  radio.setDataRate(RF24_250KBPS);

  otaPhase = 2;
  otaRejoinDeadlineMs = (uint64_t)(millis() + tsOffset) + OTA_REJOIN_TIMEOUT_MS;
}

void handleFlashAbort() {
  if (!otaActive) {
    Host.println(F("CV flash_abort: not in OTA"));
    return;
  }
  // Best-effort: tell the receiver to tear down. It might already be
  // unreachable (e.g. mid-reboot), in which case we still finish on
  // our side so the dongle resumes normal operation.
  OtaAbortMessage msg;
  msg.type = OTA_ABORT;
  ReceiverOtaStatusMessage ack;
  bool gotAck = false;
  if (otaPhase == 1) {
    sendOtaFrame(&msg, sizeof(msg), &ack, &gotAck);
  }
  otaFinishMode("aborted", nullptr, nullptr);
}

// Host-requested soft reboot. The operator triggers this from the UI
// (Settings → Dongle → "Reboot dongle") when the dongle needs a clean
// restart without unplugging the USB cable or reflashing -- e.g. to clear
// transient radio state or recover a wedged-but-not-watchdog-tripped link.
// We ack first so the host log shows the command landed, flush the USB-CDC
// TX FIFO so that ack actually leaves before the USB device tears down,
// then give the host a beat to read it before esp_restart() drops the
// link. This mirrors the watchdog's soft-reset path (trigger_panic=false):
// the device comes back on the same /dev/tty.usbmodem* within ~2s, the
// bridge's auto-reconnect re-attaches, and the daemon re-runs msync /
// receiver sync exactly as it does after a WDT reboot or a replug.
void handleReboot() {
  Host.println(F("C+ reboot"));
  Host.flush();
  delay(50);
  esp_restart();
}

// Hub WiFi settings. Replies are a single `wifi_cfg` JSON line; the stored
// password is only ever described (pass_set / pass_default), never echoed.
//   wifi_get
//   wifi_set {"ssid":"...","pass":"...","txpower":8.5}   (any key may be omitted;
//                                          txpower is the AP transmit power in
//                                          dBm, applied at once and stored)
//   wifi_reset                              (back to the built-in defaults)
void reportWifiConfig(bool ok, const char* err) {
  StaticJsonDocument<384> d;
  omni_hub::wifiDescribe(d);
  d["ok"] = ok;
  if (err != nullptr) d["err"] = err;
  serializeJson(d, Host);
  Host.write('\n');
}

// Diagnostic: one fresh read of the host module's input register.
// bits[i] is input index i (1 = high / switch closed).
void reportHostInputs() {
  uint8_t raw = readHostInputs();
  char bits[9];
  for (uint8_t i = 0; i < 8; i++) bits[i] = ((raw >> i) & 1) ? '1' : '0';
  bits[8] = '\0';
  StaticJsonDocument<160> d;
  d["type"]   = "host_inputs";
  d["raw"]    = raw;
  d["bits"]   = bits;
  d["arm"]    = (raw >> dcfg.armInputIndex) & 1;
  d["start"]  = (raw >> dcfg.startInputIndex) & 1;
  d["manual"] = (raw >> dcfg.manualInputIndex) & 1;
  serializeJson(d, Host);
  Host.write('\n');
}

void handleWifiSet(const String& args) {
  StaticJsonDocument<256> in;
  if (deserializeJson(in, args) != DeserializationError::Ok || !in.is<JsonObject>()) {
    reportWifiConfig(false, "expected {\"ssid\":\"...\",\"pass\":\"...\"}");
    return;
  }
  const char* ssid = in["ssid"] | (const char*)nullptr;
  const char* pass = in["pass"] | (const char*)nullptr;
  bool hasTxPower = in.containsKey("txpower");
  float txPower = hasTxPower ? in["txpower"].as<float>() : NAN;
  if (ssid == nullptr && pass == nullptr && !hasTxPower) {
    reportWifiConfig(false, "nothing to set");
    return;
  }
  const char* err = nullptr;
  bool ok = omni_hub::wifiSet(ssid, pass, &err, txPower);
  reportWifiConfig(ok, err);
}

// T27 broadcast control. `bcast <op> <showId> <at>` is handled at once (not
// queued): the frame goes to broadcastAddress() without auto-ACK, 5 times
// 3ms apart, then once more ~100ms later from loop(). Receivers apply a
// given seq once. Delivery is confirmed per receiver from the status flags
// (T12); the host follows up with unicast for receivers that didn't change.
#define BCAST_BURST_COUNT     5
#define BCAST_BURST_GAP_US    3000
#define BCAST_LATE_REPEAT_MS  100
static uint8_t bcastSeq = 0;
static BroadcastControlMessage bcastPending;
static uint32_t bcastRepeatDueMs = 0;   // 0 = none

static void sendBroadcastFrame(const BroadcastControlMessage& m) {
  radioEnterTx();
  radio.openWritingPipe(broadcastAddress());
  radio.write(&m, sizeof(m), true);   // multicast: NO_ACK bit set
}

bool sendBroadcastControl(uint8_t op, uint16_t showId, uint64_t at) {
  if (op < 1 || op > 4) return false;
  BroadcastControlMessage m;
  m.type = BCAST_CONTROL;
  m.op = op;
  m.seq = ++bcastSeq;
  m.showId = showId;
  m.at = at;
  for (uint8_t i = 0; i < BCAST_BURST_COUNT; i++) {
    if (i > 0) delayMicroseconds(BCAST_BURST_GAP_US);
    sendBroadcastFrame(m);
  }
  bcastPending = m;
  uint32_t due = millis() + BCAST_LATE_REPEAT_MS;
  bcastRepeatDueMs = due ? due : 1;
  return true;
}

void serviceBroadcastRepeat() {
  if (bcastRepeatDueMs == 0 || (int32_t)(millis() - bcastRepeatDueMs) < 0) return;
  bcastRepeatDueMs = 0;
  sendBroadcastFrame(bcastPending);
}

void processSerialCommandBody(String inStr) {
  inStr.trim();
  if (inStr.length() == 0) return;

  if (inStr.startsWith("{")) { parseLedJSON(inStr); return; }

  // Bare-word commands (no args) — handled before the space-required parser
  // so manual serial testing of e.g. `scan` doesn't require a trailing arg.
  if (inStr == "scan")        { runRadioScan(10, 0, 125); return; }
  if (inStr == "flash_end")   { handleFlashEnd();         return; }
  if (inStr == "flash_abort") { handleFlashAbort();       return; }
  if (inStr == "flash_ping")  { handleFlashPing();        return; }
  if (inStr == "reboot" || inStr == "restart") { handleReboot(); return; }
  if (inStr == "host_inputs") { reportHostInputs(); return; }
  if (inStr == "wifi_get")    { reportWifiConfig(true, nullptr); return; }
  if (inStr == "wifi_reset")  { omni_hub::wifiReset(); reportWifiConfig(true, nullptr); return; }

  int firstSpace = inStr.indexOf(' ');
  if (firstSpace < 0) { cmdResult = CMD_REJECTED; Host.println(F("C?NFS")); return; }
  String cmdStr = inStr.substring(0, firstSpace);
  String args = inStr.substring(firstSpace + 1);

  if (cmdStr == "wifi_set") { handleWifiSet(args); return; }

  // OTA flash mode commands. The bare-word forms (flash_end, flash_abort)
  // are dispatched up above before the space-split. flash_begin /
  // flash_data both have their own grammar (not the standard
  // `cmd IDENT params` shape) so they bypass the receiver lookup below.
  if (cmdStr == "flash_begin") { handleFlashBegin(args); return; }
  if (cmdStr == "flash_data")  { handleFlashData(args);  return; }
  if (cmdStr == "flash_recover") { handleFlashRecover(args); return; }

  if (cmdStr == "bcast") {
    // bcast <op> <showId> <at>
    if (otaActive) { cmdResult = CMD_REJECTED; Host.println(F("CV BUSY OTA")); return; }
    unsigned op = 0, showId = 0;
    unsigned long long at = 0;
    if (sscanf(args.c_str(), "%u %u %llu", &op, &showId, &at) < 2 ||
        !sendBroadcastControl((uint8_t)op, (uint16_t)showId, (uint64_t)at)) {
      cmdResult = CMD_REJECTED;
      Host.println(F("CV bcast"));
    }
    return;
  }

  if (cmdStr == "433fire") {
    if (isValidMessage(args)) {
      String binaryString = parseBinaryString(args);
      int repetitions = parseRepetitions(args);
      if (debugMode > 0) {
        Host.print(F("Processing 433MHz: ")); Host.print(binaryString);
        Host.print(F(" x")); Host.println(repetitions);
      }
      for (int i = 0; i < repetitions; i++) sendBinaryString(binaryString);
      if (debugMode > 0) Host.println(F("C+ 433"));
    } else {
      cmdResult = CMD_REJECTED; Host.println(F("CV 433"));
    }
    return;
  }

  // RF spectrum scan. No ident, optional whitespace-separated args:
  //   scan                       → 10 passes, full 0..125
  //   scan <passes>              → custom passes, full 0..125
  //   scan <passes> <s> <e>      → custom passes + channel range
  // Always emits a `scan_result` JSON line; the host parses + persists it.
  if (cmdStr == "scan") {
    uint16_t passes  = 10;
    uint8_t  chStart = 0;
    uint8_t  chEnd   = 125;
    // `args` is everything after "scan ". When invoked as bare "scan", the
    // outer parser already returned C?NFS at firstSpace<0, so here we
    // always have at least one token.
    int sp1 = args.indexOf(' ');
    String t1 = (sp1 < 0) ? args : args.substring(0, sp1);
    if (t1.length() > 0) {
      long v = t1.toInt();
      if (v > 0) passes = (uint16_t)v;
    }
    if (sp1 > 0) {
      String rest = args.substring(sp1 + 1);
      int sp2 = rest.indexOf(' ');
      if (sp2 > 0) {
        chStart = (uint8_t)constrain(rest.substring(0, sp2).toInt(), 0, 125);
        chEnd   = (uint8_t)constrain(rest.substring(sp2 + 1).toInt(), 0, 125);
      }
    }
    runRadioScan(passes, chStart, chEnd);
    return;
  }

  int secondSpace = args.indexOf(' ');
  // `msync` and `forget` are single-arg commands; `rxcfg` is single-arg
  // when invoked as a pure fetch (no key/value tail). Everything else
  // requires `IDENT <params...>`.
  if (secondSpace < 0 && cmdStr != "msync" && cmdStr != "forget" && cmdStr != "rxcfg") {
    cmdResult = CMD_REJECTED; Host.println(F("C?NSS")); return;
  }

  String ident = (secondSpace > 0) ? args.substring(0, secondSpace) : args;
  String paramsStr = (secondSpace > 0) ? args.substring(secondSpace + 1) : "";

  if (cmdStr == "msync") {
    uint64_t ts = atoll(paramsStr.c_str());
    tsOffset = ts - millis();
    clockEpoch++;
    Host.println(F("C+ msync"));
    return;
  }

  // forget IDENT — host-driven removal of a receiver from the poll table.
  // Used after the user disables/deletes the receiver in the DB-backed UI.
  // We don't bounce the radio or the queue; if there's a pending command for
  // this ident in the queue, dispatchOneCommand will simply not find the
  // receiver and report no-route.
  if (cmdStr == "forget") {
    if (ident.length() == 0) { cmdResult = CMD_REJECTED; Host.println(F("CV forget")); return; }
    if (removeReceiverByIdent(ident)) {
      Host.print(F("C+ forget ")); Host.println(ident);
    } else {
      Host.print(F("CV forget RNF ")); Host.println(ident);
    }
    return;
  }

  ReceiverInfo* rinfo = getReceiverByIdent(ident, true);
  if (!rinfo) { cmdResult = CMD_REJECTED; Host.println(F("CV RNE")); return; }

  // Drop the previous "if nodeID==0 then targetNodeID=1" footgun. If we don't
  // know the receiver's nodeID yet (haven't heard from it), we can't address
  // it. Tell the operator clearly instead of misfiring on N1.
  if (rinfo->nodeID == 0) {
    cmdResult = CMD_REJECTED; Host.print(F("CV NID0 ")); Host.println(ident);
    return;
  }
  uint16_t targetNodeID = rinfo->nodeID;

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
    // An explicit sync (registration, retry_receiver) ends any poll backoff
    // so the operator can force an immediate retry (T08).
    rinfo->pollMisses = 0;
    rinfo->skipRounds = 0;
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
    // Grammar is exactly `startload IDENT <numTargets> <showId>` — no repeat
    // suffix. Do NOT apply the trailing-token repeat heuristic here: a showId
    // of 1..10 would be mistaken for a repeat count, dropping the last param
    // and rejecting the command (CV startload). That leaves the receiver with
    // currentShowId==0 even though cues still load (cyan LED, showId 0).
    int spaceIdx = paramsStr.indexOf(' ');
    if (spaceIdx < 0) { cmdResult = CMD_REJECTED; Host.println(F("CV startload")); return; }
    qc.startload_numTargets = paramsStr.substring(0, spaceIdx).toInt();
    qc.startload_showId = paramsStr.substring(spaceIdx + 1).toInt();
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
    if (!parseShowLoadN(paramsStr, qc)) { cmdResult = CMD_REJECTED; Host.println(F("CV showloadn")); return; }
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
  } else if (cmdStr == "rxcfg") {
    // FW v16: receiver config query/set. Grammar:
    //   rxcfg IDENT                  (pure fetch)
    //   rxcfg IDENT fd <ms>          (set fire_duration_ms + fetch)
    // Future writable knobs add new tokens after the ident, each as
    // `<key> <value>`. Unknown tokens are rejected so a typoed key
    // doesn't silently no-op (looking like a successful set on the host
    // side without anything actually changing on the receiver).
    qc.messageType = RECEIVER_CONFIG_QUERY;
    qc.cfg_flags = 0;
    qc.cfg_fire_duration_ms = 0;
    String rest = paramsStr;
    rest.trim();
    while (rest.length() > 0) {
      int sp = rest.indexOf(' ');
      String key = (sp > 0) ? rest.substring(0, sp) : rest;
      if (sp <= 0) {
        cmdResult = CMD_REJECTED; Host.print(F("CV rxcfg missing value for ")); Host.println(key);
        return;
      }
      String afterKey = rest.substring(sp + 1);
      afterKey.trim();
      int sp2 = afterKey.indexOf(' ');
      String val = (sp2 > 0) ? afterKey.substring(0, sp2) : afterKey;
      String tail = (sp2 > 0) ? afterKey.substring(sp2 + 1) : String("");
      tail.trim();
      if (key == "fd") {
        long fdv = val.toInt();
        if (fdv <= 0 || fdv > 65535) {
          cmdResult = CMD_REJECTED; Host.print(F("CV rxcfg fd out-of-range ")); Host.println(val);
          return;
        }
        qc.cfg_flags |= CFG_FLAG_SET_FIRE_DURATION;
        qc.cfg_fire_duration_ms = (uint16_t)fdv;
      } else {
        cmdResult = CMD_REJECTED; Host.print(F("CV rxcfg unknown key ")); Host.println(key);
        return;
      }
      rest = tail;
    }
  } else if (cmdStr == "play" || cmdStr == "stop" || cmdStr == "reset" || cmdStr == "pause") {
    if (cmdStr == "play")       qc.messageType = GENERIC_PLAY;
    else if (cmdStr == "stop")  qc.messageType = GENERIC_STOP;
    else if (cmdStr == "reset") qc.messageType = GENERIC_RESET;
    else                        qc.messageType = GENERIC_PAUSE;
    int lastSpace = paramsStr.lastIndexOf(' ');
    if (lastSpace > 0) {
      int rep = paramsStr.substring(lastSpace + 1).toInt();
      qc.repeat_count = rep > 0 ? rep : 1;
      // `play|pause IDENT <at> <repeat>`: <at> was always a 0 placeholder;
      // non-zero is the synchronized effect time (T25).
      if (qc.messageType == GENERIC_PLAY || qc.messageType == GENERIC_PAUSE) {
        qc.sync_timestamp = strtoull(paramsStr.substring(0, lastSpace).c_str(), nullptr, 10);
      }
    }
  } else {
    cmdResult = CMD_REJECTED; Host.println(F("C?UK"));
    return;
  }

  if (qc.messageType != 0) {
    // The queue now owns the result for this sequence number (T14).
    qc.seq = pendingSeq;
    pendingSeq = 0;
    if (qc.messageType == GENERIC_STOP) {
      // Anything queued for this node that would re-arm or restart it after
      // the stop goes: PLAY, SHOW_START and load frames.
      scrubQueueForNodeTypes(targetNodeID,
          TYPE_BIT(GENERIC_PLAY) | TYPE_BIT(SHOW_START) | TYPE_BIT(START_LOAD) |
          TYPE_BIT(SHOW_LOAD) | TYPE_BIT(SHOW_LOADN));
    } else if (qc.messageType == GENERIC_PAUSE) {
      // PAUSE jumps the queue, so an older queued PLAY would otherwise run
      // after it and undo the pause.
      scrubQueueForNodeTypes(targetNodeID, TYPE_BIT(GENERIC_PLAY));
    }
    if (isPriorityType(qc.messageType)) enqueuePriorityCommand(qc);
    else enqueueCommand(qc);
    if (debugMode > 0) {
      Host.print(F("C+ Q (repeat=")); Host.print(qc.repeat_count); Host.println(F(")"));
    }
  } else {
    cmdResult = CMD_REJECTED; Host.println(F("C? PE"));
  }
}

// T14 command acks. A host line may start with `#<seq> ` (1..65535). For
// every such line exactly one `K <seq> <result> <q>` follows:
//   1 delivered (auto-ACK received) / handled, for immediate commands
//   0 not delivered after all repeats
//   2 dropped (queue full, evicted, or scrubbed by a later STOP / forget)
//   3 rejected by the parser
// q is the queue depth at the time. Lines without a prefix behave exactly
// as before. Advertised as bit 0 of `caps` in the status tick.
void processSerialCommand(String inStr) {
  inStr.trim();
  pendingSeq = 0;
  if (inStr.length() > 1 && inStr.charAt(0) == '#') {
    int sp = inStr.indexOf(' ');
    long v = (sp > 1) ? inStr.substring(1, sp).toInt() : 0;
    if (sp < 0 || v <= 0 || v > 65535) {
      Host.println(F("C?SEQ"));
      return;
    }
    pendingSeq = (uint16_t)v;
    inStr = inStr.substring(sp + 1);
  }
  cmdResult = CMD_HANDLED;
  processSerialCommandBody(inStr);
  // Not consumed by the queue: an immediate command or a rejection.
  if (pendingSeq != 0) emitCmdResult(pendingSeq, cmdResult);
  pendingSeq = 0;
}

// One complete host line, from USB serial or a hub WebSocket client.
// Provisioning commands (GETID / SETID / SETBOARD / ...) are only honored
// over USB so a WiFi client can't re-identify the board.
void dispatchHostLine(char* line, bool fromSerial) {
  if (line[0] == '\0') return;
  if (fromSerial && dcfg.provisioningHook != nullptr && dcfg.provisioningHook(line)) return;
  // OTA hot-path commands are parsed as C strings to avoid thousands of
  // Arduino String heap allocations during a firmware image transfer.
  // Heap fragmentation here can make the dongle appear to "quit" after
  // a few thousand chunks.
  if (strncmp(line, "flash_data ", 11) == 0) {
    handleFlashDataC(line + 11);
  } else if (strncmp(line, "flash_recover ", 14) == 0) {
    handleFlashRecoverC(line + 14);
  } else if (strcmp(line, "flash_ping") == 0) {
    // Hot-path liveness probe -- bypass String parsing so a
    // wedged-by-backpressure dongle can still reply quickly
    // once it catches up on the inbound buffer.
    handleFlashPing();
  } else {
    String s = String(line);
    processSerialCommand(s);
  }
}

void onHubLine(char* line) {
  dispatchHostLine(line, false);
}

void serviceSerialInput() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialBufferIndex > 0) {
        serialLineBuffer[serialBufferIndex] = '\0';
        dispatchHostLine(serialLineBuffer, true);
        serialBufferIndex = 0;
      }
      if (c == '\r' && Serial.available() > 0 && Serial.peek() == '\n') Serial.read();
    } else if (serialBufferIndex < (SERIAL_BUFFER_SIZE - 1)) {
      serialLineBuffer[serialBufferIndex++] = c;
    } else {
      serialBufferIndex = 0;
      if (debugMode > 0) Host.println(F("WARN: Serial buffer overflow"));
    }
  }
}

// Follow-up poll delays (T09). Status is one exchange behind: the ACK to a
// command carries the status loaded before that command was processed.
// A short follow-up poll after a state-changing command brings the new
// state (loadComplete, startReady, ...) to the host without waiting for
// the receiver's next round-robin poll. 10ms covers the receiver's status
// rebuild (up to ~3ms with 8 boards); 8ms is the config-response gap the
// blocking sendConfigQuery used to wait.
#define FOLLOWUP_MS        10
#define CONFIG_FOLLOWUP_MS  8

// Backoff for registered receivers that don't answer (T08). After
// POLL_BACKOFF_AFTER_MISSES unanswered polls in a row a receiver is polled
// only every 2nd, 3rd, then 5th round (skipRounds 1, 2, then capped at 4),
// so a powered-off unit stops costing a full retry burst every cycle. With
// the cap, a receiver that comes back is found within ~5 cycles (~10s at
// the default 2s interval). Host commands to it are never skipped.
#define POLL_BACKOFF_AFTER_MISSES 3
#define POLL_BACKOFF_MAX_ROUNDS   4

static inline bool armsFollowUp(uint8_t t) {
  switch (t) {
    case START_LOAD: case SHOW_LOAD: case SHOW_LOADN: case SHOW_START:
    case GENERIC_PLAY: case GENERIC_STOP: case GENERIC_RESET: case GENERIC_PAUSE:
    case RESET_DVC: case RECEIVER_CONFIG_QUERY:
      return true;
    default:
      return false;
  }
}

static inline bool nodeHasQueuedCommand(uint16_t nodeID) {
  int idx = cmdQueueHead;
  for (int k = 0; k < cmdQueueCount; k++) {
    if (commandBuffer[idx].targetNodeID == nodeID) return true;
    idx = (idx + 1) % MAX_COMMANDS_IN_QUEUE;
  }
  return false;
}

// Dispatch one command from the queue. With ACK payloads, this is non-blocking
// in the sense that radio.write() returns within ~3ms (success) to ~22ms
// (all-retry failure) — no 150ms application-level wait, no busy-poll loop.
void dispatchOneCommand(uint64_t now) {
  if (isQueueEmpty()) return;

  QueuedCommand cmd;
  if (!dequeueCommand(cmd)) return;

  if (cmd.targetNodeID == 0 && cmd.messageType != CLOCK_SYNC) {
    Host.print(F("WARN: cmd for N0 dropped, type=")); Host.println(cmd.messageType);
    emitCmdResult(cmd.seq, CMD_NOT_DELIVERED);
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
      case GENERIC_PAUSE:
        ok = sendGenericTimed(cmd.targetNodeID, cmd.messageType, cmd.sync_timestamp, now); break;
      case GENERIC_STOP:
      case GENERIC_RESET:
      case RESET_DVC:
        ok = sendGeneric(cmd.targetNodeID, cmd.messageType, now); break;
      case RECEIVER_CONFIG_QUERY:
        ok = sendConfigQuery(cmd.targetNodeID, cmd.cfg_flags,
                             cmd.cfg_fire_duration_ms, now); break;
      default:
        Host.print(F("ERR: unknown cmd type=")); Host.println(cmd.messageType);
        emitCmdResult(cmd.seq, CMD_NOT_DELIVERED);
        return;
    }
    if (ok) gotAck = true;
  }
  emitCmdResult(cmd.seq, gotAck ? CMD_HANDLED : CMD_NOT_DELIVERED);

  ReceiverInfo* ri = getReceiverByNodeID(cmd.targetNodeID);
  if (ri) {
    if (gotAck && armsFollowUp(cmd.messageType)) {
      uint32_t due = millis() + (cmd.messageType == RECEIVER_CONFIG_QUERY
                                 ? CONFIG_FOLLOWUP_MS : FOLLOWUP_MS);
      ri->followUpDueMs = due ? due : 1;
    }
    // T08: only background polls count toward the backoff; explicit host
    // commands and follow-up polls never do.
    if (!gotAck && (cmd.qflags & QF_POLL) && ri->pollMisses < 0xFF) {
      ri->pollMisses++;
      if (ri->pollMisses >= POLL_BACKOFF_AFTER_MISSES) {
        uint8_t e = ri->pollMisses - POLL_BACKOFF_AFTER_MISSES;
        ri->skipRounds = (e >= 2) ? POLL_BACKOFF_MAX_ROUNDS : (uint8_t)(1 << e);
      }
    }
  }
}

static inline bool receiverBackedOff(const ReceiverInfo& r) {
  return r.pollMisses >= POLL_BACKOFF_AFTER_MISSES;
}

uint8_t countBackedOffReceivers() {
  uint8_t n = 0;
  for (uint8_t i = 0; i < numReceivers; i++) {
    if (receivers[i].nodeID != 0 && receiverBackedOff(receivers[i])) n++;
  }
  return n;
}

// T09: queue a follow-up poll for one receiver whose follow-up is due and
// that has nothing queued. Returns true if one was queued.
static bool maybeQueueFollowUp() {
  uint32_t nowMs = millis();
  for (uint8_t i = 0; i < numReceivers; i++) {
    ReceiverInfo& r = receivers[i];
    if (r.followUpDueMs == 0 || r.nodeID == 0) continue;
    if ((int32_t)(nowMs - r.followUpDueMs) < 0) continue;
    // A queued command's own ACK carries the status (and re-arms the
    // follow-up after it), so leave the field set and look again later.
    if (nodeHasQueuedCommand(r.nodeID)) continue;
    r.followUpDueMs = 0;
    QueuedCommand qc = {};
    qc.targetNodeID = r.nodeID;
    qc.repeat_count = 1;
    qc.messageType = CLOCK_SYNC;
    qc.sync_timestamp = 0;
    qc.qflags = QF_FOLLOWUP;
    enqueueCommand(qc);
    return true;
  }
  return false;
}

// TDMA-style poll: round-robin one receiver per pollInterval. The "poll"
// itself is just a CLOCK_SYNC — its ACK carries the receiver's status.
// This means status freshness is bounded by (numReceivers * pollInterval),
// and the master never bursts all syncs at once.
void maybePollNextReceiver(uint64_t now) {
  if (numReceivers == 0) return;
  if (maybeQueueFollowUp()) return;

  // Spread one poll per (clockSyncIntervalMs / receivers in the normal
  // state). Backed-off receivers are visited between those polls without
  // taking a slot of their own (T08).
  uint8_t normal = 0;
  for (uint8_t i = 0; i < numReceivers; i++) {
    if (receivers[i].nodeID != 0 && !receiverBackedOff(receivers[i])) normal++;
  }
  uint32_t pollSpacingMs = clockSyncIntervalMs / (normal > 0 ? normal : 1);
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

    if (receiverBackedOff(r) && r.skipRounds > 0) {
      r.skipRounds--;
      continue;
    }

    // Don't double-poll if there's already a queued command for this node;
    // the queued command's ACK will carry status. Advance to the next slot.
    if (nodeHasQueuedCommand(r.nodeID)) continue;

    QueuedCommand qc = {};
    qc.targetNodeID = r.nodeID;
    qc.repeat_count = 1;
    qc.qflags = QF_POLL;
    if (r.configQueryPending) {
      // FW v16: instead of the regular CLOCK_SYNC poll, dispatch a
      // pure-fetch CONFIG_QUERY (flags=0). Its follow-up poll (T09)
      // retrieves the CONFIG_RESPONSE from the ACK FIFO and carries the
      // clock sync, so the cadence for this receiver isn't skipped.
      qc.messageType = RECEIVER_CONFIG_QUERY;
      qc.cfg_flags = 0;
      qc.cfg_fire_duration_ms = 0;
    } else {
      qc.messageType = CLOCK_SYNC;
      qc.sync_timestamp = 0;  // 0 = stamp at TX time
    }
    enqueueCommand(qc);
    lastPollDispatchTime = now;
    return;
  }
  // Every receiver was skipped (all backed off or already queued). Count
  // this as a slot so skipRounds count down once per spacing, not once per
  // loop pass.
  lastPollDispatchTime = now;
}

// Waits for the USB host to open the port, pulsing the status LEDs.
static void waitForSerialHost() {
  while (!Serial) {
    updateConnectionLEDs();
    delay(10);
  }
  updateConnectionLEDs();
  delay(1000);
}

static void startHub() {
  Host.beginHub();
  omni_hub::HubConfig hc;
  hc.ident      = dcfg.ident;
  hc.fwVersion  = dcfg.fwVersion;
  hc.nrfChannel = omni_hub::storedNrfChannel(rfChannel);
  hc.onLine     = onHubLine;
  if (!omni_hub::begin(hc)) {
    Serial.println(F("ERROR: WiFi AP failed to start; restarting"));
    Serial.flush();
    delay(2000);
    esp_restart();
  }
  // Seed the radio with the same channel the AP was placed against; the
  // host's first config JSON can still move it.
  rfChannel = hc.nrfChannel;
}

void setup(const OmniDongleConfig& cfg) {
  dcfg = cfg;
  numPixels = cfg.hostPixelCount;
  if (numPixels < 1) numPixels = 1;
  if (numPixels > MAX_HOST_PIXELS) numPixels = MAX_HOST_PIXELS;
  rf433Mask = (uint8_t)(1 << (cfg.rf433OutputIndex & 7));

  hostOutShadow = 0;
  shiftHostOutput(hostOutShadow);

  // See os4_dongle: cap how long a stalled USB host can block a print.
  Serial.setTxTimeoutMs(20);

  if (dcfg.hubMode) {
    startHub();
  } else {
    waitForSerialHost();
  }

  // Subscribe the loop task to the hardware task watchdog (see os4_dongle
  // setup() for the rationale and the init/reconfigure dance).
  esp_task_wdt_config_t wdtCfg = {
    .timeout_ms     = OTA_DONGLE_WDT_TIMEOUT_S * 1000,
    .idle_core_mask = 0,
    .trigger_panic  = false,
  };
  esp_err_t wdtErr = esp_task_wdt_init(&wdtCfg);
  if (wdtErr == ESP_ERR_INVALID_STATE) {
    esp_task_wdt_reconfigure(&wdtCfg);
  }
  esp_task_wdt_add(NULL);

  serialBufferIndex = 0;
  serialLineBuffer[0] = '\0';

  // Radio wiring and PA level follow the omni board version, same as the
  // receiver role.
  if (dcfg.boardVersion < 6) {
    SPI.begin(36, 37, 35);
    rfCePin = RF24_CE_PIN_PRE_V6;
    rfCsnPin = RF24_CSN_PIN_PRE_V6;
    rfPaLevel = RF24_PA_HIGH;
  } else {
    SPI.begin(35, 33, 34);
    rfCePin = RF24_CE_PIN_V6_PLUS;
    rfCsnPin = RF24_CSN_PIN_V6_PLUS;
    rfPaLevel = RF24_PA_MAX;
  }

  setupLEDs();

  Host.println(F("Initializing Radio..."));
  while (!radio.begin(&SPI, rfCePin, rfCsnPin)) {
    Host.println(F("ERROR: Radio hardware not responding!"));
    pixels.setPixelColor(5 % numPixels, COLOR_RED); pixels.show();
    for (int i = 0; i < 50; i++) {
      esp_task_wdt_reset();
      if (dcfg.hubMode) omni_hub::loop();
      updateConnectionLEDs();
      delay(100);
    }
  }
  radio.setDataRate(RF24_250KBPS);
  radio.setPALevel(rfPaLevel);
  radio.setChannel(rfChannel);
  // Retry policy is applied per frame (setRetryPolicy); start with the
  // command policy.
  invalidateRetryPolicy();
  setRetryPolicy(rfArcCmd);
  radio.setCRCLength(RF24_CRC_16);
  radio.setAutoAck(true);
  radio.setAutoAck(0, true);
  radio.enableDynamicPayloads();
  radio.enableAckPayload();
  // Broadcast control frames (T27) go out without auto-ACK.
  radio.enableDynamicAck();

  // The reading pipe is kept for legacy unsolicited frames, but the dongle
  // stays in TX mode from here on (see radioEnterTx).
  radio.openReadingPipe(0, masterReadAddress());
  radio.stopListening();
  radioListening = false;

  Host.println(dcfg.hubMode ? F("M+ (RF24 Master Hub Online v4: ACK-payloads, WiFi hub)")
                            : F("M+ (RF24 Master Hub Online v4: ACK-payloads)"));

  // Static memory check for the receiver table and command queue (T11).
  Host.print(F("INFO: rx_entry=")); Host.print((unsigned)sizeof(ReceiverInfo));
  Host.print(F("B rx_table=")); Host.print((unsigned)sizeof(receivers));
  Host.print(F("B queue=")); Host.print((unsigned)sizeof(commandBuffer));
  Host.print(F("B free_heap=")); Host.println((unsigned)ESP.getFreeHeap());

  for (int i = 0; i < numPixels; i++) {
    pixels.setPixelColor(i, COLOR_GREEN); pixels.show(); delay(50);
    pixels.setPixelColor(i, COLOR_OFF); pixels.show();
  }
  pixels.setPixelColor(0, COLOR_GREEN);
  pixels.show();
  ledStates[0] = 1;
  for (int i = 1; i < numPixels; i++) { ledStates[i] = 0; ledEffects[i] = 0; }
  ledDirty = true;

  Serial.setTimeout(1);
}

// One pass of host-link input: USB serial always (provisioning works in
// either role), plus the WiFi hub when it's running.
static void serviceHostInput() {
  serviceSerialInput();
  if (dcfg.hubMode) {
    omni_hub::loop();
    Host.poll();
  }
}

// Per-second status line (T10). Top-level fields are unchanged; the
// receivers[] array carries a rotating slice of at most STATUS_SLICE
// receivers (`rn` = registered receivers, `ro` = this slice's offset) so the
// line stays small whatever the fleet size: with 32 receivers the old full
// dump was ~5KB and needed ~9KB of heap per tick, and in hub mode it broke
// the 8KB host line limit above ~50 receivers. The host and the Android app
// merge per entry; operator-visible changes still go out at once as rxupd,
// so the slice only refreshes the slow fields (averaged latency, sp, rt).
// One static document, serialised straight to the host link: no String
// and no per-tick allocation.
#define STATUS_SLICE 8
static StaticJsonDocument<4096> statusDoc;
static uint8_t statusSliceOffset = 0;

void emitStatusTick(uint64_t now) {
  statusDoc.clear();
  JsonDocument& doc = statusDoc;
  doc["timestamp"] = now;
  doc["q"] = cmdQueueCount;
  doc["qmax"] = MAX_COMMANDS_IN_QUEUE;
  doc["fw"] = FW_VERSION;
  doc["ch"] = rfChannel;
  // Identify the dongle itself so the host flashes the right image.
  doc["bt"] = DONGLE_BOARD_TYPE;
  doc["bv"] = dcfg.boardVersion;
  doc["csim"] = clockSyncIntervalMs;
  // Receivers currently in poll backoff (T08).
  doc["off"] = countBackedOffReceivers();
  // Capability bits: bit 0 = `#<seq>` command acks (T14).
  doc["caps"] = DONGLE_CAPS_CMD_ACKS | DONGLE_CAPS_TIMED_PAUSE | DONGLE_CAPS_BCAST;

  uint32_t totalLat = 0; int avgLat = 0;
  if (latencySampleCount > 0) {
    for (uint8_t i = 0; i < latencySampleCount; i++) totalLat += latencies[i];
    avgLat = (int)((totalLat + latencySampleCount / 2) / latencySampleCount);
  }
  doc["l"] = avgLat;

  if (statusSliceOffset >= numReceivers) statusSliceOffset = 0;
  doc["rn"] = numReceivers;
  doc["ro"] = statusSliceOffset;
  JsonArray arr = doc.createNestedArray("receivers");
  uint8_t count = numReceivers < STATUS_SLICE ? numReceivers : STATUS_SLICE;
  for (uint8_t k = 0; k < count; k++) {
    const ReceiverInfo& r = receivers[(statusSliceOffset + k) % numReceivers];
    JsonObject ro = arr.createNestedObject();
    ro["i"] = (const char*)r.ident;
    ro["n"] = r.nodeID;
    ro["b"] = r.batteryLevel;
    ro["s"] = r.showId;
    ro["l"] = r.loadComplete ? 1 : 0;
    ro["r"] = r.startReady   ? 1 : 0;
    ro["t"] = r.lastMessageTime;
    ro["x"] = receiverAvgLatency(&r);
    ro["sp"] = calculateSuccessPercent(&r);
    ro["rt"] = receiverRetryAvgX10(&r);
    if (r.caps & RX_CAP_STATUS_FLAGS) ro["pf"] = r.stateFlags;

    // FW v16: include the cached receiver-side config when valid.
    // Skipped entirely on receivers we haven't queried yet so the
    // host can tell "no answer yet" from "really has 0 cues".
    if (r.configValid) {
      ro["fw"]  = r.fwVersion;
      ro["bv"]  = r.boardVersion;
      ro["bt"]  = r.boardType;
      ro["nb"]  = r.numBoards;
      ro["nbd"] = r.noBoardsDetected;
      ro["ca"]  = r.cuesAvailable;
      ro["fd"]  = r.fireDurationMs;
      ro["rc"]  = r.caps;
    }

    JsonArray ca = ro.createNestedArray("c");
    for (uint8_t j = 0; j < CONTINUITY_INDEX_CT; j++) ca.add(r.continuity[j]);
  }
  if (numReceivers > 0) {
    statusSliceOffset = (uint8_t)((statusSliceOffset + count) % numReceivers);
  }
  serializeJson(doc, Host);
  Host.write('\n');
}

void loop() {
  uint64_t now = millis() + tsOffset;

  // Feed the task watchdog. Long inner loops (OTA recovery, radio.write
  // bursts) also feed it inline -- this is the baseline tick.
  esp_task_wdt_reset();

  // Pull host commands in before routine LED/status/poll work. Manual fire
  // commands also enter the front of the queue, so the next dispatch can send
  // them ahead of background CLOCK_SYNC traffic.
  serviceHostInput();

  checkGpioStatus();
  updateLEDs();
  updateConnectionLEDs();

  // Prune inactive receivers.
  for (uint8_t i = 0; i < numReceivers; ) {
    if ((now - receivers[i].lastMessageTime) > receiverInactivityTimeoutMs) {
      Host.print(F("INFO: Pruning inactive receiver: ")); Host.println(receivers[i].ident);
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
    if (msgSize == 0) continue;
    ReceiverInfo* r = ingestAckPayload(buf, msgSize, now);
    if (r && buf[0] == RECEIVER_STATUS) emitRxUpd(r, false);
  }

  // While OTA flash mode is active the dongle is pinned to one receiver on
  // a non-standard data rate; skip regular polling and command dispatch.
  if (otaActive) {
    serviceOtaRejoin(now);
  } else {
    serviceBroadcastRepeat();
    maybePollNextReceiver(now);
    if (!isQueueEmpty()) dispatchOneCommand(now);
  }

  // Per-second status JSON for the host (compact heartbeat during OTA; see
  // os4_dongle FW v14/v15 notes).
  if (now - lastPrintTime >= 1000) {
    lastPrintTime = now;
    if (otaActive) {
      //   OS <attempted> <acked> <retries> <last> <bytes> <phase> <dropped>
      char buf[80];
      int n = snprintf(buf, sizeof(buf), "OS %u %u %u %u %lu %u %lu\n",
                       (unsigned)otaChunksAttempted,
                       (unsigned)otaChunksAcked,
                       (unsigned)otaHwRetryBursts,
                       (unsigned)otaLastAckedChunk,
                       (unsigned long)((uint32_t)otaChunksAcked *
                                       (uint32_t)OTA_MAX_CHUNK_BYTES),
                       (unsigned)otaPhase,
                       (unsigned long)otaSerialDropped);
      if (n > 0 && n < (int)sizeof(buf)) {
        otaEmitLineNonBlocking(buf, (size_t)n);
      }
    } else {
      emitStatusTick(now);
    }
  }

  // Service any bytes that arrived while we were doing RF/status work.
  serviceHostInput();
}

}  // namespace omni_dongle
