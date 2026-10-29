#!/usr/bin/env bash
# Builds the Auth0 tenant objects the @auth0/ai-mcp end-to-end suite needs, in the tenant the Auth0 CLI
# is logged in to, and writes the values to packages/ai-mcp/.env.e2e (mode 600).
#
#   setup.sh --print-login-command       print the `auth0 login --scopes ...` this run needs, then exit
#   setup.sh --dry-run [flags]           print every Management API call, change nothing, start no CLI
#   setup.sh --check-settings            read only: tenant settings S1..S4 and which objects exist
#   setup.sh --yes [flags]               create the missing objects without asking
#
# Flags that add object groups: --with-org, --with-expiry, --with-t2. Run `setup.sh --help` for all.
#
# Safe to run twice: each object is looked up first and created only when missing. Additive: the
# script records the id of every object it creates in a state file keyed by tenant domain and only
# ever modifies or deletes recorded ids. An object that already exists under one of its exact names
# but is not recorded makes the script stop before it changes anything; --adopt takes such objects
# over. Tenant-level settings are only read, never written. Secrets go to .env.e2e only, never to
# the terminal.

set -euo pipefail

SELF_NAME="setup.sh"
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DOMAIN="${AUTH0_DOMAIN:-}"
ENV_FILE="${PKG_DIR}/.env.e2e"
PRINT_LOGIN=0
SCOPES_ONLY=0
CHECK_SETTINGS=0
WITH_ORG=0
WITH_EXPIRY=0
WITH_T2=0
MCP_PORT=3011
AUTHCODE_PORT=3015
LIFETIME=30
EXISTING_WORK_API=""
EXISTING_M2M_CLIENT=""
EXISTING_USER=0
WORK_SCOPE="work:read"
# A second scope on the Work API, granted to the exchange client so the cache scenarios can request a wider set.
WORK_WRITE_SCOPE="work:write"
REALM_OVERRIDE=""

