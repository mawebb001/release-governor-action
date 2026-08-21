#!/usr/bin/env bash
# Static validation: shell syntax, action.yml structure, pins, README guidance,
# workflow pins, credential scan. No execution of the action, no network.
T_NAME=static
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

for f in "$T_ROOT"/scripts/*.sh "$T_ROOT"/tests/*.sh; do
  if bash -n "$f" 2>/dev/null; then t_ok "bash -n $(basename "$f")"; else t_fail "bash -n $(basename "$f")"; fi
done

py=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c "import yaml" >/dev/null 2>&1; then py="$c"; break; fi
done
if [ -z "$py" ]; then
  if [ "${CI:-}" = "true" ]; then t_fail "python with PyYAML is required for static checks in CI"
  else echo "  SKIP python+PyYAML not available locally; static_checks.py not run (CI runs it)"; fi
else
  if "$py" "$T_ROOT/tests/static_checks.py" "$T_ROOT"; then t_ok "static_checks.py"; else t_fail "static_checks.py"; fi
fi

t_done
