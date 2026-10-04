#!/usr/bin/env node
// Runner proof (RL-92): the `action-runner-proof` job in
// .github/workflows/check.yml runs THIS action (`uses: ./`) on a GitHub runner
// with FAKE enterprise-skills, npm and claude first on PATH. The fakes read
// their behaviour from a config file at a fixed path (not from the
// environment) and record argv and environment NAMES only. Inputs are the
// literal placeholder-not-a-key; no secret is used; the real CLI, the real
// claude and a real `govern --post` never run.
//
//   node scripts/runner-proof.mjs setup             fakes into $RUNNER_TEMP, first on PATH
//   node scripts/runner-proof.mjs configure <case>  config for the next action run
//   node scripts/runner-proof.mjs check <case>      OUTCOME = the action step's outcome
//   node scripts/runner-proof.mjs verdict           exit 1 unless every case matched
//
// Each check prints one line, "CASE <id> <PASS|FAIL> — …", and the verdict
// repeats them. A check never fails its own step, so every case runs.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PLACEHOLDER = 'placeholder-not-a-key';
const ROOT = join(process.env.RUNNER_TEMP ?? '', 'rg-fakes');
const CONFIG = join(ROOT, 'config.json');
const RESULTS = join(ROOT, 'results.txt');
const LICENSE = join(homedir(), '.enterprise-skills', 'license.json');
const PLANTED = JSON.stringify({ key: PLACEHOLDER });
const JOB_PROBE = 'JOB_LEVEL_ENV_PROBE';

// expect: evidence (an evidence command ran), govern (govern ran), outcome
// (the `uses: ./` step's outcome). The inputs are set in check.yml beside
// each case; `inputs` here only documents them.
export const CASES = {
  a: { title: 'normal funded path', inputs: 'funded, evidence agents', config: {}, expect: { evidence: true, govern: true, outcome: 'success' } },
  b: { title: 'an evidence step exits 1', inputs: 'funded, evidence agents', config: { evidenceExit: 1 }, expect: { evidence: true, govern: true, outcome: 'failure' } },
  c: { title: 'the claude-code install exits 1', inputs: 'funded, evidence agents', config: { npmClaudeExit: 1 }, expect: { evidence: false, govern: true, outcome: 'failure' } },
  d: { title: '`enterprise-skills --version` exits 42', inputs: 'funded, evidence agents', config: { versionExit: 42 }, expect: { evidence: false, govern: false, outcome: 'failure' } },
  e1: { title: 'B1: installed 4.30.2, funded', inputs: 'funded, evidence agents', config: { versionOut: '4.30.2\n' }, expect: { evidence: false, govern: true, outcome: 'failure' } },
  e2: { title: 'B1: installed 4.31.0-rc.1, funded', inputs: 'funded, evidence agents', config: { versionOut: '4.31.0-rc.1\n' }, expect: { evidence: false, govern: true, outcome: 'failure' } },
  e3: { title: 'B1: license file in the runner home before the run', inputs: 'funded, evidence agents', config: { plantBefore: true }, expect: { evidence: false, govern: true, outcome: 'failure', fileUnchanged: true } },
  e4: { title: 'B1/B2: license file written during the claude-code install', inputs: 'funded, evidence agents', config: { npmClaudePlant: true }, expect: { evidence: false, govern: true, outcome: 'failure', installRan: true } },
  e5: { title: 'B1: evidence input "agent", funded', inputs: 'funded, evidence agent', config: {}, expect: { evidence: false, govern: true, outcome: 'failure' } },
  e6: { title: 'B1: evidence input "agent", unfunded', inputs: 'unfunded, evidence agent', config: {}, expect: { evidence: false, govern: true, outcome: 'failure' } },
  f: { title: 'unfunded', inputs: 'unfunded, evidence agents', config: {}, expect: { evidence: false, govern: true, outcome: 'success' } },
  g: { title: 'funded, evidence none', inputs: 'funded, evidence none', config: {}, expect: { evidence: false, govern: true, outcome: 'success' } },
};

const LOGGER = `const fs = require('node:fs');
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(CONFIG)}, 'utf8'));
const log = (tool) => fs.appendFileSync(cfg.caseDir + '/calls.jsonl', JSON.stringify({ tool, argv: process.argv.slice(2), env: Object.keys(process.env).sort() }) + '\\n');
const a = process.argv.slice(2);`;

const FAKES = {
  'enterprise-skills': `#!/usr/bin/env node
${LOGGER}
if (a[0] === '--version') { process.stdout.write(cfg.versionOut ?? '4.31.0\\n'); process.exit(cfg.versionExit ?? 0); }
log('enterprise-skills');
if (a[0] === 'govern') process.exit(0);
if ((a[0] === 'agents' && a[1] === 'run') || (a[0] === 'orchestrate' && a[1] === 'workflow' && a[2] === 'run')) process.exit(cfg.evidenceExit ?? 0);
process.exit(64);
`,
  npm: `#!/usr/bin/env node
${LOGGER}
log('npm');
if (a[0] === 'install' && a[1] === '-g' && /^@anthropic-ai\\/claude-code@/.test(a[2] ?? '')) {
  if (cfg.npmClaudePlant) { fs.mkdirSync(${JSON.stringify(join(homedir(), '.enterprise-skills'))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(LICENSE)}, ${JSON.stringify(PLANTED)}); }
  process.exit(cfg.npmClaudeExit ?? 0);
}
process.exit(0);
`,
  claude: `#!/usr/bin/env node
${LOGGER}
log('claude');
process.exit(0);
`,
};

