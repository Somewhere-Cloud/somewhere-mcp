import { safeFetch } from '../../worker/src/utils/safe-fetch';
import type {
  ConnectorFileDownloader,
  ConnectorFileReference,
  MultipartUploadSession,
  StorageRecord,
} from './types/file-upload';

const MAX_CONNECTOR_FILE_BYTES = 250 * 1024 * 1024;

/** One request carries at most 100 MB, so a larger file uploads in parts. */
export const SINGLE_REQUEST_MAX_BYTES = 90 * 1024 * 1024;

/** The part-upload steps behind multipart_url, in the words of the sw.fs docs. */
export const MULTIPART_UPLOAD_GUIDANCE = Object.freeze({
  when: "One request carries at most 100 MB. A bigger file (up to the plan's per-file limit) goes up in parts through multipart_url: start, send each part, then complete. Pass size_bytes to fs_upload and it starts the upload for you.",
  start: 'POST multipart_url with JSON { size_bytes, content_type } → { upload_id, part_size, part_count, parts_url, complete_url, abort_url, expires_at }.',
  parts: 'PUT each part n = 1..part_count to parts_url + "/" + n. Every part except the last is exactly part_size bytes (at most 90 MB).',
  complete: 'POST complete_url → { path, size_bytes, content_type, version }.',
  notes: "Starting uses up the URL. An upload not completed within 6 hours is discarded, parts included; DELETE abort_url discards it sooner. A file over the plan's limit is refused at start with PAYLOAD_TOO_LARGE.",
});

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  avif: 'image/avif',
  csv: 'text/csv',
  gif: 'image/gif',
  gz: 'application/gzip',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  otf: 'font/otf',
  pdf: 'application/pdf',
  png: 'image/png',
  rar: 'application/vnd.rar',
  svg: 'image/svg+xml',
  tar: 'application/x-tar',
  txt: 'text/plain',
  ttf: 'font/ttf',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
});

export class FileUploadError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly detail?: unknown;

  constructor(code: string, message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = 'FileUploadError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function parseConnectorFileReference(input: unknown, fieldName = 'file'): ConnectorFileReference {
  if (typeof input === 'string') {
    throw new FileUploadError(
      'FILE_REFERENCE_REQUIRED',
      `${fieldName} must be a connector-provided file reference, not a path, base64 string, or text value.`,
      400,
    );
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new FileUploadError(
      'FILE_REFERENCE_REQUIRED',
      `${fieldName} must be a connector-provided file reference.`,
      400,
    );
  }

  const value = input as Record<string, unknown>;
  const downloadUrl = nonEmptyString(value.download_url);
  const fileId = nonEmptyString(value.file_id);
  if (!downloadUrl || !fileId) {
    throw new FileUploadError(
      'FILE_REFERENCE_INVALID',
      `${fieldName} must include connector-issued download_url and file_id values.`,
      400,
    );
  }

  const mimeType = nonEmptyString(value.mime_type);
  const fileName = nonEmptyString(value.file_name);
  return {
    download_url: downloadUrl,
    file_id: fileId,
    ...(mimeType ? { mime_type: mimeType } : {}),
    ...(fileName ? { file_name: fileName } : {}),
  };
}

export function parseConnectorFileReferences(input: unknown): ConnectorFileReference[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new FileUploadError(
      'FILE_REFERENCES_REQUIRED',
      'upload_attachments must be a non-empty array of connector-provided file references.',
      400,
    );
  }
  return input.map((item, index) => parseConnectorFileReference(item, `upload_attachments[${index}]`));
}

function normalizeContentType(value: string | undefined): string | null {
  if (!value) return null;
  const base = value.split(';', 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base)) {
    throw new FileUploadError('CONTENT_TYPE_INVALID', `Invalid content_type: ${value}`, 400);
  }
  return base;
}

function contentTypeFromName(name: string | undefined): string | null {
  if (!name) return null;
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function resolveUploadContentType(
  override: string | undefined,
  file: ConnectorFileReference | undefined,
  destinationPath: string,
): string {
  return normalizeContentType(override)
    ?? normalizeContentType(file?.mime_type)
    ?? contentTypeFromName(file?.file_name)
    ?? contentTypeFromName(destinationPath)
    ?? 'application/octet-stream';
}

export function attachmentFileName(file: ConnectorFileReference, index: number): string {
  const rawName = file.file_name || `${file.file_id || `attachment-${index + 1}`}.bin`;
  const baseName = rawName.split(/[\\/]/).pop() || `attachment-${index + 1}.bin`;
  let safeName = baseName
    .normalize('NFKC')
    .replace(/[\x00-\x1f\x7f]+/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!safeName || safeName === '.' || safeName === '..') safeName = `attachment-${index + 1}.bin`;
  if (safeName.startsWith('.')) safeName = `file${safeName}`;
  if (safeName.length > 180) {
    const dot = safeName.lastIndexOf('.');
    const extension = dot > 0 && safeName.length - dot <= 16 ? safeName.slice(dot) : '';
    safeName = safeName.slice(0, 180 - extension.length) + extension;
  }
  return safeName;
}

export function taskAttachmentPaths(taskId: string, files: ConnectorFileReference[]): string[] {
  const used = new Set<string>();
  return files.map((file, index) => {
    const original = attachmentFileName(file, index);
    const dot = original.lastIndexOf('.');
    const stem = dot > 0 ? original.slice(0, dot) : original;
    const extension = dot > 0 ? original.slice(dot) : '';
    let name = original;
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      name = `${stem}-${suffix}${extension}`;
      suffix++;
    }
    used.add(name.toLowerCase());
    return `/tasks/${taskId}/attachments/${name}`;
  });
}

function apiErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const message = (payload as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function storageRecordFromPayload(payload: unknown): StorageRecord | null {
  if (!payload || typeof payload !== 'object') return null;
  const envelope = payload as Record<string, unknown>;
  const candidate = envelope.data && typeof envelope.data === 'object'
    ? envelope.data as Record<string, unknown>
    : envelope;
  if (
    typeof candidate.path !== 'string'
    || typeof candidate.size_bytes !== 'number'
    || typeof candidate.content_type !== 'string'
    || typeof candidate.version !== 'number'
  ) return null;
  return {
    path: candidate.path,
    size_bytes: candidate.size_bytes,
    content_type: candidate.content_type,
    version: candidate.version,
  };
}

const defaultConnectorFileDownloader: ConnectorFileDownloader = (downloadUrl, maxBytes) =>
  safeFetch(downloadUrl, {
    allowedProtocols: ['https:'],
    maxBytes,
    maxRedirects: 3,
    timeoutMs: 30_000,
  });

/** The worker-internal address of a signed upload URL (or a URL a part upload returned). */
function internalRelayUrl(url: string): string {
  let relayUrl: URL;
  try {
    relayUrl = new URL(url);
  } catch {
    throw new FileUploadError('UPLOAD_RELAY_INVALID', 'The upload relay returned an invalid URL.', 502);
  }
  if (relayUrl.protocol !== 'https:' || !relayUrl.pathname.startsWith('/v1/upload/')) {
    throw new FileUploadError('UPLOAD_RELAY_INVALID', 'The upload relay returned an unexpected target.', 502);
  }
  return `https://api-internal${relayUrl.pathname}${relayUrl.search}`;
}

/** One call to a part-upload route; a refusal keeps the platform's error code. */
async function relayCall(fetcher: Fetcher, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher.fetch(internalRelayUrl(url), init);
  } catch (err) {
    if (err instanceof FileUploadError) throw err;
    throw new FileUploadError(
      'FS_UPLOAD_FAILED',
      'The file upload relay failed before storage confirmed the write.',
      502,
    );
  }
  const responseType = response.headers.get('Content-Type') || '';
  const payload: unknown = responseType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');
  if (!response.ok) {
    const code = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).error : undefined;
    throw new FileUploadError(
      typeof code === 'string' && code ? code : 'FS_UPLOAD_FAILED',
      apiErrorMessage(payload, `The file upload failed (HTTP ${response.status}).`),
      response.status,
      payload,
    );
  }
  return payload;
}

/**
 * Start a part upload through a signed URL's multipart_url. A size over the
 * plan's per-file limit is refused here (413 PAYLOAD_TOO_LARGE) before any
 * file byte moves, and the refused URL stays unused.
 */
export async function startMultipartUpload(
  fetcher: Fetcher,
  multipartUrl: string,
  sizeBytes: number,
  contentType: string,
): Promise<MultipartUploadSession> {
  const payload = await relayCall(fetcher, multipartUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size_bytes: sizeBytes, content_type: contentType }),
  });
  const data = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>).data as Record<string, unknown> | undefined
    : undefined;
  if (
    !data
    || typeof data.upload_id !== 'string'
    || typeof data.part_size !== 'number'
    || typeof data.part_count !== 'number'
    || typeof data.parts_url !== 'string'
    || typeof data.complete_url !== 'string'
    || typeof data.abort_url !== 'string'
    || typeof data.expires_at !== 'string'
  ) {
    throw new FileUploadError('FS_UPLOAD_BAD_RESPONSE', 'The upload relay did not return a valid part upload.', 502, payload);
  }
  return {
    upload_id: data.upload_id,
    size_bytes: sizeBytes,
    part_size: data.part_size,
    part_count: data.part_count,
    parts_url: data.parts_url,
    complete_url: data.complete_url,
    abort_url: data.abort_url,
    expires_at: data.expires_at,
  };
}

/** Exactly `length` bytes from a shared reader; bytes past the part carry over. */
function partStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  length: number,
  carry: { rest: Uint8Array | null },
): ReadableStream<Uint8Array> {
  let remaining = length;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk = carry.rest;
      carry.rest = null;
      if (!chunk) {
        const next = await reader.read();
        if (next.done) {
          controller.error(new FileUploadError('FILE_SIZE_CHANGED', 'The file ended before its declared size; nothing was saved.', 400));
          return;
        }
        chunk = next.value;
      }
      if (chunk.byteLength > remaining) {
        carry.rest = chunk.subarray(remaining);
        chunk = chunk.subarray(0, remaining);
      }
      remaining -= chunk.byteLength;
      controller.enqueue(chunk);
      if (remaining === 0) controller.close();
    },
  });
}

