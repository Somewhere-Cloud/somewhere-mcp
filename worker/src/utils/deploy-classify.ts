/**
 * deploy-classify — the ONE rule both CLI and MCP deploys obey for "what is
 * this file" (tsk_d9b5cb23 / tsk_266a7e6d). It replaces the api/+_lib/ folder
 * heuristic that classified the same .ts file differently depending on which
 * path (CLI vs MCP, deploy vs patch) saw it — the drift that caused the
 * pfb_f8d58b199f96 root-lib source leak + broken cross-file import.
 *
 * Two robust rules, no folder list:
 *
 *   1. Raw TypeScript-family source (.ts/.tsx/.mts/.cts) can never run raw in
 *      a browser, so it is NEVER a public static asset — fail-closed by
 *      extension. Enforced at the store (deploy.ts routes it to _source/
 *      only, never the canonical public path) AND at the serve layer
 *      (web/src/index.ts getR2WithFallback). Defense in depth, ONE rule —
 *      keep isRawTsSource() and that serve-guard regex in sync.
 *
 *   2. What is *server code* is decided by the bundler's import graph
 *      (esbuild reachability from api/ entries), NOT by folder. Every source
 *      module is made available to the function bundler; esbuild inlines what
 *      is actually reachable from an entry. A helper in root lib/ imported by
 *      an api/ route therefore resolves and bundles, exactly like MCP already
 *      did — "cross-file imports work from any folder" becomes true for the
 *      CLI too.
 */

/**
 * Source-code extensions the bundlers read. None of these is a static asset;
 * they are bundler inputs (client or server). Used to decide which incoming
 * `files` entries to expose to the function bundler as resolvable modules.
 */
const SOURCE_MODULE_RE = /\.(?:tsx?|jsx?|mjs|cjs|mts|cts)$/i;
export function isSourceModule(path: string): boolean {
  return SOURCE_MODULE_RE.test(path);
}

/** Text dependency inputs the function compiler actually resolves. JSON is
 *  deliberately explicit rather than part of a growing generic extension
 *  allowlist: the compile worker supports JSON imports and nothing else is
 *  admitted here without that same concrete compiler contract. */
function isFunctionDependencyInput(path: string): boolean {
  return isSourceModule(path) || /\.json$/i.test(path);
}

/**
 * TypeScript-family source: never browser-runnable, so it must never sit at a
 * public canonical path regardless of folder or which bucket (files vs
 * functions) the client placed it in. This is the fail-closed security
 * predicate. MUST stay in sync with the serve-layer guard in
 * web/src/index.ts getR2WithFallback (same extension set).
 */
const RAW_TS_SOURCE_RE = /\.(?:tsx?|mts|cts)$/i;
export function isRawTsSource(path: string): boolean {
  return RAW_TS_SOURCE_RE.test(path);
}

export interface DeploySourcePartition {
  /**
   * Every source module available to the function bundler, keyed by path —
   * the union of `functions` and any source file that arrived in `files`. An
   * api/ entry can import a helper from ANY folder because the helper is in
   * this map; esbuild resolves and inlines it by reachability.
   */
  bundlerModules: Record<string, string>;
  /**
   * Paths that arrived in `files` (not `functions`). After bundling, a
   * files-origin module that was NOT inlined into any server entry must not
   * be uploaded as a phantom standalone function — it is client/orphan source
   * handled by the frontend path. Used to gate the per-file function upload.
   */
  filesOriginPaths: Set<string>;
}

/**
 * Function-routing convention predicate (F-DEPLOY-FN-IN-FILES,
 * pfb_3c5b080f199e). True for a path that the platform routes as a server
 * function: a source module under `api/` or `_lib/`, or a root-level
 * parametric route like `[id].ts` / `[...slug].mjs` — restricted to
 * executable function extensions (`.ts` / `.js` / `.mjs`).
 *
 * Deliberately narrow: a `.tsx`/`.jsx` component, a `.css`, or a `.ts` that
 * is NOT under a function prefix is browser/static source the platform
 * compiles — NOT a function. Mirrors the routability rule the function
 * bundler uses to pick entries; keep the two in sync.
 */
