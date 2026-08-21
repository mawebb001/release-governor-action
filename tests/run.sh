#!/usr/bin/env bash
# Runs every tests/test_*.sh in order and reports. Exit 1 on any failure.
# All tests use placeholder credentials and stubs; nothing leaves the machine.
set -uo pipefail
cd "$(dirname "$0")/.."
status=0
for f in tests/test_*.sh; do
  printf '\n== %s\n' "$f"
  if ! bash "$f"; then status=1; fi
done
printf '\n'
if [ "$status" -eq 0 ]; then echo "ALL TEST FILES PASSED"; else echo "TEST FAILURES PRESENT"; fi
exit "$status"
