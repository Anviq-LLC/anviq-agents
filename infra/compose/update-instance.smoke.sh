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
case "$*" in
  *"config --images"*)
    printf '%s
' "registry.example.test/app:${ANVIQ_IMAGE_TAG:-edge}"       "registry.example.test/computer:${ANVIQ_COMPUTER_IMAGE_TAG:-edge}" "postgres:16"
    ;;
  *"manifest inspect"*) [[ "${FAKE_MISSING:-0}" != 1 ]] || exit 1 ;;
esac
FAKE
chmod +x "$scratch/bin/docker"
export PATH="$scratch/bin:$PATH" CALLS="$scratch/calls" ANVIQ_DIR="$scratch/inst" ANVIQ_MIN_FREE_GB=0
printf 'ANVIQ_IMAGE_TAG=sha-old\n' > "$scratch/inst/.env"
cp "$scratch/inst/.env" "$scratch/before"

out="$(bash "$root/update-instance.sh" sha-new --dry-run 2>&1)" || fail "dry run failed: $out"
[[ "$out" == *"Now running: sha-old"* && "$out" == *"Dry run ok: would update to sha-new"* ]] || fail "unexpected output: $out"
cmp -s "$scratch/before" "$scratch/inst/.env" || fail "dry run changed .env"
! grep -qE ' (up|pull|exec) ' "$CALLS" || fail "dry run touched containers"
[[ "$out" == *"Found registry.example.test/app:sha-new"* && "$out" == *"Found registry.example.test/computer:sha-new"* ]] || fail "did not check the target images: $out"
[[ "$out" != *"postgres"* ]] || fail "checked an image this update does not move"
if out="$(FAKE_MISSING=1 bash "$root/update-instance.sh" sha-new --dry-run 2>&1)"; then fail "passed with an unreachable image"; fi
[[ "$out" == *"Cannot reach registry.example.test/app:sha-new"* ]] || fail "missing image not named: $out"
! bash "$root/update-instance.sh" 'bad tag' --dry-run 2>/dev/null || fail "accepted a bad tag"
echo "update-instance smoke ok"
