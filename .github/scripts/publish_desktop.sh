#!/usr/bin/env bash
# publish_desktop.sh -- stage the built desktop installers and push them to the
# download/desktop tree on the static host (same scoped deploy key as firmware).
#
# Assumes the electron-builder artifacts for every platform have already been
# downloaded into SRC_DIR (the build-desktop matrix uploads them; the publish
# job pulls them back with actions/download-artifact). It:
#
#   1. Collects the installer set (.dmg / .exe / .blockmap / latest*.yml) into a
#      tree rooted at the download/ folder, under desktop/.
#   2. Writes desktop/manifest.json -- { version, updated, platforms{...} } with a
#      direct download link per platform -- for the website / in-app update check.
#   3. Hands the staged tree to scoped_download_rsync.sh, which uploads it.
#
# The electron-builder latest*.yml + .blockmap files are published too, so the
# same location can later serve electron's autoUpdater feed if we wire it up.
#
# Required env:
#   SRC_DIR        dir containing the downloaded build artifacts (searched recursively)
#   REMOTE_HOST    static host
#   REMOTE_USER    ssh user that owns the scoped key
# Optional env:
#   VERSION              app version; defaults to host/desktop/package.json "version"
#   DESKTOP_BASE_URL     default https://backyard-hero.com/download/desktop
#   REMOTE_PORT          default 22
#   REMOTE_SSH_KEY       default $HOME/.ssh/id_ed25519
#   DRY_RUN              1 to rsync --dry-run
set -euo pipefail

SRC_DIR="${SRC_DIR:?set SRC_DIR=dir of downloaded installers}"
DESKTOP_BASE_URL="${DESKTOP_BASE_URL:-https://backyard-hero.com/download/desktop}"

err()  { echo "[publish_desktop] ERROR: $*" >&2; exit 1; }
info() { echo "[publish_desktop] $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RSYNC_HELPER="${SCRIPT_DIR}/scoped_download_rsync.sh"
base="${DESKTOP_BASE_URL%/}"

[[ -d "${SRC_DIR}" ]] || err "SRC_DIR not found: ${SRC_DIR}"

VERSION="${VERSION:-}"
if [[ -z "${VERSION}" ]]; then
  VERSION="$(python3 -c "import json;print(json.load(open('${REPO_ROOT}/host/desktop/package.json'))['version'])")"
fi
[[ -n "${VERSION}" ]] || err "could not determine VERSION"

# ---- stage (tree rooted at the download/ folder) -------------------------
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
pub="${work}/pub"
deskdir="${pub}/desktop"
mkdir -p "${deskdir}"

shopt -s nullglob
found=0
while IFS= read -r -d '' f; do
  cp -f "${f}" "${deskdir}/"
  found=1
done < <(find "${SRC_DIR}" -type f \
  \( -iname '*.dmg' -o -iname '*.exe' -o -iname '*.zip' -o -iname '*.blockmap' -o -iname 'latest*.yml' \) -print0)
[[ "${found}" == "1" ]] || err "no installer artifacts (.dmg/.exe/.zip/.blockmap/latest*.yml) found under ${SRC_DIR}"

# Build desktop/manifest.json by classifying the staged installer files.
python3 - "${deskdir}" "${VERSION}" "${base}" "${deskdir}/manifest.json" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone
from urllib.parse import quote

deskdir, version, base, dst = sys.argv[1:5]
base = base.rstrip("/")

platforms = {}
for name in sorted(os.listdir(deskdir)):
    lower = name.lower()
    if lower.endswith(".dmg"):
        key = "mac-arm64" if "arm64" in lower else "mac-x64"
    elif lower.endswith(".exe"):
        key = "win-x64"
    else:
        continue  # blockmaps / latest*.yml are published but not manifest entries
    path = os.path.join(deskdir, name)
    platforms[key] = {
        "file": name,
        "link": f"{base}/{quote(name)}",
        "size": os.path.getsize(path),
    }

manifest = {
    "version": version,
    "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": platforms,
}
with open(dst, "w") as fh:
    json.dump(manifest, fh, indent=4, sort_keys=True)
    fh.write("\n")
print(f"[publish_desktop] manifest v{version}: {', '.join(sorted(platforms)) or '(no installers!)'}")
PY

info "staged tree:"
find "${pub}" -type f | sed "s|${pub}|  download|"

# ---- publish (scoped rsync into the download/ root) ----------------------
[[ -x "${RSYNC_HELPER}" ]] || err "rsync helper not found/executable: ${RSYNC_HELPER}"
info "publishing desktop v${VERSION}"
"${RSYNC_HELPER}" "${pub}"
