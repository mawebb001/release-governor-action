#!/usr/bin/env node
/**
 * Cursor hook: stop — optional orchestrate signal-active.
 * Controlled by .project-ai/orchestration-hooks.json (stopSignalActive).
 */
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';

const cwd = process.cwd();
const configPath = join(cwd, '.project-ai', 'orchestration-hooks.json');

function log(msg) {
  try {
    const dir = join(cwd, '.project-ai', 'hook-logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'stop-signal-active.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

function drainStdin() {
  try {
    if (!process.stdin.isTTY) {
      readFileSync(0, 'utf8');
    }
  } catch {
    /* ignore */
  }
}

drainStdin();

if (!existsSync(configPath)) {
  process.exit(0);
}

let config = {};
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (e) {
  log(`invalid orchestration-hooks.json: ${e}`);
  process.exit(0);
}

if (!config.stopSignalActive) {
  process.exit(0);
}

const isWin = process.platform === 'win32';
const result = spawnSync(
  'enterprise-skills',
  ['orchestrate', 'signal-active', '--json', '--summary', 'cursor-hook-stop'],
  {
    cwd,
    encoding: 'utf8',
    shell: isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

if (result.error) {
  log(`spawn error: ${result.error.message}`);
  process.exit(0);
}

const out = (result.stdout || '').trim();
if (out) {
  try {
    const j = JSON.parse(out);
    if (j.ok === false && j.error === 'no_active_skill') {
      log('no active skill; nothing to signal');
    } else {
      log(`signal-active: ${out.slice(0, 800)}`);
    }
  } catch {
    log(`stdout: ${out.slice(0, 500)}`);
  }
}

if (result.status !== 0 && result.stderr) {
  log(`stderr: ${(result.stderr || '').slice(0, 500)}`);
}

process.exit(0);
