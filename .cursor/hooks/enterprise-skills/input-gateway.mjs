#!/usr/bin/env node
/**
 * Cursor hook: userPromptSubmit — optional orchestration input gateway.
 * Controlled by .project-ai/orchestration-hooks.json (inputGateway).
 *
 * The hook reads the prompt payload from stdin, starts a structured task
 * contract, and blocks only when the advisor returns a hard block.
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
    appendFileSync(join(dir, 'input-gateway.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

function readStdin() {
  try {
    if (!process.stdin.isTTY) {
      return readFileSync(0, 'utf8');
    }
  } catch {
    /* ignore */
  }
  return '';
}

function findPrompt(value, depth = 0) {
  if (depth > 5 || value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPrompt(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  const record = value;
  for (const key of ['prompt', 'message', 'text', 'input', 'userPrompt', 'user_prompt']) {
    const found = findPrompt(record[key], depth + 1);
    if (found) return found;
  }
  for (const child of Object.values(record)) {
    const found = findPrompt(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractPrompt(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return findPrompt(JSON.parse(trimmed));
  } catch {
    return trimmed;
  }
}

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

if (!config.inputGateway) {
  process.exit(0);
}

const prompt = extractPrompt(readStdin());
if (!prompt) {
  log('no prompt payload found; skip input gateway');
  process.exit(0);
}

const tier = typeof config.subscriptionTier === 'string' ? config.subscriptionTier : 'community';
const maxPromptChars = Number.isInteger(config.maxPromptChars) ? config.maxPromptChars : 2000;
const promptForContract = prompt.slice(0, maxPromptChars);
const isWin = process.platform === 'win32';

function quoteWindowsArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function runStartTask() {
  if (isWin) {
    return spawnSync(
      `enterprise-skills orchestrate start-task ${quoteWindowsArg(promptForContract)} --tier ${quoteWindowsArg(tier)} --json`,
      {
        cwd,
        encoding: 'utf8',
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  }

  return spawnSync('enterprise-skills', ['orchestrate', 'start-task', promptForContract, '--tier', tier, '--json'], {
    cwd,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const result = runStartTask();

if (result.error) {
  log(`spawn error: ${result.error.message}`);
  process.exit(0);
}

const stdout = (result.stdout || '').trim();
let decision = 'unknown';
let risk = 'unknown';
let taskId = 'unknown';
if (stdout) {
  try {
    const contract = JSON.parse(stdout);
    decision = contract.decision || decision;
    risk = contract.risk_level || risk;
    taskId = contract.task_id || taskId;
  } catch {
    log(`unparsed stdout: ${stdout.slice(0, 500)}`);
  }
}

log(`task=${taskId} decision=${decision} risk=${risk}`);

if (result.status !== 0 && result.stderr) {
  log(`stderr: ${(result.stderr || '').slice(0, 500)}`);
}

if (decision === 'block') {
  console.error(
    `Enterprise Skills input gateway blocked this prompt. task=${taskId} risk=${risk}. ` +
      'Review .project-ai/skill-outputs/_task-contract.yaml for details.',
  );
  process.exit(1);
}

// Agent brief: surface the advisor decision + workflow ready-steps to the
// agent. stdout is injected as context by IDEs that support it; the same
// content is persisted to .project-ai/skill-outputs/_agent-brief.md for
// agents that read state files instead.
if (config.agentBrief !== false) {
  const briefResult = isWin
    ? spawnSync('enterprise-skills orchestrate brief', {
        cwd,
        encoding: 'utf8',
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawnSync('enterprise-skills', ['orchestrate', 'brief'], {
        cwd,
        encoding: 'utf8',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
  if (briefResult.error) {
    log(`brief spawn error: ${briefResult.error.message}`);
  } else if (briefResult.status === 0 && (briefResult.stdout || '').trim()) {
    console.log(briefResult.stdout.trim());
  } else if (briefResult.status !== 0) {
    log(`brief exit ${briefResult.status}: ${(briefResult.stderr || '').slice(0, 300)}`);
  }
}

process.exit(0);
