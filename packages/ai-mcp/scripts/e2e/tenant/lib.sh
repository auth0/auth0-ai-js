#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2016
# Shared helpers for setup.sh and teardown.sh. Sourced, not run.
#
# Every object these scripts create carries the name prefix below. Setup records the id of each
# object it creates in a state file keyed by tenant domain; teardown deletes exactly those ids.

PREFIX="ai-mcp-e2e"
CONNECTION_NAME="${PREFIX}-users"
CIMD_URL="https://claude.ai/oauth/claude-code-client-metadata"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# packages/ai-mcp
PKG_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
STATE_FILE="${E2E_TENANT_STATE_FILE:-${PKG_DIR}/.env.e2e.state.json}"

DRY_RUN=0
ASSUME_YES=0
ADOPT=0

# Names of the scopes the script needs on the Auth0 CLI session are collected here while the script
# runs (one line per Management API call), so the login command always matches the calls made.
SCOPE_LOG="${SCOPE_LOG:-}"

say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"; }

confirm() {
  # confirm "question" -> returns 0 when the user typed yes (or --yes was given)
  [ "$ASSUME_YES" -eq 1 ] && return 0
  local answer
  printf '%s [y/N] ' "$1"
  read -r answer || answer=""
  case "$answer" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# --- scope bookkeeping ------------------------------------------------------------------------------

# scope_for METHOD PATH -> prints the Management API scopes that call needs, one per line.
scope_for() {
  local method path seg rest
  method="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  path="${2%%\?*}"
  seg="${path%%/*}"
  rest="${path#*/}"
  [ "$seg" = "$path" ] && rest=""
  local verb=""
  case "$method" in
    get) verb="read" ;;
    post) verb="create" ;;
    patch | put) verb="update" ;;
    delete) verb="delete" ;;
  esac
  case "$seg" in
    clients)
      printf '%s:clients\n' "$verb"
      case "$2" in *client_secret*) printf 'read:client_keys\n' ;; esac
      ;;
    client-grants) printf '%s:client_grants\n' "$verb" ;;
    resource-servers) printf '%s:resource_servers\n' "$verb" ;;
    connections) printf '%s:connections\n' "$verb" ;;
    users | users-by-email) printf '%s:users\n' "$verb" ;;
    organizations)
      case "$rest" in
        */members*) printf '%s:organization_members\n' "$verb" ;;
        */enabled_connections*) printf '%s:organization_connections\n' "$verb" ;;
        *) printf '%s:organizations\n' "$verb" ;;
      esac
      ;;
    tenants) printf 'read:tenant_settings\n' ;;
  esac
}

track_scope() {
  [ -n "$SCOPE_LOG" ] || return 0
  scope_for "$1" "$2" >>"$SCOPE_LOG"
}

# teardown_scopes: the scopes teardown.sh needs, added to the setup list so one login covers both.
teardown_scopes() {
  local p
  for p in clients client-grants resource-servers connections users organizations; do
    track_scope GET "$p"
    track_scope DELETE "$p/x"
  done
  track_scope GET "clients/x?fields=client_secret"
}

# login_scopes_csv: the sorted, de-duplicated scopes collected in SCOPE_LOG, comma separated.
login_scopes_csv() {
  [ -s "$SCOPE_LOG" ] || return 0
  sort -u "$SCOPE_LOG" | paste -sd, -
}

# --- Management API wrapper -------------------------------------------------------------------------

