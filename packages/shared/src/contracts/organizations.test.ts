import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_LABELS,
  PRICE_TIER_OF_LABEL,
  createOrganizationRequestSchema,
  organizationInviteStartPayloadSchema,
  priceTierOfLabel,
  updateOrganizationRequestSchema,
} from './organizations.js';

describe('label -> price tier [C, owner 2026-11-11]', () => {
  it('maps STANDARD and ALIF_FACTORING to their own tiers and WHOLESALE and PARTNER to the shared one', () => {
    expect(PRICE_TIER_OF_LABEL).toEqual({
      STANDARD: 'STANDARD',
      WHOLESALE: 'WHOLESALE_PARTNER',
      PARTNER: 'WHOLESALE_PARTNER',
      // [C, owner 2026-11-12]
      ALIF_FACTORING: 'ALIF_FACTORING',
    });
    for (const label of ORGANIZATION_LABELS) {
      expect(priceTierOfLabel(label)).toBe(PRICE_TIER_OF_LABEL[label]);
    }
  });

  it('is frozen: the mapping cannot be changed at run time', () => {
    expect(Object.isFrozen(PRICE_TIER_OF_LABEL)).toBe(true);
  });
});

describe('create organization request', () => {
  it('needs a type; the label defaults to STANDARD and the phone to none', () => {
    expect(createOrganizationRequestSchema.safeParse({ name: 'Ali' }).success).toBe(false);
    expect(createOrganizationRequestSchema.parse({ type: 'PERSON', name: ' Ali ' })).toEqual({
      type: 'PERSON',
      name: 'Ali',
      phone: null,
      label: 'STANDARD',
    });
  });

  it('normalizes a typed phone and refuses a Telegram id or unknown fields', () => {
    expect(
      createOrganizationRequestSchema.parse({
        type: 'GROUP',
        name: 'Shop',
        phone: '+998 (90) 123-45-67',
        label: 'PARTNER',
      }),
    ).toMatchObject({ phone: '+998901234567', label: 'PARTNER' });
    expect(
      createOrganizationRequestSchema.safeParse({
        type: 'PERSON',
        name: 'Ali',
        telegramUserId: '123',
      }).success,
    ).toBe(false);
  });

  it('lets staff change the label, the phone and the type later (the server checks the chat)', () => {
    expect(updateOrganizationRequestSchema.safeParse({ label: 'WHOLESALE' }).success).toBe(true);
    expect(updateOrganizationRequestSchema.safeParse({ phone: null }).success).toBe(true);
    expect(updateOrganizationRequestSchema.safeParse({ type: 'PERSON' }).success).toBe(true);
    expect(updateOrganizationRequestSchema.safeParse({ type: 'TEAM' }).success).toBe(false);
  });
});

describe('invite start payload', () => {
  it('is org_ plus 43 base64url characters, within Telegram limits', () => {
    const payload = `org_${'a'.repeat(43)}`;
    expect(payload.length).toBeLessThanOrEqual(64);
    expect(organizationInviteStartPayloadSchema.safeParse(payload).success).toBe(true);
    expect(organizationInviteStartPayloadSchema.safeParse(`staff_${'a'.repeat(43)}`).success).toBe(
      false,
    );
    expect(organizationInviteStartPayloadSchema.safeParse(`org_${'a'.repeat(42)}`).success).toBe(
      false,
    );
  });
});
