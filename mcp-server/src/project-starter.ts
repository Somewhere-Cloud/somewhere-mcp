// project_create starter (tsk_7eb6d91e3b2a4321955c987028f55a0f): the same
// files `somewhere init` writes, deployed as the project's first release.
// Every byte comes from PROJECT_STARTER_MIRROR, generated from the pinned
// @somewhere-tech/cli; this module only selects, names and ships it.
import { PROJECT_STARTER_MIRROR } from './project-starter.generated';
import type {
  ProjectStarterDeployPlan,
  StarterDeployAttempt,
  StarterDeployBody,
  ProjectStarterFile,
  ProjectStarterMirror,
  ProjectStarterReport,
  ProjectStarterResolution,
  ProjectStarterSelection,
} from './types/project-starter';

export const DEFAULT_STARTER_FEATURES = 'auth';
export const DEFAULT_STARTER_UI = 'styled';
export const SKILLS_PACK_URL = 'https://somewhere.cloud/skills/pack.json';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The template's two uses of the app name: a JSON string literal in
 *  src/config.ts and HTML (text and the description attribute) in index.html.
 *  An .html file is escaped as HTML everywhere, so a quoted attribute value is
 *  never mistaken for a JSON string. The escape set matches the CLI template
 *  (init-feature-template.ts indexHtml); check-project-starter.mjs proves this
 *  equals the CLI output for hostile names. */
function nameContent(path: string, content: string, token: string, appName: string): string {
  if (path.endsWith('.html')) return content.split(token).join(escapeHtml(appName));
  return content
    .split(JSON.stringify(token)).join(JSON.stringify(appName))
    .split(token).join(escapeHtml(appName));
}

export function starterSource(mirror: ProjectStarterMirror = PROJECT_STARTER_MIRROR): string {
  return `${mirror.source.package}@${mirror.source.version}`;
}

/** Resolve `--features`/`--ui` the way `somewhere init` does. */
export function resolveProjectStarter(
  features: string,
  ui: string,
  appName: string,
  mirror: ProjectStarterMirror = PROJECT_STARTER_MIRROR,
): ProjectStarterResolution {
  const known = mirror.catalog.modules.map((entry) => entry.id);
  const ids = features.split(',').map((value) => value.trim()).filter(Boolean);
  if (ids.length === 0) {
    return { ok: false, message: `starter needs at least one module (${known.join(', ')}) or "none".` };
  }
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length) {
    const reasons = mirror.catalog.not_offered
      .filter((entry) => unknown.includes(entry.id))
      .map((entry) => ` ${entry.id}: ${entry.reason}`)
      .join('');
    return { ok: false, message: `Unknown starter module ${unknown.join(', ')}. Available: ${known.join(', ')}, or "none".${reasons}` };
  }
  const modes = mirror.catalog.ui.map((entry) => entry.id);
  if (!modes.includes(ui)) {
    return { ok: false, message: `Unknown starter_ui ${ui}. Use one of: ${modes.join(', ')}.` };
  }
  const requested = known.filter((id) => ids.includes(id));
  const selection: ProjectStarterSelection | undefined = mirror.selections[`${requested.join(',')}|${ui}`];
  if (!selection) return { ok: false, message: `No starter for ${requested.join(',')} with ${ui} UI.` };
  const files: ProjectStarterFile[] = selection.files.map(([path, digest]) => {
    const content = mirror.blobs[digest];
    if (content === undefined) throw new Error(`project starter mirror is missing ${path}`);
    return { path, content: nameContent(path, content, mirror.app_name_token, appName) };
  });
  return { ok: true, selection, files };
}

/** Split the starter exactly as the CLI's deploy collector did at generation. */
export function planStarterDeploy(
  selection: ProjectStarterSelection,
  files: ProjectStarterFile[],
): ProjectStarterDeployPlan {
  const contentByPath = new Map(files.map((file) => [file.path, file.content]));
  const plan: ProjectStarterDeployPlan = { files: {}, functions: {}, held_back: [] };
  const deployedPaths = new Set<string>();
  for (const [bucket, key, path] of selection.deploy) {
    const content = contentByPath.get(path);
    if (content === undefined) throw new Error(`project starter deploy entry ${key} has no source file ${path}`);
    plan[bucket][key] = content;
    deployedPaths.add(path);
  }
  plan.held_back = files.map((file) => file.path).filter((path) => !deployedPaths.has(path));
  return plan;
}

