#!/usr/bin/env bash
# Offline tests for setup.sh, teardown.sh and lib.sh. A stub `auth0` binary on PATH keeps a small
# in-memory tenant in a JSON file and records every call, so nothing here touches a real tenant.
#
#   scripts/e2e/tenant/test.sh
#
# Needs bash, jq and openssl. Runs shellcheck when it is installed.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP="${HERE}/setup.sh"
TEARDOWN="${HERE}/teardown.sh"
CIMD_URL="https://claude.ai/oauth/claude-code-client-metadata"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/e2e-tenant-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
BIN="${WORK}/bin"
mkdir -p "$BIN"
export STUB_DB="${WORK}/db.json"
export STUB_LOG="${WORK}/calls.log"
STATE="${WORK}/state.json"
ENVF="${WORK}/env.e2e"
OUT="${WORK}/out.txt"

PASS=0
FAIL=0
ok() {
  # ok NAME CONDITION_EXIT_CODE
  if [ "$2" -eq 0 ]; then PASS=$((PASS + 1)); printf 'ok      %s\n' "$1"; else FAIL=$((FAIL + 1)); printf 'FAILED  %s\n' "$1"; fi
}
file_mode() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1" 2>/dev/null; }
check() { local name="$1"; shift; if "$@"; then ok "$name" 0; else ok "$name" 1; fi; }
has() { grep -q -- "$2" "$1"; }
hasnt() { ! grep -q -- "$2" "$1"; }

# --- the stub ---------------------------------------------------------------------------------------

cat >"${BIN}/auth0" <<'STUB'
#!/usr/bin/env bash
# Stub of the Auth0 CLI: `auth0 tenants list --json` and `auth0 api METHOD PATH` over a JSON file.
set -u
if [ "${1:-}" = tenants ]; then printf '[{"name":"stub.us.auth0.com","active":true}]'; exit 0; fi
[ "${1:-}" = api ] || exit 2
method="$2"; path="$3"
body="$(cat)"
printf '%s %s\n' "$method" "$path" >>"$STUB_LOG"
query=""
case "$path" in *\?*) query="${path#*\?}"; path="${path%%\?*}" ;; esac
qget() { printf '%s' "$query" | tr '&' '\n' | grep "^$1=" | head -1 | cut -d= -f2-; }
db="$(cat "$STUB_DB")"
save() { printf '%s' "$1" >"$STUB_DB"; }
notfound() { printf '{"statusCode":404,"errorCode":"not_found","message":"not found"}'; }
keyfor() { case "$1" in clients) echo client_id ;; users) echo user_id ;; *) echo id ;; esac; }
prefix() { case "$1" in resource-servers) echo rs ;; clients) echo cli ;; client-grants) echo cgr ;; connections) echo con ;; organizations) echo org ;; users) echo usr ;; esac; }

IFS=/ read -r seg1 seg2 seg3 <<<"$path"
case "$seg1" in
  tenants)
    printf '{"client_id_metadata_document_supported":true,"resource_parameter_profile":"compatibility","authorization_response_iss_parameter_supported":true}'
    exit 0 ;;
  users-by-email)
    email="$(qget email)"
    printf '%s' "$db" | jq -c --arg e "$email" '[.users[] | select(.email == $e)]'
    exit 0 ;;
esac

coll="$seg1"
key="$(keyfor "$coll")"
case "$coll" in resource-servers | clients | client-grants | connections | organizations | users) ;; *) notfound; exit 0 ;; esac

# sub-resources
if [ -n "${seg3:-}" ]; then
  id="$seg2"
  case "$coll/$seg3" in
    organizations/members)
      if [ "$method" = get ]; then printf '%s' "$db" | jq -c --arg o "$id" '[(.members[$o] // [])[] | {user_id: .}]'
      else save "$(printf '%s' "$db" | jq -c --arg o "$id" --argjson b "$body" '.members[$o] = ((.members[$o] // []) + $b.members | unique)')"; printf '{}'; fi
      exit 0 ;;
    organizations/enabled_connections)
      if [ "$method" = get ]; then printf '%s' "$db" | jq -c --arg o "$id" '(.enabled[$o] // [])'
      else save "$(printf '%s' "$db" | jq -c --arg o "$id" --argjson b "$body" '.enabled[$o] = ((.enabled[$o] // []) + [{connection_id: $b.connection_id}])')"; printf '{}'; fi
      exit 0 ;;
    connections/clients)
      save "$(printf '%s' "$db" | jq -c --arg c "$id" --argjson b "$body" '.conn_clients[$c] = $b')"; printf '{}'; exit 0 ;;
  esac
  notfound; exit 0
