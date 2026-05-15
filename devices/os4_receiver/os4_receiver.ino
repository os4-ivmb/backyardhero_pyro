#include <SPI.h>
#include <RF24.h>
#include <Adafruit_NeoPixel.h>
#include <Preferences.h>
#include <Update.h>

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
// v10: 2026-05-XX - Fix RF address aliasing. RECEIVER_BASE is now
//   arithmetically *added* to NODE_ID instead of OR'd. Pre-v10 receivers
//   with even NODE_IDs already used `BASE+N` by accident (because OR
//   with 0x01 == +1 when LSB=0), so they don't move; receivers with odd
//   NODE_IDs shift up by one address slot. Pair only with dongle FW v8+.
// v11: 2026-05-XX - Adaptive disconnect detection + ACK-payload freshness:
//   * Disconnect threshold now scales with the observed inter-poll gap
//     (median of the last 8 successful contacts, * 5x, floored at 5s and
//     capped at 60s). The dongle's clockSyncIntervalMs * numReceivers
//     can range from ~50ms to many seconds; the old fixed 10s timeout
//     false-fired the moment the operator slowed polling for a large
//     fleet. Now a fleet polled every 8s tolerates a missed ACK without
//     declaring "disconnect" until ~40s of true silence.
//   * refreshAckPayload() now flushes the ACK TX FIFO before writing
//     so the dongle never receives a stale (>250ms) status piggyback
//     when commands come in faster than the periodic refresh.
// v12: 2026-05-XX - Don't abort the show on radio dropout + clock-domain fix:
//   * The disconnect detection used `now = millis() + clock_offset` for
//     `lastCmdReceived` but recomputed `now` with the LATEST clock_offset
//     on the following loop iteration. A CLOCK_SYNC inside the same iter
//     would mutate clock_offset, so the next iteration's
//     `now - lastCmdReceived` included the entire clock-offset delta --
//     enough to trip the 5s floor on any meaningful clock jump (e.g. an
//     msync at daemon restart, or jitter compounding over minutes), even
//     though no real time had elapsed. That manifested as a quick
//     magenta `ANIM_FLASHING_PURPLE` flash mid-show and the receiver
//     halting all subsequent cue fires. Now we track `lastCmdReceived`
//     in raw `millis()` so the disconnect math is monotonic and
//     unaffected by clock_offset updates.
//   * Even on a real disconnect, we no longer clear `isPlaying`. The
//     show is loaded locally with absolute synchronized fire times --
//     a brief RF dropout doesn't invalidate any of that, and aborting
//     the autonomous schedule is exactly the wrong response. The radio
//     is still re-armed and we still flash purple so the operator sees
//     the blip, but cues continue to fire on the loaded schedule. The
//     operator can hit STOP if they want a hard abort.
// v13: 2026-05-XX - Relax receiver disconnect tolerance:
//   * Minimum disconnect threshold increased from 5s to 8s.
//   * Adaptive threshold increased from 5x to 6x observed poll gap.
//   * Maximum threshold increased from 60s to 90s.
// v15: 2026-05-XX - OTA flash mode (paired with dongle FW v10+):
//   * New message types OTA_BEGIN(13) / OTA_DATA(14) / OTA_END(15) /
//     OTA_ABORT(16) and a piggy-back ACK status RECEIVER_OTA_STATUS(17).
//   * On OTA_BEGIN we call Update.begin(totalSize), switch the radio to
//     the high data rate the dongle requested (1Mbps or 2Mbps), and
//     start streaming chunks straight into the OTA partition via
//     Update.write(). Each chunk is up to 29 bytes (32B nRF payload -
//     1B type - 2B chunkIdx); the dongle's auto-retry handles loss.
//   * On OTA_END we Update.end(true), accept-the-image, and ESP.restart()
//     -- the bootloader picks the new partition next boot. NVS is
//     untouched so identity (NODE_ID + RECEIVER_IDENT) survives.
//   * On OTA_ABORT or any local error, Update.abort() runs and the
//     radio switches back to the standard 250kbps so the receiver can
//     resume normal polling without a reboot.
//   * While the OTA state machine is active, runPlayLoop / animation /
//     status-LED updates are suspended; the status strip shows a slow
//     dim-white breathe so the operator can see the unit is being
//     reflashed. We keep refreshing the ACK payload on every chunk so
//     the dongle gets up-to-date `bytesReceived` / `lastChunk` /
//     `state` / `errorCode` for progress reporting up to the host.
// v16: 2026-05-XX - Boot-time status-LED sequence now encodes FW_VERSION
//   and NODE_ID as 3-digit decimal numbers across the 3 status LEDs:
//   * The boot sequence is now three flashes:
//       1. FW_VERSION (digit-color, breath in/out)
//       2. Battery level (existing behavior, unchanged: bar count + color)
//       3. NODE_ID     (digit-color, breath in/out)
//     The 1st and 3rd used to be a single fixed-purple breath and a
//     fixed-white fade respectively, neither of which carried any per-
//     unit information. That made it impossible to tell at a glance
//     which firmware or which receiver had just powered up -- a real
//     problem during incremental rollouts and during fleet bring-up.
//   * For both the version and node-id flashes, each status LED shows
//     one decimal digit:
//       LED 0 = hundreds digit
//       LED 1 = tens digit
//       LED 2 = ones digit
//     For example FW v20 -> LED0 red(0), LED1 yellow(2), LED2 red(0);
//     FW v16 -> LED0 red(0), LED1 red(0), LED2 orange(6). NODE_ID 137
//     -> LED0 blue(1), LED1 green(3), LED2 white(7).
//   * Each digit 0..9 maps to a fixed, vivid color chosen so consecutive
//     digits are maximally distinct (so 1 vs 2 or 7 vs 8 are obvious at
//     a glance, even if 2 vs 5 could be confused at a distance):
//       0 red    1 blue   2 yellow 3 green  4 purple
//       5 cyan   6 orange 7 white  8 pink   9 lime
//     The LEDs all breathe in/out together at the same brightness curve
//     the old purple breath used, so the boot "feel" is unchanged --
//     just informative.
//   * Only the boot flashes change. The unprovisioned magenta breath, the
//     show-time animations, and the OTA white breathe are untouched --
//     those carry distinct semantics that shouldn't be repurposed.
//     Unprovisioned units (NODE_ID==0) will show all-red(0) on the
//     node-id flash, then transition into the magenta breath as usual.
// v22: 2026-05-XX - Receiver-side configuration query/set protocol (paired
//   with dongle FW v16+):
//   * Two new message types:
//       RECEIVER_CONFIG_QUERY    (18) -- dongle -> receiver
//       RECEIVER_CONFIG_RESPONSE (19) -- receiver -> dongle (ACK payload)
//   * The query carries a `flags` byte plus per-config fields. Today the
//     only knob is `fire_duration_ms` (gated by CFG_FLAG_SET_FIRE_DURATION);
//     more knobs will land in the same struct's reserved space without a
//     wire-protocol bump. flags=0 is a pure fetch (no settings written).
//   * The response is a fixed-size 17-byte struct carrying NODE_ID, FW /
//     board version, NUM_BOARDS / noBoardsDetected / cuesAvailable, and the
//     persisted fire_duration_ms (plus 8 bytes reserved for future fields).
//   * cuesAvailable = 0 when no cue boards are detected (noBoardsDetected
//     true), otherwise NUM_BOARDS * 8 (NUM_LEDS). Reported authoritatively
//     here so the host UI no longer has to guess from operator-edited cue
//     counts.
//   * fire_duration_ms is now persisted in the same NVS namespace as the
//     identity ("byh_rx", key "fire_dur"), defaulting to 1000ms on a fresh
//     unit. Replaces the compile-time #define FIRE_MS_DURATION 1000 -- the
//     host can tune fire pulse width per-receiver without a reflash.
//   * ACK choreography mirrors the OTA_BEGIN handshake: a query's auto-ACK
//     fires before the receiver CPU runs (so it carries stale status), then
//     the receiver loads the CONFIG_RESPONSE into the FIFO and sets a
//     `configResponsePending` flag. The flag suppresses periodic /
//     post-command status refreshes from clobbering the response, so any
//     subsequent inbound command (the dongle queues a CLOCK_SYNC right
//     after the query) carries the response in its auto-ACK. The flag
//     auto-clears on the first non-config inbound command, restoring
//     normal RECEIVER_STATUS piggybacking thereafter.
// v14: 2026-05-XX - Move NODE_ID + RECEIVER_IDENT out of firmware and into
//   NVS (flash-backed Preferences). One firmware binary now serves the
//   whole fleet; per-unit identity is provisioned over USB serial after
//   the first flash via the host-side `devices/utils/flash_receiver.py`
//   helper (which sends a `SETID <node_id> <ident>` line and waits for
//   the chip to reboot). Notes:
//     * NODE_ID==0 is the unprovisioned sentinel: the receiver does NOT
//       start the radio, displays a slow magenta breathing pattern on
//       the status LEDs so the operator can see the unit needs
//       commissioning, and only services serial. Once provisioned,
//       ESP.restart() picks up the new identity from NVS like any boot.
//     * Serial commands accepted at any time (one per line, 115200 8N1):
//         GETID                  -> prints "NODE_ID=<n> IDENT=<s>"
//         SETID <n> <ident>      -> writes NVS, prints "OK SETID ..." then resets
//         WIPEID                 -> clears NVS identity (back to unprovisioned)
//     * NVS namespace is "byh_rx", keys "node_id" (uchar) and "ident"
//       (string, max 15 chars + NUL). The host flash workflow preserves
//       NVS across all flashes: the default partition table puts NVS at
//       0x9000-0xdfff, in the gap between the partition table and
//       boot_app0, and `flash_receiver.py` (both default and --full)
//       only writes regions outside that gap. Identity therefore
//       survives every firmware update unless someone explicitly
//       erases the chip (e.g. `esptool.py erase_flash`).
#define BOARD_VERISON 9
#define FW_VERSION 23

