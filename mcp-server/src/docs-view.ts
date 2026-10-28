/**
 * Bounded views of one docs topic: summary, one section, or the full reference.
 * The default view depends on the topic's kind (DOCS_TOPIC_KINDS): a recipe
 * (a whole job) defaults to the full view; every other kind defaults to the
 * summary. An explicit `detail` or `section` always wins. Shared by the `docs` tool and scripts/generate-docs.mjs (the
 * public manifest's `summary` / `sections` fields), so a signed-in CLI read, an
 * anonymous CLI read and an MCP read return the same text for the same view.
 *
 * Contract (agreed with the CLI, tsk_5fb397eb4d5a4d469698e9c744343dd4):
 * - The first line of every view is the status line
 *   `[docs] topic=<t> view=<summary|full|section> complete=<true|false> shown=<n> full=<n>`.
 *   Consumers parse `view=` and `complete=`; keep the format stable.
 * - complete=true only when the whole topic body is present.
 * - Section ids are the heading slugs the /docs site already uses for anchors,
 *   de-duplicated with a numeric suffix, except where a topic gives a section a
 *   short reader-facing id (DOCS_SECTION_ID_RENAMES); the slug then stays valid
 *   as `legacy_id`. The same ids appear in the summary index, the manifest
 *   `sections[]` and the `section` argument.
 * - The view never rewrites topic text: every byte shown comes from the topic.
 */

import { DOCS_TOPIC_KINDS, type DocsTopicKind } from './docs-summary-leads';
import { DOCS_SECTION_ID_RENAMES } from './docs-section-ids';

type SectionIdRenames = Readonly<Record<string, Readonly<Record<string, string>>>>;

export type DocsView = 'summary' | 'full' | 'section';

/** The `docs` tool's options. Anything else is refused, never ignored. */
export const DOCS_TOOL_OPTIONS = ['topic', 'detail', 'section', 'project_id'] as const;
export const DOCS_DETAIL_VALUES = ['summary', 'full'] as const;

export type DocsToolArgsCheck =
  | { ok: true }
  | { ok: false; error: 'INVALID_ARGUMENTS'; message: string; details: { unknown?: string[]; supported: readonly string[]; detail?: unknown } };

/**
 * An option the tool does not know used to be dropped silently, so
 * `{ view: "full" }` returned the summary as if it had been honoured
 * (pfb_b062060145cc). Unknown options and an unknown `detail` are refused by
 * name, with the supported set.
 */
export function checkDocsToolArgs(args: Record<string, unknown>): DocsToolArgsCheck {
  const supported = DOCS_TOOL_OPTIONS as readonly string[];
  const unknown = Object.keys(args).filter((key) => !supported.includes(key));
  if (unknown.length > 0) {
    const named = unknown.map((key) => `"${key}"`).join(', ');
    const hint = unknown.some((key) => key === 'view' || key === 'mode' || key === 'full')
      ? ' For the complete topic pass detail: "full"; for one section pass section: "<id>".'
      : '';
    return {
      ok: false,
      error: 'INVALID_ARGUMENTS',
      message: `docs: unknown option${unknown.length > 1 ? 's' : ''} ${named}. Supported options: ${supported.join(', ')}.${hint}`,
      details: { unknown, supported },
    };
  }
  if (args.detail !== undefined && !(DOCS_DETAIL_VALUES as readonly unknown[]).includes(args.detail)) {
    return {
      ok: false,
      error: 'INVALID_ARGUMENTS',
      message: `docs: detail must be "summary" or "full"; got ${JSON.stringify(args.detail)}.`,
      details: { detail: args.detail, supported: DOCS_DETAIL_VALUES },
    };
  }
  return { ok: true };
}

export interface DocsSection {
  id: string;
  heading: string;
  level: 2 | 3;
  /** Offset of the heading line in the body passed to docsSections(). */
  start: number;
  /** Offset where the section ends: the next heading at the same or a higher level, or end of body. */
  end: number;
  /** The heading-slug id this section had before its topic renamed it; still accepted as `section`. */
  legacy_id?: string;
}

export interface DocsViewResult {
  view: DocsView;
  complete: boolean;
  /** The status line alone (also the first line of `text`). */
  status: string;
  text: string;
}

/** A topic at or under this size is returned whole, even in summary view:
 *  about 1.7-1.8k tokens of this code-heavy prose (o200k, measured 3.7
 *  chars/token), so it still fits a 2k-token tool-output window in one read. */
export const DOCS_COMPLETE_MAX_CHARS = 6500;
/** Upper bound on a rendered summary (status line through the last retrieval line).
 *  Root-approved ceiling for a compact primitive first call: about 3k tokens at
 *  the measured 3.7 chars/token, so a whole accepted read-first unit fits. */
