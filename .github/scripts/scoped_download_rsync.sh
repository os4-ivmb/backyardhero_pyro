#!/usr/bin/env bash
# scoped_download_rsync.sh -- push a staging tree into the download/ area of the
# static host over a deploy key that is locked (via an authorized_keys forced
# rrsync command) to that one directory.
#
# The staging dir's top-level entries map directly onto download/, e.g.
#   <stage>/firmware/<device>/...  -> download/firmware/<device>/...
#   <stage>/desktop/...            -> download/desktop/...
#
# Because the key is pinned to the download root, the rsync destination is just
# "<user>@<host>:". We never pass --delete -- publishing is additive, so old
# versions and sibling trees (firmware vs desktop) are left untouched.
#
# Usage: scoped_download_rsync.sh <staging_dir>
# Env:
#   REMOTE_HOST, REMOTE_USER   required
#   REMOTE_PORT                 default 22
#   REMOTE_SSH_KEY             default $HOME/.ssh/id_ed25519
#   DRY_RUN                    1 -> rsync --dry-run (no changes pushed)
set -euo pipefail

stage="${1:?usage: scoped_download_rsync.sh <staging_dir>}"
REMOTE_HOST="${REMOTE_HOST:?set REMOTE_HOST}"
REMOTE_USER="${REMOTE_USER:?set REMOTE_USER}"
REMOTE_PORT="${REMOTE_PORT:-22}"
REMOTE_SSH_KEY="${REMOTE_SSH_KEY:-${HOME}/.ssh/id_ed25519}"
DRY_RUN="${DRY_RUN:-0}"

[[ -d "${stage}" ]] || { echo "[publish] ERROR: staging dir not found: ${stage}" >&2; exit 1; }
[[ -f "${REMOTE_SSH_KEY}" ]] || { echo "[publish] ERROR: ssh key not found: ${REMOTE_SSH_KEY}" >&2; exit 1; }

opts=(
  -rlz
  --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r
  --omit-dir-times
  -e "ssh -i ${REMOTE_SSH_KEY} -p ${REMOTE_PORT} -o StrictHostKeyChecking=yes"
)
[[ "${DRY_RUN}" == "1" ]] && opts+=(--dry-run -v)

count="$(cd "${stage}" && find . -type f | wc -l | tr -d ' ')"
echo "[publish] rsync ${count} file(s) -> ${REMOTE_USER}@${REMOTE_HOST} (download root)"
rsync "${opts[@]}" "${stage}/" "${REMOTE_USER}@${REMOTE_HOST}:"
echo "[publish] done."
