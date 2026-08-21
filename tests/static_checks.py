#!/usr/bin/env python3
"""Static validation of the action's credential boundary and dependency pins.

Run by tests/test_00_static.sh. Reads action.yml, the lockfiles, the README,
the CI workflow and the scripts; never executes anything and never touches the
network. Exit 1 if any check fails.
"""
import json
import pathlib
import re
import sys

import yaml

ROOT = pathlib.Path(sys.argv[1]).resolve()
FAILS = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


def read(p):
    return (ROOT / p).read_text(encoding="utf-8")


# --------------------------------------------------------------- action.yml --
action = yaml.safe_load(read("action.yml"))
steps = action["runs"]["steps"]
by_id = {s.get("id"): s for s in steps}
action_text = read("action.yml")

cli_lock = json.loads(read("deps/cli/package-lock.json"))
agent_lock = json.loads(read("deps/agent/package-lock.json"))
cli_pin = cli_lock["packages"]["node_modules/enterprise-skills"]["version"]
agent_pin = agent_lock["packages"]["node_modules/@anthropic-ai/claude-code"]["version"]

check(action["inputs"]["cli-version"]["default"] == cli_pin,
      f"action.yml cli-version default equals the locked CLI pin ({cli_pin})")
check(re.fullmatch(r"\d+\.\d+\.\d+", action["inputs"]["cli-version"]["default"]) is not None,
      "cli-version default is an exact version")

VALUE_EXPR = re.compile(r"\$\{\{\s*inputs\.(license-key|anthropic-api-key)\s*\}\}")
for s in steps:
    name = s.get("name", "?")
    check(s.get("shell") == "bash", f"step '{name}' uses shell: bash")
    check(not VALUE_EXPR.search(s.get("run", "")),
          f"step '{name}' never interpolates a secret into its run line")
    check("secrets." not in yaml.safe_dump(s), f"step '{name}' never references the secrets context")
    run = s.get("run", "")
    check(run.startswith('bash "$GITHUB_ACTION_PATH/scripts/'), f"step '{name}' delegates to a tested script")


def holders(secret):
    out = []
    for s in steps:
        for v in (s.get("env") or {}).values():
            m = VALUE_EXPR.search(str(v))
            if m and m.group(1) == secret:
                out.append(s.get("id"))
    return out


check(holders("license-key") == ["govern"],
      f"license-key VALUE is present in exactly one step: govern (found {holders('license-key')})")
check(holders("anthropic-api-key") == ["evidence"],
      f"anthropic-api-key VALUE is present in exactly one step: evidence (found {holders('anthropic-api-key')})")
check((by_id["govern"].get("env") or {}).get("ES_LICENSE_KEY") == "${{ inputs.license-key }}",
      "govern step exposes the license as ES_LICENSE_KEY (env-first CLI contract)")
check("ANTHROPIC_API_KEY" not in (by_id["govern"].get("env") or {}),
      "govern step does not hold ANTHROPIC_API_KEY")
check("ES_LICENSE_KEY" not in (by_id["evidence"].get("env") or {}),
      "evidence step does not hold ES_LICENSE_KEY")
for sid in ("inputs", "trust", "preflight", "install-cli", "install-agent"):
    env = by_id[sid].get("env") or {}
    check(not any(VALUE_EXPR.search(str(v)) for v in env.values()),
          f"step '{sid}' holds no credential value (install/validation outside credential scope)")
check("!= ''" in str((by_id["preflight"].get("env") or {}).get("LICENSE_PRESENT", "")),
      "preflight receives license PRESENCE as a runner-computed boolean, not the value")
check("ai_run == 'true'" in by_id["evidence"].get("if", ""), "evidence step is gated on preflight ai_run")
check("ai_run == 'true'" in by_id["install-agent"].get("if", ""), "agent runtime install is gated on preflight ai_run")
check("proceed == 'true'" in by_id["install-cli"].get("if", ""), "CLI install is gated on preflight proceed")
check("proceed == 'true'" in by_id["govern"].get("if", ""), "govern is gated on preflight proceed")
action_semantic = yaml.safe_dump(action)  # comments dropped: only env/run/if values count
check("github.token" not in action_semantic and "GITHUB_TOKEN" not in action_semantic,
      "action.yml never references github.token / GITHUB_TOKEN in any step, env or expression")
check("npm install -g" not in action_text, "action.yml has no global/mutable npm install")
check("persist-credentials" not in action_text or "persist-credentials: false" in action_text,
      "action.yml does not enable credential persistence")

# ------------------------------------------------------------------ scripts --
scripts_text = "".join(read(p) for p in sorted((ROOT / "scripts").glob("*.sh")))
check("npm install -g" not in scripts_text and "npx " not in scripts_text,
      "scripts never install from a mutable/global source")
check("npm ci --ignore-scripts" in scripts_text, "locked install disables npm lifecycle scripts")
check("env -i" in read("scripts/lib.sh"), "scoped exec rebuilds the child environment from scratch (env -i)")
for must in ("GITHUB_TOKEN", "ACTIONS_", "INPUT_", "NODE_OPTIONS", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "npm_config_"):
    check(must in read("scripts/lib.sh"), f"hard-deny table names {must}")