/**
 * Stream a file of known size into a started part upload, one part at a time
 * (never the whole file in memory), then complete it. Any failure discards the
 * upload so no parts are left behind.
 */
export async function uploadStreamInParts(
  fetcher: Fetcher,
  session: MultipartUploadSession,
  body: ReadableStream<Uint8Array>,
): Promise<StorageRecord> {
  const reader = body.getReader();
  const carry: { rest: Uint8Array | null } = { rest: null };
  try {
    for (let n = 1; n <= session.part_count; n += 1) {
      const expected = n < session.part_count
        ? session.part_size
        : session.size_bytes - session.part_size * (session.part_count - 1);
      await relayCall(fetcher, `${session.parts_url}/${n}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(expected) },
        body: partStream(reader, expected, carry),
        duplex: 'half',
      } as RequestInit);
    }
    if ((carry.rest && carry.rest.byteLength > 0) || !(await reader.read()).done) {
      throw new FileUploadError('FILE_SIZE_CHANGED', 'The file is larger than its declared size; nothing was saved.', 400);
    }
    const payload = await relayCall(fetcher, session.complete_url, { method: 'POST' });
    const record = storageRecordFromPayload(payload);
    if (!record) {
      throw new FileUploadError(
        'FS_UPLOAD_BAD_RESPONSE',
        'The upload relay succeeded without returning a valid storage record.',
        502,
        payload,
      );
    }
    return record;
  } catch (err) {
    await reader.cancel().catch(() => {});
    await relayCall(fetcher, session.abort_url, { method: 'DELETE' }).catch(() => {});
    throw err;
  }
}

function declaredLength(response: Response): number | null {
  const raw = response.headers.get('Content-Length');
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function streamConnectorFileToUpload(
  fetcher: Fetcher,
  uploadUrl: string,
  file: ConnectorFileReference,
  contentType: string,
  downloadFile: ConnectorFileDownloader = defaultConnectorFileDownloader,
  maxBytes = MAX_CONNECTOR_FILE_BYTES,
  multipartUrl?: string,
): Promise<StorageRecord> {
  const relayTarget = internalRelayUrl(uploadUrl);
  if (multipartUrl !== undefined) internalRelayUrl(multipartUrl);

  // With a part-upload route, the plan's limit is enforced by the upload
  // itself: a declared size over it is refused at start, before any byte
  // moves, so the download is only held to the largest file any plan takes.
  let source: Response;
  try {
    source = await downloadFile(
      file.download_url,
      multipartUrl === undefined ? Math.min(maxBytes, MAX_CONNECTOR_FILE_BYTES) : MAX_CONNECTOR_FILE_BYTES,
    );
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'SAFE_FETCH_BODY_TOO_LARGE') {
      throw new FileUploadError(
        'PAYLOAD_TOO_LARGE',
        `File exceeds the ${MAX_CONNECTOR_FILE_BYTES / (1024 * 1024)} MB per-file upload limit.`,
        413,
      );
    }
    throw new FileUploadError(
      'FILE_DOWNLOAD_FAILED',
      'The connector file could not be downloaded safely.',
      502,
    );
  }
  if (!source.ok) {
    throw new FileUploadError(
      'FILE_DOWNLOAD_FAILED',
      `The connector file could not be downloaded (HTTP ${source.status}).`,
      source.status,
    );
  }

  const size = declaredLength(source);
  if (multipartUrl !== undefined && size !== null && source.body
    && (size > SINGLE_REQUEST_MAX_BYTES || size > maxBytes)) {
    let session: MultipartUploadSession;
    try {
      session = await startMultipartUpload(fetcher, multipartUrl, size, contentType);
    } catch (err) {
      await source.body.cancel().catch(() => {});
      throw err;
    }
    return uploadStreamInParts(fetcher, session, source.body);
  }

  let uploadResponse: Response;
  try {
    uploadResponse = await fetcher.fetch(
      relayTarget,
      {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: source.body ?? new Uint8Array(0),
      },
    );
  } catch {
    throw new FileUploadError(
      'FS_UPLOAD_FAILED',
      'The file upload relay failed before storage confirmed the write.',
      502,
    );
  }
  const responseType = uploadResponse.headers.get('Content-Type') || '';
  const payload: unknown = responseType.includes('application/json')
    ? await uploadResponse.json().catch(() => null)
    : await uploadResponse.text().catch(() => '');
  if (!uploadResponse.ok) {
    throw new FileUploadError(
      'FS_UPLOAD_FAILED',
      apiErrorMessage(payload, `The file upload failed (HTTP ${uploadResponse.status}).`),
      uploadResponse.status,
      payload,
    );
  }

  const record = storageRecordFromPayload(payload);
  if (!record) {
    throw new FileUploadError(
      'FS_UPLOAD_BAD_RESPONSE',
      'The upload relay succeeded without returning a valid storage record.',
      502,
      payload,
    );
  }
  return record;
}
