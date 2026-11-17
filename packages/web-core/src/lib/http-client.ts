import {
  buildPath,
  conflictReasonSchema,
  errorBodySchema,
  validationIssueSchema,
  type ConflictReason,
  type RouteSpec,
} from '@iorder/shared';
import {
  ApiConflictError,
  ApiError,
  ApiNotFoundError,
  ApiRateLimitedError,
  ApiResponseError,
  ApiValidationError,
  InvalidResponseError,
  NetworkError,
  PermissionDeniedError,
  RequestTimeoutError,
  UnauthenticatedError,
  type FieldIssue,
} from './api-errors';
import { markAppOutdated } from './app-outdated';

/**
 * Anything with zod's `safeParse` shape. Declared structurally so the web app does not need its
 * own zod dependency: the schemas come from @iorder/shared, which owns it.
 */
export interface ResponseSchema<T> {
  safeParse: (data: unknown) => { success: true; data: T } | { success: false; error: unknown };
}

interface CommonRequestOptions {
  /** Values for `:param` placeholders of the route path. */
  readonly params?: Readonly<Record<string, string>>;
  /** Query string values; `undefined` entries are left out. */
  readonly query?: Readonly<Record<string, string | undefined>>;
  /** Extra request headers for this call only (for example `Idempotency-Key`). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Deadline of this call only (a large upload); defaults to the client's. */
  readonly timeoutMs?: number;
}

/** A JSON body or a multipart form, never both (a type error). */
export type RequestOptions = CommonRequestOptions &
  (
    | {
        /** Sent as JSON. */
        readonly body?: unknown;
        readonly form?: never;
      }
    | {
        /**
         * Sent as multipart/form-data (a file upload). The browser writes the Content-Type with
         * its boundary, so none is set here.
         */
        readonly form: FormData;
        readonly body?: never;
      }
  );

/** A binary 2xx answer (an attachment such as the price list .xlsx). */
export interface DownloadedFile {
  readonly blob: Blob;
  /** From `Content-Disposition`; null when the server named no file (the caller picks one). */
  readonly fileName: string | null;
}

export interface HttpClient {
  /** Every 2xx body is parsed with `schema`; a mismatch is an InvalidResponseError. */
  request: <T>(spec: RouteSpec, schema: ResponseSchema<T>, options?: RequestOptions) => Promise<T>;
  /** For routes that answer 204 No Content. */
  requestVoid: (spec: RouteSpec, options?: RequestOptions) => Promise<void>;
  /** For routes that answer a file; errors are the same typed errors as `request`. */
  requestFile: (spec: RouteSpec, options?: RequestOptions) => Promise<DownloadedFile>;
}

export interface HttpClientConfig {
  /** For example `https://api.example.uz`; empty means same origin. Trailing slashes are ignored. */
  readonly baseUrl: string;
  /** Injected so tests can run without a network. */
  readonly fetchImpl?: typeof fetch;
  /** Deadline for one request; defaults to REQUEST_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /** Headers added to every request, read at call time (for example `Authorization: tma ...`). */
  readonly defaultHeaders?: () => Readonly<Record<string, string>>;
}

/** A request that takes longer than this is abandoned and reported as a timeout. */
export const REQUEST_TIMEOUT_MS = 30_000;

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function toIssues(details: unknown): FieldIssue[] {
  if (!Array.isArray(details)) return [];
  const issues: FieldIssue[] = [];
  for (const item of details) {
    const parsed = validationIssueSchema.safeParse(item);
    if (parsed.success) issues.push(parsed.data);
  }
  return issues;
}

interface ReadError {
  readonly code: string;
  readonly message: string;
  readonly details: unknown;
  readonly reason: ConflictReason | undefined;
}

/**
 * Reads the shared error body. A body that only fails the strict schema because of a `reason`
 * this client does not know (a newer server) is still read: the status and code stay useful and
 * the unknown reason becomes undefined, which callers treat as "generic conflict".
 */
function readErrorBody(value: unknown): ReadError | null {
  const strict = errorBodySchema.safeParse(value);
  if (strict.success) {
    const { code, message, details, reason } = strict.data.error;
    return { code, message, details, reason };
  }
  if (typeof value !== 'object' || value === null || !('error' in value)) return null;
  const error: unknown = value.error;
  if (typeof error !== 'object' || error === null) return null;
  const { code, message, details, reason } = error as Record<string, unknown>;
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  const known = conflictReasonSchema.safeParse(reason);
  return { code, message, details, reason: known.success ? known.data : undefined };
}

/** Used when a 429 carries no readable `Retry-After`. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 3600;

/** Whole seconds only (the api sends no HTTP-date); anything else falls back to the default. */
function readRetryAfter(header: string | null): number {
  if (header === null || !/^\d{1,6}$/.test(header.trim())) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(Math.max(Number(header), 1), MAX_RETRY_AFTER_SECONDS);
}