# api METHOD PATH [JSON]
# Calls the Management API through the Auth0 CLI. In dry-run mode it prints the call and returns an
# empty result (or a placeholder object for writes) and never starts the CLI. A request body is piped
# to the CLI on stdin, never put on the command line, because arguments are visible in `ps`.
api() {
  local method="$1" path="$2" body="${3:-}"
  local lower
  lower="$(printf '%s' "$method" | tr '[:upper:]' '[:lower:]')"
  track_scope "$lower" "$path"
  if [ "$DRY_RUN" -eq 1 ]; then
    if [ -n "$body" ]; then
      printf 'DRY-RUN  auth0 api %s "%s" <body on stdin> %s\n' "$lower" "$path" \
        "$(printf '%s' "$body" | jq -c 'if type == "object" and has("password") then .password = "<generated>" else . end')" >&2
    else
      printf 'DRY-RUN  auth0 api %s "%s"\n' "$lower" "$path" >&2
    fi
    case "$lower" in
      get) printf '[]' ;;
      *) printf '{"id":"DRYRUN_ID","client_id":"DRYRUN_CLIENT_ID","user_id":"DRYRUN_USER_ID"}' ;;
    esac
    return 0
  fi
  # The Auth0 CLI exits 0 even when the Management API answers with an error and prints the error
  # object instead. Treat that object as a failure so callers can stop on it.
  local out rc=0 force=()
  if [ "$lower" = delete ]; then force=(--force); fi
  if [ -n "$body" ]; then
    out="$(printf '%s' "$body" | auth0 api "$lower" "$path" ${force[@]+"${force[@]}"})" || rc=$?
  else
    # </dev/null: the CLI reads a piped body from stdin and must not swallow a caller's loop input.
    out="$(auth0 api "$lower" "$path" ${force[@]+"${force[@]}"} </dev/null)" || rc=$?
  fi
  [ "$rc" -eq 0 ] || return "$rc"
  if printf '%s' "$out" | jq -e 'type == "object" and ((.statusCode? // 0) >= 400)' >/dev/null 2>&1; then
    printf 'auth0 api %s %s failed: %s\n' "$lower" "${path%%\?*}" \
      "$(printf '%s' "$out" | jq -r '"HTTP \(.statusCode) \(.errorCode // .error // "error"): \(.message // "")"')" >&2
    if printf '%s' "$out" | jq -e '(.statusCode == 403) or ((.message // "") | test("scope"; "i"))' >/dev/null 2>&1; then
      printf 'Hint: the CLI session may lack a scope. Print the login command with: %s --print-login-command\n' "${SELF_NAME:-setup.sh}" >&2
    fi
    return 1
  fi
  printf '%s' "$out"
}

# list_all PATH -> JSON array with every page of a list endpoint (page size 50, the smallest cap
# among the endpoints used here).
LIST_PAGE_SIZE=50
list_all() {
  local path="$1" sep='?' page=0 out='[]' chunk n
  case "$path" in *\?*) sep='&' ;; esac
  while [ "$page" -lt 400 ]; do
    chunk="$(api GET "${path}${sep}per_page=${LIST_PAGE_SIZE}&page=${page}")" || return 1
    chunk="$(printf '%s' "$chunk" | jq -c 'if type == "array" then . else [] end')"
    n="$(printf '%s' "$chunk" | jq 'length')"
    out="$(jq -cs 'add' <(printf '%s' "$out") <(printf '%s' "$chunk"))"
    [ "$n" -lt "$LIST_PAGE_SIZE" ] && break
    page=$((page + 1))
  done
  printf '%s' "$out"
}

# --- state file: ids created by setup, read by teardown ---------------------------------------------
# Shape: {"tenants": {"<domain>": {"created": {"<kind>": [{"id": "...", "name": "..."}]}}}}
# Teardown deletes exactly the recorded ids, and only for the tenant it is pointed at. The file holds
# ids and names only, never a secret.

STATE_DOMAIN="" # set by the caller once the target tenant is known

# state_validate: stop with a clear error when the state file exists but is not usable. Call it in the
# main shell (a die inside $( ) would only end the subshell).
state_validate() {
  [ -f "$STATE_FILE" ] || return 0
  jq -e '(.tenants | type == "object") and ([.tenants[] | .created | to_entries[] | .value[] | (.id | type == "string") and (.name | type == "string")] | all)' \
    "$STATE_FILE" >/dev/null 2>&1 \
    || die "${STATE_FILE} is not valid JSON or does not have the expected structure. Nothing was changed. Fix or delete the file, then run again."
}

state_init() {
  state_validate
  [ -f "$STATE_FILE" ] || printf '{"tenants":{}}\n' >"$STATE_FILE"
  chmod 600 "$STATE_FILE"
}

