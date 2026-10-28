import type { ToolDefinition } from './tool-registry/types';
import type { AdvisorComposition, AdvisorComponent, AdvisorRecipe } from './advisor-recipe-types';
import { checkoutFulfillmentRecipe } from './advisor-checkout-recipe';
import { magicLinkBrowserRecipe } from './advisor-magic-link-recipe';
import { checkAdvisorCommands } from './advisor-command-contract';
import { renderAdvisorAction } from './advisor-actions';
export { quoteAdvisorShell } from './advisor-actions';

export const ADVISOR_COMPOSITION_PROMPT = `Return one JSON object with prose, components, recipes, actions.
prose: useful concise explanation in the requested format, including general answers outside recipes.
components: [{decision,status,explanation}], one entry per requested decision; status is provided, needs_input or unavailable. This is your coverage receipt, not proof of universal completeness.
recipes: at most two selections. {kind:"checkout_fulfillment",table:"payment_requests"} renders a proposed new serverOnly schema and a fixed Stripe handler binding server-recorded session, amount, currency, livemode and account. Select checkout_fulfillment only for an explicitly requested separate Stripe-native destination. Ordinary ad-hoc fulfillment uses the platform lifecycle payment.completed event described in the payments guide, including shared-account test mode. This optional recipe does not create Checkout or perform external fulfillment. {kind:"magic_link_browser"} renders the fixed emailed landing/browser POST/cookie/navigation flow. For diagnosis of an existing working authentication/session flow, preserve its callback and cookies; do not select a replacement magic_link_browser recipe merely because login is mentioned. Select the appropriate recipe when those executable flows are requested; do not rewrite their security code in prose. Recipe table names are proposals, never inferred existing tables. Checkout expectations must be stored by trusted server creation, never browser/event/model defaults. Missing amount blocks Checkout creation only.
actions: [{tool,arguments}], exact caller-advertised tool name and JSON object. Do not assemble shell commands. Omit project_id: the renderer binds the authorized project; never substitute a different project. Missing required inputs belong in components, not invented placeholders. CLI auth_verify_magic_link consumes a token and is an alternative to the browser recipe, never a preceding step. Never include credentials or magic-link tokens.
Keep general explanations useful; an unavailable recipe/action must not erase independent decisions. No tool round follows this response.`;

// Non-strict schema permits the advertised tools' heterogeneous JSON arguments;
// local parsing, tool identity and project binding remain authoritative.
export const ADVISOR_COMPOSITION_FORMAT = {
  type: 'json_schema', name: 'advisor_composition', strict: false,
  schema: { type: 'object', required: ['prose', 'components', 'recipes', 'actions'], additionalProperties: false,
    properties: {
      prose: { type: 'string' },
      components: { type: 'array', maxItems: 16, items: { type: 'object', required: ['decision', 'status', 'explanation'], additionalProperties: false,
        properties: { decision: { type: 'string' }, status: { enum: ['provided', 'needs_input', 'unavailable'] }, explanation: { type: 'string' } } } },
      recipes: { type: 'array', maxItems: 2, items: { anyOf: [
        { type: 'object', required: ['kind', 'table'], additionalProperties: false, properties: { kind: { const: 'checkout_fulfillment' }, table: { type: 'string' } } },
        { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { const: 'magic_link_browser' } } },
      ] } },
      actions: { type: 'array', maxItems: 12, items: { type: 'object', required: ['tool', 'arguments'], additionalProperties: false,
        properties: { tool: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } } } },
    } },
} as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function string(value: unknown, cap: number): value is string { return typeof value === 'string' && value.length <= cap; }
export function parseAdvisorComposition(text: string): AdvisorComposition | null {
  if (new TextEncoder().encode(text).byteLength > 100_000) return null;
  let input: Record<string, unknown> | null;
  try { input = object(JSON.parse(text)); } catch { return null; }
  if (!input || !string(input.prose, 20_000) || !Array.isArray(input.components) || input.components.length > 16 ||
      !Array.isArray(input.recipes) || input.recipes.length > 2 || !Array.isArray(input.actions) || input.actions.length > 12) return null;
  const components: AdvisorComponent[] = [];
  for (const value of input.components) {
    const c = object(value);
    if (!c || !string(c.decision, 200) || !string(c.explanation, 4000) ||
      (c.status !== 'provided' && c.status !== 'needs_input' && c.status !== 'unavailable')) return null;
    components.push({ decision: c.decision, status: c.status, explanation: c.explanation });
  }
  const recipes: AdvisorRecipe[] = [];
  for (const value of input.recipes) {
    const r = object(value);
    if (r?.kind === 'magic_link_browser' && Object.keys(r).length === 1) recipes.push({ kind: r.kind });
    else if (r?.kind === 'checkout_fulfillment' && string(r.table, 48) && /^[a-z][a-z0-9_]*$/.test(r.table) && Object.keys(r).length === 2) recipes.push({ kind: r.kind, table: r.table });
    else return null;
  }
  if (new Set(recipes.map(r => r.kind)).size !== recipes.length) return null;
  const actions = [];
  for (const value of input.actions) {
    const a = object(value), args = object(a?.arguments);
    if (!a || !string(a.tool, 100) || !args || JSON.stringify(args).length > 40_000) return null;
    actions.push({ tool: a.tool, arguments: args });
  }
  return { prose: input.prose, components, recipes, actions };
}

