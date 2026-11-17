import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_LOCALE,
  STAFF_ROLES,
  type Locale,
  type PriceTier,
  type StaffRole,
} from '@iorder/shared';
import { Clock } from '../../common/clock/clock.js';
import { NotFoundError } from '../../common/errors/domain-errors.js';
import { IdentityService, StaffBotLinkService, type DeliveryTarget } from '../identity/index.js';
import { OrganizationsService } from '../organizations/index.js';
import { isKickMemberType, kickMemberPayloadSchema } from '../../common/outbox/kick-member.js';
import {
  isPriceListPostType,
  priceListPostPayloadSchema,
} from '../../common/outbox/price-list-post.js';
import { isStaffNoticeType, type StaffNoticeType } from '../../common/outbox/staff-notices.js';
import { NOTIFICATION_TYPES, OrdersService, type NotificationType } from '../orders/index.js';
import { PriceListExportService, type PriceListExport } from '../pricing/index.js';
import {
  TelegramSender,
  TelegramSendError,
  WebLinks,
  type MessageButton,
  type SendMessageOptions,
} from '../telegram/index.js';
import {
  BATCH_TIME_BUDGET_SECONDS,
  CLAIM_LEASE_SECONDS,
  DEFAULT_BATCH_SIZE,
  KICK_MAX_RATE_LIMITED_AGE_SECONDS,
  MAX_BATCH_SIZE,
  rateLimitWaitSeconds,
  retryDelaySeconds,
  type DeliveryErrorCode,
} from './delivery-policy.js';
import { renderNotification, type Audience } from './message-templates.js';
import { orderButtons } from './order-buttons.js';
import { OutboxRepository, type ClaimedNotification } from './outbox.repository.js';
import { appendPlacerLine, type OrderPlacer } from './placer-line.js';
import { PRICE_POST_BUTTON_TEXT, priceListPostCaption } from './price-post-template.js';
import { renderStaffNotice } from './staff-notice-templates.js';

export interface DispatchSummary {
  claimed: number;
  sent: number;
  /** Rows scheduled to be tried again (transient failure or rate limit). */
  retried: number;
  failed: number;
  /** Rows whose processing hit an unexpected fault (for example the database); see `runOnce`. */
  errors: number;
}

/** One person or chat a row has to reach, with the reader's language and kind. */
interface Target {
  chatId: string;
  locale: Locale;
  audience: Audience;
  /** A person's private chat (not a group): a refusal there means the bot no longer reaches them. */
  privateChat: boolean;
  /** An organization chat: the organization's CURRENT price tier (the price list file follows it). */
  priceTier?: PriceTier;
}

type TargetLookup =
  | { ok: true; targets: Target[] }
  /**
   * Nothing to send: the person's own PERSON organization chat (the same private chat) carries the
   * same news in its own row, so the row counts as delivered.
   */
  | { ok: true; targets: []; coveredByOrganizationChat: true }
  | { ok: false; code: DeliveryErrorCode };

/** What one chat gets for a row: the text and what goes with it (buttons, a mention). */
interface OutgoingMessage {
  text: string;
  options: SendMessageOptions;
}

/** State shared by the rows of one batch. */
interface BatchContext {
  /** The price list file per language and tier, built once per batch however many chats get it. */
  priceFiles: Map<string, Promise<PriceListExport>>;
}

type RowResult =
  | { kind: 'SENT' }
  | { kind: 'FAILED'; code: DeliveryErrorCode }
  | { kind: 'RETRY'; code: DeliveryErrorCode }
  | { kind: 'RATE_LIMITED'; waitSeconds: number };

const isNotificationType = (value: string): value is NotificationType =>
  (NOTIFICATION_TYPES as readonly string[]).includes(value);
const isStaffRole = (value: string): value is StaffRole =>
  (STAFF_ROLES as readonly string[]).includes(value);

