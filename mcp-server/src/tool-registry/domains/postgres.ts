import { defineDomainToolSpecs, type JsonSchemaProperty } from '../types';

/**
 * The attached Postgres database's control plane: one read tool and one tool
 * per kind of write, so each carries annotations true of every call it can
 * make. Arguments are forwarded exactly; /v1/postgres/* enforces target,
 * owner role, size, checksum and ledger rules. SQL arrives in a structured
 * field — never a local path — and is sent as written.
 */

const common = {
  group: 'db',
  core: false,
  visibility: 'authenticated',
  paid: false,
  surfaces: ['full'],
} as const;

const PROJECT_ID: JsonSchemaProperty = {
  type: 'string',
  description: 'Project ID (UUID), subdomain, or slug — resolved server-side.',
};

const TARGET: JsonSchemaProperty = {
  type: 'string',
  enum: ['production', 'preview'],
  description: 'Which database. Always explicit; there is no default. preview requires a created preview database and never falls back to production.',
};

const STATUS_VIEWS = ['attachment', 'migrations', 'preview'] as const;

export const POSTGRES_TOOL_SPECS = defineDomainToolSpecs([
  {
    ...common,
    definition: {
    name: 'postgres_status',
    description: `Read the project's attached Postgres database without changing it. Never returns a key or connection string.

- \`view: "attachment"\` (default): connection state plus \`credentials\` — \`{ stored, separated, migration_role, runtime_role, login_verified_at, privileges_verified_at, setup_role, setup_started_at, revision, generation, verified_now: false }\`. Timestamps record the last successful check; they do not prove the current database state.
- \`view: "migrations"\` + \`target\`: the migration ledger, \`{ target, migrations: [{ name, checksum, state: "applying" | "applied" | "failed", applied_at }] }\`. \`applying\` means the outcome is unresolved and blocks later migrations.
- \`view: "preview"\`: the project's preview database, or an error when none has been created.

\`\`\`json
{ "project_id": "my-app", "view": "migrations", "target": "production" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        view: { type: 'string', enum: [...STATUS_VIEWS], description: 'What to read; attachment by default.' },
        target: { ...TARGET, description: 'Required with view "migrations": production or preview.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Read Postgres attachment, migrations or preview', readOnlyHint: true, idempotentHint: true },
    execute: (runtime, args) => {
      const view = args.view ?? 'attachment';
      const query = new URLSearchParams({ project_id: String(args.project_id ?? '') });
      if (view === 'attachment') return runtime.callApi('GET', `/v1/postgres/status?${query}`);
      if (view === 'preview') return runtime.callApi('GET', `/v1/postgres/preview?${query}`);
      if (view === 'migrations') {
        if (args.target !== undefined) query.set('target', String(args.target));
        return runtime.callApi('GET', `/v1/postgres/migrations/status?${query}`);
      }
      return Promise.resolve({
        status: 400,
        data: { ok: false, error: 'VALIDATION_ERROR', message: `view must be one of ${STATUS_VIEWS.join(', ')}.` },
      });
    },
  },
  {
    ...common,
    definition: {
    name: 'postgres_migrate',
    description: `Apply ONE native PostgreSQL migration file to the attached database. Owner only; requires separated credentials (\`postgres_credentials_separate\`).

The SQL is run exactly as given — never split or rewritten — inside a transaction the platform opens, so it must not contain BEGIN, COMMIT or ROLLBACK. Maximum 1 MB. The ledger stores a SHA-256 checksum per name:
- same name + same SQL already applied → returns the recorded receipt, runs nothing;
- same name + different SQL already applied → refused (\`POSTGRES_MIGRATION_CHANGED\`), so changed SQL takes a new name;
- a failed file was rolled back and may be corrected and applied again;
- an unresolved outcome (\`POSTGRES_MIGRATION_UNCERTAIN\`) blocks every later migration until the database is inspected.

Files apply one call at a time in version order, stopping at the first error. Migrations never run on deploy. Returns \`{ target, migration: { name, checksum, state, applied_at } }\`.

\`\`\`json
{ "project_id": "my-app", "target": "preview", "name": "0002_add_orders", "sql": "CREATE TABLE orders (id bigint PRIMARY KEY);" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        target: TARGET,
        name: { type: 'string', description: 'Ledger name, 1–160 letters, numbers, dots, underscores or hyphens (e.g. "0002_add_orders").' },
        sql: { type: 'string', description: 'The complete file contents. Not a path.' },
      },
      required: ['project_id', 'target', 'name', 'sql'],
    },
  },
    annotations: { title: 'Apply a Postgres migration', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    execute: (runtime, args) => runtime.callApi('POST', '/v1/postgres/migrations/apply', {
      project_id: args.project_id,
      target: args.target,
      name: args.name,
      sql: args.sql,
    }),
  },
  {
    ...common,
    definition: {
    name: 'postgres_preview',
    description: `Create, reset or delete the project's one preview database. Owner only. Production is never changed.

- \`create\`: copies production data into an isolated branch in the customer's own provider account. A preview never falls back to production. Published app draft execution does not yet bind this database; creating the branch alone does not make it available to published previews.
- \`reset\`: replaces the preview's data with a fresh copy of production.
- \`delete\`: removes the preview database.

Reset and delete lose the preview's data and affect an already-deployed preview at once, until it is redeployed. \`postgres_status\` \`view: "preview"\` returns the current state.

\`\`\`json
{ "project_id": "my-app", "action": "create" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        action: { type: 'string', enum: ['create', 'reset', 'delete'], description: 'create, reset or delete.' },
      },
      required: ['project_id', 'action'],
    },
  },
    annotations: { title: 'Create, reset or delete the Postgres preview', readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    execute: (runtime, args) => runtime.callApi('POST', '/v1/postgres/preview', {
      project_id: args.project_id,
      action: args.action,
    }),
  },
  {
    ...common,
    definition: {
    name: 'postgres_credentials_separate',
    description: `Give deployed functions their own limited database role, keeping the attached role for migrations only. Owner only; required before \`postgres_migrate\`. Calling it again after setup rechecks the stored runtime login and privileges.

The status timestamps record the last successful check, not continuous verification. Takes effect on the next deploy: releases already deployed keep their old credentials until redeployed or until the credential is rotated in the provider account. An interrupted setup remains pending for owner recovery and does not start a second role. Never returns a key or connection string.

\`\`\`json
{ "project_id": "my-app" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: { project_id: PROJECT_ID },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Separate Postgres app and migration credentials', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execute: (runtime, args) => runtime.callApi('POST', '/v1/postgres/credentials/separate', {
      project_id: args.project_id,
    }),
  },
  {
    ...common,
    definition: {
    name: 'postgres_copy',
    description: `Copy the project's Somewhere database into a NEW private schema of its attached Postgres database (a database attached or created through the connected provider account). Owner only; requires separated credentials (\`postgres_credentials_separate\`). The Somewhere database and the running app are not changed, and nothing is switched over.

Faithful copies only: values are exact, and keys, unique rules, foreign keys, NOT NULL, defaults and identity sequences are recreated. A CHECK rule, trigger, view, non-binary collation, unsupported default, or a reference to a table that is not copied (app users, platform tables) refuses the copy with the exact item and what to change — nothing is silently dropped. App users, sessions and other platform tables are never copied; access rules are listed, not translated.

- \`action: "prepare"\` (writes nothing): reads one snapshot and returns the plan — tables with the destination type per column, keys, foreign keys, \`fidelity\`, \`excluded\`, \`access_rules_not_copied\`, \`performance_indexes_not_recreated\` (speed-only indexes), \`refusals\` and \`limits\`. Any refusal → 422 \`POSTGRES_COPY_UNSUPPORTED\`. Optional \`schema\`: the new schema name.
- \`action: "copy"\` + \`plan\` (the \`plan\` object prepare returned): one transaction creates the schema, tables and rows, recreates keys and identity sequences, verifies every table's row count and value digest inside the destination, and stores a receipt. Refused with \`POSTGRES_COPY_PLAN_STALE\` if the attachment, its credentials or the source schema changed since prepare. Retrying a committed plan returns its receipt (\`already_copied: true\`). \`POSTGRES_COPY_OUTCOME_UNCERTAIN\` means the connection dropped while committing; status is the first read.
- \`action: "status"\` + \`schema\` + \`copy_id\`: \`committed\` (with receipt), \`in_progress\`, \`not_found\` or \`conflict\`.

No other role (including the app's runtime role) is granted access to the new schema; additional access requires an explicit grant. Limits: 64 tables, 20,000 rows, 4 MiB of values, 60 seconds.

\`\`\`json
{ "project_id": "my-app", "action": "prepare" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: PROJECT_ID,
        action: { type: 'string', enum: ['prepare', 'copy', 'status'], description: 'prepare, copy or status.' },
        schema: { type: 'string', description: 'prepare: optional new schema name (lower-case letters, digits, underscores). status: the plan\'s schema.' },
        plan: {
          type: 'object',
          description: 'copy: the plan object returned by prepare, unchanged.',
          properties: {
            copy_id: { type: 'string' }, schema: { type: 'string' },
            destination_fingerprint: { type: 'string' }, source_fingerprint: { type: 'string' },
          },
        },
        copy_id: { type: 'string', description: 'status: the plan\'s copy_id.' },
      },
      required: ['project_id', 'action'],
    },
  },
    annotations: { title: 'Copy the database into the attached Postgres', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execute: (runtime, args) => {
      if (args.action === 'prepare') {
        return runtime.callApi('POST', '/v1/postgres/copy/prepare', {
          project_id: args.project_id, ...(args.schema !== undefined ? { schema: args.schema } : {}),
        });
      }
      if (args.action === 'copy') return runtime.callApi('POST', '/v1/postgres/copy', { project_id: args.project_id, plan: args.plan });
      if (args.action === 'status') {
        const query = new URLSearchParams({
          project_id: String(args.project_id ?? ''), schema: String(args.schema ?? ''), copy_id: String(args.copy_id ?? ''),
        });
        return runtime.callApi('GET', `/v1/postgres/copy/status?${query}`);
      }
      return Promise.resolve({
        status: 400,
        data: { ok: false, error: 'VALIDATION_ERROR', message: 'action must be one of prepare, copy, status.' },
      });
    },
  },
] as const);
