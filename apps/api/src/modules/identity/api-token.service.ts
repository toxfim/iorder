import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { Clock } from '../../common/clock/clock.js';
import { InputValidationError, NotFoundError } from '../../common/errors/domain-errors.js';
import { AuditService } from '../audit/index.js';
import {
  API_TOKEN_MAX_DAYS,
  generateApiToken,
  hashApiToken,
  isWellFormedApiToken,
  toActorScopes,
  type ApiTokenScope,
} from './api-token.js';
import { ApiTokenRepository, type ApiTokenRecord } from './api-token.repository.js';
import { IdentityRepository } from './identity.repository.js';
import { StaffAuthRepository } from './staff-auth.repository.js';

const API_TOKEN_ENTITY = 'API_TOKEN';

/** last_used_at is bookkeeping for people, not a security control: one write a minute is enough. */
const TOUCH_INTERVAL_MS = 60_000;

export interface IssueApiTokenInput {
  /** The staff login (for example admin@iorder.uz) the token acts as. */
  login: string;
  name: string;
  days: number;
  scopes: readonly ApiTokenScope[];
}

export interface IssuedApiToken {
  /** Shown once; only its hash is stored. */
  token: string;
  record: ApiTokenRecord;
}

/**
 * Issuing, revoking and checking API tokens. Issue and revoke are called only by the owner's CLI
 * (no endpoint), so their audit rows are system rows of the `CLI` source.
 */
@Injectable()
export class ApiTokenService {
  constructor(
    private readonly repository: ApiTokenRepository,
    private readonly identity: IdentityRepository,
    private readonly credentials: StaffAuthRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async issue(input: IssueApiTokenInput): Promise<IssuedApiToken> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 100) {
      throw new InputValidationError([{ path: 'name', message: 'must be 1-100 characters' }]);
    }
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > API_TOKEN_MAX_DAYS) {
      throw new InputValidationError([
        { path: 'days', message: `must be a whole number from 1 to ${API_TOKEN_MAX_DAYS}` },
      ]);
    }
    if (input.scopes.length === 0) {
      throw new InputValidationError([{ path: 'scopes', message: 'at least one scope' }]);
    }
    const credential = await this.credentials.findCredentialByLogin(
      'STAFF',
      input.login.trim().toLowerCase(),
    );
    const user = credential ? await this.identity.findById(credential.userId) : null;
    if (!user || user.status !== 'ACTIVE' || user.staffRoles.length === 0) {
      throw new NotFoundError('No active staff account with this login');
    }
    // A token for an action the person cannot perform would never work; refuse it up front.
    const person: Actor = { userId: user.id, staffRoles: user.staffRoles };
    const missing = input.scopes.filter((scope) => !can(person, scope));
    if (missing.length > 0) {
      throw new InputValidationError([
        { path: 'scopes', message: `the account's roles do not allow: ${missing.join(', ')}` },
      ]);
    }

    const now = this.clock.now();
    const token = generateApiToken();
    const expiresAt = new Date(now.getTime() + input.days * 86_400_000);
    const record = await this.repository.transaction(async (tx) => {
      const created = await this.repository.insert(tx, {
        userId: user.id,
        name,
        tokenHash: hashApiToken(token),
        scopes: input.scopes,
        now,
        expiresAt,
      });
      await this.audit.recordSystem(tx, {
        systemSource: 'CLI',
        entityType: API_TOKEN_ENTITY,
        entityId: created.id,
        action: 'CLI_API_TOKEN_ISSUED',
        changes: {
          userId: { from: null, to: user.id },
          name: { from: null, to: name },
          scopes: { from: null, to: [...created.scopes] },
          expiresAt: { from: null, to: expiresAt.toISOString() },
        },
      });
      return created;
    });
    return { token, record };
  }

  /** True when this call revoked it; false when it was already revoked. */
  async revoke(id: string): Promise<boolean> {
    return this.repository.transaction(async (tx) => {
      const existing = await this.repository.findById(tx, id);
      if (!existing) throw new NotFoundError('API token not found');
      const now = this.clock.now();
      const revoked = await this.repository.revoke(tx, id, now);
      if (!revoked) return false;
      await this.audit.recordSystem(tx, {
        systemSource: 'CLI',
        entityType: API_TOKEN_ENTITY,
        entityId: id,
        action: 'CLI_API_TOKEN_REVOKED',
        changes: { revokedAt: { from: null, to: now.toISOString() } },
      });
      return true;
    });
  }

  /**
   * The Actor behind a token, or null for every problem (malformed, unknown, revoked, expired,
   * person blocked or without a staff role). Roles are read fresh on every request, so taking a
   * role away disables the token at once; the scopes then narrow what is left.
   */
  async authenticate(token: string): Promise<Actor | null> {
    if (!isWellFormedApiToken(token)) return null;
    const record = await this.repository.findByTokenHash(hashApiToken(token));
    if (!record || record.revokedAt !== null) return null;
    const now = this.clock.now();
    if (record.expiresAt.getTime() <= now.getTime()) return null;
    const user = await this.identity.findById(record.userId);
    if (user?.status !== 'ACTIVE' || user.staffRoles.length === 0) return null;
    if (
      record.lastUsedAt === null ||
      now.getTime() - record.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS
    ) {
      await this.repository.touch(record.id, now);
    }
    return { userId: user.id, staffRoles: user.staffRoles, scopes: toActorScopes(record.scopes) };
  }
}
