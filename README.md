# Enterprise Skills Release Governor — GitHub Action

One `uses:` block puts a deterministic, evidence-bound PASS/FAIL on every pull
request. The [Enterprise Skills](https://enterpriseskills.ai) GitHub App opens
the `enterprise-skills/release-governor` check; this action produces the
decision that completes it.

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

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `license-key` | yes | — | Your Enterprise Skills license key, from a repo secret. **Planted, never device-activated** — device seats are for workstations; an ephemeral runner would burn one per run. |
| `anthropic-api-key` | no | `""` | Funds the headless evidence phase. Absent = the phase is skipped with a visible notice. |
| `evidence` | no | `agents` | `agents` (PR-scale semantic agents, minutes) · `release-readiness` (full workflow, up to 90 min) · `none`. |
| `cli-version` | no | `^4.12.0` | The `enterprise-skills` npm version/range to run. |

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

install CLI → plant the license file → *(optionally)* run the headless
evidence phase → `govern --post`, which classifies the diff, evaluates the
committed evidence against versioned policy, prints the decision, and posts it
— completing the required check with a countersigned, independently verifiable
record. Setup and full docs: <https://enterpriseskills.ai/release-gates>.
