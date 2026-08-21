#!/usr/bin/env node
/**
 * Cursor `beforeShellExecution` — skill trigger bindings
 * (docs/WIRING_PROBES_DESIGN.md §7, A6).
 *
 * `pre-deploy-check` was active in the pack and simply never invoked before
 * either infrastructure apply. This hook removes "somebody remembers at exactly
 * the right moment" from the loop: when a command matching a binding is about
 * to run, the required skill must already have been satisfied on this branch.
 *
 * Deliberately thin. Every rule lives in `enterprise-skills triggers check`, so
 * this shim and the Claude Code one cannot disagree about what is armed.
 *
 * stdin  : { command, cwd, sandbox }
 * stdout : { permission: "allow" | "ask" | "deny", user_message, agent_message }
 *
 * FAILS OPEN, on purpose and with a named reason: a pre-execution hook that
 * errors must not brick the user's shell. The gate that must not fail open is
 * the merge gate, which is the Governor, and it is unaffected by this file.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PERMISSION = { allow: 'allow', warn: 'allow', ask: 'ask', block: 'deny' };

function allow(reason) {
  process.stdout.write(JSON.stringify(reason ? { permission: 'allow', agent_message: reason } : { permission: 'allow' }));
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const raw = readStdin();
let input = {};
try {
  input = raw ? JSON.parse(raw) : {};
} catch {
  allow();
}

const command = typeof input.command === 'string' ? input.command : '';
const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
if (!command) allow();

// No bindings configured means nothing to enforce — stay silent and cheap.
if (!existsSync(join(cwd, '.project-ai', 'SKILL_TRIGGERS.yaml'))) allow();

// The command travels in the ENVIRONMENT, never in argv. On Windows the
// `enterprise-skills` entry point is a .cmd shim, which forces `shell: true`,
// and Node then joins argv into a command line — so a command containing `&`
// would execute its tail from inside the gate meant to control it, and any
// command containing a space would split and silently never match. A shell does
// not re-scan an expanded variable's value, so the env var is safe whatever it
// holds. Same fix as ES_AGENT_PROMPT in the agent executors.
const result = spawnSync('enterprise-skills', ['triggers', 'check', '--json'], {
  cwd,
  encoding: 'utf8',
  timeout: 10000,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
  env: { ...process.env, ES_TRIGGER_COMMAND: command },
});

if (result.error || typeof result.stdout !== 'string' || result.stdout.trim().length === 0) {
  allow('enterprise-skills trigger bindings could not be evaluated; the command was allowed unchecked.');
}

let verdict;
try {
  verdict = JSON.parse(result.stdout);
} catch {
  allow('enterprise-skills trigger bindings returned unreadable output; the command was allowed unchecked.');
}

const permission = PERMISSION[verdict?.decision] ?? 'allow';
if (permission === 'allow') allow();

process.stdout.write(
  JSON.stringify({
    permission,
    user_message: verdict.message,
    agent_message:
      `${verdict.message}\n\n` +
      'Run the required skill now, then record it and retry. Do not work around this by ' +
      'rephrasing the command — the binding exists because this command class introduced ' +
      'the last three production defects.',
  }),
);
process.exit(0);