// Runtime identity, populated from NVS in setup(). 0 / "RX???" are the
// unprovisioned sentinels -- see loadIdentityFromNVS() and the v14 notes
// above. Treat these as read-only outside of the provisioning helpers.
uint8_t NODE_ID = 0;
char    RECEIVER_IDENT[16] = "RX???";

// True until loadIdentityFromNVS() finds a non-zero NODE_ID. Drives the
// "skip radio init + flash magenta + serial-only" provisioning loop.
bool isProvisioned = false;

Preferences identityPrefs;
static const char* IDENTITY_NS       = "byh_rx";
static const char* IDENTITY_KEY_ID   = "node_id";
static const char* IDENTITY_KEY_IDENT = "ident";
// FW v22: persisted runtime config lives in the same NVS namespace so
// existing flash/wipe tooling keeps working. Add new keys here as more
// per-receiver knobs land (kept short -- NVS keys cap at 15 chars).
static const char* CONFIG_KEY_FIRE_DUR = "fire_dur";

// Default fire-pulse width if NVS is empty (matches the legacy
// FIRE_MS_DURATION #define so unflashed-config receivers behave
// identically to older firmware).
#define DEFAULT_FIRE_DURATION_MS 1000
// Sanity bounds for incoming fire_duration_ms set requests. Anything
// shorter than 50ms is unlikely to reliably fire an e-match; anything
// longer than 5s holds the cue line in the firing state long enough
// that subsequent cues on the same module won't see it as "available
// for the next shot" within a typical show. Out-of-range values get
// clamped before NVS.
#define FIRE_DURATION_MS_MIN  50
#define FIRE_DURATION_MS_MAX  5000

// Runtime fire-pulse width. Loaded from NVS in setup(); writable via
// the RECEIVER_CONFIG_QUERY message (see v22 history note above).
uint16_t fireDurationMs = DEFAULT_FIRE_DURATION_MS;

const bool RECEIVER_USES_V1_CUES = false;

// Set to 1 for verbose serial logging (helpful for bringup, costs ms per cmd).
#define DEBUG_PRINT 0
#define DBG_PRINT(x)   do { if (DEBUG_PRINT) Serial.print(x);   } while (0)
#define DBG_PRINTLN(x) do { if (DEBUG_PRINT) Serial.println(x); } while (0)

// OTA-specific debug logging. Independent from DEBUG_PRINT because OTA
// flash mode is the most common thing operators want serial visibility
// into (the radio link is opaque from the UI), but it's also useless
// chatter during normal show operation. Defaults ON in this build so
// that anyone watching a USB serial console while OTA-flashing this
// receiver gets a per-event trace of state, errors, and progress
// without recompiling. Set to 0 if you want a quieter receiver.
#define OTA_DEBUG 1
#define OTA_LOG(x)   do { if (OTA_DEBUG) Serial.print(x);   } while (0)
#define OTA_LOGLN(x) do { if (OTA_DEBUG) Serial.println(x); } while (0)

#if BOARD_VERISON >= 6
  #define RF24_CE_PIN 37
  #define RF24_CSN_PIN 36
#else
  #define RF24_CE_PIN 34
  #define RF24_CSN_PIN 33
#endif

// FIRE pulse width is now a runtime value (`fireDurationMs`) backed by NVS
// instead of the old compile-time #define FIRE_MS_DURATION 1000. See the v22
// FW_VERSION note up top.

#define LED_PIN 11
#define STATUS_LED_PIN 17
#define STATUS_LED_COUNT 3
#define BATT_VOLTAGE_PIN 3
#define BOARD_CT_PIN 2
int NUM_BOARDS = 1;
int NUM_LEDS = (8 * NUM_BOARDS);
bool noBoardsDetected = false;

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
// Raw millis() at the time of the most recent inbound command. Stays in
// the monotonic millis domain so the disconnect math doesn't depend on
// clock_offset. (Previously this was stored in synchronized-clock units
// and a CLOCK_SYNC arrival could shift it relative to `now` by the
// clock-offset delta -- which trips the 5s threshold on clock jumps.)
uint64_t lastCmdReceivedMs = 0;
uint64_t lastInputModeRunTime = 0;
uint64_t lastMessageReceivedTime = 0;
uint64_t lastAckPayloadRefresh = 0;

// Rolling estimate of the inter-poll gap so the disconnect threshold can
// adapt to the dongle's clockSyncIntervalMs without us being told. We
// keep the last few gap samples and use the median for stability against
// occasional "dropped one ACK then got the next" outliers (which would
// otherwise double the apparent gap and slow detection of real failures).
//
// Gap is measured between successive *commands of any kind* arriving;
// the dongle's TDMA poller guarantees at least one CLOCK_SYNC per slot,
// so command arrivals are a faithful proxy for "i am still being seen".
#define POLL_GAP_SAMPLES 8
uint32_t pollGapSamples[POLL_GAP_SAMPLES] = { 0 };
uint8_t  pollGapNextIdx = 0;
uint8_t  pollGapCount   = 0;
uint64_t prevPollMs     = 0;

// Floor / ceiling around the adaptive disconnect threshold. The floor
// keeps fast pollers from triggering a false disconnect after a single
// dropped ACK; the ceiling prevents a slow poller (or a one-off long
// gap from a queue stall on the dongle) from making us blind to a real
// outage for minutes.
#define DISCONNECT_MIN_MS 8000UL
#define DISCONNECT_MAX_MS 90000UL
#define DISCONNECT_GAP_MULTIPLIER 6UL

Adafruit_NeoPixel strip(NUM_LEDS, LED_PIN, NEO_GRB + NEO_KHZ800);
Adafruit_NeoPixel statusStrip(STATUS_LED_COUNT, STATUS_LED_PIN, NEO_GRB + NEO_KHZ800);

uint32_t COLOR_CONT_NEEDED = strip.Color(180, 0, 0);
uint32_t COLOR_CONT_ACHIEVED = strip.Color(0, 175, 0);
uint32_t COLOR_CONT_AVAIL = strip.Color(0, 0, 175);
uint32_t COLOR_FIRING = strip.Color(200, 200, 0);
uint32_t COLOR_FIRED = strip.Color(0, 0, 255);

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
  SHOW_LOADN               = 11,
  RESET_DVC                = 12,
  OTA_BEGIN                = 13,
  OTA_DATA                 = 14,
  OTA_END                  = 15,
  OTA_ABORT                = 16,
  RECEIVER_OTA_STATUS      = 17,
  RECEIVER_CONFIG_QUERY    = 18,
  RECEIVER_CONFIG_RESPONSE = 19
};

// Bit flags for ReceiverConfigSetMessage.flags. flags == 0 is the
// "pure fetch" case -- the receiver applies nothing and only emits a
// CONFIG_RESPONSE on the next ACK. New knobs go here as new bit slots so
// the host can update an arbitrary subset in one frame.
#define CFG_FLAG_SET_FIRE_DURATION 0x01