fi

if [ -z "${seg2:-}" ]; then
  case "$method" in
    get)
      if [ "$coll" = client-grants ]; then
        printf '%s' "$db" | jq -c --arg c "$(qget client_id)" --arg a "$(qget audience)" '[.["client-grants"][] | select(($c == "" or .client_id == $c) and ($a == "" or .audience == $a))]'
      else
        printf '%s' "$db" | jq -c --arg c "$coll" '.[$c]'
      fi ;;
    post)
      n="$(printf '%s' "$db" | jq '.counter + 1')"
      id="$(prefix "$coll")_${n}"
      [ "$coll" = users ] && id="auth0|${id}"
      obj="$(printf '%s' "$body" | jq -c --arg k "$key" --arg id "$id" --arg c "$coll" '
        . + {($k): $id}
        | if $c == "clients" then . + {client_secret: ("stubsecret-" + $id), grant_types: (.grant_types // [])} else . end
        | if $c == "connections" then . + {is_domain_connection: (.is_domain_connection // false)} else . end
        | if $c == "users" then . + {identities: [{connection: .connection}]} else . end')"
      db="$(printf '%s' "$db" | jq -c --arg c "$coll" --argjson o "$obj" '.[$c] += [$o] | .counter += 1')"
      save "$db"
      printf '%s' "$obj" | jq -c 'del(.password)' ;;
    *) notfound ;;
  esac
  exit 0
fi

id="$seg2"
exists="$(printf '%s' "$db" | jq -r --arg c "$coll" --arg k "$key" --arg id "$id" '[.[$c][] | select(.[$k] == $id)] | length')"
[ "$exists" = 1 ] || { notfound; exit 0; }
case "$method" in
  get) printf '%s' "$db" | jq -c --arg c "$coll" --arg k "$key" --arg id "$id" '[.[$c][] | select(.[$k] == $id)] | first' ;;
  patch)
    save "$(printf '%s' "$db" | jq -c --arg c "$coll" --arg k "$key" --arg id "$id" --argjson b "$body" '.[$c] |= map(if .[$k] == $id then . * ($b | del(.password)) else . end)')"
    printf '{}' ;;
  delete)
    save "$(printf '%s' "$db" | jq -c --arg c "$coll" --arg k "$key" --arg id "$id" '.[$c] |= map(select(.[$k] != $id))')"
    printf '{}' ;;
esac
STUB
chmod +x "${BIN}/auth0"

reset_tenant() {
  # A tenant that already holds three objects this suite must never touch.
  jq -nc --arg u "$CIMD_URL" '{counter: 100, "resource-servers": [{id: "rs_foreign", name: "somebody else API", identifier: "https://other.example"}],
    clients: [{client_id: "cli_foreign", name: "somebody else client"}, {client_id: "cli_cimd", name: "Claude Code", external_client_id: $u}],
    "client-grants": [], connections: [], organizations: [], users: [], members: {}, enabled: {}, conn_clients: {}}' >"$STUB_DB"
  : >"$STUB_LOG"
  rm -f "$STATE" "$ENVF"
}

run_setup() { PATH="${BIN}:${PATH}" "$SETUP" --state-file "$STATE" --env-file "$ENVF" "$@" >"$OUT" 2>&1; }
run_teardown() { PATH="${BIN}:${PATH}" "$TEARDOWN" --state-file "$STATE" "$@" >"$OUT" 2>&1; }
mutating_calls() { grep -Ec '^(post|patch|put|delete) ' "$STUB_LOG" || true; }

ALL="--with-org --with-expiry --with-t2"

# --- print-login-command ----------------------------------------------------------------------------

printf '== login command\n'
PATH="/usr/bin:/bin:$(dirname "$(command -v jq)"):$(dirname "$(command -v openssl)")" "$SETUP" --print-login-command >"$OUT" 2>&1
ok "print-login-command exits 0 without the auth0 CLI" $?
has "$OUT" '^auth0 login --scopes "'; ok "prints an auth0 login command" $?
has "$OUT" 'create:client_grants'; ok "includes create:client_grants" $?
has "$OUT" 'read:client_keys'; ok "includes read:client_keys (secrets are read)" $?
hasnt "$OUT" 'update:client_grants'; ok "does not need update:client_grants" $?
hasnt "$OUT" 'organization_members'; ok "no organization scopes without --with-org" $?
"$SETUP" --print-login-command --with-org >"$OUT" 2>&1
has "$OUT" 'create:organization_members'; ok "--with-org adds create:organization_members" $?
has "$OUT" 'create:organization_connections'; ok "--with-org adds create:organization_connections" $?
has "$OUT" 'delete:organizations'; ok "teardown scopes are included" $?