export const DOCS_SUMMARY_MAX_CHARS = 12000;
/** The changelog keeps the earlier summary bound: its opening prose is dated
 *  entries, not a primitive quick start, so a larger first call adds history. */
export const DOCS_CHANGELOG_SUMMARY_MAX_CHARS = 6000;

/** The summary bound for one topic, by its editorial kind (DOCS_TOPIC_KINDS). */
export function docsSummaryMaxChars(topic: string, kind?: DocsTopicKind): number {
  return (kind ?? DOCS_TOPIC_KINDS[topic]) === 'changelog' ? DOCS_CHANGELOG_SUMMARY_MAX_CHARS : DOCS_SUMMARY_MAX_CHARS;
}
/** A requested section larger than this, with subsections, is shown as its lead plus a subsection index. */
export const DOCS_SECTION_MAX_CHARS = 12000;

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/** Same slug as the /docs site anchors (scripts/generate-docs.mjs). */
export function docsHeadingSlug(heading: string): string {
  return stripInlineMarkdown(heading.trim())
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

/**
 * Renames that apply to this topic's slug ids: the old id exists, and the new id
 * is neither another section's id nor the target of a second rename.
 */
function applicableRenames(ids: readonly string[], renames: Readonly<Record<string, string>>): Map<string, string> {
  const present = new Set(ids);
  const targets = Object.values(renames);
  const applied = new Map<string, string>();
  for (const [from, to] of Object.entries(renames)) {
    if (present.has(from) && !present.has(to) && targets.filter((target) => target === to).length === 1) applied.set(from, to);
  }
  return applied;
}

/** Why a topic's configured renames would not all apply (empty when they do). */
export function docsSectionIdProblems(topic: string, body: string, renames: SectionIdRenames = DOCS_SECTION_ID_RENAMES): string[] {
  const configured = renames[topic] ?? {};
  const ids = docsSections(body).map((section) => section.id);
  const applied = applicableRenames(ids, configured);
  return Object.entries(configured).filter(([from]) => !applied.has(from)).map(([from, to]) => (!ids.includes(from)
    ? `${topic}: section "${from}" (renamed "${to}") no longer exists`
    : `${topic}: section "${from}" cannot be renamed "${to}": that id is already used in the topic`));
}

/**
 * `## ` / `### ` headings outside fenced code, with body offsets. With a topic,
 * that topic's reader-facing renames apply (DOCS_SECTION_ID_RENAMES).
 */
export function docsSections(body: string, topic?: string, renames: SectionIdRenames = DOCS_SECTION_ID_RENAMES): DocsSection[] {
  const heads: Array<Omit<DocsSection, 'end'>> = [];
  const seen = new Map<string, number>();
  let offset = 0;
  let inFence = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    else if (!inFence) {
      const match = /^(##|###)\s+(.+)$/.exec(line);
      if (match) {
        const base = docsHeadingSlug(match[2]) || 'section';
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        heads.push({
          id: count === 1 ? base : `${base}-${count}`,
          heading: line.trim(),
          level: match[1] === '##' ? 2 : 3,
          start: offset,
        });
      }
    }
    offset += line.length + 1;
  }
  const renamed = topic ? applicableRenames(heads.map((head) => head.id), renames[topic] ?? {}) : new Map<string, string>();
  return heads.map((head, index) => {
    const next = heads.slice(index + 1).find((candidate) => candidate.level <= head.level);
    const end = next ? next.start : body.length;
    const id = renamed.get(head.id);
    return id ? { ...head, id, end, legacy_id: head.id } : { ...head, end };
  });
}

/** A public-manifest section entry: a section, or an old id kept for clients that only read `id`. */
export type DocsManifestSection = DocsSection | (Omit<DocsSection, 'legacy_id'> & { alias_of: string });

/**
 * The manifest `sections[]` for one page: the topic's sections (canonical ids,
 * in order), then one compatibility entry per renamed section that carries the
 * old id, the same heading and byte range, and `alias_of` the canonical id.
 * Clients that select by `id` alone keep resolving old ids to the same bytes.
 */
export function docsManifestSections(body: string, topic: string, renames: SectionIdRenames = DOCS_SECTION_ID_RENAMES): DocsManifestSection[] {
  const sections = docsSections(body, topic, renames);
  const aliases = sections.flatMap(({ legacy_id, ...section }) => (legacy_id ? [{ ...section, id: legacy_id, alias_of: section.id }] : []));
  return [...sections, ...aliases];
}

/** Split a leading `# Title` line from a topic string. */
export function splitDocsTitle(text: string): { title: string | null; body: string } {
  const match = /^\s*#\s+([^\n]+)\n/.exec(text);
  if (!match) return { title: null, body: text };
  return { title: match[1].trim(), body: text.slice(match[0].length).replace(/^\n+/, '') };
}

export function docsStatusLine(input: { topic: string; view: DocsView; complete: boolean; shown: number; full: number }): string {
  return `[docs] topic=${input.topic} view=${input.view} complete=${input.complete} shown=${input.shown} full=${input.full}`;
}

function kilo(chars: number): string {
  return chars < 1000 ? `${chars}` : `${(chars / 1000).toFixed(1)}k`;
}

export interface DocsRetrieval {
  full: string;
  section: string;
}

/** Retrieval commands, shaped for the caller that will run them. */
export function docsRetrieval(topic: string, cli: boolean): DocsRetrieval {
  if (cli) {
    return {
      full: `somewhere docs ${topic} --full`,
      section: `somewhere docs ${topic} --section <id>`,
    };
  }
  return {
    full: `docs({ topic: "${topic}", detail: "full" })`,
    section: `docs({ topic: "${topic}", section: "<id>" })`,
  };
}

/** Older CLIs have no --full/--section; `somewhere call` reaches the same tool arguments. */
function legacyCliRetrieval(topic: string): string {
  return `older CLI: somewhere call docs '{"topic":"${topic}","detail":"full"}'`;
}

function findSection(sections: readonly DocsSection[], wanted: string): DocsSection | undefined {
  const raw = wanted.trim();
  if (!raw) return undefined;
  const id = raw.toLowerCase();
  const exact = sections.find((section) => section.id === id)
    ?? sections.find((section) => section.legacy_id === id);
  if (exact) return exact;
  const normalized = docsHeadingSlug(raw.replace(/^#+\s*/, ''));
  if (!normalized) return undefined;
  const matches = sections.filter((section) => docsHeadingSlug(section.heading.replace(/^#+\s*/, '')) === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

function renderIndex(sections: readonly DocsSection[], included: ReadonlySet<string>, within?: DocsSection): string {
  const rows = sections
    .filter((section) => !within || (section.start > within.start && section.end <= within.end))
    .map((section) => {
      const indent = section.level === 3 && !within ? '  ' : '';
      const mark = included.has(section.id) ? ' (shown above)' : '';
      return `${indent}- ${section.id} · ${kilo(section.end - section.start)}${mark}`;
    });
  return rows.join('\n');
}

/** Largest paragraph-boundary prefix of `text` that fits in `max` chars. */
function paragraphPrefix(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n\n', max);
  return cut > 0 ? text.slice(0, cut) : '';
}

export interface RenderDocsViewInput {
  /** Canonical topic id, used in the status line and retrieval commands. */
  topic: string;
  /** The topic text, optionally starting with its `# Title` line. */
  text: string;
  /** 'full' returns the whole topic; anything else is a summary unless `section` is set. */
  detail?: unknown;
  section?: unknown;
  /** Editorial read-first sections (exact `## ` / `### ` heading lines), rendered in the summary in this order. */
  leads?: readonly string[];
  /** Shape retrieval lines for the CLI (`somewhere docs …`) instead of the tool call. */
  cli?: boolean;
  /** The topic's editorial kind; defaults to DOCS_TOPIC_KINDS[topic]. */
  kind?: DocsTopicKind;
}

/** The view a call gets when it names neither `detail` nor `section`. */
export function docsDefaultDetail(topic: string, kind?: DocsTopicKind): 'full' | 'summary' {
  return (kind ?? DOCS_TOPIC_KINDS[topic]) === 'recipe' ? 'full' : 'summary';
}

export function renderDocsView(input: RenderDocsViewInput): DocsViewResult {
  const { title, body } = splitDocsTitle(input.text);
  const titleLine = title ? `# ${title}\n\n` : '';
  const full = body.length;
  const sections = docsSections(body, input.topic);
  const retrieval = docsRetrieval(input.topic, Boolean(input.cli));
  const legacy = input.cli ? ` (${legacyCliRetrieval(input.topic)})` : '';
  const done = (view: DocsView, complete: boolean, shown: number, content: string): DocsViewResult => {
    const status = docsStatusLine({ topic: input.topic, view, complete, shown, full });
    return { view, complete, status, text: `${status}\n${content}` };
  };

  const requestedSection = typeof input.section === 'string' ? input.section : null;
  const detail = input.detail === undefined && requestedSection === null
    ? docsDefaultDetail(input.topic, input.kind)
    : input.detail;
  if (detail === 'full' && requestedSection === null) return done('full', true, full, titleLine + body);

  if (requestedSection !== null) {
    const section = findSection(sections, requestedSection);
    if (!section) {
      return done('section', false, 0,
        `No section "${requestedSection.trim()}" in ${input.topic}. Use an exact ID; normalized headings must identify one section. Sections (id · size):\n${renderIndex(sections, new Set())}\n\n`
        + `One section: ${retrieval.section}\nFull reference: ${retrieval.full}${legacy}\n`);
    }
    if (detail === 'full') return done('full', true, full, titleLine + body);
    const text = body.slice(section.start, section.end).replace(/\s+$/, '');
    const context = title ? `(${title} › ${section.heading.replace(/^#+\s*/, '')})\n\n` : '';
    const children = sections.filter((candidate) => candidate.start > section.start && candidate.end <= section.end);
    if (text.length > DOCS_SECTION_MAX_CHARS && children.length > 0) {
      const lead = body.slice(section.start, children[0].start).replace(/\s+$/, '');
      return done('section', false, lead.length,
        `${context}${lead}\n\nThis section is ${kilo(text.length)} chars; its subsections (id · size):\n`
        + `${renderIndex(sections, new Set(), section)}\n\nOne subsection: ${retrieval.section}\n`);
    }
    return done('section', text.length === full, text.length, `${context}${text}\n`);
  }

  if (full <= DOCS_COMPLETE_MAX_CHARS) return done('summary', true, full, titleLine + body);

  // Summary: title, the topic's opening prose, the editorial read-first
  // sections, then an index of every section and the exact retrieval calls.
  // Critical instructions live in the read-first sections, so they precede
  // the index; the retrieval line is repeated first and last so a client
  // that truncates the middle still keeps a way to continue.
  const header = `Summary of a ${kilo(full)}-char topic. Full reference: ${retrieval.full}${legacy}. `
    + `One section: ${retrieval.section} (ids listed at the end).\n\n`;
  const footerFor = (index: string) => `\n\n## Sections (id · size)\n${index}\n\n`
    + `One section: ${retrieval.section}\nFull reference: ${retrieval.full}${legacy}\n`;
  const statusReserve = docsStatusLine({ topic: input.topic, view: 'summary', complete: false, shown: full, full }).length + 1;

  const leadSections: DocsSection[] = [];
  for (const heading of input.leads ?? []) {
    const match = sections.find((section) => section.heading === heading.trim());
    if (match) leadSections.push(match);
  }
  const included = new Set(leadSections.flatMap((lead) => sections
    .filter((section) => section.start >= lead.start && section.end <= lead.end)
    .map((section) => section.id)));
  const leadText = leadSections.map((lead) => body.slice(lead.start, lead.end).replace(/\s+$/, '')).join('\n\n');
  const fixed = statusReserve + header.length + titleLine.length + footerFor(renderIndex(sections, included)).length
    + (leadText ? leadText.length + 2 : 0);
  const introRaw = (sections.length ? body.slice(0, sections[0].start) : body).replace(/\s+$/, '');
  const max = docsSummaryMaxChars(input.topic, input.kind);
  const intro = paragraphPrefix(introRaw, Math.max(0, max - fixed));
  // Fill the rest of the budget with whole sections in document order, so a
  // summary carries content rather than mostly an index (waitlist report: every
  // lookup cost two calls). A section that does not fit is skipped, never cut.
  let room = max - fixed - (intro ? intro.length + 2 : 0);
  const filled: DocsSection[] = [];
  for (const section of sections) {
    if (included.has(section.id)) continue;
    const text = body.slice(section.start, section.end).replace(/\s+$/, '');
    // Each included section also gains " (shown above)" on its index line.
    const inner = sections.filter((candidate) => candidate.start >= section.start && candidate.end <= section.end);
    const cost = text.length + 2 + inner.length * ' (shown above)'.length;
    if (cost > room) continue;
    filled.push(section);
    room -= cost;
    for (const candidate of inner) included.add(candidate.id);
  }
  // Everything fit: that is the whole topic, so answer it as complete.
  if (intro === introRaw && sections.every((section) => included.has(section.id))) {
    return done('summary', true, full, titleLine + body);
  }
  const ordered = [...leadSections, ...filled.sort((x, y) => x.start - y.start)];
  const shownText = ordered.map((section) => body.slice(section.start, section.end).replace(/\s+$/, '')).join('\n\n');
  const content = [intro, shownText].filter(Boolean).join('\n\n');
  const shown = intro.length + shownText.length;
  const complete = shown >= body.trim().length;
  return done('summary', complete, shown, header + titleLine + content + footerFor(renderIndex(sections, included)));
}