// ---------------------------------------------------------------------------
// OTA flash protocol structs. All wire payloads sit comfortably under the
// 32-byte nRF24 max so they fit a single radio frame. Both sides must
// match the dongle copy of these structs (see os4_dongle.ino).
// ---------------------------------------------------------------------------

// dongle -> receiver: enter flash mode. Switching the radio to the
// requested data rate is deferred until *after* we send the ACK for this
// frame (the ACK still goes out at the previous rate so the dongle hears
// it cleanly). dataRate is encoded as: 0 = stay at 250kbps,
// 1 = RF24_1MBPS, 2 = RF24_2MBPS.
struct OtaBeginMessage {
  uint8_t  type;         // OTA_BEGIN
  uint32_t totalSize;    // bytes in firmware image (Update.begin gets this)
  uint16_t totalChunks;  // number of OTA_DATA frames the dongle plans to send
  uint8_t  dataRate;     // 0=250k, 1=1M, 2=2M
  uint32_t crc32;        // expected CRC32 of the entire image (end-to-end check)
} __attribute__((packed));

// dongle -> receiver: one slice of firmware. Followed by `len` raw payload
// bytes (where len = msgSize - sizeof(OtaDataMessage)). chunkIdx is
// monotonic-increasing across the transfer; receivers reject anything that
// isn't strictly the next slot to keep the OTA partition write order
// deterministic (Update.write() is append-only, no seek).
struct OtaDataMessage {
  uint8_t  type;       // OTA_DATA
  uint16_t chunkIdx;   // 0-based index of this chunk within the transfer
  // Followed by up to (32 - sizeof(this)) bytes of raw firmware data.
} __attribute__((packed));

struct OtaEndMessage {
  uint8_t type;        // OTA_END
} __attribute__((packed));

struct OtaAbortMessage {
  uint8_t type;        // OTA_ABORT
} __attribute__((packed));

// receiver -> dongle: fits in the same ACK FIFO as the normal status
// payload (see refreshAckPayload). The dongle picks the parser based on
// the leading type byte, so OTA mode and normal mode can interleave
// without a separate transport.
struct ReceiverOtaStatusMessage {
  uint8_t  type;             // RECEIVER_OTA_STATUS
  uint8_t  state;            // OtaState below
  uint16_t lastChunk;        // last chunkIdx successfully written
  uint32_t bytesReceived;    // running total of bytes accepted by Update.write
  uint8_t  errorCode;        // OtaError below; 0 = none
  uint8_t  nodeID;           // echoed for sanity
} __attribute__((packed));

enum OtaState : uint8_t {
  OTA_STATE_IDLE     = 0,  // not in flash mode
  OTA_STATE_PREP_OK  = 1,  // OTA_BEGIN accepted, ready to receive chunks
  OTA_STATE_RUNNING  = 2,  // streaming chunks
  OTA_STATE_DONE     = 3,  // OTA_END accepted, will reboot
  OTA_STATE_ERROR    = 4   // aborted, see errorCode
};

