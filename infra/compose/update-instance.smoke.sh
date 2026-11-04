#!/usr/bin/env bash
# The update script's dry run must leave .env and the containers alone.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
mkdir -p "$scratch/bin" "$scratch/inst"
cat > "$scratch/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "$CALLS"
FAKE
chmod +x "$scratch/bin/docker"
export PATH="$scratch/bin:$PATH" CALLS="$scratch/calls" ANVIQ_DIR="$scratch/inst" ANVIQ_MIN_FREE_GB=0
printf 'ANVIQ_IMAGE_TAG=sha-old\n' > "$scratch/inst/.env"
cp "$scratch/inst/.env" "$scratch/before"

out="$(bash "$root/update-instance.sh" sha-new --dry-run 2>&1)" || fail "dry run failed: $out"
[[ "$out" == *"Now running: sha-old"* && "$out" == *"Dry run ok: would update to sha-new"* ]] || fail "unexpected output: $out"
cmp -s "$scratch/before" "$scratch/inst/.env" || fail "dry run changed .env"
! grep -qE ' (up|pull|exec) ' "$CALLS" || fail "dry run touched containers"
! bash "$root/update-instance.sh" 'bad tag' --dry-run 2>/dev/null || fail "accepted a bad tag"
echo "update-instance smoke ok"
