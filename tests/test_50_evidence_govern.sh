#!/usr/bin/env bash
# run-evidence.sh and run-govern.sh against stub CLIs that record their
# environment NAMES and argv. Proves:
#   - untrusted PR analysis never spawns an agent even with the key present
#   - the evidence child (and the agent it spawns) see ANTHROPIC_API_KEY only
#   - the governor sees ES_LICENSE_KEY (+ OIDC pair when granted) only
#   - OIDC request variables are not inherited by the evidence child
#   - base resolution, argv shape, fail-closed paths, exit propagation
T_NAME=evidence-govern
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

tmp=$(t_tmp); seed_protected_env "$tmp"
stubs="$tmp/stubs"; mkdir -p "$stubs"
make_stub "$stubs" enterprise-skills
make_stub "$stubs" claude
printf '%s' "$stubs/claude" > "$stubs/enterprise-skills.spawn"   # the CLI spawns the agent with ITS environment
export PATH="$stubs:$PATH"
E="$T_ROOT/scripts/run-evidence.sh"; G="$T_ROOT/scripts/run-govern.sh"
ES_CALLS="$stubs/enterprise-skills.calls"; CL_CALLS="$stubs/claude.calls"
reset_calls() { rm -f "$ES_CALLS" "$CL_CALLS" "$stubs/enterprise-skills.exit"; : > "$GITHUB_OUTPUT"; }

# ---- evidence: untrusted contexts never spawn, key present or not -----------
for t in same-repo-pr fork-pr pr-target merge-queue branch-push; do
  reset_calls
  out=$(TRUST="$t" AI_ALLOWED=false AI_RUN=false EVIDENCE=agents BASE_REF_INPUT=origin/main bash "$E" 2>&1); rc=$?
  assert_rc "$rc" 1 "evidence in $t: refused (rc 1)"
  assert_eq "$(stub_calls "$ES_CALLS")" "0" "evidence in $t: CLI never spawned"
  assert_eq "$(stub_calls "$CL_CALLS")" "0" "evidence in $t: agent never spawned"
  assert_contains "$out" "no agent was spawned" "evidence in $t: states nothing ran"
done
reset_calls
out=$(TRUST=protected-branch AI_ALLOWED=true AI_RUN=false EVIDENCE=agents BASE_REF_INPUT=origin/main bash "$E" 2>&1); rc=$?
assert_rc "$rc" 1 "evidence with ai_allowed=true but ai_run=false: refused"
assert_eq "$(stub_calls "$ES_CALLS")" "0" "...and nothing spawned"

# ---- evidence: trusted + funded → CLI and agent see ANTHROPIC_API_KEY only ---
reset_calls
out=$(TRUST=protected-branch AI_ALLOWED=true AI_RUN=true EVIDENCE=agents BASE_REF_INPUT=origin/main bash "$E" 2>&1); rc=$?
assert_rc "$rc" 0 "evidence (agents) in protected-branch runs"
assert_eq "$(stub_calls "$ES_CALLS")" "1" "CLI spawned once"
assert_eq "$(stub_field "$ES_CALLS" ARGV)" 'agents run --yes --base origin/main --agent-cmd claude -p "{prompt}" --permission-mode acceptEdits' "CLI argv is the agents run shape with the explicit base"
assert_eq "$(stub_field "$ES_CALLS" PLACEHOLDER_NAMES)" "ANTHROPIC_API_KEY " "CLI sees exactly one credential: ANTHROPIC_API_KEY"
names=" $(stub_field "$ES_CALLS" ENV_NAMES) "
for n in ES_LICENSE_KEY ENTERPRISE_SKILLS_LICENSE_KEY GITHUB_TOKEN GH_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_RUNTIME_TOKEN NPM_TOKEN NODE_AUTH_TOKEN NODE_OPTIONS INPUT_LICENSE_KEY GITHUB_OUTPUT GITHUB_ENV GITHUB_PATH RG_TEST_CANARY AWS_SECRET_ACCESS_KEY; do
  assert_not_contains "$names" " $n " "evidence CLI does not see $n"
