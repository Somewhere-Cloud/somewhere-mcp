/** Deliver the connection-telemetry write with bounded retries. Returns null
 *  on success, or the last failure. A refused or failed telemetry write never
 *  fails the caller's MCP connection; the caller must log what this returns. */
export async function deliverClientSession(
  send: () => Promise<{ status: number }>,
  attempts = 2,
): Promise<string | null> {
  let lastFailure = 'unknown failure';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await send();
      if (response.status === 200) return null;
      lastFailure = `status=${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }
  return lastFailure;
}
