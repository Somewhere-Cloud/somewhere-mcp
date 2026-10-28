/**
 * Deploy-intent signal (pfb_f4794b8175ff): reported after a tool call that
 * names a project (worker POST /v1/mcp-usage/deploy-intent). Since
 * tsk_b1dc17e0 the API only verifies and accepts it: tool calls no longer start
 * or extend a compile container.
 *
 * Fire-and-forget under ctx.waitUntil: never on the tool call's path, and a
 * refusal or failure is logged, never surfaced to the agent. One signal per
 * project per isolate per interval — the worker's lease-extension interval, so
 * an active agent keeps the lease alive and a chatty one costs at most one
 * request per project per interval from each isolate.
 */

/** Matches COMPILE_WARM_SIGNAL_INTERVAL_MS in worker/src/utils/compile-warm-gate.ts. */
export const DEPLOY_INTENT_INTERVAL_MS = 30_000;
const PRUNE_AT = 2_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeployIntentCall {
  /** POSTs the signal for this project with the caller's own credential. */
  post: (projectId: string) => Promise<{ status: number }>;
  waitUntil: (promise: Promise<unknown>) => void;
  log: (message: string) => void;
}

export type DeployIntentSignal = (projectId: string, call: DeployIntentCall) => void;

/** One per isolate: the interval is remembered across requests. */
export function createDeployIntentSignal(now: () => number = Date.now): DeployIntentSignal {
  const recent = new Map<string, number>();
  return (projectId, call) => {
    try {
      if (!UUID_RE.test(projectId)) return;
      const at = now();
      const last = recent.get(projectId);
      if (last !== undefined && at - last < DEPLOY_INTENT_INTERVAL_MS) return;
      if (recent.size >= PRUNE_AT) {
        for (const [id, seen] of recent) {
          if (at - seen >= DEPLOY_INTENT_INTERVAL_MS) recent.delete(id);
        }
      }
      recent.set(projectId, at);
      call.waitUntil(
        call.post(projectId).then(
          (res) => {
            if (res.status !== 202) call.log(`[deploy-intent] warm signal answered ${res.status}`);
          },
          (err: unknown) => call.log(`[deploy-intent] warm signal failed: ${err instanceof Error ? err.message : String(err)}`),
        ),
      );
    } catch (err) {
      call.log(`[deploy-intent] warm signal threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
