import type { ExecutionContext } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor.js';
import { ActorResolver } from '../../common/auth/actor-resolver.js';
import { mayUseCustomerApp, toStaffViewerActor } from '../../common/auth/staff-viewer.js';
import type { TelegramInitDataVerifier } from '../telegram/init-data-verifier.js';
import type { IdentityRepository } from './identity.repository.js';
import type { UserView } from './user.view.js';

/** `Authorization: tma <initData>` (the scheme Telegram's own Mini App documentation uses). */
const AUTH_SCHEME = /^tma[ ]+(\S.*)$/i;

export interface StaffMiniAppBinding {
  /**
   * The verifier of the bot that hosts the STAFF Mini App (its token is an env setting). When it is
   * given, ONLY init data signed by that bot makes a staff actor.
   */
  staffVerifier: TelegramInitDataVerifier;
  /** STAFF_ORDERING_ORGANIZATION_ID for the viewer block, or null (as in production). */
  staffOrderingOrganizationId: string | null;
}

/** Which bot signed the init data: that is the app the person opened. */
type Door = 'ANY' | 'CUSTOMER_APP' | 'STAFF_APP';

/**
 * Builds the Actor from Telegram Mini App init data. Fails closed: every problem (no header,
 * bad or stale signature, unknown or blocked user, inactive organization, a user with neither
 * a staff role nor a membership) returns null, and the caller cannot tell the cases apart.
 * Nothing here logs the header, the init data or the token.
 *
 * Staff roles win: a person with a staff role never gets a membership in their Actor. A
 * user is not created here: auto-registration needs product decisions first.
 *
 * One bot (no binding, the default): its init data makes a staff actor or a customer member,
 * whichever the person is, as it always did. Two bots (a binding): the init data says which app
 * was opened, because each bot signs only its own Mini App. The staff bot makes a staff actor and
 * nothing else; the main bot makes a customer member or a staff VIEWER and never a staff actor,
 * so the init data the customer app holds for a staff member opens no staff route.
 */
export class TelegramActorResolver extends ActorResolver {
  constructor(
    private readonly verifier: TelegramInitDataVerifier,
    private readonly repository: IdentityRepository,
    private readonly binding: StaffMiniAppBinding | null = null,
  ) {
    super();
  }

  async resolve(context: ExecutionContext): Promise<Actor | null> {
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>();
    const header = request.headers?.['authorization'];
    if (typeof header !== 'string') return null;
    const initData = AUTH_SCHEME.exec(header)?.[1];
    if (initData === undefined) return null;

    const opened = this.verify(initData);
    if (opened === null) return null;

    const user = await this.repository.findByTelegramId(BigInt(opened.telegramUserId));
    if (!user || user.status !== 'ACTIVE') return null;

    if (user.staffRoles.length > 0) return this.staffActor(user, opened.door);
    // The staff bot is not a customer door: a customer opens the customer app of the main bot.
    if (opened.door === 'STAFF_APP') return null;

    const [membership] = await this.repository.findActiveMemberships([user.id]);
    if (!membership || !membership.organizationActive) return null;
    return {
      userId: user.id,
      staffRoles: [],
      membership: { organizationId: membership.organizationId, role: membership.role },
    };
  }

  /** A signature matches one bot only, so the order of the two checks decides nothing. */
  private verify(initData: string): { telegramUserId: string; door: Door } | null {
    if (this.binding !== null) {
      const staff = this.binding.staffVerifier.verify(initData);
      if (staff.ok) return { telegramUserId: staff.data.user.telegramUserId, door: 'STAFF_APP' };
    }
    const main = this.verifier.verify(initData);
    if (!main.ok) return null;
    return {
      telegramUserId: main.data.user.telegramUserId,
      door: this.binding === null ? 'ANY' : 'CUSTOMER_APP',
    };
  }

  private staffActor(user: UserView, door: Door): Actor | null {
    if (door !== 'CUSTOMER_APP') return { userId: user.id, staffRoles: user.staffRoles };
    // The same answer a viewer SESSION gets (staff-session.service): a role that does not open
    // the customer app has no viewer, and the person is told to sign in like anyone unknown.
    if (!mayUseCustomerApp(user.staffRoles)) return null;
    return toStaffViewerActor(
      { userId: user.id, staffRoles: user.staffRoles },
      this.binding?.staffOrderingOrganizationId ?? null,
    );
  }
}
