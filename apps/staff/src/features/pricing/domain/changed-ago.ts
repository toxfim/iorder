import { businessParts } from '@core/lib/business-clock';

// "O'zgargan" in Narxlar (design approved 2026-11-19): how long ago a product's prices last
// changed, by Tashkent calendar days (hard rule 9): "bugun 09:41", "kecha", "5 kun oldin",
// "2 hafta oldin", "3 oy oldin". The steps (two weeks of days, then weeks up to a month) are the
// design's.

export type ChangedAgo =
  | { readonly kind: 'today'; readonly time: string }
  | { readonly kind: 'yesterday' }
  | { readonly kind: 'days' | 'weeks' | 'months'; readonly count: number };

const DAY_MS = 24 * 60 * 60 * 1000;

const calendarDay = (instant: Date | string): number => {
  const p = businessParts(instant);
  return Date.UTC(p.year, p.month - 1, p.day) / DAY_MS;
};

/** null for a malformed instant. A change "in the future" (a clock ahead) reads as today. */
export function changedAgo(changedAt: string, now: Date): ChangedAgo | null {
  if (!Number.isFinite(Date.parse(changedAt))) return null;
  const days = Math.max(0, calendarDay(now) - calendarDay(changedAt));
  if (days === 0) {
    const p = businessParts(changedAt);
    const time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    return { kind: 'today', time };
  }
  if (days === 1) return { kind: 'yesterday' };
  if (days < 14) return { kind: 'days', count: days };
  if (days < 30) return { kind: 'weeks', count: Math.round(days / 7) };
  return { kind: 'months', count: Math.max(1, Math.round(days / 30)) };
}