/** The one place where an HTTP failure becomes a typed error. */
function toError(status: number, text: string, retryAfter: string | null): Error {
  const json = parseJson(text);
  const body = json.ok ? readErrorBody(json.value) : null;
  if (status === 429) {
    return new ApiRateLimitedError(
      body?.message ?? 'Too many requests',
      body?.code ?? 'RATE_LIMITED',
      readRetryAfter(retryAfter),
    );
  }
  if (!body) {
    // Not our error body (proxy page, framework error): keep the status, drop the text.
    if (status === 401) return new UnauthenticatedError();
    return status === 403
      ? new PermissionDeniedError()
      : new ApiResponseError(`HTTP ${status}`, status, 'UNKNOWN');
  }
  const { code, message, details, reason } = body;
  if (status === 401) return new UnauthenticatedError(message);
  if (status === 403) return new PermissionDeniedError(message);
  if (status === 404) return new ApiNotFoundError(message, code, details);
  if (status === 409) return new ApiConflictError(message, code, details, reason);
  if (status === 422) return new ApiValidationError(message, code, toIssues(details), details);
  return new ApiResponseError(message, status, code, details);
}

function buildQuery(query: RequestOptions['query']): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) search.set(key, value);
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * The file name of a `Content-Disposition` header: the RFC 5987 `filename*=UTF-8''...` form wins
 * over the plain `filename="..."`. Path parts are dropped, so a name can never point elsewhere.
 */
export function fileNameFromContentDisposition(header: string | null): string | null {
  if (header === null) return null;
  let name: string | null = null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended?.[2]) {
    try {
      name = decodeURIComponent(extended[2].trim().replace(/^"(.*)"$/, '$1'));
    } catch {
      name = null;
    }
  }
  if (name === null) {
    const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
    const quoted = plain?.[1];
    const bare = plain?.[2];
    // Only a quoted string has quoted-pairs (`\"`); a bare token is taken as it is.
    if (quoted !== undefined) name = quoted.replace(/\\(.)/g, '$1');
    else if (bare !== undefined) name = bare.trim();
  }
  const base = name?.split(/[\\/]/).pop()?.trim() ?? '';
  return base === '' || base === '.' || base === '..' ? null : base;
}

function rethrowClearingOutdated(caught: unknown): never {
  markAppOutdated(false);
  throw caught;
}

export function createHttpClient(config: HttpClientConfig): HttpClient {
  const base = config.baseUrl.replace(/\/+$/, '');

  const timeoutMs = config.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function send(
    url: string,
    spec: RouteSpec,
    options: RequestOptions,
    signal: AbortSignal,
    accept: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: accept,
      ...config.defaultHeaders?.(),
      ...options.headers,
    };
    const hasBody = options.body !== undefined;
    if (hasBody) headers['Content-Type'] = 'application/json';
    // Resolved at call time so a test (or the page) replacing globalThis.fetch is honoured.
    const doFetch = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    return doFetch(url, {
      method: spec.method,
      headers,
      body: options.form ?? (hasBody ? JSON.stringify(options.body) : undefined),
      signal,
    });
  }

  // One deadline covers the whole exchange (connect, headers and body), so a hung request cannot
  // lock the screen that waits for it. A plain setTimeout (not AbortSignal.timeout) keeps it
  // controllable with fake timers.
  async function exchange<T>(
    spec: RouteSpec,
    options: RequestOptions,
    accept: string,
    readBody: (response: Response) => Promise<T>,
  ): Promise<T> {
    // Built first: a missing path parameter is a programming error, not a network failure.
    const url = `${base}${buildPath(spec, options.params)}${buildQuery(options.query)}`;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? timeoutMs);
    try {
      const response = await send(url, spec, options, controller.signal, accept);
      if (!response.ok) {
        const text = await response.text();
        throw toError(response.status, text, response.headers.get('Retry-After'));
      }
      return await readBody(response);
    } catch (caught) {
      if (timedOut) throw new RequestTimeoutError(undefined, { cause: caught });
      // Our own typed errors pass through; everything else never produced an HTTP answer.
      if (caught instanceof ApiError) throw caught;
      throw new NetworkError(undefined, { cause: caught });
    } finally {
      clearTimeout(timer);
    }
  }

  const readOk = (spec: RouteSpec, options: RequestOptions): Promise<string> =>
    exchange(spec, options, 'application/json', (response) => response.text());

  return {
    async request(spec, schema, options = {}) {
      const text = await readOk(spec, options).catch(rethrowClearingOutdated);
      const json = parseJson(text);
      if (!json.ok) {
        markAppOutdated(true);
        throw new InvalidResponseError(`${spec.method} ${spec.path}: body is not JSON`);
      }
      const parsed = schema.safeParse(json.value);
      if (!parsed.success) {
        markAppOutdated(true);
        throw new InvalidResponseError(`${spec.method} ${spec.path}: unexpected response shape`, {
          cause: parsed.error,
        });
      }
      markAppOutdated(false);
      return parsed.data;
    },
    async requestVoid(spec, options = {}) {
      await readOk(spec, options).catch(rethrowClearingOutdated);
    },
    async requestFile(spec, options = {}) {
      const file = await exchange(spec, options, '*/*', async (response) => ({
        blob: await response.blob(),
        fileName: fileNameFromContentDisposition(response.headers.get('Content-Disposition')),
      })).catch(rethrowClearingOutdated);
      markAppOutdated(false);
      return file;
    },
  };
}
