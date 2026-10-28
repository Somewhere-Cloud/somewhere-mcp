/**
 * Shared safe egress fetch — wraps every user-controlled outbound
 * call so SSRF/metadata exfil/DNS-rebinding can't reach private
 * infrastructure.
 *
 * Centralised here because we have at least 8 user-URL surfaces:
 *   - /v1/render (browser page.goto)
 *   - /v1/ai/transcribe (audio_url)
 *   - /v1/webhooks (project webhook delivery)
 *   - /v1/db/webhook (DB change webhooks)
 *   - /v1/inbox (inbox-message webhooks)
 *   - /v1/auth (auth webhooks)
 *   - /v1/jobs, /v1/queue, /v1/cron handlers + completion webhooks
 *
 * Each path used its own ad-hoc validator before. The audit
 * (2026-05-25) found that each was missing at least one of:
 *   - inet_aton-aware IPv4 parsing (so 2130706433 → 127.0.0.1 was
 *     never blocked)
 *   - DNS resolve + IP check (so attacker.example → 169.254.169.254
 *     slipped through)
 *   - redirect target revalidation
 *   - hard byte cap
 *   - hard timeout
 *   - IPv6 metadata / link-local / ULA blocks
 *
 * This module is the Worker's transport. The POLICY it applies —
 * hostname blocklist, URL rules, resolved-address classification, and the
 * customer-visible reason for every denial — lives in `utils/egress-policy.ts`,
 * because the job container (`containers/job-executor`) has to apply the same
 * one and a second copy is how tier 3 drifted into following redirects nobody
 * checked (tsk_f91e7d4a). Patch the policy there; patch the transport here.
 *
 * Callers MUST use `safeFetch()` instead of bare `fetch()` for any URL
 * that came in from a user, project setting, deploy file, or app-user
 * JWT body.
 *
 * Why one helper instead of per-surface:
 *   1. Easier to keep blocklists in sync across surfaces.
 *   2. One place to test against (worker/scripts/test-safe-fetch.mjs).
 *   3. When CF adds a new metadata IP we patch one file, not eight.
 */

import {
  DEFAULT_EGRESS_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
  EgressPolicyError,
  assertSafeRemoteUrlWith,
  dnsQueryUrl,
  headersForCrossOriginHop,
  isSameOrigin,
  type DnsAnswer,
  type EgressPolicyOptions,
} from './egress-policy';

export { assertSafeUrl, isBlockedHost, EgressPolicyError as SafeFetchError } from './egress-policy';

const DEFAULT_TIMEOUT_MS = DEFAULT_EGRESS_TIMEOUT_MS;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export interface SafeFetchOptions extends EgressPolicyOptions {
  /** Total deadline through DNS, redirects and response-body consumption. Default 15s. */
  timeoutMs?: number;
  /** Default 3. Set to 0 to disable redirect following. */
  maxRedirects?: number;
  /** Default 25 MB. */
  maxBytes?: number;
  /** Caller cancellation (for example a job cancelled while its delivery is in
   *  flight). Aborts DNS, the request and body reads with SAFE_FETCH_CANCELLED,
   *  distinct from the deadline's SAFE_FETCH_TIMEOUT. */
  signal?: AbortSignal;
  /** Headers + method + body forwarded to underlying fetch. */
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  /** The trusted executor's binding to the web worker (F1, pfb_1a470ef5d3af). A hop whose URL is a
   *  platform-hosted site (isPlatformHostedTarget) is sent through it with the SAME URL and request;
   *  every other hop, and every hop when this is unset, uses the public fetch. Validation, redirects,
   *  credential stripping, the deadline and the body cap are identical on both. No fallback: a
   *  binding failure is the answer. */
  platformHostFetch?: (input: string, init: RequestInit) => Promise<Response>;
}

/** A platform-hosted site: exactly https://<one label>.somewhere.site, no port, no userinfo. The apex,
 *  deeper names, a trailing dot and lookalike suffixes are not (they take the public fetch). */
