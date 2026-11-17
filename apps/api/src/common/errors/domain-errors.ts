import type { ConflictReason, MembershipConflictReason } from '@iorder/shared';

/** Thrown by services. HTTP status mapping lives only in `to-error-response.ts`. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
}

export type AnyConflictReason = ConflictReason | MembershipConflictReason;

/**
 * The request is valid but conflicts with current state, e.g. an illegal order transition.
 * Every conflict names a machine-readable reason (CONFLICT_REASONS in @iorder/shared).
 */
export class ConflictError extends DomainError {
  readonly code = 'CONFLICT';

  constructor(
    message: string,
    readonly reason: AnyConflictReason,
    details?: unknown,
  ) {
    super(message, details);
  }
}

/**
 * The request is well-formed but its CONTENT cannot be processed: a price list import file that is
 * not an .xlsx or has the wrong headers, or import rows that fail the row checks. Mapped to 422
 * like a validation error, with its own `code` so a client can tell the two apart; `details` carries
 * the machine-readable parts (`reason`, `rows`).
 */
export class UnprocessableError extends DomainError {
  constructor(
    readonly code: string,
    message: string,
    details?: unknown,
  ) {
    super(message, details);
  }
}

/** No actor could be resolved for the request. Distinct from ForbiddenError (known actor, not allowed). */
export class UnauthenticatedError extends DomainError {
  readonly code = 'UNAUTHENTICATED';
}

/**
 * Stored data (a setting, a JSON column) does not have the expected shape. A server-side fault:
 * mapped to a generic 500. The message names WHAT is corrupt, never the stored value.
 */
export class CorruptSettingError extends DomainError {
  readonly code = 'CORRUPT_SETTING';
}

/** Too many attempts; the body names no account and no reason beyond the wait. Mapped to 429. */
export class RateLimitedError extends DomainError {
  readonly code = 'RATE_LIMITED';

  constructor(readonly retryAfterSeconds: number) {
    super('Too many attempts, try again later', { retryAfterSeconds });
  }
}

export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
}

export interface InputIssue {
  path: string;
  message: string;
}

export class InputValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED';

  constructor(readonly issues: InputIssue[]) {
    super('Request validation failed', issues);
  }
}
