import { Injectable } from '@nestjs/common';
import type { StaffRole } from '@iorder/shared';
import {
  STAFF_LINK_START_PREFIX,
  STAFF_NOTIFICATION_LINK_TTL_SECONDS,
  staffLinkStartPayloadSchema,
} from '@iorder/shared/staff-auth';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { Clock } from '../../common/clock/clock.js';
import { isUniqueViolation } from '../../common/database/errors.js';
import { ForbiddenError } from '../../common/errors/domain-errors.js';
import { AuditService } from '../audit/index.js';
import { IdentityRepository } from './identity.repository.js';
import { generateSessionToken, hashSessionToken } from './session-token.js';
import { StaffBotLinkRepository } from './staff-bot-link.repository.js';
import { StaffWriteThrottle } from './staff-write-throttle.js';

const USER_ENTITY = 'USER';

/**
 * [C] 2026-10-25: every staff member except an administrator gets bot messages for the order
 * updates of their role. A person whose only role is ADMIN gets none, so needs no connection.
 */
export function receivesBotNotifications(staffRoles: readonly StaffRole[]): boolean {
  return staffRoles.some((role) => role !== 'ADMIN');
}

export interface StaffNotificationStatus {
  telegramLinked: boolean;
  botConnected: boolean;
}

export interface StaffBotLink {
  /** The `start` payload of the deep link (`staff_<token>`); the caller adds the bot's address. */
  startPayload: string;
  expiresAt: Date;
}

/** What a Start press with a connect payload did; the bot answers each one differently. */
export type BotConnectOutcome =
  | 'CONNECTED'
  /** Unknown, used, expired or malformed link, or the person is no longer active staff. */
  | 'INVALID_LINK'
  /** The account already has a different Telegram id: a manager must change it. */
  | 'OTHER_TELEGRAM_ACCOUNT'
  /** This Telegram id belongs to another person of the system. */
  | 'TELEGRAM_TAKEN';

export interface BotStartPerson {
  telegramUserId: bigint;
}

/** Whether the bot may write to a person: they started it, and it was not refused since. */
export function isBotConnected(state: {
  botStartedAt: Date | null;
  botBlockedAt: Date | null;
}): boolean {
  if (state.botStartedAt === null) return false;
  return state.botBlockedAt === null || state.botBlockedAt < state.botStartedAt;
}

@Injectable()
export class StaffBotLinkService {
  constructor(
    private readonly links: StaffBotLinkRepository,
    private readonly users: IdentityRepository,
    private readonly audit: AuditService,
    private readonly throttle: StaffWriteThrottle,
    private readonly clock: Clock,
  ) {}

  async status(actor: Actor): Promise<StaffNotificationStatus> {
    assertMayConnect(actor);
    const state = await this.links.findChatState(actor.userId);
    if (state === null) throw new ForbiddenError('Access denied');
    return {
      telegramLinked: state.telegramUserId !== null,
      botConnected: state.telegramUserId !== null && isBotConnected(state),
    };
  }

  /**
   * A new one-time connect link for the signed-in staff member. Earlier links stay valid until
   * they expire (a person may open the staff app on two devices). Audited without the token.
   */
  async createLink(actor: Actor): Promise<StaffBotLink> {
    assertMayConnect(actor);
    const now = this.clock.now();
    this.throttle.check(actor.userId, now.getTime());
    const token = generateSessionToken();
    const expiresAt = new Date(now.getTime() + STAFF_NOTIFICATION_LINK_TTL_SECONDS * 1000);
    await this.users.transaction(async (tx) => {
      await this.links.insertToken(tx, {
        userId: actor.userId,
        tokenHash: hashSessionToken(token),
        createdAt: now,
        expiresAt,
      });
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: USER_ENTITY,
        entityId: actor.userId,
        action: 'STAFF_BOT_LINK_CREATED',
        changes: { expiresAt: { from: null, to: expiresAt.toISOString() } },
      });
    });
    return { startPayload: `${STAFF_LINK_START_PREFIX}${token}`, expiresAt };
  }

  /**
   * `/start staff_<token>` in a private chat. The link is used up by the first press that gets
   * this far, whatever the outcome, so a leaked link cannot be tried again. The Telegram id is
   * written only when the account has none; an account linked to another Telegram account is
   * left alone (a manager changes it in the staff accounts page).
   */
  async connectByStart(payload: string, person: BotStartPerson): Promise<BotConnectOutcome> {
    if (!staffLinkStartPayloadSchema.safeParse(payload).success) return 'INVALID_LINK';
    const tokenHash = hashSessionToken(payload.slice(STAFF_LINK_START_PREFIX.length));
    const now = this.clock.now();
    try {
      return await this.users.transaction(async (tx) => {
        const token = await this.links.lockTokenByHash(tx, tokenHash);
        if (token === null || token.usedAt !== null || token.expiresAt <= now) {
          return 'INVALID_LINK';
        }
        await this.links.markTokenUsed(tx, token.id, now);
        if (!(await this.users.lockById(tx, token.userId))) return 'INVALID_LINK';
        const user = await this.users.findById(token.userId, tx);
        if (
          user === null ||
          user.status !== 'ACTIVE' ||
          !receivesBotNotifications(user.staffRoles)
        ) {
          return 'INVALID_LINK';
        }
        if (user.telegramUserId !== null && user.telegramUserId !== person.telegramUserId) {
          return 'OTHER_TELEGRAM_ACCOUNT';
        }
        const owner = await this.users.findByTelegramId(person.telegramUserId, tx);
        if (owner !== null && owner.id !== user.id) return 'TELEGRAM_TAKEN';

        await this.links.connect(tx, user.id, {
          telegramUserId: person.telegramUserId,
          startedAt: now,
        });
        await this.audit.record(tx, {
          actorUserId: user.id,
          entityType: USER_ENTITY,
          entityId: user.id,
          action: 'STAFF_BOT_CONNECTED',
          changes: {
            telegramUserId: {
              from: user.telegramUserId === null ? null : user.telegramUserId.toString(),
              to: person.telegramUserId.toString(),
            },
          },
        });
        return 'CONNECTED';
      });
    } catch (error) {
      // Another account took the id between the check and the write.
      if (isUniqueViolation(error)) return 'TELEGRAM_TAKEN';
      throw error;
    }
  }

  /** A plain /start of someone the system knows: the bot may write to them from now on. */
  async recordStarted(telegramUserId: bigint): Promise<void> {
    await this.links.markStartedByTelegramId(telegramUserId, this.clock.now());
  }

  /** Telegram refused a private message: the bot no longer reaches this person. */
  async recordBlocked(telegramUserId: bigint): Promise<void> {
    await this.links.markBlockedByTelegramId(telegramUserId, this.clock.now());
  }
}

function assertMayConnect(actor: Actor): void {
  if (!can(actor, 'CONNECT_BOT_NOTIFICATIONS')) throw new ForbiddenError('Access denied');
}
