# Session Checkpoint

## Last Updated
2026-08-21 (UTC) — end of the ES-P0-ACTION-CREDENTIAL-SCOPE implementation session

## Session Summary
Implemented the Action half of ES-P0-ACTION-CREDENTIAL-SCOPE on
`fix/es-p0-action-credential-boundary`: exact, integrity-locked installs
(enterprise-skills 4.30.2, @anthropic-ai/claude-code 2.1.238), step-level
credential scope, an `env -i` allowlist boundary for every CLI process, an
explicit event trust matrix (AI evidence never on pull-request content),
fail-safe missing-secret handling, and a 412-assertion offline test suite.
Recorded as RH-20260821-001 (IMPLEMENTED BUT NOT PROVEN) in
`docs/RELEASE_HARDENING.md`. Pushed; not merged, `v1` not retagged.

## Changes Made
- `action.yml` — rewritten into seven thin steps delegating to `scripts/`; secrets on exactly one step each; pre-4.14 license-file planting removed; new inputs `trusted-refs`, `base-ref`; outputs `trust`, `ai-evidence`, `outcome`, `cli-version`.
- `scripts/lib.sh` — `rg_scoped_exec` boundary (allowlist / hard deny / named pass / OIDC pair), locked `npm ci`, base resolution, checkout-credential scan.
- `scripts/{validate-inputs,resolve-trust,preflight,install-deps,run-evidence,run-govern}.sh`.
- `deps/cli`, `deps/agent` — package.json + package-lock.json (exact pins, sha512 for every package).
- `tests/` — run.sh, helpers, static_checks.py, seven test files, offline install fixture.
- `.github/workflows/test.yml` — sha-pinned, `persist-credentials: false`, `contents: read`, no secrets.
- `README.md` — sha-pinned checkout guidance, trust matrix, per-step credential table, trusted-evidence workflow, pins.
- `docs/RELEASE_HARDENING.md` — ledger created, RH-20260821-001.
- `.gitignore`, `.gitattributes` (`eol=lf`).

## Decisions Made
- Pin the **published** CLI 4.30.2 (registry integrity + independently recomputed hash + hub main at 4.30.2), not the unpublished 4.31.0 CLI half whose independent verification failed (hub RH-20260820-003V). The Action holds its own boundary because 4.30.2 spawns agents with `shell: true` and inherited env.
- No credential-bearing AI execution on **any** pull-request content (fork or same-repo), stricter than the CLI half's OWNER/MEMBER allowance; AI evidence only on push to the default branch / `trusted-refs` or manual dispatch there.
- `cli-version` input must equal the locked pin (installed from a committed lockfile, never a range); the <4.14 on-disk license fallback removed as part of the defect class.
- Fork PR without a license = notice + exit 0 (GitHub gives forks no secrets); every other context without a license = error before anything is installed.
- Persisted checkout credentials fail closed when AI would run, warn otherwise.
- Ledger sequence is this repo's own (`RH-20260821-001`); the hub's ledger is cited by id.

## Current State
- **Branch**: `fix/es-p0-action-credential-boundary` (HEAD `200f177`, impl `82cdf1d`), tracking origin, in sync
- **Build Status**: n/a (composite action; static validation passes)
- **Test Status**: passing — `bash tests/run.sh` 412/412; live locked CLI install → 4.30.2
- **Governance State**: enterprise authority pack and Cursor governance artifacts initialized; runtime receipts, orchestration audit, and active session state remain intentionally untracked

## Known Issues
- Not yet run end to end on a real GitHub runner or against the live App/API; CI workflow triggers only on PR or push to main.
- Agent-runtime install path (`install.cjs`, ~500 MB binary) not exercised live; Node ≥22 engine warning on Node-20 runners unverified.
- No `v4.30.2` git tag in the hub — tarball↔commit binding is by version + ledger.
- Windows: `compgen -e` omits non-identifier env names; action targets ubuntu-latest.

## Next TODO

### Agent Tasks
1. Independent clean-room verification of `82cdf1d` (run the suite, then the action from a scratch repo in fork-PR / same-repo-PR / default-branch-push contexts; attempt bypasses: job-level `GITHUB_TOKEN` env, `id-token: write`, `NODE_OPTIONS`, `.npmrc` in the governed repo) — to be done by a verifier, not the implementer; the verifier appends RH-20260821-003.
2. If/when a verified CLI with `child-boundary` is published, bump `deps/cli` lock, add `--pass-env ANTHROPIC_API_KEY` to the evidence step, revisit the same-repo-PR policy against the CLI's classifier.

### External Tasks (User Action Required)
1. Open the PR for `fix/es-p0-action-credential-boundary` (GitHub) — not opened by the agent; its `Action tests` workflow runs on PR.
2. Decide on merge + `v1` retag after independent verification (GitHub releases) — deliberately not performed.

Status reconfirmed 2026-08-20 (America/Los_Angeles): both items remain pending (user confirmed).

## Completed Since Last Checkpoint
- 2026-08-21 ES-P0-ACTION-CREDENTIAL-SCOPE Action half implemented, tested (412 assertions), ledgered, pushed — verified by `git log origin/fix/es-p0-action-credential-boundary` = `46c7781`.
- 2026-08-20 Authority pack initialized with the enterprise profile; `enterprise-skills validate --json` reports `complete` and `context gate` passes (filesystem and executable evidence).

## Files Modified This Session
- `action.yml`, `README.md` — rewritten (see Changes Made)
- `scripts/*.sh` (7 files) — new
- `deps/cli/*`, `deps/agent/*` — new
- `tests/**` — new
- `.github/workflows/test.yml`, `.gitignore`, `.gitattributes` — new
- `docs/RELEASE_HARDENING.md`, `docs/SESSION_CHECKPOINT.md` — new
