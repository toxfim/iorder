import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PriceTier } from '@iorder/shared';
import type { PriceListPostRecipients, PriceListPostSkipped } from '@iorder/shared/staff-cost';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { businessDayOf, getBusinessTimeParts } from '../../common/clock/business-time.js';
import { Clock } from '../../common/clock/clock.js';
import type { Tx } from '../../common/database/db-client.js';
import { ForbiddenError, NotFoundError } from '../../common/errors/domain-errors.js';
import {
  enqueuePriceListPosts,
  type PriceListPostPayload,
} from '../../common/outbox/price-list-post.js';

import { AuditService, type AuditChanges } from '../audit/index.js';
import { OrganizationsService, type PricePostingPlan } from '../organizations/index.js';
import { PricingRepository } from './pricing.repository.js';
import { PricingService } from './pricing.service.js';
import { UsdRateService } from './usd-rate/usd-rate.service.js';

/** Who a post reaches and who it leaves out, counted. */
export interface PricePostSummary {
  recipients: PriceListPostRecipients;
  skipped: PriceListPostSkipped;
}

export interface PriceListPostResult extends PricePostSummary {
  versionNumber: number;
  /** Outbox rows really added (a daily run adds none for a chat that got the file that day). */
  queuedGroupCount: number;
}

export type DailyPostResult =
  ({ outcome: 'QUEUED' } & PriceListPostResult) | { outcome: 'NOTHING_PUBLISHED' };

/**
 * Posts the price list Excel file to every organization ([C] 2026-10-28; per tier and per chat
 * [C] 2026-11-11): each ACTIVE, bound organization with price posting on gets the file of ITS
 * tier, a GROUP in its group chat and a PERSON in the person's private chat with the bot. Only
 * outbox rows are written here (side effects go through the outbox); the notifications module
 * builds the file and sends it. The rows and the history entry are ONE transaction (hard rule 12).
 */
