// Shared receiver predicates. Centralised so health metrics across the
// console (StatusBar's receiver count, ShowHealthStrip pre-flight,
// ConsolePanel's "all receivers online" gate) all agree on what counts.
//
// Two rules:
//   1. Disabled receivers shouldn't count -- they're inert in the daemon.
//   2. Transmit-only receivers (today: BILUSOCN_433_TX_ONLY) physically
//      cannot report status back over the radio, so they have no
//      meaningful "connected", "loaded", "continuity" or "ready" state.
//      Counting them against those metrics produces a permanently red
//      bar that misleads the operator.

// Currently the only one-way type. Kept as a list for future expansion;
// `isTxOnlyReceiverType` also matches anything ending in `_TX_ONLY` so
// new transmitter-only protocols slot in for free.
const TX_ONLY_TYPES = new Set(["BILUSOCN_433_TX_ONLY"]);

export function isTxOnlyReceiverType(type) {
  if (!type || typeof type !== "string") return false;
  if (TX_ONLY_TYPES.has(type)) return true;
  return type.endsWith("_TX_ONLY");
}

/**
 * Whether a receiver should be counted in receiver-status metrics
 * (connected / loaded / ready / continuity). Excludes disabled rows and
 * one-way receiver types.
 *
 * `receiver.enabled` may be `undefined` on objects coming from the live
 * daemon snapshot (the daemon only emits enabled rows in the first
 * place); we treat undefined as enabled for that reason.
 */
export function isPollableReceiver(receiver) {
  if (!receiver) return false;
  if (receiver.enabled === false) return false;
  if (isTxOnlyReceiverType(receiver.type)) return false;
  return true;
}
