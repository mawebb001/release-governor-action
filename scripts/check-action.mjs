#!/usr/bin/env node
// Guard for action.yml. It denies by default: action.yml must match, value by
// value, the action this file expects (EXPECTED_STEPS and checkInputs below).
// Every step, in order, must have exactly the expected keys, `if`, env names
// and values, and command lines; a step, key, env name or command line that is
// not expected fails, naming the step. So an agent can start only in the two
// evidence steps, both evidence steps need the one pinned claude-code install
// before them, and the cli-version default must equal the one pinned CLI
// version, with its artifact identity (integrity, gitHead) in the comment
// beside it. Pins live in scripts/pins.mjs; the gate's minimum must not exceed
// the pinned CLI version.
//
// action.yml is read twice: by the guard's own strict subset parser and by the
// real YAML parser pinned in check-parser/ (yaml, installed with
// `npm ci --ignore-scripts`). Any value on which the two readings differ
// fails. Every decision is made on the real parser's reading; when the real
// parser is not installed, the guard fails closed.
//
// Usage: node scripts/check-action.mjs [path/to/action.yml]
//   CHECK_PARSER_DIR overrides the parser directory (default: check-parser/).
// Then runs the evidence-gate and cli-version tables.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_VERSION, selfTest as gateSelfTest } from './evidence-gate.mjs';
import { selfTest as cliVersionSelfTest } from './cli-version.mjs';
import { CLAUDE_CODE_PIN, CLI_PIN } from './pins.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// The guard's own reading: a strict YAML subset parser that throws on
// anything it does not understand (fail closed).
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

// ---------------------------------------------------------------------------
// The real parser.

export function loadRealParser(dir = process.env.CHECK_PARSER_DIR ?? join(REPO, 'check-parser')) {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return { error: `no ${manifest}` };
  const want = JSON.parse(readFileSync(manifest, 'utf8')).dependencies?.yaml;
  const installed = join(dir, 'node_modules', 'yaml', 'package.json');
  if (!existsSync(installed)) return { error: `yaml is not installed in ${dir} — run \`npm ci --ignore-scripts\` there` };
  const got = JSON.parse(readFileSync(installed, 'utf8')).version;
  if (typeof want !== 'string' || got !== want) return { error: `${dir} pins yaml ${JSON.stringify(want)} but ${JSON.stringify(got)} is installed` };
  return { yaml: createRequire(manifest)('yaml'), version: got };
}

// One document, no errors or warnings, no anchors, aliases or tags; failsafe
// schema, so every scalar is a string, as the subset parser reads it.
export function readReal(text, Y) {
  const docs = Y.parseAllDocuments(text, { schema: 'failsafe', uniqueKeys: true, strict: true, prettyErrors: false });
  if (!Array.isArray(docs) || docs.length !== 1) return { problems: [`${Array.isArray(docs) ? docs.length : 0} YAML documents, expected 1`] };
  const doc = docs[0];
  const problems = [...doc.errors, ...doc.warnings].map((e) => e.message.split('\n')[0]);
  Y.visit(doc, (key, node) => {
    if (Y.isAlias(node)) problems.push(`alias *${node.source}`);
    else if (node && typeof node === 'object' && 'anchor' in node && node.anchor) problems.push(`anchor &${node.anchor}`);
    if (node && typeof node === 'object' && 'tag' in node && node.tag) problems.push(`explicit tag ${node.tag}`);
  });
  if (problems.length) return { problems };
  return { doc, value: doc.toJS(), problems };
}

