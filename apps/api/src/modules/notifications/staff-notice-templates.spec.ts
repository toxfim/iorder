import { LOCALES } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import { STAFF_NOTICE_TYPES } from '../../common/outbox/staff-notices.js';
import { renderStaffNotice } from './staff-notice-templates.js';

const pending = {
  organizationName: 'Alpha Trade',
  chatId: '-1001234567890',
  addedByName: 'Alice K',
  addedByTelegramUserId: '7100000001',
};
const conflict = {
  personName: 'Alice K',
  telegramUserId: '7100000001',
  organizationName: 'Beta',
};
const linked = { organizationName: 'Alice K' };
const payloadOf = (type: (typeof STAFF_NOTICE_TYPES)[number]) =>
  type === 'ORGANIZATION_PENDING' ? pending : type === 'ORGANIZATION_LINKED' ? linked : conflict;

describe('staff notice texts', () => {
  it.each(LOCALES)('every notice type has a %s text', (locale) => {
    for (const type of STAFF_NOTICE_TYPES) {
      const text = renderStaffNotice({ type, locale, payload: payloadOf(type) });
      expect(text, `${type} ${locale}`).not.toBeNull();
      expect(text).toContain('Alice K');
    }
  });

  it('names the group, the chat and who added the bot, and tells staff when members appear', () => {
    const en = renderStaffNotice({ type: 'ORGANIZATION_PENDING', locale: 'EN', payload: pending });
    expect(en).toContain('Alpha Trade');
    expect(en).toContain('-1001234567890');
    expect(en).toContain('Alice K (Telegram 7100000001)');
    expect(en).toMatch(/on their next message or when they join/);
    expect(
      renderStaffNotice({ type: 'ORGANIZATION_PENDING', locale: 'RU', payload: pending }),
    ).toMatch(/следующем сообщении/);
    expect(
      renderStaffNotice({ type: 'ORGANIZATION_PENDING', locale: 'UZ', payload: pending }),
    ).toMatch(/keyingi xabari/);
  });

  it('works when nobody is recorded as the one who added the bot', () => {
    const rest = { organizationName: pending.organizationName, chatId: pending.chatId };
    const text = renderStaffNotice({ type: 'ORGANIZATION_PENDING', locale: 'EN', payload: rest });
    expect(text).toContain('Alpha Trade');
    expect(text).not.toContain('added by');
  });

  it('rejects a payload with an unknown field or a wrong shape (allow-list)', () => {
    expect(
      renderStaffNotice({
        type: 'ORGANIZATION_PENDING',
        locale: 'EN',
        payload: { ...pending, phone: '+998901234567' },
      }),
    ).toBeNull();
    expect(
      renderStaffNotice({
        type: 'MEMBERSHIP_CONFLICT',
        locale: 'EN',
        payload: { personName: 'x' },
      }),
    ).toBeNull();
    expect(
      renderStaffNotice({ type: 'MEMBERSHIP_CONFLICT', locale: 'EN', payload: null }),
    ).toBeNull();
  });
});
