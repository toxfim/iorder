import { HttpException, HttpStatus } from '@nestjs/common';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  InputValidationError,
  NotFoundError,
  RateLimitedError,
  UnauthenticatedError,
  UnprocessableError,
  type AnyConflictReason,
} from './domain-errors.js';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    /** Only on CONFLICT. */
    reason?: AnyConflictReason;
    details?: unknown;
  };
}

export interface ErrorResponse {
  status: number;
  body: ErrorBody;
  /** Extra response headers, for example Retry-After on 429. */
  headers?: Record<string, string>;
}

function statusForDomainError(error: DomainError): number {
  if (error instanceof InputValidationError) return HttpStatus.UNPROCESSABLE_ENTITY;
  if (error instanceof UnprocessableError) return HttpStatus.UNPROCESSABLE_ENTITY;
  if (error instanceof NotFoundError) return HttpStatus.NOT_FOUND;
  if (error instanceof ConflictError) return HttpStatus.CONFLICT;
  if (error instanceof UnauthenticatedError) return HttpStatus.UNAUTHORIZED;
  if (error instanceof RateLimitedError) return HttpStatus.TOO_MANY_REQUESTS;
  if (error instanceof ForbiddenError) return HttpStatus.FORBIDDEN;
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

/**
 * The body parser (body-parser, behind Express) rejects an oversized body with its own error
 * object, which is not an HttpException. Matched by its stable `type` tag.
 */
export function isPayloadTooLarge(exception: unknown): boolean {
  return (
    typeof exception === 'object' &&
    exception !== null &&
    (exception as { type?: unknown }).type === 'entity.too.large'
  );
}

/** The one text for every request the server could not read; never the parser's own message. */
const MALFORMED_REQUEST_MESSAGE = 'Request could not be read';

/**
 * The other refusals of the body parser (unsupported charset or encoding, an aborted request...)
 * are plain objects with a `type` tag and a 4xx `status`, not HttpExceptions (only the JSON
 * SyntaxError is wrapped by the Express adapter). They are the client's mistake: answered 400
 * with the fixed message, so they are neither logged with a stack nor echoed.
 */
export function isBodyParserClientError(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) return false;
  const { type, status } = exception as { type?: unknown; status?: unknown };
  return (
    typeof type === 'string' &&
    /^(entity|charset|encoding|request|stream|parameters)\./.test(type) &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
  );
}

/** The single place where errors become HTTP responses. Never exposes stacks or internals. */
export function toErrorResponse(exception: unknown): ErrorResponse {
  if (exception instanceof DomainError) {
    const status = statusForDomainError(exception);
    if (status < 500) {
      return {
        status,
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            ...(exception instanceof ConflictError ? { reason: exception.reason } : {}),
            ...(exception.details === undefined ? {} : { details: exception.details }),
          },
        },
        ...(exception instanceof RateLimitedError
          ? { headers: { 'Retry-After': String(exception.retryAfterSeconds) } }
          : {}),
      };
    }
  }

  if (isPayloadTooLarge(exception)) {
    return {
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      body: { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } },
    };
  }

  if (isBodyParserClientError(exception)) {
    return {
      status: HttpStatus.BAD_REQUEST,
      body: { error: { code: 'BAD_REQUEST', message: MALFORMED_REQUEST_MESSAGE } },
    };
  }

  if (exception instanceof HttpException) {
    // Framework errors: an unknown route (404) or a request Express could not read (400). The
    // app itself never throws these (it throws DomainErrors), so a 400 here is always the
    // adapter's wrap of a JSON SyntaxError or a URIError, whose message quotes the input: it
    // is replaced by the same fixed text as above so a mistyped sign-in body is never echoed.
    const status = exception.getStatus();
    if (status < 500) {
      const message =
        status === HttpStatus.BAD_REQUEST ? MALFORMED_REQUEST_MESSAGE : exception.message;
      return {
        status,
        body: { error: { code: HttpStatus[status] ?? 'HTTP_ERROR', message } },
      };
    }
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
  };
}
