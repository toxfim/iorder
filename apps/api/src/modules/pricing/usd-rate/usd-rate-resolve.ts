import { USD_RATE_BANK_MARKUP_UZS } from '@iorder/shared';
import type { UsdRateSource } from '@iorder/shared/staff-cost';
import { getBusinessTimeParts } from '../../../common/clock/business-time.js';
import type { Prisma } from '../../../generated/prisma/client.js';

export interface ChannelRateInput {
  rate: Prisma.Decimal;
  rateDate: string;
  postId: number;
}

export interface ManualRateInput {
  rate: Prisma.Decimal;
  setBy: string;
  setAt: Date;
  /** The end of its 24 hours; cancelling moves it to the moment of the cancellation. */
  expiresAt: Date;
}

/** The bank's own number, without the markup. */
export interface BankRateInput {
  rate: Prisma.Decimal;
  rateDate: string;
}

export interface UsdRateInputs {
  channel: ChannelRateInput | null;
  manual: ManualRateInput | null;
  bank: BankRateInput | null;
}

export interface ResolvedUsdRate {
  rate: Prisma.Decimal;
  source: UsdRateSource;
  rateDate: string | null;
  setBy: string | null;
}

/** How long a rate entered by a staff member stays in force [C, owner 2026-10-31]. */
export const MANUAL_RATE_TTL_MS = 24 * 60 * 60_000;

/** The Tashkent calendar day (YYYY-MM-DD) of an instant. */
export function tashkentDay(instant: Date): string {
  const p = getBusinessTimeParts(instant);
  return `${String(p.year)}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function manualInForce(inputs: UsdRateInputs, now: Date): ManualRateInput | null {
  return inputs.manual && now < inputs.manual.expiresAt ? inputs.manual : null;
}

/**
 * THE rule for the rate in force [C, owner 2026-10-31]: the channel's post for today, else a manual
 * rate within its 24 hours, else the Central Bank + 40 so'm. Decided at read time from the stored
 * inputs, so a channel day or a manual rate ends exactly on time without a job having to run.
 *
 * The last two lines are for a system that has no bank rate yet (a failed or switched-off refresh):
 * an old value with its date or author is shown, because no rate at all would stop every order.
 */
export function resolveUsdRate(inputs: UsdRateInputs, now: Date): ResolvedUsdRate | null {
  const { channel, manual, bank } = inputs;
  if (channel && channel.rateDate === tashkentDay(now)) return fromChannel(channel);
  const inForce = manualInForce(inputs, now);
  if (inForce) return fromManual(inForce);
  if (bank) {
    return {
      rate: bank.rate.plus(USD_RATE_BANK_MARKUP_UZS),
      source: 'CBU',
      rateDate: bank.rateDate,
      setBy: null,
    };
  }
  if (manual) return fromManual(manual);
  return channel ? fromChannel(channel) : null;
}

function fromChannel(channel: ChannelRateInput): ResolvedUsdRate {
  return { rate: channel.rate, source: 'CHANNEL', rateDate: channel.rateDate, setBy: null };
}

function fromManual(manual: ManualRateInput): ResolvedUsdRate {
  return { rate: manual.rate, source: 'MANUAL', rateDate: null, setBy: manual.setBy };
}
