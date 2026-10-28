/**
 * Docs topic synonyms: a name an agent is likely to ask for, mapped to the
 * canonical topic that answers it. The single source for MCP `docs({ topic })`
 * (platform-help.ts) and for the public /docs-manifest.json `aliases` map that
 * the signed-out `somewhere docs <topic>` resolves through
 * (scripts/generate-docs.mjs, tsk_51155c7d). Keys are lowercase; a reader
 * matches the raw lowercase name, then the name with every non-alphanumeric run
 * turned into `-`.
 */
export const DOCS_TOPIC_SYNONYMS: Readonly<Record<string, string>> = {
  schema: 'declared-data',
  'built-in': 'handled-for-you',
  'what-somewhere-handles': 'handled-for-you',
  'platform-responsibilities': 'handled-for-you',
  groups: 'sw.groups',
  'app-groups': 'sw.groups',
  files: 'sw.fs',
  origins: 'cors',
  'allowed-origins': 'cors',
  'cross-origin': 'cors',
  'origin-not-allowed': 'cors',
  drafts: 'dev-environments',
  draft: 'dev-environments',
  'dev-env': 'dev-environments',
  'dev-prod': 'dev-environments',
  preview: 'dev-environments',
  staging: 'dev-environments',
  promote: 'dev-environments',
  rollback: 'dev-environments',
  fetch: 'sw.fetch',
  http: 'sw.fetch',
  outbound: 'sw.fetch',
  'outbound-http': 'sw.fetch',
  'outbound-request': 'sw.fetch',
  'outbound-http-request': 'sw.fetch',
  // Queue sends are retired; the retirement note lives in sw.jobs.
  'sw.queue': 'sw.jobs',
  queue: 'sw.jobs',
  // The starter's schema-changes skill name; the schema-file contract lives in sw.db.
  'schema-changes': 'sw.db',
  'schema-change': 'sw.db',
};
