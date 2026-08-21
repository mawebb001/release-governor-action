#!/usr/bin/env bash
# Step 6 — the semantic-agent evidence phase. Trusted contexts ONLY.
# The workflow step's env carries exactly one credential: ANTHROPIC_API_KEY.
# The CLI (and the agent it spawns) run under the scoped environment with that
# one name passed explicitly — no license, no GITHUB_TOKEN, no OIDC pair, no
# runner file-command variables, whatever the job-level env looks like.
# Env: TRUST, AI_ALLOWED, AI_RUN, EVIDENCE, BASE_REF_INPUT, PUSH_BEFORE, ANTHROPIC_API_KEY
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TRUST="${TRUST:-unknown}"
AI_ALLOWED="${AI_ALLOWED:-false}"
AI_RUN="${AI_RUN:-false}"
EVIDENCE="${EVIDENCE:-agents}"

# Defense in depth: the step condition should never let an untrusted context
# reach this script; if it does, refuse before anything is spawned.
if [ "$AI_ALLOWED" != "true" ] || [ "$AI_RUN" != "true" ]; then
  rg_error "evidence boundary" "AI evidence invoked in trust context '$TRUST' with ai_allowed=$AI_ALLOWED ai_run=$AI_RUN; refusing, no agent was spawned."
  exit 1
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  rg_error "evidence boundary" "ANTHROPIC_API_KEY is not present in this step; nothing to run with. No agent was spawned."
  exit 1
fi
case "$EVIDENCE" in
  agents|release-readiness) ;;
  none) rg_log "evidence: none; nothing to do"; exit 0 ;;
  *) rg_error "evidence boundary" "unknown evidence mode '$EVIDENCE'"; exit 1 ;;
esac

agent_cmd='claude -p "{prompt}" --permission-mode acceptEdits'
rc=0
if [ "$EVIDENCE" = "agents" ]; then
  base=$(rg_resolve_base) || { rg_error "evidence boundary" "cannot resolve a base ref for this $TRUST run (no base-ref input, no GITHUB_BASE_REF, no push 'before' sha). Set the base-ref input."; exit 1; }
  rg_log "agents run against base '$base'; child environment: allowlist + ANTHROPIC_API_KEY only"
  rg_scoped_exec --pass ANTHROPIC_API_KEY -- enterprise-skills agents run --yes --base "$base" --agent-cmd "$agent_cmd" || rc=$?
else
  rg_log "orchestrate workflow run release-readiness; child environment: allowlist + ANTHROPIC_API_KEY only"
  rg_scoped_exec --pass ANTHROPIC_API_KEY -- enterprise-skills orchestrate workflow run release-readiness --yes --agent-cmd "$agent_cmd" --step-timeout 1800 || rc=$?
fi
rg_output evidence_exit "$rc"
exit "$rc"
