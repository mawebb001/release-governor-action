// The one pinned enterprise-skills release and the one pinned claude-code
// release, written once. action.yml must match them exactly
// (scripts/check-action.mjs) and the registry must confirm them
// (scripts/check-registry.mjs). Either moves only by an owner release decision.

export const CLI_PIN = Object.freeze({
  version: '4.31.0',
  integrity: 'sha512-pQSF/GFSJLXgh7ZR4dOJVfUtlYhPubrq8oQ39Bsn/79MxLmxmb51NpMaGzDhCd4nYoCL/fXYPgk2aXHJ/NBXXQ==',
  gitHead: '3be3bb1cd4542462bd4f965c98c71696fe75edf7',
});

export const CLAUDE_CODE_PIN = '2.1.285';
