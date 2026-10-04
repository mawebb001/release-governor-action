#!/usr/bin/env node
// Evidence-phase gate. The evidence steps start an agent over pull-request
// content; only enterprise-skills >= 4.31.0 hands that agent an allowlisted
// environment and takes the vendor key by name (--pass-env). The decision is
// made from the INSTALLED version, never the requested range, and it fails
// closed: older, pre-release, empty, unparseable, or a failed
// `enterprise-skills --version` all refuse.
//
// Action mode (no arguments) reads:
//   ES_VERSION_RC   exit status of `enterprise-skills --version`
//   ES_VERSION_OUT  its stdout
//   EVIDENCE        the `evidence` input
//   FUNDED          "true" when an anthropic-api-key was provided
// and writes allowed=true|false to $GITHUB_OUTPUT. It never fails the step:
// a refusal skips the evidence steps and the govern step still runs.
//
// `node scripts/evidence-gate.mjs --self-test` runs GATE_TABLE.

import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MIN_VERSION = [4, 31, 0];

const PLAIN_RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function decide({ rc, out }) {
  if (rc !== 0) {
    return { allowed: false, version: null, reason: `enterprise-skills --version failed (exit ${rc})` };
  }
  const text = typeof out === 'string' ? out.trim() : '';
  const m = PLAIN_RELEASE.exec(text);
  if (!m) {
    return { allowed: false, version: null, reason: `installed version is not a plain release (${JSON.stringify(text.slice(0, 40))})` };
  }
  const parts = m.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (parts[i] !== MIN_VERSION[i]) {
      const allowed = parts[i] > MIN_VERSION[i];
      return { allowed, version: text, reason: `installed ${text} is ${allowed ? 'newer than' : 'older than'} ${MIN_VERSION.join('.')}` };
    }
  }
  return { allowed: true, version: text, reason: `installed ${text} equals ${MIN_VERSION.join('.')}` };
}

// rc/out pairs as the action step captures them.
export const GATE_TABLE = [
  { rc: 0, out: '4.31.0\n', allowed: true },
  { rc: 0, out: '4.31.1\n', allowed: true },
  { rc: 0, out: '4.32.0\n', allowed: true },
  { rc: 0, out: '5.0.0\n', allowed: true },
  { rc: 0, out: '4.30.2\n', allowed: false },
  { rc: 0, out: '4.14.0\n', allowed: false },
  { rc: 0, out: '4.13.0\n', allowed: false },
  { rc: 0, out: '3.99.99\n', allowed: false },
  { rc: 0, out: '4.31.0-rc.1\n', allowed: false },
  { rc: 0, out: '4.31.0+build.1\n', allowed: false },
  { rc: 0, out: 'v4.31.0\n', allowed: false },
  { rc: 0, out: '04.31.0\n', allowed: false },
  { rc: 0, out: '0.0.0\n', allowed: false },
  { rc: 0, out: '', allowed: false },
  { rc: 0, out: 'garbage\n', allowed: false },
  { rc: 0, out: '4.31.0\n4.31.0\n', allowed: false },
  { rc: 127, out: '', allowed: false },
  { rc: 1, out: '4.31.0\n', allowed: false },
];

export function selfTest(log = console.log) {
  let failures = 0;
  for (const row of GATE_TABLE) {
    const got = decide(row);
    const ok = got.allowed === row.allowed;
    if (!ok) failures += 1;
    log(`${ok ? 'ok  ' : 'FAIL'} rc=${row.rc} out=${JSON.stringify(row.out)} -> ${got.allowed ? 'allowed' : 'refused'} (${got.reason})`);
  }
  log(`evidence-gate table: ${GATE_TABLE.length - failures}/${GATE_TABLE.length} rows as expected`);
  return failures === 0;
}

// Workflow-command escaping for an annotation message.
function escapeData(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function actionMode(env) {
  const rc = Number.parseInt(env.ES_VERSION_RC ?? '', 10);
  const result = decide({ rc: Number.isNaN(rc) ? -1 : rc, out: env.ES_VERSION_OUT ?? '' });
  const requested = (env.EVIDENCE ?? '') !== 'none';
  const funded = env.FUNDED === 'true';
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `allowed=${result.allowed}\n`);
  if (result.allowed) {
    console.log(`Evidence gate: allowed — ${result.reason}.`);
    return;
  }
  const installed = result.version
    ? `enterprise-skills ${result.version} is installed (${result.reason}).`
    : `The installed enterprise-skills version could not be verified (${result.reason}).`;
  const message =
    `${installed} The evidence phase needs a plain release >= ${MIN_VERSION.join('.')}: ` +
    `${MIN_VERSION.join('.')} hands the agent an allowlisted environment and takes the vendor key by name (--pass-env). ` +
    `Both evidence steps are skipped; the govern step still runs. Fix: set cli-version to ${MIN_VERSION.join('.')} or newer.`;
  if (requested && funded) {
    console.log(`::error title=Evidence phase refused::${escapeData(message)}`);
  } else {
    console.log(`Evidence gate: refused — ${result.reason} (no evidence phase was requested and funded, so nothing is skipped).`);
  }
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
    actionMode(process.env);
  }
}
