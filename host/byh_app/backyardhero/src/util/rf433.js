// Bilusocn 433MHz transmit timing.
//
// The dongle transmits each `433fire >>bits:N<<` synchronously: one 24-bit
// frame sent N times, and it doesn't start the next command until it's done.
// So the repeat count N sets the minimum spacing between back-to-back
// Bilusocn cues. Cues scheduled closer than that queue up on the dongle and
// fire late.
//
// Frame timing comes from the dongle firmware (sendOneMessage /
// sendZeroMessage / sendBinaryString in omni_dongle.cpp and os4_dongle.ino):
//   1 bit = 376us high + 1030us low = 1406us
//   0 bit = 1032us high + 566us low = 1598us
//   + 400us stop pulse + 10ms gap after every frame
// 12 of the 24 bits are fixed (8 ones, 4 zeros); the zone byte and target
// nibble decide the rest, so a frame takes 44.9ms-47.2ms. We use the
// worst case so the spacing shown is always safe.
//
// Bounds mirror RF433_REPEAT_* in pythings/pc_daemon/protocol_handler/
// BYHProtocolHandler.py.

export const RF433_REPEAT_DEFAULT = 8;
export const RF433_REPEAT_MIN = 1;
export const RF433_REPEAT_MAX = 10;

const BIT_ONE_US = 376 + 1030;
const BIT_ZERO_US = 1032 + 566;
const FRAME_TAIL_US = 400 + 10_000;
// Worst case: only the 8 fixed one-bits are ones; the other 16 are zeros.
export const RF433_FRAME_MS_MAX = (8 * BIT_ONE_US + 16 * BIT_ZERO_US + FRAME_TAIL_US) / 1000;

/** Minimum spacing (ms) between back-to-back Bilusocn cues at `repeatCt`. */
export function rf433MinSpacingMs(repeatCt) {
  const n = Math.max(RF433_REPEAT_MIN, Math.min(RF433_REPEAT_MAX, Math.round(repeatCt) || RF433_REPEAT_DEFAULT));
  return Math.ceil(n * RF433_FRAME_MS_MAX);
}

/** Max back-to-back Bilusocn cues per second at `repeatCt`. */
export function rf433MaxCuesPerSecond(repeatCt) {
  return 1000 / rf433MinSpacingMs(repeatCt);
}

// A cue that ends up this late is worth flagging. Below this the delay is
// lost in fuse/lift timing (and the spacing figure is already worst case).
export const RF433_LATE_WARN_MS = 50;

/**
 * Find Bilusocn cues the dongle can't send on time.
 *
 * The dongle has one 433MHz transmitter and sends each cue's repeats before
 * starting the next, across every Bilusocn zone. We replay the show through
 * that queue: each cue starts at max(its fire time, when the previous one
 * finished). A run of back-to-back cues where the queue never drained is
 * one cluster; clusters whose worst delay is >= RF433_LATE_WARN_MS are
 * returned.
 *
 * `items` are timeline items ({ id, zone, startTime, delay? }). Fire time
 * is startTime - delay, matching pc_daemon.process_display_payload.
 * `bilusocnZones` is a Set of zone ids (strings) owned by Bilusocn entries.
 *
 * Returns [{ itemIds, firstItemId, count, fromSec, toSec, maxLateMs }].
 */
export function findBilusocnLateCues(items, bilusocnZones, repeatCt) {
  if (!Array.isArray(items) || !bilusocnZones || bilusocnZones.size === 0) return [];
  const spacingMs = rf433MinSpacingMs(repeatCt);

  const cues = [];
  for (const item of items) {
    if (!item || !bilusocnZones.has(String(item.zone))) continue;
    const start = Number(item.startTime);
    if (!Number.isFinite(start)) continue;
    const delay = Number(item.delay) || 0;
    cues.push({ id: item.id, fireMs: (start - delay) * 1000 });
  }
  cues.sort((a, b) => a.fireMs - b.fireMs);

  const clusters = [];
  let cluster = null;
  let freeAtMs = -Infinity;
  for (const cue of cues) {
    const startMs = Math.max(cue.fireMs, freeAtMs);
    const lateMs = startMs - cue.fireMs;
    if (lateMs > 0 && cluster) {
      cluster.itemIds.push(cue.id);
      cluster.toMs = cue.fireMs;
      cluster.maxLateMs = Math.max(cluster.maxLateMs, lateMs);
    } else {
      if (cluster && cluster.maxLateMs >= RF433_LATE_WARN_MS) clusters.push(cluster);
      cluster = { itemIds: [cue.id], fromMs: cue.fireMs, toMs: cue.fireMs, maxLateMs: 0 };
    }
    freeAtMs = startMs + spacingMs;
  }
  if (cluster && cluster.maxLateMs >= RF433_LATE_WARN_MS) clusters.push(cluster);

  return clusters.map((c) => ({
    itemIds: c.itemIds,
    firstItemId: c.itemIds[0],
    count: c.itemIds.length,
    fromSec: c.fromMs / 1000,
    toSec: c.toMs / 1000,
    maxLateMs: Math.round(c.maxLateMs),
  }));
}
