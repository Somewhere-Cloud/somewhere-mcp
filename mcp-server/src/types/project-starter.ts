/** One `somewhere init` module selection as the pinned CLI resolved it. */
export interface ProjectStarterSelection {
  requested: string[];
  added: string[];
  modules: string[];
  ui: string;
  /** The CLI's own one-line description of the selection. */
  description: string;
  /** [path, sha256 of the content in `blobs`] in CLI write order. */
  files: [string, string][];
  /** What `somewhere deploy` sends for these files, as the pinned CLI's own
   *  collector classified them: [bucket, deploy key, source path]. */
  deploy: ['files' | 'functions', string, string][];
  extension_points: Record<string, string>;
}

export interface ProjectStarterCatalog {
  modules: { id: string; summary: string; requires: string[] }[];
  ui: { id: string; summary: string }[];
  not_offered: { id: string; reason: string }[];
}

export interface ProjectStarterSkill {
  name: string;
  description: string;
  path: string;
}

/** Content-addressed mirror of the pinned CLI starter (generated). */
export interface ProjectStarterMirror {
  source: { package: string; version: string };
  app_name_token: string;
  app_name_files: string[];
  catalog: ProjectStarterCatalog;
  /** Keyed by `<requested ids in catalog order>|<ui>`. */
  selections: Record<string, ProjectStarterSelection>;
  blobs: Record<string, string>;
  skills: { version: string; sha256: string; skills: ProjectStarterSkill[] };
  digest: string;
}

export interface ProjectStarterFile {
  path: string;
  content: string;
}

export type ProjectStarterResolution =
  | { ok: true; selection: ProjectStarterSelection; files: ProjectStarterFile[] }
  | { ok: false; message: string };

/** The deploy payload split the way `somewhere deploy` splits a folder. */
export interface ProjectStarterDeployPlan {
  files: Record<string, string>;
  functions: Record<string, string>;
  /** Starter files that stay with the agent instead of the release. */
  held_back: string[];
}

export interface StarterDeployBody {
  project_id: string;
  base_release_id: null;
  files: Record<string, string>;
  functions: Record<string, string>;
  source: 'mcp';
}

export type StarterDeployAttempt =
  | { kind: 'answered'; status: number; data: unknown }
  | { kind: 'timed_out' }
  | { kind: 'transport_error'; message: string };

export interface ProjectStarterReport {
  /** deployed: a live release; preview: deployed but needs promote; failed:
   *  the deploy route refused; unknown: no answer in time, a transport error,
   *  a 5xx or non-JSON answer, or an answer without a release. */
  status: 'deployed' | 'preview' | 'failed' | 'unknown';
  detail?: 'refused' | 'timed_out' | 'transport_error' | 'upstream_unavailable' | 'malformed_response' | 'requires_promote';
  source: string;
  features: string;
  ui: string;
  description?: string;
  deployed_files?: string[];
  held_back_files?: string[];
  version?: unknown;
  /** Confirmed active release from the completed publication response. */
  release_id?: string;
  url?: unknown;
  error?: unknown;
  /** AGENTS.md from the starter: the project contract deploys never publish. */
  agent_contract?: string;
  /** README.md from the starter: the file map. */
  readme?: string;
  extension_points?: Record<string, string>;
  skills?: { version: string; pack_url: string; skills: ProjectStarterSkill[] };
  /** The same starter from the CLI: `npx <package> <argv…>` writes these bytes. */
  cli_equivalent?: { package: string; argv: string[] };
  next?: string;
  recovery?: {
    check: { tool: string; args: Record<string, unknown> }[];
    note: string;
    redeploy?: { tool: 'project_deploy'; args: { project_id: string; base_release_id: null; files: Record<string, string>; functions: Record<string, string> } };
    redeploy_omitted?: string;
  };
}
