import { TASK_TYPE_GUIDANCE } from '../../task-types';
import { defineDomainToolSpecs, type JsonSchemaProperty } from '../types';

const READ_PROPERTIES: Record<string, JsonSchemaProperty> = {
  view: { type: 'string', enum: ['current', 'history', 'field', 'relationships', 'full'], description: 'Task view; current by default. relationships pages linked task references and replacement pointers without comments or document bodies. full is explicitly unbounded.' },
  kind: { type: 'string', enum: ['comments', 'activity', 'revisions', 'reviews'], description: 'History kind; defaults to comments. revisions holds saved guidance text; reviews holds explicit account review records.' },
  field: { type: 'string', description: 'Top-level field to expand with view=field.' },
  event_id: { type: 'string', description: 'History event ID for a field expansion; kind is repeated.' },
  cursor: { type: 'string', description: 'Opaque next_cursor from the previous page, valid only with the original filters and view. It cannot be combined with offset.' },
  limit: { type: 'number', description: 'History or relationship rows per page (default 5, cap 20); response budget can return fewer.' },
  offset: { type: 'number', description: 'Fresh row offset, or UTF-16 character offset for field expansion. Cursor provides checked continuation when available.' },
};

export function taskQueryParams(args: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams();
  for (const key of ['project_id', 'waiting_on', 'status', 'type', 'include_archived', 'include_superseded', 'review_for_closure', 'assignee', 'area', 'parent_id', 'q', 'active', 'stale', 'stale_days', 'sort', 'detail', 'limit', 'offset', 'view', 'kind', 'field', 'event_id', 'cursor']) {
    if (args[key] !== undefined) query.set(key, String(args[key]));
  }
  return query;
}