const FUNCTION_ROUTE_EXT_RE = /\.(?:ts|js|mjs)$/i;
export function isFunctionRoutePath(path: string): boolean {
  if (!FUNCTION_ROUTE_EXT_RE.test(path)) return false;
  if (path.startsWith('api/') || path.startsWith('_lib/')) return true;
  // Root-level parametric route, e.g. "[id].ts" or "[...path].mjs".
  if (/^\[[^/]+\]\.(?:ts|js|mjs)$/i.test(path)) return true;
  return false;
}

/**
 * The ONE route rule (pfb_db210a1d6386). A file or folder whose name starts
 * with `_` (`api/_lib.ts`, `api/_lib/club.ts`, `_lib/db.ts`) is an
 * import-only helper: it is bundled into every route that imports it, but it
 * is never registered or served as a route — a request for it is a plain 404.
 */
export function isHelperModulePath(path: string): boolean {
  return path.replace(/^\/+/, '').split('/').some((segment) => segment.startsWith('_'));
}

/**
 * True when a function source file becomes a ROUTE: it sits under `api/` or
 * is a root-level parametric file (`[id].ts`, `[...path].ts`), and it is not
 * a helper (see isHelperModulePath). Every route enumerator — the bundler's
 * router, the compiler's entry list, the touched-route probes — uses this.
 */
