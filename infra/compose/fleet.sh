#!/usr/bin/env bash
# Update or inspect a list of published-image instances over SSH, one after another.
#
#   ./fleet.sh update <image tag> [--dry-run]   stops at the first instance that fails
#   ./fleet.sh versions                         image tag and revision per instance
#
# The list is a private file outside the repository (default ~/.config/anviq/fleet, or
# ANVIQ_FLEET_FILE). One instance per line: <name> <ssh target> [<instance directory>].
# See fleet.example for the format.
set -Eeuo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
list="${ANVIQ_FLEET_FILE:-${HOME}/.config/anviq/fleet}"
[[ -f "${list}" ]] || { echo "No instance list at ${list}" >&2; exit 1; }

instances() { sed -e 's/#.*//' "${list}" | awk 'NF >= 2'; }

each() {
  local action="$1" tag="${2:-}" flag="${3:-}" name target dir done=0 total
  total="$(instances | wc -l)"
  (( total > 0 )) || { echo "${list} lists no instances" >&2; exit 1; }
  while read -r name target dir; do
    dir="${dir:-/opt/anviq}"
    echo "== ${name}"
    if ! "${action}" "${target}" "${dir}" "${tag}" "${flag}" </dev/null; then
      echo "Stopped at ${name}; ${done} of ${total} done" >&2
      exit 1
    fi
    done=$((done + 1))
  done < <(instances)
  echo "Done: ${done} of ${total}"
}

update() {
  local target="$1" dir="$2" tag="$3" flag="$4" remote
  remote="/tmp/anviq-update-instance.$$"
  scp -q "${here}/update-instance.sh" "${target}:${remote}"
  ssh -n "${target}" "ANVIQ_DIR=$(printf %q "${dir}") bash ${remote} ${tag} ${flag}; code=\$?; rm -f ${remote}; exit \$code"
}

version() {
  local target="$1" dir="$2"
  ssh -n "${target}" "cd $(printf %q "${dir}") && printf '%s ' \"\$(sed -n 's/^ANVIQ_IMAGE_TAG=//p' .env | tail -n 1)\" && docker inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' \"\$(docker compose --env-file .env -f docker-compose.images.yml ps -q api)\""
}

case "${1:-}" in
  update)
    [[ -n "${2:-}" && ( -z "${3:-}" || "${3}" == --dry-run ) ]] || { echo "Usage: $0 update <image tag> [--dry-run]" >&2; exit 1; }
    each update "$2" "${3:-}" ;;
  versions) each version ;;
  *) echo "Usage: $0 update <image tag> [--dry-run] | versions" >&2; exit 1 ;;
esac
