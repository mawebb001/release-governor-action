#!/usr/bin/env bash
# preflight.sh: missing-secret behaviour (fork skip vs. error), the AI gate
# per trust context, the unfunded notice, and the persisted-checkout check.
# The script only ever receives presence booleans; no value is in scope.
T_NAME=preflight
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

tmp=$(t_tmp); seed_protected_env "$tmp"
S="$T_ROOT/scripts/preflight.sh"
mkdir -p "$tmp/ws" && git -C "$tmp/ws" init -q
export GITHUB_WORKSPACE="$tmp/ws"

run_pf() { # LICENSE_PRESENT ANTHROPIC_PRESENT EVIDENCE TRUST AI_ALLOWED
  : > "$GITHUB_OUTPUT"
  PF_OUT=$(LICENSE_PRESENT="$1" ANTHROPIC_PRESENT="$2" EVIDENCE="$3" TRUST="$4" AI_ALLOWED="$5" bash "$S" 2>&1); PF_RC=$?
}

# fork PR without license: safe, documented skip
run_pf false false agents fork-pr false
assert_rc "$PF_RC" 0 "fork-pr without license exits 0"
assert_eq "$(out_get "$GITHUB_OUTPUT" proceed)" "false" "fork-pr without license: proceed=false"
assert_eq "$(out_get "$GITHUB_OUTPUT" outcome)" "skipped-fork-no-license" "fork-pr without license: outcome skipped-fork-no-license"
assert_contains "$PF_OUT" "::notice" "fork-pr without license: notice emitted"
assert_contains "$PF_OUT" "Nothing was installed" "fork-pr without license: states nothing ran"

# anything else without license: error, nothing proceeds
for t in same-repo-pr protected-branch trusted-manual branch-push pr-target merge-queue unknown-event; do
  run_pf false true agents "$t" false
  assert_rc "$PF_RC" 1 "$t without license exits 1"
  assert_eq "$(out_get "$GITHUB_OUTPUT" proceed)" "false" "$t without license: proceed=false"
  assert_eq "$(out_get "$GITHUB_OUTPUT" outcome)" "blocked-missing-license" "$t without license: outcome blocked-missing-license"
  assert_contains "$PF_OUT" "::error" "$t without license: error emitted"
done

# same-repo PR with BOTH secrets present: AI refused, key not exposed, governance proceeds
run_pf true true agents same-repo-pr false
assert_rc "$PF_RC" 0 "same-repo-pr with secrets exits 0"
assert_eq "$(out_get "$GITHUB_OUTPUT" proceed)" "true" "same-repo-pr: proceed=true"
assert_eq "$(out_get "$GITHUB_OUTPUT" ai_run)" "false" "same-repo-pr: ai_run=false (no credential-bearing AI execution)"
assert_eq "$(out_get "$GITHUB_OUTPUT" ai_evidence)" "refused-untrusted" "same-repo-pr: ai_evidence=refused-untrusted"
assert_contains "$PF_OUT" "NOT exposed to any process" "same-repo-pr: notice states the key was not exposed"
for t in fork-pr pr-target merge-queue branch-push manual-other-ref unknown-event not-actions; do
  run_pf true true agents "$t" false
  assert_eq "$(out_get "$GITHUB_OUTPUT" ai_run)" "false" "$t with key present: ai_run=false"
done

# trusted contexts: AI scheduled when funded, skipped-unfunded otherwise
for t in protected-branch trusted-manual; do
  run_pf true true agents "$t" true
  assert_eq "$(out_get "$GITHUB_OUTPUT" ai_run)" "true" "$t funded: ai_run=true"
  assert_eq "$(out_get "$GITHUB_OUTPUT" ai_evidence)" "scheduled" "$t funded: ai_evidence=scheduled"
  run_pf true false agents "$t" true
  assert_eq "$(out_get "$GITHUB_OUTPUT" ai_run)" "false" "$t unfunded: ai_run=false"
  assert_eq "$(out_get "$GITHUB_OUTPUT" ai_evidence)" "skipped-unfunded" "$t unfunded: ai_evidence=skipped-unfunded"
  assert_contains "$PF_OUT" "Evidence phase skipped" "$t unfunded: documented notice"
done
# the trust output is authoritative even if ai_allowed were mislabelled
run_pf true true agents same-repo-pr true
assert_eq "$(out_get "$GITHUB_OUTPUT" ai_run)" "true" "preflight trusts resolve-trust's ai_allowed (defense in depth lives in run-evidence.sh)"
# evidence: none
run_pf true true none protected-branch true
assert_eq "$(out_get "$GITHUB_OUTPUT" ai_run)" "false" "evidence=none: ai_run=false"
assert_eq "$(out_get "$GITHUB_OUTPUT" ai_evidence)" "disabled" "evidence=none: ai_evidence=disabled"

# persisted checkout credentials
git -C "$tmp/ws" config http.https://github.com/.extraheader "AUTHORIZATION: basic UExBQ0VIT0xERVJfTk9UX0FfUkVBTF9UT0tFTg=="
run_pf true true agents protected-branch true
assert_rc "$PF_RC" 1 "persisted checkout token + AI scheduled: fails closed"
assert_eq "$(out_get "$GITHUB_OUTPUT" proceed)" "false" "persisted + AI: proceed=false"
assert_eq "$(out_get "$GITHUB_OUTPUT" outcome)" "blocked-checkout-credentials" "persisted + AI: outcome blocked-checkout-credentials"
assert_eq "$(out_get "$GITHUB_OUTPUT" checkout_credentials_persisted)" "true" "persisted detected"
assert_contains "$PF_OUT" "persist-credentials: false" "persisted + AI: remediation named"
run_pf true true agents same-repo-pr false
assert_rc "$PF_RC" 0 "persisted checkout token on a PR (no AI): continues"
assert_contains "$PF_OUT" "::warning" "persisted on a PR: warning emitted"
assert_eq "$(out_get "$GITHUB_OUTPUT" proceed)" "true" "persisted on a PR: governance proceeds"
git -C "$tmp/ws" config --unset http.https://github.com/.extraheader
run_pf true true agents protected-branch true
assert_rc "$PF_RC" 0 "clean checkout + AI scheduled: proceeds"
assert_eq "$(out_get "$GITHUB_OUTPUT" checkout_credentials_persisted)" "false" "clean checkout detected"

# the script's own environment never needs a value: run it with every secret unset
: > "$GITHUB_OUTPUT"
out=$(env -u ES_LICENSE_KEY -u ANTHROPIC_API_KEY LICENSE_PRESENT=true ANTHROPIC_PRESENT=true EVIDENCE=agents TRUST=protected-branch AI_ALLOWED=true bash "$S" 2>&1); rc=$?
assert_rc "$rc" 0 "preflight works with no secret values in its environment at all"

rm -rf "$tmp"
t_done
