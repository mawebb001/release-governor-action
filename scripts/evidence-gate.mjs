#!/usr/bin/env node
// Installed-version step and evidence-phase gate. The action reads
// `enterprise-skills --version` once, in the step that runs this script, and
// every later step uses this step's outputs.
//
//   - Unreadable (the command exits non-zero, or prints something that is not
//     a version): this script exits 1 with an error, which fails the step and
//     the job there. No later step runs, the govern step included.
//   - Readable: the outputs are written and this step succeeds.
//       version               the installed version
//       evidence              agents | release-readiness | none — the evidence
//                             step that may run (subject to the Claude Code
//                             install and the license-file check). Not none
//                             only for a plain release >= MIN_VERSION, funded,
//                             with that mode requested.
//       refused               true when an evidence phase was requested and
//                             funded but the version refuses it
//       evidence-input-valid  false when the evidence input is not agents,
//                             release-readiness or none
//       plant-license-file    true for a release below 4.14, which reads only
//                             ~/.enterprise-skills/license.json
//     A readable version that is older than MIN_VERSION or is not a plain
//     release (a pre-release, build metadata) refuses the evidence phase, with
//     an error naming the fix when evidence was requested and funded. Refused
//     or invalid: the govern step still runs, then the action's last step
//     fails the job.
//
// Action mode (no arguments) reads:
//   ES_VERSION_RC   exit status of `enterprise-skills --version`
//   ES_VERSION_OUT  its stdout
//   EVIDENCE        the `evidence` input
//   FUNDED          "true" when an anthropic-api-key was provided
//
// `node scripts/evidence-gate.mjs --self-test` runs GATE_TABLE.

import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MIN_VERSION = [4, 31, 0];
const ENV_FIRST_LICENSE = [4, 14];

const NUM = '(0|[1-9]\\d*)';
const IDENT = '[0-9A-Za-z-]+';
const VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}((?:-${IDENT}(?:\\.${IDENT})*)?(?:\\+${IDENT}(?:\\.${IDENT})*)?)$`);

// { readable, version, plain, allowed, plantLicenseFile, reason }
export function decide({ rc, out }) {
  if (rc !== 0) {
    return { readable: false, reason: `\`enterprise-skills --version\` exited ${rc}` };
  }
  const text = typeof out === 'string' ? out.trim() : '';
  const m = VERSION.exec(text);
  if (!m) {
    return { readable: false, reason: `\`enterprise-skills --version\` printed ${JSON.stringify(text.slice(0, 40))}, which is not a version` };
  }
  const parts = m.slice(1, 4).map(Number);
  const plain = m[4] === '';
  const plantLicenseFile = parts[0] < ENV_FIRST_LICENSE[0] || (parts[0] === ENV_FIRST_LICENSE[0] && parts[1] < ENV_FIRST_LICENSE[1]);
  let cmp = 0;
  for (let i = 0; i < 3 && cmp === 0; i += 1) cmp = Math.sign(parts[i] - MIN_VERSION[i]);
  const min = MIN_VERSION.join('.');
  if (!plain) {
    return { readable: true, version: text, plain, allowed: false, plantLicenseFile, reason: `installed ${text} is not a plain release` };
  }
  const allowed = cmp >= 0;
  const relation = cmp > 0 ? 'newer than' : cmp < 0 ? 'older than' : 'equal to';
  return { readable: true, version: text, plain, allowed, plantLicenseFile, reason: `installed ${text} is ${relation} ${min}` };
}

// rc/out pairs as the action step captures them.
export const GATE_TABLE = [
  { rc: 0, out: '4.31.0\n', readable: true, allowed: true, plant: false },
  { rc: 0, out: '4.31.0\r\n', readable: true, allowed: true, plant: false },
  { rc: 0, out: '4.31.1\n', readable: true, allowed: true, plant: false },
  { rc: 0, out: '4.32.0\n', readable: true, allowed: true, plant: false },
  { rc: 0, out: '5.0.0\n', readable: true, allowed: true, plant: false },
  { rc: 0, out: '4.30.2\n', readable: true, allowed: false, plant: false },
  { rc: 0, out: '4.14.0\n', readable: true, allowed: false, plant: false },
  { rc: 0, out: '4.13.0\n', readable: true, allowed: false, plant: true },
  { rc: 0, out: '3.99.99\n', readable: true, allowed: false, plant: true },
  { rc: 0, out: '0.0.0\n', readable: true, allowed: false, plant: true },
  { rc: 0, out: '4.31.0-rc.1\n', readable: true, allowed: false, plant: false },
  { rc: 0, out: '4.32.0-rc.1\n', readable: true, allowed: false, plant: false },
  { rc: 0, out: '4.31.0+build.1\n', readable: true, allowed: false, plant: false },
  { rc: 0, out: '4.13.0-rc.1\n', readable: true, allowed: false, plant: true },
  { rc: 0, out: 'v4.31.0\n', readable: false },
  { rc: 0, out: '04.31.0\n', readable: false },
  { rc: 0, out: '\u001b[31m4.31.0\u001b[0m\n', readable: false },
  { rc: 0, out: '', readable: false },
  { rc: 0, out: 'garbage\n', readable: false },
  { rc: 0, out: '4.31.0\n4.31.0\n', readable: false },
  { rc: 0, out: '4.31.0\nallowed=true\n', readable: false },
  { rc: 127, out: '', readable: false },
  { rc: 42, out: '4.31.0\n', readable: false },
  { rc: 1, out: '4.31.0\n', readable: false },
];

