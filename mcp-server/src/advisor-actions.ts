import type { JsonSchemaProperty, ToolDefinition } from './tool-registry/types';
import type { AdvisorAction } from './advisor-recipe-types';
import { checkAdvisorCommands } from './advisor-command-contract';

/** The registry's small schema vocabulary, not a universal JSON Schema validator. */
function matches(value: unknown, schema: JsonSchemaProperty, depth = 0): boolean {
  if (depth > 12) return false;
  if (schema.oneOf && schema.oneOf.filter(item => matches(value, item, depth + 1)).length !== 1) return false;
  if (schema.enum && !schema.enum.includes(value as string)) return false;
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (types.length && !types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type)) return false;
  if (Array.isArray(value)) return (!schema.maxItems || value.length <= schema.maxItems) &&
    (!schema.items || value.every(item => matches(item, schema.items!, depth + 1)));
  if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    if (schema.required?.some(key => !Object.hasOwn(fields, key))) return false;
    return Object.entries(fields).every(([key, item]) => schema.properties?.[key]
      ? matches(item, schema.properties[key], depth + 1)
      : schema.additionalProperties === false ? false
      : typeof schema.additionalProperties === 'object' ? matches(item, schema.additionalProperties, depth + 1) : true);
  }
  return true;
}
export function quoteAdvisorShell(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
/** Inline code that a value's own backticks cannot close early. */
function inlineCode(value: string): string {
  const ticks = '`'.repeat(Math.max(0, ...[...value.matchAll(/`+/g)].map(run => run[0].length)) + 1);
  const pad = ticks.length > 1 ? ' ' : '';
  return ticks + pad + value + pad + ticks;
}
/** `described` is a non-executable step for a project-bound tool when no
 * project is authorized: never a command, never a project ID. */
export function renderAdvisorAction(action: AdvisorAction, options: {
  tools: readonly Pick<ToolDefinition, 'name' | 'inputSchema'>[]; projectId: string | null; caller: string; browserVerification: boolean;
}): { text: string } | { described: string } | { reason: string } {
  const definition = options.tools.find(tool => tool.name === action.tool);
  if (!definition) return { reason: 'tool is not advertised to this caller' };
  const args = { ...action.arguments };
  const projectBound = 'project_id' in definition.inputSchema.properties;
  if (projectBound) {
    // Without an authorized project any supplied ID, null included, is refused;
    // with one, only that exact ID is accepted. A refused ID is never echoed.
    if ('project_id' in args && (!options.projectId || args.project_id !== options.projectId)) return { reason: 'authorized project identity is missing or mismatched' };
    if (options.projectId) args.project_id = options.projectId;
  }
  const described = projectBound && !options.projectId;
  if (action.tool === 'auth_verify_magic_link') {
    if (options.browserVerification) return { reason: 'CLI redemption consumes the link needed by the browser recipe; use a separate fresh link for an API test' };
    // Model-generated arguments cannot establish where a token came from.
    // Explain the supported API without reproducing a credential in advice.
    const text = 'For an isolated API test, `auth_verify_magic_link` takes `project_id` and a fresh `token`. Supply the token privately when calling the tool; it is consumed once. Use a separate fresh link for browser verification.';
    return described ? { described: text } : { text };
  }
  if (described) {
    // The project is supplied later by the caller's own authorized tool call.
    if (!matches({ ...args, project_id: 'project' }, definition.inputSchema)) return { reason: 'arguments do not match the advertised tool schema' };
    return { described: Object.keys(args).length ? `\`${action.tool}\` with ${inlineCode(JSON.stringify(args))}` : `\`${action.tool}\`` };
  }
  if (!matches(args, definition.inputSchema)) return { reason: 'arguments do not match the advertised tool schema' };
  const command = `somewhere call ${action.tool} ${quoteAdvisorShell(JSON.stringify(args))}`;
  const checked = checkAdvisorCommands(`\`\`\`sh\n${command}\n\`\`\``, options.tools);
  if (!checked.ok || checked.unvalidated) return { reason: 'complete valid tool arguments are required' };
  return { text: options.caller === 'connector'
    ? `Tool: ${action.tool}\n\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``
    : `\`\`\`sh\n${command}\n\`\`\`` };
}
