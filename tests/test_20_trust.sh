#!/usr/bin/env bash
# resolve-trust.sh: the event trust matrix. Fork, same-repository PR (owner,
# member, contributor), pull_request_target, merge queue, push to default /
# trusted / other branch, manual dispatch, unknown events, not-in-Actions,
# unreadable payload. AI is allowed only for protected-branch / trusted-manual.
T_NAME=trust
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

tmp=$(t_tmp); seed_protected_env "$tmp"
S="$T_ROOT/scripts/resolve-trust.sh"

pr_payload() { # head_repo fork assoc [number]
  cat <<JSON
{"repository":{"full_name":"acme/widgets","default_branch":"main"},
 "pull_request":{"number":${4:-42},"author_association":"$3",
   "head":{"ref":"topic","sha":"abcdef0123456789abcdef0123456789abcdef01","repo":$( [ "$1" = null ] && echo null || printf '{"full_name":"%s","fork":%s}' "$1" "$2" )},
   "base":{"ref":"main","repo":{"full_name":"acme/widgets","fork":false}}}}
JSON
}
push_payload() { printf '{"repository":{"full_name":"acme/widgets","default_branch":"main"},"before":"%s","after":"%s"}' "$1" "0123456789abcdef0123456789abcdef01234567"; }
plain_payload() { printf '{"repository":{"full_name":"acme/widgets","default_branch":"main"}}'; }

run_case() { # label event ref payload expected_trust expected_ai [TRUSTED_REFS]
  local label="$1" event="$2" ref="$3" payload="$4" want="$5" want_ai="$6" trefs="${7:-}"
  : > "$GITHUB_OUTPUT"
  printf '%s' "$payload" > "$tmp/event.json"
  out=$(GITHUB_EVENT_NAME="$event" GITHUB_REF="$ref" GITHUB_EVENT_PATH="$tmp/event.json" TRUSTED_REFS="$trefs" bash "$S" 2>&1); rc=$?
  assert_rc "$rc" 0 "$label: exits 0"
  assert_eq "$(out_get "$GITHUB_OUTPUT" trust)" "$want" "$label: trust=$want"
  assert_eq "$(out_get "$GITHUB_OUTPUT" ai_allowed)" "$want_ai" "$label: ai_allowed=$want_ai"
  LAST_OUT="$out"
}

run_case "fork PR"                    pull_request refs/pull/42/merge "$(pr_payload other/widgets true CONTRIBUTOR)" fork-pr false
assert_eq "$(out_get "$GITHUB_OUTPUT" pr_number)" "42" "fork PR: pr_number captured"
assert_eq "$(out_get "$GITHUB_OUTPUT" head_repo)" "other/widgets" "fork PR: head_repo captured"
run_case "fork PR (same name, fork=true)" pull_request refs/pull/42/merge "$(pr_payload acme/widgets true CONTRIBUTOR)" fork-pr false
run_case "PR with deleted head repo"  pull_request refs/pull/42/merge "$(pr_payload null false CONTRIBUTOR)" fork-pr false
run_case "same-repo PR (OWNER)"       pull_request refs/pull/7/merge  "$(pr_payload acme/widgets false OWNER 7)" same-repo-pr false
assert_eq "$(out_get "$GITHUB_OUTPUT" author_association)" "OWNER" "same-repo PR: association recorded, not used to elevate"
run_case "same-repo PR (MEMBER)"      pull_request refs/pull/7/merge  "$(pr_payload acme/widgets false MEMBER 7)" same-repo-pr false
run_case "same-repo PR (CONTRIBUTOR)" pull_request refs/pull/7/merge  "$(pr_payload acme/widgets false CONTRIBUTOR 7)" same-repo-pr false
run_case "pull_request_review"        pull_request_review refs/pull/7/merge "$(pr_payload acme/widgets false OWNER 7)" same-repo-pr false
run_case "pull_request_target"        pull_request_target refs/heads/main "$(pr_payload other/widgets true OWNER 9)" pr-target false
assert_contains "$LAST_OUT" "::warning" "pull_request_target: warning emitted"
run_case "merge_group"                merge_group refs/heads/gh-readonly-queue/main/pr-7 "$(plain_payload)" merge-queue false
run_case "push to default branch"     push refs/heads/main "$(push_payload 1111111111111111111111111111111111111111)" protected-branch true
assert_eq "$(out_get "$GITHUB_OUTPUT" push_before)" "1111111111111111111111111111111111111111" "push: before sha captured for base resolution"
run_case "push to feature branch"     push refs/heads/feature/x "$(push_payload 1111111111111111111111111111111111111111)" branch-push false
run_case "push to trusted ref"        push refs/heads/release/2026.08 "$(push_payload 1111111111111111111111111111111111111111)" protected-branch true "release/2026.08, hotfix"
run_case "push to trusted full ref"   push refs/heads/hotfix "$(push_payload 1111111111111111111111111111111111111111)" protected-branch true "refs/heads/hotfix"
run_case "push to untrusted despite list" push refs/heads/other "$(push_payload 1111111111111111111111111111111111111111)" branch-push false "release/2026.08"
run_case "push to tag"                push refs/tags/v1.2.3 "$(push_payload 0000000000000000000000000000000000000000)" branch-push false
run_case "workflow_dispatch on main"  workflow_dispatch refs/heads/main "$(plain_payload)" trusted-manual true
run_case "workflow_dispatch elsewhere" workflow_dispatch refs/heads/feature/x "$(plain_payload)" manual-other-ref false
run_case "schedule on main"           schedule refs/heads/main "$(plain_payload)" trusted-manual true
run_case "issue_comment"              issue_comment refs/heads/main "$(plain_payload)" unknown-event false
run_case "workflow_run"               workflow_run refs/heads/main "$(plain_payload)" unknown-event false
run_case "no event name"              "" refs/heads/main "$(plain_payload)" unknown-event false

# unreadable payload on a pull_request: fail closed to fork-pr
: > "$GITHUB_OUTPUT"
out=$(GITHUB_EVENT_NAME=pull_request GITHUB_REF=refs/pull/1/merge GITHUB_EVENT_PATH="$tmp/does-not-exist.json" bash "$S" 2>&1)
assert_eq "$(out_get "$GITHUB_OUTPUT" trust)" "fork-pr" "unreadable payload on pull_request resolves to fork-pr (fail closed)"
# push with no payload: default branch unknown -> not trusted
: > "$GITHUB_OUTPUT"
out=$(GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main GITHUB_EVENT_PATH="$tmp/does-not-exist.json" bash "$S" 2>&1)
assert_eq "$(out_get "$GITHUB_OUTPUT" trust)" "branch-push" "push with unreadable payload is not trusted (default branch unknown)"
# outside Actions
: > "$GITHUB_OUTPUT"
out=$(env -u GITHUB_ACTIONS GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main GITHUB_EVENT_PATH="$tmp/event.json" bash "$S" 2>&1)
assert_eq "$(out_get "$GITHUB_OUTPUT" trust)" "not-actions" "GITHUB_ACTIONS unset resolves to not-actions"
assert_eq "$(out_get "$GITHUB_OUTPUT" ai_allowed)" "false" "not-actions never allows AI"

rm -rf "$tmp"
t_done
