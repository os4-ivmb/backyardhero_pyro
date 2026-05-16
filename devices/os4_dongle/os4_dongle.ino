#include <SPI.h>
#include <RF24.h>
#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>

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
// v5: 2026-04-XX - Host-driven receiver registration:
//   * `forget IDENT` serial command for host-controlled removal of a
//     receiver from the poll table (host now owns the receiver list via
//     SQLite Receivers table; daemon issues `sync` / `forget` to reconcile)
// v6: 2026-05-XX - RF spectrum scan:
//   * `scan [passes [chStart chEnd]]` serial command runs an RPD-based
//     congestion sweep and emits a single `{"type":"scan_result", ...}`
//     line that the host parses and persists.
//   * Per-second status JSON now includes `ch` (current rfChannel) so the
//     UI can show the active frequency without a separate query.
// v7: 2026-05-XX - Push-on-arrival receiver telemetry:
//   * Each successful ACK-payload status update now emits a single-line
//     `{"type":"rxupd", ...}` JSON to the host the moment it arrives,
//     rather than waiting for the per-second aggregate. Status-to-host
//     latency drops from "0..1000ms (1Hz tick)" to "tens of ms" (RF retry
//     window + USB-CDC).
//   * The per-second `status` JSON is unchanged and still emitted — it
//     covers slow-changing housekeeping (queue depth, fw, channel,
//     aggregate latency) and acts as a heartbeat for the host so dropped
//     rxupd lines self-heal within a second.
// v10: 2026-05-XX - OTA flash mode (paired with receiver FW v15+):
//   * New serial commands `flash_begin / flash_data / flash_end / flash_abort`
//     drive an end-to-end firmware push from the host to a single chosen
//     receiver. While in flash mode the dongle pins itself to that one
//     receiver: regular polling and command-queue dispatch are paused,
//     and the radio data rate is hopped up to RF24_2MBPS to keep the
//     ~340KB transfer under ~30 seconds end-to-end.
//   * Each `flash_data <chunkIdx> <hex_payload>` line emits a single
//     OTA_DATA frame and reports back `ota_ack` / `ota_nack` JSON so
//     the host can pace the next chunk on success or retry on failure.
//   * After `flash_end` the dongle waits up to 30s for the receiver to
//     reboot back onto the standard 250kbps poll, then reports
//     `ota_done` (or `ota_timeout`) before resuming normal operation.
// v9: 2026-05-XX - Clamp clockSyncIntervalMs + scrub queue on `forget`:
//   * config knobs `clock_sync_interval_ms` / `response_timeout_ms` /
//     `receiver_timeout_ms` are now sanity-bounded on apply (50..30000ms,
//     5..500ms, 60s..6h respectively). Out-of-range values silently
//     broke polling -- e.g. setting csim=0 made pollSpacingMs=0 then
//     5ms-floored, which busted ACK timing on slow links. The actually-
//     applied values get echoed back in the per-second status as `csim`
//     so the host UI can show what the dongle is running with.
//   * `forget IDENT` now removes any pending queued commands targeting
//     that nodeID. Previously a forgotten receiver would still get any
//     in-flight queued commands dispatched, wasting up to ~22ms of
//     radio time per cmd on TX-FAIL retries.
// v16: 2026-05-XX - Receiver-side config query/set (paired with receiver
//   FW v22+):
//   * Two new message types:
//       RECEIVER_CONFIG_QUERY    (18) -- dongle -> receiver
//       RECEIVER_CONFIG_RESPONSE (19) -- receiver -> dongle (in ACK payload)
//   * New serial command:
//       `rxcfg IDENT`            -- pure fetch (flags=0)
//       `rxcfg IDENT fd <ms>`    -- set fire_duration_ms + fetch
//     Each command emits a single `{"type":"rxcfg", ...}` JSON line on
//     receipt of the receiver's CONFIG_RESPONSE, carrying nodeID, FW /
//     board version, NUM_BOARDS / noBoardsDetected / cuesAvailable, and
//     the actually-applied (clamped) fire_duration_ms.
//   * ACK choreography mirrors handleFlashBegin's: the dongle sends the
//     CONFIG_QUERY (its auto-ACK carries stale RECEIVER_STATUS, which
//     we ingest normally), then immediately sends a CLOCK_SYNC. The
//     receiver loaded the CONFIG_RESPONSE into its ACK FIFO between
//     those two writes, so the CLOCK_SYNC's auto-ACK carries the
//     response. Done in the same dispatchOneCommand iteration so the
//     CONFIG_RESPONSE can't get raced by another receiver's poll.
//   * Auto-query: any newly-registered receiver (autocreate via
//     getReceiverByIdent, including post-prune re-discovery) is marked
//     configQueryPending. The next poll slot for that receiver
//     dispatches a CONFIG_QUERY instead of a CLOCK_SYNC, which covers
//     the "operator turned the unit off, added a cue board, turned it
//     back on" case without UI involvement. Flag clears once the
//     CONFIG_RESPONSE is ingested.
//   * Per-receiver entries in the per-second status JSON now include
//     `fw` / `bv` / `nb` / `nbd` / `ca` / `fd` so the host can recover
//     full receiver state (e.g. post-restart) without re-querying.
// v17: 2026-05-XX - OTA begin handshake recovery:
//   * `flash_begin` now clears half-open OTA sessions by sending best-effort
//     OTA_ABORT probes at both 250kbps and the requested OTA rate before
//     starting a new begin. This recovers quick retries after a prior Phase A
//     success stranded the receiver at 1M/2M.
//   * If the initial 250kbps begin gets no hardware ACK, the dongle also
//     probes the requested OTA rate before failing. Error strings now
//     distinguish no begin ACK from no PREP_OK ACK.
// v15: 2026-05-XX - Non-blocking OTA serial writes + faster WDT recovery:
//   * emitOtaAck/Nack/Pong/heartbeat now build their line into a stack
//     buffer and check Serial.availableForWrite() *before* writing. If
//     the USB-CDC TX ring buffer (256B) doesn't have room, the line is
//     dropped and `otaSerialDropped` is bumped. Previously, even with
//     setTxTimeoutMs(20), Serial.print of a 30-byte line did a byte-by-
//     byte write loop where each byte could block 20ms against a backed-
//     up FIFO -- so a slow host briefly stalling drainage chained into
//     600ms+ of main-loop blocking per ack message. Drops are safe
//     because the host has its own retry/timeout layer for OTA chunks.
//   * Dropped count surfaces in the OS heartbeat (`OS att acked retries
//     last bytes phase dropped`) so the host can see backpressure.
//   * WDT timeout dropped from 20s to 10s and trigger_panic switched to
//     `false` (soft reset instead of panic). Faster recovery, USB-CDC
//     re-enumerates more reliably without a panic backtrace stalling
//     reboot.
// v14: 2026-05-XX - OTA dongle lockup recovery / link-fail mitigation:
//   * Per-second status JSON is no longer emitted during OTA. The full
//     status frame is ~400-500B; with a 256B USB-CDC TX ring buffer +
//     the per-byte setTxTimeoutMs(50) backstop, a single status print
//     while the host was slow to drain could block the main loop for
//     20+ seconds, manifesting as "dongle locked up". We now emit a
//     ~30B compact heartbeat (`OS att acked retries last\n`) instead.
//   * Every radio.write() and Serial.print() inside the OTA hot path
//     now calls yield(), which releases the CPU to FreeRTOS so the USB-
//     CDC service task can drain the TX ring buffer between operations.
//   * `flash_recover <idx> [<level>]` accepts an escalating recovery
//     level: 0 = stored-frame replay (current behavior), 1 = soft radio
//     recovery (flush FIFOs + reapply config) + replay, 2 = full
//     radio.begin() restart + reapply + 250kbps probe. Host-side
//     OtaFlashDriver now escalates 0->1->2 across host attempts 4/6/8.
//   * `flash_recover` is idempotent: if the requested chunk is already
//     <= otaLastAckedChunk it acks from cached state with no radio work.
//   * `flash_ping` liveness command emits `OP <millis> <att> <acked>\n`
//     immediately so the host can detect a wedged dongle without
//     consuming a chunk-retry slot.
//   * Hardware task watchdog (esp_task_wdt) at 20s as last-resort safety
//     net. If the OTA path ever truly wedges, the dongle resets cleanly
//     instead of staying mute.
//   * Tightened per-chunk recovery budget: OTA_PER_CHUNK_RETRIES 6->4,
//     OTA_RECOVERY_ROUNDS 4->2. Worst-case wall time per failed chunk
//     drops from ~2.1s to ~600ms, so a transient burst of interference
//     no longer chokes the serial pipe for seconds at a time -- the host
//     gets the NACK and decides whether to retry or recover.
#define FW_VERSION 17

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
  RECEIVER_CONFIG_RESPONSE = 19   // receiver -> dongle (in ACK payload)
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
  uint8_t  nodeID;
  uint8_t  fwVersion;
  uint8_t  boardVersion;
  uint8_t  numBoards;         // 0 if noBoardsDetected, else detected NUM_BOARDS
  uint8_t  noBoardsDetected;  // 0 or 1
  uint8_t  cuesAvailable;     // 0 if noBoardsDetected, else NUM_BOARDS * 8
  uint16_t fireDurationMs;    // currently-effective fire pulse width (ms)
  uint8_t  reserved[8];       // future fields
} __attribute__((packed));

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
  uint8_t  nodeID;
} __attribute__((packed));