const PLATFORM_HOSTED_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.somewhere\.site$/;
export function isPlatformHostedTarget(url: URL): boolean {
  return url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === ''
    && PLATFORM_HOSTED_HOST.test(url.hostname);
}

interface DnsJsonResponse {
  Answer?: DnsAnswer[];
}

// Pin the REAL fetch at module load, before any per-request guard or customer
// module can replace globalThis.fetch. Generated runtime guards now restore the
// shared global in finally blocks, but safeFetch may still run while a guard is
// active and customer code is intentionally allowed to override its own global
// fetch. Platform safe-fetch does its own SSRF checks, so its DoH lookup and
// target request must stay on this out-of-band transport.
const SAFE_FETCH_REAL_FETCH: typeof fetch = globalThis.fetch.bind(globalThis);

async function fetchDnsAnswers(host: string, type: 'A' | 'AAAA', timeoutMs: number, signal?: AbortSignal): Promise<DnsAnswer[]> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 3_000));
  try {
    const response = await SAFE_FETCH_REAL_FETCH(dnsQueryUrl(host, type), {
      headers: { Accept: 'application/dns-json' },
      // Workers do not implement redirect: 'error' (throws TypeError at the
      // edge). Use 'manual'; a DoH endpoint never redirects, and a 3xx would
      // fail the !response.ok check below anyway.
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new EgressPolicyError('SAFE_FETCH_DNS_FAILED', `Could not resolve host ${host}.`);
    }
    const body = await response.json<DnsJsonResponse>().catch(() => null);
    if (!body) throw new EgressPolicyError('SAFE_FETCH_DNS_FAILED', `Could not resolve host ${host}.`);
    return Array.isArray(body.Answer) ? body.Answer : [];
  } catch (err) {
    if (err instanceof EgressPolicyError) throw err;
    throw new EgressPolicyError('SAFE_FETCH_DNS_FAILED', `Could not resolve host ${host}.`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** Resolve A and AAAA through DNS-over-HTTPS. The container tier resolves the
 * same names through the same endpoint (see containers/job-executor). */
async function resolveDnsAnswers(host: string, timeoutMs: number, signal?: AbortSignal): Promise<DnsAnswer[]> {
  return (await Promise.all([
    fetchDnsAnswers(host, 'A', timeoutMs, signal),
    fetchDnsAnswers(host, 'AAAA', timeoutMs, signal),
  ])).flat();
}

/** Validate both the URL syntax/literal host and its current A/AAAA answers.
 * Use this when a downstream provider will fetch the URL on our behalf. */
export async function assertSafeRemoteUrl(rawUrl: string, opts: SafeFetchOptions = {}): Promise<URL> {
  return assertSafeRemoteUrlWith(rawUrl, resolveDnsAnswers, opts);
}

/**
 * Fetch with manual redirect handling so we revalidate every hop.
 * Returns a Response whose body is bounded to maxBytes; bodies that
 * exceed the cap throw SAFE_FETCH_BODY_TOO_LARGE during read.
 *
 * Before the target request, resolve A and AAAA records through DNS-over-
 * HTTPS and reject the hostname if any answer is non-public. Repeat that
 * check for every redirect target. Literal-host validation still runs
 * first so obvious numeric loopback, metadata, and IPv6 ULA attempts are
 * rejected without contacting the target.
 *
 * WHAT CROSSES AN ORIGIN CHANGE (tsk_17632cb8)
 * --------------------------------------------
 * The address check answers "may we connect there". It does not answer "may
 * that party read what we were carrying". Every hop used to re-send the caller's
 * headers and body verbatim, so a handler that answered `302 -> some third
 * party` handed that party the platform's signed invocation envelope — a
 * credential replayable for its whole validity window — plus any Authorization
 * or Cookie and the request body.
 *
 * So, on a hop whose ORIGIN differs from the original request's:
 *   - the invocation envelope, every other `X-Somewhere-*` header, and
 *     Authorization / Proxy-Authorization / Cookie are dropped
 *     (`headersForCrossOriginHop` in utils/egress-policy.ts owns the list, so
 *      the job container drops exactly the same set);
 *   - the body is not re-sent, and Content-Type / Content-Length go with it.
 *
 * The METHOD is deliberately NOT downgraded on 301/302/303 the way a browser
 * downgrades it — see the redirect method rule in utils/egress-policy.ts: the
 * downgrade is what laundered 8,164 never-run jobs into successes
 * (tsk_baf2d1df), and dropping the body outright already gives us the
 * protection the browser rule exists for.
 *
 * Once a chain has left the original origin it never regains the envelope, even
 * if a later hop points back: by then the `Location` chain has been chosen by a
 * third party, and the path it names is not the path the signature covers.
 * A SAME-ORIGIN hop is unchanged — same headers, same method, same body — which
 * is what keeps the tsk_baf2d1df dead-handler case failing instead of being
 * laundered into a success.
 */
/** Where a SAFE_FETCH_TIMEOUT fired (tsk_fad32488). Diagnostic only: durations
 *  and stage names, never URLs, headers or bodies. */
export type SafeFetchStage = 'validate' | 'target_fetch' | 'redirect_validate' | 'body';
export interface SafeFetchTimeoutDetail {
  stage: SafeFetchStage;
  /** Redirect hops already followed when the deadline fired. */
  hop: number;
  /** Time spent in the current stage, and in validation (DNS) overall. */
  stageMs: number;
  validateMs: number;
  elapsedMs: number;
  /** Which transport the current hop used: the executor's web binding or the public fetch. */
  via: 'binding' | 'public';
}

export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const ctrl = new AbortController();
  const timeoutError = new EgressPolicyError('SAFE_FETCH_TIMEOUT', `Timed out after ${timeoutMs}ms.`);
  const startedAt = Date.now();
  let stage: SafeFetchStage = 'validate';
  let stageAt = startedAt;
  let hop = 0;
  let validateMs = 0;
  let via: 'binding' | 'public' = 'public';
  const enter = (next: SafeFetchStage) => { stage = next; stageAt = Date.now(); };
  let failBody: ((error: EgressPolicyError) => void) | undefined;
  const timer = setTimeout(() => {
    const now = Date.now();
    const detail: SafeFetchTimeoutDetail = {
      stage, hop, via, stageMs: now - stageAt,
      validateMs: validateMs + (stage === 'validate' || stage === 'redirect_validate' ? now - stageAt : 0),
      elapsedMs: now - startedAt,
    };
    Object.assign(timeoutError, { detail });
    ctrl.abort(timeoutError);
    failBody?.(timeoutError);
  }, timeoutMs);
  // Set when the caller's signal ends the request, so every abort path below
  // reports SAFE_FETCH_CANCELLED rather than the timeout.
  let cancelledError: EgressPolicyError | null = null;
  const cancelled = () => {
    const error = new EgressPolicyError('SAFE_FETCH_CANCELLED', 'The request was cancelled.');
    cancelledError = error;
    clearTimeout(timer);
    ctrl.abort(error);
    failBody?.(error);
  };
  if (opts.signal?.aborted) cancelled();
  else opts.signal?.addEventListener('abort', cancelled, { once: true });
  const validate = (url: string) => assertSafeRemoteUrlWith(url,
    (host, budget) => resolveDnsAnswers(host, budget, ctrl.signal), opts);
  // Discarded redirect/oversize bodies must not retain a connection. Cancellation
  // itself is best-effort: a remote cleanup cannot extend the caller's deadline.
  const cancelBody = (response: Response | undefined, reason?: unknown) => {
    void response?.body?.cancel(reason).catch(() => undefined);
  };
  let response: Response | undefined;

  try {
    let currentUrl = (await validate(rawUrl)).toString();
    validateMs += Date.now() - stageAt;
    const originalUrl = currentUrl;
    const method = opts.method ?? 'GET';
    let headers = new Headers(opts.headers);
    let body = opts.body ?? null;
    // Sticky: an origin-crossing chain never regains the original credentials.
    let leftOriginalOrigin = false;
    let redirects = 0;

    while (true) {
      ctrl.signal.throwIfAborted();
      enter('target_fetch');
      // Per hop: a validated platform-hosted URL goes through the executor's web binding when it has one.
      const hosted = opts.platformHostFetch && isPlatformHostedTarget(new URL(currentUrl)) ? opts.platformHostFetch : null;
      via = hosted ? 'binding' : 'public';
      try {
        response = await (hosted ?? SAFE_FETCH_REAL_FETCH)(currentUrl, {
          method, headers, body, redirect: 'manual', signal: ctrl.signal,
        });
      } catch (err) {
        if (cancelledError) throw cancelledError;
        if (ctrl.signal.aborted && ctrl.signal.reason instanceof EgressPolicyError) throw ctrl.signal.reason;
        if (ctrl.signal.aborted || (err as Error).name === 'AbortError') throw timeoutError;
        throw new EgressPolicyError('SAFE_FETCH_NETWORK', (err as Error).message);
      }
      ctrl.signal.throwIfAborted();
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        const location = response.headers.get('location') as string;
        cancelBody(response);
        response = undefined;
        if (redirects >= maxRedirects) {
          throw new EgressPolicyError('SAFE_FETCH_TOO_MANY_REDIRECTS', `Exceeded ${maxRedirects} redirects.`);
        }
        const next = new URL(location, currentUrl);
        enter('redirect_validate');
        const validated = (await validate(next.toString())).toString();
        validateMs += Date.now() - stageAt;
        if (!isSameOrigin(originalUrl, validated)) leftOriginalOrigin = true;
        if (leftOriginalOrigin) {
          headers = new Headers(headersForCrossOriginHop(headers));
          body = null;
        }
        currentUrl = validated;
        redirects++;
        hop = redirects;
        continue;
      }

      // HEAD/204 responses have no body to bound. Content-Length on HEAD may
      // describe a large resource without delivering any of those bytes.
      if (!response.body) {
        clearTimeout(timer);
        return response;
      }
      const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
      if (contentLength > 0 && contentLength > maxBytes) {
        throw new EgressPolicyError('SAFE_FETCH_BODY_TOO_LARGE',
          `Response declared ${contentLength} bytes, cap is ${maxBytes}.`);
      }

      enter('body');
      const reader = response.body.getReader();
      let received = 0;
      let finished = false;
      const finish = (cancel: boolean, reason?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        failBody = undefined;
        if (cancel) {
          ctrl.abort(reason);
          void reader.cancel(reason).catch(() => undefined);
        }
        reader.releaseLock();
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          failBody = (error) => {
            finish(true, error);
            controller.error(error);
          };
        },
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (finished) return;
            if (done) { finish(false); controller.close(); return; }
            received += value.byteLength;
            if (received > maxBytes) {
              const error = new EgressPolicyError('SAFE_FETCH_BODY_TOO_LARGE',
                `Response exceeded ${maxBytes} bytes.`);
              finish(true, error);
              controller.error(error);
              return;
            }
            controller.enqueue(value);
          } catch (error) {
            if (finished) return;
            finish(true, error);
            controller.error(error);
          }
        },
        cancel(reason) { finish(true, reason); },
      });
      return new Response(stream, { status: response.status, headers: response.headers });
    }
  } catch (error) {
    const failure = cancelledError ?? (ctrl.signal.aborted ? timeoutError : error);
    clearTimeout(timer);
    ctrl.abort(failure);
    cancelBody(response, failure);
    throw failure;
  }
}
