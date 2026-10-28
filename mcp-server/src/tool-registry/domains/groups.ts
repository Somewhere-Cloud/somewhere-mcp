import { defineDomainToolSpecs } from '../types';

const common = {
  group: 'groups',
  core: false,
  visibility: 'authenticated',
  paid: false,
  surfaces: ['full'],
} as const;

export const GROUP_TOOL_SPECS = defineDomainToolSpecs([
  {
    ...common,
    definition: {
    name: 'group_create',
    description: `Create, organize, groups — create a project group to organize related projects under one group with shared members and one shared design theme; the caller becomes the group owner. Owners and editors can manage membership, invites and the shared theme, and delete the group. Project ownership and billing stay with each project’s owner.

Returns the new group: \`{ id, owner_id, name, description, created_at, updated_at, role: "owner", project_count: 0 }\`.

**Example:**

\`\`\`json
{ "name": "marketing-apps", "description": "All public-facing marketing projects" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name' },
        description: { type: 'string', description: 'Optional description for the group' },
      },
      required: ['name'],
    },
  },
    annotations: { title: 'Create a project group', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    execute: (runtime, args) => runtime.callApi('POST', '/v1/groups', { name: args.name, description: args.description }),
  },
  {
    ...common,
    definition: {
    name: 'group_list',
    description: `List, groups, organize — list groups you own or belong to. Returns \`{ groups: [{ id, owner_id, name, description, created_at, updated_at, role, project_count }] }\` where role is YOUR role in each group (owner / editor).`,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
    annotations: { title: 'List project groups', readOnlyHint: true, idempotentHint: true },
    execute: (runtime) => runtime.callApi('GET', '/v1/groups'),
  },
  {
    ...common,
    definition: {
    name: 'group_get',
    description: `Group detail, inspect group — get full detail for a group: the group fields plus \`projects: [{ id, name, subdomain, status }]\`, \`members: [{ user_id, role }]\`, and \`design_tokens\` (the shared theme object, \`{}\` until one is saved). 403 FORBIDDEN if you are not a member. Owners and editors can manage membership, invites and the shared theme, and delete the group. Project ownership and billing stay with each project’s owner.

**Example:**

\`\`\`json
{ "group_id": "grp_abc123" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Group ID (UUID) from group_create / group_list.' },
      },
      required: ['group_id'],
    },
  },
    annotations: { title: 'Group detail (projects + members + theme)', readOnlyHint: true, idempotentHint: true },
    execute: (runtime, args) => runtime.callApi('GET', `/v1/groups/${encodeURIComponent(String(args.group_id))}`),
  },
  {
    ...common,
    definition: {
    name: 'group_delete',
    description: `Delete a group — available to any group member. Removes the group, its membership and theme; projects in the group are DETACHED, never deleted. Errors: FORBIDDEN (403, no group membership). Owners and editors can manage membership, invites and the shared theme, and delete the group. Project ownership and billing stay with each project’s owner.

**Example:**

\`\`\`json
{ "group_id": "grp_abc123" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Group ID (UUID) from group_create / group_list.' },
      },
      required: ['group_id'],
    },
  },
    annotations: { title: 'Delete a group (projects detached, never deleted)', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    execute: (runtime, args) => runtime.callApi('DELETE', `/v1/groups/${encodeURIComponent(String(args.group_id))}`),
  },
  {
    ...common,
    definition: {
    name: 'group_add_project',
    description: `Add project to group, organize project — put a project you can edit into a group you belong to. A project belongs to AT MOST ONE group — if it's already in another, returns 409 GROUP_CONFLICT and you must group_remove_project from the old group first. Returns \`{ added: true, group_id, project_id }\`. Owners and editors can manage membership, invites and the shared theme, and delete the group. Project ownership and billing stay with each project’s owner.

**Example:**

\`\`\`json
{ "group_id": "grp_abc123", "project_id": "e4f2a1b0-..." }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Group ID (UUID) from group_create / group_list.' },
        project_id: { type: 'string', description: 'Project UUID, slug or subdomain; the caller must have editor access.' },
      },
      required: ['group_id', 'project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    execute: (runtime, args) => runtime.callApi('POST', `/v1/groups/${encodeURIComponent(String(args.group_id))}/projects`, { project_id: args.project_id }),
  },
  {
    ...common,
    definition: {
    name: 'group_remove_project',
    description: `Remove project from group, detach project — pull a project out of a group. Allowed for any group member or anyone with editor access to the project. 404 NOT_IN_GROUP if the project isn't in that group. Returns \`{ removed: true, group_id, project_id }\`. Owners and editors can manage membership, invites and the shared theme, and delete the group. Project ownership and billing stay with each project’s owner.

**Example:**

\`\`\`json
{ "group_id": "grp_abc123", "project_id": "e4f2a1b0-..." }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Group ID (UUID) from group_create / group_list.' },
        project_id: { type: 'string', description: 'Project UUID from project_list or project_get; detaching takes the UUID.' },
      },
      required: ['group_id', 'project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    execute: (runtime, args) => runtime.callApi('DELETE', `/v1/groups/${encodeURIComponent(String(args.group_id))}/projects/${encodeURIComponent(String(args.project_id))}`),
  },
  {
    ...common,
    definition: {
    name: 'group_invite_create',
    description: `Invite member to group — sending NEW group invitations is unavailable: the call is refused with GONE (410) after the usual VALIDATION_ERROR / FORBIDDEN checks, and nothing is stored or emailed. Existing members and pending invitations are unchanged; group_invite_list, group_invite_revoke and group_invite_accept keep working.

**Example:**

\`\`\`json
{ "group_id": "grp_abc123", "email": "teammate@example.com", "role": "editor" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Group ID (UUID) from group_create / group_list.' },
        email: { type: 'string', description: 'Email address to invite.' },
        role: { type: 'string', enum: ['editor', 'owner'], description: 'Role to grant on acceptance. Defaults to editor.' },
      },
      required: ['group_id', 'email'],
    },
  },
    annotations: { title: 'Invite a member to a group', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    execute: (runtime, args) => runtime.callApi('POST', `/v1/groups/${encodeURIComponent(String(args.group_id))}/invites`, { email: args.email, role: args.role }),
  },
  {
    ...common,
    definition: {
    name: 'group_invite_list',
    description: `List pending group invites, view invites — Any group member can list open invites for a group (not yet accepted, not expired). Returns \`{ invites: [{ email, role, invited_at, expires_at }] }\`.

**Example:**

\`\`\`json
{ "group_id": "grp_abc123" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Group ID (UUID) from group_create / group_list.' },
      },
      required: ['group_id'],
    },
  },
    annotations: { title: 'List pending group invites', readOnlyHint: true, idempotentHint: true },
    execute: (runtime, args) => runtime.callApi('GET', `/v1/groups/${encodeURIComponent(String(args.group_id))}/invites`),
  },
  {
    ...common,
    definition: {
    name: 'group_invite_accept',
    description: `Accept a group invitation, join group — accept a pending invite using the token from the invite email (\`cinv_...\`). The CALLER's signed-in account must be the invited email address, with a verified email. On success the caller becomes a group member with the invited role. Returns \`{ accepted: true, group_id }\`. Errors: EMAIL_NOT_VERIFIED (403, caller's email isn't verified), INVITE_INVALID (404, bad/unknown token), INVITE_USED (409, already accepted), INVITE_EXPIRED (410, past the 7-day window), INVITE_WRONG_ACCOUNT (403, caller is signed in as a different email than was invited), GROUP_NOT_FOUND (404, group was deleted since the invite was sent).

**Example:**

\`\`\`json
{ "group_id": "grp_abc123", "token": "cinv_a1b2c3..." }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Group ID (UUID) from group_create / group_list.' },
        token: { type: 'string', description: 'Invite token from the invite email (starts with cinv_).' },
      },
      required: ['group_id', 'token'],
    },
  },
    annotations: { title: 'Accept a group invitation', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    execute: (runtime, args) => runtime.callApi('POST', `/v1/groups/${encodeURIComponent(String(args.group_id))}/invites/accept`, { token: args.token }),
  },
  {
    ...common,
    definition: {
    name: 'group_invite_revoke',
    description: `Revoke group invite, cancel invite — Any group member can revoke a PENDING invite by email (an accepted invite is membership, not an invite — the members list is in group_get). Returns \`{ revoked: true }\`. 404 NOT_FOUND if there's no pending invite for that email in this group.

**Example:**

\`\`\`json
{ "group_id": "grp_abc123", "email": "teammate@example.com" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: 'Group ID (UUID) from group_create / group_list.' },
        email: { type: 'string', description: 'Invited email address to revoke.' },
      },
      required: ['group_id', 'email'],
    },
  },
    annotations: { title: 'Revoke a pending group invite', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    execute: (runtime, args) => runtime.callApi('DELETE', `/v1/groups/${encodeURIComponent(String(args.group_id))}/invites/${encodeURIComponent(String(args.email))}`),
  },
] as const);
