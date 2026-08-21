#!/usr/bin/env bash
# Step 1 — validate inputs. No credentials are in scope for this step.
# Env: EVIDENCE, CLI_VERSION, TRUSTED_REFS, BASE_REF_INPUT, GITHUB_ACTION_PATH
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

: "${GITHUB_ACTION_PATH:?GITHUB_ACTION_PATH is required}"
EVIDENCE="${EVIDENCE:-agents}"
CLI_VERSION="${CLI_VERSION:-}"
TRUSTED_REFS="${TRUSTED_REFS:-}"
BASE_REF_INPUT="${BASE_REF_INPUT:-}"

cli_lock="$GITHUB_ACTION_PATH/deps/cli/package-lock.json"
agent_lock="$GITHUB_ACTION_PATH/deps/agent/package-lock.json"
pinned_cli=$(rg_lock_version "$cli_lock" enterprise-skills) || { rg_error "pins" "cannot read the CLI pin from $cli_lock"; exit 1; }
pinned_agent=$(rg_lock_version "$agent_lock" @anthropic-ai/claude-code) || { rg_error "pins" "cannot read the agent pin from $agent_lock"; exit 1; }

case "$EVIDENCE" in
  agents|release-readiness|none) ;;
  *) rg_error "inputs" "evidence must be one of: agents, release-readiness, none (got '$EVIDENCE')"; exit 1 ;;
esac

if [ -z "$CLI_VERSION" ]; then CLI_VERSION="$pinned_cli"; fi
if ! [[ "$CLI_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  rg_error "inputs" "cli-version must be an exact version (got '$CLI_VERSION'). Ranges, tags and dist-tags are refused: the CLI is installed from a committed, integrity-locked lockfile, never resolved at run time."
  exit 1
fi
if [ "$CLI_VERSION" != "$pinned_cli" ]; then
  rg_error "inputs" "cli-version '$CLI_VERSION' does not match the integrity-locked pin $pinned_cli shipped by this action release. The pin changes only by a reviewed commit to the action (deps/cli/package-lock.json), not by an input — use the action release that ships the version you need."
  exit 1
fi

# Non-secret coordinates that later become argv (never shell lines); keep them
# to the character class git refs use so a typo cannot become an option.
if ! [[ "$TRUSTED_REFS" =~ ^[A-Za-z0-9._/,[:space:]-]*$ ]]; then
  rg_error "inputs" "trusted-refs contains characters outside [A-Za-z0-9._/,- ]"; exit 1
fi
if ! [[ "$BASE_REF_INPUT" =~ ^[A-Za-z0-9._/-]*$ ]] || [[ "$BASE_REF_INPUT" == -* ]]; then
  rg_error "inputs" "base-ref must be a plain ref (got '$BASE_REF_INPUT')"; exit 1
fi

rg_log "Pins (from committed lockfiles): enterprise-skills@$pinned_cli, @anthropic-ai/claude-code@$pinned_agent"
rg_output cli_version "$pinned_cli"
rg_output agent_version "$pinned_agent"
