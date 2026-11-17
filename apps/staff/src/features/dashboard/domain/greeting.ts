import { businessParts } from '@core/lib/business-clock';

export type GreetingPeriod = 'morning' | 'afternoon' | 'evening';

/** "Xayrli tong" before noon, "kun" until six, "kech" after, by Tashkent time. */
export function greetingPeriod(now: Date): GreetingPeriod {
  const { hour } = businessParts(now);
  return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

/** Weekday (0 = Sunday), day of month and month (0-based) for the date line of the home page. */
export function dateLineParts(now: Date): { weekday: number; day: number; month: number } {
  const parts = businessParts(now);
  return { weekday: parts.weekday, day: parts.day, month: parts.month - 1 };
}

/** The first word of a full name ("Sanjar Toshev" -> "Sanjar"). */
export const firstName = (fullName: string): string => fullName.trim().split(/\s+/)[0] ?? '';