# --- dry run ----------------------------------------------------------------------------------------

printf '== dry run\n'
reset_tenant
# shellcheck disable=SC2086
run_setup --dry-run $ALL
ok "dry run exits 0" $?
check "dry run never invokes the auth0 CLI" [ ! -s "$STUB_LOG" ]
ok "dry run writes neither state nor env file" "$([ ! -e "$STATE" ] && [ ! -e "$ENVF" ] && echo 0 || echo 1)"
for pat in 'post "resource-servers"' 'post "clients"' 'post "client-grants"' 'post "connections"' 'post "users"' 'post "organizations"' 'enabled_connections' '/members"'; do
  has "$OUT" "DRY-RUN  auth0 api ${pat}\|DRY-RUN  auth0 api post \"organizations/.*${pat}"; ok "dry run prints: ${pat}" $?
done
check "dry run plans all eight APIs" [ "$(grep -c 'post "resource-servers"' "$OUT")" -ge 8 ]
hasnt "$OUT" 'DRYRUN_SECRET'; ok "dry run prints no secret placeholder" $?

# --- first live run ---------------------------------------------------------------------------------

printf '== live run against the stub\n'
reset_tenant
# shellcheck disable=SC2086
run_setup --yes $ALL
ok "first run exits 0" $?
cp "$OUT" "${WORK}/out-first.txt"
check "env file has mode 600" [ "$(file_mode "$ENVF")" = 600 ]
check "state file has mode 600" [ "$(file_mode "$STATE")" = 600 ]
for name in AUTH0_E2E_DOMAIN AUTH0_E2E_MCP_AUDIENCE AUTH0_E2E_DOWNSTREAM_AUDIENCE AUTH0_E2E_OBO_CLIENT_ID AUTH0_E2E_OBO_CLIENT_SECRET \
  AUTH0_E2E_LOGIN_CLIENT_ID AUTH0_E2E_LOGIN_CLIENT_SECRET AUTH0_E2E_USERNAME AUTH0_E2E_PASSWORD AUTH0_E2E_REALM AUTH0_E2E_M2M_CLIENT_ID \
  AUTH0_E2E_M2M_CLIENT_SECRET AUTH0_E2E_ORDERS_AUDIENCE AUTH0_E2E_INVENTORY_AUDIENCE AUTH0_E2E_ANALYTICS_AUDIENCE AUTH0_E2E_LEDGER_AUDIENCE \
  AUTH0_E2E_LIMITED_CLIENT_ID AUTH0_E2E_LIMITED_CLIENT_SECRET AUTH0_E2E_ORG_ID AUTH0_E2E_ORG_A_ID AUTH0_E2E_ORG_B_ID AUTH0_E2E_ORG_USER_USERNAME \
  AUTH0_E2E_ORG_USER_PASSWORD AUTH0_E2E_AUTHCODE_CLIENT_ID AUTH0_E2E_AUTHCODE_CLIENT_SECRET AUTH0_E2E_AUTHCODE_REDIRECT_PORT \
  AUTH0_E2E_SHORT_MCP_AUDIENCE AUTH0_E2E_SHORT_DOWNSTREAM_AUDIENCE AUTH0_E2E_SHORT_LIFETIME_SECONDS AUTH0_E2E_T2_PORT AUTH0_E2E_T2_MCP_AUDIENCE \
  AUTH0_E2E_T2_USERNAME AUTH0_E2E_T2_PASSWORD; do
  grep -q "^${name}=." "$ENVF"; ok "env file has ${name}" $?
