/**
 * The published MCP protected resources and the audience each one grants
 * (tsk_2019e832). One table for the authorization server (worker) and the
 * resource server (mcp-server), so the two can never disagree about what a
 * token's `aud` means.
 *
 * Every connector access token carries exactly one of these resources as
 * `aud`. There is no unscoped connector token: a client that does not name a
 * resource is granted the full surface, and only after the user approves that
 * on the consent page.
 */
export type McpSurface = 'full' | 'connector' | 'chatgpt';

export const FULL_MCP_RESOURCE = 'https://mcp.somewhere.tech/mcp';

/** Exact match only: an audience is an identity, never a prefix. */
export const MCP_RESOURCE_SURFACES: Readonly<Record<string, McpSurface>> = Object.freeze({
  [FULL_MCP_RESOURCE]: 'full',
  'https://mcp.somewhere.cloud/mcp': 'full',
  'https://mcp.somewhere.cloud/mcp/connector': 'connector',
  'https://mcp.somewhere.cloud/mcp/chatgpt': 'chatgpt',
  'https://mcp.somewhere.tech/mcp/connector': 'connector',
  'https://mcp.somewhere.tech/mcp/chatgpt': 'chatgpt',
});

export function surfaceForResource(resource: unknown): McpSurface | null {
  return typeof resource === 'string' && Object.hasOwn(MCP_RESOURCE_SURFACES, resource)
    ? MCP_RESOURCE_SURFACES[resource]
    : null;
}

/** Curated surfaces grant a subset of the full toolset. */
export function isCuratedSurface(surface: McpSurface | null): boolean {
  return surface === 'connector' || surface === 'chatgpt';
}

/**
 * The run_code execution policy a surface's grant requires. The connector
 * surface's run_code runs under the connector runtime restriction; the other
 * surfaces impose none. The agent surface sends this policy and the runner
 * derives it from the token's audience, so a connector grant cannot drop the
 * restriction by calling the runner directly.
 */
export function runCodeExecutionPolicyForSurface(surface: McpSurface): 'connector' | undefined {
  return surface === 'connector' ? 'connector' : undefined;
}

export interface McpIdentity { issuer: string; apiOrigin: string; fullResource: string }
const TECH_IDENTITY: McpIdentity = Object.freeze({ issuer: 'https://mcp.somewhere.tech', apiOrigin: 'https://api.somewhere.tech', fullResource: FULL_MCP_RESOURCE });
const CLOUD_IDENTITY: McpIdentity = Object.freeze({ issuer: 'https://mcp.somewhere.cloud', apiOrigin: 'https://api.somewhere.cloud', fullResource: 'https://mcp.somewhere.cloud/mcp' });

export function mcpIdentityForApiOrigin(origin: string): McpIdentity | null {
  return origin === TECH_IDENTITY.apiOrigin ? TECH_IDENTITY : origin === CLOUD_IDENTITY.apiOrigin ? CLOUD_IDENTITY : null;
}
export function mcpIdentityForIssuer(origin: string): McpIdentity | null {
  return origin === TECH_IDENTITY.issuer ? TECH_IDENTITY : origin === CLOUD_IDENTITY.issuer ? CLOUD_IDENTITY : null;
}
export function mcpIdentityForResource(resource: unknown): McpIdentity | null {
  if (!surfaceForResource(resource)) return null;
  return mcpIdentityForIssuer(new URL(resource as string).origin);
}
export function mcpResourceMatchesApi(resource: unknown, requestUrl: string): boolean {
  const identity = mcpIdentityForResource(resource);
  return identity !== null && identity.apiOrigin === new URL(requestUrl).origin;
}
