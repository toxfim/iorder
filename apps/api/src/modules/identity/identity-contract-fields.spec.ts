import * as shared from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import { collectSchemaKeys, isZodSchema } from '../../../test/support/schema-keys.js';

// Personal data (phone, Telegram ids, the group's chat id) belongs to STAFF contracts only.
// The allow-list is a literal here on purpose: adding such a key to a customer-facing schema and
// to a production list at the same time must not silence this test.
const PERSONAL_KEYS = ['phone', 'telegramUserId', 'telegramChatId'] as const;
const STAFF_SCHEMAS_WITH_PERSONAL_DATA = [
  // Order views for staff: the placer, the driver and the delivery contact carry a phone.
  'deliveryContactSchema',
  'staffOrderFulfilmentSchema',
  'staffOrderFulfilmentSummarySchema',
  'staffOrderFullSchema',
  'staffOrderFullSummarySchema',
  'staffOrderListResponseSchema',
  'staffOrderPersonSchema',
  'staffOrderSchema',
  'staffOrderSummarySchema',
  'staffTimelineEventSchema',
  'staffTimelineResponseSchema',
  // The caller's OWN contact (typed by the customer at the first order, owner decision 2026-10-23).
  'meResponseSchema',
  'ownContactSchema',
  'setOwnContactRequestSchema',
  'staffMemberResponseSchema',
  // Staff-created organizations [C, 2026-11-11]: the organization's contact phone and bound person.
  'createOrganizationRequestSchema',
  'createOrganizationResponseSchema',
  'updateOrganizationRequestSchema',
  'staffOrganizationListResponseSchema',
  'staffOrganizationResponseSchema',
  'staffOrganizationSummarySchema',
  'staffPersonCardSchema',
  'staffUserListResponseSchema',
  'staffUserResponseSchema',
  'updateUserRequestSchema',
] as const;

type Schema = Parameters<typeof collectSchemaKeys>[0];
const schemas = Object.entries(shared as Record<string, unknown>).filter(
  (entry): entry is [string, Schema] => isZodSchema(entry[1]),
);

describe('personal data stays in staff contracts', () => {
  it('finds the identity schemas', () => {
    const names = schemas.map(([name]) => name);
    for (const expected of ['meResponseSchema', 'staffUserResponseSchema']) {
      expect(names).toContain(expected);
    }
  });

  it('only the staff allow-list declares phone, Telegram ids or chat ids', () => {
    const offenders = schemas
      .filter(([, schema]) =>
        collectSchemaKeys(schema).some((key) => (PERSONAL_KEYS as readonly string[]).includes(key)),
      )
      .map(([name]) => name)
      .filter((name) => !(STAFF_SCHEMAS_WITH_PERSONAL_DATA as readonly string[]).includes(name))
      .sort();
    expect(offenders).toEqual([]);
  });

  it('GET /me exposes no Telegram id; the only phone is the caller own contact', () => {
    const keys = collectSchemaKeys(shared.meResponseSchema);
    expect(keys).not.toContain('telegramUserId');
    expect(keys).not.toContain('telegramChatId');
    expect(keys.filter((key) => key === 'phone')).toHaveLength(1);
    expect(Object.keys(shared.meResponseSchema.shape)).not.toContain('phone');
  });
});