_state_write() {
  # _state_write JQ_FILTER [jq args...]: rewrite the state file through a private temp file.
  local filter="$1" tmp
  shift
  state_validate
  tmp="$(mktemp "${STATE_FILE}.XXXXXX")"
  if jq "$@" "$filter" "$STATE_FILE" >"$tmp"; then
    chmod 600 "$tmp"
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    return 1
  fi
}

# state_add KIND ID NAME
state_add() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  [ -n "$STATE_DOMAIN" ] || die "internal: STATE_DOMAIN not set"
  state_init
  _state_write '.tenants[$d].created[$k] = ((.tenants[$d].created[$k] // []) | map(select(.id != $id)) + [{id: $id, name: $n}])' \
    --arg d "$STATE_DOMAIN" --arg k "$1" --arg id "$2" --arg n "$3"
}

# state_has KIND ID -> success when setup recorded that id for the current tenant
state_has() {
  [ -f "$STATE_FILE" ] || return 1
  jq -e --arg d "$STATE_DOMAIN" --arg k "$1" --arg id "$2" \
    '[.tenants[$d].created[$k][]? | select(.id == $id)] | length > 0' "$STATE_FILE" >/dev/null 2>&1
}

# state_list KIND -> "id<TAB>name" lines recorded for the current tenant
state_list() {
  [ -f "$STATE_FILE" ] || return 0
  jq -r --arg d "$STATE_DOMAIN" --arg k "$1" '.tenants[$d].created[$k][]? | [.id, .name] | @tsv' "$STATE_FILE"
}

# state_remove KIND ID: forget one id after it was deleted
state_remove() {
  [ -f "$STATE_FILE" ] || return 0
  _state_write '.tenants[$d].created[$k] |= map(select(.id != $id))' --arg d "$STATE_DOMAIN" --arg k "$1" --arg id "$2"
}

# state_prune: drop empty kinds and empty tenants; delete the file when nothing is left
state_prune() {
  [ -f "$STATE_FILE" ] || return 0
  _state_write '.tenants |= (with_entries(.value.created |= with_entries(select(.value | length > 0))) | with_entries(select(.value.created | length > 0)))'
  if jq -e '.tenants | length == 0' "$STATE_FILE" >/dev/null; then rm -f "$STATE_FILE"; fi
}

# can_modify KIND ID -> success when the script may change the object: it recorded it. In a dry run an
# object that would be adopted counts as modifiable so the printed plan is complete.
can_modify() {
  state_has "$1" "$2" && return 0
  [ "$DRY_RUN" -eq 1 ] && [ "$ADOPT" -eq 1 ] && return 0
  return 1
}

# --- active tenant ----------------------------------------------------------------------------------

active_tenant() {
  auth0 tenants list --json 2>/dev/null | jq -r '[.[] | select(.active) | .name] | first // empty'
}

# --- shared by setup and teardown -------------------------------------------------------------------

