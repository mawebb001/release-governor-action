# Enterprise Skills Release Governor — GitHub Action

One `uses:` block puts a deterministic, evidence-bound PASS/FAIL on every pull
request. The [Enterprise Skills](https://enterpriseskills.ai) GitHub App opens
the `enterprise-skills/release-governor` check; this action produces the
decision that completes it.

The action installs the Enterprise Skills CLI from a **committed,
integrity-locked lockfile** (exact version, every transitive package hashed),
scopes **each credential to the single step that needs it**, runs every CLI
process under an **allowlisted environment** (no job-level `GITHUB_TOKEN`, no
OIDC request variables, no `NODE_OPTIONS`/`npm_config_*`/`INPUT_*` leak
through), and runs the semantic-agent evidence phase **only in trusted
contexts** — never against pull-request content while a credential is in
scope.

## Usage (pull-request gate)

```yaml
name: Release Governor
on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  id-token: write # optional: lets the decision carry a CI attestation (passed to the governor process only)

jobs:
  govern:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: ${{ github.event.pull_request.head.sha }} # the PR HEAD, not the synthetic merge commit
          fetch-depth: 0                                 # govern classifies base...HEAD and needs history
          persist-credentials: false                     # required: no token left in .git/config

      - uses: mawebb001/release-governor-action@v1 # pin to a commit sha in production
        with:
          license-key: ${{ secrets.ES_LICENSE_KEY }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }} # optional; never used on pull_request events (see Trust matrix)
```

On `pull_request` the action governs over **committed evidence**: the
`anthropic-api-key`, if given, is not exposed to any process. To produce AI
evidence, run the action from a trusted context:

```yaml
name: Release Governor (trusted evidence)
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  govern:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          fetch-depth: 0
          persist-credentials: false # the action fails closed if a token is persisted here and AI evidence would run

      - uses: mawebb001/release-governor-action@v1
        with:
          license-key: ${{ secrets.ES_LICENSE_KEY }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          base-ref: origin/main # for workflow_dispatch; push events use the event's "before" commit by default
```

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `license-key` | yes | — | Your Enterprise Skills license key, from a repo secret. Present in **exactly one step** (the decision post) as `ES_LICENSE_KEY`, passed by name to the governor process only; never written to disk, never device-activated. Mint a dedicated CI service key with `enterprise-skills license mint-ci`. Empty → the run fails safely (fork PRs skip with a notice; anything else errors before anything is installed). |
| `anthropic-api-key` | no | `""` | Funds the headless evidence phase. Present in **exactly one step** (the evidence phase) and **only when the trust context permits AI** (push to the default branch or a `trusted-refs` entry; `workflow_dispatch`/`schedule` on such a ref). On `pull_request`, `pull_request_target`, `merge_group` and other branches it is never exposed to any process. Absent → the phase is skipped with a visible notice. |
| `evidence` | no | `agents` | `agents` (PR-scale semantic agents) · `release-readiness` (full workflow, up to 90 min) · `none`. |
| `cli-version` | no | `4.30.2` | The exact CLI version this action installs. It is installed from `deps/cli/package-lock.json` (exact version + integrity for the whole tree), never resolved from a range. A value other than the locked pin fails the run; ranges and dist-tags are refused. |
| `trusted-refs` | no | `""` | Extra branch names (or full refs), comma-separated, that count as protected for the AI evidence phase in addition to the repository default branch. Pull requests are never trusted regardless. |
| `base-ref` | no | `""` | Explicit base ref for diff classification (e.g. `origin/main`). Defaults to `origin/<PR base>` on pull requests and to the push event's `before` commit on pushes. |

## Outputs

| Output | Values |
|---|---|
| `trust` | `fork-pr` · `same-repo-pr` · `pr-target` · `merge-queue` · `protected-branch` · `branch-push` · `trusted-manual` · `manual-other-ref` · `unknown-event` |
| `ai-evidence` | `scheduled` · `refused-untrusted` · `skipped-unfunded` · `disabled` · `not-run` · `refused-checkout-credentials` |
| `outcome` | `decided` · `decision-failed` · `skipped-fork-no-license` · `blocked-missing-license` · `blocked-checkout-credentials` · `blocked-no-base` |
| `cli-version` | the exact CLI version installed |

## Trust matrix

The action classifies every run before it installs anything. "AI" means the
semantic-agent evidence phase (Claude Code executing over repository content
with `ANTHROPIC_API_KEY`). The deterministic governor runs in every context
that has a license.

| Context | Event | AI evidence | License-bearing govern | Notes |
|---|---|---|---|---|
| `fork-pr` | `pull_request*` whose head repo is not this repo | **no** | no (GitHub gives forks no secrets) | Notice + exit 0. Nothing installed, nothing credentialed ran. The required check stays incomplete until a trusted workflow posts the decision. |
| `same-repo-pr` | `pull_request*` from a branch in this repo | **no** | yes | Secrets ARE available to these runs; the action does not let them reach an agent. `author_association` is recorded, never used to elevate. |
| `pr-target` | `pull_request_target` | **no** (warned) | yes | Always untrusted; if your workflow checks out the PR head here, the checkout itself is the risk. Use `pull_request`. |
| `merge-queue` | `merge_group` | **no** | yes | |
| `protected-branch` | `push` to the default branch or a `trusted-refs` entry | **yes** (if funded) | yes | |
| `branch-push` | `push` elsewhere | **no** | yes | |
| `trusted-manual` | `workflow_dispatch` / `schedule` on the default branch or a `trusted-refs` entry | **yes** (if funded) | yes | Set `base-ref`. |
| `manual-other-ref`, `unknown-event` | anything else | **no** | yes | |

Branch protection cannot be queried without a token, so "protected" here means
the repository default branch plus whatever you name in `trusted-refs`.

## Credential scope, step by step

| Step | Credentials in the step's environment | Child environment |
|---|---|---|
| Validate inputs | none | — |
| Resolve trust | none | — |
| Preflight | none (receives `license-key != ''` / `anthropic-api-key != ''` as runner-computed booleans) | — |
| Install CLI (`npm ci --ignore-scripts` from `deps/cli/package-lock.json`) | none | allowlist only |
| Install agent runtime (trusted + funded only; `npm ci --ignore-scripts` from `deps/agent/package-lock.json`, then the one reviewed `install.cjs` by name) | none | allowlist only |
| Evidence phase (trusted + funded only) | `ANTHROPIC_API_KEY` | allowlist + `ANTHROPIC_API_KEY` |
| Govern + post | `ES_LICENSE_KEY` | allowlist + `ES_LICENSE_KEY` (+ the OIDC request pair when `id-token: write`, for attestation) |

Every CLI process is started with `env -i` and an explicit allowlist
(`scripts/lib.sh`): process/locale basics, proxy/CA configuration, and
GitHub's non-secret coordinates. Hard-denied at any trust level: `GITHUB_TOKEN`,
`GH_TOKEN`, the runner file commands (`GITHUB_ENV`, `GITHUB_PATH`,
`GITHUB_OUTPUT`, `GITHUB_STATE`, `GITHUB_STEP_SUMMARY`), `NODE_OPTIONS`,
`NPM_TOKEN`, `NODE_AUTH_TOKEN`, `ACTIONS_*`, `INPUT_*`, `npm_config_*`. Secrets
are never interpolated into a `run:` line.

## Three things that will bite you if you skip them

1. **`persist-credentials: false` and `fetch-depth: 0`.** The first keeps the
   workflow token out of `.git/config` (the action fails closed if it finds one
   there and AI evidence would run; on pull requests it warns). The second is
   what lets `govern` diff `base...HEAD`. On `pull_request` events check out
   `github.event.pull_request.head.sha` so the decision binds to the PR HEAD.
2. **No evidence funded ≠ broken, and no evidence on PRs is by design.** On
   evidence-requiring diffs, an unfunded run is an honest FAIL in enforce mode —
   the policy working. While adopting, put `mode: warn` in
   `.project-ai/GOVERNOR_POLICY.yaml`. To get AI evidence, commit session
   evidence with the PR or run the trusted-evidence workflow above. (An
   "observe PASS" can never be pitched as governance — the mode is stamped into
   the decision record and the check title.)
3. **The repo cap is real.** Active repositories are counted per license
   (Pro 3 · Team 10 · Enterprise contract). A 402 from the decision post is the
   entitlement working, not the action failing.

## What this action does, exactly

validate inputs → resolve trust → preflight (presence booleans, checkout
scan) → `npm ci --ignore-scripts` the CLI from the committed lockfile (no
credentials) → *(trusted + funded only)* install the agent runtime the same
way and run the headless evidence phase with `ANTHROPIC_API_KEY` alone →
`govern --post` with `ES_LICENSE_KEY` alone (+ OIDC attestation when granted),
which classifies the diff, evaluates the committed evidence against versioned
policy, prints the decision, and posts it — completing the required check with
a countersigned, independently verifiable record. Setup and full docs:
<https://enterpriseskills.ai/release-gates>.

## Pins

| Dependency | Exact version | Where |
|---|---|---|
| `enterprise-skills` | 4.30.2 | `deps/cli/package-lock.json` (sha512 integrity for all 102 packages) |
| `@anthropic-ai/claude-code` | 2.1.238 | `deps/agent/package-lock.json` (sha512 integrity, platform binaries included) |
| `actions/checkout` (documented) | `11d5960a326750d5838078e36cf38b85af677262` (v4) | README |

Pins change only by a reviewed commit to this repository. Pin **this action**
to a commit sha in production as well; `@v1` is a moving tag.

## Tests

`bash tests/run.sh` — static validation (`tests/static_checks.py`) and the
defensive dynamic proofs (scoped environment, trust matrix, preflight,
locked install, evidence/govern against stub CLIs, checkout scan). Every
credential in the tests is a placeholder containing the word `PLACEHOLDER`;
nothing contacts a registry, GitHub, Anthropic or the Enterprise Skills API.
The hardening ledger is `docs/RELEASE_HARDENING.md`.