done
has "$ENVF" '^AUTH0_E2E_MCP_AUDIENCE=http://localhost:3011/mcp$'; ok "MCP audience is the fixed T2 URL" $?
has "$ENVF" '^AUTH0_E2E_T2_MCP_AUDIENCE=http://localhost:3011/mcp$'; ok "T2 audience equals the MCP audience" $?
has "$ENVF" '^AUTH0_E2E_AUTHCODE_REDIRECT_PORT=3015$'; ok "auth-code redirect port written" $?
has "$ENVF" '^AUTH0_E2E_OBO_CLIENT_SECRET=stubsecret-'; ok "the secret reached the env file" $?
PW="$(grep '^AUTH0_E2E_PASSWORD=' "$ENVF" | cut -d= -f2-)"
hasnt "${WORK}/out-first.txt" 'stubsecret'; ok "no client secret on the terminal" $?
hasnt "${WORK}/out-first.txt" "$PW"; ok "no test user password on the terminal" $?
jq -e '.tenants["stub.us.auth0.com"].created | (.apis | length) == 8 and (.clients | length) == 7 and (.grants | length) >= 14 and (.organizations | length) == 2 and (.users | length) == 2' "$STATE" >/dev/null
ok "state file records the created ids" $?
jq -e '[.tenants[].created.clients[].id] | index("cli_foreign") == null' "$STATE" >/dev/null; ok "state never records the foreign client" $?
jq -e '.tenants["stub.us.auth0.com"].created.refs | map(.id) | index("cli_cimd") != null' "$STATE" >/dev/null; ok "the Claude Code client is recorded as a reference" $?
jq -e '[.["client-grants"][] | select(.client_id == "cli_cimd")] | length == 1' "$STUB_DB" >/dev/null; ok "a grant was added for the Claude Code client" $?
jq -e '.clients | map(select(.client_id == "cli_cimd")) | first | has("token_exchange") | not' "$STUB_DB" >/dev/null; ok "the Claude Code client itself was not modified" $?
jq -e '[.connections[] | select(.name == "ai-mcp-e2e-users")] | first | .is_domain_connection == true' "$STUB_DB" >/dev/null; ok "--with-t2 created a domain-level connection" $?
jq -e '.["resource-servers"] | map(select(.identifier == "https://short-mcp.ai-mcp-e2e.test")) | first | .token_lifetime == 30' "$STUB_DB" >/dev/null; ok "short API got the token lifetime" $?
jq -e '.["client-grants"] | map(select(.audience == "https://ledger.ai-mcp-e2e.test")) | all(.scope == ["read:ledger"])' "$STUB_DB" >/dev/null; ok "ledger is granted read only" $?

# --- second run -------------------------------------------------------------------------------------

printf '== second run\n'
: >"$STUB_LOG"
# shellcheck disable=SC2086
run_setup --yes $ALL
ok "second run exits 0" $?
hasnt "$OUT" '^   created'; ok "second run creates nothing" $?
check "second run reports exists for the objects" [ "$(grep -c '^   exists' "$OUT")" -ge 20 ]
check "second run makes no POST or DELETE call" [ "$(grep -Ec '^post |^delete ' "$STUB_LOG")" -eq 0 ]
check "second run only re-asserts the connection client list" [ "$(grep -E '^(patch|put) ' "$STUB_LOG" | grep -vc '^patch connections/[^/]*/clients$')" -eq 0 ]
hasnt "$OUT" 'stubsecret'; ok "second run prints no secret" $?
PW2="$(grep '^AUTH0_E2E_PASSWORD=' "$ENVF" | cut -d= -f2-)"
check "the saved test user password is kept" [ "$PW" = "$PW2" ]

# --- check-settings is read only --------------------------------------------------------------------

printf '== check settings\n'
: >"$STUB_LOG"
run_setup --check-settings
ok "--check-settings exits 0" $?
check "--check-settings makes only GET calls" [ "$(mutating_calls)" -eq 0 ]
check "--check-settings does call the tenant" [ -s "$STUB_LOG" ]
has "$OUT" 'S1 Resource Parameter Compatibility Profile: on'; ok "reports S1" $?
has "$OUT" 'S4 Include issuer in authorization responses: on'; ok "reports S4" $?

# --- refusal of unrecorded objects --------------------------------------------------------------------

printf '== unrecorded objects\n'
cp "$STATE" "${WORK}/state.keep"
rm -f "$STATE"
: >"$STUB_LOG"
# shellcheck disable=SC2086
run_setup --yes $ALL
check "setup refuses objects it did not record" [ $? -ne 0 ]
has "$OUT" 'only modifies objects it created'; ok "refusal explains --adopt" $?
check "refusal happens before any mutating call" [ "$(mutating_calls)" -eq 0 ]
cp "${WORK}/state.keep" "$STATE"

# --- teardown ---------------------------------------------------------------------------------------

printf '== teardown\n'
: >"$STUB_LOG"
run_teardown --dry-run
ok "teardown --dry-run exits 0" $?
check "teardown --dry-run calls nothing" [ ! -s "$STUB_LOG" ]
has "$OUT" 'DELETE apis'; ok "teardown --dry-run lists recorded objects" $?
hasnt "$OUT" 'cli_cimd'; ok "teardown --dry-run does not list the referenced client" $?