# A recorded id goes into a URL path, so it must look like an Auth0 id and nothing else. This blocks a
# tampered state file from pointing a delete at another endpoint (for example "../resource-servers/x").
valid_id() {
  case "$1" in
    "" | -* | *..* | */* | *[!A-Za-z0-9_\|.-]*) return 1 ;;
  esac
  return 0
}

path_for() {
  case "$1" in
    grants) printf 'client-grants' ;;
    users) printf 'users' ;;
    clients) printf 'clients' ;;
    organizations) printf 'organizations' ;;
    connections) printf 'connections' ;;
    apis) printf 'resource-servers' ;;
  esac
}

# verify_object KIND ID NAME -> sets VERIFY to "ok", "gone" or a mismatch reason. Before deleting, the
# live object is fetched and its name (or email) must equal what setup recorded.
VERIFY=""
verify_object() {
  local k="$1" id="$2" name="$3" out rc=0 actual
  VERIFY=""
  if [ "$k" = grants ]; then
    # Grants cannot be fetched by id. Find it in the list; its client must be one this state recorded.
    out="$(list_all "client-grants")" || { VERIFY="could not list client grants"; return 0; }
    actual="$(printf '%s' "$out" | jq -r --arg i "$id" '[.[] | select(.id == $i) | .client_id] | first // empty')"
    if [ -z "$actual" ]; then VERIFY=gone; return 0; fi
    # A grant is ours to delete when its client is one setup created or one it only referenced (kind
    # "refs": existing clients that get grants but are never modified or deleted).
    if [ "$(jq -r --arg d "$STATE_DOMAIN" --arg c "$actual" '[.tenants[$d].created | ((.clients // []) + (.refs // []))[] | select(.id == $c)] | length' "$STATE_FILE")" -gt 0 ]; then
      VERIFY=ok
    else
      VERIFY="grant belongs to client ${actual}, which setup did not record"
    fi
    return 0
  fi
  out="$(api GET "$(path_for "$k")/${id}" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    if printf '%s' "$out" | grep -q 'HTTP 404'; then VERIFY=gone; else VERIFY="could not read it: ${out}"; fi
    return 0
  fi
  case "$k" in
    users) actual="$(printf '%s' "$out" | jq -r '.email // "" | ascii_downcase')"; name="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" ;;
    *) actual="$(printf '%s' "$out" | jq -r '.name // ""')" ;;
  esac
  if [ "$actual" = "$name" ]; then VERIFY=ok; else VERIFY="live object is called \"${actual}\", state recorded \"${name}\""; fi
}

# --- tenant settings (read only) --------------------------------------------------------------------
# Only a GET of tenants/settings is ever made; no tenant setting is ever written.
#   CIMD_SETTING     client_id_metadata_document_supported must be true
#   PROFILE_SETTING  resource_parameter_profile must be "compatibility"
#   ISS_SETTING      "Include issuer in authorization responses" (authorization_response_iss_parameter_supported)
# Each is on, off or unknown. unknown means the tenant settings payload did not show the key; callers must
# not guess.
CIMD_SETTING="unknown"
PROFILE_SETTING="unknown"
PROFILE_VALUE=""
ISS_SETTING="unknown"
SETTINGS_NOTE=""
read_tenant_settings() {
  local out rc=0
  CIMD_SETTING="unknown"; PROFILE_SETTING="unknown"; PROFILE_VALUE=""; ISS_SETTING="unknown"; SETTINGS_NOTE=""
  out="$(api GET "tenants/settings" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    SETTINGS_NOTE="tenant settings could not be read (needs read:tenant_settings)"
    return 0
  fi
  CIMD_SETTING="$(printf '%s' "$out" | jq -r '
    ([.. | objects | select(has("client_id_metadata_document_supported")) | .client_id_metadata_document_supported | select(type == "boolean")] | first) as $x
    | if $x == true then "on" elif $x == false then "off" else "unknown" end' 2>/dev/null)" || CIMD_SETTING="unknown"
  PROFILE_VALUE="$(printf '%s' "$out" | jq -r '[.. | objects | select(has("resource_parameter_profile")) | .resource_parameter_profile | strings] | first // ""' 2>/dev/null)" || PROFILE_VALUE=""
  case "$PROFILE_VALUE" in
    compatibility) PROFILE_SETTING="on" ;;
    audience) PROFILE_SETTING="off" ;;
  esac
  ISS_SETTING="$(printf '%s' "$out" | jq -r '
    ([.. | objects | to_entries[] | select(.key | test("iss_parameter|issuer_in_auth")) | .value | select(type == "boolean")] | first) as $x
    | if $x == true then "on" elif $x == false then "off" else "unknown" end' 2>/dev/null)" || ISS_SETTING="unknown"
  [ -n "$CIMD_SETTING" ] || CIMD_SETTING="unknown"
  [ -n "$ISS_SETTING" ] || ISS_SETTING="unknown"
}

settings_lines() {
  printf '  S1 Resource Parameter Compatibility Profile: %s%s\n' "$PROFILE_SETTING" "${PROFILE_VALUE:+ (value: ${PROFILE_VALUE})}"
  printf '  S2 Client ID Metadata Document Registration: %s\n' "$CIMD_SETTING"
  printf '  S3 On-behalf-of internal flag: not readable through the Management API (the runner preflight probes it)\n'
  printf '  S4 Include issuer in authorization responses: %s\n' "$ISS_SETTING"
}