enum OtaError : uint8_t {
  OTA_ERR_NONE             = 0,
  OTA_ERR_BEGIN_FAILED     = 1,  // Update.begin() rejected (e.g. no partition / oversize)
  OTA_ERR_WRITE_FAILED     = 2,  // Update.write() returned short
  OTA_ERR_OVERSIZE         = 3,  // chunk pushed bytesReceived past totalSize
  OTA_ERR_END_FAILED       = 4,  // Update.end(true) failed (CRC / signature)
  OTA_ERR_OOB_CHUNK        = 5,  // chunkIdx not the expected next slot
  OTA_ERR_HOST_ABORT       = 6,  // host sent OTA_ABORT
  OTA_ERR_BAD_BEGIN        = 7   // OTA_BEGIN was malformed (bad size / rate)
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

// dongle -> receiver: fetch config (and optionally set values). flags == 0
// is a no-op write, response-only fetch; bits in `flags` request specific
// per-field writes. New writable knobs add new flag bits and new field
// slots; the wire layout stays append-only so older firmware just ignores
// trailing bytes (msgSize-checked at dispatch time).
struct ReceiverConfigSetMessage {
  uint8_t  type;              // RECEIVER_CONFIG_QUERY
  uint8_t  flags;             // bit 0: SET_FIRE_DURATION (apply fire_duration_ms)
  uint16_t fire_duration_ms;  // applied when flags & CFG_FLAG_SET_FIRE_DURATION
} __attribute__((packed));

// receiver -> dongle: piggybacks in the same ACK FIFO as RECEIVER_STATUS.
// The dongle parses on the leading type byte (RECEIVER_STATUS vs.
// RECEIVER_CONFIG_RESPONSE) and routes to the right ingestor. `reserved`
// is intentionally zero-padded for future fields without a wire bump.
struct ReceiverConfigResponseMessage {
  uint8_t  type;              // RECEIVER_CONFIG_RESPONSE
  uint8_t  nodeID;
  uint8_t  fwVersion;         // FW_VERSION
  uint8_t  boardVersion;      // BOARD_VERISON
  uint8_t  numBoards;         // 0 if noBoardsDetected, else detected NUM_BOARDS
  uint8_t  noBoardsDetected;  // 0 or 1
  uint8_t  cuesAvailable;     // 0 if noBoardsDetected, else NUM_BOARDS * 8
  uint16_t fireDurationMs;    // currently-effective fire pulse width (ms)
  uint8_t  reserved[8];       // future fields; zero-padded for now
} __attribute__((packed));

// Non-blocking show-time LED animation state machine. Declared near the top
// of the file so Arduino's auto-prototype generator sees the enum before it
// emits prototypes for functions that reference it.
enum AnimType { ANIM_NONE = 0, ANIM_PULSING_YELLOW, ANIM_FLASHING_PURPLE, ANIM_SMOOTH_WAVE, ANIM_SMOOTHER_SWEEP };
AnimType currentAnim = ANIM_NONE;
uint32_t animStartMs = 0;

// ---------------------------------------------------------------------------
// OTA runtime state. Populated on OTA_BEGIN, consumed by OTA_DATA / OTA_END.
// Only PREP_OK/RUNNING/DONE are active flash-mode states. ERROR is just the
// last failure we report in logs/ACK payloads before returning to normal
// 250kbps polling.
// ---------------------------------------------------------------------------
uint8_t  otaState        = OTA_STATE_IDLE;
uint8_t  otaError        = OTA_ERR_NONE;
uint32_t otaTotalSize    = 0;
uint16_t otaTotalChunks  = 0;
uint16_t otaLastChunk    = 0xFFFF;     // 0xFFFF = no chunk yet
uint32_t otaBytesReceived = 0;
uint32_t otaCrc32Expected = 0;
uint8_t  otaPendingDataRate = 0;       // applied after we ACK OTA_BEGIN
uint64_t otaLastActivityMs = 0;

// True between handling a RECEIVER_CONFIG_QUERY and the next inbound
// command. While set, refreshAckPayload() and the periodic 250ms
// refresh both keep the CONFIG_RESPONSE loaded in the ACK FIFO instead
// of the regular RECEIVER_STATUS, so the dongle's follow-up command
// (it queues a CLOCK_SYNC right after the query for exactly this
// reason) carries the response in its auto-ACK. Cleared on the first
// non-config inbound command -- whatever ACK that command rode away
// with was the response, and we should resume normal status piggyback.
bool configResponsePending = false;
// Watchdog for stuck OTA: if we go this long without any inbound radio
// activity in flash mode, abort and return to normal operation so a
// hung host doesn't strand the receiver.
#define OTA_INACTIVITY_TIMEOUT_MS 30000UL

RF24 radio(RF24_CE_PIN, RF24_CSN_PIN);

// Must match the dongle scheme. v10 fixed a long-standing bug where
// RECEIVER_BASE was bitwise-OR'd with NODE_ID instead of arithmetically
// added; that aliased every (even N, odd N+1) pair onto the same radio
// address. v10 receivers MUST be paired with v8+ dongle firmware -- a
// v10 receiver with NODE_ID=153 listens on 154, while a v9 receiver
// with NODE_ID=153 listens on 153. Mixing the two on the same fleet
// silently breaks polling.
const uint8_t rfChannel = 85;
const uint8_t rfSystemId = 0;
#define MASTER_WRITE_BASE 0x0000000000ULL
#define RECEIVER_BASE     0x0000000001ULL
static inline uint64_t systemSalt() {
  return ((uint64_t)rfSystemId) << 32;
}
static inline uint64_t masterWriteAddress() {
  // MASTER_WRITE_BASE is 0 so `|` and `+` are equivalent; `|` is kept to
  // make the salt-merge intent explicit.
  return MASTER_WRITE_BASE | systemSalt();
}
static inline uint64_t receiverReadAddress() {
  // Arithmetic add (not OR) so each NODE_ID maps to a unique address.
  return systemSalt() + RECEIVER_BASE + (uint64_t)NODE_ID;
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

// ---------------------------------------------------------------------------
// OTA helpers.
// ---------------------------------------------------------------------------

// Forward declarations so the inter-OTA-helper call graph compiles in any
// order Arduino's auto-prototype generator picks. (The serviceOtaLoopIteration
// driver calls back into updateOtaStatusLEDs which is defined further down.)
void updateOtaStatusLEDs();
void serviceOtaLoopIteration();

// Map a wire dataRate byte to the RF24 enum. 0 / unknown -> 250kbps so a
// malformed OTA_BEGIN can't push the radio into a state we can't recover
// from over the air.
rf24_datarate_e otaWireRate(uint8_t b) {
  if (b == 1) return RF24_1MBPS;
  if (b == 2) return RF24_2MBPS;
  return RF24_250KBPS;
}

bool otaIsActive() {
  return otaState == OTA_STATE_PREP_OK
      || otaState == OTA_STATE_RUNNING
      || otaState == OTA_STATE_DONE;
}

// Build the OTA-mode ACK payload. Same FIFO slot as buildStatus(), but
// with a different leading type byte so the dongle's status parser can
// dispatch on it. We deliberately do not include any of the normal
// telemetry here; the dongle is operator-pinned to this receiver during
// OTA and only cares about transfer progress.
void buildOtaStatus(ReceiverOtaStatusMessage* msg) {
  msg->type          = RECEIVER_OTA_STATUS;
  msg->state         = otaState;
  msg->lastChunk     = otaLastChunk;
  msg->bytesReceived = otaBytesReceived;
  msg->errorCode     = otaError;
  msg->nodeID        = NODE_ID;
}

// Refresh the ACK payload while we're in flash mode. Mirrors the normal
// refreshAckPayload() flow: flush the TX FIFO so a stale entry doesn't
// land on the dongle, then write exactly one fresh status frame so the
// next inbound command's auto-ACK carries up-to-the-millisecond OTA
// progress.
void refreshOtaAckPayload() {
  ReceiverOtaStatusMessage msg;
  buildOtaStatus(&msg);
  radio.flush_tx();
  radio.writeAckPayload(0, &msg, sizeof(msg));
  lastAckPayloadRefresh = millis();
}

// Tear down OTA state on either explicit OTA_ABORT or a local error. We
// switch the radio back to 250kbps so the receiver re-joins the normal
// fleet polling without needing a reboot. Update.abort() rolls back the
// in-progress write so the OTA partition stays in a known state.
void otaTeardown(uint8_t err) {
  // Log BEFORE we tear down so the operator can see WHY a transfer
  // suddenly stopped working from the receiver's side. The dongle has
  // no visibility into receiver-side errors -- by the time it sees
  // no_rf_ack, the receiver has already hopped back to 250kbps and
  // the dongle is stranded.
  OTA_LOG(F("[OTA] teardown err="));
  OTA_LOG(err);
  OTA_LOG(F(" state="));
  OTA_LOG(otaState);
  OTA_LOG(F(" lastChunk="));
  OTA_LOG(otaLastChunk);
  OTA_LOG(F(" bytes="));
  OTA_LOGLN(otaBytesReceived);

  if (otaState == OTA_STATE_RUNNING || otaState == OTA_STATE_PREP_OK) {
    Update.abort();
  }
  // Do not leave the receiver parked in OTA_STATE_ERROR. The main loop gates
  // normal show/radio handling on "active OTA", and if ERROR remains active
  // the unit never rejoins normal fleet polling. Preserve otaError for logs /
  // the next ACK payload, but return to IDLE immediately.
  otaState = OTA_STATE_IDLE;
  otaError = err;
  // Restore the standard data rate. The dongle does the same on its
  // side after timing out / aborting, so the channel is symmetric again.
  radio.setDataRate(RF24_250KBPS);
  refreshOtaAckPayload();
}

// OTA_BEGIN: configure Update for `totalSize` bytes and ready the receiver
// to ingest chunks. We DO NOT switch the radio data rate here -- the ACK
// for this very command still has to ride the previous rate so the dongle
// hears it. Caller (the dispatch loop) hops the rate after refreshing the
// ACK payload.
void handleOtaBegin(OtaBeginMessage* msg) {
  // Reject blatantly bad inputs early. Update.begin() will catch oversize
  // separately, but a totalSize=0 or totalChunks=0 means the host wire
  // protocol is wrong and there's nothing to do.
  if (msg->totalSize == 0 || msg->totalChunks == 0) {
    otaTeardown(OTA_ERR_BAD_BEGIN);
    return;
  }
  // Idempotent fast-path: the dongle's OTA_BEGIN handshake intentionally
  // sends OTA_BEGIN twice (once at 250kbps, once at the target rate) so
  // it can read a fresh PREP_OK ACK out of the second auto-ACK. If we're
  // already in PREP_OK with matching params, just bump the watchdog --
  // re-running Update.abort+begin would burn ~10ms of flash erase work
  // for nothing.
  if (otaState == OTA_STATE_PREP_OK
      && otaTotalSize == msg->totalSize
      && otaTotalChunks == msg->totalChunks
      && otaCrc32Expected == msg->crc32) {
    otaPendingDataRate = msg->dataRate;
    otaLastActivityMs = (uint64_t)millis();
    return;
  }
  // If we were already in OTA mode (different params, or further along),
  // abort the in-flight write before starting fresh. Lets the operator
  // re-trigger an OTA without a reboot.
  if (otaState != OTA_STATE_IDLE) {
    Update.abort();
  }
  otaTotalSize     = msg->totalSize;
  otaTotalChunks   = msg->totalChunks;
  otaCrc32Expected = msg->crc32;
  otaPendingDataRate = msg->dataRate;
  otaLastChunk     = 0xFFFF;
  otaBytesReceived = 0;
  otaError         = OTA_ERR_NONE;

  if (!Update.begin(otaTotalSize)) {
    OTA_LOG(F("[OTA] Update.begin FAILED size="));
    OTA_LOG(otaTotalSize);
    OTA_LOG(F(" UpdateErr="));
    OTA_LOGLN(Update.getError());
    otaTeardown(OTA_ERR_BEGIN_FAILED);
    return;
  }
  // Optional: feed the expected CRC to Update so end() can verify. The
  // ESP32 Update class accepts it via setMD5; we don't have an MD5
  // handy, but the trailing CRC32 we compute in software still serves
  // as an end-to-end check.
  otaState = OTA_STATE_PREP_OK;
  otaLastActivityMs = (uint64_t)millis();
  OTA_LOG(F("[OTA] BEGIN ok size="));
  OTA_LOG(otaTotalSize);
  OTA_LOG(F(" chunks="));
  OTA_LOG(otaTotalChunks);
  OTA_LOG(F(" rate="));
  OTA_LOGLN(otaPendingDataRate);
}

// OTA_DATA: append `dataLen` bytes from `data` to the OTA partition.
// dataLen = msgSize - sizeof(OtaDataMessage). We require chunks to arrive
// strictly in order (Update.write is append-only); the dongle's RF auto-
// retry plus its own flash-mode bookkeeping make in-order delivery the
// natural happy path.
void handleOtaData(OtaDataMessage* hdr, uint8_t* data, uint8_t dataLen) {
  if (otaState != OTA_STATE_PREP_OK && otaState != OTA_STATE_RUNNING) {
    // Got data without a BEGIN -- stale frame, ignore.
    OTA_LOG(F("[OTA] DATA in wrong state idx="));
    OTA_LOG(hdr->chunkIdx);
    OTA_LOG(F(" state="));
    OTA_LOGLN(otaState);
    return;
  }

  uint16_t expectedIdx = (otaLastChunk == 0xFFFF) ? 0 : (uint16_t)(otaLastChunk + 1);
  if (hdr->chunkIdx != expectedIdx) {
    // Out-of-order: most likely a duplicate from a retry that we already
    // applied. Silently re-ack the previous slot rather than tearing
    // down the whole transfer.
    if (hdr->chunkIdx == otaLastChunk) {
      otaLastActivityMs = (uint64_t)millis();
      return;
    }
    OTA_LOG(F("[OTA] OOB_CHUNK got="));
    OTA_LOG(hdr->chunkIdx);
    OTA_LOG(F(" expected="));
    OTA_LOG(expectedIdx);
    OTA_LOG(F(" lastApplied="));
    OTA_LOGLN(otaLastChunk);
    otaTeardown(OTA_ERR_OOB_CHUNK);
    return;
  }

  if ((uint32_t)otaBytesReceived + dataLen > otaTotalSize) {
    OTA_LOG(F("[OTA] OVERSIZE bytes="));
    OTA_LOG(otaBytesReceived);
    OTA_LOG(F(" + dataLen="));
    OTA_LOG(dataLen);
    OTA_LOG(F(" > totalSize="));
    OTA_LOGLN(otaTotalSize);
    otaTeardown(OTA_ERR_OVERSIZE);
    return;
  }

  size_t wrote = Update.write(data, dataLen);
  if (wrote != dataLen) {
    OTA_LOG(F("[OTA] WRITE_FAILED idx="));
    OTA_LOG(hdr->chunkIdx);
    OTA_LOG(F(" wrote="));
    OTA_LOG((uint32_t)wrote);
    OTA_LOG(F(" want="));
    OTA_LOG(dataLen);
    OTA_LOG(F(" UpdateErr="));
    OTA_LOGLN(Update.getError());
    otaTeardown(OTA_ERR_WRITE_FAILED);
    return;
  }

  otaBytesReceived += dataLen;
  otaLastChunk = hdr->chunkIdx;
  otaState = OTA_STATE_RUNNING;
  otaLastActivityMs = (uint64_t)millis();

  // Periodic progress. Every 256 chunks (~7KB) is light enough not to
  // dominate the serial bandwidth even at 2Mbps OTA throughput.
  if ((hdr->chunkIdx & 0xFF) == 0) {
    OTA_LOG(F("[OTA] progress idx="));
    OTA_LOG(hdr->chunkIdx);
    OTA_LOG(F(" bytes="));
    OTA_LOG(otaBytesReceived);
    OTA_LOG(F("/"));
    OTA_LOGLN(otaTotalSize);
  }
}

// OTA_END: commit the image and reboot. After ESP.restart() the bootloader
// jumps to the freshly-written app partition (Update.end(true) flips the
// OTA-data sector to point at it). NVS is untouched, so identity carries
// across the boot.
void handleOtaEnd() {
  if (otaState != OTA_STATE_RUNNING && otaState != OTA_STATE_PREP_OK) {
    OTA_LOG(F("[OTA] END in wrong state state="));
    OTA_LOGLN(otaState);
    return;
  }
  if (otaBytesReceived != otaTotalSize) {
    OTA_LOG(F("[OTA] END short bytes="));
    OTA_LOG(otaBytesReceived);
    OTA_LOG(F(" want="));
    OTA_LOGLN(otaTotalSize);
    otaTeardown(OTA_ERR_END_FAILED);
    return;
  }
  if (!Update.end(true)) {
    OTA_LOG(F("[OTA] Update.end FAILED UpdateErr="));
    OTA_LOGLN(Update.getError());
    otaTeardown(OTA_ERR_END_FAILED);
    return;
  }
  OTA_LOGLN(F("[OTA] END ok -- rebooting"));
  otaState = OTA_STATE_DONE;
  otaError = OTA_ERR_NONE;
  // Refresh the ACK payload so the dongle sees state=DONE on its next
  // poll, then reboot. We give the radio a beat to drain the in-flight
  // ACK before pulling the trigger.
  refreshOtaAckPayload();
  delay(80);
  ESP.restart();
}

// Operator-initiated abort: tear down and resume normal polling at 250kbps
// without rebooting.
void handleOtaAbort() {
  otaTeardown(OTA_ERR_HOST_ABORT);
}

// Hot-path tick called from loop() while otaState != IDLE. We service
// the radio aggressively (most frames are OTA_DATA), refresh the OTA
// ACK after each one, and skip every other expensive thing the normal
// loop does.
void serviceOtaLoopIteration() {
  bool sawAny = false;
  while (radio.available()) {
    uint8_t buf[32];
    uint8_t msgSize = radio.getDynamicPayloadSize();
    if (msgSize == 0 || msgSize > sizeof(buf)) {
      radio.flush_rx();
      break;
    }
    radio.read(&buf, msgSize);
    sawAny = true;
    uint8_t mType = buf[0];
    switch (mType) {
      case OTA_BEGIN:
        if (msgSize >= sizeof(OtaBeginMessage)) {
          handleOtaBegin((OtaBeginMessage*)buf);
          refreshOtaAckPayload();
          if (otaState == OTA_STATE_PREP_OK) {
            delay(2);
            radio.setDataRate(otaWireRate(otaPendingDataRate));
          }
        }
        break;
      case OTA_DATA: {
        if (msgSize > sizeof(OtaDataMessage)) {
          uint8_t dataLen = msgSize - sizeof(OtaDataMessage);
          handleOtaData((OtaDataMessage*)buf,
                        buf + sizeof(OtaDataMessage),
                        dataLen);
          refreshOtaAckPayload();
        }
        break;
      }
      case OTA_END:
        // handleOtaEnd refreshes the ACK and reboots if successful.
        // If it fails we drop into the error branch and resume normal
        // operation on the next iteration.
        handleOtaEnd();
        if (otaState != OTA_STATE_DONE) {
          // Update.end failed -- restore radio so we can be polled
          // normally and the operator can see the failure code.
          radio.setDataRate(RF24_250KBPS);
        }
        refreshOtaAckPayload();
        break;
      case OTA_ABORT:
        handleOtaAbort();
        refreshOtaAckPayload();
        break;
      default:
        // While OTA is active we ignore non-OTA frames to avoid
        // half-applying a normal command in the middle of a flash.
        // The dongle is operator-pinned to us during this window
        // anyway, so nothing else should be coming in.
        break;
    }
  }
  if (sawAny) {
    otaLastActivityMs = (uint64_t)millis();
  }

  // Watchdog: if the host wedges mid-transfer we don't want to be
  // permanently parked at 2Mbps with no fleet polling. Tear down
  // gracefully and resume normal operation.
  if (otaState == OTA_STATE_PREP_OK || otaState == OTA_STATE_RUNNING) {
    if ((uint64_t)millis() - otaLastActivityMs > OTA_INACTIVITY_TIMEOUT_MS) {
      otaTeardown(OTA_ERR_HOST_ABORT);
    }
  }

  updateOtaStatusLEDs();
  // Tight wait so we don't busy-spin the CPU while idle between chunks.
  delay(1);
}

// Driven from the main loop while otaState != IDLE: paints all three
// status LEDs at a low pulsing white so the operator can see the unit
// is being reflashed, with a green tinge once we've committed.
void updateOtaStatusLEDs() {
  uint32_t cyc = millis() % 1500;
  uint8_t b = (cyc < 750) ? (uint8_t)((cyc * 90) / 750)
                          : (uint8_t)(((1500 - cyc) * 90) / 750);
  uint32_t color = statusStrip.Color(b, b, b);
  if (otaState == OTA_STATE_DONE) {
    color = statusStrip.Color(0, b, 0);
  } else if (otaState == OTA_STATE_ERROR) {
    color = statusStrip.Color(b, 0, 0);
  }
  for (int i = 0; i < STATUS_LED_COUNT; i++) {
    statusStrip.setPixelColor(i, color);
  }
  statusStrip.show();
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
//
// We flush the TX FIFO first, then write a single fresh payload. Without
// the flush, the FIFO (3 slots deep) accumulates entries when the
// periodic 250ms refresh outpaces command consumption -- the dongle
// would then see the *oldest* queued payload, up to ~750ms stale, which
// matters for battery / continuity / showState bits during loading.
// flush_tx() on the receiver side affects only outgoing payloads (the
// auto-ACK queue) and is safe to call any time we own the radio.
void refreshAckPayload() {
  // FW v22: while a CONFIG_RESPONSE is sitting in the ACK FIFO waiting
  // to ride out on the dongle's follow-up command, leave it alone.
  // Overwriting with RECEIVER_STATUS here would cause the response to
  // be silently dropped (the dongle would just see a stale status and
  // never learn about the receiver's NUM_BOARDS / fire_duration / etc).
  // The flag clears on the first non-config inbound command (see the
  // dispatch loop), at which point the next refresh restores normal
  // status piggybacking.
  if (configResponsePending) return;

  ReceiverStatusMessage msg;
  buildStatus(&msg);
  radio.flush_tx();
  radio.writeAckPayload(0, &msg, sizeof(msg));
  lastAckPayloadRefresh = millis();
}

// FW v22: build the receiver-side configuration snapshot. cuesAvailable
// is the *physically usable* cue count -- 0 when no boards detected,
// otherwise NUM_BOARDS * 8. numBoards mirrors that: when no boards are
// detected we report 0 even though setBoardCount() clamps the runtime
// NUM_BOARDS to 1 internally for buffer-sizing safety. The host should
// never have to know about that internal clamp.
void buildConfigResponse(ReceiverConfigResponseMessage* msg) {
  memset(msg, 0, sizeof(*msg));
  msg->type             = RECEIVER_CONFIG_RESPONSE;
  msg->nodeID           = NODE_ID;
  msg->fwVersion        = FW_VERSION;
  msg->boardVersion     = BOARD_VERISON;
  msg->numBoards        = noBoardsDetected ? 0 : (uint8_t)NUM_BOARDS;
  msg->noBoardsDetected = noBoardsDetected ? 1 : 0;
  msg->cuesAvailable    = noBoardsDetected ? 0 : (uint8_t)(NUM_BOARDS * 8);
  msg->fireDurationMs   = fireDurationMs;
  // reserved[8] already zeroed by memset above.
}

// FW v22: load the CONFIG_RESPONSE into the ACK TX FIFO so the dongle's
// next inbound command (it deliberately queues a CLOCK_SYNC right after
// the query) carries the response in its auto-ACK. Sets
// configResponsePending so refreshAckPayload() / the periodic 250ms
// refresh won't clobber it before the dongle pulls it.
void loadConfigResponseIntoAck() {
  ReceiverConfigResponseMessage msg;
  buildConfigResponse(&msg);
  radio.flush_tx();
  radio.writeAckPayload(0, &msg, sizeof(msg));
  configResponsePending = true;
  lastAckPayloadRefresh = millis();
}

// FW v22: handle an incoming RECEIVER_CONFIG_QUERY. flags == 0 is a
// pure fetch -- we apply nothing and only emit the response. Each set
// bit in flags requests a corresponding write; today the only knob is
// SET_FIRE_DURATION. saveFireDurationToNVS() clamps to
// [FIRE_DURATION_MS_MIN, FIRE_DURATION_MS_MAX] before persisting, so
// the response always reports the actually-applied (clamped) value
// rather than what the host requested.
void handleConfigQuery(ReceiverConfigSetMessage* m) {
  if (m->flags & CFG_FLAG_SET_FIRE_DURATION) {
    saveFireDurationToNVS(m->fire_duration_ms);
    Serial.print(F("Config: fire_duration_ms set to "));
    Serial.println(fireDurationMs);
  }
  loadConfigResponseIntoAck();
}

// Push one inter-poll gap sample into the ring and return a stability-
// preferring estimator (median for >= 3 samples, mean otherwise). Median
// keeps a single huge outlier from doubling our disconnect threshold.
uint32_t pollGapEstimateMs() {
  if (pollGapCount == 0) return 0;
  uint32_t copy[POLL_GAP_SAMPLES];
  for (uint8_t i = 0; i < pollGapCount; i++) copy[i] = pollGapSamples[i];
  // tiny insertion sort (n <= 8)
  for (uint8_t i = 1; i < pollGapCount; i++) {
    uint32_t v = copy[i];
    int8_t j = i - 1;
    while (j >= 0 && copy[j] > v) { copy[j + 1] = copy[j]; j--; }
    copy[j + 1] = v;
  }
  if (pollGapCount >= 3) return copy[pollGapCount / 2];
  uint32_t sum = 0;
  for (uint8_t i = 0; i < pollGapCount; i++) sum += copy[i];
  return sum / pollGapCount;
}

// Recompute the adaptive disconnect threshold from the current gap
// estimate. Returns ms.
uint32_t adaptiveDisconnectMs() {
  uint32_t gap = pollGapEstimateMs();
  if (gap == 0) return DISCONNECT_MIN_MS;
  uint64_t scaled = (uint64_t)gap * DISCONNECT_GAP_MULTIPLIER;
  if (scaled < DISCONNECT_MIN_MS) return DISCONNECT_MIN_MS;
  if (scaled > DISCONNECT_MAX_MS) return DISCONNECT_MAX_MS;
  return (uint32_t)scaled;
}

// Record that we just heard a command from the dongle. Updates the
// rolling gap estimate so adaptiveDisconnectMs() tracks the dongle's
// current poll cadence.
void notePollContact(uint64_t nowMs) {
  if (prevPollMs != 0) {
    uint64_t delta = nowMs - prevPollMs;
    // Guard against a >1 minute gap (we were probably actually
    // disconnected) corrupting the estimate. Anything beyond the cap
    // is itself a sign of trouble; we just don't let it skew the
    // baseline.
    if (delta > DISCONNECT_MAX_MS) delta = DISCONNECT_MAX_MS;
    pollGapSamples[pollGapNextIdx] = (uint32_t)delta;
    pollGapNextIdx = (pollGapNextIdx + 1) % POLL_GAP_SAMPLES;
    if (pollGapCount < POLL_GAP_SAMPLES) pollGapCount++;
  }
  prevPollMs = nowMs;
}

// ---------------------------------------------------------------------------
// Identity (NODE_ID + RECEIVER_IDENT) NVS helpers + serial provisioning.
// ---------------------------------------------------------------------------
//
// Pre-v14, NODE_ID and RECEIVER_IDENT were #define / const baked into the
// firmware -- so every receiver in the fleet needed its own custom build.
// v14 moves identity into the NVS partition (flash-backed key/value store
// via the Arduino Preferences wrapper) so one binary serves all units;
// commissioning is done after-the-fact over USB serial. See FW_VERSION
// notes at the top of this file for the full design.

void loadIdentityFromNVS() {
  identityPrefs.begin(IDENTITY_NS, true);  // read-only
  NODE_ID = identityPrefs.getUChar(IDENTITY_KEY_ID, 0);
  size_t got = identityPrefs.getString(IDENTITY_KEY_IDENT, RECEIVER_IDENT, sizeof(RECEIVER_IDENT));
  if (got == 0) {
    strncpy(RECEIVER_IDENT, "RX???", sizeof(RECEIVER_IDENT));
  }
  RECEIVER_IDENT[sizeof(RECEIVER_IDENT) - 1] = '\0';
  identityPrefs.end();
  isProvisioned = (NODE_ID != 0);
}

bool saveIdentityToNVS(uint8_t newId, const char* newIdent) {
  if (newId == 0) return false;
  if (newIdent == nullptr) return false;
  size_t identLen = strnlen(newIdent, sizeof(RECEIVER_IDENT));
  if (identLen == 0 || identLen >= sizeof(RECEIVER_IDENT)) return false;

  identityPrefs.begin(IDENTITY_NS, false);  // read/write
  identityPrefs.putUChar(IDENTITY_KEY_ID, newId);
  identityPrefs.putString(IDENTITY_KEY_IDENT, newIdent);
  identityPrefs.end();
  return true;
}

void wipeIdentityFromNVS() {
  identityPrefs.begin(IDENTITY_NS, false);
  identityPrefs.clear();
  identityPrefs.end();
}

// FW v22: persisted runtime config. Lives in the same IDENTITY_NS so
// `flash_receiver.py` and the WIPEID serial helper continue to work
// without surgery -- WIPEID intentionally clears these too, matching
// the existing "factory reset" semantics for a unit. Defaults are
// applied (in setup()) when the key is missing, so legacy units that
// have never been configured behave exactly like the old #define.

void loadFireDurationFromNVS() {
  identityPrefs.begin(IDENTITY_NS, true);  // read-only
  uint16_t fromNvs = identityPrefs.getUShort(CONFIG_KEY_FIRE_DUR, 0);
  identityPrefs.end();
  if (fromNvs >= FIRE_DURATION_MS_MIN && fromNvs <= FIRE_DURATION_MS_MAX) {
    fireDurationMs = fromNvs;
  } else {
    fireDurationMs = DEFAULT_FIRE_DURATION_MS;
  }
}

bool saveFireDurationToNVS(uint16_t value) {
  if (value < FIRE_DURATION_MS_MIN) value = FIRE_DURATION_MS_MIN;
  if (value > FIRE_DURATION_MS_MAX) value = FIRE_DURATION_MS_MAX;
  identityPrefs.begin(IDENTITY_NS, false);
  size_t wrote = identityPrefs.putUShort(CONFIG_KEY_FIRE_DUR, value);
  identityPrefs.end();
  if (wrote == 0) return false;
  fireDurationMs = value;
  return true;
}

// Read a single line (CR/LF terminated) from Serial without blocking. Returns
// true and writes a null-terminated string into `out` (capacity outCap) when
// a complete line has arrived. Internal state is static to this function.
bool readSerialLine(char* out, size_t outCap) {
  static char buf[64];
  static size_t len = 0;
  while (Serial.available()) {
    int c = Serial.read();
    if (c < 0) break;
    if (c == '\r') continue;
    if (c == '\n') {
      buf[len] = '\0';
      strncpy(out, buf, outCap);
      out[outCap - 1] = '\0';
      len = 0;
      return true;
    }
    if (len + 1 < sizeof(buf)) buf[len++] = (char)c;
    // Silently drop overflow; the next CR/LF starts a fresh line.
    else len = 0;
  }
  return false;
}

// Process one serial line if available. Always safe to call from the main
// loop; it's the host-side hook for `devices/utils/flash_receiver.py`.
void serviceSerialProvisioning() {
  char line[64];
  if (!readSerialLine(line, sizeof(line))) return;

  if (strncmp(line, "GETID", 5) == 0) {
    Serial.print(F("NODE_ID="));
    Serial.print(NODE_ID);
    Serial.print(F(" IDENT="));
    Serial.println(RECEIVER_IDENT);
    return;
  }

  if (strncmp(line, "WIPEID", 6) == 0) {
    wipeIdentityFromNVS();
    Serial.println(F("OK WIPEID -- restarting"));
    delay(100);
    ESP.restart();
    return;
  }

  if (strncmp(line, "SETID ", 6) == 0) {
    // Format: "SETID <node_id> <ident>"
    int newId = -1;
    char newIdent[sizeof(RECEIVER_IDENT)] = {0};
    int n = sscanf(line + 6, "%d %15s", &newId, newIdent);
    if (n != 2 || newId < 1 || newId > 254) {
      Serial.println(F("ERR SETID -- usage: SETID <1-254> <ident>"));
      return;
    }
    if (!saveIdentityToNVS((uint8_t)newId, newIdent)) {
      Serial.println(F("ERR SETID -- save failed"));
      return;
    }
    Serial.print(F("OK SETID NODE_ID="));
    Serial.print(newId);
    Serial.print(F(" IDENT="));
    Serial.print(newIdent);
    Serial.println(F(" -- restarting"));
    delay(100);
    ESP.restart();
  }
}

// Visual cue for the operator that this unit hasn't been provisioned yet.
// Slow magenta breathing on all three status LEDs. Non-blocking; called
// every loop iter from the unprovisioned branch.
void updateUnprovisionedStatusLEDs() {
  // 2s sine-ish breathing (linear triangle is fine).
  uint32_t cyc = millis() % 2000;
  uint8_t b = (cyc < 1000) ? (uint8_t)((cyc * 200) / 1000)
                           : (uint8_t)(((2000 - cyc) * 200) / 1000);
  for (int i = 0; i < STATUS_LED_COUNT; i++) {
    statusStrip.setPixelColor(i, statusStrip.Color(b, 0, b));
  }
  statusStrip.show();
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
            if (millis() - fireStartTime[i] >= fireDurationMs) {
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

// Fixed palette mapping decimal digits 0..9 -> a vivid NeoPixel color.
// Ordering chosen so that consecutive digits are maximally distinct
// (red->blue->yellow->green->purple->cyan->orange->white->pink->lime),
// which is what matters when reading FW_VERSION off the 3 status LEDs
// (see v16 history note). Stored in {R, G, B} order; converted to a
// packed 32-bit color at use time so STATUS_LED_COUNT can change without
// touching this table.
static const uint8_t FW_DIGIT_COLORS[10][3] = {
  {255,   0,   0},  // 0 red
  {  0,   0, 255},  // 1 blue
  {255, 200,   0},  // 2 yellow
  {  0, 255,   0},  // 3 green
  {180,   0, 255},  // 4 purple
  {  0, 255, 255},  // 5 cyan
  {255,  80,   0},  // 6 orange
  {255, 255, 255},  // 7 white
  {255,   0, 120},  // 8 pink
  {160, 255,   0},  // 9 lime
};

// Display a 0..999 number as 3 decimal digits across the 3 status LEDs
// (LED 0 = hundreds, LED 1 = tens, LED 2 = ones) with a slow breath in
// and out. Each digit is colored from FW_DIGIT_COLORS so consecutive
// values are easy to tell apart at a glance. Used by the boot sequence
// to flash both FW_VERSION and NODE_ID; see v16 history note.
void breatheStatusDigits(uint16_t value) {
  uint16_t v = value % 1000;
  uint8_t digits[STATUS_LED_COUNT];
  digits[0] = (uint8_t)((v / 100) % 10);   // LED 0: hundreds
  digits[1] = (uint8_t)((v /  10) % 10);   // LED 1: tens
  digits[2] = (uint8_t)( v        % 10);   // LED 2: ones

  const int breathSteps = 50;
  const int breathDelay = 15;
  for (int j = 0; j <= breathSteps; j++) {
    uint16_t bb = (j * 255) / breathSteps;
    for (int i = 0; i < STATUS_LED_COUNT; i++) {
      const uint8_t* c = FW_DIGIT_COLORS[digits[i]];
      uint8_t r = (uint8_t)((c[0] * bb) / 255);
      uint8_t g = (uint8_t)((c[1] * bb) / 255);
      uint8_t b = (uint8_t)((c[2] * bb) / 255);
      statusStrip.setPixelColor(i, statusStrip.Color(r, g, b));
    }
    statusStrip.show();
    delay(breathDelay);
  }
  for (int j = breathSteps; j >= 0; j--) {
    uint16_t bb = (j * 255) / breathSteps;
    for (int i = 0; i < STATUS_LED_COUNT; i++) {
      const uint8_t* c = FW_DIGIT_COLORS[digits[i]];
      uint8_t r = (uint8_t)((c[0] * bb) / 255);
      uint8_t g = (uint8_t)((c[1] * bb) / 255);
      uint8_t b = (uint8_t)((c[2] * bb) / 255);
      statusStrip.setPixelColor(i, statusStrip.Color(r, g, b));
    }
    statusStrip.show();
    delay(breathDelay);
  }
  statusStrip.clear();
  statusStrip.show();
}

void statusLEDStartupSequence() {
  // 1st flash: FW_VERSION as 3 decimal digits in the digit-color palette.
  breatheStatusDigits((uint16_t)FW_VERSION);
  delay(100);

  // 2nd flash: battery level (number of lit LEDs = bars; color = level).
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

  // 3rd flash: NODE_ID as 3 decimal digits in the same digit-color palette.
  // Unprovisioned units (NODE_ID==0) display all-red(0). The full
  // unprovisioned magenta-breathe pattern still kicks in afterwards from
  // the main loop, so this is just a heads-up, not the only signal.
  breatheStatusDigits((uint16_t)NODE_ID);
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
  if      (targetY < 1100) NUM_BOARDS = 1;
  else if (targetY < 1900) NUM_BOARDS = 2;
  else if (targetY < 2500) NUM_BOARDS = 3;
  else if (targetY < 3150) NUM_BOARDS = 4;
  else if (targetY < 3500) NUM_BOARDS = 5;
  else if (targetY < 4000) NUM_BOARDS = 6;
  else if (targetY < 4400) NUM_BOARDS = 7;
  else if (targetY < 5000) NUM_BOARDS = 8;
  else NUM_BOARDS = 0;

  if(NUM_BOARDS == 0) {
    NUM_BOARDS = 1;
    noBoardsDetected = true;
    DBG_PRINTLN("No Cue board detected. Defaulting to 1");
  }else{
    noBoardsDetected = false;
  }
  NUM_LEDS = (8 * NUM_BOARDS);
  
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

  // Same TX-timeout reasoning as the dongle: prevent any Serial.print
  // (incl. OTA_LOGLN inside the OTA hot path) from blocking the main
  // loop indefinitely when the host isn't draining USB CDC. 50ms is
  // long enough to never drop bytes in normal operation, short enough
  // to keep the radio responsive even if the operator pulled the
  // serial cable mid-OTA.
  Serial.begin(115200);
  Serial.setTxTimeoutMs(50);
  delay(1000);

  loadIdentityFromNVS();
  loadFireDurationFromNVS();

  setBoardCount();

  pinMode(SHIFT_IN_CLOCK, OUTPUT);
  pinMode(SHIFT_IN_LATCH, OUTPUT);
  pinMode(SHIFT_IN_DATA, INPUT);

  Serial.print(F("Board Version: ")); Serial.println(BOARD_VERISON);
  Serial.print(F("FW Version: "));    Serial.println(FW_VERSION);
  Serial.print(F("Ident: "));         Serial.println(RECEIVER_IDENT);
  Serial.print(F("NODE_ID: "));       Serial.println(NODE_ID);
  Serial.print(F("Fire duration: ")); Serial.print(fireDurationMs); Serial.println(F(" ms"));

  statusStrip.begin();
  statusStrip.clear();
  statusStrip.show();
  statusLEDStartupSequence();

  strip.begin();
  strip.clear();
  strip.show();
  strip.updateLength(NUM_LEDS);

  testLEDStrip();

  // Bail out before radio init if we have no identity. The main loop will
  // breathe magenta and service the SETID serial command. Once the host
  // sends `SETID <n> <ident>` we ESP.restart() and re-enter setup() with
  // a real NODE_ID.
  if (!isProvisioned) {
    Serial.println(F("UNPROVISIONED: send `SETID <node_id> <ident>` over serial."));
    return;
  }

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

  Serial.print(F("FW Version: "));
  Serial.println(FW_VERSION);

  // Pre-load an initial ACK payload so the very first command we receive can
  // ACK back with current status.
  refreshAckPayload();
}

void loop() {
  // Serial provisioning is always live -- this is the only way to recover
  // a unit whose NODE_ID got wiped, and the only way to re-ID a unit in
  // the field without re-flashing.
  serviceSerialProvisioning();

  if (!isProvisioned) {
    updateUnprovisionedStatusLEDs();
    delay(10);
    return;
  }

  // While we're in OTA flash mode, run a tight inner loop dedicated to
  // ingesting OTA frames + repainting the OTA status LEDs. Skip the
  // normal show / poll-gap / disconnect machinery -- if a show was
  // running it stays running on its loaded schedule (see runPlayLoop
  // notes in v12), and the operator already gated this off "no show
  // loaded" on the host side anyway.
  if (otaIsActive()) {
    serviceOtaLoopIteration();
    return;
  }

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
    // Feed the adaptive-cadence estimator so the disconnect threshold
    // tracks whatever clockSyncIntervalMs the dongle is running on.
    notePollContact((uint64_t)millis());

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
      case OTA_BEGIN:
        if (msgSize >= sizeof(OtaBeginMessage)) {
          handleOtaBegin((OtaBeginMessage*)buf);
          // Refresh the ACK payload right now so the dongle's read of
          // this very command carries the OTA prep status. Then hop the
          // radio data rate to whatever the dongle asked for -- the
          // ACK has already gone out at the previous (negotiated) rate.
          refreshOtaAckPayload();
          if (otaState == OTA_STATE_PREP_OK) {
            delay(2);  // let the radio drain the ACK before we hop
            radio.setDataRate(otaWireRate(otaPendingDataRate));
          }
          // Skip the normal status refresh / disconnect bookkeeping
          // below; we're now in OTA mode for the next iteration.
          lastCmdReceivedMs = (uint64_t)millis();
          continue;
        }
        break;
      case RECEIVER_CONFIG_QUERY:
        if (msgSize >= sizeof(ReceiverConfigSetMessage)) {
          handleConfigQuery((ReceiverConfigSetMessage*)buf);
          // Skip the normal post-command refreshAckPayload() below --
          // it would no-op anyway thanks to configResponsePending, but
          // bail explicitly so the intent is obvious. The response is
          // already loaded in the ACK FIFO; the next inbound command
          // (the dongle queues a CLOCK_SYNC right after) will ride it
          // out and clear the flag.
          lastCmdReceivedMs = (uint64_t)millis();
          continue;
        }
        break;
      default:
        DBG_PRINT("Unknown message type: ");
        DBG_PRINTLN(mType);
        break;
    }

    // FW v22: any non-config inbound command means the dongle has
    // already pulled the previously-loaded CONFIG_RESPONSE off the
    // wire (it rode out in *this* command's auto-ACK). Clear the flag
    // so refreshAckPayload() below can resume normal status piggyback.
    if (mType != RECEIVER_CONFIG_QUERY) configResponsePending = false;

    // Refresh the ACK payload immediately so the next command's auto-ACK
    // carries fresh status. This replaces the old sendStatus() TX pattern.
    refreshAckPayload();

    // Trigger non-blocking decorative animations on certain commands.
    if (mType == SHOW_START)         requestAnim(ANIM_SMOOTH_WAVE);
    else if (mType == GENERIC_RESET) requestAnim(ANIM_SMOOTHER_SWEEP);

    // Stamp in raw millis (monotonic) so the disconnect math is
    // unaffected by handleClockSync mutating clock_offset above.
    lastCmdReceivedMs = (uint64_t)millis();
  }

  // Periodic ACK payload refresh so battery/continuity stays current even
  // during quiet periods.
  if (millis() - lastAckPayloadRefresh > ACK_PAYLOAD_REFRESH_MS) {
    refreshAckPayload();
  }

  updateNonBlockingAnim();
  updateStatusLEDs();

  // Disconnect detection. Threshold scales with the observed inter-poll
  // gap so the dongle's clockSyncIntervalMs can be retuned at runtime
  // without us false-firing. See pollGapEstimateMs / adaptiveDisconnectMs.
  //
  // IMPORTANT: this uses raw millis() on both sides of the comparison.
  // We deliberately don't use the synchronized clock here -- a
  // handleClockSync() inside the radio.available() loop above can
  // mutate clock_offset, and using `now = millis() + clock_offset`
  // would inject that delta into the disconnect math even though no
  // real time has passed.
  //
  // Crucially, on a true disconnect we re-arm the radio and flash
  // purple so the operator can see the blip, but we DO NOT clear
  // isPlaying. The show is loaded locally with absolute synchronized
  // fire times; a transient RF dropout doesn't invalidate any of that.
  // Killing isPlaying caused receivers that briefly lost contact
  // mid-show to stop firing for the rest of the show, which is much
  // worse than the alternative of firing through the blackout. If the
  // operator wants a hard stop, they can hit the stop button.
  uint64_t nowMs = (uint64_t)millis();
  uint32_t discMs = adaptiveDisconnectMs();
  if (nowMs - lastCmdReceivedMs > discMs && gotCommand) {
    DBG_PRINT("Disconnect detected (threshold=");
    DBG_PRINT(discMs);
    DBG_PRINTLN("ms, isPlaying=");
    DBG_PRINT(isPlaying ? 1 : 0);
    DBG_PRINTLN(") -- re-arming radio, NOT aborting show");
    if (isPlaying) {
      // Visual cue for the operator that this receiver lost the dongle
      // briefly. The animation is non-blocking and lasts ~1s; firing
      // continues on the loaded schedule throughout.
      requestAnim(ANIM_FLASHING_PURPLE);
    }
    gotCommand = false;
    // Reset the gap estimator -- the new cadence will be re-learned from
    // the next few contacts post-reconnect, which is right: a stale
    // pre-disconnect estimate would otherwise inflate the new threshold.
    pollGapCount = 0;
    pollGapNextIdx = 0;
    prevPollMs = 0;
    // Re-arm the radio in case it's stuck in a weird state.
    radio.flush_tx();
    radio.flush_rx();
    radio.openReadingPipe(0, receiverReadAddress());
    radio.startListening();
    refreshAckPayload();
    // Bump lastCmdReceivedMs so we don't re-trigger every loop iter
    // until the next real contact arrives.
    lastCmdReceivedMs = nowMs;
  }

  // Auto-clear stale firing state if the show loop didn't (defensive).
  bool doRefresh = false;
  for (uint8_t i = 0; i < 128; i++) {
    if (targetFiring[i]) {
      if (millis() - fireStartTime[i] >= fireDurationMs) {
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
