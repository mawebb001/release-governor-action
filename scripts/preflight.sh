#!/usr/bin/env bash
# Step 3 — credential presence and checkout state. No credential VALUES are in
# scope: the workflow passes booleans computed by the runner's expression
# engine (`inputs.license-key != ''`), so even this step never holds a secret.
# Env: LICENSE_PRESENT, ANTHROPIC_PRESENT, EVIDENCE, TRUST, AI_ALLOWED
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

LICENSE_PRESENT="${LICENSE_PRESENT:-false}"
ANTHROPIC_PRESENT="${ANTHROPIC_PRESENT:-false}"
EVIDENCE="${EVIDENCE:-agents}"
TRUST="${TRUST:?TRUST is required (resolve-trust output)}"
AI_ALLOWED="${AI_ALLOWED:-false}"

finish() { # proceed ai_run ai_evidence outcome
  rg_output proceed "$1"; rg_output ai_run "$2"; rg_output ai_evidence "$3"; rg_output outcome "$4"
}

# --- license: fail safely when absent -----------------------------------------
if [ "$LICENSE_PRESENT" != "true" ]; then
  if [ "$TRUST" = "fork-pr" ]; then
    rg_notice "Release Governor: fork pull request" "GitHub does not provide repository secrets to workflows triggered by fork pull requests, so no license-key reached this run and no decision can be posted from this context. Nothing was installed, no credentialed process ran, and the required check stays incomplete until a trusted workflow produces the decision. (README: Trust matrix, fork-pr.)"
    finish false false not-run skipped-fork-no-license
    exit 0
  fi
  rg_error "Release Governor: license-key missing" "license-key is empty in trust context '$TRUST'. Refusing to continue: nothing was installed, no evidence phase ran and no decision post was attempted. Store the key as a repository or organization secret and pass it as license-key (mint a CI service key with 'enterprise-skills license mint-ci')."
  finish false false not-run blocked-missing-license
  exit 1
fi

# --- AI evidence: trusted contexts only, and only when funded -----------------
ai_run=false; ai_evidence=""
if [ "$EVIDENCE" = "none" ]; then
  ai_evidence=disabled
  rg_log "Evidence phase disabled by input (evidence: none)."
elif [ "$AI_ALLOWED" != "true" ]; then
  ai_evidence=refused-untrusted
  if [ "$ANTHROPIC_PRESENT" = "true" ]; then
    rg_notice "Evidence phase refused (untrusted context)" "Trust context is '$TRUST'. Semantic agents execute over repository content with a vendor credential, so this action never runs them against pull-request, merge-queue or non-default-branch content. The anthropic-api-key was NOT exposed to any process in this run. The Governor decides over committed evidence. Produce AI evidence from a trusted context (push to the default branch / workflow_dispatch; README: Trust matrix) or commit session evidence."
  else
    rg_notice "Evidence phase not run (untrusted context, unfunded)" "Trust context is '$TRUST' and no anthropic-api-key was provided. The Governor decides over committed evidence only."
  fi
elif [ "$ANTHROPIC_PRESENT" != "true" ]; then
  ai_evidence=skipped-unfunded
  rg_notice "Evidence phase skipped (unfunded)" "No anthropic-api-key input was provided, so no headless evidence was produced. The Governor decides over committed evidence only. On evidence-requiring diffs in enforce mode that is an honest FAIL: the policy working, not a bug. Fund the evidence phase, commit session evidence, or set mode: warn in .project-ai/GOVERNOR_POLICY.yaml while adopting."
else
  ai_run=true; ai_evidence=scheduled
  rg_log "Evidence phase scheduled: trust context '$TRUST' permits AI evidence and the phase is funded."
fi

# --- checkout credentials -----------------------------------------------------
rg_checkout_credentials_persisted >/dev/null
persisted="$RG_CHECKOUT_PERSISTED"
rg_output checkout_credentials_persisted "$persisted"
if [ "$persisted" = "true" ]; then
  if [ "$ai_run" = "true" ]; then
    rg_error "Checkout credentials persisted" "The checkout still carries a GitHub token (${RG_CHECKOUT_DETAIL}). AI evidence will not run while a repository credential is reachable from the working tree: an agent with write permission on files could use it. Set 'persist-credentials: false' on actions/checkout (README: Usage). Failing closed; nothing credentialed ran."
    finish false false refused-checkout-credentials blocked-checkout-credentials
    exit 1
  fi
  rg_warn "Checkout credentials persisted" "The checkout still carries a GitHub token (${RG_CHECKOUT_DETAIL}). This run performs no AI execution, so it continues, but set 'persist-credentials: false' on actions/checkout. It is required before any trusted workflow enables AI evidence."
fi

finish true "$ai_run" "$ai_evidence" proceed
