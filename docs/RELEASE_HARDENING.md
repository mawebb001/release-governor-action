# Release Hardening Ledger — release-governor-action

Append-only. Entries carry sequential `RH-YYYYMMDD-NNN` identifiers (UTC
date; this repository's own sequence — the hub ledger in
`cursor_enterprise_skills/docs/RELEASE_HARDENING.md` is separate and is cited
by id where relevant). An entry is never edited after it lands; corrections
append a new entry that cites the one it corrects. Classifications:
`IMPLEMENTED BUT NOT PROVEN` (implementation complete, awaiting independent
verification) and `FIXED AND PROVEN` (written only by an independent
verifier, never by the implementer).

## Rollup

| id | finding | classification | branch | implementation commit |
| --- | --- | --- | --- | --- |
| RH-20260821-001 | ES-P0-ACTION-CREDENTIAL-SCOPE (Action half) | IMPLEMENTED BUT NOT PROVEN | fix/es-p0-action-credential-boundary | 82cdf1d4621724734d7439937920f718f547ad42 |

---

## RH-20260821-001 — ES-P0-ACTION-CREDENTIAL-SCOPE, Action half (implementation)

- **Classification:** IMPLEMENTED BUT NOT PROVEN (independent verification
  pending; the implementer does not write FIXED AND PROVEN).
- **Repository:** `mawebb001/release-governor-action`.
- **Branch:** `fix/es-p0-action-credential-boundary`, cut from `origin/main`
  at `7a935a087997c944b9462887b56b7df1a6e11b71` (tracked tree clean at cut;
  the only untracked path was `.project-ai/`, session artifacts written by
  the locally installed CLI's `context gate` / `orchestrate` during session
  start — left untracked, not committed).
- **Implementation commit:** `82cdf1d4621724734d7439937920f718f547ad42`
  (this ledger entry is a separate, following commit so it can cite the sha).
- **Companion:** the CLI half is hub RH-20260820-003 (cli 4.31.0,
  `packages/cli/src/lib/child-boundary.ts`), whose independent clean-room
  verification **failed** (hub RH-20260820-003V) and which is **not
  published**. Nothing here depends on it: the Action holds the boundary
  itself, against the published CLI.
- **Defect (confirmed by reading the shipped action.yml at 7a935a0):**
  `npm install -g "enterprise-skills@${{ inputs.cli-version }}"` with default
  `^4.14.0` and `npm install -g @anthropic-ai/claude-code` (latest) — mutable,
  resolved at run time, lifecycle scripts enabled; the semantic-agent step ran
  `claude -p ... --permission-mode acceptEdits` over pull-request content with
  `ANTHROPIC_API_KEY` and `ES_LICENSE_KEY` in scope on every `pull_request`
  event (same-repository PRs receive secrets); every CLI process inherited the
  step's full environment (job-level `GITHUB_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_*`
  from `id-token: write`, `NODE_OPTIONS`, `npm_config_*`); no trust
  classification of the event; a pre-4.14 fallback wrote the license key to
  `~/.enterprise-skills/license.json`.

### Exact CLI version and registry evidence

The action pins **`enterprise-skills@4.30.2`** — the newest published
version, proven from the registry and cross-checked independently:

| evidence | value |
| --- | --- |
| `npm view enterprise-skills dist-tags` | `latest: 4.30.2` |
| publish time (`npm view enterprise-skills time`) | `4.30.2: 2026-08-21T01:14:02.331Z` |
| `dist.tarball` | `https://registry.npmjs.org/enterprise-skills/-/enterprise-skills-4.30.2.tgz` |
| `dist.integrity` (registry-stated) | `sha512-P0lvRRUcsr2QU8znG9q4kRXuvIhNZrQFSIKY4DVNYpoBhnlRGwTreAbpbYFUJYtpSbDB92mbV/FQQ1iFy1yqpQ==` |
| `dist.shasum` (registry-stated) | `25939329b538fc9a9abb47a6eeca8cf52421ff63` |
| independent recomputation (`npm pack enterprise-skills@4.30.2`, `openssl dgst -sha512` / `-sha1` on the fetched tarball) | sha512 and sha1 **match** the registry values above |
| `dist.signatures` | keyid `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U` (npm registry signing key), sig recorded by the registry |
| lockfile (`deps/cli/package-lock.json`) | `packages["node_modules/enterprise-skills"].version = 4.30.2`, integrity identical to `dist.integrity`; 102 locked packages, every one with sha512 integrity and an exact version, every `resolved` on `registry.npmjs.org` |
| hub source (`cursor_enterprise_skills`) | `origin/main` = `59a1a65`; `packages/cli/package.json` on main = `4.30.2`; the version was set by `257eafe` (#274, the journal fence, cli 4.30.2); hub RH-20260820-002 records that fence as FIXED AND PROVEN (independent) at verified target `0de9e79`, whose content #274 squash-merged |
| hub tags | `v4.30.0`, `v4.30.1` exist; **no `v4.30.2` tag yet** — see residual conditions |
| locally installed CLI at session start | `4.29.0` (not used; the action installs from its lockfile) |

What 4.30.2 does with credentials (read from the fetched tarball's `dist/`):
`commands/govern.js` resolves the license env-first (`lib/license-key.js`:
`ES_LICENSE_KEY`) and attaches an OIDC token when
`ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN` are present (`lib/oidc.js`, audience
`enterprise-skills`, non-fatal when absent); `commands/agents.js` references no
license at all; `lib/tree-spawn.js` / `commands/orchestrate-run-workflow.js`
spawn the agent command with `shell: true` and the CLI's own environment
inherited; no `--pass-env`, no `child-boundary`, no `classifyTrust` exist in
4.30.2. Therefore the environment the Action hands the CLI is exactly what the
agent inherits — which is why the Action scopes it.

The semantic-agent runtime pin is **`@anthropic-ai/claude-code@2.1.238`**
(`npm view` latest at 2026-08-20T20:32:25Z; `dist.integrity`
`sha512-8AgGrM8qxsA5B8KU/MvVND/fMUsF3vZQxeYjz+1Z/rGx/ZmNr0iqjfmUVKVASKN7P9OzkAUHoXgKEpyvgRfUkA==`;
lockfile identical; platform binaries are optionalDependencies at the same
exact version, each integrity-locked). Its `postinstall` (`node install.cjs`)
only places the platform binary from the already-locked optional dependency —
read in full from the fetched tarball; the action runs that one script by
name after a `--ignore-scripts` install.

### Dependency pins (exact, immutable)

| dependency | exact reference | where |
| --- | --- | --- |
| `enterprise-skills` | `4.30.2`, `sha512-P0lvRRUc…yqpQ==` | `deps/cli/package.json` + `deps/cli/package-lock.json` (lockfileVersion 3, 102 packages) |
| `@anthropic-ai/claude-code` | `2.1.238`, `sha512-8AgGrM8q…RfUkA==` | `deps/agent/package.json` + `deps/agent/package-lock.json` (lockfileVersion 3, 9 packages incl. platform binaries) |
| `actions/checkout` (documented + CI) | `11d5960a326750d5838078e36cf38b85af677262` (v4) | README workflows, `.github/workflows/test.yml` |
| `actions/setup-node` (CI) | `49933ea5288caeca8642d1e84afbd3f7d6820020` (v4) | `.github/workflows/test.yml` |
| test fixture `postinstall-spy` | `1.0.0`, local tarball `sha512-/FSjoHBJstg33U2QrIodrY++JbB8IBgkpBzZKRbWrmUix72dqVj1wleQAyqxUF9tkT9FMtdvBi97X9SSFkdRtA==` | `tests/fixtures/` |

Install mechanics: `npm ci --ignore-scripts --no-audit --no-fund` from the
committed lockfile, in the action's own directory (`$GITHUB_ACTION_PATH/deps/<set>`),
under the scoped environment (no `npm_config_*`, no `NODE_OPTIONS`, no
credential). The installed version is re-read from `node_modules/<pkg>/package.json`
and from `<bin> --version` and must equal the lock pin. `cli-version` is
validated as exact semver and must equal the locked pin (default `4.30.2`);
ranges, dist-tags and other exact versions fail the run. No `npm install -g`,
no `npx`, anywhere.

### Step-level environment boundaries

| step (action.yml id) | credential in step env | runs | child env (rg_scoped_exec) |
| --- | --- | --- | --- |
| `inputs` (validate) | none | `scripts/validate-inputs.sh` | — |
| `trust` (resolve) | none | `scripts/resolve-trust.sh` | — |
| `preflight` | none — `LICENSE_PRESENT=${{ inputs.license-key != '' }}`, `ANTHROPIC_PRESENT=${{ inputs.anthropic-api-key != '' }}` (runner-computed booleans) | `scripts/preflight.sh` | — |
| `install-cli` | none | `npm ci --ignore-scripts` (deps/cli) | allowlist only |
| `install-agent` (trusted + funded only) | none | `npm ci --ignore-scripts` (deps/agent) + `node install.cjs` by name | allowlist only |
| `evidence` (trusted + funded only) | `ANTHROPIC_API_KEY` | `enterprise-skills agents run …` / `orchestrate workflow run release-readiness …` | allowlist + `ANTHROPIC_API_KEY` |
| `govern` | `ES_LICENSE_KEY` | `enterprise-skills govern --post --base … [--pr N]` | allowlist + `ES_LICENSE_KEY` (+ `ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN` when the job granted `id-token: write`) |

`rg_scoped_exec` (`scripts/lib.sh`) rebuilds the child environment with
`env -i`: allowlist = process/locale (`PATH HOME USER … CI TMPDIR TMP TEMP`,
`LC_*`, `XDG_*`), Windows process essentials, egress configuration
(`HTTP(S)_PROXY`, `NO_PROXY`, `SSL_CERT_*`, `NODE_EXTRA_CA_CERTS`,
`REQUESTS_CA_BUNDLE`), GitHub non-secret coordinates (`GITHUB_ACTIONS`,
`GITHUB_WORKSPACE`, `GITHUB_REPOSITORY(_OWNER)`, `GITHUB_SHA`, `GITHUB_REF*`,
`GITHUB_BASE_REF`, `GITHUB_HEAD_REF`, `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`,
`GITHUB_RUN_*`, `GITHUB_JOB`, `GITHUB_WORKFLOW`, `GITHUB_ACTOR`,
`GITHUB_SERVER_URL`, `GITHUB_API_URL`, `RUNNER_OS`, `RUNNER_ARCH`). Hard deny
(never inherited, never passable): `GITHUB_TOKEN`, `GH_TOKEN`,
`GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GITHUB_ENV`, `GITHUB_PATH`,
`GITHUB_OUTPUT`, `GITHUB_STATE`, `GITHUB_STEP_SUMMARY`, `NPM_TOKEN`,
`NODE_AUTH_TOKEN`, `NODE_OPTIONS`, `ACTIONS_RUNTIME_TOKEN/URL`,
`ACTIONS_RESULTS_URL`, `ACTIONS_CACHE_URL`; prefixes `ACTIONS_*`, `INPUT_*`,
`NPM_CONFIG_*`, `npm_config_*`. Passable by name (`--pass`), complete set:
`ES_LICENSE_KEY`, `ENTERPRISE_SKILLS_LICENSE_KEY`, `ANTHROPIC_API_KEY`; the
OIDC pair only via `--pass-oidc`, used by `run-govern.sh` alone. Refusals
return 2 before any spawn; a post-condition re-checks the constructed
environment. Secrets are never interpolated into a `run:` line
(static-checked). `RUNNER_TEMP` is not allowlisted (same reasoning as the CLI
half: it is where the runner file commands live).

### Event trust matrix (scripts/resolve-trust.sh)

| trust | event / condition | AI evidence | govern (license) | missing license |
| --- | --- | --- | --- | --- |
| `fork-pr` | `pull_request`/`_review`/`_review_comment` with head repo ≠ base repo, `head.repo.fork == true`, head repo absent, or payload unreadable | no | n/a (GitHub gives forks no secrets) | `::notice`, outputs `proceed=false outcome=skipped-fork-no-license`, exit 0, nothing installed |
| `same-repo-pr` | `pull_request*` with head repo == base repo (any `author_association`; recorded, never elevates) | **no** — `anthropic-api-key` never reaches any process | yes | `::error`, exit 1, nothing installed |
| `pr-target` | `pull_request_target` | no (+ `::warning`) | yes | `::error`, exit 1 |
| `merge-queue` | `merge_group` | no | yes | `::error`, exit 1 |
| `protected-branch` | `push` to `refs/heads/<default_branch>` or a `trusted-refs` entry | **yes** (if funded) | yes | `::error`, exit 1 |
| `branch-push` | `push` elsewhere (incl. tags) | no | yes | `::error`, exit 1 |
| `trusted-manual` | `workflow_dispatch`/`schedule` on the default branch or a `trusted-refs` entry | **yes** (if funded) | yes | `::error`, exit 1 |
| `manual-other-ref` | `workflow_dispatch`/`schedule` elsewhere | no | yes | `::error`, exit 1 |
| `unknown-event` / `not-actions` | any other event / `GITHUB_ACTIONS != true` | no | yes | `::error`, exit 1 |

Deliberately stricter than the CLI half on one axis: the CLI half allows an
OWNER/MEMBER/COLLABORATOR same-repository PR to run agents under its
allowlist; this action runs **no** credential-bearing AI execution on any
pull-request content (the ticket's "same-repository contributor PRs do not
receive credential-bearing AI execution", applied to all same-repository PRs
because the published CLI has no child boundary of its own). Persisted
checkout credentials (`http.*.extraheader` with `Authorization`, or a
credential-bearing `remote.origin.url`) fail closed (`exit 1`,
`outcome=blocked-checkout-credentials`) when AI would run, and warn otherwise.
`run-evidence.sh` re-checks `AI_ALLOWED`/`AI_RUN` and refuses before any spawn
(defense in depth behind the step `if:`).

### Files

- `action.yml` — rewritten: inputs `license-key`, `anthropic-api-key`,
  `evidence`, `cli-version` (default `4.30.2`, must equal the lock),
  `trusted-refs`, `base-ref`; outputs `trust`, `ai-evidence`, `outcome`,
  `cli-version`; seven thin steps delegating to scripts; secrets on exactly one
  step each; the pre-4.14 license-file planting step removed.
- `scripts/lib.sh` (boundary), `validate-inputs.sh`, `resolve-trust.sh`,
  `preflight.sh`, `install-deps.sh`, `run-evidence.sh`, `run-govern.sh`.
- `deps/cli/{package.json,package-lock.json}`, `deps/agent/{package.json,package-lock.json}`.
- `tests/run.sh`, `tests/helpers.sh`, `tests/static_checks.py`,
  `tests/test_00_static.sh`, `test_10_scoped_env.sh`, `test_20_trust.sh`,
  `test_30_preflight.sh`, `test_40_install.sh`, `test_50_evidence_govern.sh`,
  `test_60_checkout.sh`, `tests/fixtures/{postinstall-spy/,postinstall-spy-1.0.0.tgz,locked-consumer/}`.
- `.github/workflows/test.yml` (sha-pinned checkout with
  `persist-credentials: false`, `permissions: contents: read`, no secrets;
  runs the suite and one live locked CLI install).
- `README.md` (sha-pinned checkout, `persist-credentials: false`, least
  permissions, PR head ref, trust matrix, per-step credential table,
  trusted-evidence workflow, pins), `.gitignore`, `.gitattributes`
  (`eol=lf`).

### Tests and commands (Windows 11, git-bash, node 22.14.0, npm 10.9.2, python 3 + PyYAML, jq; 2026-08-21 UTC)

`bash tests/run.sh` — **ALL TEST FILES PASSED**, 412 assertions:
static 17 · scoped-env 86 · trust 72 · preflight 69 · install 58 ·
evidence-govern 94 · checkout 16. Every credential value in the suite is a
placeholder containing `PLACEHOLDER`; the CLI and the agent are stubs that
record environment NAMES and argv; no network except the one live install
below; no Enterprise Skills, Anthropic or GitHub operation.

Live locked install (registry only, no credentials):
`GITHUB_ACTION_PATH=$PWD bash scripts/install-deps.sh cli` with placeholder
`ES_LICENSE_KEY`/`GITHUB_TOKEN` exported in the parent — `added 102 packages
in 13s`, `enterprise-skills --version: 4.30.2` (read under the scoped
environment), `cli_version=4.30.2`.

Registry/provenance commands: `npm view enterprise-skills version dist-tags
time dist.integrity dist.shasum dist.tarball dist.signatures`, `npm pack
enterprise-skills@4.30.2 --ignore-scripts` + `openssl dgst -sha512 -binary |
openssl base64 -A` and `-sha1`, `npm view @anthropic-ai/claude-code …`, `npm
pack @anthropic-ai/claude-code@2.1.238` (to read `install.cjs`),
`git -C <hub> log/tag/show` for `origin/main`, `packages/cli/package.json`,
`257eafe`, `git ls-remote --tags https://github.com/actions/checkout`.

### The required proofs (placeholders only; nothing leaves the machine)

1. **install-time processes cannot see protected variables** — test_40 B:
   with lifecycle scripts deliberately enabled, a scoped `npm ci` runs a
   postinstall spy that sees none of 24 protected names and zero placeholder
   values; test_40 C is the positive control (an unscoped `npm ci` spy DOES
   see them, so the detector is valid); test_40 A: the action's real install
   path (`--ignore-scripts`) never runs the spy at all; test_10: a default
   scoped child sees no protected name, no placeholder value, while
   allowlisted coordinates are present.
2. **untrusted PR analysis cannot see protected variables** — test_50: the
   governor on a same-repo PR sees exactly `ES_LICENSE_KEY` (+ the OIDC pair
   when granted) and none of `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`,
   `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RESULTS_URL`, `NPM_TOKEN`,
   `NODE_AUTH_TOKEN`, `NODE_OPTIONS`, `GITHUB_OUTPUT/ENV/PATH`, `INPUT_*`, a
   canary; a process it spawns cannot see `ANTHROPIC_API_KEY`.
3. **same-repository contributor PRs do not receive credential-bearing AI
   execution** — test_20 (OWNER/MEMBER/CONTRIBUTOR same-repo PRs all
   `same-repo-pr`, `ai_allowed=false`), test_30 (with both secrets present:
   `ai_run=false`, `ai_evidence=refused-untrusted`, notice states the key was
   not exposed), test_50 (run-evidence in `same-repo-pr`/`fork-pr`/
   `pr-target`/`merge-queue`/`branch-push` with the key present: rc 1, CLI and
   agent stubs never spawned), static (the evidence step's `if:` is gated on
   `ai_run == 'true'` and is the only holder of the key).
4. **fork behaviour is safe and explicit** — test_20 (head repo ≠ base,
   `fork: true`, deleted head repo, unreadable payload → `fork-pr`), test_30
   (no license → `::notice`, `exit 0`, `proceed=false`,
   `outcome=skipped-fork-no-license`, "Nothing was installed"), README trust
   matrix row.
5. **OIDC request variables are not inherited by untrusted children** —
   test_10 (`--pass ACTIONS_ID_TOKEN_REQUEST_TOKEN/URL` refused rc 2 without
   spawn; default child and `--pass ANTHROPIC_API_KEY` child lack the pair;
   `--pass-oidc` passes exactly the pair and nothing else from `ACTIONS_*`),
   test_50 (evidence CLI and the agent grandchild lack the pair; the governor
   alone receives it, and only when present).
6. **checkout credentials are not persisted under the documented workflow** —
   test_60 + static: every README checkout is sha-pinned with
   `persist-credentials: false` (count of checkouts == count of
   `persist-credentials: false`), `contents: read`, no `pull_request_target`;
   CI workflow likewise; runtime detection of `extraheader`/URL credentials
   proven on a real temp repo; preflight fails closed when AI would run.
7. **exact dependency versions are enforced** — static (package.json deps
   exact; every locked package has exact version + sha512 integrity + npmjs
   `resolved`; `cli-version` default == lock), test_40 D (a tampered
   integrity makes `npm ci` refuse with `EINTEGRITY`, nothing installed),
   test_40 E (`^4.14.0`, `~4.30.0`, `latest`, `4.30.1`, `4.31.0` refused;
   `4.30.2`/empty accepted), live install reports `4.30.2`.
8. **missing secrets produce a safe, documented result** — test_30 (every
   non-fork context without a license: `::error`, exit 1,
   `outcome=blocked-missing-license`, nothing installed; fork: notice/skip;
   unfunded trusted: `skipped-unfunded` notice), test_50 (`run-govern.sh`
   without `ES_LICENSE_KEY`: exit 1, no spawn; `run-evidence.sh` without
   `ANTHROPIC_API_KEY`: exit 1, no spawn), README inputs table.
9. **no test performs real credential or production operations** — static
   credential-pattern scan over scripts/, tests/, action.yml, README, docs,
   workflows (no `sk-ant-…`, `ghp_…`, `github_pat_…`, AKIA…, private keys);
   all values carry `PLACEHOLDER`; stubs replace both CLIs; the only network
   call is the registry fetch of the locked CLI.

### Residual conditions (stated, not glossed)

- **Not run on a real GitHub runner end to end.** The composite action was
  exercised script-by-script with stubs and placeholders on Windows; the CI
  workflow (`.github/workflows/test.yml`) will run the suite and the live CLI
  install on `ubuntu-latest` once the branch is pushed, but no run against
  the live Enterprise Skills App / API with a real license has been made.
  Independent verification should run the action from a workflow in a
  scratch repository (fork PR, same-repo PR, push to default branch).
- **Agent runtime install path not exercised live.** `install-deps.sh agent`
  (`npm ci --ignore-scripts` + `node install.cjs` + `claude --version`) is
  covered by the pin/integrity static checks and by the fixture-based
  lifecycle proofs, but the ~500 MB platform binary was not downloaded here
  and CI deliberately installs only the CLI. `@anthropic-ai/claude-code`
  declares `engines.node >= 22`; the native binary does not need node, but on
  a runner whose default node is 20 `npm ci` will print `EBADENGINE` warnings
  (not fail). Not verified on a runner.
- **The published CLI (4.30.2) has no child boundary of its own** — its agent
  spawn is `shell: true` with inherited env. The Action's scoped environment
  is therefore the only line; it is sufficient for the names listed above but
  it is an Action-level control, not a CLI-level one. When a verified CLI with
  `child-boundary` ships (4.31.0 failed verification, hub RH-20260820-003V),
  the evidence step should additionally pass `--pass-env ANTHROPIC_API_KEY`
  and the same-repo-PR policy can be revisited against the CLI's classifier.
- **No OS or network sandbox.** Scoped children run as the same user with the
  runner's network; `HOME` is allowlisted, so on-disk files (`~/.npmrc`,
  `~/.claude`, `~/.enterprise-skills`) remain reachable to a trusted-context
  agent. This is why untrusted content never gets AI execution here.
- **Tarball-to-commit binding for 4.30.2 is by version + ledger, not by tag.**
  The hub has no `v4.30.2` git tag yet (v4.30.0/v4.30.1 exist); the registry
  integrity and signature are recorded, and the hub's main carries 4.30.2
  from #274, but a byte-level comparison of the published `dist/` against a
  build of `257eafe` was not performed.
- **Branch protection is not queried.** "Protected" = default branch +
  `trusted-refs`; a `push` to any other branch is untrusted. Operators who
  protect additional branches must list them.
- **`pull_request_target` still runs the deterministic governor** with the
  license (no AI), because the diff classification is content-reading but not
  content-executing; a warning is emitted. Operators should use
  `pull_request`.
- **Same-repository PRs get no AI evidence through this action** (by design;
  see the matrix). Per-PR AI evidence now comes from committed session
  evidence or the trusted-evidence workflow; this is a product behaviour
  change that the README states.
- **Interface changes:** `cli-version` must equal the locked pin (previously
  any range); the pre-4.14 license-file fallback is removed (an exact pin
  below 4.14 is refused by the pin check). New inputs `trusted-refs`,
  `base-ref`; new outputs. `@v1` was NOT retagged; nothing was merged or
  published.
- **`.project-ai/` session artifacts** written by the local CLI remain
  untracked in the working tree; they are not part of the change.
- **Windows-specific:** `rg_scoped_exec` enumerates names via `compgen -e`,
  which omits environment entries whose names are not valid shell
  identifiers (e.g. `ProgramFiles(x86)`); children on Windows runners lose
  those entries. The action targets `ubuntu-latest`.

### Open release conditions

- Independent verification of this branch head (clean-room: check out
  `82cdf1d…`, run `bash tests/run.sh`, run the action from a scratch
  repository in the fork / same-repo PR / default-branch push contexts with
  placeholder or scoped real credentials, attempt bypasses not enumerated
  here — e.g. job-level `env:` with `GITHUB_TOKEN`, `id-token: write`,
  `NODE_OPTIONS`, a `.npmrc` in the governed repository).
- Merge, `v1` retag and release notes (deliberately NOT performed).
- The hub's companion CLI half (4.31.0) remains unpublished and unverified;
  no pin here depends on it.