/**
 * Delivers `notification_outbox` rows to Telegram. Scheduled by the worker's `outbox-dispatch` job
 * (modules/jobs, off by default); `runOnce` can also be called by the `bot:dispatch-once` script.
 *
 * Delivery semantics: AT LEAST ONCE, with the window for a duplicate kept as small as possible.
 *  1. Claim: one statement locks due rows (`FOR UPDATE SKIP LOCKED`), counts the attempt and
 *     pushes `next_attempt_at` to a lease end. Two dispatchers never get the same row, and a
 *     row cannot be claimed again while its lease runs.
 *  2. Send, then immediately record the chat in `delivered_chat_ids` (and `SENT` once every
 *     chat has it). A retry skips chats already recorded.
 *  The only duplicate window is a crash (or a failed database write) in the few milliseconds
 *  between Telegram accepting a message and step 2; the row is then sent again once its lease
 *  expires. That is the right side to fail on: a status update must never be lost, a repeated
 *  one is only noise. Exactly-once is impossible against Telegram's API.
 *
 * The dispatcher updates only `status`, `attempts`, `sent_at`, `next_attempt_at`,
 * `last_error_code` and `delivered_chat_ids`; it never stores message text or a Telegram error
 * body (only the short codes of `DeliveryErrorCode`).
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    private readonly repository: OutboxRepository,
    private readonly sender: TelegramSender,
    private readonly identity: IdentityService,
    private readonly organizations: OrganizationsService,
    private readonly orders: OrdersService,
    private readonly links: WebLinks,
    private readonly clock: Clock,
    private readonly botLinks: StaffBotLinkService,
    private readonly priceExport: PriceListExportService,
  ) {}

  /**
   * Fails with a clear message when the database role cannot update the delivery columns of the
   * outbox (the grants file was not applied). Without that the sender would send a message and
   * then be unable to record it, and the row would be sent again. Names only columns.
   */
  async assertDeliveryGrants(): Promise<void> {
    const missing = await this.repository.findMissingUpdateGrants();
    if (missing.length > 0) {
      throw new Error(
        `The database role may not update these delivery columns of the outbox: ${missing.join(', ')}. ` +
          'Apply db/app-role-grants.sql to the role before sending.',
      );
    }
  }

  async runOnce(batchSize: number = DEFAULT_BATCH_SIZE): Promise<DispatchSummary> {
    const summary: DispatchSummary = { claimed: 0, sent: 0, retried: 0, failed: 0, errors: 0 };
    // Without a bot token nothing can be delivered: leave the rows exactly as they are.
    if (!this.sender.enabled) return summary;

    const limit = Math.min(Math.max(Math.trunc(batchSize), 1), MAX_BATCH_SIZE);
    const claimTime = this.clock.now();
    const rows = await this.repository.claimDue(
      claimTime,
      new Date(claimTime.getTime() + CLAIM_LEASE_SECONDS * 1000),
      limit,
    );
    summary.claimed = rows.length;

    // Set by the first 429: the rest of the batch is deferred instead of hammering Telegram.
    let pauseSeconds: number | null = null;
    const batch: BatchContext = { priceFiles: new Map() };
    const deadline = claimTime.getTime() + BATCH_TIME_BUDGET_SECONDS * 1000;
    for (const [index, row] of rows.entries()) {
      if (this.clock.now().getTime() >= deadline) {
        // Too slow: the leases of the rest must not run out while they wait. Give them back.
        const rest = rows.slice(index);
        await this.repository.release(
          rest.map((r) => r.id),
          this.clock.now(),
        );
        summary.retried += rest.length;
        break;
      }
      try {
        const result: RowResult =
          pauseSeconds === null
            ? await this.deliver(row, batch)
            : { kind: 'RATE_LIMITED', waitSeconds: pauseSeconds };
        if (result.kind === 'RATE_LIMITED') pauseSeconds = result.waitSeconds;
        await this.finish(row, result, summary);
      } catch (error) {
        // An unexpected fault (the database went away mid-batch). The row keeps its lease and
        // becomes due again when the lease ends; the rest of the batch carries on. Only the
        // error type is logged: the message may echo query parameters.
        summary.errors += 1;
        this.logger.error(`Notification ${row.id} could not be processed: ${errorName(error)}`);
      }
    }
    return summary;
  }

  /** Sends one row to everyone it addresses and decides what happens to the row. */
  private async deliver(row: ClaimedNotification, batch: BatchContext): Promise<RowResult> {
    if (isKickMemberType(row.type)) return this.deliverKick(row);
    if (isPriceListPostType(row.type)) return this.deliverPriceList(row, batch);
    const type = row.type;
    if (!isNotificationType(type) && !isStaffNoticeType(type)) {
      return { kind: 'FAILED', code: 'INVALID_PAYLOAD' };
    }
    const lookup = await this.resolveTargets(row);
    if (!lookup.ok) return { kind: 'FAILED', code: lookup.code };
    if ('coveredByOrganizationChat' in lookup) return { kind: 'SENT' };

    const delivered = new Set(row.deliveredChatIds);
    let reachedAnyone = delivered.size > 0;
    let transient = false;
    let unreachable = false;
    let rejected = false;
    for (const target of dedupe(lookup.targets)) {
      if (delivered.has(target.chatId)) continue;
      const message = await this.compose(row, type, target);
      if (message === null) return { kind: 'FAILED', code: 'INVALID_PAYLOAD' };
      try {
        await this.send(target.chatId, message);
      } catch (error) {
        const failure =
          error instanceof TelegramSendError ? error : new TelegramSendError('TRANSIENT');
        if (failure.failure === 'RATE_LIMITED') {
          return {
            kind: 'RATE_LIMITED',
            waitSeconds: rateLimitWaitSeconds(failure.retryAfterSeconds),
          };
        }
        if (failure.failure === 'RECIPIENT_UNREACHABLE' && target.privateChat) {
          // The staff app asks this person to connect the bot again.
          await this.botLinks.recordBlocked(BigInt(target.chatId));
        }
        if (failure.failure === 'RECIPIENT_UNREACHABLE') unreachable = true;
        else if (failure.failure === 'REJECTED') rejected = true;
        else transient = true;
        continue;
      }
      reachedAnyone = true;
      // Right after the send, before anything else: this is the whole crash window.
      await this.repository.recordDelivered(row.id, target.chatId);
    }

    if (transient) return { kind: 'RETRY', code: 'SEND_FAILED' };
    if (reachedAnyone) return { kind: 'SENT' };
    if (unreachable) return { kind: 'FAILED', code: 'RECIPIENT_UNREACHABLE' };
    return rejected
      ? { kind: 'FAILED', code: 'MESSAGE_REJECTED' }
      : { kind: 'FAILED', code: 'NO_RECIPIENT' };
  }

  /**
   * The message of one row for one chat, or null when the payload does not have the expected
   * shape. An order message has the order behind buttons, never as a link in the text (staff [C]
   * 2026-10-25, the customer side [C] 2026-11-09). In the organization's group it also names the
   * person who placed the order, as a mention.
   */
  private async compose(
    row: ClaimedNotification,
    type: NotificationType | StaffNoticeType,
    target: Target,
  ): Promise<OutgoingMessage | null> {
    if (isStaffNoticeType(type)) {
      const notice = renderStaffNotice({ type, locale: target.locale, payload: row.payload });
      return notice === null ? null : { text: notice, options: { disableLinkPreview: true } };
    }
    const text = renderNotification({
      type,
      audience: target.audience,
      locale: target.locale,
      payload: row.payload,
    });
    if (text === null) return null;
    const buttons = this.orderButtons(row, target);
    const inGroup = target.audience === 'CUSTOMER' && !target.privateChat;
    const named = inGroup
      ? appendPlacerLine(text, target.locale, await this.placerOf(row))
      : { text, mentions: [] };
    return {
      text: named.text,
      options: {
        disableLinkPreview: true,
        ...(buttons.length > 0 ? { buttons } : {}),
        ...(named.mentions.length > 0 ? { mentions: named.mentions } : {}),
      },
    };
  }

  /**
   * One send. A mention is an extra: if Telegram refuses the request with it, the same message
   * goes out once more with the name as plain text, so a mention can never cost the customer the
   * message itself. Every other failure is the caller's to classify.
   */
  private async send(chatId: string, message: OutgoingMessage): Promise<void> {
    try {
      await this.sender.sendMessage(chatId, message.text, message.options);
    } catch (error) {
      const refused = error instanceof TelegramSendError && error.failure === 'REJECTED';
      if (!refused || message.options.mentions === undefined) throw error;
      await this.sender.sendMessage(chatId, message.text, {
        disableLinkPreview: true,
        ...(message.options.buttons === undefined ? {} : { buttons: message.options.buttons }),
      });
    }
  }

  /** The person who placed the row's order, for the mention; null when unknown. */
  private async placerOf(row: ClaimedNotification): Promise<OrderPlacer | null> {
    if (row.orderId === null) return null;
    const placerId = await this.orders.findPlacerIdOfOrder(row.orderId);
    const person = placerId === null ? null : await this.identity.findMentionSubject(placerId);
    return person === null
      ? null
      : { name: person.fullName, telegramUserId: person.telegramUserId };
  }

  /**
   * Sends the price list Excel file to one organization group ([C] 2026-10-28). The file is built
   * at send time from the CURRENT published list (once per batch), so a group never gets prices
   * older than the ones in force; the payload records what was asked for. The caption repeats
   * the file's date and USD rate and points to the button. The button is a plain url button (a
   * web_app button is rejected in groups).
   */
  private async deliverPriceList(
    row: ClaimedNotification,
    batch: BatchContext,
  ): Promise<RowResult> {
    if (!priceListPostPayloadSchema.safeParse(row.payload).success) {
      return { kind: 'FAILED', code: 'INVALID_PAYLOAD' };
    }
    const lookup = await this.resolveTargets(row);
    if (!lookup.ok) return { kind: 'FAILED', code: lookup.code };
    const target = lookup.targets[0];
    if (target === undefined) return { kind: 'FAILED', code: 'NO_RECIPIENT' };
    if (row.deliveredChatIds.includes(target.chatId)) return { kind: 'SENT' };
    // The tier of the organization's label NOW [C, owner 2026-11-11]: a label changed after the
    // row was queued must never send the other tier's prices.
    const tier = target.priceTier ?? 'STANDARD';

    let file: PriceListExport;
    try {
      const key = `${target.locale}:${tier}`;
      let building = batch.priceFiles.get(key);
      if (building === undefined) {
        building = this.priceExport.buildCurrent(target.locale, tier);
        batch.priceFiles.set(key, building);
      }
      file = await building;
    } catch (error) {
      if (error instanceof NotFoundError) return { kind: 'FAILED', code: 'NO_PRICE_LIST' };
      throw error;
    }
    // The tier (read now) may have no priced product, e.g. a label changed to Alif factoring after
    // the row was queued: never send an empty workbook.
    if (file.rowCount === 0) return { kind: 'FAILED', code: 'NO_PRICED_ITEMS' };
    // The Mini App direct link opens the catalog inside Telegram (owner, 2026-10-29); without
    // TELEGRAM_MINI_APP_URL the button falls back to the customer website.
    const pricesUrl = this.links.miniAppStart('prices') ?? this.links.customerPrices();
    try {
      await this.sender.sendDocument(
        target.chatId,
        { fileName: file.fileName, data: file.data },
        {
          caption: priceListPostCaption(file, pricesUrl !== null),
          ...(pricesUrl === null
            ? {}
            : { button: { text: PRICE_POST_BUTTON_TEXT, url: pricesUrl } }),
        },
      );
    } catch (error) {
      const failure =
        error instanceof TelegramSendError ? error : new TelegramSendError('TRANSIENT');
      switch (failure.failure) {
        case 'RATE_LIMITED':
          return {
            kind: 'RATE_LIMITED',
            waitSeconds: rateLimitWaitSeconds(failure.retryAfterSeconds),
          };
        case 'RECIPIENT_UNREACHABLE':
          return { kind: 'FAILED', code: 'RECIPIENT_UNREACHABLE' };
        case 'REJECTED':
          return { kind: 'FAILED', code: 'MESSAGE_REJECTED' };
        default:
          return { kind: 'RETRY', code: 'SEND_FAILED' };
      }
    }
    await this.repository.recordDelivered(row.id, target.chatId);
    return { kind: 'SENT' };
  }

  /**
   * Removes a blocked person from one group. The checks run again at send time (the job may have
   * waited): the person must still be BLOCKED, must not be staff, and the ids in the payload must
   * still be the ones on record. The membership becomes LEFT only after Telegram accepted the
   * removal; every failure keeps the membership as it was and ends as a short code the manager
   * can read (GET /staff/users/:id/removal-status).
   */
  private async deliverKick(row: ClaimedNotification): Promise<RowResult> {
    const parsed = kickMemberPayloadSchema.safeParse(row.payload);
    if (!parsed.success || row.recipientOrganizationId === null) {
      return { kind: 'FAILED', code: 'INVALID_PAYLOAD' };
    }
    const payload = parsed.data;
    const subject = await this.identity.findRemovalSubject(payload.userId);
    if (subject === null) return { kind: 'FAILED', code: 'NO_RECIPIENT' };
    if (subject.isStaff || !subject.blocked || subject.telegramUserId !== payload.telegramUserId) {
      return { kind: 'FAILED', code: 'REMOVAL_NOT_ALLOWED' };
    }
    // The job belongs to ONE membership: still active, and the same one (same start).
    const memberSince = await this.organizations.findActiveMembershipStart(
      row.recipientOrganizationId,
      payload.userId,
    );
    if (memberSince === null || memberSince.getTime() !== new Date(payload.joinedAt).getTime()) {
      return { kind: 'FAILED', code: 'REMOVAL_NOT_ALLOWED' };
    }
    const chat = await this.organizations.findChatTarget(row.recipientOrganizationId);
    if (chat === null || chat.chatId === null) return { kind: 'FAILED', code: 'NO_RECIPIENT' };
    // A PERSON organization's chat is the person's own private chat: nobody to remove there.
    if (chat.privateChat) return { kind: 'FAILED', code: 'REMOVAL_NOT_ALLOWED' };
    if (chat.chatId !== payload.chatId) return { kind: 'FAILED', code: 'INVALID_PAYLOAD' };

    try {
      await this.sender.removeMember(payload.chatId, payload.telegramUserId);
    } catch (error) {
      const failure =
        error instanceof TelegramSendError ? error : new TelegramSendError('TRANSIENT');
      // The person is out of the group (banned) but may stay on its ban list: the membership
      // follows the truth and the audit line says what is left to do.
      if (failure.failure === 'UNBAN_FAILED') {
        await this.organizations.recordMemberRemovedByBot({
          organizationId: row.recipientOrganizationId,
          userId: payload.userId,
          requestedByUserId: payload.requestedByUserId,
          requestedAt: payload.requestedAt,
          reason: payload.reason,
          bannedNotUnbanned: true,
        });
      }
      if (failure.failure === 'CHAT_MIGRATED') {
        // Operators need the new id to fix the organization; it stays out of the outbox row.
        this.logger.warn(
          `Notification ${row.id}: chat ${payload.chatId} migrated to ${failure.migratedToChatId ?? 'an unknown id'}`,
        );
      }
      return removalFailure(failure);
    }
    await this.organizations.recordMemberRemovedByBot({
      organizationId: row.recipientOrganizationId,
      userId: payload.userId,
      requestedByUserId: payload.requestedByUserId,
      requestedAt: payload.requestedAt,
      reason: payload.reason,
    });
    return { kind: 'SENT' };
  }

  private async finish(
    row: ClaimedNotification,
    result: RowResult,
    summary: DispatchSummary,
  ): Promise<void> {
    const now = this.clock.now();
    switch (result.kind) {
      case 'SENT':
        await this.repository.markSent(row.id, now);
        summary.sent += 1;
        return;
      case 'FAILED':
        await this.repository.markFailed(row.id, result.code);
        this.logger.warn(`Notification ${row.id} failed: ${result.code}`);
        summary.failed += 1;
        return;
      case 'RATE_LIMITED':
        if (isKickMemberType(row.type) && this.rateLimitedTooLong(row, now)) {
          await this.repository.markFailed(row.id, 'RATE_LIMITED_TOO_LONG');
          this.logger.warn(`Notification ${row.id} failed: RATE_LIMITED_TOO_LONG`);
          summary.failed += 1;
          return;
        }
        await this.repository.deferWithoutAttempt(
          row.id,
          new Date(now.getTime() + result.waitSeconds * 1000),
        );
        summary.retried += 1;
        return;
      case 'RETRY': {
        const delay = retryDelaySeconds(row.attempts);
        if (delay === null) {
          await this.repository.markFailed(row.id, 'RETRIES_EXHAUSTED');
          this.logger.warn(`Notification ${row.id} failed: RETRIES_EXHAUSTED`);
          summary.failed += 1;
          return;
        }
        await this.repository.scheduleRetry(
          row.id,
          new Date(now.getTime() + delay * 1000),
          result.code,
        );
        summary.retried += 1;
        return;
      }
    }
  }

  private rateLimitedTooLong(row: ClaimedNotification, now: Date): boolean {
    return now.getTime() - row.createdAt.getTime() >= KICK_MAX_RATE_LIMITED_AGE_SECONDS * 1000;
  }

  private async resolveTargets(row: ClaimedNotification): Promise<TargetLookup> {
    switch (row.recipientKind) {
      case 'USER': {
        const target =
          row.recipientUserId === null
            ? null
            : await this.identity.findDeliveryTarget(row.recipientUserId);
        if (target === null) return { ok: false, code: 'NO_RECIPIENT' };
        // Hard rule 6: a customer-side person only hears about orders of THEIR organization, and
        // only while that membership and the organization are ACTIVE (a former member or a
        // member of a deactivated organization gets nothing). Staff are not tied to one.
        if (!target.isStaff && !(await this.belongsToOrderOrganization(target, row))) {
          return { ok: false, code: 'NO_RECIPIENT' };
        }
        if (!target.isStaff && (await this.isOwnOrganizationChat(target))) {
          return { ok: true, targets: [], coveredByOrganizationChat: true };
        }
        return { ok: true, targets: [fromPerson(target)] };
      }
      case 'ROLE': {
        if (row.recipientRole === null || !isStaffRole(row.recipientRole)) {
          return { ok: false, code: 'NO_RECIPIENT' };
        }
        const people = await this.identity.findDeliveryTargetsByRole(row.recipientRole);
        return people.length === 0
          ? { ok: false, code: 'NO_RECIPIENT' }
          : { ok: true, targets: people.map(fromPerson) };
      }
      case 'ORGANIZATION_CHAT': {
        const chat =
          row.recipientOrganizationId === null
            ? null
            : await this.organizations.findChatTarget(row.recipientOrganizationId);
        // A PERSON not bound yet has no chat: nobody to reach [P].
        if (chat === null || chat.chatId === null) return { ok: false, code: 'NO_RECIPIENT' };
        if (!chat.active) return { ok: false, code: 'ORGANIZATION_INACTIVE' };
        // A group has no language of its own yet: the default one (open question, see the work log).
        // A PERSON's chat is their private chat with the bot [C, owner 2026-11-11]: the same
        // allow-listed customer message, without the group's mention line.
        return {
          ok: true,
          targets: [
            {
              chatId: chat.chatId,
              locale: DEFAULT_LOCALE,
              audience: 'CUSTOMER',
              privateChat: chat.privateChat,
              priceTier: chat.priceTier,
            },
          ],
        };
      }
    }
  }

  /**
   * True when the person's organization is a PERSON whose chat is this person's own private chat:
   * the organization-chat row of the same order event already reaches them there.
   */
  private async isOwnOrganizationChat(target: DeliveryTarget): Promise<boolean> {
    if (target.membership === null) return false;
    const chat = await this.organizations.findChatTarget(target.membership.organizationId);
    return chat !== null && chat.privateChat && chat.chatId === target.chatId;
  }

  private async belongsToOrderOrganization(
    target: DeliveryTarget,
    row: ClaimedNotification,
  ): Promise<boolean> {
    if (target.membership === null || !target.membership.organizationActive) return false;
    if (row.orderId === null) return false;
    const orderOrganizationId = await this.orders.findOrganizationIdOfOrder(row.orderId);
    return orderOrganizationId === target.membership.organizationId;
  }

  /**
   * The buttons that open the row's order for this reader: the page of their web app (staff or
   * customer) and the Mini App. Each side has its own Mini App direct link. For staff the
   * registered staff Mini App is used wherever it is configured, and the `web_app` fallback only
   * while the bot that sends the message also signs staff in (see `orderButtons`).
   */
  private orderButtons(row: ClaimedNotification, target: Target): MessageButton[] {
    if (row.orderId === null) return [];
    if (target.audience === 'STAFF') {
      return orderButtons({
        audience: 'STAFF',
        locale: target.locale,
        privateChat: target.privateChat,
        pageUrl: this.links.staffOrder(row.orderId),
        miniAppLink: this.links.staffOrderMiniApp(row.orderId),
        preferMiniAppLink: true,
        webAppSignsIn: this.links.staffWebAppSignsIn,
      });
    }
    return orderButtons({
      audience: 'CUSTOMER',
      locale: target.locale,
      privateChat: target.privateChat,
      pageUrl: this.links.customerOrder(row.orderId),
      miniAppLink: this.links.customerOrderMiniApp(row.orderId),
    });
  }
}

