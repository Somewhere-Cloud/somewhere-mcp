import type { ToolExecutionRuntime, ToolSpec, ToolUpstreamResult } from '../types';
import { InternalApiPathError, internalApiUrl } from '../../internal-api-url';

interface OperatorRuntime extends ToolExecutionRuntime {
  env: { API_SERVICE: Fetcher; SOMEWHERE_TECH_ADMIN_KEY?: string };
  authHeader: string;
}

async function callOperator(runtime: OperatorRuntime, method: string, path: string, body?: unknown): Promise<ToolUpstreamResult> {
  const bridgeKey = runtime.env.SOMEWHERE_TECH_ADMIN_KEY;
  if (!bridgeKey) return { status: 503, data: { ok: false, error: 'OPERATOR_BRIDGE_UNAVAILABLE' } };
  let url: string;
  try { url = internalApiUrl(`/v1/sys/operator/${path}`, '/v1/sys/operator/'); }
  catch (err) { if (err instanceof InternalApiPathError) return { status: 400, data: { ok: false, error: err.code } }; throw err; }
  const response = await runtime.env.API_SERVICE.fetch(new Request(url, {
    method,
    headers: { 'X-Admin-Key': bridgeKey, Authorization: runtime.authHeader, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, data: await response.json() };
}

export const ADMIN_PROJECT_TOOL_SPECS: readonly ToolSpec<OperatorRuntime>[] = [{
  definition: {
    name: 'admin_project_inspect',
    description: 'Inspect a project as an operator without impersonation. Returns owner, display name, slug, public address, active served release, working source version and resource counts. Shows existing transfer and release-repair paths. Does not read customer data or secrets; an apparently empty project is not automatically disposable. Use debug_project first to resolve an email or address to an exact project ID.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string', description: 'Exact project ID.' } }, required: ['project_id'] },
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  group: 'admin', core: false, visibility: 'admin', paid: false, surfaces: ['full'],
  execute: (runtime, args) => callOperator(runtime, 'GET', `projects/${encodeURIComponent(String(args.project_id))}`),
}, {
  definition: {
    name: 'admin_project_rename',
    description: 'Change a project display name as an operator, with an atomic audit record and exact owner/name/release preconditions from admin_project_inspect. Preserves project ID, files, releases, slug and public address. This is not public-address renaming. Provide a support/task reason; stale state fails without modification.',
    inputSchema: { type: 'object', properties: {
      project_id: { type: 'string' }, name: { type: 'string' }, reason: { type: 'string' },
      expected_owner_id: { type: 'string' }, expected_name: { type: 'string' }, expected_release_id: { type: ['string', 'null'] },
    }, required: ['project_id', 'name', 'reason', 'expected_owner_id', 'expected_name', 'expected_release_id'] },
  },
  annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false },
  group: 'admin', core: false, visibility: 'admin', paid: false, surfaces: ['full'],
  execute: (runtime, args) => {
    const { project_id, ...body } = args;
    return callOperator(runtime, 'POST', `projects/${encodeURIComponent(String(project_id))}/name`, body);
  },
}, {
  definition: {
    name: 'admin_project_source_export',
    description: 'Export the exact served raw source, source assets and function source for operator support, with required audit and inspected owner/release preconditions. Does not copy database rows, uploaded files, environment values, auth identities, email, jobs or domains. Nothing executes. Source can itself contain production addresses or credentials; review before running it. Requires a non-null immutable served release; no fallback.',
    inputSchema: { type: 'object', properties: {
      project_id: { type: 'string' }, reason: { type: 'string' },
      expected_owner_id: { type: 'string' }, expected_release_id: { type: 'string' },
    }, required: ['project_id', 'reason', 'expected_owner_id', 'expected_release_id'] },
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  group: 'admin', core: false, visibility: 'admin', paid: false, surfaces: ['full'],
  execute: (runtime, args) => {
    const { project_id, ...body } = args;
    return callOperator(runtime, 'POST', `projects/${encodeURIComponent(String(project_id))}/source`, body);
  },
}, {
  definition: {
    name: 'admin_support_copy_create',
    description: 'Create an operator-owned dormant source copy of the exact inspected customer served release. Copies raw source, assets and function source only. No runtime, address, database, auth identities, environment values, uploaded files, email or jobs are copied or created. Maximum snapshot 4 MiB. Use read/edit/check and explicitly reviewed apply; this is not a runnable sandbox.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, expected_owner_id: { type: 'string' }, expected_release_id: { type: 'string' }, reason: { type: 'string' } }, required: ['project_id', 'expected_owner_id', 'expected_release_id', 'reason'] },
  },
  annotations: { readOnlyHint: false, idempotentHint: false },
  group: 'admin', core: false, visibility: 'admin', paid: false, surfaces: ['full'],
  execute: (runtime, args) => { const { project_id, ...body } = args; return callOperator(runtime, 'POST', `projects/${encodeURIComponent(String(project_id))}/support-copies`, body); },
}, {
  definition: {
    name: 'admin_support_copy_read',
    description: 'Read your dormant support copy, complete source, revision/hash, file changes against the captured base and apply receipts. Review this exact snapshot before explicit apply. Copy source is inert; platform environment values and database data are excluded, but credentials embedded in source can be present.',
    inputSchema: { type: 'object', properties: { copy_id: { type: 'string' } }, required: ['copy_id'] },
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  group: 'admin', core: false, visibility: 'admin', paid: false, surfaces: ['full'],
  execute: (runtime, args) => callOperator(runtime, 'GET', `support-copies/${encodeURIComponent(String(args.copy_id))}`),
}, {
  definition: {
    name: 'admin_support_copy_edit',
    description: 'Replace your dormant support copy with a complete raw-source snapshot under an expected revision. Omitted files/functions are removed from this copy. Clears its compile check. Does not deploy, invoke code or edit the customer project. A pending apply locks source edits until its exact receipt settles.',
    inputSchema: { type: 'object', properties: {
      copy_id: { type: 'string' }, expected_revision: { type: 'integer' }, reason: { type: 'string' },
      source: { type: 'object', properties: {
        files: { type: 'object', additionalProperties: { type: 'string' } },
        binaryFiles: { type: 'object', additionalProperties: { type: 'string' } },
        functions: { type: 'object', additionalProperties: { type: 'string' } },
      }, required: ['files', 'binaryFiles', 'functions'], additionalProperties: false },
    }, required: ['copy_id', 'expected_revision', 'source', 'reason'] },
  },
  annotations: { readOnlyHint: false, idempotentHint: false },
  group: 'admin', core: false, visibility: 'admin', paid: false, surfaces: ['full'],
  execute: (runtime, args) => { const { copy_id, ...body } = args; return callOperator(runtime, 'POST', `support-copies/${encodeURIComponent(String(copy_id))}/source`, body); },
}, {
  definition: {
    name: 'admin_support_copy_check',
    description: 'Compile your exact support source revision through the normal compiler, with no environment values, deployment or function invocation. Records a check for that source hash; successful compilation is not runtime testing. Source edits invalidate it. Runtime isolation testing is outside this tool.',
    inputSchema: { type: 'object', properties: { copy_id: { type: 'string' }, expected_revision: { type: 'integer' } }, required: ['copy_id', 'expected_revision'] },
  },
  annotations: { readOnlyHint: false, idempotentHint: true },
  group: 'admin', core: false, visibility: 'admin', paid: false, surfaces: ['full'],
  execute: (runtime, args) => { const { copy_id, ...body } = args; return callOperator(runtime, 'POST', `support-copies/${encodeURIComponent(String(copy_id))}/check`, body); },
}, {
  definition: {
    name: 'admin_support_copy_apply',
    description: 'Explicitly publish your reviewed and compile-checked support source back to the customer project, with exact copy revision/hash, owner and base served release preconditions. This changes production source and reuses the customer existing configuration. A concurrent customer release or changed operator/owner proof fails closed. No data/environment/auth copying. Supply a unique operation_id; after an unknown receipt retry that exact operation and snapshot. Inspect receipts before starting another apply.',
    inputSchema: { type: 'object', properties: {
      copy_id: { type: 'string' }, operation_id: { type: 'string', description: 'Unique letters/digits/underscore/hyphen receipt ID, maximum 80 characters.' }, reason: { type: 'string' },
      expected_revision: { type: 'integer' }, reviewed_source_hash: { type: 'string', description: 'Exact 64-character lowercase source hash from support-copy read.' },
      expected_owner_id: { type: 'string' }, expected_release_id: { type: 'string' },
    }, required: ['copy_id', 'operation_id', 'reason', 'expected_revision', 'reviewed_source_hash', 'expected_owner_id', 'expected_release_id'] },
  },
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
  group: 'admin', core: false, visibility: 'admin', paid: false, surfaces: ['full'],
  execute: (runtime, args) => { const { copy_id, ...body } = args; return callOperator(runtime, 'POST', `support-copies/${encodeURIComponent(String(copy_id))}/apply`, body); },
}];