// Maximum data bytes per OTA_DATA frame. 32-byte nRF payload minus the
// 3-byte OtaDataMessage header. Must match the host's chunk size.
#define OTA_MAX_CHUNK_BYTES (32 - (uint8_t)sizeof(OtaDataMessage))

// How long to keep pinging the receiver post-flash_end before declaring
// the reflash dead. The receiver's Update.end + reboot is typically
// ~1-2s, so 30s is generous.
#define OTA_REJOIN_TIMEOUT_MS 30000UL

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
  uint8_t  numBoards;
  uint8_t  noBoardsDetected;
  uint8_t  cuesAvailable;
  uint16_t fireDurationMs;
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

  // For RECEIVER_CONFIG_QUERY (FW v16+). cfg_flags is the bitset that
  // gates which trailing fields actually get applied on the receiver;
  // 0 means a pure fetch.
  uint8_t  cfg_flags;
  uint16_t cfg_fire_duration_ms;
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
uint8_t  otaTargetNodeID      = 0;
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
// any subsequent Serial.print would hit a clogged TX FIFO and stall
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
// Serial.print backpressure under a hostile RF link). If we ever do
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
// invisible to the radio. Switching to `+` gives every uint8_t nodeID a
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

static inline uint64_t systemSalt() {
  // 4-byte left-shift so the system ID lives in the high 32 bits and never
  // collides with the 0..255 nodeID range in the low byte.
  return ((uint64_t)rfSystemId) << 32;
}
static inline uint64_t masterReadAddress() {
  // MASTER_READ_BASE is 0 so `|` and `+` are equivalent here; using `|`
  // makes the salt-merge intent explicit.
  return MASTER_READ_BASE | systemSalt();
}
static inline uint64_t receiverAddress(uint8_t nodeID) {
  // See the IMPORTANT note above re: arithmetic add vs. bitwise OR.
  return systemSalt() + RECEIVER_BASE + (uint64_t)nodeID;
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
    uint8_t newNodeID = nodeIDFromIdent(ident);
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
          Serial.print(F("ERR: RF addr collision adding "));
          Serial.print(ident);
          Serial.print(F(" (N"));
          Serial.print(newNodeID);
          Serial.print(F(") with "));
          Serial.print(receivers[i].ident);
          Serial.print(F(" (N"));
          Serial.print(receivers[i].nodeID);
          Serial.println(F(") -- registration refused"));
          return nullptr;
        }
      }
    }

    ReceiverInfo &r = receivers[numReceivers];
    r.ident = ident;
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
    r.successHead = 0;
    r.successCount = 0;
    for (uint8_t k = 0; k < MAX_SUCCESS_SAMPLES; k++) r.successHistory[k] = false;
    r.consecutiveFailures = 0;
    // FW v16: queue an automatic CONFIG_QUERY for the next poll slot
    // assigned to this receiver. Covers initial connect AND post-prune
    // re-discovery (the operator turned the unit off, swapped a cue
    // board, turned it back on -- we want the new NUM_BOARDS *and* any
    // operator-set fire_duration_ms reflected on the host immediately).
    r.configValid = false;
    r.configQueryPending = true;
    r.fwVersion = 0;
    r.boardVersion = 0;
    r.numBoards = 0;
    r.noBoardsDetected = 0;
    r.cuesAvailable = 0;
    r.fireDurationMs = 0;
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

