import { advisorWorkflows } from './advisor-workflows';
import { ADVISOR_TOPIC_DEPENDENCIES } from './platform-help';
import { advisorCapabilityDependencies, advisorSections, type AdvisorKnowledgeSelection } from './advisor-capabilities';
import type { ToolDefinition } from './tool-registry/types';

export type AdvisorTopicDependencies = Readonly<Record<string, readonly { topic: string; heading?: string }[]>>;

interface KnowledgeTool {
  name: string;
  description: string;
  inputSchema?: ToolDefinition['inputSchema'];
}

export interface AdvisorKnowledge {
  text: string;
  topics: string[];
  selection: AdvisorKnowledgeSelection;
}

export function advisorFallbackText(code: string, topics: string[], outcome?: string): string {
  const reason = outcome === 'not_configured' || outcome === 'invalid_parameter'
    ? 'Advisor is misconfigured and cannot answer right now.'
    : code === 'ADVISOR_TIMEOUT'
      ? 'Advisor is slow: this question exceeded its response budget.'
      : code === 'ADVISOR_INCOMPLETE_RESPONSE'
        ? 'Advisor is degraded: the answer was cut short, so it has not been presented as complete.'
        : 'Advisor is unavailable: it did not return a complete answer.';
  const commands = topics.filter((topic) => !['cli', 'guarantees', 'getting-started'].includes(topic)).slice(0, 3);
  return `${reason} Use ${commands.length ? commands.map((topic) => `\`somewhere docs ${topic}\``).join(', ') : '`somewhere docs getting-started`'} for the exact contracts, or read https://somewhere.cloud/docs.txt. These references do not depend on the advisor. Repeating the same request now may hit the same failure.`;
}

const STOP_WORDS = new Set('a an the and or to of in on for with is are as at by be this that it i my your how what exact current give only use using project platform somewhere have from can do does'.split(' '));

function terms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z][a-z0-9_.-]+/g) ?? [])
    .map((word) => word.replace(/[_.-]+$/, ''))
    .filter((word) => !STOP_WORDS.has(word)))];
}

/** Select complete documentation sections, not a prefix of the million-character
 * corpus. No model, vector service, or project data is involved in retrieval. */
