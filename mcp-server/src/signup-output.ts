/** Registration metadata is useful in MCP; live signup credentials belong in
 * the app's secure auth flow, not text or structured conversation output. */
const CREDENTIAL_FIELDS = new Set(['token', 'access_token', 'refresh_token', 'session_token', 'mfa_token', 'activation_token']);
function withoutSignupCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSignupCredentials);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !CREDENTIAL_FIELDS.has(key))
    .map(([key, field]) => [key, withoutSignupCredentials(field)]));
}
/** Apply before generic enrichment so neither MCP output format retains tokens. */
export function signupResultForChat<T extends { status: number; data: unknown }>(result: T): T {
  return { ...result, data: withoutSignupCredentials(result.data) };
}
