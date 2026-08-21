#!/usr/bin/env bash
# Step 7 — deterministic governance + decision post.
# The workflow step's env carries exactly one credential: ES_LICENSE_KEY. The
# governor runs under the scoped environment with that name passed explicitly,
# plus — only here — the OIDC request pair when the job granted id-token:
# write, so the decision can carry a CI attestation. No AI runs in this step;
# the CLI classifies the diff and evaluates committed evidence.
# Env: TRUST, PR_NUMBER, BASE_REF_INPUT, PUSH_BEFORE, ES_LICENSE_KEY
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TRUST="${TRUST:-unknown}"
if [ -z "${ES_LICENSE_KEY:-}" ]; then
  rg_error "govern" "ES_LICENSE_KEY is not present in this step; the decision cannot be posted. Nothing was spawned."
  rg_output outcome blocked-missing-license
  exit 1
fi
base=$(rg_resolve_base) || { rg_error "govern" "cannot resolve a base ref for this $TRUST run (no base-ref input, no GITHUB_BASE_REF, no push 'before' sha). Set the base-ref input."; rg_output outcome blocked-no-base; exit 1; }

args=(govern --post --base "$base")
if [ -n "${PR_NUMBER:-}" ]; then
  [[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || { rg_error "govern" "PR_NUMBER '$PR_NUMBER' is not numeric"; exit 1; }
  args+=(--pr "$PR_NUMBER")
fi
if [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
  rg_log "OIDC request variables present (id-token: write): passed to the governor process only, for decision attestation"
fi
rg_log "govern ${args[*]}; child environment: allowlist + ES_LICENSE_KEY (+ OIDC pair when granted)"
rc=0
rg_scoped_exec --pass ES_LICENSE_KEY --pass-oidc -- enterprise-skills "${args[@]}" || rc=$?
if [ "$rc" -eq 0 ]; then rg_output outcome decided; else rg_output outcome decision-failed; fi
exit "$rc"
