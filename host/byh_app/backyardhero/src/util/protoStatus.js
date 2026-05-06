// Human labels for the daemon's proto-handler state machine.
//
// `proto_handler_status` is emitted as raw enum strings (STANDBY,
// LOADING, LOADED, START_PENDING, START_CONFIRMED, STARTED, ABORTED).
// Showing those raw to the operator is unfriendly and mid-show is
// exactly when friendly matters most.
//
// `badge` is the short compact label suitable for a status chip.
// `label` is the prose label used in hints and the show-details card.
//
// Anything that doesn't match the map falls through to a humanised
// version of the raw token (Title Case with spaces) rather than ALL_CAPS.

const MAP = {
  STANDBY: {
    badge: "Standby",
    label: "System idle. No show is loaded.",
  },
  LOADING: {
    badge: "Loading",
    label: "Sending cue timings to receivers.",
  },
  LOADED: {
    badge: "Loaded",
    label: "Show loaded. Press the green START on the box when ready.",
  },
  START_PENDING: {
    badge: "Receivers syncing",
    label: "Waiting for receivers to agree on start time.",
  },
  START_CONFIRMED: {
    badge: "Counting down",
    label: "All receivers ready. Counting down.",
  },
  STARTED: {
    badge: "Running",
    label: "Show is running.",
  },
  STOPPED: {
    badge: "Finished",
    label: "Show finished.",
  },
  ABORTED: {
    badge: "Aborted",
    label: "Show was aborted (manual stop or error).",
  },
};

function humanise(token) {
  return String(token)
    .toLowerCase()
    .split("_")
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

export function protoStatusBadge(status) {
  if (!status) return null;
  return MAP[status]?.badge || humanise(status);
}

export function protoStatusLabel(status) {
  if (!status) return null;
  return MAP[status]?.label || humanise(status);
}
