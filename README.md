# Enterprise Skills Release Governor — GitHub Action

One `uses:` block runs the Release Governor on a pull request and posts its
deterministic, evidence-bound PASS/FAIL. The
[Enterprise Skills](https://enterpriseskills.ai) GitHub App opens the
`enterprise-skills/release-governor` check; this action produces the decision
that completes it.

## Usage

```yaml
name: Release Governor
on:
  pull_request:
    branches: [main]

jobs:
  govern:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # optional: lets the decision carry a CI attestation
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # govern classifies base...HEAD and needs the PR head object

      - uses: mawebb001/release-governor-action@v1
        with:
          license-key: ${{ secrets.ES_LICENSE_KEY }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }} # optional — funds the evidence phase
```

The agent runs as the same OS user as the CLI, so it can read the
environment of the CLI process that started it, with or without
`--pass-env`: measured with cli 4.31.0 and a stub agent, that environment
held `ANTHROPIC_API_KEY` and the other credential names the measurement set
on the evidence step (`ES_LICENSE_KEY`, `GITHUB_TOKEN`,
`ACTIONS_ID_TOKEN_REQUEST_TOKEN`).

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `license-key` | yes | — | Your Enterprise Skills license key, from a repo secret. Rides as **`ES_LICENSE_KEY` env** only on the license-compatibility and govern steps, not on an evidence step where an agent runs. The action does not device-activate it, and on an installed cli ≥ 4.14 writes no license file. Mint a dedicated CI service key with `enterprise-skills license mint-ci` instead of reusing a workstation key. |
| `anthropic-api-key` | no | `""` | Funds the headless evidence phase. Absent = the phase is skipped with a visible notice. |
| `evidence` | no | `agents` | `agents` (PR-scale semantic agents, minutes) · `release-readiness` (full workflow, up to 90 min) · `none`. Any other value fails the job after the govern step runs. |
| `cli-version` | no | `4.31.0` | The `enterprise-skills` npm version (`4.31.0`) or semver range (`^4.31.0`, `>=4.31.0 <5.0.0`). Anything else, such as a dist-tag or an `npm:` alias, fails the job before anything is installed. The evidence phase needs an installed plain release ≥ 4.31.0; on an older release the govern step still runs, and when the evidence phase was asked for and funded the job then fails. |

## Three things that will bite you if you skip them

1. **`fetch-depth: 0`.** `govern` diffs `base...HEAD`; a shallow clone has no
   base, and on `pull_request` events the PR head object must be reachable so
   the CLI can decide against it (it self-corrects away from the synthetic
   merge commit when the head is present).
2. **No evidence funded ≠ broken.** On evidence-requiring diffs, an unfunded
   run is an honest FAIL in enforce mode — the policy working. While adopting,
   put `mode: warn` in `.project-ai/GOVERNOR_POLICY.yaml`: the verdict stays
   honest and recorded, the check completes neutral, nothing blocks. Graduate
   to `enforce` when the evidence phase is funded. (An "observe PASS" can
   never be pitched as governance — the mode is stamped into the decision
   record and the check title.)
3. **The repo cap is real.** Active repositories are counted per license
   (Pro 3 · Team 10 · Enterprise contract). A 402 from the decision post is
   the entitlement working, not the action failing.

## What this action does, exactly

validate `cli-version` and install the CLI → read the installed version once
(a version it cannot read fails the job here) → hand the license to the
compatibility step as `ES_LICENSE_KEY` env → *(optionally, on cli ≥ 4.31.0)*
install the pinned Claude Code in a step that sets neither key → check for a
license file in the runner's home → run the headless evidence phase →
`govern --post`, which classifies the diff, evaluates the committed evidence
against versioned policy, prints the decision, and posts it — completing the
required check with a countersigned, independently verifiable record → fail
the job if the evidence phase failed or was refused, or if the `evidence`
input is invalid. Setup and full docs:
<https://enterpriseskills.ai/release-gates>.

The action does not set up Node. `@anthropic-ai/claude-code@2.1.285` declares
`node >=22.0.0`; on Node 20.19.0, npm installs it with an `EBADENGINE` warning
and `claude --version` and `claude --help` exit 0 (an agent run on Node 20 was
not measured).

Keep keys out of job-level `env:`. The Claude Code install step sets no key,
but a job-level `env:` name reaches it: this repository's runner check
(`action-runner-proof`) sets one and records it in that step's environment.

## Backward compatibility: pinning an older CLI

The evidence phase needs a plain release ≥ 4.31.0. In 4.31.0 the agent gets
an allowlisted environment: the vendor key is in it because both evidence
steps pass `--pass-env ANTHROPIC_API_KEY` (without the flag, no
credential-like name is in it), and the action does not put `ES_LICENSE_KEY`
in the environment of either evidence step. What the agent can read outside
that environment is under Usage. 4.30.2, the release before 4.31.0, rejects
`--pass-env`, and without it gives the agent the step's whole environment.
So the action
reads the **installed** version once: below 4.31.0, or a pre-release, it skips
both evidence steps with an error annotation naming the fix; the govern step
runs, and when the evidence phase was asked for and funded, the job then
fails. When `enterprise-skills --version` fails or
prints something that is not a version, the job fails at that step with an
error naming the fix, and the govern step does not run.

The allowlist passes `HOME` to the agent, so a license file in the runner's
home is readable by the agent whoever wrote it. The action therefore refuses
the evidence phase while `~/.enterprise-skills/license.json` exists (or when
it cannot tell), with an error annotation naming the fix; it does not change
the file, the govern step runs, and the job then fails. The check runs after
the Claude Code install, as the last step before the evidence steps.

When an evidence step or the Claude Code install fails, the govern step still
runs over the evidence that exists, and a last step then fails the job. That
last step also fails the job when the `evidence` input is not `agents`,
`release-readiness` or `none`.

Since `enterprise-skills` 4.14.0 the CLI resolves `ES_LICENSE_KEY` env-first
on every posting path (`govern --post`, `deploy record`/`gate`,
`journey run`), so this action passes the license as env to the govern step
and — on cli ≥ 4.14 — writes nothing to disk. Older releases read only a
planted `~/.enterprise-skills/license.json`.

If your `cli-version` pins below 4.14 (an exact `4.13.0`, a `~4.12.0` range),
the govern step keeps working: the action checks the **installed** version at
run time and plants the keys-only license file just for those CLIs (the
evidence phase is refused, as above). Ranges like `^4.12.0`
resolve to ≥ 4.14 today and get the env-only path automatically. Either way
the key is never device-activated — device seats are for workstations, and an
ephemeral runner would burn one per run.
