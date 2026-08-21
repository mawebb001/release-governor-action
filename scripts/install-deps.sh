#!/usr/bin/env bash
# Steps 4/5 — install a dependency tree from its committed lockfile.
#   install-deps.sh cli    → enterprise-skills (exact pin, integrity-locked)
#   install-deps.sh agent  → @anthropic-ai/claude-code (exact pin, integrity-locked)
# Runs with NO credentials in scope (the workflow step sets none, and the npm
# process runs under the scoped environment anyway), lifecycle scripts OFF.
# For the agent runtime the ONE lifecycle script it needs is run afterwards by
# name — node install.cjs — which only places the platform binary that the
# lockfile already pinned by integrity. Nothing else is executed.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

: "${GITHUB_ACTION_PATH:?GITHUB_ACTION_PATH is required}"
name="${1:?usage: install-deps.sh cli|agent}"
case "$name" in
  cli)   pkg=enterprise-skills; bin=enterprise-skills ;;
  agent) pkg=@anthropic-ai/claude-code; bin=claude ;;
  *) rg_error "locked install" "unknown dependency set '$name'"; exit 1 ;;
esac
dir="$GITHUB_ACTION_PATH/deps/$name"
pinned=$(rg_lock_version "$dir/package-lock.json" "$pkg") || { rg_error "locked install" "cannot read pin for $pkg from $dir/package-lock.json"; exit 1; }

rg_log "Installing $pkg@$pinned from $dir/package-lock.json (npm ci --ignore-scripts, scoped environment, no credentials)"
rg_npm_ci_locked "$dir"

installed=$(node -e 'process.stdout.write(require(process.argv[1]+"/package.json").version)' "$dir/node_modules/$pkg")
if [ "$installed" != "$pinned" ]; then
  rg_error "locked install" "installed $pkg@$installed but the lockfile pins $pinned; refusing to continue"
  exit 1
fi

if [ "$name" = "agent" ]; then
  rg_log "Running the one reviewed lifecycle script by name: $pkg/install.cjs (places the integrity-locked platform binary; no network, no credentials)"
  ( cd "$dir/node_modules/$pkg" && rg_scoped_exec -- node install.cjs )
fi

bindir="$dir/node_modules/.bin"
reported=$(rg_scoped_exec -- "$bindir/$bin" --version 2>/dev/null | tr -d '\r' | tail -n1 || true)
case "$reported" in
  *"$pinned"*) rg_log "$bin --version: $reported" ;;
  *) rg_error "locked install" "$bin --version reported '$reported', expected $pinned"; exit 1 ;;
esac

if [ -n "${GITHUB_PATH:-}" ]; then echo "$bindir" >> "$GITHUB_PATH"; fi
rg_output bin_dir "$bindir"
rg_output "${name}_version" "$pinned"