done
assert_contains "$names" " GITHUB_REPOSITORY " "evidence CLI sees non-secret coordinates"
assert_eq "$(stub_calls "$CL_CALLS")" "1" "agent spawned once by the CLI"
assert_eq "$(stub_field "$CL_CALLS" PLACEHOLDER_NAMES)" "ANTHROPIC_API_KEY " "agent (grandchild) sees exactly ANTHROPIC_API_KEY"
anames=" $(stub_field "$CL_CALLS" ENV_NAMES) "
assert_not_contains "$anames" " ACTIONS_ID_TOKEN_REQUEST_TOKEN " "agent does not inherit the OIDC request token"
assert_not_contains "$anames" " ACTIONS_ID_TOKEN_REQUEST_URL " "agent does not inherit the OIDC request URL"
assert_not_contains "$anames" " GITHUB_TOKEN " "agent does not inherit GITHUB_TOKEN"
assert_not_contains "$anames" " ES_LICENSE_KEY " "agent does not inherit the license"
assert_eq "$(out_get "$GITHUB_OUTPUT" evidence_exit)" "0" "evidence_exit output recorded"

# release-readiness shape
reset_calls
out=$(TRUST=trusted-manual AI_ALLOWED=true AI_RUN=true EVIDENCE=release-readiness bash "$E" 2>&1); rc=$?
assert_rc "$rc" 0 "evidence (release-readiness) in trusted-manual runs"
assert_contains "$(stub_field "$ES_CALLS" ARGV)" "orchestrate workflow run release-readiness --yes" "release-readiness argv"
assert_contains "$(stub_field "$ES_CALLS" ARGV)" "--step-timeout 1800" "release-readiness step timeout preserved"
assert_eq "$(stub_field "$ES_CALLS" PLACEHOLDER_NAMES)" "ANTHROPIC_API_KEY " "release-readiness CLI sees ANTHROPIC_API_KEY only"

# base resolution for push events; missing base fails closed
reset_calls
out=$(TRUST=protected-branch AI_ALLOWED=true AI_RUN=true EVIDENCE=agents PUSH_BEFORE=1111111111111111111111111111111111111111 bash "$E" 2>&1); rc=$?
assert_rc "$rc" 0 "evidence on push uses the before sha"
assert_contains "$(stub_field "$ES_CALLS" ARGV)" "--base 1111111111111111111111111111111111111111" "push base = event.before"
reset_calls
out=$(env -u GITHUB_BASE_REF TRUST=protected-branch AI_ALLOWED=true AI_RUN=true EVIDENCE=agents PUSH_BEFORE=0000000000000000000000000000000000000000 bash "$E" 2>&1); rc=$?
assert_rc "$rc" 1 "evidence with no resolvable base fails"
assert_eq "$(stub_calls "$ES_CALLS")" "0" "...without spawning"
reset_calls
out=$(env -u ANTHROPIC_API_KEY TRUST=protected-branch AI_ALLOWED=true AI_RUN=true EVIDENCE=agents BASE_REF_INPUT=origin/main bash "$E" 2>&1); rc=$?
assert_rc "$rc" 1 "evidence without the key present fails"
assert_eq "$(stub_calls "$ES_CALLS")" "0" "...without spawning"
# CLI exit propagates
reset_calls; echo 4 > "$stubs/enterprise-skills.exit"
out=$(TRUST=protected-branch AI_ALLOWED=true AI_RUN=true EVIDENCE=agents BASE_REF_INPUT=origin/main bash "$E" 2>&1); rc=$?
assert_rc "$rc" 4 "evidence propagates the CLI exit status"
assert_eq "$(out_get "$GITHUB_OUTPUT" evidence_exit)" "4" "evidence_exit=4 recorded"

