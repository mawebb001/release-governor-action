#!/usr/bin/env bash
# scripts/lib.sh — shared helpers for the Release Governor action.
#
# Sourced by every step script (and by the tests). Holds the ONE credential
# boundary the action enforces: rg_scoped_exec, which runs a child with an
# allowlisted environment so install-time, evidence-time and decision-time
# processes see exactly the names the step passes by hand — never the runner's
# full environment (GITHUB_TOKEN set at job level, OIDC request variables
# injected by `id-token: write`, npm/Node injection variables, INPUT_*).
#
# Names mirror the CLI half of ES-P0-ACTION-CREDENTIAL-SCOPE
# (cursor_enterprise_skills RH-20260820-003, packages/cli/src/lib/child-boundary.ts)
# so the Action and the CLI draw the same line. The published CLI this action
# pins (4.30.2) predates that code and spawns agents with its own environment
# inherited, which is exactly why the Action must hold the line itself.

set -euo pipefail

# ---------------------------------------------------------------- logging ----
rg_log()    { printf '%s\n' "$*"; }
rg_notice() { printf '::notice title=%s::%s\n' "$1" "$2"; }
rg_warn()   { printf '::warning title=%s::%s\n' "$1" "$2"; }
rg_error()  { printf '::error title=%s::%s\n' "$1" "$2"; }
# Step output (GITHUB_OUTPUT when present) + echo, so a local run shows the same.
rg_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; fi
  printf '  %s=%s\n' "$1" "$2"
}

# --------------------------------------------------------- boundary tables ----
# Inherited by every scoped child when present in the parent (by NAME; values
# are never inspected). Process/locale, Windows process essentials, egress
# configuration, and GitHub's non-secret coordinates.
RG_ALLOW_EXACT=(
  PATH HOME USER USERNAME LOGNAME SHELL TERM LANG LANGUAGE TZ NO_COLOR FORCE_COLOR
  CI TMPDIR TMP TEMP
  SystemRoot SYSTEMROOT windir WINDIR SystemDrive SYSTEMDRIVE ComSpec COMSPEC PATHEXT
  USERPROFILE HOMEDRIVE HOMEPATH APPDATA LOCALAPPDATA ProgramData PROGRAMDATA
  ProgramFiles PROGRAMFILES ProgramW6432 CommonProgramFiles CommonProgramW6432
  ALLUSERSPROFILE PUBLIC OS PROCESSOR_ARCHITECTURE PROCESSOR_ARCHITEW6432
  NUMBER_OF_PROCESSORS COMPUTERNAME USERDOMAIN HOSTNAME
  HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy
  SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE
  GITHUB_ACTIONS GITHUB_WORKSPACE GITHUB_REPOSITORY GITHUB_REPOSITORY_OWNER
  GITHUB_SHA GITHUB_REF GITHUB_REF_NAME GITHUB_REF_TYPE GITHUB_BASE_REF GITHUB_HEAD_REF
  GITHUB_EVENT_NAME GITHUB_EVENT_PATH GITHUB_RUN_ID GITHUB_RUN_NUMBER GITHUB_RUN_ATTEMPT
  GITHUB_JOB GITHUB_WORKFLOW GITHUB_ACTOR GITHUB_SERVER_URL GITHUB_API_URL
  RUNNER_OS RUNNER_ARCH
)
RG_ALLOW_PREFIX=( LC_ XDG_ )

