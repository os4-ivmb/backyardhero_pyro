#!/usr/bin/env bash
# build_and_push_docker.sh -- build and push the Backyard Hero host image
# to Docker Hub at os4ivmb/backyardhero.
#
# Default behavior:
#   - Builds a multi-arch (linux/amd64,linux/arm64) image with `docker buildx`.
#   - Tags it as both :latest and :<host_version> from systemcfg.json.
#   - Pushes both tags to docker.io/os4ivmb/backyardhero.
#
# Common usage:
#   ./build_and_push_docker.sh                 # build + push :latest and :<version>
#   ./build_and_push_docker.sh --no-push       # build only, don't push
#   ./build_and_push_docker.sh --tag rc1       # add an extra :rc1 tag
#   ./build_and_push_docker.sh --single-arch   # build only for the host arch
#   ./build_and_push_docker.sh --image my/img  # push to a different repo
#
# Prereqs:
#   - Docker Desktop (or docker engine + buildx plugin)
#   - `docker login` already done for the target Docker Hub account
#     (the default account is `os4ivmb`; override with --image)

set -euo pipefail

# The Dockerfile, the build context (byh_app/, pythings/, tcp_serial_bridge/,
# supervisord*.conf, ...) and config/systemcfg.json all live in host/.
# This script lives one level deeper at host/run/osx/, so resolve up two
# levels and run docker buildx from there. Same pattern as start.sh.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${HOST_DIR}"

IMAGE="os4ivmb/backyardhero"
PLATFORMS="linux/amd64,linux/arm64"
PUSH=1
EXTRA_TAGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)        IMAGE="$2"; shift 2 ;;
    --no-push)      PUSH=0;     shift   ;;
    --single-arch)  PLATFORMS="" ; shift ;;
    --platforms)    PLATFORMS="$2"; shift 2 ;;
    --tag)          EXTRA_TAGS+=("$2"); shift 2 ;;
    -h|--help)
      sed -n '2,25p' "$0"; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Pull the host_version field out of systemcfg.json without bringing in jq.
VERSION="$(awk -F'[ :,]+' '/"host_version"/ {print $3; exit}' \
  config/systemcfg.json | tr -d '"')"
if [[ -z "${VERSION}" ]]; then
  echo "[build] WARNING: could not parse host_version from config/systemcfg.json"
  VERSION="dev"
fi

# Normalize to a docker-tag-friendly string (no dots required, but be safe).
VERSION_TAG="v${VERSION}"
echo "[build] image:    ${IMAGE}"
echo "[build] version:  ${VERSION_TAG}"
echo "[build] platforms: ${PLATFORMS:-host-native}"

TAG_ARGS=( -t "${IMAGE}:latest" -t "${IMAGE}:${VERSION_TAG}" )
if [[ ${#EXTRA_TAGS[@]} -gt 0 ]]; then
  for t in "${EXTRA_TAGS[@]}"; do
    TAG_ARGS+=( -t "${IMAGE}:${t}" )
  done
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[build] ERROR: docker not found in PATH." >&2
  exit 1
fi

# Make sure a buildx builder exists. Use the default docker-container driver
# so we get multi-arch + a writable cache. This is idempotent.
if [[ -n "${PLATFORMS}" ]]; then
  if ! docker buildx inspect byh-builder >/dev/null 2>&1; then
    echo "[build] creating buildx builder 'byh-builder'..."
    docker buildx create --name byh-builder --use >/dev/null
  else
    docker buildx use byh-builder >/dev/null
  fi
  docker buildx inspect --bootstrap >/dev/null
fi

if [[ -n "${PLATFORMS}" ]]; then
  if [[ "${PUSH}" -eq 1 ]]; then
    echo "[build] building + pushing multi-arch..."
    docker buildx build \
      --platform "${PLATFORMS}" \
      "${TAG_ARGS[@]}" \
      --push \
      .
  else
    # Multi-arch images cannot live in the local docker daemon (the manifest
    # list has no concept of a single-arch local image). Fall back to the
    # host architecture for --no-push.
    echo "[build] --no-push set; building for host arch only and loading locally."
    docker buildx build \
      "${TAG_ARGS[@]}" \
      --load \
      .
  fi
else
  if [[ "${PUSH}" -eq 1 ]]; then
    echo "[build] building + pushing single-arch (host)..."
    docker buildx build "${TAG_ARGS[@]}" --push .
  else
    echo "[build] building single-arch (host) into local docker..."
    docker buildx build "${TAG_ARGS[@]}" --load .
  fi
fi

echo "[build] done."
if [[ "${PUSH}" -eq 1 ]]; then
  echo "[build] pushed:"
  echo "          ${IMAGE}:latest"
  echo "          ${IMAGE}:${VERSION_TAG}"
  if [[ ${#EXTRA_TAGS[@]} -gt 0 ]]; then
    for t in "${EXTRA_TAGS[@]}"; do echo "          ${IMAGE}:${t}"; done
  fi
fi