# ---- govern ------------------------------------------------------------------
reset_calls
out=$(TRUST=same-repo-pr PR_NUMBER=42 GITHUB_BASE_REF=main bash "$G" 2>&1); rc=$?
assert_rc "$rc" 0 "govern on a same-repo PR runs"
assert_eq "$(stub_field "$ES_CALLS" ARGV)" "govern --post --base origin/main --pr 42" "govern argv: --post, base from GITHUB_BASE_REF, --pr"
assert_eq "$(stub_field "$ES_CALLS" PLACEHOLDER_NAMES)" "ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL ES_LICENSE_KEY " "govern sees ES_LICENSE_KEY + the OIDC pair (attestation) and nothing else"
gnames=" $(stub_field "$ES_CALLS" ENV_NAMES) "
for n in ANTHROPIC_API_KEY GITHUB_TOKEN GH_TOKEN ACTIONS_RUNTIME_TOKEN ACTIONS_RESULTS_URL NPM_TOKEN NODE_AUTH_TOKEN NODE_OPTIONS GITHUB_OUTPUT GITHUB_ENV GITHUB_PATH INPUT_LICENSE_KEY RG_TEST_CANARY; do
  assert_not_contains "$gnames" " $n " "govern does not see $n"
done
assert_eq "$(stub_calls "$CL_CALLS")" "1" "(stub CLI spawned the agent stub as modelled)"
assert_not_contains " $(stub_field "$CL_CALLS" ENV_NAMES) " " ANTHROPIC_API_KEY " "a process spawned from the govern step cannot see ANTHROPIC_API_KEY"
assert_eq "$(out_get "$GITHUB_OUTPUT" outcome)" "decided" "outcome=decided"
assert_contains "$out" "OIDC request variables present" "govern logs that OIDC is passed (names only)"
assert_not_contains "$out" "PLACEHOLDER" "govern log never prints a value"

# govern without id-token grant: license only
reset_calls
out=$(env -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL TRUST=same-repo-pr PR_NUMBER=42 GITHUB_BASE_REF=main bash "$G" 2>&1); rc=$?
assert_eq "$(stub_field "$ES_CALLS" PLACEHOLDER_NAMES)" "ES_LICENSE_KEY " "govern without id-token sees ES_LICENSE_KEY only"
# govern on push (no PR): no --pr, base = before
reset_calls
out=$(env -u GITHUB_BASE_REF TRUST=protected-branch PUSH_BEFORE=2222222222222222222222222222222222222222 bash "$G" 2>&1); rc=$?
assert_eq "$(stub_field "$ES_CALLS" ARGV)" "govern --post --base 2222222222222222222222222222222222222222" "govern on push: no --pr, base = event.before"
# fail-closed paths
reset_calls
out=$(env -u ES_LICENSE_KEY TRUST=same-repo-pr PR_NUMBER=42 GITHUB_BASE_REF=main bash "$G" 2>&1); rc=$?
assert_rc "$rc" 1 "govern without license fails"
assert_eq "$(stub_calls "$ES_CALLS")" "0" "...without spawning"
assert_eq "$(out_get "$GITHUB_OUTPUT" outcome)" "blocked-missing-license" "outcome=blocked-missing-license"
reset_calls
out=$(TRUST=same-repo-pr PR_NUMBER='42; touch pwned' GITHUB_BASE_REF=main bash "$G" 2>&1); rc=$?
assert_rc "$rc" 1 "govern rejects a non-numeric PR number"
assert_eq "$(stub_calls "$ES_CALLS")" "0" "...without spawning"
reset_calls
out=$(env -u GITHUB_BASE_REF TRUST=unknown-event bash "$G" 2>&1); rc=$?
assert_rc "$rc" 1 "govern with no resolvable base fails"
assert_eq "$(out_get "$GITHUB_OUTPUT" outcome)" "blocked-no-base" "outcome=blocked-no-base"
reset_calls; echo 3 > "$stubs/enterprise-skills.exit"
out=$(TRUST=same-repo-pr PR_NUMBER=42 GITHUB_BASE_REF=main bash "$G" 2>&1); rc=$?
assert_rc "$rc" 3 "govern propagates the CLI exit status"
assert_eq "$(out_get "$GITHUB_OUTPUT" outcome)" "decision-failed" "outcome=decision-failed"

rm -rf "$tmp"
t_done