@Injectable()
export class PriceListPostService {
  constructor(
    private readonly repository: PricingRepository,
    private readonly pricing: PricingService,
    private readonly organizations: OrganizationsService,
    private readonly usdRate: UsdRateService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** What a post would do now (counts only), for the confirm dialog. Manager, admin. */
  async preview(actor: Actor): Promise<PricePostSummary> {
    if (!can(actor, 'UPDATE_PRICE_LIST')) throw new ForbiddenError('Access denied');
    return summarize(await this.withoutEmptyTiers(await this.organizations.findPricePostingPlan()));
  }

  /**
   * Leaves out the recipients whose tier has no priced product (an Alif factoring organization
   * before any Alif price exists), counted as `noPrices`: an empty workbook is never sent
   * [P, review 2026-11-12]. One read of the list per tier present.
   */
  private async withoutEmptyTiers(plan: PricePostingPlan): Promise<PostPlan> {
    const tiers = [...new Set(plan.recipients.map((r) => r.priceTier))];
    const empty = new Set<PriceTier>();
    for (const tier of tiers) {
      try {
        if ((await this.pricing.getCurrentForExport(tier)).items.length === 0) empty.add(tier);
      } catch (error) {
        // Nothing published: the post itself says so; the plan stays as it is.
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    const recipients = plan.recipients.filter((r) => !empty.has(r.priceTier));
    return {
      recipients,
      skipped: { ...plan.skipped, noPrices: plan.recipients.length - recipients.length },
    };
  }

  /** "Send to the groups now" (manager, admin). Every press is a new send. */
  async postNow(actor: Actor): Promise<PriceListPostResult> {
    if (!can(actor, 'UPDATE_PRICE_LIST')) throw new ForbiddenError('Access denied');
    return this.repository.transaction(async (tx) => {
      const queued = await this.enqueue(tx, `price-post:manual:${randomUUID()}`);
      if (queued === null) throw new NotFoundError('No price list has been published yet');
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: 'PRICE_LIST_VERSION',
        entityId: queued.versionId,
        action: 'PRICE_LIST_POSTED_TO_GROUPS',
        changes: postChanges(queued),
      });
      return resultOf(queued);
    });
  }

  /**
   * The daily automatic post (worker job, system actor). At most one post per chat per business
   * day (Asia/Tashkent): the dedupe key carries the day, so a second run that day adds nothing.
   * Nothing published: nothing happens.
   */
  async postDaily(): Promise<DailyPostResult> {
    const day = businessDayOf(this.clock.now()).date;
    return this.repository.transaction(async (tx) => {
      const queued = await this.enqueue(tx, `price-post:daily:${day}`);
      if (queued === null) return { outcome: 'NOTHING_PUBLISHED' };
      if (queued.added > 0) {
        await this.audit.recordSystem(tx, {
          systemSource: 'PRICE_POST',
          entityType: 'PRICE_LIST_VERSION',
          entityId: queued.versionId,
          action: 'PRICE_POST_DAILY_QUEUED',
          changes: postChanges(queued),
        });
      }
      return { outcome: 'QUEUED', ...resultOf(queued) };
    });
  }

  private async enqueue(tx: Tx, dedupePrefix: string): Promise<Queued | null> {
    const version = await this.pricing.findPublishedVersion(tx);
    if (!version) return null;
    const [fullPlan, rate] = await Promise.all([
      this.organizations.findPricePostingPlan(tx),
      this.usdRate.readSnapshot(tx),
    ]);
    const plan = await this.withoutEmptyTiers(fullPlan);
    const payload: Omit<PriceListPostPayload, 'priceTier'> = {
      versionNumber: version.number,
      dateLabel: dateLabel(this.clock.now()),
      usdRate: rate === null ? null : rate.rate.toFixed(),
    };
    const added = await enqueuePriceListPosts(
      tx,
      { recipients: plan.recipients, payload, dedupePrefix },
      this.clock.now(),
    );
    return { versionId: version.id, versionNumber: version.number, plan, added, payload };
  }
}

/** The organizations' plan after the tiers without a priced product were left out. */
interface PostPlan {
  recipients: PricePostingPlan['recipients'];
  skipped: PricePostingPlan['skipped'] & { noPrices: number };
}

interface Queued {
  versionId: string;
  versionNumber: number;
  plan: PostPlan;
  added: number;
  payload: Omit<PriceListPostPayload, 'priceTier'>;
}

function summarize(plan: PostPlan): PricePostSummary {
  const count = (keep: (r: PostPlan['recipients'][number]) => boolean): number =>
    plan.recipients.filter(keep).length;
  return {
    recipients: {
      total: plan.recipients.length,
      byTier: {
        STANDARD: count((r) => r.priceTier === 'STANDARD'),
        WHOLESALE_PARTNER: count((r) => r.priceTier === 'WHOLESALE_PARTNER'),
        ALIF_FACTORING: count((r) => r.priceTier === 'ALIF_FACTORING'),
      },
      byDestination: {
        GROUP: count((r) => r.destination === 'GROUP'),
        PRIVATE: count((r) => r.destination === 'PRIVATE'),
      },
    },
    skipped: { ...plan.skipped },
  };
}

function resultOf(queued: Queued): PriceListPostResult {
  return {
    versionNumber: queued.versionNumber,
    queuedGroupCount: queued.added,
    ...summarize(queued.plan),
  };
}

function postChanges(queued: Queued): AuditChanges {
  const { recipients, skipped } = summarize(queued.plan);
  const ids = (tier: string): string[] =>
    queued.plan.recipients.filter((r) => r.priceTier === tier).map((r) => r.organizationId);
  return {
    versionNumber: { from: null, to: queued.payload.versionNumber },
    dateLabel: { from: null, to: queued.payload.dateLabel },
    usdRate: { from: null, to: queued.payload.usdRate },
    queuedGroupCount: { from: null, to: queued.added },
    organizationIds: {
      from: null,
      to: queued.plan.recipients.map((r) => r.organizationId),
    },
    standardOrganizationIds: { from: null, to: ids('STANDARD') },
    wholesalePartnerOrganizationIds: { from: null, to: ids('WHOLESALE_PARTNER') },
    alifFactoringOrganizationIds: { from: null, to: ids('ALIF_FACTORING') },
    privateChatCount: { from: null, to: recipients.byDestination.PRIVATE },
    skippedUnboundCount: { from: null, to: skipped.unbound },
    skippedInactiveCount: { from: null, to: skipped.inactive },
    skippedPostingOffCount: { from: null, to: skipped.postingOff },
    skippedNoPricesCount: { from: null, to: skipped.noPrices },
  };
}

function dateLabel(instant: Date): string {
  const t = getBusinessTimeParts(instant);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(t.day)}.${pad(t.month)}.${t.year}`;
}
