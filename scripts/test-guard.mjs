#!/usr/bin/env node
// T2: guard mutants. Each mutant edits the fixed action.yml (every anchor it
// edits must occur exactly once) and must FAIL the guard with a failure that
// names the expected step or section. Also: the fixed file and the positive
// controls pass; action.yml at 7a935a0 and at 0f38775 (scripts/fixtures) fail;
// the registry check (G5) fails on a nonexistent claude-code version, a wrong
// identity and an unreadable registry, through a fake fetch (no network).
//
// Usage: node scripts/test-guard.mjs   (needs check-parser/ installed;
// CHECK_PARSER_DIR overrides it). VERIFIER_AR7_DIR, when set, also runs every
// *.yml in that directory, each of which must fail.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkActionText, loadRealParser } from './check-action.mjs';
import { checkRegistry } from './check-registry.mjs';
import { CLAUDE_CODE_PIN, CLI_PIN } from './pins.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED = readFileSync(join(REPO, 'action.yml'), 'utf8');

function once(text, anchor) {
  const n = text.split(anchor).length - 1;
  if (n !== 1) throw new Error(`anchor occurs ${n} times: ${JSON.stringify(anchor.slice(0, 60))}`);
}
const replace = (anchor, by) => (text) => {
  once(text, anchor);
  return text.replace(anchor, () => by);
};
const chain = (...fs) => (text) => fs.reduce((t, f) => f(t), text);

const AGENTS_RUN = '      run: enterprise-skills agents run --yes --base "origin/$BASE_REF" --pass-env ANTHROPIC_API_KEY --agent-cmd "claude -p \\"{prompt}\\" --permission-mode acceptEdits"\n';
const RR_RUN = '      run: enterprise-skills orchestrate workflow run release-readiness --yes --pass-env ANTHROPIC_API_KEY --agent-cmd';
const AGENTS_IF = "      if: ${{ steps.cli.outputs.evidence == 'agents' && steps.license-file.outputs.clear == 'true' && steps.claude-code.outcome == 'success' }}\n";
const RR_IF = "      if: ${{ steps.cli.outputs.evidence == 'release-readiness' && steps.license-file.outputs.clear == 'true' && steps.claude-code.outcome == 'success' }}\n";
const AGENTS_ENV = '        ANTHROPIC_API_KEY: ${{ inputs.anthropic-api-key }}\n        BASE_REF: ${{ github.base_ref }}\n      run: enterprise-skills agents run';
const CC_STEP = `    - name: Install Claude Code (evidence phase)
      id: claude-code
      if: \${{ steps.license-file.outputs.clear == 'true' }}
      continue-on-error: true
      shell: bash
      run: npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_PIN}

`;
const CLI_STEP_START = '    - name: Installed CLI version and evidence gate\n';
const CLI_STEP_END = '        node "$GITHUB_ACTION_PATH/scripts/evidence-gate.mjs"\n\n';
const AGENTS_STEP_START = '    - name: Evidence phase (semantic agents)\n';
const IDENTITY = [
  `    # Verified artifact: enterprise-skills@${CLI_PIN.version}\n`,
  `    # dist.integrity ${CLI_PIN.integrity}\n`,
  `    # gitHead ${CLI_PIN.gitHead}\n`,
];
const GOVERN_ENV = '        PR_NUMBER: ${{ github.event.number }}\n';
const STEP = {
  install: 'step 1: Install Enterprise Skills CLI',
  cli: 'step 2: Installed CLI version and evidence gate',
  compat: 'step 3: License compatibility (plant the file only for cli < 4.14)',
  licenseFile: 'step 4: License file check (refuse the evidence phase next to a license file)',
  claudeCode: 'step 5: Install Claude Code (evidence phase)',
  agents: 'step 6: Evidence phase (semantic agents)',
  rr: 'step 7: Evidence phase (full release-readiness workflow)',
  govern: 'step 9: Govern and post the decision (completes the PR check run)',
};

