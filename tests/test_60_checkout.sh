#!/usr/bin/env bash
# Checkout credential detection + the documented workflow's checkout guidance.
T_NAME=checkout
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
source "$T_ROOT/scripts/lib.sh"; set +e

tmp=$(t_tmp); seed_protected_env "$tmp"
ws="$tmp/ws"; mkdir -p "$ws"; git -C "$ws" init -q

rg_checkout_credentials_persisted "$ws" >/dev/null; assert_eq "$RG_CHECKOUT_PERSISTED" "false" "fresh checkout: no persisted credentials"
git -C "$ws" config http.https://github.com/.extraheader "AUTHORIZATION: basic UExBQ0VIT0xERVJfTk9UX0FfUkVBTF9UT0tFTg=="
rg_checkout_credentials_persisted "$ws" >/dev/null; assert_eq "$RG_CHECKOUT_PERSISTED" "true" "actions/checkout extraheader (persist-credentials default) detected"
assert_contains "$RG_CHECKOUT_DETAIL" "extraheader" "detail names the mechanism"
git -C "$ws" config --unset http.https://github.com/.extraheader
rg_checkout_credentials_persisted "$ws" >/dev/null; assert_eq "$RG_CHECKOUT_PERSISTED" "false" "after removal: clean"
git -C "$ws" remote add origin "https://x-access-token:PLACEHOLDER_NOT_A_REAL_TOKEN@github.com/acme/widgets.git"
rg_checkout_credentials_persisted "$ws" >/dev/null; assert_eq "$RG_CHECKOUT_PERSISTED" "true" "credential embedded in remote URL detected"
git -C "$ws" remote set-url origin "https://github.com/acme/widgets.git"
rg_checkout_credentials_persisted "$ws" >/dev/null; assert_eq "$RG_CHECKOUT_PERSISTED" "false" "plain remote URL: clean"
rg_checkout_credentials_persisted "$tmp" >/dev/null; assert_eq "$RG_CHECKOUT_PERSISTED" "false" "non-git directory: false (no crash)"

# The documented workflow (README) and the CI workflow use least privilege and
# do not persist the token. (static_checks.py repeats this with a YAML parser;
# this is the shell-only version so the property is proven even without it.)
readme="$T_ROOT/README.md"
assert_contains "$(cat "$readme")" "persist-credentials: false" "README: persist-credentials: false documented"
blocks=$(awk '/^```ya?ml/{f=1;next} /^```/{f=0} f' "$readme")
checkout_lines=$(printf '%s\n' "$blocks" | grep -E 'uses: actions/checkout@' || true)
assert_ne "$checkout_lines" "" "README: has checkout steps in its workflows"
bad=$(printf '%s\n' "$checkout_lines" | grep -Ev 'actions/checkout@[0-9a-f]{40}' || true)
assert_eq "$bad" "" "README: every checkout is pinned to a 40-hex commit sha"
assert_not_contains "$blocks" "pull_request_target" "README workflows: no pull_request_target"
assert_not_contains "$blocks" "persist-credentials: true" "README workflows: never persist credentials"
assert_contains "$blocks" "contents: read" "README workflows: contents: read"
n_checkout=$(printf '%s\n' "$checkout_lines" | wc -l | tr -d ' ')
n_persist=$(printf '%s\n' "$blocks" | grep -c 'persist-credentials: false' || true)
assert_eq "$n_persist" "$n_checkout" "README: every documented checkout ($n_checkout) sets persist-credentials: false"
wf="$T_ROOT/.github/workflows/test.yml"
assert_contains "$(cat "$wf")" "persist-credentials: false" "CI workflow: persist-credentials: false"
assert_eq "$(grep -E 'uses: ' "$wf" | grep -Ev '@[0-9a-f]{40}' | wc -l | tr -d ' ')" "0" "CI workflow: every action pinned by sha"

rm -rf "$tmp"
t_done
