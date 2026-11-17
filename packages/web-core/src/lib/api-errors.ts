// Typed errors raised by API adapters. The UI maps them to screen states in one place
// (useAsyncView) instead of inspecting messages or status codes in every page.

import type { ConflictReason } from '@iorder/shared';

export class ApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiError';
  }
}

/** The server answered 401/403: the caller may not see this resource. */
export class PermissionDeniedError extends ApiError {
  constructor(message = 'Permission denied', options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * 401 specifically: the caller is not authenticated at all (for a Mini App: not a member of an
 * active group). A 403 stays a plain PermissionDeniedError, a refusal of one action.
 */
export class UnauthenticatedError extends PermissionDeniedError {
  constructor(message = 'Not authenticated', options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnauthenticatedError';
  }
}

/** The server answered with its standard error body (`{ error: { code, message, details } }`). */
export class ApiResponseError extends ApiError {
  constructor(
    message: string,
    readonly status: number,
    /** Machine-readable code from the shared ERROR_CODES (or a framework status name). */
    readonly code: string,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApiResponseError';
  }
}

/**
 * 429: too many requests. `retryAfterSeconds` comes from the `Retry-After` header (whole seconds
 * only; a missing or unreadable header gives a conservative default so a countdown can still run).
 */
export class ApiRateLimitedError extends ApiResponseError {
  constructor(
    message: string,
    code: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message, 429, code);
    this.name = 'ApiRateLimitedError';
  }
}

/** 404: the resource (or a product named in `details.productIds`) does not exist. */
export class ApiNotFoundError extends ApiResponseError {
  constructor(message: string, code: string, details?: unknown) {
    super(message, 404, code, details);
    this.name = 'ApiNotFoundError';
  }
}

/**
 * 409: valid request, but it conflicts with the current state. `reason` is the machine-readable
 * cause from the shared CONFLICT_REASONS; it is undefined when the server sent none or a value
 * this client does not know (callers must then fall back to a generic message).
 */
export class ApiConflictError extends ApiResponseError {
  constructor(
    message: string,
    code: string,
    details?: unknown,
    readonly reason?: ConflictReason,
  ) {
    super(message, 409, code, details);
    this.name = 'ApiConflictError';
  }
}

export interface FieldIssue {
  /** Dotted path in the request body, for example `items.3.basePrice`. */
  readonly path: string;
  readonly message: string;
}

/**
 * 422: the request body failed validation; `issues` say which field. `details` keeps the body's
 * raw details: a 422 about a whole file (`details.reason`) or about rows of an import
 * (`details.rows`) carries no field issues, and a caller reads those payloads from here.
 */
export class ApiValidationError extends ApiResponseError {
  constructor(
    message: string,
    code: string,
    readonly issues: readonly FieldIssue[],
    details: unknown = issues,
  ) {
    super(message, 422, code, details);
    this.name = 'ApiValidationError';
  }
}

/** The server answered 2xx but the body is not what the shared contract promises. */
export class InvalidResponseError extends ApiError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidResponseError';
  }
}

/** The request never produced an HTTP answer (offline, DNS, CORS, aborted). */
export class NetworkError extends ApiError {
  constructor(message = 'Network request failed', options?: ErrorOptions) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

/** The request did not finish in time and was aborted by the client. */
export class RequestTimeoutError extends NetworkError {
  constructor(message = 'Request timed out', options?: ErrorOptions) {
    super(message, options);
    this.name = 'RequestTimeoutError';
  }
}
