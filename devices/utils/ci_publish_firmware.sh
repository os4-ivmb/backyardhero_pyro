#!/usr/bin/env bash
# ci_publish_firmware.sh -- stage one device's freshly-built firmware and push
# it to the download/firmware tree on the static host.
#
# This is the CI counterpart of ownerutils/deploy_*_firmware. It assumes the
# four per-version bins already exist under devices/os4_<device>/bin/ (produced
# by build_receiver.sh / build_dongle.sh in an earlier workflow step). It:
#
#   1. Stages firmware/<device>/{the 4 bins, latest.json} plus an aggregate
#      firmware/manifest.json, under a tree rooted at the download/ folder.
#   2. Fetches the currently-published manifest.json over public HTTPS and merges
#      this device into it (so the *other* device's entry survives) -- nothing is
#      read back over SSH, which lets the deploy key stay write-only.
#   3. Hands the staged tree to scoped_download_rsync.sh, which uploads it.
#
# SCOPING: the deploy key on the host is locked, via an authorized_keys forced
# command, to `rrsync -wo <.../download>` -- it can only *upload* into the
# download folder and nowhere else on the box. The staging tree's top-level
# `firmware/` dir lands at download/firmware/. We never delete, so old versions
# and the sibling device's files survive. See ownerutils/FIRMWARE_RELEASE.md.
#
# Required env:
#   DEVICE              receiver | dongle
#   VERSION             FW_VERSION just built (e.g. 26)
#   REMOTE_HOST         static host (scratchy)
#   REMOTE_USER         ssh user that owns the scoped key
# Optional env:
#   DOWNLOAD_BASE_URL   default https://backyard-hero.com/download/firmware
#   REMOTE_PORT         default 22
#   REMOTE_SSH_KEY      default $HOME/.ssh/id_ed25519
#   DRY_RUN             1 to rsync --dry-run (no changes pushed)
set -euo pipefail

DEVICE="${DEVICE:?set DEVICE=receiver|dongle}"
VERSION="${VERSION:?set VERSION}"
DOWNLOAD_BASE_URL="${DOWNLOAD_BASE_URL:-https://backyard-hero.com/download/firmware}"

err()  { echo "[ci_publish] ERROR: $*" >&2; exit 1; }
info() { echo "[ci_publish] $*"; }

case "${DEVICE}" in
  receiver) prefix="os4_receiver" ;;
  dongle)   prefix="os4_dongle" ;;
  *) err "DEVICE must be receiver|dongle, got '${DEVICE}'" ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BIN_DIR="${REPO_ROOT}/devices/os4_${DEVICE}/bin"
RSYNC_HELPER="${REPO_ROOT}/.github/scripts/scoped_download_rsync.sh"
base="${DOWNLOAD_BASE_URL%/}"
link="${base}/${DEVICE}/${prefix}_v${VERSION}.bin"

# ---- stage (tree rooted at the download/ folder) -------------------------
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
pub="${work}/pub"
fwdir="${pub}/firmware/${DEVICE}"
mkdir -p "${fwdir}"

for suffix in .bin .bootloader.bin .partitions.bin .boot_app0.bin; do
  f="${BIN_DIR}/${prefix}_v${VERSION}${suffix}"
  [[ -f "${f}" ]] || err "missing built artifact: ${f} (did the build step run?)"
  cp "${f}" "${fwdir}/"
done

# Per-device latest.json -- the contract the app reads (matches write_latest_manifest).
cat > "${fwdir}/latest.json" <<JSON
{
    "version": "${VERSION}",
    "link": "${link}"
}
JSON

# Aggregate manifest.json kept in the firmware root. Merge into whatever is
# currently published so we don't clobber the sibling device.
curl -fsS "${base}/manifest.json" -o "${work}/current.json" 2>/dev/null \
  || echo '{}' > "${work}/current.json"

python3 - "${DEVICE}" "${VERSION}" "${link}" \
  "${work}/current.json" "${pub}/firmware/manifest.json" <<'PY'
import json
import sys
from datetime import datetime, timezone

device, version, link, src, dst = sys.argv[1:6]
try:
    with open(src) as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}

data[device] = {
    "version": int(version),
    "link": link,
    "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}

with open(dst, "w") as fh:
    json.dump(data, fh, indent=4, sort_keys=True)
    fh.write("\n")
PY

info "staged tree:"
find "${pub}" -type f | sed "s|${pub}|  download|"

# ---- publish (scoped rsync into the download/ root) ----------------------
[[ -x "${RSYNC_HELPER}" ]] || err "rsync helper not found/executable: ${RSYNC_HELPER}"
info "publishing ${DEVICE} v${VERSION}"
"${RSYNC_HELPER}" "${pub}"
