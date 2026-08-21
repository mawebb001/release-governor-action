# Project Stack Manifest

## Locked Configuration

- **Generated:** 2026-08-20 (America/Los_Angeles)
- **Project:** release-governor-action
- **Description:** Composite GitHub Action that runs Enterprise Skills release-governance checks under explicit trust and credential boundaries.
- **Language:** Bash, with YAML action/workflow definitions, Python static checks, and locked Node runtimes
- **Framework:** GitHub Actions composite action
- **Database:** none
- **Auth:** none; GitHub and service credentials are passed only to scoped child processes
- **Payments:** none
- **Services:** GitHub Actions, Enterprise Skills, Anthropic (optional trusted evidence phase)
- **Architecture:** thin composite-action steps delegating to defensive shell scripts

## Governance

- **Profile:** enterprise
- **Active Skills:** 8 Community-tier skills
- **Authority Pack:** `.project-ai/`

## Commands

- **Dev Server:** not applicable
- **Type Check:** not configured
- **Lint:** `python tests/static_checks.py`
- **Test:** `bash tests/run.sh`
- **Build:** not applicable

## Key Patterns

- **Auth Check:** not applicable
- **DB Query:** not applicable
- **API Route Location:** not applicable
- **Service Layer:** `scripts/`
- **Component Layer:** not applicable
- **Error Response:** `rg_error` followed by a non-zero exit
- **Logger:** source `scripts/lib.sh`; use `rg_log`, `rg_notice`, `rg_warn`, or `rg_error`

## Environment Variables

Documented in `action.yml` and `README.md`; no `.env` file is used.

## LOCKED — Do not edit manually

Run `init project skills` to regenerate.