export type PreparedProjectStarter =
  | { ok: true; body: StarterDeployBody; report: ProjectStarterReport }
  | { ok: false; message: string };

/** How long project_create waits for the starter's first deploy. */
export const STARTER_DEPLOY_WAIT_MS = 120_000;
/** Largest exact redeploy payload returned inline for recovery (characters). */
export const STARTER_RECOVERY_INLINE_MAX = 48_000;

/** Build the first-release deploy body and the starter description. */
export function prepareProjectStarter(
  input: { projectId: string; appName: string; features: string; ui: string },
  mirror: ProjectStarterMirror = PROJECT_STARTER_MIRROR,
): PreparedProjectStarter {
  const resolved = resolveProjectStarter(input.features, input.ui, input.appName, mirror);
  if (!resolved.ok) return resolved;
  const plan = planStarterDeploy(resolved.selection, resolved.files);
  const fileText = (path: string) => resolved.files.find((file) => file.path === path)?.content;
  const features = resolved.selection.modules.join(',');
  return {
    ok: true,
    body: { project_id: input.projectId, base_release_id: null, files: plan.files, functions: plan.functions, source: 'mcp' },
    report: {
      status: 'unknown',
      source: starterSource(mirror),
      features,
      ui: resolved.selection.ui,
      description: resolved.selection.description,
      deployed_files: [...Object.keys(plan.functions), ...Object.keys(plan.files)].sort(),
      held_back_files: plan.held_back,
      agent_contract: fileText('AGENTS.md'),
      readme: fileText('README.md'),
      extension_points: resolved.selection.extension_points,
      skills: { version: mirror.skills.version, pack_url: SKILLS_PACK_URL, skills: mirror.skills.skills },
      cli_equivalent: { package: starterSource(mirror), argv: ['init', '--name', input.appName, '--features', features, '--ui', resolved.selection.ui] },
    },
  };
}

/**
 * Wait for the starter deploy, at most until `signal` aborts. The signal ends
 * only this wait: the deploy request itself is not cancelled and may still
 * finish upstream, which is why a timeout is reported as unknown.
 */
export async function awaitStarterDeploy(
  pending: Promise<{ status: number; data: unknown }>,
  signal: AbortSignal = AbortSignal.timeout(STARTER_DEPLOY_WAIT_MS),
): Promise<StarterDeployAttempt> {
  const answered = pending.then(
    (result): StarterDeployAttempt => ({ kind: 'answered', status: result.status, data: result.data }),
    (error: unknown): StarterDeployAttempt => ({ kind: 'transport_error', message: error instanceof Error ? error.message : String(error) }),
  );
  const timedOut = new Promise<StarterDeployAttempt>((resolve) => {
    if (signal.aborted) resolve({ kind: 'timed_out' });
    signal.addEventListener('abort', () => resolve({ kind: 'timed_out' }), { once: true });
  });
  return Promise.race([answered, timedOut]);
}

/** Confirm the deploy route's completed publication, not HTTP success alone.
 * Release-native responses identify the active release; the explicit environment
 * response remains supported. Neither pending work nor a preview is a live deploy. */