# Hard deny: never inherited and never passable by name, at any trust level.
# GITHUB_ENV/PATH/OUTPUT/STATE/STEP_SUMMARY are the runner file commands — a
# child holding them can inject variables, PATH entries and outputs into LATER
# steps, which is an escalation path. NODE_OPTIONS / npm_config_* preload code
# into every node/npm process. RUNNER_TEMP is omitted for the same reason the
# CLI half omits it (it is where the file commands live).
RG_DENY_EXACT=(
  GITHUB_TOKEN GH_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
  GITHUB_ENV GITHUB_PATH GITHUB_OUTPUT GITHUB_STATE GITHUB_STEP_SUMMARY
  NPM_TOKEN NODE_AUTH_TOKEN NODE_OPTIONS
  ACTIONS_RUNTIME_TOKEN ACTIONS_RUNTIME_URL ACTIONS_RESULTS_URL ACTIONS_CACHE_URL
)
RG_DENY_PREFIX=( ACTIONS_ INPUT_ NPM_CONFIG_ npm_config_ )

# The complete set of credential names a step may pass explicitly (one --pass
# per name). Anything else is refused before any child is spawned.
RG_PASSABLE=( ES_LICENSE_KEY ENTERPRISE_SKILLS_LICENSE_KEY ANTHROPIC_API_KEY )
# The OIDC request pair — passable ONLY via --pass-oidc, used by exactly one
# caller (the govern/post step) so the decision can carry a CI attestation.
RG_OIDC_NAMES=( ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN )

rg_name_in() { local n="$1"; shift; local x; for x in "$@"; do [ "$x" = "$n" ] && return 0; done; return 1; }
rg_name_has_prefix() { local n="$1"; shift; local p; for p in "$@"; do case "$n" in "$p"*) return 0;; esac; done; return 1; }
rg_is_denied() { rg_name_in "$1" "${RG_DENY_EXACT[@]}" || rg_name_has_prefix "$1" "${RG_DENY_PREFIX[@]}"; }
rg_is_allowlisted() { rg_name_in "$1" "${RG_ALLOW_EXACT[@]}" || rg_name_has_prefix "$1" "${RG_ALLOW_PREFIX[@]}"; }