check("--pass ANTHROPIC_API_KEY" in read("scripts/run-evidence.sh")
      and "--pass ES_LICENSE_KEY" not in read("scripts/run-evidence.sh"),
      "evidence passes ANTHROPIC_API_KEY only")
check("--pass ES_LICENSE_KEY --pass-oidc" in read("scripts/run-govern.sh")
      and "ANTHROPIC" not in read("scripts/run-govern.sh"),
      "govern passes ES_LICENSE_KEY (+OIDC) only")
check(read("scripts/run-evidence.sh").count("--pass-oidc") == 0 and read("scripts/install-deps.sh").count("--pass") == 0,
      "neither evidence nor install can request the OIDC pair")

# --------------------------------------------------------------------- deps --
for d, pkg, pin in (("cli", "enterprise-skills", cli_pin), ("agent", "@anthropic-ai/claude-code", agent_pin)):
    pj = json.loads(read(f"deps/{d}/package.json"))
    for name, ver in pj["dependencies"].items():
        check(re.fullmatch(r"\d+\.\d+\.\d+", ver) is not None, f"deps/{d}: {name} pinned exactly ({ver})")
    lk = json.loads(read(f"deps/{d}/package-lock.json"))
    check(lk.get("lockfileVersion", 0) >= 2, f"deps/{d}: lockfileVersion >= 2")
    check(lk["packages"][f"node_modules/{pkg}"]["version"] == pin, f"deps/{d}: lock pins {pkg}@{pin}")
    missing_integrity = [p for p, m in lk["packages"].items() if p and not m.get("link") and not m.get("integrity")]
    bad_version = [p for p, m in lk["packages"].items()
                   if p and not re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?", str(m.get("version", "")))]
    check(not missing_integrity, f"deps/{d}: every locked package carries an integrity hash ({len(lk['packages'])-1} packages)")
    check(not bad_version, f"deps/{d}: every locked package has an exact version")
    ranged = [p for p, m in lk["packages"].items() if p and m.get("resolved") and not str(m["resolved"]).startswith("https://registry.npmjs.org/")]
    check(not ranged, f"deps/{d}: every resolved URL points at registry.npmjs.org")

# ----------------------------------------------------------------- workflows --
wf_dir = ROOT / ".github" / "workflows"
for wf in sorted(wf_dir.glob("*.yml")):
    text = wf.read_text(encoding="utf-8")
    for m in re.finditer(r"uses:\s*([^\s@]+)@(\S+)", text):
        check(re.fullmatch(r"[0-9a-f]{40}", m.group(2)) is not None, f"{wf.name}: {m.group(1)} pinned by 40-hex commit sha")
    check("persist-credentials: false" in text, f"{wf.name}: checkout uses persist-credentials: false")
    check(re.search(r"^permissions:\s*\n\s+contents: read", text, re.M) is not None, f"{wf.name}: least-privilege permissions (contents: read)")
    check("pull_request_target" not in text, f"{wf.name}: does not use pull_request_target")
    check("secrets." not in text, f"{wf.name}: uses no secrets")

# ------------------------------------------------------------------- README --
readme = read("README.md")
blocks = re.findall(r"```ya?ml\n(.*?)```", readme, re.S)
check(len(blocks) >= 1, "README documents at least one workflow")
for i, b in enumerate(blocks, 1):
    if "actions/checkout" not in b:
        continue
    check("persist-credentials: false" in b, f"README workflow #{i}: checkout uses persist-credentials: false")
    for m in re.finditer(r"uses:\s*actions/[^\s@]+@(\S+)", b):
        check(re.fullmatch(r"[0-9a-f]{40}", m.group(1)) is not None, f"README workflow #{i}: GitHub action pinned by commit sha")
    check(re.search(r"permissions:\s*\n\s+contents: read", b) is not None, f"README workflow #{i}: permissions contents: read")
    check("pull_request_target" not in b, f"README workflow #{i}: no pull_request_target")
    check("fetch-depth: 0" in b, f"README workflow #{i}: fetch-depth: 0 (base...HEAD needs history)")
check("Trust matrix" in readme, "README documents the trust matrix")
check("fork" in readme and "same-repo" in readme, "README documents fork and same-repository behaviour")

# --------------------------------------------------------- credential scan --
CRED = re.compile(r"sk-ant-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----")
scanned = 0
for p in list((ROOT / "scripts").glob("*")) + list((ROOT / "tests").rglob("*")) + [ROOT / "action.yml", ROOT / "README.md"] + list((ROOT / "docs").glob("*")) + list(wf_dir.glob("*")):
    if p.is_file() and p.suffix not in (".tgz",):
        scanned += 1
        if CRED.search(p.read_text(encoding="utf-8", errors="replace")):
            check(False, f"no real-credential pattern in {p.relative_to(ROOT)}")
check(True, f"no real-credential pattern in {scanned} scanned files (the only placeholders carry the word PLACEHOLDER)")

print(f"static checks: {len(FAILS)} failure(s)")
sys.exit(1 if FAILS else 0)
