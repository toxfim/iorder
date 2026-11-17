import { ConflictError } from '../../common/errors/domain-errors.js';

export type VersionStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

// The whole lifecycle of a price list version (data-model §3). The database triggers repeat
// this as a last line of defence; the service rejects first with a proper error.
const ALLOWED: Readonly<Record<VersionStatus, readonly VersionStatus[]>> = {
  DRAFT: ['PUBLISHED'],
  PUBLISHED: ['ARCHIVED'],
  ARCHIVED: [],
};

export function canTransitionVersion(from: VersionStatus, to: VersionStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertVersionTransition(from: VersionStatus, to: VersionStatus): void {
  if (!canTransitionVersion(from, to)) {
    // Publishing something that is not a draft: it was published meanwhile (the client's draft
    // is gone) or it is an archived version that can never be published.
    const reason =
      to === 'PUBLISHED' && from === 'PUBLISHED'
        ? 'DRAFT_NOT_OPEN'
        : to === 'PUBLISHED' && from === 'ARCHIVED'
          ? 'VERSION_NOT_DRAFT'
          : 'INVALID_VERSION_TRANSITION';
    throw new ConflictError(`Price list version cannot move from ${from} to ${to}`, reason);
  }
}
