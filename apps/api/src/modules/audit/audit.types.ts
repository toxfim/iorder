export type AuditValue =
  string | number | boolean | null | AuditValue[] | { [key: string]: AuditValue };

/** One changed field: the value before and after. `null` means "did not exist" / "removed". */
export interface AuditChange {
  from: AuditValue;
  to: AuditValue;
}

/** Field name -> before/after. Stored as-is in `audit_log.diff` (product-owner rule: full history). */
export type AuditChanges = Record<string, AuditChange>;

interface AuditEntryBase {
  entityType: string;
  entityId: string;
  action: string;
  changes: AuditChanges;
}

/**
 * An action by a person. The actor id comes from the authenticated `Actor` and the time from
 * the Clock; neither may ever come from request input.
 */
export interface AuditEntry extends AuditEntryBase {
  actorUserId: string;
}

/** Systems that may write audit rows without a person. Add a source only with a reviewed reason. */
export type SystemSource =
  | 'SHEET_SYNC'
  | 'RATE_REFRESH'
  | 'BOOTSTRAP'
  | 'TELEGRAM'
  | 'AUTH'
  // The daily automatic price list post to the organization groups (migration brands).
  | 'PRICE_POST'
  // An owner-run command with no signed-in person (issuing and revoking API tokens).
  | 'CLI';

/**
 * An action by the system itself (for example the sheet sync): stored with a NULL actor, never
 * a fabricated user id. The action must start with its source name; the database CHECK
 * `audit_log_actor_required` enforces the same prefix, so a NULL actor is impossible for any
 * other action.
 */
interface SystemAuditEntryOf<S extends SystemSource> extends AuditEntryBase {
  systemSource: S;
  action: `${S}_${string}`;
}

/** One variant per source, so a source can only write its own actions. */
export type SystemAuditEntry = { [S in SystemSource]: SystemAuditEntryOf<S> }[SystemSource];