// Paths at which two readings differ.
export function differences(a, b, path = '') {
  if (a === b) return [];
  const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  if (kind(a) !== kind(b)) return [`${path || '(root)'}: ${kind(a)} vs ${kind(b)}`];
  if (kind(a) === 'array') {
    const out = a.length === b.length ? [] : [`${path}: ${a.length} items vs ${b.length}`];
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) out.push(...differences(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  if (kind(a) === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    const out = ka.join('\0') === kb.join('\0') ? [] : [`${path || '(root)'}: keys ${JSON.stringify(ka)} vs ${JSON.stringify(kb)}`];
    for (const k of ka) if (Object.prototype.hasOwnProperty.call(b, k)) out.push(...differences(a[k], b[k], path ? `${path}.${k}` : k));
    return out;
  }
  return [`${path || '(root)'}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`];
}

// ---------------------------------------------------------------------------
// The expected action.

const AGENT_CMD = '--agent-cmd "claude -p \\"{prompt}\\" --permission-mode acceptEdits"';

export function expectedSteps(claudeCodePin = CLAUDE_CODE_PIN) {
  return [
    {
      name: 'Install Enterprise Skills CLI',
      shell: 'bash',
      env: { ES_CLI_VERSION: '${{ inputs.cli-version }}' },
      run: ['node "$GITHUB_ACTION_PATH/scripts/cli-version.mjs"', 'npm install -g "enterprise-skills@$ES_CLI_VERSION"', ''],
    },
    {
      name: 'Installed CLI version and evidence gate',
      id: 'cli',
      shell: 'bash',
      env: { EVIDENCE: '${{ inputs.evidence }}', FUNDED: "${{ inputs.anthropic-api-key != '' }}" },
      run: [
        'if ES_VERSION_OUT="$(enterprise-skills --version)"; then ES_VERSION_RC=0; else ES_VERSION_RC=$?; fi',
        'export ES_VERSION_OUT ES_VERSION_RC',
        'node "$GITHUB_ACTION_PATH/scripts/evidence-gate.mjs"',
        '',
      ],
    },
    {
      name: 'License compatibility (plant the file only for cli < 4.14)',
      shell: 'bash',
      env: {
        ES_LICENSE_KEY: '${{ inputs.license-key }}',
        ES_CLI_INSTALLED: '${{ steps.cli.outputs.version }}',
        PLANT_LICENSE_FILE: '${{ steps.cli.outputs.plant-license-file }}',
      },
      run: [
        'if [ "$PLANT_LICENSE_FILE" = "true" ]; then',
        '  mkdir -p ~/.enterprise-skills',
        '  node -e "require(\'fs\').writeFileSync(require(\'os\').homedir()+\'/.enterprise-skills/license.json\', JSON.stringify({ key: process.env.ES_LICENSE_KEY }))"',
        '  echo "cli $ES_CLI_INSTALLED predates env-first ES_LICENSE_KEY (4.14.0): planted the keys-only license file it reads."',
        'else',
        '  echo "cli $ES_CLI_INSTALLED resolves ES_LICENSE_KEY from the environment: no license file written."',
        'fi',
        '',
      ],
    },
    {
      name: 'License file check (refuse the evidence phase next to a license file)',
      id: 'license-file',
      if: "${{ steps.cli.outputs.evidence == 'agents' || steps.cli.outputs.evidence == 'release-readiness' }}",
      shell: 'bash',
      run: ['node "$GITHUB_ACTION_PATH/scripts/license-file-check.mjs"'],
    },
    {
      name: 'Install Claude Code (evidence phase)',
      id: 'claude-code',
      if: "${{ steps.license-file.outputs.clear == 'true' }}",
      'continue-on-error': 'true',
      shell: 'bash',
      run: [`npm install -g @anthropic-ai/claude-code@${claudeCodePin}`],
    },
    {
      name: 'Evidence phase (semantic agents)',
      id: 'agents',
      if: "${{ steps.cli.outputs.evidence == 'agents' && steps.license-file.outputs.clear == 'true' && steps.claude-code.outcome == 'success' }}",
      'continue-on-error': 'true',
      shell: 'bash',
      env: { ANTHROPIC_API_KEY: '${{ inputs.anthropic-api-key }}', BASE_REF: '${{ github.base_ref }}' },
      run: [`enterprise-skills agents run --yes --base "origin/$BASE_REF" --pass-env ANTHROPIC_API_KEY ${AGENT_CMD}`],
    },
    {
      name: 'Evidence phase (full release-readiness workflow)',
      id: 'release-readiness',
      if: "${{ steps.cli.outputs.evidence == 'release-readiness' && steps.license-file.outputs.clear == 'true' && steps.claude-code.outcome == 'success' }}",
      'continue-on-error': 'true',
      shell: 'bash',
      env: { ANTHROPIC_API_KEY: '${{ inputs.anthropic-api-key }}' },
      run: [`enterprise-skills orchestrate workflow run release-readiness --yes --pass-env ANTHROPIC_API_KEY ${AGENT_CMD} --step-timeout 1800`],
    },
    {
      name: 'Evidence phase skipped (unfunded)',
      if: "${{ inputs.anthropic-api-key == '' && inputs.evidence != 'none' }}",
      shell: 'bash',
      run: [
        'echo "::notice title=Evidence phase skipped::No anthropic-api-key input was provided, so no headless evidence was produced. The Governor decides over committed evidence only. On evidence-requiring diffs in enforce mode that is an honest FAIL — the policy working, not a bug. Fund the evidence phase, commit session evidence, or set mode: warn in .project-ai/GOVERNOR_POLICY.yaml while adopting."',
        '',
      ],
    },
    {
      name: 'Govern and post the decision (completes the PR check run)',
      shell: 'bash',
      env: { ES_LICENSE_KEY: '${{ inputs.license-key }}', PR_NUMBER: '${{ github.event.number }}', BASE_REF: '${{ github.base_ref }}' },
      run: ['enterprise-skills govern --post --pr "$PR_NUMBER" --base "origin/$BASE_REF"'],
    },
    {
      name: 'Fail the job when the evidence phase failed',
      if: "${{ steps.claude-code.outcome == 'failure' || steps.agents.outcome == 'failure' || steps.release-readiness.outcome == 'failure' }}",
      shell: 'bash',
      run: [
        'echo "::error title=Evidence phase failed::An evidence-phase step failed (its log is above). The govern step ran over the evidence that exists; this step fails the job so the failure stays visible."',
        'exit 1',
        '',
      ],
    },
  ];
}

// Input names, in order, with their required flags and defaults.
export function expectedInputs(cliPin = CLI_PIN.version) {
  return [
    ['license-key', { required: 'true' }],
    ['anthropic-api-key', { required: 'false', default: '' }],
    ['evidence', { required: 'false', default: 'agents' }],
    ['cli-version', { required: 'false', default: cliPin }],
  ];
}

export function identityLines(pin = CLI_PIN) {
  return [`Verified artifact: enterprise-skills@${pin.version}`, `dist.integrity ${pin.integrity}`, `gitHead ${pin.gitHead}`];
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (obj, keys) => {
  const got = Object.keys(obj);
  return got.length === keys.length && keys.every((k) => got.includes(k));
};

function compareStep(step, want, label, failures) {
  if (!isMap(step)) {
    failures.push(`[${label}] is not a mapping`);
    return;
  }
  for (const k of Object.keys(step)) if (!(k in want)) failures.push(`[${label}] key "${k}" is not expected`);
  for (const k of Object.keys(want)) if (!(k in step)) failures.push(`[${label}] key "${k}" is missing`);
  for (const k of ['name', 'id', 'if', 'shell', 'continue-on-error']) {
    if (k in want && k in step && step[k] !== want[k]) {
      failures.push(`[${label}] ${k} is ${JSON.stringify(step[k])}, expected ${JSON.stringify(want[k])}`);
    }
  }
  if ('env' in want && 'env' in step) {
    if (!isMap(step.env)) {
      failures.push(`[${label}] env is not a mapping`);
    } else {
      for (const n of Object.keys(step.env)) {
        if (!(n in want.env)) failures.push(`[${label}] env name ${n} is not expected`);
        else if (step.env[n] !== want.env[n]) failures.push(`[${label}] env ${n} is ${JSON.stringify(step.env[n])}, expected ${JSON.stringify(want.env[n])}`);
      }
      for (const n of Object.keys(want.env)) if (!(n in step.env)) failures.push(`[${label}] env name ${n} is missing`);
    }
  }
  if ('run' in step) {
    if (typeof step.run !== 'string') {
      failures.push(`[${label}] run is not a string`);
    } else {
      const got = step.run.split('\n');
      for (let i = 0; i < Math.max(got.length, want.run.length); i += 1) {
        if (got[i] !== want.run[i]) {
          if (i >= want.run.length) failures.push(`[${label}] run line ${i + 1} is not expected: ${JSON.stringify(got[i])}`);
          else if (i >= got.length) failures.push(`[${label}] run line ${i + 1} is missing: ${JSON.stringify(want.run[i])}`);
          else failures.push(`[${label}] run line ${i + 1} is not expected: ${JSON.stringify(got[i])}, expected ${JSON.stringify(want.run[i])}`);
        }
      }
    }
  }
}

// Decisions on the real parser's reading. `doc` is the real parser's Document
// (for the comment beside the cli-version default).
export function checkAction(value, doc, opts = {}) {
  const pins = { cli: opts.cliPin ?? CLI_PIN, claudeCode: opts.claudeCodePin ?? CLAUDE_CODE_PIN, minVersion: opts.minVersion ?? MIN_VERSION };
  const failures = [];
  if (!isMap(value)) return ['[action.yml] is not a mapping'];
  if (!sameKeys(value, ['name', 'description', 'branding', 'inputs', 'runs'])) {
    failures.push(`[top level] keys are ${JSON.stringify(Object.keys(value))}, expected name, description, branding, inputs, runs`);
  }
  if (value.name !== 'Enterprise Skills Release Governor') failures.push(`[top level] name is ${JSON.stringify(value.name)}`);
  if (typeof value.description !== 'string' || value.description === '') failures.push('[top level] description is missing');
  if (!isMap(value.branding) || !sameKeys(value.branding, ['icon', 'color']) || value.branding.icon !== 'shield' || value.branding.color !== 'blue') {
    failures.push('[top level] branding is not icon "shield", color "blue"');
  }

  // Inputs: names, order, required flags, defaults; descriptions present.
  const inputs = value.inputs;
  const want = expectedInputs(pins.cli.version);
  if (!isMap(inputs)) {
    failures.push('[inputs] missing or not a mapping');
  } else {
    const names = Object.keys(inputs);
    if (names.join('\0') !== want.map(([n]) => n).join('\0')) failures.push(`[inputs] names are ${JSON.stringify(names)}, expected ${JSON.stringify(want.map(([n]) => n))}`);
    for (const [n, w] of want) {
      const inp = inputs[n];
      if (!isMap(inp)) continue;
      const keys = ['description', 'required', ...('default' in w ? ['default'] : [])];
      if (!sameKeys(inp, keys)) failures.push(`[input ${n}] keys are ${JSON.stringify(Object.keys(inp))}, expected ${JSON.stringify(keys)}`);
      if (typeof inp.description !== 'string' || inp.description === '') failures.push(`[input ${n}] description is missing`);
      if (inp.required !== w.required) failures.push(`[input ${n}] required is ${JSON.stringify(inp.required)}, expected ${JSON.stringify(w.required)}`);
      if ('default' in w && inp.default !== w.default) failures.push(`[input ${n}] default is ${JSON.stringify(inp.default)}, expected ${JSON.stringify(w.default)}`);
    }
  }

  // The pinned CLI: identity beside the default, and the gate's minimum.
  const cvNode = doc?.getIn?.(['inputs', 'cli-version'], true);
  const defPair = cvNode?.items?.find((p) => p?.key?.value === 'default');
  const comment = (defPair?.key?.commentBefore ?? '').split('\n').map((l) => l.trim());
  for (const line of identityLines(pins.cli)) {
    if (!comment.includes(line)) failures.push(`[input cli-version] the comment beside the default does not record "${line}"`);
  }
  const pinParts = pins.cli.version.split('.').map(Number);
  let cmp = 0;
  for (let i = 0; i < 3 && cmp === 0; i += 1) cmp = Math.sign(pins.minVersion[i] - pinParts[i]);
  if (cmp > 0) failures.push(`[gate] minimum ${pins.minVersion.join('.')} exceeds the pinned CLI ${pins.cli.version}`);

  // runs: composite, the expected steps in order, nothing else.
  const runs = value.runs;
  if (!isMap(runs) || !sameKeys(runs, ['using', 'steps']) || runs.using !== 'composite') {
    failures.push(`[runs] must be exactly using: "composite" and steps (got keys ${JSON.stringify(isMap(runs) ? Object.keys(runs) : runs)})`);
  }
  const steps = isMap(runs) ? runs.steps : undefined;
  if (!Array.isArray(steps)) return [...failures, '[runs] steps is missing or not a list'];
  const wantSteps = expectedSteps(pins.claudeCode);
  for (let i = 0; i < Math.max(steps.length, wantSteps.length); i += 1) {
    const step = steps[i];
    const ws = wantSteps[i];
    const label = `step ${i + 1}: ${isMap(step) && typeof step.name === 'string' ? step.name : ws ? ws.name : '?'}`;
    if (!ws) {
      failures.push(`[${label}] is not expected`);
      continue;
    }
    if (step === undefined) {
      failures.push(`[step ${i + 1}: ${ws.name}] is missing`);
      continue;
    }
    if (isMap(step) && step.name !== ws.name) {
      failures.push(`[${label}] is not the expected step here (expected "${ws.name}")`);
    }
    compareStep(step, ws, label, failures);
  }
  return failures;
}

// The whole check of one action.yml text. Returns the failures.
export function checkActionText(text, opts = {}) {
  const failures = [];
  const real = opts.parser ?? loadRealParser();
  if (real.error) return [`[parser] the real YAML parser is unavailable (${real.error}) — cannot check (fail closed)`];
  let own;
  try {
    own = parseYamlSubset(text);
  } catch (err) {
    failures.push(`[parser] the guard's own reading fails: ${err instanceof Error ? err.message : String(err)}`);
  }
  let r;
  try {
    r = readReal(text, real.yaml);
  } catch (err) {
    return [...failures, `[parser] yaml ${real.version} cannot read it: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (r.problems.length) return [...failures, ...r.problems.map((p) => `[parser] yaml ${real.version}: ${p}`)];
  if (own !== undefined) {
    for (const d of differences(own, r.value)) failures.push(`[parser] the guard's reading differs from yaml ${real.version} at ${d}`);
  }
  failures.push(...checkAction(r.value, r.doc, opts));
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
  const path = process.argv[2] ?? join(REPO, 'action.yml');
  let failures;
  try {
    failures = checkActionText(readFileSync(path, 'utf8'));
  } catch (err) {
    failures = [`[read] ${err instanceof Error ? err.message : String(err)}`];
  }
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(failures.length === 0 ? `action check: ${path} OK` : `action check: ${path} — ${failures.length} failure(s)`);
  const gateOk = gateSelfTest();
  const cliVersionOk = cliVersionSelfTest();
  process.exitCode = failures.length === 0 && gateOk && cliVersionOk ? 0 : 1;
}
