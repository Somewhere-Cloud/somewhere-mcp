/**
 * Editorial read-first sections for docs summaries (docs-view.ts). Key = a
 * canonical topic id; value = exact `## ` / `### ` heading lines, rendered
 * verbatim in the summary in this order, ahead of the section index. Pick the
 * sections an agent needs before writing code: signatures, exact result
 * shapes, and the failure modes that silently break apps. Every heading must
 * exist, and every summary must fit DOCS_SUMMARY_MAX_CHARS
 * (mcp-server/scripts/test-docs-view.mjs). A topic without an entry
 * summarizes as its opening prose plus the index.
 */
export const DOCS_SUMMARY_LEADS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  changes: ['## How we handle breaking changes'],
  'declared-data': ['## Data'],
  'sw.db': ['## Start with declared tables', '### Builder verbs and where-shapes'],
  'sw.groups': ['## Share data with a group'],
  'getting-started': ['## Start an app'],
  'architecture-patterns': ['## Start with managed access'],
  'postgres': ['## Connect and attach', '## Separate application credentials'],
  'sw.auth': ['## Auth — sign-in is already part of your app'],
  'sw.env': ['## Env vars and secrets'],
  'auth-client': ['## 1. The backend — one line', '## 2. The page — the SDK client', '## Response shapes — one contract'],
  tasks: ['## Current state and waiting'],
  functions: ['## Functions'],
  'declared-files': [
    '## Declare a collection and use it',
    '## Who can retrieve a file',
    '## Files outside a collection',
    '## More on files',
  ],
  'sw.email': [
    '## Send from an authorized action',
    '## Test it with the test inbox',
    '## Read the result',
    '## More on email',
  ],
  'sw.ai': [
    '## Call a model',
    "## Search a user's documents",
    '## Which search to use',
    '## More on AI and search',
  ],
  search: [
    '## Managed file search — point it at a file (inside functions)',
  ],
  'sw.jobs': [
    '## Choose the kind of work',
    '## Run a job and report its status',
    '## Job limits',
    '## Run on a schedule',
    '## More on jobs and schedules',
  ],
  cron: [
    '## Recipe — hourly cleanup of stale rows',
    '## When a schedule is the wrong tool',
  ],
  payments: [
    '## Sell an upgrade in test mode',
    '## Take real payments',
    '## More on payments',
  ],
  deploy: [
    '## Deploy and check the result',
    "## Before you change a project you didn't just deploy",
    '## Connect a domain',
    '## More on deploy and domains',
  ],
  browser: [
    '## Check one real journey, including a refusal',
    '## Read what happened',
    '## Count what users do',
    '## More on testing and observing',
  ],
});

/**
 * The editorial shape of every canonical topic (docs/internal/DOCS-TOPIC-TEMPLATE.md).
 * - recipe: a whole job (recipes and job guides), outside the core reading
 *   path. The first call returns the complete topic (docs-view.ts) unless the
 *   caller asks for `detail: "summary"` or a section.
 * - reference: core and other primitive reference. The first call is the
 *   bounded summary; its read-first lead (DOCS_SUMMARY_LEADS) is a real quick start.
 * - comparison: positioning against another platform.
 * - generated: produced from source by scripts/generate-docs.mjs.
 * - changelog: dated entries; the only kind that may carry dated banners.
 * Every topic needs an entry: a new topic without one fails
 * scripts/check-docs-shape.mjs and mcp-server/scripts/test-docs-view.mjs.
 */
export type DocsTopicKind = 'recipe' | 'reference' | 'comparison' | 'generated' | 'changelog';

export const DOCS_TOPIC_KINDS: Readonly<Record<string, DocsTopicKind>> = Object.freeze({
  'api-surface': 'generated',
  'declared-data': 'reference',
  sdk: 'reference',
  sdks: 'reference',
  cli: 'reference',
  'verify-before-deploy': 'reference',
  'local-dev': 'reference',
  'migration-supabase': 'reference',
  'sw.db': 'reference',
  'sw.groups': 'reference',
  speed: 'reference',
  postgres: 'reference',
  'sw.fetch': 'reference',
  'typed-functions': 'reference',
  functions: 'reference',
  'declared-files': 'reference',
  'sw.fs': 'reference',
  'file-tools': 'reference',
  'sw.auth': 'reference',
  'auth-client': 'reference',
  projects: 'reference',
  'project-groups': 'reference',
  search: 'reference',
  render: 'reference',
  browser: 'reference',
  github: 'reference',
  analytics: 'reference',
  inbox: 'reference',
  'sw.ai': 'reference',
  'sw.agent': 'reference',
  'sw.email': 'reference',
  'sw.env': 'reference',
  'sw.jobs': 'reference',
  'sw.logs': 'reference',
  'dev-environments': 'reference',
  deploy: 'reference',
  'deploy-intelligence': 'reference',
  inspect: 'reference',
  domains: 'reference',
  'domain-ownership': 'reference',
  live: 'reference',
  cron: 'reference',
  'live-data': 'reference',
  smoke: 'reference',
  tasks: 'reference',
  'sw.rateLimit': 'reference',
  pricing: 'reference',
  'sw.billing': 'reference',
  billing: 'reference',
  changes: 'changelog',
  feedback: 'reference',
  calendar: 'reference',
  payments: 'reference',
  'handled-for-you': 'reference',
  guarantees: 'reference',
  'getting-started': 'reference',
  setup: 'reference',
  'common-mistakes': 'reference',
  'architecture-patterns': 'reference',
  limits: 'reference',
  troubleshooting: 'reference',
  'sw.web': 'reference',
  'sw.push': 'reference',
  'sw.notifications': 'reference',
  'sw.image': 'reference',
  'recipe-ai-agent': 'recipe',
  'recipe-booking': 'recipe',
  'recipe-ecommerce': 'recipe',
  'recipe-multi-chat': 'recipe',
  'sw.endpoint': 'reference',
  'recipe-signed-in-app': 'recipe',
  'recipe-login': 'recipe',
  'recipe-file-uploads': 'recipe',
  'recipe-email': 'recipe',
  'recipe-push-notifications': 'recipe',
  'recipe-background-jobs': 'recipe',
  'recipe-ai-features': 'recipe',
  'recipe-ai-receipts': 'recipe',
  'recipe-seo': 'recipe',
  'recipe-csv-import': 'recipe',
  'recipe-pdfs': 'recipe',
  'recipe-paid-api': 'recipe',
  'recipe-import-app': 'recipe',
  'recipe-escalation': 'recipe',
  'database-engine': 'reference',
  'sql-compatibility': 'reference',
  cors: 'reference',
  'security-model': 'reference',
  'pricing-comparison': 'comparison',
  portability: 'reference',
  'vs-supabase': 'comparison',
  'vs-vercel': 'comparison',
  'design-system': 'reference',
});