function deployedRelease(attempt: StarterDeployAttempt):
  | { kind: 'live' | 'preview'; version: number; url: unknown; releaseId?: string }
  | { kind: 'refused'; error: unknown }
  | { kind: 'upstream_unavailable'; error: unknown }
  | { kind: 'malformed' } {
  if (attempt.kind !== 'answered') return { kind: 'malformed' };
  const body = attempt.data && typeof attempt.data === 'object' ? attempt.data as Record<string, unknown> : null;
  // A 5xx, or a non-JSON page the MCP client relabels UPSTREAM_ERROR, does not
  // show what the deploy did; only the deploy route's own refusal does.
  if (attempt.status >= 500 || body?.error === 'UPSTREAM_ERROR') {
    return { kind: 'upstream_unavailable', error: body?.error ?? `HTTP ${attempt.status}` };
  }
  if (attempt.status >= 400 || body?.ok === false) {
    return { kind: 'refused', error: body?.error ?? body?.message ?? `HTTP ${attempt.status}` };
  }
  const data = body?.ok === true && body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : null;
  if (attempt.status !== 200 || !data || !Number.isInteger(data.version) || (data.version as number) < 1) return { kind: 'malformed' };
  if (data.requires_promote === true || data.environment === 'preview' || data.preview === true) return { kind: 'preview', version: data.version as number, url: data.url };
  if (data.environment !== undefined && data.environment !== 'live') return { kind: 'malformed' };
  if (data.release_publish !== undefined || data.release_id !== undefined || data.active_release_id !== undefined) {
    // `partial` is the actual responder's published release with a blank-page
    // warning/fallback, not unfinished publication. Matching active identity is
    // still mandatory; a queued operation or a retained candidate is unknown.
    if (data.release_publish !== true || typeof data.release_id !== 'string' || !data.release_id.trim()
      || data.release_id !== data.active_release_id || (data.status !== 'success' && data.status !== 'partial')) {
      return { kind: 'malformed' };
    }
    return { kind: 'live', version: data.version as number, url: data.url, releaseId: data.release_id };
  }
  if (data.environment !== 'live' || (data.status !== undefined && data.status !== 'success' && data.status !== 'partial')) return { kind: 'malformed' };
  return { kind: 'live', version: data.version as number, url: data.url };
}

const RECOVERY_NOTE = 'The project exists. A second project_create with the same subdomain returns SUBDOMAIN_TAKEN, and a new name makes a second project. project_deploys and deploy_status report the deployment of this project. While a deployment is in progress or its outcome is unknown, another deploy is not needed. Once the prior attempt has finished and the starter did not go live, project_deploy with recovery.redeploy (or the CLI command in starter.cli_equivalent) produces the same starter files.';

/** The starter description after its deploy attempt. Never throws. */
export function starterOutcome(prepared: { body: StarterDeployBody; report: ProjectStarterReport }, attempt: StarterDeployAttempt): ProjectStarterReport {
  const release = deployedRelease(attempt);
  if (release.kind === 'live') {
    return {
      ...prepared.report,
      status: 'deployed',
      version: release.version,
      ...(release.releaseId ? { release_id: release.releaseId } : {}),
      url: release.url,
      next: 'Edit the starter with project_patch (read files with project_export). AGENTS.md, README.md and the skills are returned here because deploys do not publish them.',
    };
  }
  const payload = { tool: 'project_deploy' as const, args: { project_id: prepared.body.project_id, base_release_id: prepared.body.base_release_id, files: prepared.body.files, functions: prepared.body.functions } };
  const inline = JSON.stringify(payload.args).length <= STARTER_RECOVERY_INLINE_MAX;
  const recovery = {
    check: [
      { tool: 'project_deploys', args: { project_id: prepared.body.project_id } },
      { tool: 'deploy_status', args: { project_id: prepared.body.project_id } },
    ],
    note: RECOVERY_NOTE,
    ...(inline ? { redeploy: payload } : { redeploy_omitted: 'The exact files exceed the inline limit; starter.cli_equivalent reproduces them byte for byte.' }),
  };
  if (release.kind === 'preview') {
    return { ...prepared.report, status: 'preview', version: release.version, url: release.url, detail: 'requires_promote', next: 'The starter was deployed as a preview, not production. Promote it with project_promote, or deploy your own source.' };
  }
  if (release.kind === 'refused') {
    return { ...prepared.report, status: 'failed', detail: 'refused', error: release.error, recovery };
  }
  const detail = attempt.kind === 'timed_out' ? 'timed_out'
    : attempt.kind === 'transport_error' ? 'transport_error'
      : release.kind === 'upstream_unavailable' ? 'upstream_unavailable' : 'malformed_response';
  return {
    ...prepared.report,
    status: 'unknown',
    detail,
    ...(attempt.kind === 'transport_error' ? { error: attempt.message } : release.kind === 'upstream_unavailable' ? { error: release.error } : {}),
    next: attempt.kind === 'timed_out'
      ? `The starter deploy did not answer within ${STARTER_DEPLOY_WAIT_MS / 1000} seconds. It may still finish; whether it did is unknown.`
      : 'The starter deploy outcome is unknown.',
    recovery,
  };
}
