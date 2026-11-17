import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityHistoryMessages } from '@/features/activity-history/messages';
import { botSettingsMessages } from '@/features/bot-settings/messages';
import { staffProfileMessages } from '@/features/profile/messages';
import { createAppI18n } from './index';
import { ensureStaffSystemPagesMessages } from './staff-system-pages-messages';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

const CATALOGS = [
  ['activityHistory', activityHistoryMessages],
  ['botSettings', botSettingsMessages],
  ['staffProfile', staffProfileMessages],
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('activity history, bot settings and profile messages', () => {
  it.each(CATALOGS)('%s: the same keys in uz, ru and en, and no empty text', (_, messages) => {
    const uz = keys(messages.uz).sort();
    expect(keys(messages.ru).sort()).toEqual(uz);
    expect(keys(messages.en).sort()).toEqual(uz);
    for (const locale of ['uz', 'ru', 'en'] as const) {
      expect(JSON.stringify(messages[locale])).not.toContain('""');
    }
  });

  it.each(['UZ', 'RU', 'EN'] as const)(
    '%s: every text compiles in vue-i18n and is not a raw key',
    async (locale) => {
      const i18n = createAppI18n(locale);
      await ensureStaffSystemPagesMessages(i18n);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      for (const [namespace, messages] of CATALOGS) {
        for (const key of keys(messages.uz)) {
          const full = `${namespace}.${key}`;
          const text = i18n.global.t(full, {
            count: 2,
            shown: 1,
            total: 2,
            time: '10:00',
            date: '20.10.2026',
            actor: 'A',
            action: 'a',
            organization: 'O',
            number: 3,
            roles: 'R',
          });
          expect(text, full).not.toBe(full);
          expect(text, full).not.toBe('');
        }
      }
      expect(errors).not.toHaveBeenCalled();
      expect(warnings).not.toHaveBeenCalled();
    },
  );

  it('writes BotFather with a literal @', async () => {
    const i18n = createAppI18n('EN');
    await ensureStaffSystemPagesMessages(i18n);
    expect(i18n.global.t('botSettings.appearance.unavailable')).toContain('@BotFather');
  });

  it('are missing from a fresh instance and merged per locale on demand', async () => {
    const i18n = createAppI18n('RU');
    expect(i18n.global.te('staffProfile.title', 'ru')).toBe(false);
    await ensureStaffSystemPagesMessages(i18n);
    expect(i18n.global.te('staffProfile.title', 'uz')).toBe(true);
    expect(i18n.global.t('activityHistory.title')).toBe('История действий');
  });
});
