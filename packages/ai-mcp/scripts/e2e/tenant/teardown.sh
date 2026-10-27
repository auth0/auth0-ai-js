#!/usr/bin/env bash
# shellcheck disable=SC2016
# Deletes the tenant objects setup.sh created. It deletes exactly the ids that setup recorded for the
# active tenant in the state file, and only after a live read confirms each object still carries the
# name that was recorded. It never touches other connections, users, applications, APIs or settings,
# and it refuses an id it did not record.
#
#   teardown.sh --dry-run    print what it would delete, call nothing
#   teardown.sh --list       list the recorded objects, delete nothing
#   teardown.sh              show the list, ask for confirmation, delete
#   teardown.sh --yes        skip the confirmation (for scripts)
#
# Objects setup only referenced (the Claude Code client, an existing M2M client) are kept in the state
# file under "refs" so their grants can be removed; the objects themselves are never deleted.
# If any delete fails, the state file is kept (minus what was deleted) so you can run it again.

set -euo pipefail

SELF_NAME="teardown.sh"
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DOMAIN="${AUTH0_DOMAIN:-}"
LIST_ONLY=0
TAB="$(printf '\t')"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    --list) LIST_ONLY=1 ;;
    --domain) shift; [ $# -gt 0 ] || die "--domain needs a value"; DOMAIN="$1" ;;
    --state-file) shift; [ $# -gt 0 ] || die "--state-file needs a value"; STATE_FILE="$1" ;;
    -h | --help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

need_cmd jq
state_validate

# Deletion order: grants, users, applications, organizations, connections, APIs.
KINDS="grants users clients organizations connections apis"

if [ "$DRY_RUN" -eq 1 ]; then
  say "Dry run: no Auth0 CLI calls, no changes."
  if [ ! -f "$STATE_FILE" ]; then
    say "No state file: nothing recorded, so a real run would delete nothing."
    exit 0
  fi
  say "Recorded objects (a real run deletes the ones for the active tenant, never kind refs):"
  jq -r --arg d "$DOMAIN" '.tenants | to_entries[] | select($d == "" or .key == $d) | .key as $t | .value.created | to_entries[] | select(.key != "refs") | .key as $k | .value[] | "  \($t)  DELETE \($k)  \(.name)  (\(.id))"' "$STATE_FILE"
  exit 0
fi

need_cmd auth0
ACTIVE="$(active_tenant)"
[ -n "$ACTIVE" ] || die "The Auth0 CLI has no active tenant."
[ -z "$DOMAIN" ] || [ "$DOMAIN" = "$ACTIVE" ] || die "Active CLI tenant is ${ACTIVE} but ${DOMAIN} was requested. Switch with: auth0 tenants use ${DOMAIN}"
STATE_DOMAIN="$ACTIVE"
say "Tenant: ${ACTIVE}"

# The work list: lines of "kind<TAB>id<TAB>name".
WORK=""
SKIPPED=0
add_work() { WORK="${WORK}${1}${TAB}${2}${TAB}${3}
"; }

for K in $KINDS; do
  while IFS="$TAB" read -r ID NAME; do
    if [ -z "$ID" ]; then continue; fi
    if valid_id "$ID"; then add_work "$K" "$ID" "$NAME"; else
      warn "skipping recorded ${K} id with unexpected characters: ${ID}"
      SKIPPED=$((SKIPPED + 1))
    fi
  done <<LIST
$(state_list "$K")
LIST
done
if [ -z "$WORK" ] && [ "$SKIPPED" -gt 0 ]; then
  die "Every recorded id was rejected as malformed. Check ${STATE_FILE}. Nothing was deleted."
fi
if [ -z "$WORK" ]; then
  say "Nothing recorded for ${ACTIVE} in ${STATE_FILE}, so there is nothing to delete."
  exit 0
fi

TOTAL="$(printf '%s' "$WORK" | grep -c . || true)"
if [ "$LIST_ONLY" -eq 1 ]; then say "Objects listed for ${ACTIVE}:"; else say "These ${TOTAL} objects will be deleted from ${ACTIVE}:"; fi
printf '%s' "$WORK" | while IFS="$TAB" read -r K ID NAME; do
  if [ -n "$ID" ]; then printf '  %-14s %s  (%s)\n' "$K" "$NAME" "$ID"; fi
done
say ""
if [ "$LIST_ONLY" -eq 1 ]; then
  say "List only: nothing was deleted."
  exit 0
fi
confirm "Delete these ${TOTAL} objects from ${ACTIVE}? This cannot be undone." || die "Cancelled. Nothing was deleted."

FAILED=0
for K in $KINDS; do
  while IFS="$TAB" read -r WK ID NAME; do
    [ "$WK" = "$K" ] || continue
    verify_object "$K" "$ID" "$NAME"
    if [ "$VERIFY" = gone ]; then
      say "   gone     ${NAME} (already deleted)"
      state_remove "$K" "$ID"
      continue
    elif [ "$VERIFY" != ok ]; then
      warn "NOT deleting ${NAME} (${ID}): ${VERIFY}"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
    ERR=""
    RC=0
    ERR="$(api DELETE "$(path_for "$K")/${ID}" 2>&1 >/dev/null)" || RC=$?
    if [ "$RC" -eq 0 ]; then
      say "   deleted  ${NAME}"
      state_remove "$K" "$ID"
    elif printf '%s' "$ERR" | grep -q 'HTTP 404'; then
      say "   gone     ${NAME} (already deleted)"
      state_remove "$K" "$ID"
    else
      warn "could not delete ${NAME} (${ID}): ${ERR}"
      FAILED=$((FAILED + 1))
    fi
  done <<LIST
$WORK
LIST
done

say ""
if [ "$FAILED" -gt 0 ] || [ "$SKIPPED" -gt 0 ]; then
  warn "${FAILED} delete(s) failed and ${SKIPPED} object(s) were skipped. The state file still lists the failed ones; fix the cause and run this again. Skipped objects were left untouched."
  exit 1
fi
# Referenced objects were never deleted; drop their records now that no grant of ours remains.
if jq -e --arg d "$STATE_DOMAIN" '[.tenants[$d].created | to_entries[] | select(.key != "refs") | .value[]] | length == 0' "$STATE_FILE" >/dev/null 2>&1; then
  _state_write 'del(.tenants[$d].created.refs)' --arg d "$STATE_DOMAIN"
fi
state_prune
say "Done. The env file still holds the old values; delete it if you no longer need it."