// [group, name, mutate, expected fragment(s) of failure lines, opts?]
export const MUTANTS = [
  // The verifier's ar7 defeats, rebuilt on this file.
  ['verifier', 'folded scalar: --pass-env on a more-indented line', replace(AGENTS_RUN, '      run: >\n        enterprise-skills agents run --yes --base "origin/$BASE_REF"\n          --pass-env ANTHROPIC_API_KEY\n        --agent-cmd "claude -p \\"{prompt}\\" --permission-mode acceptEdits"\n'), [`[parser] the guard's reading differs from yaml 2.9.1 at runs.steps[5].run`, `[${STEP.agents}] run line 1 is not expected`]],
  ['verifier', 'flag only in a shell comment on the command\'s own line', replace(AGENTS_RUN, '      run: |\n        enterprise-skills agents run --yes --base "origin/$BASE_REF" --agent-cmd "claude -p \\"{prompt}\\" --permission-mode acceptEdits" # --pass-env ANTHROPIC_API_KEY\n'), `[${STEP.agents}] run line 1 is not expected`],
  ['verifier', 'cli-version default exact 4.30.2', replace('    default: "4.31.0"\n', '    default: "4.30.2"\n'), '[input cli-version] default is "4.30.2", expected "4.31.0"'],
  ['verifier', 'artifact identity comment removed', chain(...IDENTITY.map((l) => replace(l, ''))), '[input cli-version] the comment beside the default does not record "Verified artifact: enterprise-skills@4.31.0"'],
  ['verifier', 'claude-code install removed', replace(CC_STEP, ''), `[step 5: Evidence phase (semantic agents)] is not the expected step here (expected "Install Claude Code (evidence phase)")`],
  ['verifier', 'nonexistent claude-code version in action.yml', replace(`@anthropic-ai/claude-code@${CLAUDE_CODE_PIN}`, '@anthropic-ai/claude-code@99.99.99'), `[${STEP.claudeCode}] run line 1 is not expected: "npm install -g @anthropic-ai/claude-code@99.99.99"`],
  ['verifier', 'agent started through a variable', chain(replace(GOVERN_ENV, `${GOVERN_ENV}        AGENT: claude\n`), replace('      run: enterprise-skills govern --post', '      run: |\n        "$AGENT" -p "{prompt}"\n        enterprise-skills govern --post')), `[${STEP.govern}] env name AGENT is not expected`],
  // ACT-1 mutants.
  ['ACT-1', 'a1 ES_LICENSE_KEY on the agents step', replace(AGENTS_ENV, `        ES_LICENSE_KEY: \${{ inputs.license-key }}\n${AGENTS_ENV}`), `[${STEP.agents}] env name ES_LICENSE_KEY is not expected`],
  ['ACT-1', 'a2a --pass-env removed (agents)', replace(AGENTS_RUN, AGENTS_RUN.replace(' --pass-env ANTHROPIC_API_KEY', '')), `[${STEP.agents}] run line 1 is not expected`],
  ['ACT-1', 'a2b --pass-env removed (release-readiness)', replace(RR_RUN, RR_RUN.replace(' --pass-env ANTHROPIC_API_KEY', '')), `[${STEP.rr}] run line 1 is not expected`],
  ['ACT-1', 'a3 default "^4.14.0"', replace('    default: "4.31.0"\n', '    default: "^4.14.0"\n'), '[input cli-version] default is "^4.14.0", expected "4.31.0"'],
  ['ACT-1', 'a4a claude-code unpinned', replace(`@anthropic-ai/claude-code@${CLAUDE_CODE_PIN}`, '@anthropic-ai/claude-code'), `[${STEP.claudeCode}] run line 1 is not expected`],
  ['ACT-1', 'a4b claude-code pinned to a range', replace(`@anthropic-ai/claude-code@${CLAUDE_CODE_PIN}`, `@anthropic-ai/claude-code@^${CLAUDE_CODE_PIN}`), `[${STEP.claudeCode}] run line 1 is not expected`],
  ['ACT-1', 'a5 ES_LICENSE_KEY in runs.env', replace('  using: "composite"\n', '  using: "composite"\n  env:\n    ES_LICENSE_KEY: ${{ inputs.license-key }}\n'), '[runs] must be exactly using: "composite" and steps'],
  // ACT-1B mutants, mapped to the gate's new shape.
  ['ACT-1B', 'b1 gate condition removed (agents)', replace(AGENTS_IF, AGENTS_IF.replace("steps.cli.outputs.evidence == 'agents' && ", '')), `[${STEP.agents}] if is`],
  ['ACT-1B', 'b2 gate condition removed (release-readiness)', replace(RR_IF, RR_IF.replace("steps.cli.outputs.evidence == 'release-readiness' && ", '')), `[${STEP.rr}] if is`],
  ['ACT-1B', 'b3 agents if deleted', replace(AGENTS_IF, ''), `[${STEP.agents}] key "if" is missing`],
  ['ACT-1B', "b4 condition weakened to != 'none'", replace(AGENTS_IF, AGENTS_IF.replace("== 'agents'", "!= 'none'")), `[${STEP.agents}] if is`],
  ['ACT-1B', 'b5 gate step deleted', (t) => {
    once(t, CLI_STEP_START);
    const a = t.indexOf(CLI_STEP_START);
    const b = t.indexOf(CLI_STEP_END, a) + CLI_STEP_END.length;
    return t.slice(0, a) + t.slice(b);
  }, '[step 2: License compatibility (plant the file only for cli < 4.14)] is not the expected step here (expected "Installed CLI version and evidence gate")'],
  ['ACT-1B', 'b6 gate step moved below the agents step', (t) => {
    once(t, CLI_STEP_START);
    once(t, AGENTS_STEP_START);
    const a = t.indexOf(CLI_STEP_START);
    const b = t.indexOf(CLI_STEP_END, a) + CLI_STEP_END.length;
    const block = t.slice(a, b);
    const rest = t.slice(0, a) + t.slice(b);
    const r = rest.indexOf('    - name: Evidence phase (full release-readiness workflow)\n');
    return rest.slice(0, r) + block + rest.slice(r);
  }, '[step 2: License compatibility (plant the file only for cli < 4.14)] is not the expected step here'],
  ['ACT-1B', 'b7 gate id renamed', replace('      id: cli\n', '      id: version-gate\n'), `[${STEP.cli}] id is "version-gate", expected "cli"`],
  ['ACT-1B', 'b8 --version replaced by a constant', replace('ES_VERSION_OUT="$(enterprise-skills --version)"', 'ES_VERSION_OUT="4.31.0"'), `[${STEP.cli}] run line 1 is not expected`],
  ['ACT-1B', "x1 '|| inputs.evidence == 'agents'' appended", replace(AGENTS_IF, AGENTS_IF.replace(" }}\n", " || inputs.evidence == 'agents' }}\n")), `[${STEP.agents}] if is`],
  ['ACT-1B', 'x3 a uses: step added', replace(AGENTS_STEP_START, '    - name: Some action\n      uses: example/agent-action@v1\n\n' + AGENTS_STEP_START), '[step 6: Some action] is not the expected step here'],
  // New, against G1 - G4.
  ['G1', 'extra step at the end', (t) => `${t}\n    - name: Debug\n      shell: bash\n      run: env\n`, '[step 11: Debug] is not expected'],
  ['G1', 'extra env name on govern', replace(GOVERN_ENV, `${GOVERN_ENV}        DEBUG: "1"\n`), `[${STEP.govern}] env name DEBUG is not expected`],
  ['G1', 'continue-on-error on the version step', replace('      id: cli\n', '      id: cli\n      continue-on-error: true\n'), `[${STEP.cli}] key "continue-on-error" is not expected`],
  ['G1', 'govern runs always()', replace('    - name: Govern and post the decision (completes the PR check run)\n', '    - name: Govern and post the decision (completes the PR check run)\n      if: ${{ always() }}\n'), `[${STEP.govern}] key "if" is not expected`],
  ['G1', 'cli-version interpolated into run again', replace('npm install -g "enterprise-skills@$ES_CLI_VERSION"', 'npm install -g "enterprise-skills@${{ inputs.cli-version }}"'), `[${STEP.install}] run line 2 is not expected`],
  ['G1', 'cli-version validation removed', replace('        node "$GITHUB_ACTION_PATH/scripts/cli-version.mjs"\n', ''), `[${STEP.install}] run line 1 is not expected`],
  ['G1', 'license-file check made unconditional', replace("      if: ${{ steps.cli.outputs.evidence == 'agents' || steps.cli.outputs.evidence == 'release-readiness' }}\n", ''), `[${STEP.licenseFile}] key "if" is missing`],
  ['G1', 'ANTHROPIC_API_KEY on the claude-code install', replace('      run: npm install -g @anthropic-ai/claude-code@', '      env:\n        ANTHROPIC_API_KEY: ${{ inputs.anthropic-api-key }}\n      run: npm install -g @anthropic-ai/claude-code@'), `[${STEP.claudeCode}] key "env" is not expected`],
  ['G1', 'working-directory on the agents step', replace(AGENTS_IF, `${AGENTS_IF}      working-directory: /tmp\n`), `[${STEP.agents}] key "working-directory" is not expected`],
  ['G1', 'continue-on-error removed from the agents step', replace(`${AGENTS_IF}      continue-on-error: true\n`, AGENTS_IF), `[${STEP.agents}] key "continue-on-error" is missing`],
  ['G1', 'evidence-failure step removed', (t) => {
    const a = t.indexOf('    - name: Fail the job when the evidence phase failed\n');
    if (a < 0) throw new Error('anchor');
    return t.slice(0, a);
  }, '[step 10: Fail the job when the evidence phase failed] is missing'],
  ['G1', 'license-key required flag flipped', replace('      phase is refused while a license file exists in the runner\'s home.\n    required: true\n', '      phase is refused while a license file exists in the runner\'s home.\n    required: false\n'), '[input license-key] required is "false", expected "true"'],
  ['G1', 'outputs added', (t) => `${t.replace('runs:\n', 'outputs:\n  decision:\n    description: x\n    value: y\n\nruns:\n')}`, '[top level] keys are'],
  ['G2', 'integrity in the identity comment altered', replace(IDENTITY[1], IDENTITY[1].replace('pQSF', 'pQSG')), `[input cli-version] the comment beside the default does not record "dist.integrity ${CLI_PIN.integrity}"`],
  ['G2', 'gitHead in the identity comment altered', replace(IDENTITY[2], IDENTITY[2].replace('3be3bb1c', '3be3bb1d')), `[input cli-version] the comment beside the default does not record "gitHead ${CLI_PIN.gitHead}"`],
  ['G2', 'gate minimum above the pinned CLI', (t) => t, '[gate] minimum 4.32.0 exceeds the pinned CLI 4.31.0', { minVersion: [4, 32, 0] }],
  ['G2', 'pin moved without the default', (t) => t, '[input cli-version] default is "4.31.0", expected "4.32.0"', { cliPin: { ...CLI_PIN, version: '4.32.0' } }],
  ['G3', 'claude-code moved to 2.1.288 in action.yml only', replace(`@anthropic-ai/claude-code@${CLAUDE_CODE_PIN}`, '@anthropic-ai/claude-code@2.1.288'), `[${STEP.claudeCode}] run line 1 is not expected`],
  ['G3', 'claude-code install back inside the agents step', chain(replace(CC_STEP, ''), replace(AGENTS_RUN, `      run: |\n        npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_PIN}\n        enterprise-skills agents run --yes --base "origin/$BASE_REF" --pass-env ANTHROPIC_API_KEY --agent-cmd "claude -p \\"{prompt}\\" --permission-mode acceptEdits"\n`)), 'Install Claude Code (evidence phase)'],
  ['G4', 'anchor and alias', chain(replace(AGENTS_ENV, AGENTS_ENV.replace('        ANTHROPIC_API_KEY: ${{ inputs.anthropic-api-key }}', '        ANTHROPIC_API_KEY: &k ${{ inputs.anthropic-api-key }}'))), '[parser] yaml 2.9.1: anchor &k'],
  ['G4', 'duplicate env key', replace(AGENTS_ENV, AGENTS_ENV.replace('        BASE_REF: ${{ github.base_ref }}\n', '        BASE_REF: ${{ github.base_ref }}\n        ANTHROPIC_API_KEY: ${{ inputs.license-key }}\n')), '[parser] yaml 2.9.1: Map keys must be unique'],
  ['G4', 'second document', (t) => `${t}---\nname: other\n`, '[parser] yaml 2.9.1: 2 YAML documents, expected 1'],
  ['G4', 'tab indentation', replace('        BASE_REF: ${{ github.base_ref }}\n      run: enterprise-skills agents', '\tBASE_REF: ${{ github.base_ref }}\n      run: enterprise-skills agents'), '[parser]'],
  ['G4', 'flow mapping env', replace(AGENTS_ENV, '        {ANTHROPIC_API_KEY: "${{ inputs.anthropic-api-key }}", BASE_REF: "${{ github.base_ref }}"}\n      run: enterprise-skills agents run'), "[parser] the guard's own reading fails"],
  ['G4', 'quoted env key', replace(AGENTS_ENV, `        "ES_LICENSE_KEY": \${{ inputs.license-key }}\n${AGENTS_ENV}`), "[parser] the guard's own reading fails"],
  ['G4', 'explicit tag', replace('      id: cli\n', '      id: !!str cli\n'), '[parser] yaml 2.9.1: explicit tag'],
  ['G4', 'multi-line plain scalar in an if', replace(AGENTS_IF, "      if: ${{ steps.cli.outputs.evidence == 'agents' &&\n        steps.license-file.outputs.clear == 'true' && steps.claude-code.outcome == 'success' }}\n"), '[parser]'],
];

