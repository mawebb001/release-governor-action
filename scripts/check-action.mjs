#!/usr/bin/env node
// Guard for action.yml: the shape that let a floating CLI range start an agent
// without its key, and that put the license key next to an agent, must not
// come back. Fails, naming the step, when:
//   - ES_LICENSE_KEY is in the env of a step whose run text starts an agent
//     (`claude`, `agents run`, `orchestrate`), or at composite/top level;
//   - an `agents run` / `orchestrate workflow run` command lacks
//     `--pass-env ANTHROPIC_API_KEY`;
//   - the cli-version default is not an exact version;
//   - a claude-code install is not an exact version.
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

  steps.forEach((step, idx) => {
    const name = step?.name ?? `#${idx + 1}`;
    const run = typeof step?.run === 'string' ? step.run : '';
    const env = step?.env ?? {};
    const startsAgent = /\bclaude\b|agents run|orchestrate/.test(run);
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
