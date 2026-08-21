#!/usr/bin/env bash
# Test helpers. Sourced by every tests/test_*.sh.
#
# EVERY credential-looking value in these tests is a placeholder that contains
# the word PLACEHOLDER. No test contacts the registry, the Enterprise Skills
# API, Anthropic, or GitHub; the CLI and the agent are replaced by stubs that
# record what they were given. Nothing here is a real credential or a
# production operation.
set -uo pipefail

T_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export GITHUB_ACTION_PATH="$T_ROOT"
T_NAME="${T_NAME:-$(basename "${BASH_SOURCE[1]:-test}" .sh)}"
T_PASS=0; T_FAIL=0

t_ok()   { printf '  ok   %s\n' "$1"; T_PASS=$((T_PASS+1)); }
t_fail() { printf '  FAIL %s\n' "$1"; T_FAIL=$((T_FAIL+1)); }
assert_eq()           { if [ "$1" = "$2" ]; then t_ok "$3"; else t_fail "$3 (expected '$2', got '$1')"; fi; }
assert_ne()           { if [ "$1" != "$2" ]; then t_ok "$3"; else t_fail "$3 (did not expect '$2')"; fi; }
assert_contains()     { case "$1" in *"$2"*) t_ok "$3" ;; *) t_fail "$3 (missing '$2' in: ${1:0:300})" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) t_fail "$3 (unexpected '$2' in: ${1:0:300})" ;; *) t_ok "$3" ;; esac; }
assert_rc()           { if [ "$1" -eq "$2" ]; then t_ok "$3"; else t_fail "$3 (expected rc $2, got $1)"; fi; }
assert_file_exists()  { if [ -e "$1" ]; then t_ok "$2"; else t_fail "$2 (missing $1)"; fi; }
assert_file_absent()  { if [ ! -e "$1" ]; then t_ok "$2"; else t_fail "$2 (unexpected $1)"; fi; }
t_done() {
  printf '%s: %d passed, %d failed\n' "$T_NAME" "$T_PASS" "$T_FAIL"
  [ "$T_FAIL" -eq 0 ]
}
t_tmp() { mktemp -d "${TMPDIR:-/tmp}/rg-test.XXXXXX"; }

# Read `key=value` from a GITHUB_OUTPUT-style file (last write wins).
out_get() { grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2- ; }

# Names that must never reach an install, agent or governor process unless a
# step passes them by name. Values are placeholders.
RG_TEST_PROTECTED_NAMES=(
  ES_LICENSE_KEY ENTERPRISE_SKILLS_LICENSE_KEY ANTHROPIC_API_KEY
  GITHUB_TOKEN GH_TOKEN GH_ENTERPRISE_TOKEN
  ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL
  ACTIONS_RUNTIME_TOKEN ACTIONS_RUNTIME_URL ACTIONS_RESULTS_URL ACTIONS_CACHE_URL
  NPM_TOKEN NODE_AUTH_TOKEN
  AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN STRIPE_SECRET_KEY SUPABASE_SERVICE_ROLE_KEY
  INPUT_LICENSE_KEY INPUT_ANTHROPIC_API_KEY
  RG_TEST_CANARY
)
# Seeds the parent shell the way a hostile/ careless job could look: secrets at
# job level, OIDC injected, npm/Node injection vectors, runner file commands.
# $1 = temp dir for the runner file-command files.
seed_protected_env() {
  local d="$1" n
  for n in "${RG_TEST_PROTECTED_NAMES[@]}"; do export "$n=PLACEHOLDER_${n}_NOT_A_REAL_SECRET"; done
  export ACTIONS_ID_TOKEN_REQUEST_URL="https://placeholder.invalid/oidc?PLACEHOLDER_NOT_A_REAL_URL"
  export NODE_OPTIONS="--title=PLACEHOLDER_NODE_OPTIONS"              # valid option, so the parent's node still runs
  export npm_config_registry="https://registry.placeholder.invalid/PLACEHOLDER"
  export NPM_CONFIG_LOGLEVEL="PLACEHOLDER_NPM_CONFIG"
  export GITHUB_ENV="$d/github_env" GITHUB_PATH="$d/github_path" GITHUB_STATE="$d/github_state" GITHUB_STEP_SUMMARY="$d/github_step_summary"
  export GITHUB_OUTPUT="$d/github_output"
  : > "$GITHUB_OUTPUT"
  # Non-secret coordinates a real runner provides.
  export GITHUB_ACTIONS=true GITHUB_REPOSITORY=acme/widgets GITHUB_REPOSITORY_OWNER=acme
  export GITHUB_SHA=0123456789abcdef0123456789abcdef01234567 GITHUB_RUN_ID=1 GITHUB_ACTOR=tester
  export GITHUB_SERVER_URL=https://github.com GITHUB_API_URL=https://api.github.com
  export RUNNER_OS=Linux RUNNER_ARCH=X64 RUNNER_TEMP="$d" CI=true
}

# make_stub <dir> <name>
# A stand-in executable that appends a record of its argv, its environment
# NAMES, and which names carried a PLACEHOLDER value to <dir>/<name>.calls.
# It never prints values. If <dir>/<name>.exit exists its content is the exit
# code. If <dir>/<name>.spawn exists, the stub execs that command afterwards
# (used to model the CLI spawning the agent with its own environment).
make_stub() {
  local dir="$1" name="$2"
  cat > "$dir/$name" <<STUB
#!/usr/bin/env bash
{
  printf 'ARGV: %s\n' "\$*"
  printf 'ENV_NAMES: %s\n' "\$(compgen -e | sort | tr '\n' ' ')"
  printf 'PLACEHOLDER_NAMES: %s\n' "\$(env | grep PLACEHOLDER | cut -d= -f1 | sort | tr '\n' ' ')"
  printf 'CWD: %s\n' "\$PWD"
  printf -- '---\n'
} >> "$dir/$name.calls"
if [ -f "$dir/$name.spawn" ]; then "\$(cat "$dir/$name.spawn")" --probe-from-$name; fi
if [ -f "$dir/$name.exit" ]; then exit "\$(cat "$dir/$name.exit")"; fi
exit 0
STUB
  chmod +x "$dir/$name"
}

# stub_field <calls-file> <FIELD> [record-index, 1-based; default 1]
stub_field() {
  local f="$1" field="$2" idx="${3:-1}"
  awk -v want="$idx" -v fld="$field:" 'BEGIN{n=1} $0=="---"{n++; next} n==want && index($0, fld)==1 {sub(fld" ?", ""); print}' "$f"
}
stub_calls() { [ -f "$1" ] && grep -c '^---$' "$1" || echo 0; }
