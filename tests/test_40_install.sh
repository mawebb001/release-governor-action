#!/usr/bin/env bash
# Locked, script-free, credential-free dependency installation.
#   A. rg_npm_ci_locked: lifecycle scripts do NOT run (spy never executes)
#   B. even with scripts enabled, a scoped install cannot see protected names
#   C. positive control: an UNSCOPED install would see them (the spy works)
#   D. a tampered integrity hash makes npm ci refuse (exact pins enforced)
#   E. real lockfiles pin the exact versions; validate-inputs enforces them
# The fixture dependency is a local tarball; no registry access is needed.
T_NAME=install
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"
source "$T_ROOT/scripts/lib.sh"; set +e

tmp=$(t_tmp); seed_protected_env "$tmp"
cp -R "$T_ROOT/tests/fixtures" "$tmp/fixtures"
consumer="$tmp/fixtures/locked-consumer"
spy_out="$consumer/node_modules/postinstall-spy/spy-ran.json"

# A
rg_npm_ci_locked "$consumer" >"$tmp/a.log" 2>&1; rc=$?
assert_rc "$rc" 0 "A: locked install succeeds offline ($(tail -n1 "$tmp/a.log" 2>/dev/null))"
assert_file_exists "$consumer/node_modules/postinstall-spy/package.json" "A: dependency installed"
assert_file_absent "$spy_out" "A: postinstall did NOT run under the locked install (lifecycle scripts disabled)"

# B — scripts enabled deliberately, but under the scoped environment
rm -rf "$consumer/node_modules"
( cd "$consumer" && rg_scoped_exec -- npm ci --no-audit --no-fund --loglevel=error ) >"$tmp/b.log" 2>&1; rc=$?
assert_rc "$rc" 0 "B: scoped install with scripts enabled succeeds ($(tail -n1 "$tmp/b.log" 2>/dev/null))"
assert_file_exists "$spy_out" "B: postinstall ran (control condition)"
if [ -f "$spy_out" ]; then
  names=" $(node -e 'const s=require(process.argv[1]);process.stdout.write(s.names.join(" "))' "$spy_out") "
  for n in "${RG_TEST_PROTECTED_NAMES[@]}" NODE_OPTIONS npm_config_registry NPM_CONFIG_LOGLEVEL GITHUB_ENV GITHUB_PATH GITHUB_OUTPUT; do
    assert_not_contains "$names" " $n " "B: install-time lifecycle script cannot see $n"
  done
  leaked=$(node -e 'const s=require(process.argv[1]);process.stdout.write(String(s.placeholder_names.length))' "$spy_out")
  assert_eq "$leaked" "0" "B: install-time lifecycle script reads zero placeholder values"
fi

# C — positive control: unscoped install (what a plain `run: npm ci` step would do)
rm -rf "$consumer/node_modules"
( cd "$consumer" && npm ci --no-audit --no-fund --loglevel=error ) >"$tmp/c.log" 2>&1; rc=$?
assert_rc "$rc" 0 "C: unscoped control install succeeds ($(tail -n1 "$tmp/c.log" 2>/dev/null))"
if [ -f "$spy_out" ]; then
  leaked=$(node -e 'const s=require(process.argv[1]);process.stdout.write(String(s.placeholder_names.length))' "$spy_out")
  assert_ne "$leaked" "0" "C: positive control — an unscoped install-time script DOES see protected names ($leaked), so the spy is a valid detector"
fi

# D — tampered integrity
rm -rf "$consumer/node_modules"
node -e '
const fs=require("fs");const p=process.argv[1];const l=JSON.parse(fs.readFileSync(p,"utf8"));
const k=Object.keys(l.packages).find(k=>k.endsWith("node_modules/postinstall-spy"));
l.packages[k].integrity="sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
fs.writeFileSync(p,JSON.stringify(l,null,2));' "$consumer/package-lock.json"
rg_npm_ci_locked "$consumer" >"$tmp/d.log" 2>&1; rc=$?
assert_ne "$rc" "0" "D: npm ci refuses a lockfile whose integrity hash does not match (rc $rc)"
assert_contains "$(cat "$tmp/d.log")" "EINTEGRITY" "D: refusal is an integrity failure"
assert_file_absent "$consumer/node_modules/postinstall-spy/package.json" "D: nothing installed after integrity refusal"

# E — real pins and validate-inputs
assert_eq "$(rg_lock_version "$T_ROOT/deps/cli/package-lock.json" enterprise-skills)" "4.30.2" "E: deps/cli lock pins enterprise-skills@4.30.2"
assert_eq "$(rg_lock_version "$T_ROOT/deps/agent/package-lock.json" @anthropic-ai/claude-code)" "2.1.238" "E: deps/agent lock pins @anthropic-ai/claude-code@2.1.238"
V="$T_ROOT/scripts/validate-inputs.sh"
vi() { : > "$GITHUB_OUTPUT"; VI_OUT=$(EVIDENCE="$1" CLI_VERSION="$2" TRUSTED_REFS="${3:-}" BASE_REF_INPUT="${4:-}" bash "$V" 2>&1); VI_RC=$?; }
vi agents "";            assert_rc "$VI_RC" 0 "E: empty cli-version accepted (defaults to pin)"; assert_eq "$(out_get "$GITHUB_OUTPUT" cli_version)" "4.30.2" "E: cli_version output is the pin"
vi agents 4.30.2;        assert_rc "$VI_RC" 0 "E: exact pin accepted"
vi agents '^4.14.0';     assert_rc "$VI_RC" 1 "E: range ^4.14.0 refused"; assert_contains "$VI_OUT" "exact version" "E: range refusal explains exactness"
vi agents '~4.30.0';     assert_rc "$VI_RC" 1 "E: range ~4.30.0 refused"
vi agents latest;        assert_rc "$VI_RC" 1 "E: dist-tag refused"
vi agents 4.30.1;        assert_rc "$VI_RC" 1 "E: a different exact version refused (pin changes only by commit)"
vi agents 4.31.0;        assert_rc "$VI_RC" 1 "E: a newer exact version refused"
vi bogus 4.30.2;         assert_rc "$VI_RC" 1 "E: unknown evidence mode refused"
vi release-readiness 4.30.2; assert_rc "$VI_RC" 0 "E: release-readiness accepted"
vi none 4.30.2;          assert_rc "$VI_RC" 0 "E: none accepted"
vi agents 4.30.2 "release/1, main" ""; assert_rc "$VI_RC" 0 "E: trusted-refs list accepted"
vi agents 4.30.2 'a;rm -rf' "";        assert_rc "$VI_RC" 1 "E: trusted-refs with shell metacharacters refused"
vi agents 4.30.2 "" "origin/main";     assert_rc "$VI_RC" 0 "E: base-ref accepted"
vi agents 4.30.2 "" "--evil";          assert_rc "$VI_RC" 1 "E: base-ref that looks like an option refused"
vi agents 4.30.2 "" 'x$(id)';          assert_rc "$VI_RC" 1 "E: base-ref with expansion refused"
bash "$T_ROOT/scripts/install-deps.sh" bogus >/dev/null 2>&1; assert_rc $? 1 "E: install-deps refuses an unknown dependency set"

rm -rf "$tmp"
t_done