// Must pass: the guard is not a byte comparison.
export const CONTROLS = [
  ['fixed action.yml', (t) => t],
  ['CRLF line endings', (t) => t.replace(/\n/g, '\r\n')],
  ['an added YAML comment line', replace('  steps:\n', '  steps:\n    # an added comment\n')],
  ['a reworded input description', replace('Optional. Funds the headless evidence phase', 'Optional. Pays for the headless evidence phase')],
];

function fakeRegistry(table) {
  return async (url) => {
    const hit = Object.entries(table).find(([k]) => url.endsWith(k));
    if (!hit) return { status: 404, json: async () => ({}) };
    if (hit[1] instanceof Error) throw hit[1];
    if (typeof hit[1] === 'number') return { status: hit[1], json: async () => ({}) };
    return { status: 200, json: async () => hit[1] };
  };
}
const GOOD = {
  '/enterprise-skills/4.31.0': { version: '4.31.0', dist: { integrity: CLI_PIN.integrity }, gitHead: CLI_PIN.gitHead },
  [`/@anthropic-ai%2fclaude-code/${CLAUDE_CODE_PIN}`]: { version: CLAUDE_CODE_PIN },
};
export const REGISTRY_CASES = [
  ['registry: the pins as recorded (positive control)', {}, GOOD, null],
  ['registry: nonexistent claude-code version 99.99.99', { claudeCode: '99.99.99' }, GOOD, '[registry] @anthropic-ai/claude-code@99.99.99 does not exist'],
  ['registry: integrity differs', {}, { ...GOOD, '/enterprise-skills/4.31.0': { ...GOOD['/enterprise-skills/4.31.0'], dist: { integrity: 'sha512-other' } } }, '[registry] enterprise-skills@4.31.0 dist.integrity is "sha512-other"'],
  ['registry: gitHead differs', {}, { ...GOOD, '/enterprise-skills/4.31.0': { ...GOOD['/enterprise-skills/4.31.0'], gitHead: '0'.repeat(40) } }, '[registry] enterprise-skills@4.31.0 gitHead is'],
  ['registry: unreadable (network error)', {}, { '/enterprise-skills/4.31.0': new Error('getaddrinfo ENOTFOUND registry.npmjs.org'), [`/@anthropic-ai%2fclaude-code/${CLAUDE_CODE_PIN}`]: new Error('getaddrinfo ENOTFOUND registry.npmjs.org') }, 'could not be read (getaddrinfo ENOTFOUND registry.npmjs.org)'],
  ['registry: answers 500', {}, { ...GOOD, [`/@anthropic-ai%2fclaude-code/${CLAUDE_CODE_PIN}`]: 500 }, 'answered 500'],
];