function setup() {
  if (!process.env.RUNNER_TEMP || !process.env.GITHUB_PATH) throw new Error('runs only on a GitHub runner (RUNNER_TEMP, GITHUB_PATH)');
  if (existsSync(LICENSE)) throw new Error(`${LICENSE} exists before any case: the runner image is not clean`);
  const bin = join(ROOT, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const [name, src] of Object.entries(FAKES)) {
    writeFileSync(join(bin, name), src);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(RESULTS, '');
  appendFileSync(process.env.GITHUB_PATH, `${bin}\n`);
  console.log(`fakes in ${bin}, first on PATH for the following steps`);
}

function configure(id) {
  const c = CASES[id];
  if (!c) throw new Error(`unknown case ${id}`);
  // Remove only what a case of this job planted.
  if (existsSync(LICENSE) && readFileSync(LICENSE, 'utf8') === PLANTED) rmSync(LICENSE);
  const caseDir = join(ROOT, `case-${id}`);
  rmSync(caseDir, { recursive: true, force: true });
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, 'calls.jsonl'), '');
  writeFileSync(CONFIG, JSON.stringify({ ...c.config, caseDir }));
  if (c.config.plantBefore) {
    mkdirSync(join(homedir(), '.enterprise-skills'), { recursive: true });
    writeFileSync(LICENSE, PLANTED);
  }
  console.log(`case ${id}: ${c.title} (${c.inputs}); config ${JSON.stringify(c.config)}`);
}

function check(id) {
  const c = CASES[id];
  const calls = readFileSync(join(ROOT, `case-${id}`, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const es = calls.filter((x) => x.tool === 'enterprise-skills');
  const got = {
    evidence: es.some((x) => (x.argv[0] === 'agents' && x.argv[1] === 'run') || (x.argv[0] === 'orchestrate' && x.argv[1] === 'workflow')),
    govern: es.some((x) => x.argv[0] === 'govern'),
    outcome: process.env.OUTCOME ?? '(unset)',
  };
  const install = calls.find((x) => x.tool === 'npm' && /^@anthropic-ai\/claude-code@/.test(x.argv[2] ?? ''));
  const problems = [];
  for (const k of ['evidence', 'govern', 'outcome']) if (got[k] !== c.expect[k]) problems.push(`${k} ${got[k]}, expected ${c.expect[k]}`);
  if (c.expect.fileUnchanged && !(existsSync(LICENSE) && readFileSync(LICENSE, 'utf8') === PLANTED)) problems.push('the planted license file changed');
  if (c.expect.installRan && !install) problems.push('the claude-code install did not run');
  if (install && (install.env.includes('ANTHROPIC_API_KEY') || install.env.includes('ES_LICENSE_KEY'))) problems.push('a key name is in the claude-code install environment');
  const notes = [];
  if (install) notes.push(`job-level env name ${JOB_PROBE} in the claude-code install environment: ${install.env.includes(JOB_PROBE) ? 'yes' : 'no'}`);
  const line = `CASE ${id} ${problems.length ? 'FAIL' : 'PASS'} — ${c.title}: evidence command ran: ${got.evidence ? 'yes' : 'no'}; govern ran: ${got.govern ? 'yes' : 'no'}; action step outcome: ${got.outcome}${notes.length ? `; ${notes.join('; ')}` : ''}${problems.length ? ` — MISMATCH: ${problems.join('; ')}` : ''}`;
  appendFileSync(RESULTS, `${line}\n`);
  console.log(line);
}

function verdict() {
  const lines = existsSync(RESULTS) ? readFileSync(RESULTS, 'utf8').split('\n').filter(Boolean) : [];
  for (const l of lines) console.log(l);
  const seen = new Set(lines.map((l) => l.split(' ')[1]));
  const missing = Object.keys(CASES).filter((id) => !seen.has(id));
  const failed = lines.filter((l) => / FAIL — /.test(l)).map((l) => l.split(' ')[1]);
  for (const id of missing) console.log(`CASE ${id} FAIL — no result (its steps did not run)`);
  const ok = failed.length === 0 && missing.length === 0;
  console.log(`runner proof: ${Object.keys(CASES).length - failed.length - missing.length}/${Object.keys(CASES).length} cases matched${ok ? '' : ` — not matched: ${[...failed, ...missing].join(', ')}`}`);
  process.exitCode = ok ? 0 : 1;
}

const [cmd, id] = process.argv.slice(2);
if (cmd === 'setup') setup();
else if (cmd === 'configure') configure(id);
else if (cmd === 'check') check(id);
else if (cmd === 'verdict') verdict();
else if (cmd !== undefined) throw new Error(`unknown command ${cmd}`);