export const TASK_READ_TOOL_SPECS = defineDomainToolSpecs([
  {
    definition: {
      name: 'tasks_overview',
      description: 'Start with a bounded project brief: vision, SOPs, recorded priorities, work underway, blockers and completed work with release links. Uses existing records, no model ranking. Two records per section; a focused section returns up to five. Counts, ordering and continuation are explicit. Reviewed guidance is distinguished from newer drafts. Excerpts are partial; tasks_get has the source and linked guidance. Closed tasks without a release link are not presented as shipped.',
      inputSchema: { type: 'object', properties: {
        project_id: { type: 'string', description: 'Project ID or slug; default/spine selects the shared organization board.' },
        area: { type: 'string', description: 'Optional exact area across all sections. Guidance without that area is not included; task links carry cross-area guidance.' },
        section: { type: 'string', enum: ['direction', 'practice', 'priorities', 'active', 'blocked', 'shipped'], description: 'Expand one section or continue its page.' },
        cursor: { type: 'string', description: 'Opaque page.next_cursor, valid only with the same project_id, area and section; each call returns one page.' },
      }, required: ['project_id'] },
    },
    annotations: { title: 'Read project direction and work', readOnlyHint: true, idempotentHint: true },
    group: 'tasks', core: true, coreRank: 113, visibility: 'authenticated', paid: false,
    surfaces: ['full', 'chatgpt', 'connector'], protocol: { surfaceAnnotations: { chatgpt: { destructiveHint: false, openWorldHint: false } }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const q = new URLSearchParams();
      for (const key of ['project_id', 'area', 'section', 'cursor']) if (args[key] !== undefined) q.set(key, String(args[key]));
      return runtime.callApi('GET', `/v1/tasks/overview?${q}`);
    },
  },
  {
    definition: {
    name: 'tasks_list',
    description: 'Read tasks. view=board returns a board scan: 50 concise current-state rows by default, no descriptions/comments. Other reads default to a small task page (10, bounded response). The same filters with page.next_cursor as cursor continue; pages are not concatenated automatically. Task ordering is live keyset: edits to sort/filter fields may skip or repeat rows; a new read starts a fresh queue. Fields in omitted are partial; tasks_get view=field expands them. detail=full explicitly permits unbounded descriptions. task_id reads one current task; tasks_get covers history/field options. review_for_closure reports its source candidate limit. tasks_overview covers project direction and work; tasks_summary gives counts and memory_search durable guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        ...READ_PROPERTIES,
        view: { type: 'string', enum: ['current', 'board', 'full', 'history', 'field', 'relationships'], description: 'board returns only current-state rows, default 50/max100, under 32,000 data characters; unfinished tasks by default, waiting/needs_review/blocked rows first. Recorded release tags flag closure review. Explicit status/sort override those defaults. current preserves detailed excerpts; full is unbounded.' },
        waiting_on: { type: 'string', enum: ['human', 'product_decision', 'external', 'none'], description: 'Filter explicit waiting signals; requires view=board. none selects tasks with no recorded wait.' },
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug, resolved server-side. 'default' or 'spine' targets the organization's shared atomic task board used by the platform dogfood and resolution-note workflow." },
        task_id: { type: 'string', description: 'Optional task ID beginning with tsk_ for a bounded current-state read instead of a list. Comments and activity are retrieved separately through tasks_get. A short prefix resolves when unique; an ambiguous prefix returns candidates.' },
        status: { type: 'string', enum: ['backlog', 'open', 'in_progress', 'blocked', 'needs_review', 'done', 'archived'] },
        type: { type: 'string', description: 'Filter by one type or a comma-separated list. Custom labels are supported.\n' + TASK_TYPE_GUIDANCE },
        include_superseded: { type: 'boolean', description: 'Default true for task history/search; false excludes records replaced by a superseded_by pointer or supersedes relationship. Memory recall defaults to false.' },
        include_archived: { type: 'boolean', description: 'Default false. Only affects results when a type filter is present: archived rows are hidden unless this is true.' },
        review_for_closure: { type: 'boolean', description: 'Surface-only review queue returning report rows whose parent task carries a shipped_in version, annotated with resolved_by_version. It does not change status and ignores the other filters.' },
        assignee: { type: 'string', description: 'Filter to tasks assigned to this person.' },
        area: { type: 'string', description: 'Filter to tasks in this subsystem.' },
        parent_id: { type: 'string', description: 'Filter to sub-tasks of this parent; the string "null" selects only top-level tasks without a parent.' },
        q: { type: 'string', description: 'Case-insensitive text search over title and description.' },
        active: { type: 'boolean', description: 'Shortcut for "what is on my plate" — status open + in_progress. Ignored if an explicit status is given.' },
        stale: { type: 'boolean', description: 'Only in_progress tasks untouched for more than stale_days.' },
        stale_days: { type: 'number', description: 'Staleness threshold in days (default 7). Also controls the per-row `stale` flag.' },
        sort: { type: 'string', enum: ['priority', 'updated', 'created'], description: 'Sort order. Default (omitted) is the smart order: open before done, by priority, newest first.' },
        detail: { type: 'string', enum: ['full'], description: 'The "full" value includes complete descriptions instead of compact excerpts.' },
        limit: { type: 'number', description: 'Max rows to return (default 10). Compact pages return at most 20 rows and detail=full up to 500; view=board defaults to 50, max 100. The payload budget may return fewer; page.limit is the effective cap.' },
        offset: { type: 'number', description: 'Optional fresh offset traversal. Cursor provides checked continuation; the two fields cannot be combined.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'List tasks, or read one', readOnlyHint: true, idempotentHint: true },
    group: 'tasks',
    core: true,
    coreRank: 40,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Read a bounded page of project tasks. The same filters with next_cursor continue the list. Omitted fields can be retrieved separately; sorting and filters reflect live edits." }, surfaceAnnotations: { chatgpt: { destructiveHint: false, openWorldHint: false }, connector: {"title":"Tasks List","readOnlyHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const q = taskQueryParams(args);
      const id = typeof args.task_id === 'string' && args.task_id ? args.task_id : null;
      if (id && args.detail === 'full') q.set('view', 'full');
      if (id) return runtime.callApi('GET', `/v1/tasks/${encodeURIComponent(id)}?${q}`);
      return runtime.callApi('GET', `/v1/tasks?${q}`);
    },
  },
  {
    definition: {
    name: 'tasks_get',
    description: 'Read current task state by default, bounded to about 12,000 JSON characters, with history counts and expansion instructions. view=relationships pages explicit and legacy links, current target state and supersession pointers; task_id leads to the target. Missing targets and partial pointers are explicit. view=history pages comments, activity, guidance revisions or review records (kind), newest first with stable ID ties; default 5. view=field expands an omitted top-level field as bounded JSON-text chunks; a history field also takes kind and event_id. The same read options with next_cursor as cursor continue. History uses a keyset and initial rowid/time upper bounds; appends do not restart it, deletions disappear, and edited bodies are live. Membership is not frozen: deletion followed by a same-timestamp insert can admit a new event on a later page. Field chunks reject changed content with CURSOR_STALE; a new field read returns the current content. view=full explicitly requests the unbounded compatibility response with all comments/activity ordered oldest first (created_at ASC, id ASC). Prefix task IDs work when unique.',
    inputSchema: {
      type: 'object',
      properties: {
        ...READ_PROPERTIES,
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug, resolved server-side. 'default' or 'spine' targets the organization's shared atomic task board." },
        task_id: { type: 'string', description: 'Task ID (starts with tsk_). Prefixes are accepted when unique inside the project.' },
      },
      required: ['project_id', 'task_id'],
    },
  },
    annotations: { title: 'Read one task', readOnlyHint: true, idempotentHint: true },
    group: 'tasks',
    core: true,
    coreRank: 39,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Read one task’s current state, a page of history, or a selected field. Continuation and omitted content are explicit; full view requests unbounded history." }, surfaceAnnotations: { chatgpt: { destructiveHint: false, openWorldHint: false }, connector: {"title":"Tasks Get","readOnlyHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      if (typeof args.task_id !== 'string' || !args.task_id) {
        return { status: 400, data: { ok: false, error: 'VALIDATION_ERROR', message: 'tasks_get requires task_id. Use tasks_list to discover IDs.' } };
      }
      return runtime.callApi('GET', `/v1/tasks/${encodeURIComponent(args.task_id)}?${taskQueryParams(args)}`);
    },
  },
]);
