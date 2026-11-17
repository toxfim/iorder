import { describe, expect, it } from 'vitest';
import { staffOrganizationsMessages } from '@/features/staff-organizations/messages';
import { createAppI18n } from './index';
import { ensureStaffOrganizationsMessages } from './staff-organizations-messages';

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('staff organizations messages', () => {
  it('have the same keys in uz, ru and en, and no empty text', () => {
    const uz = keys(staffOrganizationsMessages.uz).sort();
    expect(keys(staffOrganizationsMessages.ru).sort()).toEqual(uz);
    expect(keys(staffOrganizationsMessages.en).sort()).toEqual(uz);
    for (const locale of ['uz', 'ru', 'en'] as const) {
      const flat = JSON.stringify(staffOrganizationsMessages[locale]);
      expect(flat).not.toContain('""');
    }
  });

  it('are missing from a fresh instance and merged per locale on demand', async () => {
    const i18n = createAppI18n('RU');
    expect(i18n.global.te('organizations.title', 'ru')).toBe(false);
    await ensureStaffOrganizationsMessages(i18n);
    expect(i18n.global.te('organizations.title', 'ru')).toBe(true);
    expect(i18n.global.te('organizations.title', 'uz')).toBe(true); // the fallback language
    expect(i18n.global.t('organizations.info', { count: 2 }, 2)).toBe('2 организации');
  });
});
