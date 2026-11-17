import { describe, expect, it } from 'vitest';
import { staffCommonMessages } from '@/features/staff-common/messages';
import { staffOrdersMessages } from '@/features/staff-orders/messages';

// F-12 / F-13: one vocabulary per role, and no raw enum token inside a sentence. The table of
// names is in docs/private/product/autonomous-work-log.md ("Status vocabulary").

function leaves(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    leaves(child, path === '' ? key : `${path}.${key}`),
  );
}

const LANGS = ['uz', 'ru', 'en'] as const;

describe('staff texts', () => {
  it.each(LANGS)('%s: no raw PAID / UNPAID token reaches a person', (lang) => {
    const found = [
      ...leaves(staffOrdersMessages[lang], 'orders'),
      ...leaves(staffCommonMessages[lang], 'common'),
    ].filter(([, text]) => /\b(UN)?PAID\b/.test(text));
    expect(found).toEqual([]);
  });

  it.each(LANGS)('%s: the staff stage names are all different', (lang) => {
    const stages = Object.values(staffOrdersMessages[lang].stages);
    expect(new Set(stages).size).toBe(stages.length);
  });

  it.each(LANGS)(
    '%s: RELEASED has one name in lists, the feed, the history and the toast',
    (lang) => {
      const orders = staffOrdersMessages[lang];
      const feed = staffCommonMessages[lang].activity.ORDER_RELEASED;
      const names = [orders.stages.RELEASED, orders.detail.events.RELEASED];
      expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(1);
      expect(feed.toLowerCase()).toContain(orders.stages.RELEASED.toLowerCase());
      expect(orders.toast.released.toLowerCase()).toContain(orders.stages.RELEASED.toLowerCase());
    },
  );
});
