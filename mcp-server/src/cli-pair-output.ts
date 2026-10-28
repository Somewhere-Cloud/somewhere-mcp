/**
 * auth_cli_pair output for chat (tsk_b07f1dac item 2).
 *
 * POST /v1/keys/cli-pair also mints a 30-day refresh token. The CLI's own
 * sign-in flows (browser callback, device code, claim handoff) store that
 * refresh token straight into the CLI config; nothing reads it from MCP
 * output, and `somewhere auth set` accepts only the smt_ key. Returning it
 * through a tool result only copies a month-long credential into the
 * conversation. The 24-hour key, its id and expiry are kept, so the
 * documented `somewhere auth set` handoff is unchanged.
 */
const REFRESH_FIELDS = ['refresh_token', 'refresh_expires_at', 'refresh_ttl_seconds'] as const;

function withoutRefresh(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (!(REFRESH_FIELDS as readonly string[]).includes(key)) out[key] = field;
  }
  return out;
}

/** The cli-pair upstream result with every refresh field removed, at the top
 *  level and inside the `{ ok, data }` envelope. Errors pass through. */
export function cliPairResultForChat<T extends { status: number; data: unknown }>(result: T): T {
  const body = result.data;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return result;
  const stripped = withoutRefresh(body) as Record<string, unknown>;
  if (stripped.data && typeof stripped.data === 'object') stripped.data = withoutRefresh(stripped.data);
  return { ...result, data: stripped };
}