// Drop every queued command targeting `nodeID`. Used by `forget` so a
// disabled receiver doesn't keep eating radio time on retries that will
// never succeed. Compacts the ring in-place to preserve queue ordering
// for everyone else.
//
// Returns the number of commands dropped.
uint8_t scrubQueueForNode(uint8_t nodeID) {
  if (cmdQueueCount == 0 || nodeID == 0) return 0;
  uint8_t dropped = 0;
  // Walk the live range and copy survivors back to a fresh head.
  // This works even with the wrap-around layout because we read in
  // order and write in order to indices we've already read past.
  int readIdx = cmdQueueHead;
  int writeIdx = cmdQueueHead;
  int remaining = cmdQueueCount;
  while (remaining-- > 0) {
    QueuedCommand& src = commandBuffer[readIdx];
    if (src.targetNodeID == nodeID) {
      dropped++;
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

// Remove a receiver by ident. Used for the host-driven `forget IDENT` serial
// command (host edited the Receivers DB table, told us this one is no longer
// in scope). Returns true if the receiver was found and removed. Also
// scrubs any pending queued commands targeting the removed receiver --
// otherwise dispatchOneCommand would keep retrying them and silently
// burn ~22ms of radio time per cmd on TX-FAIL retries.
bool removeReceiverByIdent(const String &ident) {
  for (uint8_t i = 0; i < numReceivers; i++) {
    if (receivers[i].ident == ident) {
      uint8_t goneNodeID = receivers[i].nodeID;
      // Shift the tail down to keep the array compact.
      for (uint8_t j = i; j < numReceivers - 1; ++j) receivers[j] = receivers[j + 1];
      numReceivers--;
      // Reset the round-robin pointer to a safe slot — it might have pointed
      // past the end after the shift.
      if (nextPollReceiverIdx >= numReceivers) nextPollReceiverIdx = 0;
      uint8_t dropped = scrubQueueForNode(goneNodeID);
      if (dropped > 0 && debugMode > 0) {
        Serial.print(F("INFO: forget scrubbed ")); Serial.print(dropped);
        Serial.print(F(" queued cmd(s) for N")); Serial.println(goneNodeID);
      }
      return true;
    }
  }
  return false;
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
  d["sp"] = calculateSuccessPercent((ReceiverInfo*)r);
  JsonArray ca = d.createNestedArray("c");
  for (uint8_t j = 0; j < CONTINUITY_INDEX_CT; j++) ca.add(r->continuity[j]);
  serializeJson(d, Serial);
  Serial.write('\n');
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
  if (len < sizeof(ReceiverStatusMessage)) {
    if (debugMode > 0) {
      Serial.print(F("WARN: short status frame, len=")); Serial.println(len);
    }
    return NULL;
  }

  const ReceiverStatusMessage* status = (const ReceiverStatusMessage*)buf;
  if (status->type != RECEIVER_STATUS) {
    if (debugMode > 0) {
      Serial.print(F("WARN: ack payload type mismatch=")); Serial.println(status->type);
    }
    return NULL;
  }

  // ident must be a printable, NUL-terminated string starting with 'R'.
  char identBuf[sizeof(status->ident) + 1];
  memcpy(identBuf, status->ident, sizeof(status->ident));
  identBuf[sizeof(status->ident)] = '\0';
  if (identBuf[0] != 'R') {
    if (debugMode > 0) {
      Serial.print(F("WARN: bogus ident in status: ")); Serial.println(identBuf);
    }
    return NULL;
  }

  ReceiverInfo* r = getReceiverByIdent(String(identBuf), true);
  if (!r) {
    Serial.print(F("ERR: Status from unknown ident/node ")); Serial.println(status->nodeID);
    return NULL;
  }

  r->nodeID = status->nodeID;
  r->batteryLevel = status->batteryLevel;
  r->showId = status->showState & 0x3FFF;
  r->loadComplete = (status->showState & (1 << 14)) ? true : false;
  r->startReady   = (status->showState & (1 << 15)) ? true : false;
  r->lastMessageTime = now;
  r->continuity[0] = status->cont64_0;
  r->continuity[1] = status->cont64_1;
  return r;
}

// FW v16: emit a single `rxcfg` JSON line summarizing the latest
// CONFIG_RESPONSE for a receiver. Mirrors emitRxUpd's compact key
// scheme so the host parser can stay symmetric:
//   i=ident n=nodeID fw=fwVersion bv=boardVersion nb=numBoards
//   nbd=noBoardsDetected ca=cuesAvailable fd=fireDurationMs t=lastMsgTime
void emitRxCfg(const ReceiverInfo* r) {
  if (!r || !r->configValid) return;
  StaticJsonDocument<192> d;
  d["type"] = "rxcfg";
  d["i"]    = r->ident;
  d["n"]    = r->nodeID;
  d["fw"]   = r->fwVersion;
  d["bv"]   = r->boardVersion;
  d["nb"]   = r->numBoards;
  d["nbd"]  = r->noBoardsDetected;
  d["ca"]   = r->cuesAvailable;
  d["fd"]   = r->fireDurationMs;
  d["t"]    = r->lastMessageTime;
  serializeJson(d, Serial);
  Serial.write('\n');
}

// FW v16: ingest a RECEIVER_CONFIG_RESPONSE arrived via the ACK FIFO.
// Routed to from ingestAckPayload(). Updates the cached config fields,
// clears configQueryPending so future polls go back to CLOCK_SYNC, and
// emits the `rxcfg` line so the host can persist the new values.
ReceiverInfo* ingestConfigResponse(const uint8_t* buf, uint8_t len, uint64_t now) {
  if (len < sizeof(ReceiverConfigResponseMessage)) {
    if (debugMode > 0) {
      Serial.print(F("WARN: short cfg resp, len=")); Serial.println(len);
    }
    return NULL;
  }
  const ReceiverConfigResponseMessage* cr = (const ReceiverConfigResponseMessage*)buf;
  if (cr->nodeID == 0) {
    if (debugMode > 0) Serial.println(F("WARN: cfg resp nodeID=0"));
    return NULL;
  }
  ReceiverInfo* r = getReceiverByNodeID(cr->nodeID);
  if (!r) {
    // Unknown nodeID -- we don't have an ident here so we can't auto-create.
    // The next normal status frame will register the receiver, after which a
    // fresh config query (auto- or operator-driven) will succeed.
    if (debugMode > 0) {
      Serial.print(F("WARN: cfg resp from unknown N")); Serial.println(cr->nodeID);
    }
    return NULL;
  }
  r->configValid       = true;
  r->configQueryPending = false;
  r->fwVersion         = cr->fwVersion;
  r->boardVersion      = cr->boardVersion;
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
        Serial.print(F("WARN: unknown ack type=")); Serial.println(buf[0]);
      }
      return NULL;
  }
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
  radio.stopListening();
  radio.flush_tx();
  radio.flush_rx();

  for (uint16_t p = 0; p < passes; p++) {
    for (uint16_t i = 0; i < nCh; i++) {
      uint8_t ch = chStart + i;
      radio.setChannel(ch);
      radio.startListening();
      // Trx2rx is ~130us on nRF24L01+. 180us gives us the settle + a
      // ~50us RPD latch window with margin.
      delayMicroseconds(180);
      if (radio.testRPD()) hits[i]++;
      radio.stopListening();
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
  Serial.println(out);
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
    // Emit AFTER the latency/success bookkeeping so the just-arrived
    // sample is what the host sees. Prefer the pointer the ACK actually
    // came from, fall back to the node-id lookup.
    ReceiverInfo* emit = updatedR ? updatedR : r;
    if (emit) emitRxUpd(emit, true);
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
      // Push the success% delta to the host even on TX fail, so the
      // displayed success rate dips in real time. Skip the fresh latency
      // sample (we don't have one) and don't update lmt — freshness is
      // still bounded by the most recent successful poll.
      emitRxUpd(r, false);
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

// FW v16: send a RECEIVER_CONFIG_QUERY then immediately a CLOCK_SYNC to
// fetch the receiver's CONFIG_RESPONSE. The query's auto-ACK carries
// the receiver's previously-loaded RECEIVER_STATUS (ingested as
// normal); the receiver loads the CONFIG_RESPONSE into its ACK FIFO
// during the brief gap before the follow-up CLOCK_SYNC, so the
// CLOCK_SYNC's auto-ACK carries the response. ingestAckPayload routes
// it to ingestConfigResponse, which emits the `rxcfg` line.
//
// Returns true if BOTH writes succeeded. The CLOCK_SYNC failing means
// we definitely lost the response; the host can re-issue rxcfg.
bool sendConfigQuery(uint8_t nodeID, uint8_t flags, uint16_t fire_dur_ms, uint64_t now) {
  ReceiverConfigSetMessage q;
  q.type = RECEIVER_CONFIG_QUERY;
  q.flags = flags;
  q.fire_duration_ms = fire_dur_ms;
  bool ok1 = sendCommandFrame(nodeID, &q, sizeof(q), now);
  if (!ok1) return false;

  // Inter-frame gap to give the receiver's main loop time to dispatch
  // the CONFIG_QUERY and call loadConfigResponseIntoAck() before our
  // follow-up CLOCK_SYNC's auto-ACK fires. radio.write() returns the
  // moment the CONFIG_QUERY's auto-ACK arrives (~1ms after TX start)
  // -- by then the receiver's loop has only just barely *received*
  // the frame, not processed it. Without this delay the CLOCK_SYNC
  // can arrive before the response is loaded and we get the stale
  // RECEIVER_STATUS instead.
  //
  // 8ms mirrors handleFlashBegin's "wait for the receiver to settle"
  // delay (15ms there, but that includes Update.begin + radio rate
  // hop). For a plain config query the receiver has nothing slow to
  // do, so 8ms gives ~5ms of headroom over the worst observed loop
  // iteration time (LED animations + show housekeeping).
  delay(8);

  return sendClockSync(nodeID, 0, (uint64_t)(millis() + tsOffset));
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
    if (len >= sizeof(ReceiverOtaStatusMessage) &&
        buf[0] == RECEIVER_OTA_STATUS) {
      memcpy(outMsg, buf, sizeof(ReceiverOtaStatusMessage));
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
  serializeJson(d, Serial);
  Serial.write('\n');
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
// Serial.print does a per-byte loop that can block 20ms × N on a full
// FIFO -- chained, that's how the dongle main loop ends up wedged
// long enough to trip the watchdog.
//
// Returns the number of bytes written (0 if dropped). Always yields so
// the USB-CDC service task gets a chance to drain.
static inline size_t otaEmitLineNonBlocking(const char* buf, size_t len) {
  if (len == 0) return 0;
  // availableForWrite() returns 0 if the device isn't enumerated /
  // connected -- treat that the same as "no room", drop silently.
  int avail = Serial.availableForWrite();
  if (avail <= 0 || (size_t)avail < len) {
    otaSerialDropped++;
    yield();
    return 0;
  }
  size_t n = Serial.write((const uint8_t*)buf, len);
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
  radio.stopListening();
  radio.openWritingPipe(receiverAddress(otaTargetNodeID));
  bool ok = radio.write(payload, payloadLen);
  ReceiverOtaStatusMessage tmp;
  if (readOtaAckPayload(&tmp)) {
    if (ackOut) *ackOut = tmp;
    *gotAck = true;
  }
  radio.startListening();
  // radio.write blocks up to ~95ms on a failed link (RF24 FAILURE_HANDLING
  // backstop). Yield so the USB-CDC service task can drain the dongle's
  // TX ring buffer between attempts -- otherwise multiple back-to-back
  // failed writes monopolize the loop task and Serial.print stalls.
  // Also feed the WDT so the watchdog doesn't trip during a long but
  // legitimate recovery burst.
  esp_task_wdt_reset();
  yield();
  return ok;
}

void otaReassertRadioConfig(rf24_datarate_e rate) {
  radio.stopListening();
  radio.flush_tx();
  radio.flush_rx();
  radio.setChannel(rfChannel);
  radio.setDataRate(rate);
  radio.setPALevel(RF24_PA_MAX);
  radio.setRetries(15, 5);
  radio.setCRCLength(RF24_CRC_16);
  radio.setAutoAck(true);
  radio.setAutoAck(0, true);
  radio.enableDynamicPayloads();
  radio.enableAckPayload();
  radio.openReadingPipe(0, masterReadAddress());
  radio.openWritingPipe(receiverAddress(otaTargetNodeID));
  radio.startListening();
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
  radio.stopListening();
  radio.powerDown();
  delay(10);
  bool ok = radio.begin();
  if (!ok) {
    // Try once more with a longer settle.
    delay(30);
    ok = radio.begin();
  }
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
  radio.startListening();
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
    radio.stopListening();
    radio.openWritingPipe(receiverAddress(otaTargetNodeID));
    ClockSyncMessage msg;
    msg.type = CLOCK_SYNC;
    msg.timestamp = now;
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
          // otaFinishMode below restores RX listening + 250kbps.
          otaFinishMode("done", nullptr, nullptr);
          return;
        }
      }
    }
    radio.startListening();
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
  if (otaActive) { Serial.println(F("CV BUSY OTA")); return; }

  // Parse: <ident> <size> <chunks> <crc32_hex> [<rate>]
  int sp1 = args.indexOf(' ');
  if (sp1 < 0) { Serial.println(F("CV flash_begin: ident missing")); return; }
  String ident = args.substring(0, sp1);
  String rest = args.substring(sp1 + 1);
  int sp2 = rest.indexOf(' ');
  if (sp2 < 0) { Serial.println(F("CV flash_begin: size missing")); return; }
  uint32_t totalSize = (uint32_t)atoll(rest.substring(0, sp2).c_str());
  rest = rest.substring(sp2 + 1);
  int sp3 = rest.indexOf(' ');
  if (sp3 < 0) { Serial.println(F("CV flash_begin: chunks missing")); return; }
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
    Serial.println(F("CV flash_begin: zero size/chunks")); return;
  }

  ReceiverInfo* r = getReceiverByIdent(ident, false);
  if (!r) { Serial.println(F("CV flash_begin: RNE")); return; }
  if (r->nodeID == 0) {
    Serial.print(F("CV flash_begin: NID0 ")); Serial.println(ident); return;
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
    Serial.println(F("CV flash_data: not in OTA stream phase"));
    return;
  }
  char* endPtr = nullptr;
  unsigned long idxUl = strtoul(args, &endPtr, 10);
  if (endPtr == args || *endPtr != ' ') {
    Serial.println(F("CV flash_data: hex missing"));
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
    Serial.println(F("CV flash_data: bad hex"));
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
    Serial.println(F("CV flash_recover: not in OTA stream phase"));
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
    Serial.println(F("CV flash_end: not in OTA stream phase"));
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
    Serial.println(F("CV flash_abort: not in OTA"));
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

void processSerialCommand(String inStr) {
  inStr.trim();
  if (inStr.length() == 0) return;

  if (inStr.startsWith("{")) { parseLedJSON(inStr); return; }

  // Bare-word commands (no args) — handled before the space-required parser
  // so manual serial testing of e.g. `scan` doesn't require a trailing arg.
  if (inStr == "scan")        { runRadioScan(10, 0, 125); return; }
  if (inStr == "flash_end")   { handleFlashEnd();         return; }
  if (inStr == "flash_abort") { handleFlashAbort();       return; }
  if (inStr == "flash_ping")  { handleFlashPing();        return; }

  int firstSpace = inStr.indexOf(' ');
  if (firstSpace < 0) { Serial.println(F("C?NFS")); return; }
  String cmdStr = inStr.substring(0, firstSpace);
  String args = inStr.substring(firstSpace + 1);

  // OTA flash mode commands. The bare-word forms (flash_end, flash_abort)
  // are dispatched up above before the space-split. flash_begin /
  // flash_data both have their own grammar (not the standard
  // `cmd IDENT params` shape) so they bypass the receiver lookup below.
  if (cmdStr == "flash_begin") { handleFlashBegin(args); return; }
  if (cmdStr == "flash_data")  { handleFlashData(args);  return; }
  if (cmdStr == "flash_recover") { handleFlashRecover(args); return; }

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
    Serial.println(F("C?NSS")); return;
  }

  String ident = (secondSpace > 0) ? args.substring(0, secondSpace) : args;
  String paramsStr = (secondSpace > 0) ? args.substring(secondSpace + 1) : "";

  if (cmdStr == "msync") {
    uint64_t ts = atoll(paramsStr.c_str());
    tsOffset = ts - millis();
    Serial.println(F("C+ msync"));
    return;
  }

  // forget IDENT — host-driven removal of a receiver from the poll table.
  // Used after the user disables/deletes the receiver in the DB-backed UI.
  // We don't bounce the radio or the queue; if there's a pending command for
  // this ident in the queue, dispatchOneCommand will simply not find the
  // receiver and report no-route.
  if (cmdStr == "forget") {
    if (ident.length() == 0) { Serial.println(F("CV forget")); return; }
    if (removeReceiverByIdent(ident)) {
      Serial.print(F("C+ forget ")); Serial.println(ident);
    } else {
      Serial.print(F("CV forget RNF ")); Serial.println(ident);
    }
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
        Serial.print(F("CV rxcfg missing value for ")); Serial.println(key);
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
          Serial.print(F("CV rxcfg fd out-of-range ")); Serial.println(val);
          return;
        }
        qc.cfg_flags |= CFG_FLAG_SET_FIRE_DURATION;
        qc.cfg_fire_duration_ms = (uint16_t)fdv;
      } else {
        Serial.print(F("CV rxcfg unknown key ")); Serial.println(key);
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
      case RECEIVER_CONFIG_QUERY:
        ok = sendConfigQuery(cmd.targetNodeID, cmd.cfg_flags,
                             cmd.cfg_fire_duration_ms, now); break;
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
    qc.repeat_count = 1;
    if (r.configQueryPending) {
      // FW v16: instead of the regular CLOCK_SYNC poll, dispatch a
      // pure-fetch CONFIG_QUERY (flags=0). sendConfigQuery itself
      // sends a follow-up CLOCK_SYNC under the hood to retrieve the
      // CONFIG_RESPONSE from the ACK FIFO, so the clock-sync cadence
      // for this receiver isn't actually skipped.
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
}

void setup() {
  // Bump the USB-CDC RX buffer so an OTA host can pipeline several
  // `flash_data` lines without the dongle losing bytes in between
  // main-loop iterations. Default is 256B; one OTA line is ~75B so
  // 2KB lets ~25 lines queue up without backpressure.
  Serial.setRxBufferSize(2048);
  Serial.begin(115200);
  // Critical: cap the time Serial.write/println can block when the
  // host is slow to drain (e.g. docker log driver buffering, daemon
  // mid-state-write). Without this the main loop hangs indefinitely
  // on the first byte that doesn't fit in the TX FIFO -- which during
  // an OTA flash means the dongle stops responding entirely partway
  // through a multi-thousand-chunk transfer. FW v14 drops this from 50
  // to 20ms because the per-second status JSON and OTA hot-path
  // writes are now interleaved with yield() calls -- under sane host
  // backpressure 20ms/byte is plenty, and a tighter cap means a truly
  // disconnected host doesn't push us over the 20s task watchdog.
  Serial.setTxTimeoutMs(20);
  while (!Serial);
  delay(1000);

  // Subscribe the loop task to the hardware task watchdog. Without
  // this a runaway loop iteration (e.g. radio.write + USB-CDC TX
  // backpressure during a hostile OTA RF link) can keep the dongle
  // mute for tens of seconds, which the host can only deal with by
  // bouncing the USB cable. With the WDT, anything >20s of no main
  // loop progress forces a clean reboot. We feed the WDT at the top
  // of loop() and inside the OTA hot-path retry loops below.
  //
  // arduino-esp32 v3.x (IDF 5.x) takes a config struct. Try init first;
  // if the core already initialized the TWDT (depends on sdkconfig)
  // fall back to reconfigure with our timeout.
  esp_task_wdt_config_t wdtCfg = {
    .timeout_ms     = OTA_DONGLE_WDT_TIMEOUT_S * 1000,
    .idle_core_mask = 0,
    // Soft reset (false) instead of panic (true). Panic dumps a
    // backtrace over Serial which can stall the reboot path -- worse,
    // some host USB stacks treat the resulting USB-CDC reset
    // differently and don't re-enumerate cleanly. Soft reset is
    // basically `esp_restart()` and the device comes back on the same
    // /dev/tty.usbmodem* path within ~2s.
    .trigger_panic  = false,
  };
  esp_err_t wdtErr = esp_task_wdt_init(&wdtCfg);
  if (wdtErr == ESP_ERR_INVALID_STATE) {
    esp_task_wdt_reconfigure(&wdtCfg);
  }
  esp_task_wdt_add(NULL);  // current task (loopTask)

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

  // Feed the task watchdog. Long inner loops (OTA recovery, radio.write
  // bursts) also feed it inline -- this is the baseline tick.
  esp_task_wdt_reset();

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
    if (msgSize == 0) continue;
    // Unsolicited frames have no associated TX, so there's no fresh
    // latency sample to emit — pass false so the host doesn't see a
    // duplicate sample in the sliding window. ingestAckPayload also
    // emits the rxcfg JSON for CONFIG_RESPONSE arrivals here.
    ReceiverInfo* r = ingestAckPayload(buf, msgSize, now);
    if (r && buf[0] == RECEIVER_STATUS) emitRxUpd(r, false);
  }

  // While OTA flash mode is active, the dongle is pinned to one receiver
  // and the radio is on a non-standard data rate. Skip the regular
  // polling and command-dispatch paths -- otherwise we'd write to other
  // receivers at the wrong rate (no ACK, retries waste air time) and
  // try to consume queued commands for receivers we promised the
  // operator we'd ignore until the flash completes.
  if (otaActive) {
    serviceOtaRejoin(now);
  } else {
    // TDMA-style status polling — spreads one CLOCK_SYNC per slot across the
    // configured interval so all known receivers get updated regularly without
    // bursting.
    maybePollNextReceiver(now);

    // One queued command per loop iteration. radio.write() blocks at most
    // ~22ms on a failed write (5 retries × ~3.75ms ARD), and ~3ms on success.
    // No busy-poll, no inner timeout loop.
    if (!isQueueEmpty()) dispatchOneCommand(now);
  }

  // Per-second status JSON for the host.
  //
  // FW v14: while OTA is active, skip the full status JSON entirely.
  // The status frame is ~400-500 bytes (one receiver entry + housekeeping)
  // and the dongle's USB-CDC TX ring buffer is only 256 bytes. With the
  // setTxTimeoutMs(20) backstop, a single full status print while the
  // host is briefly slow to drain (docker log buffering, daemon mid-state-
  // write, etc.) can block the main loop for hundreds of ms; chained with
  // the OTA hot-path retry burst that's how a "transient RF burst" turned
  // into a multi-second silent dongle. Emit a 30-byte compact heartbeat
  // instead -- enough for the host to show progress / detect liveness.
  //   `OS <attempted> <acked> <retries> <last> <bytes_acked>\n`
  if (now - lastPrintTime >= 1000) {
    lastPrintTime = now;
    if (otaActive) {
      // FW v15: non-blocking heartbeat. Includes otaSerialDropped so
      // the host can spot persistent backpressure (drops mean the host
      // is not draining serial fast enough -- usually a docker log
      // driver issue or a daemon mid-state-write).
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
      DynamicJsonDocument doc(1024 + (numReceivers * 256));
      doc["timestamp"] = now;
      doc["q"] = cmdQueueCount;
      // Expose queue capacity so the UI can render q/qmax as a saturation
      // bar without hardcoding the dongle constant on the host side.
      // Cheap (one extra int per second).
      doc["qmax"] = MAX_COMMANDS_IN_QUEUE;
      doc["fw"] = FW_VERSION;
      doc["ch"] = rfChannel;
      // Echo the live (post-clamp) clock-sync interval so the UI can show
      // the operator what the dongle is actually running with -- e.g. if
      // they typed 0 in settings, they'll see CSIM_MIN_MS reflected here
      // rather than wondering why polling didn't change.
      doc["csim"] = clockSyncIntervalMs;

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

        // FW v16: include the cached receiver-side config when valid.
        // Skipped entirely on receivers we haven't queried yet so the
        // host can tell "no answer yet" from "really has 0 cues".
        if (receivers[i].configValid) {
          ro["fw"]  = receivers[i].fwVersion;
          ro["bv"]  = receivers[i].boardVersion;
          ro["nb"]  = receivers[i].numBoards;
          ro["nbd"] = receivers[i].noBoardsDetected;
          ro["ca"]  = receivers[i].cuesAvailable;
          ro["fd"]  = receivers[i].fireDurationMs;
        }

        JsonArray ca = ro.createNestedArray("c");
        for (uint8_t j = 0; j < CONTINUITY_INDEX_CT; j++) ca.add(receivers[i].continuity[j]);
      }
      String out;
      serializeJson(doc, out);
      Serial.println(out);
    }
  }

  // Non-blocking serial input.
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialBufferIndex > 0) {
        serialLineBuffer[serialBufferIndex] = '\0';
        // OTA hot-path commands are parsed as C strings to avoid thousands of
        // Arduino String heap allocations during a firmware image transfer.
        // Heap fragmentation here can make the dongle appear to "quit" after
        // a few thousand chunks.
        if (strncmp(serialLineBuffer, "flash_data ", 11) == 0) {
          handleFlashDataC(serialLineBuffer + 11);
        } else if (strncmp(serialLineBuffer, "flash_recover ", 14) == 0) {
          handleFlashRecoverC(serialLineBuffer + 14);
        } else if (strcmp(serialLineBuffer, "flash_ping") == 0) {
          // Hot-path liveness probe -- bypass String parsing so a
          // wedged-by-backpressure dongle can still reply quickly
          // once it catches up on the inbound buffer.
          handleFlashPing();
        } else {
          String s = String(serialLineBuffer);
          processSerialCommand(s);
        }
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
