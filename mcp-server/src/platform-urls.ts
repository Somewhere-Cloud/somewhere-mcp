/**
 * Platform URLs the MCP server generates at runtime (links, WebSocket and OAuth
 * start URLs, the runner fallback). They name somewhere.cloud: the public
 * somewhere.tech API, MCP and runner hosts are retired by the cutoff.
 * Caller-supplied URLs are passed through by the callers, never rewritten here.
 */
export const DASHBOARD_URL = 'https://somewhere.cloud/dashboard';
export const RUNNER_FALLBACK_URL = 'https://runner.somewhere.cloud';
const API_ORIGIN = 'https://api.somewhere.cloud';
const API_WS_ORIGIN = 'wss://api.somewhere.cloud';

/** Project system-event WebSocket for one project. */
export function projectEventsWebSocketUrl(projectId: string, token: string): string {
  return `${API_WS_ORIGIN}/v1/events/subscribe?project_id=${encodeURIComponent(projectId)}&channel=system:project&token=${encodeURIComponent(token)}`;
}

/** The caller's own user-event WebSocket. */
export function userEventsWebSocketUrl(token: string): string {
  return `${API_WS_ORIGIN}/v1/events/subscribe-user?token=${encodeURIComponent(token)}`;
}

/** Start of an app user's Google sign-in for one project. */
export function googleAuthStartUrl(projectId: string, redirectUri: string): string {
  return `${API_ORIGIN}/v1/auth/google?project_id=${encodeURIComponent(projectId)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

/** Dashboard checkout for a previewed domain purchase. */
export function dashboardDomainCheckoutUrl(projectId: string, domain: string): string {
  return `${DASHBOARD_URL}/projects/${encodeURIComponent(projectId)}?tab=domains&buy=${encodeURIComponent(domain)}`;
}

/** Where GitHub returns the browser: the caller's URL exactly as given, else the dashboard. */
export function githubReturnTo(callerValue: unknown): string {
  return typeof callerValue === 'string' ? callerValue : DASHBOARD_URL;
}

/** An explicitly configured runner base wins; otherwise the public cloud runner. */
export function runnerBaseUrl(configured: string | undefined): string {
  return configured || RUNNER_FALLBACK_URL;
}

/**
 * Bearer realm for a 401 from this MCP host: the platform domain of the
 * identity that answered (somewhere.cloud from mcp.somewhere.cloud,
 * somewhere.tech from mcp.somewhere.tech until that host is retired).
 */
export function mcpRealm(resourceMetadataUrl: string): string {
  return new URL(resourceMetadataUrl).hostname.replace(/^mcp\./, '');
}
