#!/usr/bin/env bash
# Step 2 — classify the run's trust context from the event. No credentials.
#
# Trust matrix (README "Trust matrix"):
#   fork-pr           pull_request* whose head repo is not this repo   AI: no
#   same-repo-pr      pull_request* from a branch in this repo          AI: no
#   pr-target         pull_request_target (base context on PR content)  AI: no, warned
#   merge-queue       merge_group                                       AI: no
#   protected-branch  push to the default branch or a trusted ref       AI: yes
#   branch-push       push to any other branch                          AI: no
#   trusted-manual    workflow_dispatch/schedule on default/trusted ref AI: yes
#   manual-other-ref  workflow_dispatch/schedule elsewhere              AI: no
#   unknown-event     anything else                                     AI: no
#   not-actions       GITHUB_ACTIONS != true                            AI: no
# "AI: yes" means the semantic-agent evidence phase MAY run (it still needs an
# anthropic-api-key). Pull-request content never receives credential-bearing
# AI execution through this action, same-repository or not.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

event="${GITHUB_EVENT_NAME:-}"
path="${GITHUB_EVENT_PATH:-}"
repo="${GITHUB_REPOSITORY:-}"
ref="${GITHUB_REF:-}"
trusted_refs="${TRUSTED_REFS:-}"

payload() {
  if [ -n "$path" ] && [ -r "$path" ]; then jq -r "$1 // empty" "$path" 2>/dev/null || true; fi
}

default_branch=$(payload '.repository.default_branch')
trust=unknown-event; ai=false; reason=""; pr_number=""; head_repo=""; assoc=""; push_before=""

is_trusted_ref() {
  local r="$1" e list
  if [ -n "$default_branch" ] && [ "$r" = "refs/heads/$default_branch" ]; then return 0; fi
  list=$(printf '%s' "$trusted_refs" | tr ',' ' ')
  for e in $list; do
    case "$e" in
      refs/*) [ "$r" = "$e" ] && return 0 ;;
      *) [ "$r" = "refs/heads/$e" ] && return 0 ;;
    esac
  done
  return 1
}

if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  trust=not-actions; reason="GITHUB_ACTIONS is not 'true'; treated as untrusted"
else
  case "$event" in
    pull_request|pull_request_review|pull_request_review_comment)
      pr_number=$(payload '.pull_request.number')
      head_repo=$(payload '.pull_request.head.repo.full_name')
      base_repo=$(payload '.pull_request.base.repo.full_name')
      [ -n "$base_repo" ] || base_repo="$repo"
      fork=$(payload '.pull_request.head.repo.fork')
      assoc=$(payload '.pull_request.author_association')
      if [ -z "$head_repo" ] || [ "$fork" = "true" ] || [ "$head_repo" != "$base_repo" ]; then
        trust=fork-pr; reason="head repository '${head_repo:-<absent>}' is not '$base_repo' (fork=${fork:-?}); secrets are not available to this run by GitHub's rules"
      else
        trust=same-repo-pr; reason="head branch lives in $base_repo (author_association=${assoc:-?}); pull-request content is not trusted for credential-bearing AI execution"
      fi ;;
    pull_request_target)
      pr_number=$(payload '.pull_request.number')
      head_repo=$(payload '.pull_request.head.repo.full_name')
      trust=pr-target; reason="pull_request_target runs in the base repository's context on pull-request content; always untrusted"
      rg_warn "pull_request_target" "This action is running under pull_request_target. It will not run AI evidence here, but if the workflow also checked out the PR head the checkout itself is the risk. Use pull_request for PR gating." ;;
    merge_group)
      trust=merge-queue; reason="merge_group content is a queue of pull requests; untrusted for AI execution" ;;
    push)
      push_before=$(payload '.before')
      if is_trusted_ref "$ref"; then trust=protected-branch; reason="push to $ref (default branch '${default_branch:-?}' or trusted-refs)"
      else trust=branch-push; reason="push to $ref, which is neither the default branch nor in trusted-refs"; fi ;;
    workflow_dispatch|schedule)
      if is_trusted_ref "$ref"; then trust=trusted-manual; reason="$event on $ref (default branch '${default_branch:-?}' or trusted-refs)"
      else trust=manual-other-ref; reason="$event on $ref, which is neither the default branch nor in trusted-refs"; fi ;;
    *)
      trust=unknown-event; reason="event '${event:-<none>}' is not in the trust matrix" ;;
  esac
fi

case "$trust" in
  protected-branch|trusted-manual) ai=true ;;
  *) ai=false ;;
esac

rg_log "Trust context: $trust (ai_allowed=$ai) — $reason"
rg_output trust "$trust"
rg_output ai_allowed "$ai"
rg_output reason "$reason"
rg_output pr_number "$pr_number"
rg_output default_branch "$default_branch"
rg_output head_repo "$head_repo"
rg_output author_association "$assoc"
rg_output push_before "$push_before"