async function main() {
  const parser = loadRealParser();
  if (parser.error) {
    console.log(`FAIL [parser] ${parser.error}`);
    process.exitCode = 1;
    return;
  }
  let failed = 0;
  let total = 0;
  const show = (ok, label, lines) => {
    total += 1;
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
    for (const l of lines) console.log(`     ${l}`);
  };
  for (const [name, mutate] of CONTROLS) {
    const f = checkActionText(mutate(FIXED), { parser });
    show(f.length === 0, `control: ${name} -> ${f.length === 0 ? 'OK' : `${f.length} failure(s)`}`, f);
  }
  for (const [group, name, mutate, expect, opts] of MUTANTS) {
    let f;
    try {
      f = checkActionText(mutate(FIXED), { parser, ...(opts ?? {}) });
    } catch (err) {
      show(false, `${group}: ${name}`, [`mutant error: ${err instanceof Error ? err.message : String(err)}`]);
      continue;
    }
    const wants = Array.isArray(expect) ? expect : [expect];
    const hits = wants.map((w) => f.find((l) => l.includes(w)));
    const hit = hits.every(Boolean);
    show(f.length > 0 && hit, `${group}: ${name} -> ${f.length} failure(s)`, hit ? hits.map((l) => `FAIL ${l}`) : [`expected failures containing: ${JSON.stringify(wants)}`, ...f.map((l) => `FAIL ${l}`)]);
  }
  for (const file of ['action-7a935a0.yml', 'action-0f38775.yml']) {
    const f = checkActionText(readFileSync(join(REPO, 'scripts', 'fixtures', file), 'utf8'), { parser });
    show(f.length > 0, `old file ${file} -> ${f.length} failure(s)`, f.slice(0, 3).map((l) => `FAIL ${l}`));
  }
  for (const [name, opts, table, expect] of REGISTRY_CASES) {
    const f = await checkRegistry({ fetchImpl: fakeRegistry(table), ...opts });
    const ok = expect === null ? f.length === 0 : f.some((l) => l.includes(expect));
    show(ok, `${name} -> ${f.length === 0 ? 'OK' : `${f.length} failure(s)`}`, f.map((l) => `FAIL ${l}`));
  }
  const dir = process.env.VERIFIER_AR7_DIR;
  if (dir) {
    for (const file of readdirSync(dir).filter((n) => n.endsWith('.yml')).sort()) {
      const f = checkActionText(readFileSync(join(dir, file), 'utf8'), { parser });
      show(f.length > 0, `verifier ar7 file ${file} -> ${f.length} failure(s)`, f.slice(0, 1).map((l) => `FAIL ${l}`));
    }
  }
  console.log(`guard tests: ${total - failed}/${total} as expected`);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
