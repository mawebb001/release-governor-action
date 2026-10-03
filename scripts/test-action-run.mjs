#!/usr/bin/env node
// T1: runs action.yml's own run: blocks, in order, each under
// `bash --noprofile --norc -e -o pipefail`, evaluating each step's `if` from
// the outputs and outcomes so far, against FAKE enterprise-skills, npm and
// claude on PATH (no network, no real CLI, no agent). Each case asserts which
// steps ran, the job's final status and the annotation text.
//
// The harness models these GitHub semantics (documented, not measured here):
// a composite step's `if` without a status function is ANDed with success();
// success() is false once a step concluded failure; a failing step with
// continue-on-error: true has outcome failure and conclusion success; the job
// fails when a step concludes failure.
//
// Usage: node scripts/test-action-run.mjs   (needs check-parser/ installed;
// CHECK_PARSER_DIR overrides it). Exit 0 when every case passes.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRealParser, readReal } from './check-action.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER = 'placeholder-not-a-key';

// ---------------------------------------------------------------------------
// GitHub expressions: the subset action.yml uses. Anything else throws.

const TOKEN = /\s*(?:('(?:[^']|'')*')|(==|!=|&&|\|\||!|\(|\))|([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)(\(\))?)/y;

function tokenize(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`expression: cannot read ${JSON.stringify(src.slice(pos))}`);
    if (m[1]) out.push({ t: 'lit', v: m[1].slice(1, -1).replace(/''/g, "'") });
    else if (m[2]) out.push({ t: 'op', v: m[2] });
    else if (m[4]) out.push({ t: 'fn', v: m[3] });
    else out.push({ t: 'path', v: m[3] });
    pos = TOKEN.lastIndex;
  }
  return out;
}

const truthy = (v) => !(v === false || v === null || v === undefined || v === '' || v === 0);
const str = (v) => (v === null || v === undefined ? '' : String(v));

function evaluate(src, ctx) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const take = (v) => {
    if (!toks[i] || toks[i].v !== v) throw new Error(`expression: expected ${v} in ${src}`);
    i += 1;
  };
  function resolve(path) {
    const parts = path.split('.');
    if (!['inputs', 'github', 'steps'].includes(parts[0])) throw new Error(`expression: unknown context ${parts[0]}`);
    let v = ctx;
    for (const p of parts) v = v === null || v === undefined ? undefined : v[p];
    return v;
  }
  function primary() {
    const t = peek();
    if (!t) throw new Error(`expression: unexpected end in ${src}`);
    i += 1;
    if (t.t === 'lit') return t.v;
    if (t.t === 'path') return resolve(t.v);
    if (t.t === 'fn') {
      if (t.v === 'success') return !ctx.failed;
      if (t.v === 'failure') return ctx.failed;
      if (t.v === 'always') return true;
      if (t.v === 'cancelled') return false;
      throw new Error(`expression: unknown function ${t.v}()`);
    }
    if (t.v === '(') {
      const v = or();
      take(')');
      return v;
    }
    throw new Error(`expression: unexpected ${t.v} in ${src}`);
  }
  function cmp() {
    const a = primary();
    const t = peek();
    if (t && t.t === 'op' && (t.v === '==' || t.v === '!=')) {
      i += 1;
      const b = primary();
      // String comparisons ignore case; null compares as ''.
      const eq = typeof a === 'boolean' || typeof b === 'boolean' ? a === b : str(a).toLowerCase() === str(b).toLowerCase();
      return t.v === '==' ? eq : !eq;
    }
    return a;
  }
  function not() {
    const t = peek();
    if (t && t.t === 'op' && t.v === '!') {
      i += 1;
      return !truthy(not());
    }
    return cmp();
  }
  function and() {
    let v = not();
    while (peek() && peek().v === '&&') {
      i += 1;
      const r = not();
      v = truthy(v) ? r : v;
    }
    return v;
  }
  function or() {
    let v = and();
    while (peek() && peek().v === '||') {
      i += 1;
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  }
  const v = or();
  if (i !== toks.length) throw new Error(`expression: trailing tokens in ${src}`);
  return v;
}

const substitute = (text, ctx) => text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => str(evaluate(e, ctx)));

