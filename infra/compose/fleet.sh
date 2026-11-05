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

# The Compose file that ships with a release: the one at the commit a sha-<commit> tag names, or
# this checkout's copy for any other tag.
compose_for() {
  local tag="$1" out="$2"
  if [[ "${tag}" =~ ^sha-([0-9a-f]{7,40})$ ]]; then
    git -C "${here}" show "${BASH_REMATCH[1]}:infra/compose/docker-compose.images.yml" >"${out}" 2>/dev/null ||
      { echo "Commit ${BASH_REMATCH[1]} is not in this checkout; run git fetch" >&2; return 1; }
  else
    cp "${here}/docker-compose.images.yml" "${out}"
  fi
}

update() {
  local target="$1" dir="$2" tag="$3" flag="$4" remote compose
  remote="/tmp/anviq-update-instance.$$"
  compose="$(mktemp)"
  compose_for "${tag}" "${compose}" || { rm -f "${compose}"; return 1; }
  scp -q "${here}/update-instance.sh" "${target}:${remote}"
  scp -q "${compose}" "${target}:${remote}.yml"
  rm -f "${compose}"
  ssh -n "${target}" "ANVIQ_DIR=$(printf %q "${dir}") ANVIQ_COMPOSE_FILE=${remote}.yml bash ${remote} ${tag} ${flag}; code=\$?; rm -f ${remote} ${remote}.yml; exit \$code"
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
