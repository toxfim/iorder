import { afterEach, describe, expect, it, vi } from 'vitest';
import { staffUsersMessages } from '@/features/staff-users/messages';
import { createAppI18n } from './index';
import { ensureStaffUsersMessages } from './staff-users-messages';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('staff users messages', () => {
  it('have the same keys in uz, ru and en, and no empty text', () => {
    const uz = keys(staffUsersMessages.uz).sort();
    expect(keys(staffUsersMessages.ru).sort()).toEqual(uz);
    expect(keys(staffUsersMessages.en).sort()).toEqual(uz);
    for (const locale of ['uz', 'ru', 'en'] as const) {
      expect(JSON.stringify(staffUsersMessages[locale])).not.toContain('""');
    }
  });

  it.each(['UZ', 'RU', 'EN'] as const)(
    '%s: every text compiles in vue-i18n (an unescaped @ or | would not) and is not a raw key',
    async (locale) => {
      const i18n = createAppI18n(locale);
      await ensureStaffUsersMessages(i18n);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      for (const key of keys(staffUsersMessages.uz)) {
        const full = `staffUsers.${key}`;
        const text = i18n.global.t(full, {
          name: 'N',
          login: 'L',
          seconds: 5,
          count: 2,
          state: 'S',
        });
        expect(text, full).not.toBe(full);
        expect(text, full).not.toBe('');
      }
      expect(errors).not.toHaveBeenCalled();
      expect(warnings).not.toHaveBeenCalled();
    },
  );

  it('write the login example with a literal @', async () => {
    const i18n = createAppI18n('EN');
    await ensureStaffUsersMessages(i18n);
    expect(i18n.global.t('staffUsers.accounts.create.loginHint')).toContain('name@iorder.uz');
  });

  it('are missing from a fresh instance and merged per locale on demand', async () => {
    const i18n = createAppI18n('RU');
    expect(i18n.global.te('staffUsers.accounts.title', 'ru')).toBe(false);
    await ensureStaffUsersMessages(i18n);
    expect(i18n.global.te('staffUsers.accounts.title', 'ru')).toBe(true);
    expect(i18n.global.te('staffUsers.accounts.title', 'uz')).toBe(true);
    expect(i18n.global.t('staffUsers.block.question')).toBe('Удалить из группы тоже?');
  });
});