usage() {
  cat <<EOF
Usage: setup.sh [options]

  --dry-run             Print every API call and change nothing. Does not start the Auth0 CLI.
  --yes                 Do not ask for confirmation.
  --with-org            Organizations A and B, the org member user, the auth-code client, the org tester.
  --with-expiry         Short-lived MCP and downstream APIs and a second exchange client for them.
  --with-t2             Domain-level connection, grant for the Claude Code (CIMD) client, T2 env values.
  --adopt               Take over existing objects that have the exact names this script uses and are
                        not in the state file. The script may then update them and teardown deletes them.
  --check-settings      Read only. Report tenant settings S1..S4 and which expected objects exist.
  --print-login-command Print the exact \`auth0 login --scopes\` command this run needs and exit.
  --domain DOMAIN       Tenant domain (default: the CLI's active tenant).
  --env-file PATH       Where to write the settings. Default: ${PKG_DIR}/.env.e2e
  --state-file PATH     State file. Default: ${PKG_DIR}/.env.e2e.state.json
  --mcp-port PORT       Port of the MCP server. The MCP API identifier is http://localhost:PORT/mcp (default ${MCP_PORT}).
  --auth-code-port PORT Port of the auth-code callback listener (default ${AUTHCODE_PORT}).
  --lifetime SECONDS    Token lifetime of the short-lived APIs (default ${LIFETIME}).

Existing hand-built objects are referenced, never recorded, modified or deleted:
  --existing-work-api ID       Use this API (resource server id) as the single downstream instead of creating one.
  --work-scope SCOPE           Scope to grant on it (default ${WORK_SCOPE}).
  --existing-m2m-client ID     Use this client as the M2M client; only grants are added for it.
  --existing-user              Use the existing test user: AUTH0_E2E_USERNAME, AUTH0_E2E_PASSWORD and
                               AUTH0_E2E_REALM are taken from the environment or the current env file.
  --realm NAME                 Use this existing database connection. Without --adopt it is only checked
                               and the manual steps are printed.

Prerequisites: Auth0 CLI logged in with the scopes from --print-login-command, jq and openssl.
On-behalf-of token exchange must be enabled on the tenant (an Auth0 internal switch, checked by the
runner preflight, never set here).
EOF
}

while [ $# -gt 0 ]; do
  arg="$1"
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    --with-org) WITH_ORG=1 ;;
    --with-expiry) WITH_EXPIRY=1 ;;
    --with-t2) WITH_T2=1 ;;
    --adopt) ADOPT=1 ;;
    --check-settings) CHECK_SETTINGS=1 ;;
    --print-login-command) PRINT_LOGIN=1 ;;
    --scopes-only) SCOPES_ONLY=1 ;;
    --existing-user) EXISTING_USER=1 ;;
    --domain | --env-file | --state-file | --mcp-port | --auth-code-port | --lifetime | --existing-work-api | --work-scope | --existing-m2m-client | --realm)
      shift
      [ $# -gt 0 ] || die "${arg} needs a value"
      case "$arg" in
        --domain) DOMAIN="$1" ;;
        --env-file) ENV_FILE="$1" ;;
        --state-file) STATE_FILE="$1" ;;
        --mcp-port) MCP_PORT="$1" ;;
        --auth-code-port) AUTHCODE_PORT="$1" ;;
        --lifetime) LIFETIME="$1" ;;
        --existing-work-api) EXISTING_WORK_API="$1" ;;
        --work-scope) WORK_SCOPE="$1" ;;
        --existing-m2m-client) EXISTING_M2M_CLIENT="$1" ;;
        --realm) REALM_OVERRIDE="$1" ;;
      esac
      ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: ${arg}" ;;
  esac
  shift
done
case "$MCP_PORT$AUTHCODE_PORT$LIFETIME" in *[!0-9]*) die "--mcp-port, --auth-code-port and --lifetime must be numbers" ;; esac

MCP_URL="http://localhost:${MCP_PORT}/mcp"
AUTHCODE_CALLBACK="http://localhost:${AUTHCODE_PORT}/callback"
[ -z "$REALM_OVERRIDE" ] || CONNECTION_NAME="$REALM_OVERRIDE"

# --- object catalog (names, identifiers, scopes) ---------------------------------------------------

MCP_API_NAME="${PREFIX} MCP server"
WORK_API_NAME="${PREFIX} Work API"
ORDERS_API_NAME="${PREFIX} Orders API"
INVENTORY_API_NAME="${PREFIX} Inventory API"
ANALYTICS_API_NAME="${PREFIX} Analytics API"
LEDGER_API_NAME="${PREFIX} Ledger API"
SHORT_MCP_API_NAME="${PREFIX} Short MCP API"
SHORT_DOWN_API_NAME="${PREFIX} Short downstream API"
WORK_AUDIENCE="https://work.${PREFIX}.test"
ORDERS_AUDIENCE="https://orders.${PREFIX}.test"
INVENTORY_AUDIENCE="https://inventory.${PREFIX}.test"
ANALYTICS_AUDIENCE="https://analytics.${PREFIX}.test"
LEDGER_AUDIENCE="https://ledger.${PREFIX}.test"
SHORT_MCP_AUDIENCE="https://short-mcp.${PREFIX}.test"
SHORT_DOWN_AUDIENCE="https://short-down.${PREFIX}.test"

MCP_SCOPES='[{"value":"tool:whoami","description":"Show the caller"},{"value":"tool:delegate","description":"Call the single downstream"},{"value":"tool:order_status_report","description":"Order and stock report"},{"value":"tool:sales_analytics_report","description":"Sales analytics report"}]'
MCP_SCOPE_LIST='["tool:whoami","tool:delegate","tool:order_status_report","tool:sales_analytics_report"]'
WORK_SCOPES='[{"value":"work:read","description":"Read work items"},{"value":"work:write","description":"Change work items"}]'
ORDERS_SCOPES='[{"value":"read:orders","description":"Read orders"}]'
INVENTORY_SCOPES='[{"value":"read:inventory","description":"Read stock levels"},{"value":"write:inventory","description":"Reserve stock"}]'
ANALYTICS_SCOPES='[{"value":"read:analytics","description":"Read monthly revenue"}]'
LEDGER_SCOPES='[{"value":"read:ledger","description":"Read the ledger"},{"value":"write:ledger","description":"Write the ledger (never granted)"}]'
SHORT_MCP_SCOPES='[{"value":"tool:whoami","description":"Show the caller"}]'
SHORT_DOWN_SCOPES='[{"value":"read:short","description":"Read short-lived data"}]'

EXCHANGE_NAME="${PREFIX} exchange client"
SHORT_EXCHANGE_NAME="${PREFIX} short exchange client"
LOGIN_NAME="${PREFIX} login client"
LIMITED_NAME="${PREFIX} limited client"
M2M_NAME="${PREFIX} m2m client"
TESTER_NAME="${PREFIX} org tester"
AUTHCODE_NAME="${PREFIX} auth-code client"
ORG_A_NAME="${PREFIX}-org-a"
ORG_B_NAME="${PREFIX}-org-b"
USER_EMAIL="${PREFIX}-user@example.com"
ORG_USER_EMAIL="${PREFIX}-org-user@example.com"

# --- scope-only mode (also used by --print-login-command and the preflight) -------------------------

compute_scopes() {
  # Runs the planned flow as a dry run, silently, and prints the scopes its calls need.
  SCOPE_LOG="$(mktemp "${TMPDIR:-/tmp}/e2e-scopes.XXXXXX")"
  DRY_RUN=1
  ASSUME_YES=1
  teardown_scopes
  track_scope GET "tenants/settings"
  # Calls that only happen when an object already exists (a dry run sees an empty tenant): scope
  # additions and lifetime fixes on APIs, password rotation for a recorded user without a saved password.
  track_scope PATCH "resource-servers/x"
  track_scope PATCH "users/x"
  run_flow >/dev/null 2>&1 || true
  login_scopes_csv
  rm -f "$SCOPE_LOG"
}

# --- env file ---------------------------------------------------------------------------------------

ENV_TOUCHED=""
ENV_TMP=""
trap 'rm -f "${ENV_TMP:-}"' EXIT
env_set() {
  # env_set KEY VALUE: replace the KEY= line in the env file, or append it. Values reach awk through
  # its environment, never a command line, and the file keeps mode 600.
  ENV_TOUCHED="${ENV_TOUCHED} $1"
  [ "$DRY_RUN" -eq 1 ] && return 0
  local old_umask
  old_umask="$(umask)"
  umask 077
  ENV_TMP="$(mktemp "${TMPDIR:-/tmp}/env-set.XXXXXX")"
  umask "$old_umask"
  if [ -f "$ENV_FILE" ]; then
    KEY="$1" VAL="$2" awk '
      BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; done = 0 }
      index($0, k "=") == 1 { print k "=" v; done = 1; next }
      { print }
      END { if (!done) print k "=" v }
    ' "$ENV_FILE" >"$ENV_TMP"
  else
    printf '%s=%s\n' "$1" "$2" >"$ENV_TMP"
  fi
  mv "$ENV_TMP" "$ENV_FILE"
  ENV_TMP=""
  chmod 600 "$ENV_FILE"
}

env_get() {
  # env_get KEY -> value from the process environment, else from the env file, else empty
  local v="${!1:-}"
  if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  [ -f "$ENV_FILE" ] || return 0
  grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- || true
}

# --- ensure helpers ---------------------------------------------------------------------------------

find_id() {
  # find_id JSON NAME ID_FIELD -> id of the first item whose .name equals NAME
  printf '%s' "$1" | jq -r --arg n "$2" --arg f "$3" '[.[] | select(.name == $n) | .[$f]] | first // empty'
}

new_password() { printf '%sAa1!' "$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-24)"; }

# ensure_api VAR NAME IDENTIFIER SCOPES_JSON SKIP_CONSENT EXTRA_JSON
# Creates the API when missing and records it. For an API the script may modify, missing scopes are
# added and the EXTRA fields (for example token_lifetime) are brought in line. Sets VAR to its id.
ensure_api() {
  local var="$1" name="$2" ident="$3" scopes="$4" skip="$5" extra="${6:-}" existing id body diff
  [ -n "$extra" ] || extra='{}'
  existing="$(printf '%s' "$APIS" | jq -c --arg i "$ident" '[.[] | select(.identifier == $i)] | first // empty')"
  if [ -n "$existing" ]; then
    id="$(printf '%s' "$existing" | jq -r '.id')"
    say "   exists   ${name}"
    diff="$(printf '%s' "$existing" | jq -r --argjson w "$scopes" --argjson e "$extra" '((($w | map(.value)) - [.scopes[]?.value]) | length > 0) or ($e | to_entries | any(.value != $x[.key]))' --argjson x "$existing" 2>/dev/null || printf 'false')"
    if [ "$diff" = true ]; then
      if can_modify apis "$id"; then
        body="$(printf '%s' "$existing" | jq -c --argjson w "$scopes" --argjson e "$extra" '. as $o | {scopes: (($o.scopes // []) + ($w | map(select(.value as $v | ([$o.scopes[]?.value] | index($v)) == null))))} + $e')"
        api PATCH "resource-servers/${id}" "$body" >/dev/null
        say "   updated  ${name} (scopes or lifetime)"
      else
        warn "${name} differs from the expected scopes or lifetime and setup did not create it. Left unchanged."
      fi
    fi
  else
    body="$(jq -nc --arg n "$name" --arg i "$ident" --argjson s "$scopes" --argjson k "$skip" --argjson e "$extra" \
      '{name: $n, identifier: $i, signing_alg: "RS256", token_dialect: "access_token", scopes: $s} + (if $k then {skip_consent_for_verifiable_first_party_clients: true} else {} end) + $e')"
    id="$(api POST "resource-servers" "$body" | jq -r '.id')"
    state_add apis "$id" "$name"
    say "   created  ${name}"
  fi
  printf -v "$var" '%s' "$id"
}

# ensure_client VAR NAME BODY_JSON -> creates the client when missing and records it. Sets VAR to client_id.
ensure_client() {
  local var="$1" name="$2" body="$3" id
  id="$(find_id "$CLIENTS" "$name" client_id)"
  if [ -n "$id" ]; then
    say "   exists   ${name}"
  else
    id="$(api POST "clients" "$body" | jq -r '.client_id')"
    state_add clients "$id" "$name"
    say "   created  ${name}"
  fi
  printf -v "$var" '%s' "$id"
}

# client_secret CLIENT_ID -> prints the secret (the caller keeps it in a variable, never prints it)
client_secret() {
  api GET "clients/${1}?fields=client_secret&include_fields=true" | jq -r '.client_secret? // empty'
}

# ensure_grant CLIENT AUDIENCE SCOPES_JSON EXTRA_JSON NAME
# Creates the grant when missing and records it. A recorded grant with other scopes is deleted and
# created again (this avoids needing the update:client_grants scope); a grant somebody else made is
# reported and left alone.
ensure_grant() {
  local client="$1" aud="$2" scopes="$3" extra="$4" name="$5" found gid body differs
  found="$(api GET "client-grants?client_id=${client}&audience=${aud}")"
  body="$(jq -nc --arg c "$client" --arg a "$aud" --argjson s "$scopes" --argjson e "$extra" '{client_id: $c, audience: $a, scope: $s} + $e')"
  if [ "$(printf '%s' "$found" | jq 'length')" = "0" ]; then
    gid="$(api POST "client-grants" "$body" | jq -r '.id')"
    state_add grants "$gid" "$name"
    say "   created  grant: ${name}"
    return 0
  fi
  gid="$(printf '%s' "$found" | jq -r '.[0].id')"
  differs="$(printf '%s' "$found" | jq -r --argjson w "$scopes" '((.[0].scope // []) | sort) != ($w | sort)')"
  if [ "$differs" != true ]; then
    say "   exists   grant: ${name}"
  elif state_has grants "$gid"; then
    api DELETE "client-grants/${gid}" >/dev/null
    state_remove grants "$gid"
    gid="$(api POST "client-grants" "$body" | jq -r '.id')"
    state_add grants "$gid" "$name"
    say "   replaced grant: ${name} (scopes differed)"
  else
    warn "grant '${name}' (${gid}) has other scopes than expected and setup did not create it. Left unchanged."
  fi
}

# ensure_exchange_client VAR_ID VAR_SECRET NAME IDENTIFIER ADD_CC
# The exchange client must be a custom API client tied to the MCP-side API; a regular application
# cannot do on-behalf-of exchanges.
ensure_exchange_client() {
  local vid="$1" vsecret="$2" name="$3" ident="$4" add_cc="$5" cid body now sec
  ensure_client cid "$name" "$(jq -nc --arg n "$name" --arg i "$ident" '{name: $n, app_type: "resource_server", resource_server_identifier: $i}')"
  now="$(api GET "clients/${cid}?fields=client_secret,grant_types,token_exchange&include_fields=true")"
  sec="$(printf '%s' "$now" | jq -r '.client_secret? // empty')"
  if printf '%s' "$now" | jq -e '(.token_exchange.allow_any_profile_of_type // []) | index("on_behalf_of_token_exchange") != null' >/dev/null 2>&1; then
    say "   exists   on-behalf-of profile on ${name}"
  else
    api PATCH "clients/${cid}" '{"token_exchange":{"allow_any_profile_of_type":["on_behalf_of_token_exchange"]}}' >/dev/null \
      || die "Could not enable the on-behalf-of profile type on ${name}. The tenant switch is probably off: ask the SDK team to enable it."
    say "   set      on-behalf-of exchange allowed for ${name}"
  fi
  if [ "$add_cc" = 1 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      say "   would add the client_credentials grant type to ${name} (current list plus one entry)"
    elif [ "$(printf '%s' "$now" | jq -r '.grant_types | type')" != array ]; then
      die "Could not read the grant types of ${name}, so they were not changed."
    elif [ "$(printf '%s' "$now" | jq -r '.grant_types | index("client_credentials") != null')" = true ]; then
      say "   exists   client_credentials grant type on ${name}"
    else
      body="$(printf '%s' "$now" | jq -c '{grant_types: ((.grant_types + ["client_credentials"]) | unique)}')"
      api PATCH "clients/${cid}" "$body" >/dev/null
      say "   set      client_credentials added to the grant types of ${name}"
    fi
  fi
  printf -v "$vid" '%s' "$cid"
  printf -v "$vsecret" '%s' "$sec"
}

# ensure_user VAR_ID VAR_PASSWORD EMAIL ENV_PASSWORD_KEY
# VAR_PASSWORD is set only when the password is new (created or rotated), so the caller writes it.
ensure_user() {
  local vid="$1" vpw="$2" email="$3" key="$4" id body pw="" found
  found="$(api GET "users-by-email?email=${email}")"
  id="$(printf '%s' "$found" | jq -r --arg c "$CONNECTION_NAME" '[.[]? | select(.identities[0].connection == $c) | .user_id] | first // empty')"
  if [ -n "$id" ]; then
    if [ -n "$(env_get "$key")" ]; then
      say "   exists   ${email} (saved password kept)"
    elif can_modify users "$id"; then
      pw="$(new_password)"
      api PATCH "users/${id}" "$(jq -nc --arg p "$pw" --arg c "$CONNECTION_NAME" '{password: $p, connection: $c}')" >/dev/null
      say "   updated  ${email} (new password written to the env file only)"
    else
      warn "${email} exists, no saved password, and setup did not create it. Refusing to change its password."
    fi
  else
    if [ "$DRY_RUN" -eq 1 ]; then pw="<generated>"; else pw="$(new_password)"; fi
    body="$(jq -nc --arg e "$email" --arg p "$pw" --arg c "$CONNECTION_NAME" '{email: $e, password: $p, connection: $c, email_verified: true}')"
    id="$(api POST "users" "$body" | jq -r '.user_id')"
    state_add users "$id" "$email"
    say "   created  ${email}"
  fi
  printf -v "$vid" '%s' "$id"
  printf -v "$vpw" '%s' "$pw"
}

# ensure_org VAR NAME DISPLAY CONNECTION_ID -> org exists, DB connection enabled on it
ensure_org() {
  local var="$1" name="$2" display="$3" conn="$4" id enabled
  id="$(find_id "$ORGS" "$name" id)"
  if [ -n "$id" ]; then
    say "   exists   ${name}"
  else
    id="$(api POST "organizations" "$(jq -nc --arg n "$name" --arg d "$display" '{name: $n, display_name: $d}')" | jq -r '.id')"
    state_add organizations "$id" "$name"
    say "   created  ${name}"
  fi
  enabled="$(api GET "organizations/${id}/enabled_connections")"
  if printf '%s' "$enabled" | jq -e --arg c "$conn" 'type == "array" and any(.[]; .connection_id == $c)' >/dev/null 2>&1; then
    say "   exists   connection enabled on ${name}"
  else
    api POST "organizations/${id}/enabled_connections" "$(jq -nc --arg c "$conn" '{connection_id: $c, assign_membership_on_login: false}')" >/dev/null
    say "   set      connection enabled on ${name}"
  fi
  printf -v "$var" '%s' "$id"
}

ensure_member() {
  # ensure_member ORG_ID USER_ID LABEL
  local members
  members="$(api GET "organizations/${1}/members")"
  if printf '%s' "$members" | jq -e --arg u "$2" 'type == "array" and any(.[]; .user_id == $u)' >/dev/null 2>&1; then
    say "   exists   ${3} is a member"
  else
    api POST "organizations/${1}/members" "$(jq -nc --arg u "$2" '{members: [$u]}')" >/dev/null
    say "   set      ${3} added as a member"
  fi
}

# --- read-only report -------------------------------------------------------------------------------

presence() {
  # presence KIND LABEL ID_OR_EMPTY
  if [ -z "$3" ]; then printf '  %-34s missing\n' "$2"
  elif state_has "$1" "$3"; then printf '  %-34s found, recorded by setup (%s)\n' "$2" "$3"
  else printf '  %-34s found, not recorded (existing or hand-built) (%s)\n' "$2" "$3"; fi
}

run_check_settings() {
  say "== Tenant settings (read only)"
  read_tenant_settings
  settings_lines
  [ -z "$SETTINGS_NOTE" ] || say "  note: ${SETTINGS_NOTE}"
  [ "$PROFILE_SETTING" != off ] || say "  S1 must be set to compatibility in the dashboard: Settings > Advanced."
  [ "$CIMD_SETTING" != off ] || say "  S2 must be turned on in the dashboard: Settings > Advanced."
  say "== Objects (read only)"
  local apis clients conns orgs
  apis="$(list_all "resource-servers")"
  clients="$(list_all "clients?fields=client_id,name,external_client_id&include_fields=true")"
  conns="$(list_all "connections?strategy=auth0")"
  orgs="$(list_all "organizations")"
  local ident
  for ident in "$MCP_URL" "$WORK_AUDIENCE" "$ORDERS_AUDIENCE" "$INVENTORY_AUDIENCE" "$ANALYTICS_AUDIENCE" "$LEDGER_AUDIENCE" "$SHORT_MCP_AUDIENCE" "$SHORT_DOWN_AUDIENCE"; do
    presence apis "API ${ident}" "$(printf '%s' "$apis" | jq -r --arg i "$ident" '[.[] | select(.identifier == $i) | .id] | first // empty')"
  done
  local n
  for n in "$EXCHANGE_NAME" "$SHORT_EXCHANGE_NAME" "$LOGIN_NAME" "$LIMITED_NAME" "$M2M_NAME" "$TESTER_NAME" "$AUTHCODE_NAME"; do
    presence clients "client ${n#"${PREFIX} "}" "$(find_id "$clients" "$n" client_id)"
  done
  presence connections "connection ${CONNECTION_NAME}" "$(find_id "$conns" "$CONNECTION_NAME" id)"
  presence organizations "organization ${ORG_A_NAME}" "$(find_id "$orgs" "$ORG_A_NAME" id)"
  presence organizations "organization ${ORG_B_NAME}" "$(find_id "$orgs" "$ORG_B_NAME" id)"
  presence refs "Claude Code (CIMD) client" "$(printf '%s' "$clients" | jq -r --arg u "$CIMD_URL" '[.[] | select(.external_client_id == $u) | .client_id] | first // empty')"
}

# --- the flow ---------------------------------------------------------------------------------------

run_flow() {
  need_cmd jq
  need_cmd openssl
  state_validate
  if [ "$DRY_RUN" -eq 1 ]; then
    [ -n "$DOMAIN" ] || DOMAIN="your-tenant.us.auth0.com"
    say "Dry run: no Auth0 CLI calls, no changes."
  else
    need_cmd auth0
    local active
    active="$(active_tenant)"
    [ -n "$active" ] || die "The Auth0 CLI has no active tenant. Run: $("$0" --print-login-command)"
    [ -n "$DOMAIN" ] || DOMAIN="$active"
    [ "$DOMAIN" = "$active" ] || die "Active CLI tenant is ${active} but the target domain is ${DOMAIN}. Run: auth0 tenants use ${DOMAIN}"
  fi
  STATE_DOMAIN="$DOMAIN"
  say "Target tenant: ${DOMAIN}"
  say "MCP server API identifier: ${MCP_URL}"
  say "Objects get the name prefix: ${PREFIX}"
  say ""

  if [ "$CHECK_SETTINGS" -eq 1 ]; then
    run_check_settings
    return 0
  fi

  say "Reminder: on-behalf-of token exchange must be enabled on this tenant. Setup cannot check it; the"
  say "runner preflight probes it. Without it everything below is created but exchanges fail."
  say ""

  if [ "$WITH_T2" -eq 1 ]; then
    say "== 0a. Tenant settings (read only)"
    read_tenant_settings
    settings_lines
    if [ "$PROFILE_SETTING" = off ] || [ "$CIMD_SETTING" = off ]; then
      die "Claude Code sign-in needs S1 set to compatibility and S2 on. Change them in the Auth0 dashboard (Settings > Advanced), then rerun. Nothing was changed."
    fi
    [ "$ISS_SETTING" != off ] || warn "S4 'Include issuer in authorization responses' is off. Auth0 lists it as an MCP client prerequisite."
  fi

  say "== 0. Checking for existing objects"
  APIS="$(list_all "resource-servers")"
  CLIENTS="$(list_all "clients?fields=client_id,name,external_client_id&include_fields=true")"
  CONNECTIONS="$(list_all "connections?strategy=auth0")"
  ORGS="[]"
  [ "$WITH_ORG" -eq 1 ] && ORGS="$(list_all "organizations")"

  local CONFLICTS="" TAB
  TAB="$(printf '\t')"
  note_existing() {
    [ -n "$2" ] || return 0
    if state_has "$1" "$2"; then return 0; fi
    CONFLICTS="${CONFLICTS}${1}${TAB}${2}${TAB}${3}
"
  }
  api_id_by_identifier() { printf '%s' "$APIS" | jq -r --arg i "$1" '[.[] | select(.identifier == $i) | .id] | first // empty'; }

  note_existing apis "$(api_id_by_identifier "$MCP_URL")" "${MCP_API_NAME} (identifier ${MCP_URL})"
  [ -n "$EXISTING_WORK_API" ] || note_existing apis "$(api_id_by_identifier "$WORK_AUDIENCE")" "${WORK_API_NAME} (identifier ${WORK_AUDIENCE})"
  note_existing apis "$(api_id_by_identifier "$ORDERS_AUDIENCE")" "${ORDERS_API_NAME} (identifier ${ORDERS_AUDIENCE})"
  note_existing apis "$(api_id_by_identifier "$INVENTORY_AUDIENCE")" "${INVENTORY_API_NAME} (identifier ${INVENTORY_AUDIENCE})"
  note_existing apis "$(api_id_by_identifier "$ANALYTICS_AUDIENCE")" "${ANALYTICS_API_NAME} (identifier ${ANALYTICS_AUDIENCE})"
  note_existing apis "$(api_id_by_identifier "$LEDGER_AUDIENCE")" "${LEDGER_API_NAME} (identifier ${LEDGER_AUDIENCE})"
  if [ "$WITH_EXPIRY" -eq 1 ]; then
    note_existing apis "$(api_id_by_identifier "$SHORT_MCP_AUDIENCE")" "${SHORT_MCP_API_NAME} (identifier ${SHORT_MCP_AUDIENCE})"
    note_existing apis "$(api_id_by_identifier "$SHORT_DOWN_AUDIENCE")" "${SHORT_DOWN_API_NAME} (identifier ${SHORT_DOWN_AUDIENCE})"
    note_existing clients "$(find_id "$CLIENTS" "$SHORT_EXCHANGE_NAME" client_id)" "$SHORT_EXCHANGE_NAME"
  fi
  local n
  for n in "$EXCHANGE_NAME" "$LOGIN_NAME" "$LIMITED_NAME"; do
    note_existing clients "$(find_id "$CLIENTS" "$n" client_id)" "$n"
  done
  [ -n "$EXISTING_M2M_CLIENT" ] || note_existing clients "$(find_id "$CLIENTS" "$M2M_NAME" client_id)" "$M2M_NAME"
  local CONNECTION_ID OWN_CONNECTION=1 CONN_MODIFY=1
  CONNECTION_ID="$(find_id "$CONNECTIONS" "$CONNECTION_NAME" id)"
  if [ -n "$REALM_OVERRIDE" ]; then
    # An existing connection the script did not create: referenced, never recorded.
    OWN_CONNECTION=0
    [ "$ADOPT" -eq 1 ] || CONN_MODIFY=0
    [ -n "$CONNECTION_ID" ] || die "--realm ${REALM_OVERRIDE}: no such database connection in ${DOMAIN}."
  else
    note_existing connections "$CONNECTION_ID" "$CONNECTION_NAME"
  fi
  if [ "$EXISTING_USER" -eq 0 ]; then
    local uid
    uid="$(api GET "users-by-email?email=${USER_EMAIL}" | jq -r --arg c "$CONNECTION_NAME" '[.[]? | select(.identities[0].connection == $c) | .user_id] | first // empty')"
    note_existing users "$uid" "$USER_EMAIL"
  fi
  if [ "$WITH_ORG" -eq 1 ]; then
    note_existing organizations "$(find_id "$ORGS" "$ORG_A_NAME" id)" "$ORG_A_NAME"
    note_existing organizations "$(find_id "$ORGS" "$ORG_B_NAME" id)" "$ORG_B_NAME"
    for n in "$TESTER_NAME" "$AUTHCODE_NAME"; do
      note_existing clients "$(find_id "$CLIENTS" "$n" client_id)" "$n"
    done
    local ouid
    ouid="$(api GET "users-by-email?email=${ORG_USER_EMAIL}" | jq -r --arg c "$CONNECTION_NAME" '[.[]? | select(.identities[0].connection == $c) | .user_id] | first // empty')"
    note_existing users "$ouid" "$ORG_USER_EMAIL"
  fi

  if [ -n "$CONFLICTS" ]; then
    say "These objects already exist in ${DOMAIN} and are not recorded as created by this script:"
    printf '%s' "$CONFLICTS" | while IFS="$TAB" read -r KIND ID NAME; do
      if [ -n "$ID" ]; then printf '  %-14s %s  (%s)\n' "$KIND" "$NAME" "$ID"; fi
    done
    if [ "$ADOPT" -ne 1 ]; then
      die "Nothing was changed. This script only modifies objects it created. If these are leftovers of an earlier run, rerun with --adopt (it may then update them and teardown deletes them). Otherwise use another tenant or prefix, or rename or remove them yourself."
    fi
    warn "--adopt: the script will take over the objects above and may update them. Teardown will delete them."
    if [ "$DRY_RUN" -eq 0 ]; then
      confirm "Adopt these objects?" || die "Cancelled. Nothing was changed."
    fi
  fi

  if [ "$DRY_RUN" -eq 0 ]; then
    confirm "Create the missing objects in ${DOMAIN}?" || die "Cancelled. Nothing was changed."
    # Record adopted objects only now, so declining any prompt above leaves no state behind.
    if [ -n "$CONFLICTS" ]; then
      while IFS="$TAB" read -r KIND ID NAME; do
        if [ -n "$ID" ]; then state_add "$KIND" "$ID" "$NAME"; fi
      done <<ADOPTED
$CONFLICTS
ADOPTED
    fi
  fi

  # --- 1. APIs ---
  say "== 1. APIs"
  # shellcheck disable=SC2034 # the ids are assigned by ensure_api and only some are read later
  local MCP_API_ID WORK_API_ID ORDERS_API_ID INVENTORY_API_ID ANALYTICS_API_ID LEDGER_API_ID SHORT_MCP_API_ID SHORT_DOWN_API_ID
  ensure_api MCP_API_ID "$MCP_API_NAME" "$MCP_URL" "$MCP_SCOPES" false
  local WORK_AUD="$WORK_AUDIENCE"
  if [ -n "$EXISTING_WORK_API" ]; then
    valid_id "$EXISTING_WORK_API" || die "--existing-work-api: unexpected id"
    if [ "$DRY_RUN" -eq 1 ]; then
      WORK_AUD="https://existing-work-api.example"
    else
      WORK_AUD="$(api GET "resource-servers/${EXISTING_WORK_API}" | jq -r '.identifier // empty')"
      [ -n "$WORK_AUD" ] || die "--existing-work-api: could not read that API."
    fi
    say "   using    existing work API ${WORK_AUD} (referenced, not recorded, not modified)"
  else
    ensure_api WORK_API_ID "$WORK_API_NAME" "$WORK_AUDIENCE" "$WORK_SCOPES" true
  fi
  ensure_api ORDERS_API_ID "$ORDERS_API_NAME" "$ORDERS_AUDIENCE" "$ORDERS_SCOPES" true
  ensure_api INVENTORY_API_ID "$INVENTORY_API_NAME" "$INVENTORY_AUDIENCE" "$INVENTORY_SCOPES" true
  ensure_api ANALYTICS_API_ID "$ANALYTICS_API_NAME" "$ANALYTICS_AUDIENCE" "$ANALYTICS_SCOPES" false
  ensure_api LEDGER_API_ID "$LEDGER_API_NAME" "$LEDGER_AUDIENCE" "$LEDGER_SCOPES" true
  if [ "$WITH_EXPIRY" -eq 1 ]; then
    local life
    life="$(jq -nc --argjson l "$LIFETIME" '{token_lifetime: $l, token_lifetime_for_web: $l}')"
    ensure_api SHORT_MCP_API_ID "$SHORT_MCP_API_NAME" "$SHORT_MCP_AUDIENCE" "$SHORT_MCP_SCOPES" false "$life"
    ensure_api SHORT_DOWN_API_ID "$SHORT_DOWN_API_NAME" "$SHORT_DOWN_AUDIENCE" "$SHORT_DOWN_SCOPES" true "$life"
  fi

  # --- 2. Connection ---
  say "== 2. Database connection"
  local DOMAIN_LEVEL=false
  [ "$WITH_T2" -eq 1 ] && DOMAIN_LEVEL=true
  if [ -n "$CONNECTION_ID" ]; then
    say "   exists   connection ${CONNECTION_NAME}"
    if [ "$DOMAIN_LEVEL" = true ] && [ "$(printf '%s' "$CONNECTIONS" | jq -r --arg n "$CONNECTION_NAME" '[.[] | select(.name == $n) | .is_domain_connection] | first // false')" != true ]; then
      if [ "$CONN_MODIFY" -eq 1 ] && { [ "$OWN_CONNECTION" -eq 0 ] || can_modify connections "$CONNECTION_ID"; }; then
        api PATCH "connections/${CONNECTION_ID}" '{"is_domain_connection":true}' >/dev/null
        say "   set      connection is now domain-level"
      else
        warn "Claude Code needs ${CONNECTION_NAME} to be a domain-level connection. Setup did not create it. Turn on 'Enable for third-party applications' in the dashboard or rerun with --adopt."
      fi
    fi
  else
    if [ "$DOMAIN_LEVEL" = true ]; then
      warn "--with-t2 makes the connection ${CONNECTION_NAME} a domain-level connection, available to every application in the tenant including third-party ones. Use a test tenant."
      [ "$DRY_RUN" -eq 1 ] || confirm "Continue with a domain-level connection?" || die "Cancelled. Only the APIs above were created."
    fi
    CONNECTION_ID="$(api POST "connections" "$(jq -nc --arg n "$CONNECTION_NAME" --argjson d "$DOMAIN_LEVEL" '{name: $n, strategy: "auth0", is_domain_connection: $d}')" | jq -r '.id')"
    [ "$OWN_CONNECTION" -eq 0 ] || state_add connections "$CONNECTION_ID" "$CONNECTION_NAME"
    say "   created  connection ${CONNECTION_NAME}"
  fi

  # --- 3. Clients ---
  say "== 3. Applications"
  local EXCHANGE_ID EXCHANGE_SECRET LOGIN_ID LOGIN_SECRET LIMITED_ID LIMITED_SECRET M2M_ID M2M_SECRET
  ensure_exchange_client EXCHANGE_ID EXCHANGE_SECRET "$EXCHANGE_NAME" "$MCP_URL" 1
  ensure_client LOGIN_ID "$LOGIN_NAME" "$(jq -nc --arg n "$LOGIN_NAME" \
    '{name: $n, app_type: "non_interactive", grant_types: ["password", "http://auth0.com/oauth/grant-type/password-realm"], token_endpoint_auth_method: "client_secret_post"}')"
  LOGIN_SECRET="$(client_secret "$LOGIN_ID")"
  ensure_client LIMITED_ID "$LIMITED_NAME" "$(jq -nc --arg n "$LIMITED_NAME" '{name: $n, app_type: "non_interactive", grant_types: ["client_credentials"], token_endpoint_auth_method: "client_secret_post"}')"
  LIMITED_SECRET="$(client_secret "$LIMITED_ID")"
  if [ -n "$EXISTING_M2M_CLIENT" ]; then
    valid_id "$EXISTING_M2M_CLIENT" || die "--existing-m2m-client: unexpected id"
    M2M_ID="$EXISTING_M2M_CLIENT"
    M2M_SECRET="$(client_secret "$M2M_ID")"
    state_add refs "$M2M_ID" "existing m2m client"
    say "   using    existing m2m client (referenced, not modified, only grants are added)"
  else
    ensure_client M2M_ID "$M2M_NAME" "$(jq -nc --arg n "$M2M_NAME" '{name: $n, app_type: "non_interactive", grant_types: ["client_credentials"], token_endpoint_auth_method: "client_secret_post"}')"
    M2M_SECRET="$(client_secret "$M2M_ID")"
  fi
  local SHORT_EXCHANGE_ID="" SHORT_EXCHANGE_SECRET=""
  if [ "$WITH_EXPIRY" -eq 1 ]; then
    ensure_exchange_client SHORT_EXCHANGE_ID SHORT_EXCHANGE_SECRET "$SHORT_EXCHANGE_NAME" "$SHORT_MCP_AUDIENCE" 0
  fi
  local AUTHCODE_ID="" AUTHCODE_SECRET="" TESTER_ID="" TESTER_SECRET=""
  if [ "$WITH_ORG" -eq 1 ]; then
    ensure_client AUTHCODE_ID "$AUTHCODE_NAME" "$(jq -nc --arg n "$AUTHCODE_NAME" --arg cb "$AUTHCODE_CALLBACK" \
      '{name: $n, app_type: "regular_web", callbacks: [$cb], grant_types: ["authorization_code"], token_endpoint_auth_method: "client_secret_post", organization_usage: "allow", oidc_conformant: true}')"
    local cur
    cur="$(api GET "clients/${AUTHCODE_ID}?fields=callbacks&include_fields=true")"
    if ! printf '%s' "$cur" | jq -e --arg cb "$AUTHCODE_CALLBACK" '(.callbacks // []) | index($cb) != null' >/dev/null 2>&1; then
      if can_modify clients "$AUTHCODE_ID"; then
        api PATCH "clients/${AUTHCODE_ID}" "$(printf '%s' "$cur" | jq -c --arg cb "$AUTHCODE_CALLBACK" '{callbacks: (((.callbacks // []) + [$cb]) | unique)}')" >/dev/null
        say "   set      callback ${AUTHCODE_CALLBACK}"
      fi
    fi
    AUTHCODE_SECRET="$(client_secret "$AUTHCODE_ID")"
    ensure_client TESTER_ID "$TESTER_NAME" "$(jq -nc --arg n "$TESTER_NAME" '{name: $n, app_type: "non_interactive", grant_types: ["client_credentials"], token_endpoint_auth_method: "client_secret_post"}')"
    TESTER_SECRET="$(client_secret "$TESTER_ID")"
  fi

  # Claude Code (CIMD) client: external, shared with other previews. Setup only reads it and adds a grant.
  local CIMD_ID=""
  if [ "$WITH_T2" -eq 1 ]; then
    CIMD_ID="$(printf '%s' "$CLIENTS" | jq -r --arg u "$CIMD_URL" '[.[] | select(.external_client_id == $u) | .client_id] | first // empty')"
    if [ -n "$CIMD_ID" ]; then
      say "   using    Claude Code (CIMD) client ${CIMD_ID} (referenced, never modified or deleted)"
      state_add refs "$CIMD_ID" "Claude Code (CIMD) client"
    else
      warn "The Claude Code (CIMD) client is not registered in ${DOMAIN}. It registers on its first sign-in once S2 is on. Rerun setup afterwards to add its grant."
    fi
  fi

  # --- 4. Grants ---
  say "== 4. Client grants"
  local WORK_GRANT
  if [ -n "$EXISTING_WORK_API" ]; then
    WORK_GRANT="$(jq -nc --arg s "$WORK_SCOPE" '[$s]')"
  else
    WORK_GRANT="$(jq -nc --arg s "$WORK_SCOPE" --arg w "$WORK_WRITE_SCOPE" '[$s, $w] | unique')"
  fi
  ensure_grant "$EXCHANGE_ID" "$WORK_AUD" "$WORK_GRANT" '{"subject_type":"user"}' "exchange client to Work API"
  ensure_grant "$EXCHANGE_ID" "$ORDERS_AUDIENCE" '["read:orders"]' '{"subject_type":"user"}' "exchange client to Orders API"
  ensure_grant "$EXCHANGE_ID" "$INVENTORY_AUDIENCE" '["read:inventory","write:inventory"]' '{"subject_type":"user"}' "exchange client to Inventory API"
  ensure_grant "$EXCHANGE_ID" "$ANALYTICS_AUDIENCE" '["read:analytics"]' '{}' "exchange client to Analytics API"
  ensure_grant "$EXCHANGE_ID" "$LEDGER_AUDIENCE" '["read:ledger"]' '{"subject_type":"user"}' "exchange client to Ledger API (read only)"
  ensure_grant "$LOGIN_ID" "$MCP_URL" "$MCP_SCOPE_LIST" '{"subject_type":"user"}' "login client to MCP server API"
  ensure_grant "$LIMITED_ID" "$MCP_URL" '["tool:whoami"]' '{}' "limited client to MCP server API"
  ensure_grant "$M2M_ID" "$WORK_AUD" "$(jq -nc --arg s "$WORK_SCOPE" '[$s]')" '{}' "m2m client to Work API"
  ensure_grant "$M2M_ID" "$LEDGER_AUDIENCE" '["read:ledger"]' '{}' "m2m client to Ledger API (partial grant)"
  if [ "$WITH_EXPIRY" -eq 1 ]; then
    ensure_grant "$LOGIN_ID" "$SHORT_MCP_AUDIENCE" '["tool:whoami"]' '{"subject_type":"user"}' "login client to Short MCP API"
    ensure_grant "$SHORT_EXCHANGE_ID" "$SHORT_DOWN_AUDIENCE" '["read:short"]' '{"subject_type":"user"}' "short exchange client to Short downstream API"
  fi
  if [ "$WITH_ORG" -eq 1 ]; then
    ensure_grant "$AUTHCODE_ID" "$MCP_URL" "$MCP_SCOPE_LIST" '{"subject_type":"user"}' "auth-code client to MCP server API"
    ensure_grant "$TESTER_ID" "$MCP_URL" '["tool:whoami"]' '{"organization_usage":"allow","allow_any_organization":true}' "org tester to MCP server API"
  fi
  if [ -n "$CIMD_ID" ]; then
    ensure_grant "$CIMD_ID" "$MCP_URL" "$MCP_SCOPE_LIST" '{"subject_type":"user"}' "Claude Code to MCP server API"
  fi

  # --- 5. Connection clients and users ---
  say "== 5. Test users"
  if [ "$CONN_MODIFY" -eq 1 ]; then
    local enabled
    enabled="$(jq -nc --arg a "$LOGIN_ID" --arg b "$AUTHCODE_ID" '[{client_id: $a, status: true}] + (if $b == "" then [] else [{client_id: $b, status: true}] end)')"
    # An additive, idempotent call: it enables the clients and leaves the connection's other settings alone.
    api PATCH "connections/${CONNECTION_ID}/clients" "$enabled" >/dev/null
    say "   set      connection enabled for the login and auth-code clients"
  else
    warn "Connection ${CONNECTION_NAME} was not created by setup. Enable it by hand for the login client ${LOGIN_ID}, or rerun with --adopt."
  fi

  # shellcheck disable=SC2034 # USER_ID is assigned by ensure_user
  local USER_ID="" USER_PW="" USERNAME REALM PASSWORD
  if [ "$EXISTING_USER" -eq 1 ]; then
    USERNAME="$(env_get AUTH0_E2E_USERNAME)"
    PASSWORD="$(env_get AUTH0_E2E_PASSWORD)"
    REALM="$(env_get AUTH0_E2E_REALM)"
    if [ "$DRY_RUN" -eq 0 ] && { [ -z "$USERNAME" ] || [ -z "$PASSWORD" ] || [ -z "$REALM" ]; }; then
      die "--existing-user needs AUTH0_E2E_USERNAME, AUTH0_E2E_PASSWORD and AUTH0_E2E_REALM in the environment or the env file."
    fi
    say "   using    existing test user (referenced)"
  else
    ensure_user USER_ID USER_PW "$USER_EMAIL" AUTH0_E2E_PASSWORD
    USERNAME="$USER_EMAIL"
    REALM="$CONNECTION_NAME"
    PASSWORD="$USER_PW"
    [ -n "$PASSWORD" ] || PASSWORD="$(env_get AUTH0_E2E_PASSWORD)"
  fi

  local ORG_A_ID="" ORG_B_ID="" ORG_USER_ID="" ORG_USER_PW=""
  if [ "$WITH_ORG" -eq 1 ]; then
    say "== 6. Organizations"
    ensure_org ORG_A_ID "$ORG_A_NAME" "ai-mcp e2e organization A" "$CONNECTION_ID"
    ensure_org ORG_B_ID "$ORG_B_NAME" "ai-mcp e2e organization B" "$CONNECTION_ID"
    ensure_user ORG_USER_ID ORG_USER_PW "$ORG_USER_EMAIL" AUTH0_E2E_ORG_USER_PASSWORD
    ensure_member "$ORG_A_ID" "$ORG_USER_ID" "$ORG_USER_EMAIL"
    [ -n "$ORG_USER_PW" ] || ORG_USER_PW="$(env_get AUTH0_E2E_ORG_USER_PASSWORD)"
  fi

  # --- 7. Env file ---
  say "== 7. Writing ${ENV_FILE}"
  if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$ENV_FILE" ]; then
    local old_umask
    old_umask="$(umask)"
    umask 077
    : >"$ENV_FILE"
    umask "$old_umask"
  fi
  env_set AUTH0_E2E_DOMAIN "$DOMAIN"
  env_set AUTH0_E2E_MCP_AUDIENCE "$MCP_URL"
  env_set AUTH0_E2E_DOWNSTREAM_AUDIENCE "$WORK_AUD"
  env_set AUTH0_E2E_DOWNSTREAM_SCOPE "$WORK_SCOPE"
  env_set AUTH0_E2E_OBO_CLIENT_ID "$EXCHANGE_ID"
  env_set AUTH0_E2E_OBO_CLIENT_SECRET "$EXCHANGE_SECRET"
  env_set AUTH0_E2E_LOGIN_CLIENT_ID "$LOGIN_ID"
  env_set AUTH0_E2E_LOGIN_CLIENT_SECRET "$LOGIN_SECRET"
  env_set AUTH0_E2E_USERNAME "$USERNAME"
  [ -z "$PASSWORD" ] || env_set AUTH0_E2E_PASSWORD "$PASSWORD"
  env_set AUTH0_E2E_REALM "$REALM"
  env_set AUTH0_E2E_M2M_CLIENT_ID "$M2M_ID"
  env_set AUTH0_E2E_M2M_CLIENT_SECRET "$M2M_SECRET"
  env_set AUTH0_E2E_ORDERS_AUDIENCE "$ORDERS_AUDIENCE"
  env_set AUTH0_E2E_INVENTORY_AUDIENCE "$INVENTORY_AUDIENCE"
  env_set AUTH0_E2E_ANALYTICS_AUDIENCE "$ANALYTICS_AUDIENCE"
  env_set AUTH0_E2E_LEDGER_AUDIENCE "$LEDGER_AUDIENCE"
  env_set AUTH0_E2E_LIMITED_CLIENT_ID "$LIMITED_ID"
  env_set AUTH0_E2E_LIMITED_CLIENT_SECRET "$LIMITED_SECRET"
  if [ "$WITH_ORG" -eq 1 ]; then
    env_set AUTH0_E2E_ORG_ID "$ORG_A_ID"
    env_set AUTH0_E2E_ORG_A_ID "$ORG_A_ID"
    env_set AUTH0_E2E_ORG_B_ID "$ORG_B_ID"
    env_set AUTH0_E2E_ORG_USER_USERNAME "$ORG_USER_EMAIL"
    [ -z "$ORG_USER_PW" ] || env_set AUTH0_E2E_ORG_USER_PASSWORD "$ORG_USER_PW"
    env_set AUTH0_E2E_AUTHCODE_CLIENT_ID "$AUTHCODE_ID"
    env_set AUTH0_E2E_AUTHCODE_CLIENT_SECRET "$AUTHCODE_SECRET"
    env_set AUTH0_E2E_AUTHCODE_REDIRECT_PORT "$AUTHCODE_PORT"
    # Not in the plan's env contract: the org tester client has no name there. Flagged for the integrator.
    env_set AUTH0_E2E_ORG_TESTER_CLIENT_ID "$TESTER_ID"
    env_set AUTH0_E2E_ORG_TESTER_CLIENT_SECRET "$TESTER_SECRET"
  fi
  if [ "$WITH_EXPIRY" -eq 1 ]; then
    env_set AUTH0_E2E_SHORT_MCP_AUDIENCE "$SHORT_MCP_AUDIENCE"
    env_set AUTH0_E2E_SHORT_DOWNSTREAM_AUDIENCE "$SHORT_DOWN_AUDIENCE"
    env_set AUTH0_E2E_SHORT_LIFETIME_SECONDS "$LIFETIME"
    # Not in the plan's env contract: the short APIs need an exchange client tied to the short MCP API.
    env_set AUTH0_E2E_SHORT_OBO_CLIENT_ID "$SHORT_EXCHANGE_ID"
    env_set AUTH0_E2E_SHORT_OBO_CLIENT_SECRET "$SHORT_EXCHANGE_SECRET"
  fi
  if [ "$WITH_T2" -eq 1 ]; then
    local claude_bin
    claude_bin="$(command -v claude 2>/dev/null || true)"
    [ -z "$claude_bin" ] || env_set AUTH0_E2E_CLAUDE_BIN "$claude_bin"
    env_set AUTH0_E2E_T2_PORT "$MCP_PORT"
    env_set AUTH0_E2E_T2_MCP_AUDIENCE "$MCP_URL"
    env_set AUTH0_E2E_T2_USERNAME "$USERNAME"
    [ -z "$PASSWORD" ] || env_set AUTH0_E2E_T2_PASSWORD "$PASSWORD"
  fi
  say "   keys:${ENV_TOUCHED}"
  [ "$DRY_RUN" -eq 1 ] || say "   file mode 600; secrets were written to the file only"
  say ""
  say "Done. Next: npm run e2e -- --check"
  say "Remove everything later with: scripts/e2e/tenant/teardown.sh"
}

# --- entry ------------------------------------------------------------------------------------------

if [ "$PRINT_LOGIN" -eq 1 ]; then
  need_cmd jq
  need_cmd openssl
  SCOPES="$(compute_scopes)"
  printf 'auth0 login --scopes "%s"\n' "$SCOPES"
  exit 0
fi

if [ "$SCOPES_ONLY" -eq 1 ]; then
  need_cmd jq
  need_cmd openssl
  compute_scopes
  exit 0
fi

# Preflight for a live run: compare the scopes this run needs to the CLI session's scopes when the CLI
# exposes them. `auth0 tenants list --json` is the only local listing; if it carries no scope field the
# script cannot tell, prints the command, and relies on the API error hint during the run.
if [ "$DRY_RUN" -eq 0 ] && [ "$CHECK_SETTINGS" -eq 0 ]; then
  need_cmd jq
  need_cmd openssl
  need_cmd auth0
  NEEDED="$(compute_scopes)"
  HAVE="$(auth0 tenants list --json 2>/dev/null | jq -r '[.[] | select(.active) | (.scopes // .scope // empty) | if type == "array" then .[] else (split("[ ,]+"; null) | .[]) end] | unique | .[]' 2>/dev/null || true)"
  if [ -n "$HAVE" ]; then
    MISSING="$(printf '%s' "$NEEDED" | tr ',' '\n' | sort -u | grep -vxFf <(printf '%s\n' "$HAVE") || true)"
    if [ -n "$MISSING" ]; then
      die "The Auth0 CLI session lacks scopes: $(printf '%s' "$MISSING" | paste -sd, -). Run: auth0 login --scopes \"${NEEDED}\""
    fi
  else
    say "Note: the Auth0 CLI does not report its session scopes, so they were not compared. If a call fails"
    say "with a scope error, run: auth0 login --scopes \"${NEEDED}\""
    say ""
  fi
fi

run_flow
