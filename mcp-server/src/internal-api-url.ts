/**
 * The one way the agent surface builds a URL for the platform API over its
 * service binding (tsk_2019e832).
 *
 * Requests on `https://api-internal` are trusted by the API as coming from this
 * surface, which has already enforced the caller's tool list. A path built from
 * tool input must therefore reach exactly the route it was built for. URL
 * parsing can move a request to a different route in only these ways, so each
 * is refused before any fetch:
 *   - dot segments, raw or percent-encoded (`..`, `.%2e`, `%2E%2E`, `.`);
 *   - backslashes, which an https URL treats as path separators;
 *   - ASCII tab, line feed and carriage return (and other C0 controls), which
 *     URL parsing silently deletes (`.\t.` becomes `..`);
 *   - spaces that parsing trims from the end of the input (`/x/.. ` becomes
 *     `/x/..`): a segment that is a dot segment once its spaces (raw or `%20`)
 *     are removed is refused, and every other literal space is percent-encoded
 *     here so it is never trimmed (a file named `a ` stays `a `).
 * As a final check, parsing must keep every segment. Anything else, including
 * an encoded slash inside an encoded identifier and non-ASCII characters
 * (which parsing only percent-encodes), keeps its route and is allowed.
 */
export const INTERNAL_API_ORIGIN = 'https://api-internal';

export class InternalApiPathError extends Error {
  readonly code = 'INVALID_PATH';
  constructor(message = 'The request path is not a canonical platform path.') {
    super(message);
    this.name = 'InternalApiPathError';
  }
}

function isDotSegment(segment: string): boolean {
  const dots = segment.replace(/%2e/gi, '.').replace(/%20/g, ' ').trim();
  return dots === '.' || dots === '..';
}

/**
 * `path` is an absolute API path with an optional query. Throws
 * InternalApiPathError unless the path is canonical and its parsed pathname
 * stays under `requiredPrefix`.
 */
export function internalApiUrl(path: string, requiredPrefix = '/'): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new InternalApiPathError();
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new InternalApiPathError();
  const end = path.search(/[?#]/);
  const pathname = end < 0 ? path : path.slice(0, end);
  const segments = pathname.split('/');
  if (segments.some(isDotSegment)) throw new InternalApiPathError();
  const url = INTERNAL_API_ORIGIN + path.replace(/ /g, '%20');
  const parsed = new URL(url);
  if (parsed.origin !== INTERNAL_API_ORIGIN || !parsed.pathname.startsWith(requiredPrefix)
    || parsed.pathname.split('/').length !== segments.length) throw new InternalApiPathError();
  return url;
}

/**
 * A file route for one project. The file path is caller input inside the
 * file route, so it may not carry its own query or fragment either.
 */
export function internalFsUrl(projectId: string, filePath: string, query = ''): string {
  if (/[?#]/.test(filePath)) throw new InternalApiPathError('A file path cannot contain "?" or "#".');
  const prefix = `/v1/fs/${encodeURIComponent(projectId)}/`;
  return internalApiUrl(prefix + filePath + query, prefix);
}