RECORDED="$(jq -r '.tenants["stub.us.auth0.com"].created | to_entries[] | select(.key != "refs") | .value[] | .id' "$STATE" | sort)"
run_teardown --yes
ok "teardown exits 0" $?
DELETED="$(grep '^delete ' "$STUB_LOG" | sed 's|^delete [^/]*/||' | sort)"
check "teardown deleted exactly the recorded ids" [ "$RECORDED" = "$DELETED" ]
jq -e '[.clients[].client_id] | index("cli_foreign") != null and index("cli_cimd") != null' "$STUB_DB" >/dev/null; ok "foreign and referenced clients survive" $?
jq -e '[.["resource-servers"][].id] == ["rs_foreign"]' "$STUB_DB" >/dev/null; ok "only the foreign API remains" $?
check "state file is removed once everything is gone" [ ! -e "$STATE" ]
hasnt "$OUT" 'stubsecret'; ok "teardown prints no secret" $?

printf '== teardown refusals\n'
reset_tenant
jq -nc '{tenants: {"stub.us.auth0.com": {created: {clients: [{id: "cli_foreign", name: "ai-mcp-e2e wrong name"}], apis: [{id: "../resource-servers/rs_foreign", name: "x"}]}}}}' >"$STATE"
run_teardown --yes
check "teardown exits non-zero when it refuses something" [ $? -ne 0 ]
has "$OUT" 'NOT deleting ai-mcp-e2e wrong name'; ok "refuses a recorded id whose live name differs" $?
has "$OUT" 'unexpected characters'; ok "skips a malformed recorded id" $?
check "no delete call was made" [ "$(grep -c '^delete ' "$STUB_LOG")" -eq 0 ]
jq -e '[.clients[].client_id] | index("cli_foreign") != null' "$STUB_DB" >/dev/null; ok "the foreign client is untouched" $?
jq -nc '{tenants: {"other.us.auth0.com": {created: {clients: [{id: "cli_foreign", name: "somebody else client"}]}}}}' >"$STATE"
: >"$STUB_LOG"
run_teardown --yes
has "$OUT" 'nothing to delete'; ok "state of another tenant is ignored" $?
check "no mutation for another tenant's state" [ "$(mutating_calls)" -eq 0 ]

# --- referenced objects -----------------------------------------------------------------------------

printf '== referenced existing objects\n'
reset_tenant
run_setup --yes --existing-work-api rs_foreign --existing-m2m-client cli_foreign
ok "setup with existing work API and m2m client exits 0" $?
has "$ENVF" '^AUTH0_E2E_DOWNSTREAM_AUDIENCE=https://other.example$'; ok "downstream audience comes from the existing API" $?
has "$ENVF" '^AUTH0_E2E_M2M_CLIENT_ID=cli_foreign$'; ok "m2m client id comes from the existing client" $?
jq -e '.["resource-servers"] | map(select(.id == "rs_foreign")) | first | (keys | sort) == ["id","identifier","name"]' "$STUB_DB" >/dev/null; ok "the existing API was not modified" $?
jq -e '.clients | map(select(.client_id == "cli_foreign")) | first | (keys | sort) == ["client_id","name"]' "$STUB_DB" >/dev/null; ok "the existing client was not modified" $?
jq -e '[.["client-grants"][] | select(.client_id == "cli_foreign")] | length == 2' "$STUB_DB" >/dev/null; ok "grants were added for the existing m2m client" $?
run_teardown --yes
ok "teardown after referenced setup exits 0" $?
jq -e '[.clients[].client_id] | index("cli_foreign") != null' "$STUB_DB" >/dev/null; ok "teardown keeps the referenced client" $?
jq -e '[.["client-grants"][] | select(.client_id == "cli_foreign")] | length == 0' "$STUB_DB" >/dev/null; ok "teardown removes the grants it added for it" $?
jq -e '[.["resource-servers"][].id] == ["rs_foreign"]' "$STUB_DB" >/dev/null; ok "teardown keeps the referenced API" $?

# --- static checks ----------------------------------------------------------------------------------

printf '== static\n'
for f in setup.sh teardown.sh lib.sh test.sh README.md; do
  ! grep -q $'\xe2\x80\x94\|\xe2\x80\x93' "${HERE}/${f}"; ok "no em or en dashes in ${f}" $?
done
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -x "${HERE}/setup.sh" "${HERE}/teardown.sh" "${HERE}/lib.sh" "${HERE}/test.sh"; ok "shellcheck is clean" $?
else
  printf 'skip    shellcheck is not installed\n'
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