/** The same request-intent decision is retained without storing the question. */
export function advisorAuthFlowRequested(question?: string): boolean {
  const existingSessionDiagnosis = question !== undefined
    && /\b(?:sessions?|cookies?|signed[ -]in|logged[ -]in)\b/i.test(question)
    && /\b(?:why|diagnos\w*|debug\w*|persist\w*|between|lost|disappear\w*|fail\w*)\b/i.test(question);
  const explicitCallbackImplementation = question !== undefined
    && /\b(?:implement|build|write|generate|provide|show|add|wire|create)\b/i.test(question)
    && /magic[ -]?links?|signInWithOtp|verifyOtp|callback/i.test(question);
  return !existingSessionDiagnosis || explicitCallbackImplementation;
}

/** Advice only: renders supplied JSON, never invokes a tool or a shell. */
export function renderAdvisorComposition(composition: AdvisorComposition, options: {
  tools: readonly Pick<ToolDefinition, 'name' | 'inputSchema'>[];
  projectId: string | null;
  caller: string;
  question?: string;
  authFlowRequested?: boolean;
}): { text: string; omissions: string[] } {
  const parts: string[] = [];
  const omissions: string[] = [];
  const addProse = (text: string) => {
    const check = checkAdvisorCommands(text, options.tools, true);
    if (!check.ok) omissions.push('Executable CLI commands must be supplied as structured actions; this fragment was withheld.');
    else parts.push(text);
  };
  addProse(composition.prose);
  const normalizedProse = composition.prose.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const component of composition.components) {
    // Suppress only exact provided explanations already present in prose.
    // Missing-input/unavailable status remains explicit even when prose repeats it.
    if (component.status === 'provided' && normalizedProse.includes(component.explanation.toLowerCase().replace(/\s+/g, ' ').trim())) continue;
    addProse(`- ${component.decision}: ${component.explanation}${component.status === 'provided' ? '' : ` (${component.status.replaceAll('_', ' ')})`}`);
  }
  const authFlowRequested = options.authFlowRequested ?? advisorAuthFlowRequested(options.question);
  const eligibleRecipes = composition.recipes.filter(recipe => recipe.kind !== 'magic_link_browser' || authFlowRequested);
  if (eligibleRecipes.length !== composition.recipes.length) omissions.push('The replacement magic-link browser flow was withheld: this question did not request its implementation.');
  for (const recipe of eligibleRecipes) {
    const rendered = recipe.kind === 'checkout_fulfillment' ? checkoutFulfillmentRecipe(recipe.table) : magicLinkBrowserRecipe();
    parts.push(rendered.explanation);
    for (const file of rendered.files) parts.push(`\`${file.path}\`\n\n\`\`\`ts\n${file.source}\`\`\``);
  }
  const runnable: { tool: string; text: string }[] = [];
  const described: string[] = [];
  for (const action of composition.actions) {
    const rendered = renderAdvisorAction(action, { ...options, browserVerification: eligibleRecipes.some(recipe => recipe.kind === 'magic_link_browser') });
    if ('reason' in rendered) omissions.push(`${action.tool}: ${rendered.reason}`);
    else if ('described' in rendered) described.push(rendered.described);
    else runnable.push({ tool: action.tool, text: rendered.text });
  }
  if (described.length) {
    // Project-free steps, then project creation, then the steps that need the project.
    const create = runnable.filter(step => step.tool === 'project_create');
    parts.push(...runnable.filter(step => step.tool !== 'project_create').map(step => step.text), ...create.map(step => step.text));
    if (!create.length) parts.push('These steps need a project: create one with `project_create` (or use an existing project) first.');
    parts.push('Once the project exists, make these calls with its `project_id` (the id `project_create` returns, or your existing project\'s id):\n' + described.map(step => `- ${step}`).join('\n'));
  } else parts.push(...runnable.map(step => step.text));
  if (omissions.length) parts.push('Withheld guidance:\n' + omissions.map(item => `- ${item}`).join('\n'));
  return { text: parts.filter(Boolean).join('\n\n'), omissions };
}

/** Only a successfully read project row binds commands; a requested ID alone is not authority. */
export function advisorAuthorizedProjectId(context: string | null): string | null {
  if (!context) return null;
  try {
    const snapshot = object(JSON.parse(context.slice(context.lastIndexOf('\n') + 1)));
    const project = object(object(snapshot?.facts)?.project);
    const id = object(object(project?.fields)?.id);
    return project?.status === 'available' && id?.status === 'known' && typeof id.value === 'string' &&
      id.value === snapshot?.project_id ? id.value : null;
  } catch { return null; }
}
