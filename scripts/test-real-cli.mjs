#!/usr/bin/env node
// T3 (outside CI): the verifier's planted-license case with the REAL
// enterprise-skills 4.31.0 and a STUB `claude` that records only the NAMES in
// its environment and whether a license file is readable. govern is never run
// for real (a wrapper answers it), npm is the harness fake (nothing is
// installed), and no real agent starts. Run twice through the T1 harness:
//   before: action.yml and gate script at 0f38775 (scripts/fixtures)
//   after:  this head's action.yml and scripts
// Then the limit case, twice, with no license file and with ES_LICENSE_KEY,
// GITHUB_TOKEN and ACTIONS_ID_TOKEN_REQUEST_TOKEN set on every step (as a
// job-level env would): a second stub records the NAMES in its own
// environment and the NAMES in /proc/<pid>/environ of each process above it
// up to this script, the CLI's included:
//   limit-with:    this head's action.yml (both evidence steps pass
//                  --pass-env ANTHROPIC_API_KEY)
//   limit-without: the same file with that flag removed
//
// Usage: ES_REAL_CLI_PREFIX=<npm prefix holding bin/enterprise-skills>
//        T3_OUT=<directory for the outputs> node scripts/test-real-cli.mjs
// Needs git and the check-parser (CHECK_PARSER_DIR overrides it).

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRealParser } from './check-action.mjs';
import { runAction } from './test-action-run.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER = 'placeholder-not-a-key';
const FLAG = ' --pass-env ANTHROPIC_API_KEY';
const JOB_ENV = ['ES_LICENSE_KEY', 'GITHUB_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
const PLANTED = ['ANTHROPIC_API_KEY', ...JOB_ENV];
const CREDENTIAL_LIKE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

const STUB = `#!/usr/bin/env node
const { dirname, join } = require('node:path');
const { readFileSync, realpathSync, writeFileSync } = require('node:fs');
const out = dirname(realpathSync(process.argv[1]));
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
let readable = false;
try { readFileSync(join(home, '.enterprise-skills', 'license.json')); readable = true; } catch {}
writeFileSync(join(out, 'env-names.' + process.pid + '.txt'), Object.keys(process.env).sort().join('\\n') + '\\n');
writeFileSync(join(out, 'license-file.' + process.pid + '.txt'), 'license_file_readable=' + readable + '\\n');
process.exit(0);
`;

// Names only. Stops below the pid in stop-pid.txt (this script).
const LIMIT_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const out = path.dirname(fs.realpathSync(process.argv[1]));
const stop = Number(fs.readFileSync(path.join(out, 'stop-pid.txt'), 'utf8'));
const names = (buf) => buf.toString().split('\\0').filter(Boolean).map((e) => e.slice(0, e.indexOf('='))).filter(Boolean).sort();
const ppid = (pid) => Number(/^PPid:\\s+(\\d+)$/m.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8'))[1]);
const ancestors = [];
for (let pid = ppid('self'), depth = 1; depth <= 16 && pid > 0 && pid !== stop; pid = ppid(pid), depth += 1) {
  const row = { depth, argv: null, names: null, error: null };
  try {
    row.argv = fs.readFileSync('/proc/' + pid + '/cmdline').toString().split('\\0').filter(Boolean).slice(0, 2).map((a) => path.basename(a));
    row.names = names(fs.readFileSync('/proc/' + pid + '/environ'));
  } catch (e) { row.error = e.code || String(e); }
  ancestors.push(row);
}
fs.writeFileSync(path.join(out, 'limit.' + process.pid + '.json'), JSON.stringify({ own: Object.keys(process.env).sort(), ancestors }, null, 2) + '\\n');
process.exit(0);
`;

function gitRepo(work) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@example.invalid', GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: 'probe@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...a) => execFileSync('git', a, { cwd: work, env, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(work, 'README.md'), '# probe\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  mkdirSync(join(work, 'migrations'));
  writeFileSync(join(work, 'migrations', '001_probe.sql'), 'CREATE TABLE probe (id integer primary key);\n');
  writeFileSync(join(work, 'openapi.yaml'), 'openapi: 3.0.0\ninfo:\n  title: probe\n  version: 1.0.0\npaths:\n  /probe:\n    get:\n      responses:\n        "200":\n          description: ok\n');
  mkdirSync(join(work, 'src'));
  writeFileSync(join(work, 'src', 'telemetry.ts'), 'export const probe = (): number => 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'change');
}

function main() {
  const prefix = process.env.ES_REAL_CLI_PREFIX;
  const out = process.env.T3_OUT;
  if (!prefix || !out) throw new Error('set ES_REAL_CLI_PREFIX and T3_OUT');
  const real = join(prefix, 'bin', 'enterprise-skills');
  if (!existsSync(real)) throw new Error(`no ${real}`);
  const parser = loadRealParser();
  if (parser.error) throw new Error(parser.error);
  const results = [];
  for (const which of ['before', 'after']) {
    const dir = join(out, which);
    rmSync(dir, { recursive: true, force: true });
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude'), STUB);
    chmodSync(join(bin, 'claude'), 0o755);
    writeFileSync(join(bin, 'enterprise-skills'), `#!/bin/sh\nif [ "\${1-}" = "govern" ]; then echo "govern (wrapper, not run): $*" >> "${join(dir, 'govern.log')}"; exit 0; fi\nexec "${real}" "$@"\n`);
    chmodSync(join(bin, 'enterprise-skills'), 0o755);
    let actionDir = REPO;
    let tmp = null;
    if (which === 'before') {
      tmp = mkdtempSync(join(tmpdir(), 'act-old-'));
      mkdirSync(join(tmp, 'scripts'));
      copyFileSync(join(REPO, 'scripts', 'fixtures', 'action-0f38775.yml'), join(tmp, 'action.yml'));
      copyFileSync(join(REPO, 'scripts', 'fixtures', 'evidence-gate-0f38775.mjs'), join(tmp, 'scripts', 'evidence-gate.mjs'));
      actionDir = tmp;
    }
    try {
      const res = runAction({
        actionDir,
        parser,
        inputs: { 'license-key': PLACEHOLDER, 'anthropic-api-key': PLACEHOLDER },
        withCli: false,
        pathPrefix: bin,
        setup: ({ home, work }) => {
          mkdirSync(join(home, '.enterprise-skills'));
          writeFileSync(join(home, '.enterprise-skills', 'license.json'), `${JSON.stringify({ key: PLACEHOLDER })}\n`);
          gitRepo(work);
        },
      });
      writeFileSync(join(dir, 'steps.log'), res.log);
      const stubFiles = execFileSync('ls', [bin], { encoding: 'utf8' }).split('\n').filter((f) => /^(env-names|license-file)\./.test(f));
      const envNames = stubFiles.filter((f) => f.startsWith('env-names.')).map((f) => readFileSync(join(bin, f), 'utf8').trim().split('\n'));
      const readable = stubFiles.filter((f) => f.startsWith('license-file.')).map((f) => readFileSync(join(bin, f), 'utf8').trim());
      const summary = {
        which,
        action: which === 'before' ? 'scripts/fixtures/action-0f38775.yml (+ evidence-gate-0f38775.mjs)' : 'action.yml at this head',
        steps: res.ran.map((s) => `${s.name} [${s.outcome}${s.outcome === 'failure' ? `, exit ${s.exit}` : ''}]`),
        job: res.job,
        stubRuns: envNames.length,
        stubEnvNames: envNames,
        stubLicenseFile: readable,
        licenseFileAfter: res.licenseFile,
        annotations: res.annotations.map((a) => `${a.level}${a.props ? ` ${a.props}` : ''}::${a.message}`),
        governWrapper: existsSync(join(dir, 'govern.log')) ? readFileSync(join(dir, 'govern.log'), 'utf8').trim() : null,
      };
      writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      results.push(summary);
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }
  const [before, after] = results;
  const ok =
    before.stubRuns > 0 &&
    before.stubLicenseFile.every((l) => l === 'license_file_readable=true') &&
    before.stubEnvNames.every((n) => !n.includes('ES_LICENSE_KEY')) &&
    after.stubRuns === 0 &&
    after.licenseFileAfter === `${JSON.stringify({ key: PLACEHOLDER })}\n` &&
    after.steps.some((s) => s.startsWith('Govern and post the decision'));
  for (const r of results) {
    console.log(`${r.which}: ${r.action}`);
    console.log(`  steps: ${r.steps.join(' -> ')}`);
    console.log(`  job: ${r.job}; stub claude runs: ${r.stubRuns}; ${r.stubLicenseFile.join(', ') || 'no stub run'}`);
    for (const n of r.stubEnvNames) console.log(`  stub env names: ${n.join(' ')}`);
    for (const a of r.annotations) console.log(`  annotation: ${a}`);
    console.log(`  govern: ${r.governWrapper ?? 'not reached'}`);
  }
  console.log(`T3 ${ok ? 'PASS' : 'FAIL'}: before, the stub ran and read the planted file; after, the stub never ran, the file is unchanged and govern ran`);
  const limitOk = limitCases(real, out, parser);
  process.exitCode = ok && limitOk ? 0 : 1;
}

// The limit the README states: with or without --pass-env, the agent can read
// the CLI process's environment.
function limitCases(real, out, parser) {
  const results = [];
  for (const which of ['limit-with', 'limit-without']) {
    const dir = join(out, which);
    rmSync(dir, { recursive: true, force: true });
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude'), LIMIT_STUB);
    chmodSync(join(bin, 'claude'), 0o755);
    writeFileSync(join(bin, 'stop-pid.txt'), String(process.pid));
    writeFileSync(join(bin, 'enterprise-skills'), `#!/bin/sh\nif [ "\${1-}" = "govern" ]; then echo "govern (wrapper, not run): $*" >> "${join(dir, 'govern.log')}"; exit 0; fi\nexec "${real}" "$@"\n`);
    chmodSync(join(bin, 'enterprise-skills'), 0o755);
    const tmp = mkdtempSync(join(tmpdir(), 'act-limit-'));
    try {
      const yml = readFileSync(join(REPO, 'action.yml'), 'utf8');
      let removed = 0;
      const stripped = yml
        .split('\n')
        .map((l) => {
          if (!/^\s+run: enterprise-skills (agents run|orchestrate workflow run) /.test(l) || !l.includes(FLAG)) return l;
          removed += 1;
          return l.replace(FLAG, '');
        })
        .join('\n');
      mkdirSync(join(tmp, 'scripts'));
      for (const f of ['evidence-gate.mjs', 'license-file-check.mjs', 'cli-version.mjs']) copyFileSync(join(REPO, 'scripts', f), join(tmp, 'scripts', f));
      writeFileSync(join(tmp, 'action.yml'), which === 'limit-with' ? yml : stripped);
      const res = runAction({
        actionDir: tmp,
        parser,
        inputs: { 'license-key': PLACEHOLDER, 'anthropic-api-key': PLACEHOLDER },
        fake: Object.fromEntries(JOB_ENV.map((n) => [n, PLACEHOLDER])),
        withCli: false,
        pathPrefix: bin,
        setup: ({ work }) => gitRepo(work),
      });
      writeFileSync(join(dir, 'steps.log'), res.log);
      const recs = execFileSync('ls', [bin], { encoding: 'utf8' }).split('\n').filter((f) => /^limit\.\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(bin, f), 'utf8')));
      const summary = {
        which,
        action: which === 'limit-with' ? 'action.yml at this head' : `action.yml at this head with ${removed} "${FLAG.trim()}" removed`,
        flagsRemoved: which === 'limit-with' ? 0 : removed,
        steps: res.ran.map((s) => `${s.name} [${s.outcome}${s.outcome === 'failure' ? `, exit ${s.exit}` : ''}]`),
        stubRuns: recs.length,
        own: recs.map((r) => r.own),
        ownCredentialLike: recs.map((r) => r.own.filter((n) => CREDENTIAL_LIKE.test(n))),
        cliProcess: recs.map((r) => {
          const row = r.ancestors.find((a) => a.argv && a.argv.includes('enterprise-skills'));
          return row ? { depth: row.depth, argv: row.argv, error: row.error, planted: row.names ? PLANTED.filter((n) => row.names.includes(n)) : null } : null;
        }),
      };
      writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      results.push(summary);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const [withFlag, without] = results;
  const readsCli = (r) => r.cliProcess.length > 0 && r.cliProcess.every((c) => c && !c.error && PLANTED.every((n) => c.planted.includes(n)));
  const ok =
    withFlag.stubRuns > 0 &&
    withFlag.ownCredentialLike.every((c) => c.join(' ') === 'ANTHROPIC_API_KEY') &&
    readsCli(withFlag) &&
    without.flagsRemoved === 2 &&
    without.stubRuns > 0 &&
    without.ownCredentialLike.every((c) => c.length === 0) &&
    readsCli(without);
  for (const r of results) {
    console.log(`${r.which}: ${r.action}`);
    console.log(`  steps: ${r.steps.join(' -> ')}`);
    console.log(`  stub claude runs: ${r.stubRuns}`);
    r.own.forEach((o, k) => {
      console.log(`  stub own env names: ${o.join(' ')}`);
      console.log(`  stub own credential-like names: ${r.ownCredentialLike[k].join(' ') || '(none)'}`);
      const c = r.cliProcess[k];
      console.log(`  CLI process (${c ? `depth ${c.depth}, ${c.argv.join(' ')}` : 'not found'}) environ, planted names readable: ${c?.planted?.join(' ') ?? c?.error ?? '(none)'}`);
    });
  }
  console.log(`T3 limit ${ok ? 'PASS' : 'FAIL'}: with the flag the stub's own environment holds ANTHROPIC_API_KEY and no other credential-like name, without it none; with and without, the stub reads ${PLANTED.join(', ')} from the CLI process's environ`);
  return ok;
}

main();
