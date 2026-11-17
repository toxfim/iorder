import { describe, expect, it } from 'vitest';
import { rememberedListQuery } from '@/features/staff-orders/composables/orders-list-memory';
import { createFakeServices } from './fake-services';

describe('fake services wiring', () => {
  it('forgets the remembered orders-list filters on sign-out', async () => {
    const services = createFakeServices();
    await services.currentUser.signIn('manager');
    rememberedListQuery.value = { stage: 'SUBMITTED', pay: 'UNPAID' };
    await services.currentUser.signOut();
    expect(rememberedListQuery.value).toEqual({});
  });
});
