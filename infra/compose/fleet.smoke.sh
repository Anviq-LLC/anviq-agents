#!/usr/bin/env bash
# Exercise the fleet script with stub ssh and scp, without hosts or Docker.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
mkdir -p "$scratch/bin"
cat > "$scratch/bin/scp" <<'FAKE'
#!/usr/bin/env bash
echo "scp $*" >> "$CALLS"
FAKE
cat > "$scratch/bin/ssh" <<'FAKE'
#!/usr/bin/env bash
echo "ssh $*" >> "$CALLS"
[[ "$2" != *broken* ]] || exit 1
echo "sha-abc123 0123456789abcdef"
FAKE
chmod +x "$scratch/bin/"*
export PATH="$scratch/bin:$PATH" CALLS="$scratch/calls"
export ANVIQ_FLEET_FILE="$scratch/fleet"
cat > "$ANVIQ_FLEET_FILE" <<'LIST'
# comment
one deploy@one.example.test
two deploy@two.example.test /srv/two
LIST

out="$(bash "$root/fleet.sh" update sha-1 --dry-run 2>&1)" || fail "dry run failed: $out"
[[ "$out" == *"Done: 2 of 2"* ]] || fail "missing summary: $out"
grep -q 'ANVIQ_DIR=/srv/two bash .* sha-1 --dry-run' "$CALLS" || fail "dry run flag or directory not passed"

out="$(bash "$root/fleet.sh" versions 2>&1)" || fail "versions failed: $out"
[[ "$out" == *"sha-abc123 0123456789abcdef"* ]] || fail "missing version: $out"

printf 'one deploy@broken.example.test\ntwo deploy@two.example.test\n' > "$ANVIQ_FLEET_FILE"
: > "$CALLS"
if out="$(bash "$root/fleet.sh" update sha-1 2>&1)"; then fail "a failing instance did not fail the run"; fi
[[ "$out" == *"Stopped at one; 0 of 2 done"* ]] || fail "missing stop message: $out"
! grep -q 'two.example.test' "$CALLS" || fail "kept going after a failure"

! bash "$root/fleet.sh" update 2>/dev/null || fail "accepted a missing tag"
echo "fleet smoke ok"
