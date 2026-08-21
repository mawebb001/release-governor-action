# Decision Log

## 2026-08-20 — Authority Pack Generated

- **Generator:** `init-project-skills` using Enterprise Skills CLI 4.30.2 plus manual repair
- **Governance profile:** enterprise
- **Skills activated:** 8 Community-tier skills rendered by the installed CLI
- **Rationale:** This composite GitHub Action handles CI credentials, executes dependency tooling, and publishes release-governance decisions; credential, supply-chain, and CI-execution risks justify enterprise governance.
- **Repair evidence:** CLI initialization reported success but omitted all six mandatory authority files because it classified this root-package-less existing repository as greenfield. The installed npm package also omits `canonical-skills.yaml`, so the registry snapshot is explicitly limited to the rendered Community-tier catalog.

## 2026-08-21 06:08 UTC — Enforcement gaps recorded

- **Task:** Append the verified session-start enforcement gaps to the release-hardening ledger.
- **Type:** implementation
- **Skill used:** `governance-enforcement`
- **Preflight:** passed; authority pack and required pre-change documents loaded, task classified as implementation, no new skill requested.
- **Decision:** Record the gaps as `OPEN — NOT IMPLEMENTED`; do not add exclusions or imply remediation.

## 2026-08-21 06:14 UTC — Governance artifacts prepared for commit

- **Task:** Commit and push the initialized authority pack and enforcement-gap ledger entry.
- **Type:** implementation
- **Skills used:** `governance-enforcement`, `git-workflow-manager`
- **Preflight:** passed; feature branch matches its upstream head, required documents are loaded, and the canonical test suite passed 412 assertions.
- **Scope decision:** Commit the durable authority pack and non-licensed Cursor configuration/hooks. Keep context receipts, orchestration audit logs, active session state, and redistribution-restricted rendered skill bodies untracked because the GitHub repository is public.