export function selectAdvisorKnowledge(
  question: string,
  topics: Record<string, string>,
  tools: KnowledgeTool[],
  options: { caller?: string; dependencies?: AdvisorTopicDependencies } = {},
): AdvisorKnowledge {
  // Native browser history is not a request for the platform automation tool.
  // Keep the original question intact for the answer; only retrieval sees this.
  const retrievalQuestion = question.replace(/\bbrowser\s+(?:history|back button|address bar)\b/gi, '');
  const query = terms(retrievalQuestion);
  const workflows = advisorWorkflows(retrievalQuestion);
  const workflowTopics = new Set(workflows.flatMap(workflow => [...workflow.topics]));
  const aliases: Record<string, RegExp> = {
    cron: /\bcron\b/i,
    payments: /\b(?:payments?|stripe|checkout)\b/i,
    'sw.db': /\b(?:database|sw\.db|serverOnly)\b/i,
    'sw.auth': /\b(?:oauth|signup|login|authentication|magic[ -]links?|verifyOtp|signInWithOtp|setSessionCookies)\b/i,
    'sw.fs': /\b(?:uploads?|files|sw\.fs)\b/i,
    // Question vocabulary that never names these topics: the answer lives
    // there, so a miss sends every model to the same wrong answer.
    'sw.env': /\b(?:env(?:ironment)?[ -]var(?:iable)?s?|env vars?|sw\.env|somewhere env|ENV_VALUES?_TOO_LARGE)\b/i,
    'migration-supabase': /\bsupabase\b/i,
    'dev-environments': /\b(?:previews?|promot(?:e|ed|ing)|staging|(?:real|live|existing) users|already has users)\b/i,
    'verify-before-deploy': /\bdeploy-check\b|\b(?:test|check|try)\b[^.?!]{0,40}\b(?:handlers?|functions?|endpoints?)\b[^.?!]{0,40}\bbefore (?:deploy|going live)/i,
    cli: /\bdeploy-check\b/i,
  };
  const pages = Object.entries(topics).filter(([name]) => name !== 'api-surface');
  const weights = new Map(query.map((word) => [word,
    Math.log(1 + pages.length / (1 + pages.filter(([, body]) => body.toLowerCase().includes(word)).length)),
  ]));
  const score = (text: string): number => {
    const lower = text.toLowerCase();
    return query.reduce((sum, word) => sum + (lower.includes(word) ? weights.get(word)! : 0), 0);
  };
  const namesTopic = (name: string): boolean => (name !== 'browser' || !workflowTopics.has('sw.auth') || /somewhere browser|browser (?:tool|test|verification|automation)|--session/i.test(question)) && (workflowTopics.has(name) || query.includes(name.toLowerCase())
    || Boolean(aliases[name]?.test(question))
    || (name.startsWith('sw.') && query.includes(name.slice(3).toLowerCase()))
    || (name.startsWith('recipe-') && query.includes(name.slice('recipe-'.length))));
  const scoredPages = pages.map(([name, body]) => ({
    name, body, named: namesTopic(name), score: (namesTopic(name) ? 50 : 0) + score(name) * 4 + score(body),
  })).filter((page) => page.score > 0).sort((a, b) => b.score - a.score);
  // Explicit domains establish the scope. A focused question does not need
  // unrelated pages merely because common words gave them a positive score.
  // Broad questions without a named domain retain corpus-wide discovery.
  const focused = scoredPages.filter((page) => page.named);
  const navigationTopics = new Set(['cli', 'sdk', 'sdks', 'guarantees', 'getting-started', 'setup', 'troubleshooting', 'common-mistakes', 'architecture-patterns']);
  const hasDomainFocus = focused.some((page) => !navigationTopics.has(page.name) && !page.name.startsWith('recipe-'));
  const ranked = (hasDomainFocus ? focused : scoredPages).slice(0, 6);
  // An architecture answer needs the setup/readback commands too. Their short
  // descriptions can otherwise lose to large descriptions repeating the query.
  const companions = new Set([
    ...(aliases.payments.test(question) ? ['payments_checkout', 'payments_onboard', 'payments_status'] : []),
    ...(workflowTopics.has('cron') ? ['cron_create', 'cron_list', 'cron_run'] : []),
    ...(aliases['sw.db'].test(question) ? ['db_import', 'db_migrate', 'db_query'] : []),
  ]);
  // Recognized task components are required scope even if optional relevance
  // ranking has filled its six page slots with other named domains.
  const projectOutboundWebhook = /\b(?:project[ -]+outbound|outbound[ -]+webhooks?|webhook[ -]+subscriptions?|webhook_deliveries_list|webhook_delivery_redrive)\b|\/v1\/webhooks\b/i.test(question);
  const requiredTopics = [...new Set([...ranked.map(page => page.name), ...workflowTopics,
    ...(projectOutboundWebhook ? ['projects'] : [])])];
  const dependencies = advisorCapabilityDependencies(question, requiredTopics, topics);
  for (const topic of workflowTopics) {
    if (!topics[topic]) dependencies.selection.omitted.push({ id: `topic:${topic}`, reason: 'unavailable' });
  }
  dependencies.selection.workflows = workflows.map(workflow => workflow.id);
  const selected: Array<{ text: string; ids: string[]; lead?: boolean }> = [{ text: dependencies.text, ids: [...dependencies.selection.selected] }];
  const dependencyTopics = [...requiredTopics];
  const visitedTopics = new Set<string>();
  for (const topic of dependencyTopics) {
    if (visitedTopics.has(topic)) continue;
    visitedTopics.add(topic);
    if (visitedTopics.size > 64) { dependencies.selection.omitted.push({ id: `topic:${topic}`, reason: 'budget' }); continue; }
    for (const reference of (options.dependencies ?? ADVISOR_TOPIC_DEPENDENCIES)[topic] ?? []) {
      if (reference.topic === 'projects' && reference.heading === '## Outbound webhook subscriptions — the raw-body signature'
        && !projectOutboundWebhook) continue;
      // A headed reference imports one contract, not every dependency of its
      // topic. Explicit roots and whole-topic references still expand normally.
      if (reference.heading === undefined && !visitedTopics.has(reference.topic) && !dependencyTopics.includes(reference.topic)) dependencyTopics.push(reference.topic);
      const sections = advisorSections(topics[reference.topic] ?? '').filter(section => section.length > 0
        && (reference.heading === undefined || section.split('\n')[0] === reference.heading));
      if (!sections.length) dependencies.selection.omitted.push({ id: `${reference.topic}:${reference.heading ?? '*'}`, reason: 'unavailable' });
      for (const section of sections) {
        const id = `${reference.topic}:${section.split('\n')[0]}`;
        if (dependencies.sectionIds.has(id)) continue;
        dependencies.sectionIds.add(id);
        dependencies.selection.selected.push(id);
        selected.push({ text: `## Required reference: ${reference.topic}\n${section}`, ids: [id] });
      }
    }
  }
  // The whole dotted name: `sw.db.server.aggregate` is the method, `sw.db.server` a namespace.
  const namedMethods = [...new Set(question.match(/\bsw\.[A-Za-z]+(?:\.[A-Za-z][A-Za-z0-9]*)+/g) ?? [])];
  const visitedMethods = new Set<string>();
  const methodDetails: typeof selected = [];
  for (const method of namedMethods) {
    if (visitedMethods.has(method)) continue;
    visitedMethods.add(method);
    if (visitedMethods.size > 64) { dependencies.selection.omitted.push({ id: `method:${method}`, reason: 'budget' }); continue; }
    const topic = method.split('.').slice(0, 2).join('.');
    // The section whose heading defines the method is its required contract.
    // Sections that merely mention it are detail, packed after the ranked
    // excerpts: `sw.db.server` alone is named in 13 database sections (36 KB),
    // which once starved the sw.endpoint definition (pfb_4ca3ea268c1a).
    const mentions = advisorSections(topics[topic] ?? '').filter(section =>
      (section.match(/\bsw\.[A-Za-z]+(?:\.[A-Za-z][A-Za-z0-9]*)+/g) ?? []).some(name => name === method));
    // Database server verbs share their ordinary verb's contract. Only use
    // that heading when this section also documents the exact server method.
    const contractMethod = method.replace(/^sw\.db\.server\./, 'sw.db.');
    if (!mentions.length) dependencies.selection.omitted.push({ id: `method:${method}`, reason: 'unavailable' });
    for (const section of mentions) {
      const id = `${topic}:${section.split('\n')[0]}`;
      const headingMethods = section.split('\n')[0].match(/\bsw\.[A-Za-z]+(?:\.[A-Za-z][A-Za-z0-9]*)+/g) ?? [];
      if (!headingMethods.some(name => name === method || name === contractMethod)) { methodDetails.push({ text: `## Topic: ${topic}\n${section}`, ids: [id] }); continue; }
      if (dependencies.sectionIds.has(id)) continue;
      dependencies.sectionIds.add(id);
      dependencies.selection.selected.push(id);
      selected.push({ text: `## Required reference: ${topic}\n${section}`, ids: [id] });
    }
  }

  // A namespace the question names on its own (`sw.endpoint handlers`) keeps its
  // defining section, as a named method does: otherwise ordinary growth in any
  // other selected topic can push that definition past the budget and the
  // answer reads it as nonexistent (pfb_4ca3ea268c1a; tsk_d03d921f, when the
  // groups methods table grew).
  for (const namespace of new Set(question.match(/\bsw\.[A-Za-z]+\b(?!\.[A-Za-z])/g) ?? [])) {
    const lead = advisorSections(topics[namespace] ?? '').find(section => section.length > 0);
    if (!lead) continue;
    const id = `${namespace}:${lead.split('\n')[0]}`;
    if (dependencies.sectionIds.has(id)) continue;
    dependencies.sectionIds.add(id);
    dependencies.selection.selected.push(id);
    // Packed first among required references: it is small, and it is what the question asks about.
    selected.splice(1, 0, { text: `## Topic: ${namespace}\n${lead}`, ids: [id], lead: true });
  }

  dependencies.selection.required = [...dependencies.selection.selected, ...dependencies.selection.omitted.map(item => item.id)];
  for (const page of ranked) {
    const sections = advisorSections(page.body);
    // Exact identifiers and the selected domain's canonical setup operations
    // beat incidental prose matches. Otherwise long worked examples win simply
    // by containing more query words than the operation's own contract.
    const identifiers = (question.match(/[a-z][a-z0-9_.-]*/gi) ?? [])
      .map((word) => word.replace(/[_.-]+$/, ''))
      .filter((word) => /[_.]|[a-z][A-Z]/.test(word) && !pages.some(([name]) => name.toLowerCase() === word.toLowerCase()))
      .map((word) => word.toLowerCase());
    const pageDomain = page.name.replace(/^sw\./, '');
    const domainCompanions = [...companions].filter((name) => name.startsWith(`${pageDomain}_`));
    const candidates = sections.map((body, order) => ({
      body, order,
      exact: identifiers.some((identifier) => body.toLowerCase().includes(identifier)),
      score: identifiers.filter((identifier) => body.toLowerCase().includes(identifier)).length * 100
        + domainCompanions.filter((name) => body.includes(name)).length * 20
        + score(body) / (1 + Math.log2(1 + body.length / 500)),
    })).filter((section) => {
      if (page.name !== 'cli' || !hasDomainFocus) return true;
      const heading = section.body.split('\n')[0];
      // A command the question names keeps its own section (\`## deploy-check — …\`).
      const command = /^##\s+([a-z][a-z-]*)\b/.exec(heading)?.[1];
      if (command && (question.includes(`somewhere ${command}`) || (command.includes('-') && question.includes(command)))) return true;
      return section.order === 0 || section.body.includes('somewhere call')
        || focused.some((topic) => !navigationTopics.has(topic.name)
          && (aliases[topic.name]?.test(heading) || heading.toLowerCase().includes(topic.name.replace(/^sw\./, ''))));
    }).sort((a, b) => b.score - a.score || a.order - b.order);
    let remaining = 5_000;
    const excerpts: typeof candidates = [];
    for (const section of candidates) {
      // A specifically requested contract is kept whole even when it exceeds
      // the ordinary topic budget. Never substitute unrelated small sections
      // for a requested identifier such as serverOnly in the schema section.
      if (!excerpts.length && section.exact && section.body.length <= 12_000) remaining = Math.max(remaining, section.body.length);
      const id = `${page.name}:${section.body.split('\n')[0]}`;
      if (dependencies.sectionIds.has(id)) continue;
      if (section.body.length > remaining) {
        dependencies.selection.omitted.push({ id, reason: 'budget' });
        continue;
      }
      dependencies.selection.selected.push(id);
      excerpts.push(section);
      remaining -= section.body.length;
    }
    for (const section of excerpts.sort((a, b) => a.order - b.order)) selected.push({ text: `## Topic: ${page.name}\n${section.body}`, ids: [`${page.name}:${section.body.split('\n')[0]}`], lead: section.order === 0 });
  }
  for (const block of methodDetails) {
    if (dependencies.sectionIds.has(block.ids[0]) || dependencies.selection.selected.includes(block.ids[0])) continue;
    dependencies.sectionIds.add(block.ids[0]);
    dependencies.selection.omitted = dependencies.selection.omitted.filter(item => item.id !== block.ids[0]);
    dependencies.selection.selected.push(block.ids[0]);
    selected.push(block);
  }
  const domainWord = (word: string): string => word.toLowerCase().replace(/s$/, '');
  const requestedDomains = new Set([
    ...query.flatMap((word) => word.split(/[_.-]/)),
    ...focused.map((page) => page.name.replace(/^sw\./, '')),
  ].map(domainWord));
  const genericToolParts = new Set('project platform cli create get set list delete update read write send run status query'.split(' '));
  const topicDomains = new Set(pages.map(([name]) => domainWord(name.replace(/^sw\./, '').split('-')[0])));
  const focusedDomains = new Set(focused.map((page) => domainWord(page.name.replace(/^sw\./, '').split('-')[0])));
  const companionDomains = new Set([...companions].map((name) => name.split('_')[0]));
  const toolRequested = (name: string): boolean => {
    if (companions.has(name) || query.includes(name)) return true;
    // The platform has three distinct delivery contracts. A project-outbound
    // webhook question must not be redirected to database/auth hooks or to the
    // unrelated system-channel WebSocket subscription because their nouns overlap.
    if (projectOutboundWebhook && (/^(?:auth|db)_webhook/.test(name) || /^events_subscribe_/.test(name))) return false;
    const parts = name.split('_');
    const runtimeName = `sw.${name.replace('_', '.')}`;
    // A focused answer may only advertise optional operations backed by the
    // excerpts it actually carries. Shared verbs such as "subscribe" and
    // "project" must not pull the system-channel WebSocket recipe into a
    // project-outbound webhook answer (or produce similar cross-domain leaks).
    if (hasDomainFocus && !parts.some((part) => focusedDomains.has(domainWord(part)))
      && !selected.some(({ text }) => text.includes(name) || text.includes(runtimeName))) return false;
    if (companionDomains.has(parts[0])) {
      if (!parts.slice(1).some((part) => requestedDomains.has(domainWord(part)))) return false;
    }
    if (topicDomains.has(domainWord(parts[0])) && !parts.some((part) => focusedDomains.has(domainWord(part)))) return false;
    // The leading namespace identifies the operation. Secondary words only
    // establish a domain when the docs actually have that domain: a request for
    // customer URL tokens does not imply project_design_tokens or view_urls.
    return name.split('_').some((part, index) => !genericToolParts.has(part)
      && (index === 0 || topicDomains.has(domainWord(part)))
      && requestedDomains.has(domainWord(part)));
  };
  const requiredToolNames = new Set([...companions, ...tools.filter(tool => query.includes(tool.name)).map(tool => tool.name)]);
  const selectedTools = tools.filter((tool) => options.caller !== 'cli' || tool.name !== 'project_deploy' || query.includes('project_deploy')).map((tool) => ({ ...tool, score: (requiredToolNames.has(tool.name) ? 100 : 0) + score(tool.name) * 4 + score(tool.description) }))
    .filter((tool) => tool.score > 0 && (!hasDomainFocus || toolRequested(tool.name)))
    .sort((a, b) => Number(requiredToolNames.has(b.name)) - Number(requiredToolNames.has(a.name)) || b.score - a.score).slice(0, 16);
  for (const name of requiredToolNames) {
    dependencies.selection.required!.push(`tool:${name}`);
    if (!tools.some(tool => tool.name === name)) dependencies.selection.omitted.push({ id: `tool:${name}`, reason: 'unavailable' });
    else if (!selectedTools.some(tool => tool.name === name)) dependencies.selection.omitted.push({ id: `tool:${name}`, reason: 'budget' });
  }
  const bounded: string[] = [];
  let remainingBytes = 60_000;
  let remainingSections = 36;
  const appendReference = (block: typeof selected[number]): void => {
    const size = new TextEncoder().encode(block.text).byteLength;
    const sectionCount = block.ids.filter(id => !id.startsWith('capability:')).length;
    if (size > remainingBytes || sectionCount > remainingSections) {
      dependencies.selection.selected = dependencies.selection.selected.filter(id => !block.ids.includes(id));
      for (const id of block.ids) dependencies.selection.omitted.push({ id, reason: 'budget' });
      return;
    }
    bounded.push(block.text); remainingBytes -= size; remainingSections -= sectionCount;
  };
  const appendTool = (tool: typeof selectedTools[number], output: string[]): void => {
    const id = `tool:${tool.name}`;
    if (!tool.inputSchema) { dependencies.selection.omitted.push({ id, reason: 'unavailable' }); return; }
    const block = `- ${tool.name}: ${tool.description.split('\n\n')[0].slice(0, 700)}\nArguments: ${JSON.stringify(tool.inputSchema)}`;
    const size = new TextEncoder().encode(block).byteLength;
    if (size > remainingBytes) dependencies.selection.omitted.push({ id, reason: 'budget' });
    else { output.push(block); dependencies.selection.selected.push(id); remainingBytes -= size; }
  };
  const requiredIds = new Set(dependencies.selection.required);
  const requiredReferences = selected.filter(block => block.ids.some(id => requiredIds.has(id)));
  // Every selected topic's defining section is packed before any topic's detail
  // sections: a topic whose definition lost the budget reads as nonexistent.
  const optionalReferences = selected.filter(block => !block.ids.some(id => requiredIds.has(id)))
    .sort((a, b) => Number(Boolean(b.lead)) - Number(Boolean(a.lead)));
  // Reserve executable argument contracts before prose can consume their budget.
  const requiredToolBlocks: string[] = [];
  for (const tool of selectedTools.filter(tool => requiredToolNames.has(tool.name))) appendTool(tool, requiredToolBlocks);
  for (const block of requiredReferences) appendReference(block);
  if (requiredToolBlocks.length) bounded.push('## Required caller-visible tools\n' + requiredToolBlocks.join('\n'));
  for (const block of optionalReferences) appendReference(block);
  const toolBlocks: string[] = [];
  for (const tool of selectedTools.filter(tool => !requiredToolNames.has(tool.name))) appendTool(tool, toolBlocks);
  const missingRequired = dependencies.selection.omitted.filter(item => dependencies.selection.required?.includes(item.id));
  const displayedMissing: typeof missingRequired = [];
  for (const item of missingRequired) {
    if (new TextEncoder().encode(JSON.stringify([...displayedMissing, item])).byteLength > 2_000) break;
    displayedMissing.push(item);
  }
  const missingNotice = missingRequired.length ? '\n\nRequired canonical references or tool schemas omitted (do not invent them): ' + JSON.stringify(displayedMissing) + ` (${missingRequired.length} total; full identities retained in diagnostics).` : '';
  return {
    topics: requiredTopics,
    selection: dependencies.selection,
    text: bounded.join('\n\n') + '\n\n## Relevant tools\n' + toolBlocks.join('\n') + missingNotice,
  };
}

