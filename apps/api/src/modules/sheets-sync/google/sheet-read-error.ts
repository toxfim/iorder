import { DomainError } from '../../../common/errors/domain-errors.js';

/**
 * Why reading the sheet failed, in the terms an operator needs:
 *  - AUTH: the key was refused, is unusable, or the token exchange failed.
 *  - NOT_FOUND: the spreadsheet or the tab does not exist, or the service account has no access.
 *  - QUOTA: Google's rate limit or quota (try again later).
 *  - NETWORK: no answer in time, connection failure, or Google had a server fault.
 *  - MALFORMED: Google answered, but not with what a values read looks like, or the sheet is
 *    empty or far larger than expected.
 */
export const SHEET_READ_ERROR_KINDS = [
  'AUTH',
  'NOT_FOUND',
  'QUOTA',
  'NETWORK',
  'MALFORMED',
] as const;
export type SheetReadErrorKind = (typeof SHEET_READ_ERROR_KINDS)[number];

const MESSAGES: Record<SheetReadErrorKind, string> = {
  AUTH: 'Google refused the service account credentials',
  NOT_FOUND: 'The spreadsheet or tab was not found, or the service account has no access to it',
  QUOTA: 'Google rate limit or quota reached',
  NETWORK: 'Google could not be reached in time',
  MALFORMED: 'Google returned a response that is not a usable sheet',
};

/**
 * The only error the Google source throws. The message is a FIXED sentence per kind, `code` is a
 * stable identifier (stored in a failed sync run), and there is deliberately no `cause` and no
 * details: a response body can echo a token, a key id or cell contents (cost data), and error
 * handlers log messages and stacks.
 */
export class SheetReadError extends DomainError {
  readonly code: string;

  constructor(readonly kind: SheetReadErrorKind) {
    super(MESSAGES[kind]);
    this.code = `SHEET_READ_${kind}`;
  }
}