export function selfTest(log = console.log) {
  let failures = 0;
  for (const row of GATE_TABLE) {
    const got = decide(row);
    const ok =
      got.readable === row.readable &&
      (!row.readable || (got.allowed === row.allowed && got.plantLicenseFile === row.plant));
    if (!ok) failures += 1;
    const verdict = !got.readable ? 'unreadable (job fails)' : `${got.allowed ? 'allowed' : 'refused'}${got.plantLicenseFile ? ', plant license file' : ''}`;
    log(`${ok ? 'ok  ' : 'FAIL'} rc=${row.rc} out=${JSON.stringify(row.out)} -> ${verdict} (${got.reason})`);
  }
  log(`evidence-gate table: ${GATE_TABLE.length - failures}/${GATE_TABLE.length} rows as expected`);
  return failures === 0;
}

// Workflow-command escaping for an annotation message.
function escapeData(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

const MODES = new Set(['agents', 'release-readiness']);
const VALID_MODES = new Set(['agents', 'release-readiness', 'none']);

// Returns the process exit code.
function actionMode(env) {
  const rcText = env.ES_VERSION_RC ?? '';
  const rc = /^\d+$/.test(rcText) ? Number(rcText) : -1;
  const result = decide({ rc, out: env.ES_VERSION_OUT ?? '' });
  const min = MIN_VERSION.join('.');
  if (!result.readable) {
    console.log(
      `::error title=Installed CLI version unreadable::${escapeData(result.reason)}. ` +
        'The job stops here: no later step runs, including the govern step. ' +
        `Fix: set cli-version to a release that installs a working enterprise-skills CLI on this runner (the default, ${min}, is one).`,
    );
    return 1;
  }
  const mode = env.EVIDENCE ?? '';
  const valid = VALID_MODES.has(mode);
  const requested = MODES.has(mode);
  const funded = env.FUNDED === 'true';
  const evidence = result.allowed && requested && funded ? mode : 'none';
  const refused = requested && funded && !result.allowed;
  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `version=${result.version}\nevidence=${evidence}\nrefused=${refused}\nevidence-input-valid=${valid}\nplant-license-file=${result.plantLicenseFile}\n`,
    );
  }
  if (!valid) {
    console.log(
      `::error title=Invalid evidence input::evidence is ${escapeData(JSON.stringify(mode.slice(0, 40)))}; it must be agents, release-readiness or none. ` +
        'No evidence step runs; the govern step runs and then the job fails. Fix: set evidence to agents, release-readiness or none.',
    );
  }
  if (result.allowed) {
    console.log(`Installed enterprise-skills ${result.version}: the evidence phase is allowed (${result.reason}).`);
  } else if (requested && funded) {
    console.log(
      `::error title=Evidence phase refused::enterprise-skills ${escapeData(result.version)} is installed (${escapeData(result.reason)}). ` +
        `The evidence phase needs a plain release >= ${min}: ${min} hands the agent an allowlisted environment, and the vendor key is in it because the evidence steps pass --pass-env ANTHROPIC_API_KEY. ` +
        'The agent runs as the same OS user as the CLI, so it can read the CLI process\'s environment, which holds the key with or without the flag. ' +
        `Both evidence steps are skipped; the govern step runs and then the job fails. Fix: set cli-version to ${min} or newer.`,
    );
  } else {
    console.log(`Installed enterprise-skills ${result.version}: the evidence phase is refused (${result.reason}); no evidence phase was requested and funded, so nothing is skipped.`);
  }
  if (evidence === 'none' && result.allowed) {
    console.log(`No evidence step runs: evidence is ${JSON.stringify(mode)} and the phase is ${funded ? 'funded' : 'unfunded'}.`);
  }
  return 0;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  if (process.argv[2] === '--self-test') {
    process.exitCode = selfTest() ? 0 : 1;
  } else {
    process.exitCode = actionMode(process.env);
  }
}
