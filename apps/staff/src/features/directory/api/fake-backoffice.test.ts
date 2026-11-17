import { describe, expect, it } from 'vitest';
import { fakeUuid } from '@core/lib/fake-ids';
import { ApiNotFoundError, PermissionDeniedError } from '@core/lib/api-errors';
import { createTestServices } from '@/test-utils/create-test-services';

const setup = () => {
  return createTestServices().back;
};

describe('fake backoffice: directory', () => {
  it('blocks and activates organizations and members, and changes a member role', async () => {
    const { directoryApi } = setup();
    expect(
      (await directoryApi.setOrganizationActive(fakeUuid('org-gsm-plus'), false)).isActive,
    ).toBe(false);
    expect((await directoryApi.setMemberActive(fakeUuid('u-132'), true)).isActive).toBe(true);
    expect(
      (
        await directoryApi.setMemberRole(
          fakeUuid('u-102'),
          fakeUuid('org-orion-mobile'),
          'SHOP_OWNER',
        )
      ).role,
    ).toBe('SHOP_OWNER');
    await expect(directoryApi.setOrganizationActive('nope', true)).rejects.toBeInstanceOf(
      ApiNotFoundError,
    );
  });
});

describe('fake backoffice: dev scenarios', () => {
  it('simulates denied, error and empty reads', async () => {
    for (const [scenario, check] of [
      ['denied', (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(PermissionDeniedError)],
      ['error', (p: Promise<unknown>) => expect(p).rejects.toThrow(/simulated failure/)],
      ['empty', (p: Promise<unknown>) => expect(p).resolves.toEqual([])],
    ] as const) {
      const { back } = createTestServices({ scenario });
      await check(back.directoryApi.listOrganizations());
    }
  });
});