function evalIf(ifText, ctx) {
  if (ifText === undefined) return !ctx.failed;
  const m = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(ifText);
  const e = m ? m[1] : ifText;
  const v = truthy(evaluate(e, ctx));
  return /\b(success|failure|always|cancelled)\(\)/.test(e) ? v : v && !ctx.failed;
}

// ---------------------------------------------------------------------------
// Fakes. Each records its argv and environment NAMES (never values).

const FAKE_LOGGER = `const { appendFileSync } = require('node:fs');
const log = (tool) => { if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool, argv: process.argv.slice(2), env: Object.keys(process.env).sort() }) + '\\n'); };`;

const FAKES = {
  'enterprise-skills': `#!/usr/bin/env node
${FAKE_LOGGER}
const a = process.argv.slice(2);
if (a[0] === '--version') {
  process.stdout.write((process.env.FAKE_VERSION_OUT ?? '4.31.0\\n').replace(/\\\\n/g, '\\n').replace(/\\\\r/g, '\\r').replace(/\\\\e/g, '\\u001b'));
  process.exit(Number(process.env.FAKE_VERSION_EXIT ?? '0'));
}
log('enterprise-skills');
if (a[0] === 'govern') process.exit(Number(process.env.FAKE_GOVERN_EXIT ?? '0'));
if ((a[0] === 'agents' && a[1] === 'run') || (a[0] === 'orchestrate' && a[1] === 'workflow' && a[2] === 'run')) process.exit(Number(process.env.FAKE_EVIDENCE_EXIT ?? '0'));
process.exit(64);
`,
  npm: `#!/usr/bin/env node
${FAKE_LOGGER}
log('npm');
const a = process.argv.slice(2);
if (a[0] === 'install' && a[1] === '-g' && /^@anthropic-ai\\/claude-code@/.test(a[2] ?? '')) process.exit(Number(process.env.FAKE_NPM_CLAUDE_EXIT ?? '0'));
process.exit(0);
`,
  claude: `#!/usr/bin/env node
${FAKE_LOGGER}
log('claude');
process.exit(0);
`,
};

function makeBin(root, { withCli }) {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [name, src] of Object.entries(FAKES)) {
    if (name === 'enterprise-skills' && !withCli) continue;
    writeFileSync(join(bin, name), src);
    chmodSync(join(bin, name), 0o755);
  }
  const nodeDir = join(root, 'node-bin');
  mkdirSync(nodeDir);
  symlinkSync(process.execPath, join(nodeDir, 'node'));
  return `${bin}:${nodeDir}:/usr/bin:/bin`;
}

// ---------------------------------------------------------------------------
// The runner.

const ANNOTATION = /^::(error|warning|notice)(?: ([^:]*))?::(.*)$/;

