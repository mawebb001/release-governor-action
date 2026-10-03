#!/usr/bin/env node
// License-file check, run after the license compatibility step and before the
// evidence phase. enterprise-skills 4.31.0 (and the @enterprise-skills/core
// 4.10.1 it pins) reads a license from one file:
//   (USERPROFILE ?? HOME ?? "")/.enterprise-skills/license.json
// and passes HOME to the agent, so an agent can read that file whoever put it
// there. This script refuses the evidence phase (clear=false) when that file,
// or the same file under HOME or os.homedir(), exists in any form (a file, a
// directory, a symlink, dangling or not), or when that cannot be determined:
// HOME unset, empty or relative, or a check that fails other than "not found".
// It never deletes or modifies the file, and it never fails the step: a
// refusal skips both evidence steps and the job continues to the govern step.
//
// Writes clear=true|false to $GITHUB_OUTPUT.

import { appendFileSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELATIVE = join('.enterprise-skills', 'license.json');

// { clear, present: [paths], undetermined: [reasons] }
export function checkLicenseFiles(env = process.env, home = homedir, lstat = lstatSync) {
  const undetermined = [];
  const bases = [];
  const cliBase = env.USERPROFILE ?? env.HOME ?? '';
  for (const [label, base] of [
    ['USERPROFILE ?? HOME (where the CLI reads)', cliBase],
    ['HOME', env.HOME],
    ['os.homedir()', (() => {
      try {
        return home();
      } catch {
        return undefined;
      }
    })()],
  ]) {
    if (typeof base !== 'string' || base === '' || !isAbsolute(base)) {
      undetermined.push(`${label} is ${base === undefined ? 'unset' : JSON.stringify(base)}, not an absolute directory`);
      continue;
    }
    if (!bases.includes(base)) bases.push(base);
  }
  const present = [];
  for (const base of bases) {
    const path = join(base, RELATIVE);
    try {
      lstat(path);
      present.push(path);
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : undefined;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') undetermined.push(`checking ${path} failed (${code ?? String(err)})`);
    }
  }
  return { clear: present.length === 0 && undetermined.length === 0, present, undetermined };
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
  const r = checkLicenseFiles();
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `clear=${r.clear}\n`);
  if (r.clear) {
    console.log(`No license file under the runner's home (${join('~', RELATIVE)}): the evidence phase may run.`);
  } else {
    const what = r.present.length
      ? `A license file exists at ${r.present.join(' and ')}, which enterprise-skills reads and an agent started by the evidence phase could read. This step did not change it.`
      : `Whether a license file exists under the runner's home cannot be determined: ${r.undetermined.join('; ')}.`;
    const fix = r.present.length
      ? 'Fix: remove whatever writes that file before this action runs (or run this action in a job without one); pass the key only through the license-key input.'
      : 'Fix: run this action with HOME set to the runner user\'s home directory.';
    console.log(
      `::error title=Evidence phase refused::${escapeData(what)} Both evidence steps are skipped and the job continues to the govern step. ${escapeData(fix)}`,
    );
  }
}
