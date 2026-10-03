#!/usr/bin/env node
// Validates the cli-version input before it reaches npm. It arrives through
// the step's env (ES_CLI_VERSION), never through ${{ }} inside run:, and only
// an npm version or semver range is accepted:
//   - an exact version: 4.31.0, 4.31.0-rc.1, 4.31.0+build.1
//   - a range built from comparators: ^4.31.0, ~4.31.0, >=4.31.0 <5.0.0,
//     4.31.x, 4.x, 4, *, 4.31.0 - 4.32.0, and sets joined by ||
// Anything else (a dist-tag such as latest, an npm: alias, a URL, a git or
// file spec, a leading v, empty) fails the step, which fails the job.
//
// `node scripts/cli-version.mjs --self-test` runs CLI_VERSION_TABLE.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NUM = '(?:0|[1-9]\\d*)';
const IDENT = '[0-9A-Za-z-]+';
const PRE = `(?:-${IDENT}(?:\\.${IDENT})*)?`;
const BUILD = `(?:\\+${IDENT}(?:\\.${IDENT})*)?`;
const X = '(?:[xX*]|' + NUM + ')';
const EXACT = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}${PRE}${BUILD}$`);
// A partial version: *, 4, 4.x, 4.31, 4.31.x, or a full version.
const PARTIAL = new RegExp(`^(?:[xX*]|${NUM}(?:\\.${X}(?:\\.${X}${PRE}${BUILD})?)?)$`);
const COMPARATOR = new RegExp(`^(?:\\^|~|>=|<=|>|<|=)?(${PARTIAL.source.slice(1, -1)})$`);
const MAX_LENGTH = 128;

export function validateCliVersion(value) {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, why: 'it is empty' };
  if (value.length > MAX_LENGTH) return { ok: false, why: `it is longer than ${MAX_LENGTH} characters` };
  if (value !== value.trim()) return { ok: false, why: 'it has leading or trailing whitespace' };
  if (EXACT.test(value)) return { ok: true, kind: 'version' };
  for (const set of value.split('||')) {
    const t = set.trim();
    if (t === '') return { ok: false, why: 'it has an empty || alternative' };
    const hyphen = /^(\S+) - (\S+)$/.exec(t);
    if (hyphen) {
      if (!PARTIAL.test(hyphen[1]) || !PARTIAL.test(hyphen[2])) return { ok: false, why: `"${t}" is not a hyphen range of versions` };
      continue;
    }
    for (const c of t.split(/ +/)) {
      if (!COMPARATOR.test(c)) return { ok: false, why: `"${c}" is not a version or a range comparator` };
    }
  }
  return { ok: true, kind: 'range' };
}

export const CLI_VERSION_TABLE = [
  ['4.31.0', true],
  ['4.31.0-rc.1', true],
  ['4.31.0+build.1', true],
  ['^4.31.0', true],
  ['~4.31.0', true],
  ['>=4.31.0 <5.0.0', true],
  ['4.31.x', true],
  ['4.x', true],
  ['4', true],
  ['*', true],
  ['4.31.0 - 4.32.0', true],
  ['4.30.2 || ^4.31.0', true],
  ['', false],
  ['latest', false],
  ['next', false],
  ['npm:enterprise-skills@4.31.0', false],
  ['v4.31.0', false],
  [' 4.31.0', false],
  ['4.31.0 ', false],
  ['4.31.0"; touch /tmp/x; echo "', false],
  ['$(id)', false],
  ['`id`', false],
  ['4.31.0 && id', false],
  ['4.31.0;id', false],
  ['4.31.0\nid', false],
  ['https://example.com/enterprise-skills.tgz', false],
  ['git+https://example.com/x.git', false],
  ['file:../enterprise-skills', false],
  ['./enterprise-skills', false],
  ['github:owner/repo', false],
  ['04.31.0', false],
  ['4.31.0 ||', false],
  ['>= 4.31.0', false],
  ['1'.repeat(129), false],
];

export function selfTest(log = console.log) {
  let failures = 0;
  for (const [value, ok] of CLI_VERSION_TABLE) {
    const got = validateCliVersion(value);
    const pass = got.ok === ok;
    if (!pass) failures += 1;
    log(`${pass ? 'ok  ' : 'FAIL'} ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)} -> ${got.ok ? `accepted (${got.kind})` : `rejected (${got.why})`}`);
  }
  log(`cli-version table: ${CLI_VERSION_TABLE.length - failures}/${CLI_VERSION_TABLE.length} rows as expected`);
  return failures === 0;
}

// Workflow-command escaping for an annotation message.
function escapeData(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
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
    const value = process.env.ES_CLI_VERSION;
    const got = validateCliVersion(value);
    if (got.ok) {
      console.log(`cli-version ${value} accepted (${got.kind}).`);
    } else {
      const shown = typeof value === 'string' ? JSON.stringify(value.slice(0, 60)) : '(unset)';
      console.log(
        `::error title=cli-version rejected::cli-version ${escapeData(shown)} is not an npm version or semver range (${escapeData(got.why)}), so nothing was installed and the job stops here. ` +
          'Fix: set cli-version to a version such as 4.31.0 or a range such as ^4.31.0.',
      );
      process.exitCode = 1;
    }
  }
}
