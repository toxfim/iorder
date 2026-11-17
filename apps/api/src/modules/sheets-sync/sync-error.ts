import { DomainError } from '../../common/errors/domain-errors.js';

/**
 * A sync failure with a SAFE message. A PostgreSQL error (for example a CHECK violation) can
 * carry `DETAIL: Failing row contains (...)` with cost columns, and error handlers log stacks,
 * so the sync never rethrows a database error as is. This error keeps only the error code and
 * the constraint name, and deliberately has no `cause`.
 */
export class SyncError extends DomainError {
  readonly code = 'SYNC_FAILED';

  constructor(message: string) {
    super(message);
  }
}

const SAFE_TOKEN = /^[A-Za-z0-9_]{1,63}$/;

function pickSafe(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined;
}

/** Looks for a `constraint` string anywhere in the error's data, a few levels deep. */
function findConstraint(value: unknown, depth = 0): string | undefined {
  if (typeof value !== 'object' || value === null || depth > 4) return undefined;
  const record = value as Record<string, unknown>;
  const direct = pickSafe(record.constraint);
  if (direct) return direct;
  for (const key of ['meta', 'cause', 'driverAdapterError', 'originalError']) {
    const found = findConstraint(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** What may be said about ANY error: its code and constraint name if they look like identifiers. */
export function describeErrorSafely(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown error';
  const record = error as Record<string, unknown>;
  const code = pickSafe(record.code);
  const constraint = findConstraint(error);
  const name = pickSafe(record.name) ?? 'Error';
  return [
    `error ${name}`,
    ...(code ? [`code ${code}`] : []),
    ...(constraint ? [`constraint ${constraint}`] : []),
  ].join(', ');
}

/**
 * The machine-readable code stored in a failed run: the error's own `code` when it looks like an
 * identifier (SYNC_FAILED, SHEET_FORMAT_INVALID, a driver code), else a fixed fallback. Never the
 * message or the stack (they can carry cost rows).
 */
export function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = pickSafe((error as Record<string, unknown>).code);
    if (code) return code;
  }
  return 'UNEXPECTED_ERROR';
}

export function toSyncError(
  error: unknown,
  progress: { chunk: number; chunks: number; committedChunks: number },
): SyncError {
  return new SyncError(
    `Cost reference write failed in chunk ${progress.chunk} of ${progress.chunks} ` +
      `(${progress.committedChunks} earlier chunk(s) were committed and are kept; the sync can be ` +
      `re-run): ${describeErrorSafely(error)}`,
  );
}