/** Chat-level refusals are final (a retry sends the same request); only 429 and 5xx wait. */
function removalFailure(failure: TelegramSendError): RowResult {
  switch (failure.failure) {
    case 'RATE_LIMITED':
      return { kind: 'RATE_LIMITED', waitSeconds: rateLimitWaitSeconds(failure.retryAfterSeconds) };
    case 'TRANSIENT':
      return { kind: 'RETRY', code: 'SEND_FAILED' };
    case 'BOT_NOT_ADMIN':
    case 'NOT_A_MEMBER':
    case 'CHAT_NOT_FOUND':
      return { kind: 'FAILED', code: failure.failure };
    case 'CANNOT_REMOVE':
      return { kind: 'FAILED', code: 'CANNOT_REMOVE_MEMBER' };
    case 'CHAT_MIGRATED':
      return { kind: 'FAILED', code: 'CHAT_MIGRATED' };
    case 'UNBAN_FAILED':
      return { kind: 'FAILED', code: 'UNBAN_FAILED' };
    case 'RECIPIENT_UNREACHABLE':
    case 'REJECTED':
      return { kind: 'FAILED', code: 'REMOVAL_REJECTED' };
  }
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

function fromPerson(person: DeliveryTarget): Target {
  return {
    chatId: person.chatId,
    locale: person.language,
    audience: person.isStaff ? 'STAFF' : 'CUSTOMER',
    privateChat: true,
  };
}

/** One message per chat even if two lookups returned the same person. */
function dedupe(targets: readonly Target[]): Target[] {
  const seen = new Set<string>();
  return targets.filter((target) =>
    seen.has(target.chatId) ? false : (seen.add(target.chatId), true),
  );
}