export function runAction({ actionDir, parser, inputs = {}, fake = {}, withCli = true, setup, homeMode = 'absolute', pathPrefix }) {
  const root = mkdtempSync(join(tmpdir(), 'act-run-'));
  try {
    const path = `${pathPrefix ? `${pathPrefix}:` : ''}${makeBin(root, { withCli })}`;
    const home = join(root, 'home');
    mkdirSync(home);
    const work = join(root, 'work');
    mkdirSync(work);
    const fakeLog = join(root, 'fake.log');
    writeFileSync(fakeLog, '');
    if (setup) setup({ home, root, work });
    const r = readReal(readFileSync(join(actionDir, 'action.yml'), 'utf8'), parser.yaml);
    if (r.problems.length) throw new Error(`action.yml: ${r.problems.join('; ')}`);
    const action = r.value;
    const given = {};
    for (const [n, spec] of Object.entries(action.inputs ?? {})) given[n] = n in inputs ? inputs[n] : spec.default ?? '';
    const ctx = { inputs: given, github: { base_ref: 'main', event: { number: '7' } }, steps: {}, failed: false };
    const base = {
      PATH: path,
      HOME: home,
      GITHUB_ACTION_PATH: actionDir,
      GITHUB_WORKSPACE: work,
      RUNNER_TEMP: root,
      TMPDIR: root,
      ENTERPRISE_SKILLS_TELEMETRY: 'off',
      FAKE_LOG: fakeLog,
      ...fake,
    };
    if (homeMode === 'relative') base.HOME = 'home';
    const ran = [];
    const annotations = [];
    const log = [];
    action.runs.steps.forEach((step, idx) => {
      const name = step.name ?? `#${idx + 1}`;
      const runs = evalIf(step.if, ctx);
      const rec = { outputs: {}, outcome: 'skipped', conclusion: 'skipped' };
      if (runs) {
        const env = { ...base };
        for (const [k, v] of Object.entries(step.env ?? {})) env[k] = substitute(v, ctx);
        const outFile = join(root, `output-${idx}`);
        writeFileSync(outFile, '');
        env.GITHUB_OUTPUT = outFile;
        const script = join(root, `step-${idx}.sh`);
        writeFileSync(script, substitute(step.run, ctx));
        const p = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', script], { cwd: work, env, encoding: 'utf8', timeout: 30000 });
        const exit = p.status ?? -1;
        for (const line of (p.stdout ?? '').split('\n')) {
          const m = ANNOTATION.exec(line);
          if (m) annotations.push({ level: m[1], props: m[2] ?? '', message: m[3], step: name });
        }
        for (const line of readFileSync(outFile, 'utf8').split('\n')) {
          const m = /^([A-Za-z0-9_-]+)=(.*)$/.exec(line);
          if (m) rec.outputs[m[1]] = m[2];
        }
        rec.outcome = exit === 0 ? 'success' : 'failure';
        rec.conclusion = rec.outcome === 'failure' && step['continue-on-error'] === 'true' ? 'success' : rec.outcome;
        if (rec.conclusion === 'failure') ctx.failed = true;
        ran.push({ name, outcome: rec.outcome, exit });
        log.push(`--- ${name} (exit ${exit})\n${p.stdout ?? ''}${p.stderr ?? ''}`);
      }
      if (step.id) ctx.steps[step.id] = rec;
    });
    const calls = readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const licensePath = join(home, '.enterprise-skills', 'license.json');
    const licenseFile = existsSync(licensePath) && statSync(licensePath).isFile() ? readFileSync(licensePath, 'utf8') : null;
    const homeFiles = readdirSync(home, { recursive: true }).sort();
    return { ran, job: ctx.failed ? 'failure' : 'success', annotations, calls, licenseFile, licenseStat: existsSync(licensePath) ? statSync(licensePath) : null, homeFiles, log: log.join('') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Cases.

const STEP = {
  install: 'Install Enterprise Skills CLI',
  cli: 'Installed CLI version and evidence gate',
  compat: 'License compatibility (plant the file only for cli < 4.14)',
  licenseFile: 'License file check (refuse the evidence phase next to a license file)',
  claudeCode: 'Install Claude Code (evidence phase)',
  agents: 'Evidence phase (semantic agents)',
  rr: 'Evidence phase (full release-readiness workflow)',
  unfunded: 'Evidence phase skipped (unfunded)',
  govern: 'Govern and post the decision (completes the PR check run)',
  failed: 'Fail the job when the evidence phase failed',
};
const FUNDED = { 'anthropic-api-key': PLACEHOLDER, 'license-key': PLACEHOLDER };
const UNFUNDED = { 'license-key': PLACEHOLDER };
const EVIDENCE_PATH = ['install', 'cli', 'compat', 'licenseFile', 'claudeCode'];
const sha = (s) => createHash('sha256').update(s).digest('hex');
const planted = JSON.stringify({ key: PLACEHOLDER });

function plant({ home }) {
  mkdirSync(join(home, '.enterprise-skills'));
  writeFileSync(join(home, '.enterprise-skills', 'license.json'), planted);
}

const calls = (res, tool) => res.calls.filter((c) => c.tool === tool);
const has = (c, name) => c.env.includes(name);

export const CASES = [
  {
    name: 'installed 4.31.0, funded, agents',
    inputs: FUNDED,
    ran: [...EVIDENCE_PATH, 'agents', 'govern'],
    job: 'success',
    annotations: [],
    check: (r) => {
      const npm = calls(r, 'npm').map((c) => c.argv.join(' '));
      const cc = calls(r, 'npm').find((c) => c.argv[2]?.startsWith('@anthropic-ai/claude-code@'));
      const ev = calls(r, 'enterprise-skills').find((c) => c.argv[0] === 'agents');
      const gv = calls(r, 'enterprise-skills').find((c) => c.argv[0] === 'govern');
      return [
        [npm.join(' | ') === 'install -g enterprise-skills@4.31.0 | install -g @anthropic-ai/claude-code@2.1.285', `npm calls: ${npm.join(' | ')}`],
        [cc && !has(cc, 'ANTHROPIC_API_KEY') && !has(cc, 'ES_LICENSE_KEY'), 'claude-code install env has neither ANTHROPIC_API_KEY nor ES_LICENSE_KEY'],
        [ev && has(ev, 'ANTHROPIC_API_KEY') && !has(ev, 'ES_LICENSE_KEY'), 'agents step env has ANTHROPIC_API_KEY, not ES_LICENSE_KEY'],
        [ev && ev.argv.join(' ') === 'agents run --yes --base origin/main --pass-env ANTHROPIC_API_KEY --agent-cmd claude -p "{prompt}" --permission-mode acceptEdits', `agents argv: ${ev?.argv.join(' ')}`],
        [gv && has(gv, 'ES_LICENSE_KEY') && !has(gv, 'ANTHROPIC_API_KEY'), 'govern env has ES_LICENSE_KEY, not ANTHROPIC_API_KEY'],
        [r.licenseFile === null, 'no license file written'],
      ];
    },
  },
  {
    name: 'installed 4.31.0, funded, release-readiness',
    inputs: { ...FUNDED, evidence: 'release-readiness' },
    ran: [...EVIDENCE_PATH, 'rr', 'govern'],
    job: 'success',
    annotations: [],
    check: (r) => {
      const ev = calls(r, 'enterprise-skills').find((c) => c.argv[0] === 'orchestrate');
      return [
        [ev && ev.argv.join(' ') === 'orchestrate workflow run release-readiness --yes --pass-env ANTHROPIC_API_KEY --agent-cmd claude -p "{prompt}" --permission-mode acceptEdits --step-timeout 1800', `orchestrate argv: ${ev?.argv.join(' ')}`],
        [ev && has(ev, 'ANTHROPIC_API_KEY') && !has(ev, 'ES_LICENSE_KEY'), 'release-readiness env has ANTHROPIC_API_KEY, not ES_LICENSE_KEY'],
      ];
    },
  },
  {
    name: 'unfunded (agents requested)',
    inputs: UNFUNDED,
    ran: ['install', 'cli', 'compat', 'unfunded', 'govern'],
    job: 'success',
    annotations: [/^notice title=Evidence phase skipped::No anthropic-api-key input was provided/],
    check: (r) => [[calls(r, 'npm').length === 1, 'only the CLI install called npm']],
  },
  {
    name: 'evidence: none, funded',
    inputs: { ...FUNDED, evidence: 'none' },
    ran: ['install', 'cli', 'compat', 'govern'],
    job: 'success',
    annotations: [],
  },
  {
    name: 'installed 4.30.2, funded (evidence refused, govern runs)',
    inputs: FUNDED,
    fake: { FAKE_VERSION_OUT: '4.30.2\\n' },
    ran: ['install', 'cli', 'compat', 'govern'],
    job: 'success',
    annotations: [/^error title=Evidence phase refused::enterprise-skills 4\.30\.2 is installed \(installed 4\.30\.2 is older than 4\.31\.0\)\. .*Both evidence steps are skipped and the job continues to the govern step\. Fix: set cli-version to 4\.31\.0 or newer\.$/],
  },
  {
    name: 'installed pre-release 4.31.0-rc.1, funded (evidence refused, govern runs)',
    inputs: FUNDED,
    fake: { FAKE_VERSION_OUT: '4.31.0-rc.1\\n' },
    ran: ['install', 'cli', 'compat', 'govern'],
    job: 'success',
    annotations: [/^error title=Evidence phase refused::enterprise-skills 4\.31\.0-rc\.1 is installed \(installed 4\.31\.0-rc\.1 is not a plain release\)\. .*Fix: set cli-version to 4\.31\.0 or newer\.$/],
  },
  {
    name: 'installed 4.13.0, funded (license file planted, evidence refused, govern runs)',
    inputs: FUNDED,
    fake: { FAKE_VERSION_OUT: '4.13.0\\n' },
    ran: ['install', 'cli', 'compat', 'govern'],
    job: 'success',
    annotations: [/^error title=Evidence phase refused::enterprise-skills 4\.13\.0 is installed/],
    check: (r) => [[r.licenseFile === planted, 'compat step planted the keys-only license file']],
  },
  {
    name: '`enterprise-skills --version` exits 42 (job fails before govern)',
    inputs: FUNDED,
    fake: { FAKE_VERSION_OUT: '4.31.0\\n', FAKE_VERSION_EXIT: '42' },
    ran: ['install', 'cli'],
    job: 'failure',
    annotations: [/^error title=Installed CLI version unreadable::`enterprise-skills --version` exited 42\. The job stops here: no later step runs, including the govern step\. Fix: set cli-version to a release that installs a working enterprise-skills CLI on this runner \(the default, 4\.31\.0, is one\)\.$/],
    check: (r) => [[calls(r, 'enterprise-skills').length === 0, 'govern was not called']],
  },
  {
    name: 'no enterprise-skills on PATH (job fails before govern)',
    inputs: FUNDED,
    withCli: false,
    ran: ['install', 'cli'],
    job: 'failure',
    annotations: [/^error title=Installed CLI version unreadable::`enterprise-skills --version` exited 127\. The job stops here/],
  },
  ...[
    ['v4.31.0\\n', 'v4.31.0'],
    ['\\e[31m4.31.0\\e[0m\\n', '\u001b[31m4.31.0\u001b[0m'],
    ['4.31.0\\nallowed=true\\n', '4.31.0\nallowed=true'],
    ['', ''],
  ].map(([out, shown]) => ({
    name: `\`enterprise-skills --version\` prints ${JSON.stringify(shown)} (job fails before govern)`,
    inputs: FUNDED,
    fake: { FAKE_VERSION_OUT: out },
    ran: ['install', 'cli'],
    job: 'failure',
    annotations: [new RegExp(`^error title=Installed CLI version unreadable::\`enterprise-skills --version\` printed ${JSON.stringify(shown).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}, which is not a version\\. The job stops here`)],
  })),
  {
    name: 'license file planted before the run (evidence refused, file untouched, govern runs)',
    inputs: FUNDED,
    setup: plant,
    ran: ['install', 'cli', 'compat', 'licenseFile', 'govern'],
    job: 'success',
    annotations: [/^error title=Evidence phase refused::A license file exists at \/\S+\/home\/\.enterprise-skills\/license\.json, which enterprise-skills reads and an agent started by the evidence phase could read\. This step did not change it\. Both evidence steps are skipped and the job continues to the govern step\. Fix: remove whatever writes that file before this action runs/],
    check: (r) => [
      [r.licenseFile === planted, `license file content unchanged (sha256 ${r.licenseFile === null ? 'missing' : sha(r.licenseFile)})`],
      [calls(r, 'npm').length === 1, 'claude-code was not installed'],
      [calls(r, 'enterprise-skills').every((c) => c.argv[0] === 'govern'), 'no evidence command ran'],
    ],
  },
  {
    name: 'license directory (not a file) planted before the run (evidence refused)',
    inputs: FUNDED,
    setup: ({ home }) => mkdirSync(join(home, '.enterprise-skills', 'license.json'), { recursive: true }),
    ran: ['install', 'cli', 'compat', 'licenseFile', 'govern'],
    job: 'success',
    annotations: [/^error title=Evidence phase refused::A license file exists at /],
  },
  {
    name: 'HOME relative (cannot determine, evidence refused)',
    inputs: FUNDED,
    homeMode: 'relative',
    ran: ['install', 'cli', 'compat', 'licenseFile', 'govern'],
    job: 'success',
    annotations: [/^error title=Evidence phase refused::Whether a license file exists under the runner's home cannot be determined: USERPROFILE \?\? HOME \(where the CLI reads\) is "home", not an absolute directory; HOME is "home", not an absolute directory; os\.homedir\(\) is "home", not an absolute directory\. Both evidence steps are skipped and the job continues to the govern step\. Fix: run this action with HOME set to the runner user's home directory\.$/],
  },
  {
    name: 'evidence command exits 1 (govern still runs, job fails)',
    inputs: FUNDED,
    fake: { FAKE_EVIDENCE_EXIT: '1' },
    ran: [...EVIDENCE_PATH, 'agents', 'govern', 'failed'],
    job: 'failure',
    annotations: [/^error title=Evidence phase failed::An evidence-phase step failed \(its log is above\)\. The govern step ran over the evidence that exists; this step fails the job so the failure stays visible\.$/],
    check: (r) => [[r.ran.find((s) => s.name === STEP.agents)?.outcome === 'failure', 'agents step outcome failure']],
  },
  {
    name: 'release-readiness command exits 1 (govern still runs, job fails)',
    inputs: { ...FUNDED, evidence: 'release-readiness' },
    fake: { FAKE_EVIDENCE_EXIT: '1' },
    ran: [...EVIDENCE_PATH, 'rr', 'govern', 'failed'],
    job: 'failure',
    annotations: [/^error title=Evidence phase failed::/],
  },
  {
    name: 'claude-code install fails (evidence skipped, govern runs, job fails)',
    inputs: FUNDED,
    fake: { FAKE_NPM_CLAUDE_EXIT: '1' },
    ran: [...EVIDENCE_PATH, 'govern', 'failed'],
    job: 'failure',
    annotations: [/^error title=Evidence phase failed::/],
  },
  {
    name: 'govern exits 1 (job fails, no evidence-failure step)',
    inputs: FUNDED,
    fake: { FAKE_GOVERN_EXIT: '1' },
    ran: [...EVIDENCE_PATH, 'agents', 'govern'],
    job: 'failure',
    annotations: [],
  },
  {
    name: 'cli-version ^4.31.0 accepted and passed through env',
    inputs: { ...FUNDED, 'cli-version': '^4.31.0' },
    ran: [...EVIDENCE_PATH, 'agents', 'govern'],
    job: 'success',
    annotations: [],
    check: (r) => [[calls(r, 'npm')[0]?.argv.join(' ') === 'install -g enterprise-skills@^4.31.0', `npm argv: ${calls(r, 'npm')[0]?.argv.join(' ')}`]],
  },
  ...[
    'latest',
    'npm:enterprise-skills@4.31.0',
    '',
    'v4.31.0',
    'file:../enterprise-skills',
    'https://example.com/enterprise-skills.tgz',
    '4.31.0"; touch "$HOME/pwned"; echo "',
    '$(touch "$HOME/pwned")',
    '`touch "$HOME/pwned"`',
    '4.31.0 && touch "$HOME/pwned"',
  ].map((v) => ({
    name: `cli-version ${JSON.stringify(v)} rejected (job fails, nothing installed)`,
    inputs: { ...FUNDED, 'cli-version': v },
    ran: ['install'],
    job: 'failure',
    annotations: [/^error title=cli-version rejected::cli-version .* is not an npm version or semver range \(.*\), so nothing was installed and the job stops here\. Fix: set cli-version to a version such as 4\.31\.0 or a range such as \^4\.31\.0\.$/],
    check: (r) => [
      [calls(r, 'npm').length === 0, 'npm was not called'],
      [!r.homeFiles.includes('pwned'), 'no injected command ran'],
    ],
  })),
];

// The verifier's two runtime findings, replayed on 0f38775's action.yml and
// gate script (scripts/fixtures, blob ids checked): the "before" rows.
export const BEFORE_CASES = [
  {
    name: 'BEFORE 0f38775: `--version` exits 42 -> govern skipped (finding 2)',
    inputs: FUNDED,
    fake: { FAKE_VERSION_OUT: '4.31.0\\n', FAKE_VERSION_EXIT: '42' },
    expectGovern: false,
    job: 'failure',
  },
  {
    name: 'BEFORE 0f38775: license file planted -> agents step runs (finding 1)',
    inputs: FUNDED,
    setup: plant,
    expectGovern: true,
    expectAgents: true,
    job: 'success',
  },
  {
    name: 'BEFORE 0f38775: cli-version with a quote runs an injected command (additional finding 2)',
    inputs: { ...FUNDED, 'cli-version': '4.31.0"; touch "$HOME/pwned"; echo "' },
    expectGovern: true,
    expectPwned: true,
    job: 'success',
  },
];

export const FIXTURE_BLOBS = {
  'action-0f38775.yml': '70decab1c00996117f939a57f3c345ff1f90dcfe',
  'evidence-gate-0f38775.mjs': '2830067cb222f9e1b4ea5ce241511d32cebda715',
  'action-7a935a0.yml': 'c2b9106d0050c1ffa6870d4e30231d69b3ffd552',
};

export function gitBlobId(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function main() {
  const parser = loadRealParser();
  if (parser.error) {
    console.log(`FAIL [parser] ${parser.error}`);
    process.exitCode = 1;
    return;
  }
  let failed = 0;
  const report = (ok, name, lines) => {
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    for (const l of lines) console.log(`     ${l}`);
  };
  for (const [file, blob] of Object.entries(FIXTURE_BLOBS)) {
    const got = gitBlobId(readFileSync(join(REPO, 'scripts', 'fixtures', file)));
    report(got === blob, `fixture ${file} is git blob ${blob}`, got === blob ? [] : [`got ${got}`]);
  }
  for (const c of CASES) {
    let res;
    try {
      res = runAction({ actionDir: REPO, parser, ...c });
    } catch (err) {
      report(false, c.name, [`harness error: ${err instanceof Error ? err.message : String(err)}`]);
      continue;
    }
    const want = c.ran.map((k) => STEP[k]);
    const got = res.ran.map((s) => s.name);
    const problems = [];
    if (got.join('\0') !== want.join('\0')) problems.push(`ran: ${JSON.stringify(got)}\n       expected: ${JSON.stringify(want)}`);
    if (res.job !== c.job) problems.push(`job ${res.job}, expected ${c.job}`);
    const notes = res.annotations.map((a) => `${a.level}${a.props ? ` ${a.props}` : ''}::${a.message}`);
    const errorsAndNotices = notes.filter((n) => /^(error|notice)/.test(n));
    if (errorsAndNotices.length !== c.annotations.length) problems.push(`annotations: ${JSON.stringify(errorsAndNotices)}`);
    c.annotations.forEach((re, k) => {
      if (!re.test(errorsAndNotices[k] ?? '')) problems.push(`annotation ${k + 1} does not match ${re}: ${JSON.stringify(errorsAndNotices[k] ?? null)}`);
    });
    for (const [ok, what] of c.check ? c.check(res) : []) if (!ok) problems.push(`check failed: ${what}`);
    report(problems.length === 0, c.name, [
      `steps: ${res.ran.map((s) => `${s.name}${s.outcome === 'failure' ? ` [failure, exit ${s.exit}]` : ''}`).join(' -> ')}`,
      `job: ${res.job}`,
      ...errorsAndNotices.map((n) => `annotation: ${n.length > 260 ? `${n.slice(0, 260)}…` : n}`),
      ...problems,
    ]);
    if (problems.length && process.env.TEST_VERBOSE) console.log(res.log);
  }
  // BEFORE rows: 0f38775's action.yml with its own gate script.
  const old = mkdtempSync(join(tmpdir(), 'act-old-'));
  try {
    mkdirSync(join(old, 'scripts'));
    copyFileSync(join(REPO, 'scripts', 'fixtures', 'action-0f38775.yml'), join(old, 'action.yml'));
    copyFileSync(join(REPO, 'scripts', 'fixtures', 'evidence-gate-0f38775.mjs'), join(old, 'scripts', 'evidence-gate.mjs'));
    for (const c of BEFORE_CASES) {
      const res = runAction({ actionDir: old, parser, ...c });
      const names = res.ran.map((s) => s.name);
      const governRan = names.includes(STEP.govern);
      const agentsRan = names.includes(STEP.agents);
      const pwned = res.homeFiles.includes('pwned');
      const ok =
        governRan === c.expectGovern &&
        res.job === c.job &&
        (c.expectAgents === undefined || agentsRan === c.expectAgents) &&
        (c.expectPwned === undefined || pwned === c.expectPwned);
      report(ok, c.name, [
        `steps: ${res.ran.map((s) => `${s.name}${s.outcome === 'failure' ? ` [failure, exit ${s.exit}]` : ''}`).join(' -> ')}`,
        `job: ${res.job}`,
        ...(c.expectPwned === undefined ? [] : [`injected command ran (\$HOME/pwned exists): ${pwned}`]),
      ]);
    }
  } finally {
    rmSync(old, { recursive: true, force: true });
  }
  const total = Object.keys(FIXTURE_BLOBS).length + CASES.length + BEFORE_CASES.length;
  console.log(`action run harness: ${total - failed}/${total} cases as expected`);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
