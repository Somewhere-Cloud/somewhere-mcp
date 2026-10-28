/** Capability dependencies accompany an operation's syntax. These are not
 * question-specific answers. Canonical sections remain the prose owner; the
 * two temporary runtime-backed constraints below have real-source fixtures
 * and can move to those sections when the documentation owner adds them. */
export interface AdvisorKnowledgeSelection {
  selected: string[];
  workflows?: string[];
  required?: string[];
  omitted: Array<{ id: string; reason: 'budget' | 'unavailable' }>;
}

export function advisorSections(body: string): string[] {
  const sections: string[] = [];
  let fenced = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    if (!sections.length || (!fenced && /^#{1,3} /.test(line))) sections.push(line);
    else sections[sections.length - 1] += '\n' + line;
  }
  return sections;
}

interface RequiredSection { topic: string; heading: string }
interface CapabilityDependency {
  id: string;
  requested: (question: string, topics: string[]) => boolean;
  sections: RequiredSection[];
  evidence: string;
}

const PUBLIC_INTAKE = /\bpublic\b[^.?!]{0,80}\b(?:forms?|intake|submissions?|submit\w*)\b|\b(?:intake|contact|enquiry|inquiry) forms?\b|\banonymous\b[^.?!]{0,60}\b(?:forms?|submi\w*|intake)\b/i;

const DEPENDENCIES: CapabilityDependency[] = [
  {
    id: 'server-rendered-pages',
    requested: (question) => /\bSSR\b|server[- ]render|\bHTML\b|\bpages?\b.*\bfunction|\bcatch[- ]all\b|\bknowledge[- ]base\b/i.test(question),
    sections: [{ topic: 'functions', heading: '## Server-rendered pages alongside the SPA' }],
    evidence: '',
  },
  {
    id: 'mixed-access-recipes',
    requested: (question) => /provider.{0,30}booker|owner.{0,30}staff|unverified.{0,30}(?:group|member)/i.test(question),
    sections: [
      { topic: 'sw.db', heading: '## Provider-or-booker and owner-or-staff recipes' },
      { topic: 'sw.groups', heading: '## Membership before email verification' },
    ],
    evidence: '',
  },
  {
    id: 'managed-schema',
    requested: (question, topics) => topics.includes('sw.db')
      && /\bschema\b|\bmanaged\b|\badd(?:ing)? (?:an? |new )?columns?\b|\b(?:owner|shared|serverOnly|group|appRole|anyOf)\s*\(|\barchitecture\b|\bfile shapes?\b|\bimplementation\b/i.test(question),
    sections: [{ topic: 'sw.db', heading: '## Start with the schema file — db/schema.ts' }],
    // Source: db-schema-deploy/differ.ts managed-scope + retention guards;
    // extract-schema-ts.ts readTable grammar. Tests exercise both directions.
    evidence: 'Managed schema capability constraints: A NEW table can use owner(), group(), appRole(), shared(), or serverOnly(); anyOf() combines exactly owner() with one member(), group() or appRole() branch; group/appRole branches grant only their explicitly listed operations. Owners retain their own rows; owner-plus-group inserts require membership in the named group. Live subscriptions over anyOf remain unsupported. allOf(gate, who) requires current membership (member() with operations, group() or appRole() with roles) AND owner() or anyOf(owner(), the same membership or an app role); leaving revokes access to every row, including rows the author created; explicit operations are required; live subscriptions, publicRead, links, intake, payment bindings and file collections are not supported on allOf tables. An EXISTING managed table can switch between owner(), shared() and serverOnly() only on a scope-only production deploy while the table is EMPTY and has no links, triggers, views, or raw SQL naming it; any other scope change is refused, and a table with rows fails when the change applies (SCHEMA_APPLY_FAILED, rolled back). Previews cannot make this switch. removedTable() retains the table and its scope; redeclaring it during retention must restore that same scope, so remove-and-recreate is not a scope-conversion workaround. A new differently named table is a separate table, not an in-place conversion; do not claim existing data or references migrate automatically. The schema file is a closed literal declaration grammar, not arbitrary TypeScript. Object-property trailing commas and trailing commas after nonempty table/helper/schema arguments are accepted; empty argument slots and extra arguments are refused.',
  },
  {
    // A team/club workflow needs the group declaration, its role rules and
    // the method table together; packing them first keeps them ahead of
    // database and email detail in the bounded prompt.
    id: 'group-data',
    requested: (_question, topics) => topics.includes('sw.groups'),
    sections: [
      { topic: 'declared-data', heading: '## Data' },
      { topic: 'sw.groups', heading: '### Declare a group table' },
      { topic: 'sw.groups', heading: "### Read a group's rows" },
      { topic: 'sw.groups', heading: '### Who may do what' },
      { topic: 'sw.groups', heading: '## Methods' },
      { topic: 'sw.auth', heading: '## Member contacts' },
    ],
    // Source: worker managed-groups roster pages carry user_id, role and
    // created_at only (fixture-checked).
    evidence: 'Group membership capability: sw.groups.members(request, groupId) pages contain user IDs and roles, not email addresses. A production function can authorize contact access and resolve member IDs with sw.auth.server.listUsers({ ids }); ordinary membership alone does not grant contact access.',
  },
  {
    // Public intake: one validating server handler writes the row. Addressed
    // to an owner it keeps owner() tables and names the looked-up user_id; a
    // table the caller declared serverOnly() keeps that declaration and only
    // the handler applies.
    id: 'public-intake',
    requested: (question) => PUBLIC_INTAKE.test(question),
    sections: [{ topic: 'recipe-signed-in-app', heading: '## 4. Public form: save first, then notify' }],
    evidence: '',
  },
  {
    id: 'owner-intake',
    requested: (question) => PUBLIC_INTAKE.test(question) && !/\bserverOnly\s*\(/.test(question),
    sections: [
      { topic: 'recipe-signed-in-app', heading: '## 2. db/schema.ts' },
      { topic: 'recipe-signed-in-app', heading: '## 3. Owner pages (signed in)' },
    ],
    evidence: '',
  },
  {
    id: 'scheduled-invocation',
    requested: (_question, topics) => topics.includes('cron'),
    sections: [{ topic: 'sw.jobs', heading: '## Job handler function' }],
    // Source: dispatch-crons enqueues source cron; job workflow signs that
    // source and target; runtime/jobs verifies the proof through the API.
    evidence: 'Scheduled invocation capability: Cron deliveries run through the signed job delivery path. A cron handler can call await sw.jobs.verifyInvocation(req) before trusting the payload; false must be refused. There is no sw.cron.verifyInvocation method. A source header alone is not authorization. Use the verifier rather than trusting the source header or an app-user session; keep handlers idempotent for repeated work. This proves platform delivery, not a signed-in app user.',
  },
];

export function advisorCapabilityDependencies(
  question: string,
  selectedTopics: string[],
  topics: Record<string, string>,
): { text: string; sectionIds: Set<string>; selection: AdvisorKnowledgeSelection } {
  const text: string[] = [];
  const sectionIds = new Set<string>();
  const selection: AdvisorKnowledgeSelection = { selected: [], omitted: [] };
  for (const dependency of DEPENDENCIES) {
    if (!dependency.requested(question, selectedTopics)) continue;
    selection.selected.push(`capability:${dependency.id}`);
    if (dependency.evidence) text.push(`## Required capability evidence\n${dependency.evidence}`);
    for (const { topic, heading } of dependency.sections) {
      const id = `${topic}:${heading}`;
      const section = advisorSections(topics[topic] ?? '').find((body) => body.split('\n')[0] === heading);
      sectionIds.add(id);
      if (section) {
        selection.selected.push(id);
        text.push(`## Required reference: ${topic}\n${section}`);
      } else {
        selection.omitted.push({ id, reason: 'unavailable' });
        text.push(`Required reference unavailable: ${id}. Do not invent its syntax or claim that its absence means the capability is unsupported.`);
      }
    }
  }
  return { text: text.join('\n\n'), sectionIds, selection };
}