export function isRoutedFunctionPath(path: string): boolean {
  if (isHelperModulePath(path)) return false;
  return path.startsWith('api/') || (!path.includes('/') && /\[/.test(path));
}

export interface DeployFilesRerouteResult {
  /** `files` with the rerouted function entries removed — what the deploy
   *  writes as static. A shallow copy; the input is never mutated. */
  files: Record<string, string>;
  /** `functions` with the rerouted entries folded in (explicit functions
   *  win). `undefined` is preserved when nothing routed AND none were
   *  provided, so the caller's "omitted functions are left untouched"
   *  merge-preserve semantics are unchanged for ordinary static deploys. */
  functions: Record<string, string> | undefined;
  /** Paths moved `files` → `functions` (drives the loud auto-route warning). */
  rerouted: string[];
  /** Function-path entries left in `files` because this deploy can't process
   *  functions (scope:'static') — drives a severe will-not-route warning
   *  instead of silently dropping them. */
  staticScopeConflicts: string[];
}

/**
 * F-DEPLOY-FN-IN-FILES (pfb_3c5b080f199e). Handler source mistakenly placed in
 * the static `files` map (an `isFunctionRoutePath` entry — `api/**`, `_lib/**`,
 * or a root `[param]` route with a `.ts`/`.js`/`.mjs` extension) is stored as a
 * static asset and never routes: `/api/*` then silently serves the SPA
 * `index.html` while the deploy reports success — fail-silent in the worst way.
 * Detect those entries and move them into `functions` so they actually route,
 * returning the moved list so the deploy warns loudly (never silent). This is
 * the same auto-routing `project_patch` already applies to a single path.
 *
 * Guards:
 *  - An explicit `functions[path]` always wins — a files-origin duplicate is
 *    left in place (no clobber); the existing bundler partition handles it.
 *  - React components (`.tsx`/`.jsx`) and a `.ts` NOT under a function prefix
 *    are legitimate static source the platform compiles; `isFunctionRoutePath`
 *    rejects them, so they stay in `files` (rule 9 — no over-reach).
 *  - When `doFunctions` is false (scope:'static') this deploy won't process
 *    functions at all; moving an entry would silently drop it, so we leave it
 *    in `files` and report it under `staticScopeConflicts` for a severe
 *    will-not-route warning.
 *
 * Pure — no I/O, returns fresh objects — so it is unit-testable in isolation.
 */
export function rerouteFunctionFilesToFunctions(
  files: Record<string, string>,
  functions: Record<string, string> | undefined,
  doFunctions: boolean,
): DeployFilesRerouteResult {
  const outFiles: Record<string, string> = { ...files };
  let outFunctions: Record<string, string> | undefined = functions ? { ...functions } : undefined;
  const rerouted: string[] = [];
  const staticScopeConflicts: string[] = [];
  for (const [path, src] of Object.entries(files)) {
    if (typeof src !== 'string') continue;
    if (!isFunctionRoutePath(path)) continue;
    // Explicit function entry wins — never clobber it, and leave the
    // duplicate static copy where it is (existing partition handles it).
    if (outFunctions && outFunctions[path] !== undefined) continue;
    if (!doFunctions) {
      staticScopeConflicts.push(path);
      continue;
    }
    if (!outFunctions) outFunctions = {};
    outFunctions[path] = src;
    delete outFiles[path];
    rerouted.push(path);
  }
  return { files: outFiles, functions: outFunctions, rerouted, staticScopeConflicts };
}

/**
 * Build the function bundler's module set from a deploy payload, merging
 * source files that landed in `files` so cross-file imports resolve from any
 * folder. `functions` wins on key collision (it is the explicit server set).
 * Pure — no I/O — so it is unit-testable in isolation.
 */
export function partitionDeploySources(
  files: Record<string, unknown>,
  functions: Record<string, unknown>,
): DeploySourcePartition {
  const bundlerModules: Record<string, string> = {};
  const filesOriginPaths = new Set<string>();
  for (const [path, src] of Object.entries(functions)) {
    if (typeof src === 'string') bundlerModules[path] = src;
  }
  for (const [path, src] of Object.entries(files)) {
    if (typeof src !== 'string') continue;
    if (!isFunctionDependencyInput(path)) continue;
    if (bundlerModules[path] !== undefined) continue; // functions wins
    bundlerModules[path] = src;
    filesOriginPaths.add(path);
  }
  return { bundlerModules, filesOriginPaths };
}

/**
 * FUNCTION_PATH_NOT_ROUTABLE (tsk_490c1e2b). The reverse direction of
 * `rerouteFunctionFilesToFunctions`: a path submitted EXPLICITLY in a deploy's
 * `functions` map (or a patch's `update_functions`) that `isFunctionRoutePath`
 * rejects — e.g. `s/[slug].ts`, a nested parametric route outside `api/`.
 *
 * That state is unrepresentable downstream, because function-ness is decided
 * by PATH everywhere after intake: the release source snapshot stores the
 * entry at its literal path, and every reader re-partitions the snapshot with
 * this same rule. So the entry silently becomes a STATIC file — never routed
 * (the caller's route serves the SPA shell and the deploy reports success),
 * reported as `type: "static"`, and republished as a PUBLIC asset. The
 * serve-layer raw-source guard catches a `.ts` at GET time, but a `.js`/`.mjs`
 * handler is served verbatim as javascript: handler source, public.
 *
 * There is no normalization available: the platform routes `api/**` and
 * root-level parametric files only, so there is no route this path could be
 * moved to without silently rewriting the caller's URL. Hence a refusal at
 * intake, before anything is published.
 *
 * Only entries the caller actually submitted are inspected — a stored map
 * merged in from a previous deploy is not re-judged here, so a project that
 * already holds such an entry can still deploy the correction.
 *
 * Pure — no I/O, returns a fresh array — so it is unit-testable in isolation.
 */
export function unroutableFunctionPaths(
  functions: Record<string, unknown> | undefined | null,
): string[] {
  // A malformed map (array / primitive) is not this rule's business — the
  // existing shape handling owns it, and judging it here would name index
  // keys as if they were paths.
  if (!functions || typeof functions !== 'object' || Array.isArray(functions)) return [];
  const out: string[] = [];
  for (const [path, src] of Object.entries(functions)) {
    // Non-string values are dropped by every downstream consumer already;
    // judging them here would report a path the deploy never carries.
    if (typeof src !== 'string') continue;
    if (isFunctionRoutePath(path)) continue;
    out.push(path);
  }
  return out;
}
