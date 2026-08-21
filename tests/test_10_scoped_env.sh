#!/usr/bin/env bash
# rg_scoped_exec: the allowlist, the hard deny, named pass-through, OIDC pair.
# Proves: install-time / agent / governor children cannot see protected names
# unless a step passes them by name; OIDC variables are not inherited.
T_NAME=scoped-env
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
source "$T_ROOT/scripts/lib.sh"; set +e

tmp=$(t_tmp); seed_protected_env "$tmp"
export LC_ALL=C XDG_RUNTIME_DIR=/run/placeholder HTTPS_PROXY=http://proxy.placeholder.invalid:3128

# 1. default child: allowlisted coordinates present, every protected name absent
names=" $(rg_scoped_exec -- bash -c 'compgen -e | sort | tr "\n" " "') "
for n in "${RG_TEST_PROTECTED_NAMES[@]}" NODE_OPTIONS npm_config_registry NPM_CONFIG_LOGLEVEL GITHUB_ENV GITHUB_PATH GITHUB_OUTPUT GITHUB_STATE GITHUB_STEP_SUMMARY RUNNER_TEMP; do
  assert_not_contains "$names" " $n " "child does not see $n"
done
for n in PATH HOME GITHUB_REPOSITORY GITHUB_SHA GITHUB_ACTIONS LC_ALL XDG_RUNTIME_DIR HTTPS_PROXY RUNNER_OS CI; do
  assert_contains "$names" " $n " "child sees allowlisted $n"
done
vals=$(rg_scoped_exec -- bash -c 'env | grep -c PLACEHOLDER'); assert_eq "${vals:-0}" "0" "no placeholder VALUE is readable by a default child"

# 2. named pass-through: exactly the one name
got=$(rg_scoped_exec --pass ANTHROPIC_API_KEY -- bash -c 'env | grep PLACEHOLDER | cut -d= -f1 | sort | tr "\n" " "')
assert_eq "$got" "ANTHROPIC_API_KEY " "--pass ANTHROPIC_API_KEY reaches the child alone"
got=$(rg_scoped_exec --pass ES_LICENSE_KEY -- bash -c 'env | grep PLACEHOLDER | cut -d= -f1 | sort | tr "\n" " "')
assert_eq "$got" "ES_LICENSE_KEY " "--pass ES_LICENSE_KEY reaches the child alone"

# 3. refusals happen before any spawn
for n in GITHUB_TOKEN GH_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_RUNTIME_TOKEN NPM_TOKEN NODE_AUTH_TOKEN NODE_OPTIONS AWS_SECRET_ACCESS_KEY STRIPE_SECRET_KEY RG_TEST_CANARY GITHUB_ENV GITHUB_OUTPUT INPUT_LICENSE_KEY npm_config_registry PATH; do
  rg_scoped_exec --pass "$n" -- touch "$tmp/spawned-$n" >/dev/null 2>&1; rc=$?
  assert_rc "$rc" 2 "--pass $n is refused (rc 2)"
  assert_file_absent "$tmp/spawned-$n" "--pass $n spawned nothing"
done
rg_scoped_exec --bogus -- touch "$tmp/spawned-bogus" >/dev/null 2>&1; assert_rc $? 2 "unknown option refused"
assert_file_absent "$tmp/spawned-bogus" "unknown option spawned nothing"
rg_scoped_exec -- >/dev/null 2>&1; assert_rc $? 2 "missing command refused"

# 4. OIDC pair only via --pass-oidc, and only the pair
got=$(rg_scoped_exec --pass-oidc -- bash -c 'env | grep PLACEHOLDER | cut -d= -f1 | sort | tr "\n" " "')
assert_eq "$got" "ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL " "--pass-oidc passes exactly the OIDC request pair"
names=" $(rg_scoped_exec --pass-oidc -- bash -c 'compgen -e | sort | tr "\n" " "') "
assert_not_contains "$names" " ACTIONS_RUNTIME_TOKEN " "--pass-oidc does not leak ACTIONS_RUNTIME_TOKEN"
assert_not_contains "$names" " ACTIONS_RESULTS_URL " "--pass-oidc does not leak ACTIONS_RESULTS_URL"
assert_not_contains "$names" " GITHUB_TOKEN " "--pass-oidc does not leak GITHUB_TOKEN"

# 5. the govern shape: license + OIDC, nothing else
got=$(rg_scoped_exec --pass ES_LICENSE_KEY --pass-oidc -- bash -c 'env | grep PLACEHOLDER | cut -d= -f1 | sort | tr "\n" " "')
assert_eq "$got" "ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL ES_LICENSE_KEY " "govern shape: ES_LICENSE_KEY + OIDC pair only"

# 6. when the runner did NOT grant id-token, --pass-oidc passes nothing extra
( unset ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL
  got=$(rg_scoped_exec --pass ES_LICENSE_KEY --pass-oidc -- bash -c 'env | grep PLACEHOLDER | cut -d= -f1 | sort | tr "\n" " "')
  assert_eq "$got" "ES_LICENSE_KEY " "--pass-oidc without id-token grant passes only the license"
  t_done >/dev/null ) ; [ $? -eq 0 ] && t_ok "subshell checks passed" || t_fail "subshell checks failed"

# 7. exit status of the child propagates
rg_scoped_exec -- bash -c 'exit 7' >/dev/null 2>&1; assert_rc $? 7 "child exit status propagates"

# 8. a grandchild inherits only the scoped environment (models CLI -> agent)
got=$(rg_scoped_exec --pass ANTHROPIC_API_KEY -- bash -c 'bash -c "env | grep PLACEHOLDER | cut -d= -f1 | sort | tr \"\n\" \" \""')
assert_eq "$got" "ANTHROPIC_API_KEY " "grandchild sees only what the child was passed"

rm -rf "$tmp"
t_done