/** Runtime-backed distinctions absent from the broad discovery index. The
 * corresponding fixtures check the signing implementation and event emitter. */
export function advisorIntegrationContext(question: string): string {
  if (!/webhook|payment|checkout/i.test(question)) return '';
  return `## Current payment and webhook evidence (takes precedence over older examples)
Project outbound /v1/webhooks and auth/database webhooks are DIFFERENT contracts.
Project outbound X-Somewhere-Signature is lowercase hex HMAC-SHA256(secret, rawBody), with NO t= or v1= wrapper and NO timestamp prefix. Read req.text() once; verify the exact UTF-8 bytes before parsing. Body: {event, project_id, timestamp, source, data}; timestamp is ISO-8601, not epoch units. That timestamp field IS authenticated inside the raw JSON body; only an ADDITIONAL timestamp prefix is absent. Never say the body timestamp is excluded from the MAC. Headers: X-Somewhere-Event, X-Somewhere-Project, X-Somewhere-Event-Id, X-Somewhere-Delivery-Id, X-Somewhere-Attempt. Deduplicate on event/delivery ID; redrives preserve the original body/signature. A configured secret is required for a signed delivery.
Auth/database webhooks instead use X-Somewhere-Signature: t=<epoch milliseconds>,v1=<hex HMAC-SHA256(secret, milliseconds + '.' + rawBody)>.
A settled ad-hoc one-time Checkout emits payment.completed to the project lifecycle webhook configured with auth_webhook_set, using the auth/database t=,v1= signature above. This includes shared-account test checkouts. It does not emit payment_received, subscription_created or subscription_cancelled to project outbound subscriptions. Do not confuse the two delivery systems.
sw.payments.events() exposes summary fields, NOT Checkout session metadata or a reliable request-id fulfillment mapping. Do not invent event.metadata or event.payment_intent_id there.
For custom order fulfillment, use the project lifecycle payment.completed event. Verify its timestamped signature and match payment.checkout_session_id, amount_total, currency and mode against the saved order: session_id, amount_total_cents and stripe_mode come from the checkout response; save the currency chosen by the server when creating checkout. Currency is not returned by this checkout response. Test and live events share this endpoint. Atomically record the unique checkout fulfillment together with the order/stock changes; on every valid delivery including duplicates, admit follow-up work with sw.jobs.create using the same idempotency_key so a missing job is created and an existing one is reused. This event does not itself update an arbitrary order table or grant an ad-hoc buyer a plan. A separate Stripe destination is optional for other native events such as refunds/disputes and uses Stripe-Signature with its own secret; it requires access to the connected account. Keep secrets server-side and use the payments docs for the exact handler. Do not use reserved somewhere_ metadata names; some identify platform bindings and suppress ad-hoc delivery.
sw.payments.checkout(options) returns session_id, url, amount_total_cents, stripe_mode and other checkout details; options include env ('dev' for test), mode ('payment'), line_items (name, amount, currency, quantity), success_url, cancel_url, and metadata. Amount is integer cents chosen on the server; do not guess a missing amount. For signed-in plan upgrades the current runtime signature is sw.payments.checkoutForUser({plan,...}); subject is derived from the signed-in request, not a positional userId.
Use crypto.getRandomValues(new Uint8Array(32)) for independent customer/admin URL tokens; persist hashes and do not expose admin tokens to public intake callers.
If the requested table is serverOnly(), preserve that policy. Anonymous intake can go through a validating server handler; do not replace serverOnly() with shared() or require signup to work around it.
`;
}
