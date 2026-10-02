#!/usr/bin/env node
// Guard for action.yml: the shape that let a floating CLI range start an agent
// without its key, and that put the license key next to an agent, must not
// come back. Fails, naming the step, when:
//   - ES_LICENSE_KEY is in the env of a step whose run text starts an agent
//     (`claude`, `agents run`, `orchestrate`), or at composite/top level;
//   - an `agents run` / `orchestrate workflow run` command lacks
//     `--pass-env ANTHROPIC_API_KEY`;
//   - the cli-version default is not an exact version;
//   - a claude-code install is not an exact version;
//   - the evidence gate is not wired: there must be exactly one step with an
//     `id` whose run invokes scripts/evidence-gate.mjs, fed the installed
//     version (`enterprise-skills --version`), placed before every step that
//     starts an agent; and every such step's `if` must require
//     `steps.<that id>.outputs.allowed == 'true'` as a top-level `&&` term;
//   - a step's shape cannot be read (a `uses:` step, an unparseable `if`).
// Then runs the evidence gate's own table.
//
// Usage: node scripts/check-action.mjs [path/to/action.yml]
// No dependencies: action.yml is read with a strict YAML subset parser that
// throws on anything it does not understand (fail closed).

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selfTest } from './evidence-gate.mjs';

const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseYamlSubset(text) {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const fail = (msg) => {
    throw new Error(`action.yml line ${i + 1}: ${msg}`);
  };
  const indentOf = (s) => s.match(/^ */)[0].length;
  const blank = (s) => /^\s*(#.*)?$/.test(s);
  const skipBlank = () => {
    while (i < lines.length && blank(lines[i])) i += 1;
  };

  function scalar(raw) {
    const s = raw.trim();
    if (s.startsWith('"')) {
      const m = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(s);
      if (!m) fail('unterminated double-quoted scalar');
      return m[1].replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\' })[c] ?? fail(`unsupported escape \\${c}`));
    }
    if (s.startsWith("'")) {
      const m = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(s);
      if (!m) fail('unterminated single-quoted scalar');
      return m[1].replace(/''/g, "'");
    }
    if (/^[[{&*!%@`]/.test(s)) fail(`unsupported YAML construct: ${s.slice(0, 20)}`);
    return s.replace(/\s+#.*$/, '');
  }

  function blockScalar(parentIndent, header) {
    const m = /^([|>])([-+]?)\s*(#.*)?$/.exec(header);
    if (!m) fail(`unsupported block scalar header ${header}`);
    const body = [];
    let blockIndent = null;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') {
        body.push('');
        i += 1;
        continue;
      }
      const ind = indentOf(line);
      if (ind <= parentIndent) break;
      if (blockIndent === null) blockIndent = ind;
      if (ind < blockIndent) fail('block scalar line less indented than its first line');
      body.push(line.slice(blockIndent));
      i += 1;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    let out;
    if (m[1] === '|') {
      out = body.join('\n');
    } else {
      out = body.reduce((acc, l) => (acc === '' ? l : l === '' ? `${acc}\n` : acc.endsWith('\n') ? acc + l : `${acc} ${l}`), '');
    }
    return m[2] === '-' ? out : `${out}\n`;
  }

  function node(indent) {
    skipBlank();
    if (i >= lines.length) return null;
    const ind = indentOf(lines[i]);
    if (ind < indent) return null;
    const t = lines[i].slice(ind);
    return t === '-' || t.startsWith('- ') ? seq(ind) : map(ind);
  }

  function value(ind, rest) {
    if (rest === '' || rest.startsWith('#')) {
      skipBlank();
      if (i >= lines.length) return null;
      const ni = indentOf(lines[i]);
      const nt = lines[i].slice(ni);
      if (ni > ind || (ni === ind && nt.startsWith('- '))) return node(ni);
      return null;
    }
    if (/^[|>]/.test(rest)) return blockScalar(ind, rest);
    return scalar(rest);
  }

  function map(ind) {
    const obj = {};
    for (;;) {
      skipBlank();
      if (i >= lines.length) break;
      const cur = indentOf(lines[i]);
      if (cur < ind) break;
      if (cur > ind) fail('unexpected indentation');
      const t = lines[i].slice(ind);
      if (t.startsWith('- ')) break;
      const m = /^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/.exec(t);
      if (!m) fail(`expected "key: value", got ${JSON.stringify(t.slice(0, 40))}`);
      if (Object.prototype.hasOwnProperty.call(obj, m[1])) fail(`duplicate key ${m[1]}`);
      i += 1;
      obj[m[1]] = value(ind, (m[2] ?? '').trim());
    }
    return obj;
  }

  function seq(ind) {
    const arr = [];
    for (;;) {
      skipBlank();
      if (i >= lines.length) break;
      const cur = indentOf(lines[i]);
      const t = lines[i].slice(cur);
      if (cur !== ind || !(t === '-' || t.startsWith('- '))) break;
      const rest = t.slice(1).trim();
      if (rest === '' || /^[A-Za-z0-9_.-]+:(\s|$)/.test(rest)) {
        // "- key: value" opens a mapping indented two past the dash.
        lines[i] = `${' '.repeat(ind + 2)}${rest}`;
        if (rest === '') i += 1;
        arr.push(node(ind + 1));
      } else {
        i += 1;
        arr.push(scalar(rest));
      }
    }
    return arr;
  }

  const root = node(0);
  skipBlank();
  if (i < lines.length) fail('content after the document root');
  return root;
}

// Logical shell lines: backslash-newline continuations joined.
function logicalLines(run) {
  return run.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
}

const STARTS_AGENT = /\bclaude\b|agents run|orchestrate/;
const RUNS_GATE = /scripts\/evidence-gate\.mjs\b/;
const STEP_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const GATE_TERM = /^steps\.([A-Za-z_][A-Za-z0-9_-]*)\.outputs\.allowed\s*==\s*'true'$/;

// True when the first '(' of t closes at its last character.
function wrapsWhole(t) {
  if (!t.startsWith('(') || !t.endsWith(')')) return false;
  let depth = 0;
  let quote = false;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (quote) {
      if (c === "'") {
        if (t[i + 1] === "'") i += 1;
        else quote = false;
      }
      continue;
    }
    if (c === "'") quote = true;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0 && i < t.length - 1) return false;
    }
  }
  return depth === 0;
}

// The step ids an `if` requires to have outputs.allowed == 'true', read from
// its top-level `&&` terms. Anything that could make the gate optional or that
// cannot be read (a top-level `||`, partial `${{ }}`, unbalanced quotes or
// parentheses) is { ok: false }: unverifiable is not negative.
export function requiredGateIds(ifText) {
  if (typeof ifText !== 'string') return { ok: false, why: 'not a string' };
  let e = ifText.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(e);
  if (wrapped) e = wrapped[1].trim();
  if (e.includes('${{') || e.includes('}}')) return { ok: false, why: 'partial ${{ }} interpolation' };
  const terms = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < e.length; i += 1) {
    const c = e[i];
    if (quote) {
      if (c === "'") {
        if (e[i + 1] === "'") i += 1;
        else quote = false;
      }
      continue;
    }
    if (c === "'") quote = true;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth < 0) return { ok: false, why: 'unbalanced parentheses' };
    } else if (depth === 0 && e.startsWith('||', i)) {
      return { ok: false, why: "a top-level '||' can make the gate optional" };
    } else if (depth === 0 && e.startsWith('&&', i)) {
      terms.push(e.slice(start, i));
      start = i + 2;
      i += 1;
    }
  }
  if (quote || depth !== 0) return { ok: false, why: 'unbalanced quotes or parentheses' };
  terms.push(e.slice(start));
  const ids = [];
  for (let t of terms) {
    t = t.trim();
    while (wrapsWhole(t)) t = t.slice(1, -1).trim();
    const m = GATE_TERM.exec(t);
    if (m) ids.push(m[1]);
  }
  return { ok: true, ids };
}

// Problems with how the gate step feeds the gate the installed version.
function gateFeedProblems(run) {
  const problems = [];
  const lines = logicalLines(run);
  const capture = lines.findIndex((l) => /\bES_VERSION_OUT="\$\(enterprise-skills --version\)"/.test(l));
  const invoke = lines.findIndex((l) => /\bnode\b/.test(l) && RUNS_GATE.test(l));
  const exported = lines.findIndex((l) => /^\s*export\b/.test(l) && /\bES_VERSION_OUT\b/.test(l) && /\bES_VERSION_RC\b/.test(l));
  if (capture < 0) problems.push('does not capture `enterprise-skills --version` into ES_VERSION_OUT');
  if ((run.match(/\bES_VERSION_OUT=/g) ?? []).length !== 1) problems.push('assigns ES_VERSION_OUT other than exactly once');
  if (!/\bES_VERSION_RC=\$\?/.test(run)) problems.push('does not pass the exit status of `enterprise-skills --version` as ES_VERSION_RC');
  if (invoke < 0) problems.push('does not run scripts/evidence-gate.mjs with node');
  if (exported < 0) problems.push('does not export ES_VERSION_OUT and ES_VERSION_RC');
  if (capture >= 0 && invoke >= 0 && !(capture <= exported && exported < invoke)) {
    problems.push('does not capture and export the version before running the gate');
  }
  return problems;
}

export function checkAction(doc) {
  const failures = [];
  const steps = doc?.runs?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return ['[action.yml] runs.steps is missing or empty — cannot check'];
  }
  if (doc.env && 'ES_LICENSE_KEY' in doc.env) failures.push('[top level] ES_LICENSE_KEY in top-level env');
  if (doc.runs.env && 'ES_LICENSE_KEY' in doc.runs.env) failures.push('[composite] ES_LICENSE_KEY in runs.env (reaches every step)');

  const def = doc.inputs?.['cli-version']?.default;
  if (typeof def !== 'string' || !EXACT.test(def)) {
    failures.push(`[input cli-version] default ${JSON.stringify(def)} is not an exact version (want e.g. "4.31.0")`);
  }

  const stepName = (step, idx) => step?.name ?? `#${idx + 1}`;
  const gates = steps.map((step, idx) => ({ step, idx })).filter(({ step }) => typeof step?.run === 'string' && RUNS_GATE.test(step.run));
  let gate = null;
  if (gates.length === 0) {
    failures.push('[gate] no step runs scripts/evidence-gate.mjs — the evidence phase is not gated');
  } else if (gates.length > 1) {
    failures.push(`[gate] ${gates.length} steps run scripts/evidence-gate.mjs (${gates.map((g) => stepName(g.step, g.idx)).join('; ')}) — ambiguous, cannot verify`);
  } else {
    gate = gates[0];
    const gname = stepName(gate.step, gate.idx);
    if (typeof gate.step.id !== 'string' || !STEP_ID.test(gate.step.id)) {
      failures.push(`[step: ${gname}] the gate step has no usable id, so no step can require its output`);
    }
    for (const p of gateFeedProblems(gate.step.run)) failures.push(`[step: ${gname}] the gate step ${p}`);
  }
  const gateId = typeof gate?.step.id === 'string' ? gate.step.id : null;

  steps.forEach((step, idx) => {
    const name = stepName(step, idx);
    if (step === null || typeof step !== 'object') {
      failures.push(`[step: ${name}] is not a mapping — cannot check (fail closed)`);
      return;
    }
    if (typeof step.run !== 'string') {
      failures.push(`[step: ${name}] has no run text${step.uses ? ` (uses: ${step.uses})` : ''} — cannot tell whether it starts an agent (fail closed)`);
      return;
    }
    const run = step.run;
    const env = step.env ?? {};
    const startsAgent = STARTS_AGENT.test(run);
    if (startsAgent) {
      if (gate && gate.idx > idx) {
        failures.push(`[step: ${name}] starts an agent before the gate step (${stepName(gate.step, gate.idx)}) runs`);
      }
      if (step.if === undefined || step.if === null || step.if === '') {
        failures.push(`[step: ${name}] starts an agent with no if — it is not gated`);
      } else {
        const req = requiredGateIds(step.if);
        if (!req.ok) {
          failures.push(`[step: ${name}] if cannot be verified (${req.why}) — fail closed`);
        } else if (req.ids.length === 0) {
          failures.push(`[step: ${name}] if does not require steps.<gate id>.outputs.allowed == 'true'`);
        } else if (!gate) {
          failures.push(`[step: ${name}] if requires steps.${req.ids.join('/')}.outputs.allowed, but there is no single gate step`);
        } else if (!gateId || !req.ids.includes(gateId)) {
          failures.push(`[step: ${name}] if requires steps.${req.ids.join('/')}.outputs.allowed, but the gate step's id is ${JSON.stringify(gate.step.id ?? null)}`);
        }
      }
    }
    if (startsAgent && 'ES_LICENSE_KEY' in env) {
      failures.push(`[step: ${name}] ES_LICENSE_KEY is in the env of a step that starts an agent`);
    }
    for (const line of logicalLines(run)) {
      if (/agents run|orchestrate workflow run/.test(line) && !/--pass-env[ =]ANTHROPIC_API_KEY\b/.test(line)) {
        failures.push(`[step: ${name}] agent command lacks --pass-env ANTHROPIC_API_KEY: ${line.trim().slice(0, 100)}`);
      }
      for (const m of line.matchAll(/@anthropic-ai\/claude-code(?:@(\S+))?/g)) {
        if (!m[1] || !EXACT.test(m[1].replace(/["']$/, ''))) {
          failures.push(`[step: ${name}] claude-code install is not an exact version: ${m[0]}`);
        }
      }
    }
  });
  return failures;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const path = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'action.yml');
  let failures;
  try {
    failures = checkAction(parseYamlSubset(readFileSync(path, 'utf8')));
  } catch (err) {
    failures = [`[parse] ${err instanceof Error ? err.message : String(err)}`];
  }
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(failures.length === 0 ? `action check: ${path} OK` : `action check: ${path} — ${failures.length} failure(s)`);
  const gateOk = selfTest();
  process.exitCode = failures.length === 0 && gateOk ? 0 : 1;
}
