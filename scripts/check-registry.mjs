#!/usr/bin/env node
// Confirms the pins in scripts/pins.mjs against the npm registry: the pinned
// enterprise-skills version has the recorded dist.integrity and gitHead, and
// the pinned @anthropic-ai/claude-code version exists. A registry that cannot
// be read fails: unverifiable is not negative.
//
// Usage: node scripts/check-registry.mjs   (network; run by action-check)

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLAUDE_CODE_PIN, CLI_PIN } from './pins.mjs';

export const REGISTRY = 'https://registry.npmjs.org';

async function getVersion(fetchImpl, name, version) {
  const url = `${REGISTRY}/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    return { error: `${url} could not be read (${err instanceof Error ? err.message : String(err)})` };
  }
  if (res.status === 404) return { missing: true, error: `${name}@${version} does not exist (${url}: 404)` };
  if (res.status !== 200) return { error: `${url} answered ${res.status}` };
  try {
    return { meta: await res.json() };
  } catch (err) {
    return { error: `${url} did not return JSON (${err instanceof Error ? err.message : String(err)})` };
  }
}

// Returns the failures.
export async function checkRegistry({ fetchImpl = fetch, cli = CLI_PIN, claudeCode = CLAUDE_CODE_PIN } = {}) {
  const failures = [];
  const es = await getVersion(fetchImpl, 'enterprise-skills', cli.version);
  if (es.error) {
    failures.push(`[registry] ${es.error}`);
  } else {
    if (es.meta?.version !== cli.version) failures.push(`[registry] enterprise-skills@${cli.version} answered version ${JSON.stringify(es.meta?.version)}`);
    if (es.meta?.dist?.integrity !== cli.integrity) failures.push(`[registry] enterprise-skills@${cli.version} dist.integrity is ${JSON.stringify(es.meta?.dist?.integrity)}, pinned ${cli.integrity}`);
    if (es.meta?.gitHead !== cli.gitHead) failures.push(`[registry] enterprise-skills@${cli.version} gitHead is ${JSON.stringify(es.meta?.gitHead)}, pinned ${cli.gitHead}`);
  }
  const cc = await getVersion(fetchImpl, '@anthropic-ai/claude-code', claudeCode);
  if (cc.error) failures.push(`[registry] ${cc.error}`);
  else if (cc.meta?.version !== claudeCode) failures.push(`[registry] @anthropic-ai/claude-code@${claudeCode} answered version ${JSON.stringify(cc.meta?.version)}`);
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
  const failures = await checkRegistry();
  for (const f of failures) console.log(`FAIL ${f}`);
  if (failures.length === 0) {
    console.log(`registry check OK: enterprise-skills@${CLI_PIN.version} integrity ${CLI_PIN.integrity} gitHead ${CLI_PIN.gitHead}; @anthropic-ai/claude-code@${CLAUDE_CODE_PIN} exists`);
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}
