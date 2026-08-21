# Novice orchestration guide

You do **not** need to memorize 80+ skill names.

## Automatic skill routing (required — novice-safe)

This project has many skills. **The user does not know their names.** You must route automatically.

### On every user message

1. **Classify intent** using signals below (do not ask "which skill?").
2. **Load and execute** the best-matching skill file(s) from the rendered skill paths for this IDE.
3. **Apply governance** via `governance-enforcement` before any code change.
4. **Suggest at most one** follow-up skill if blocked — never dump a catalog unless asked.

### Session awareness

- **First substantial message** in a chat → run **session-start** behavior (authority pack, git status, pending work reconciliation).
- **Wind-down language** ("done", "wrap up", "last thing") → offer **session-end**.
- **Deploy / LaunchOps** language → chain **pre-deploy-check** then **launchops-agent** when vendor manifests exist.

### If stuck

- Run `enterprise-skills orchestrate next` (guided menu) — user does not need to memorize commands.
- Read `.project-ai/SKILL_AUTO_ROUTING.yaml` for machine-readable routing.

### Profile: `enterprise`

### Intent → skills (defaults)

| User signals (examples) | Load these skills first |
|-------------------------|-------------------------|
| (start session|load context|begin session)… | session-start |
| (end session|wrap up|save session|close session)… | session-end |
| (bug|broken|debug|not working|error|fix issue)… | bug-hunter |
| (build feature|add feature|implement|new feature… | feature-builder |
| (refactor|clean up|restructure|simplify)… | refactor-agent |
| (code review|review (this|my|the) (code|pr|pull)… | code-review |
| (new project|greenfield|empty folder|start from … | project-initiator |
| (mid-?stream|existing (code|project|repo)|join(e… | project-initiator |

### Full per-skill triggers

See rendered skill files or `AGENTS.md` / `.project-ai/SKILL_AUTO_ROUTING.yaml`.