# rg_scoped_exec [--pass NAME]... [--pass-oidc] -- command [args...]
#
# Runs `command` with `env -i` and an environment rebuilt from scratch:
#   allowlisted names present in the parent
#   + each --pass NAME (must be in RG_PASSABLE, must be present)
#   + the OIDC pair when --pass-oidc is given and the runner injected it.
# Everything else is ABSENT in the child (not empty). Refusals happen before
# any spawn and return 2. The command's own exit status is returned otherwise.
rg_scoped_exec() {
  local -a pass=()
  local oidc=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --pass)
        shift
        [ $# -gt 0 ] || { rg_error "credential boundary" "--pass needs a name"; return 2; }
        if ! rg_name_in "$1" "${RG_PASSABLE[@]}"; then
          rg_error "credential boundary" "refused: '$1' is not a passable credential name (passable: ${RG_PASSABLE[*]}; OIDC only via --pass-oidc). Nothing was spawned."
          return 2
        fi
        pass+=("$1"); shift ;;
      --pass-oidc) oidc=1; shift ;;
      --) shift; break ;;
      *) rg_error "credential boundary" "rg_scoped_exec: unknown option '$1'. Nothing was spawned."; return 2 ;;
    esac
  done
  [ $# -gt 0 ] || { rg_error "credential boundary" "rg_scoped_exec: no command given"; return 2; }

  local -a envargs=()
  local name
  # compgen -e lists the names this shell would export to a child; reading it
  # (rather than parsing `env` output) is NUL/newline-safe by construction.
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if rg_is_denied "$name"; then
      if [ "$oidc" = 1 ] && rg_name_in "$name" "${RG_OIDC_NAMES[@]}"; then
        envargs+=("$name=${!name}")
      fi
      continue
    fi
    if [ ${#pass[@]} -gt 0 ] && rg_name_in "$name" "${pass[@]}"; then
      envargs+=("$name=${!name}"); continue
    fi
    if rg_is_allowlisted "$name"; then
      envargs+=("$name=${!name}")
    fi
  done < <(compgen -e)

  # Post-condition, independent of the loop above: no hard-denied name may be
  # in the constructed environment except the OIDC pair under --pass-oidc.
  local kv
  for kv in "${envargs[@]}"; do
    name="${kv%%=*}"
    if rg_is_denied "$name" && ! { [ "$oidc" = 1 ] && rg_name_in "$name" "${RG_OIDC_NAMES[@]}"; }; then
      rg_error "credential boundary" "internal invariant violated: '$name' reached the child environment. Nothing was spawned."
      return 2
    fi
  done

  env -i "${envargs[@]}" "$@"
}

# ------------------------------------------------------ locked npm install ----
# rg_npm_ci_locked <dir>
# `npm ci` from the committed package-lock.json in <dir>, with lifecycle scripts
# disabled and the scoped (credential-free) environment. Exact versions and
# integrity hashes come from the lockfile; npm refuses anything that drifts.
rg_npm_ci_locked() {
  local dir="$1"
  [ -f "$dir/package-lock.json" ] || { rg_error "locked install" "no package-lock.json in $dir"; return 1; }
  ( cd "$dir" && rg_scoped_exec -- npm ci --ignore-scripts --no-audit --no-fund --loglevel=error )
}

# rg_lock_version <lockfile> <package-name>  → the exact version the lock pins
rg_lock_version() {
  node -e 'const l=require(process.argv[1]);const p=l.packages["node_modules/"+process.argv[2]];if(!p||!p.version){process.exit(3)}process.stdout.write(p.version)' "$1" "$2"
}

# ----------------------------------------------------- base ref resolution ----
# rg_resolve_base → prints the git ref the CLI diffs against.
#   base-ref input  → as given
#   pull_request*   → origin/$GITHUB_BASE_REF
#   push            → the event's `before` sha (PUSH_BEFORE), when real
rg_resolve_base() {
  if [ -n "${BASE_REF_INPUT:-}" ]; then printf '%s' "$BASE_REF_INPUT"; return 0; fi
  if [ -n "${GITHUB_BASE_REF:-}" ]; then printf 'origin/%s' "$GITHUB_BASE_REF"; return 0; fi
  if [ -n "${PUSH_BEFORE:-}" ] && [[ "$PUSH_BEFORE" =~ ^[0-9a-f]{40}$ ]] && [ "$PUSH_BEFORE" != "0000000000000000000000000000000000000000" ]; then
    printf '%s' "$PUSH_BEFORE"; return 0
  fi
  return 1
}

# ------------------------------------------------- checkout credential scan ----
# rg_checkout_credentials_persisted [workspace]
# Prints "true" or "false" and sets RG_CHECKOUT_PERSISTED / RG_CHECKOUT_DETAIL
# (call it directly, not in a command substitution, to read the variables).
# Detects what actions/checkout leaves behind when persist-credentials is not
# false.
rg_checkout_credentials_persisted() {
  local ws="${1:-${GITHUB_WORKSPACE:-$PWD}}"
  RG_CHECKOUT_DETAIL=""; RG_CHECKOUT_PERSISTED=false
  local persisted=false hdr url
  if git -C "$ws" rev-parse --git-dir >/dev/null 2>&1; then
    hdr=$(git -C "$ws" config --local --get-regexp '^http\..*\.extraheader$' 2>/dev/null || true)
    if printf '%s' "$hdr" | grep -qi 'authorization'; then
      persisted=true
      RG_CHECKOUT_DETAIL="http.*.extraheader carries an Authorization header (actions/checkout persist-credentials default)"
    fi
    url=$(git -C "$ws" config --local --get remote.origin.url 2>/dev/null || true)
    if printf '%s' "$url" | grep -Eq '://[^/@]+@'; then
      persisted=true
      RG_CHECKOUT_DETAIL="${RG_CHECKOUT_DETAIL:+$RG_CHECKOUT_DETAIL; }remote.origin.url embeds credentials"
    fi
  fi
  RG_CHECKOUT_PERSISTED="$persisted"
  printf '%s' "$persisted"
}
