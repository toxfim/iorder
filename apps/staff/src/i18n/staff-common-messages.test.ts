import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { createFakeAuthApi } from '@/features/auth/api/fake-auth-api';
import { createCurrentUserStore } from '@/features/auth/composables/current-user-store';
import { createAppRouter } from '@/router';
import { createAppI18n } from './index';
import { ensureStaffCommonMessages } from './staff-common-messages';

describe('lazy staff common labels', () => {
  it('are missing from a fresh instance and merged at the root on demand', async () => {
    const i18n = createAppI18n('RU');
    expect(i18n.global.te('activity.ORDER_APPROVED_SKIP_ACCOUNTING', 'ru')).toBe(false);
    await ensureStaffCommonMessages(i18n);
    expect(i18n.global.te('activity.ORDER_APPROVED_SKIP_ACCOUNTING', 'ru')).toBe(true);
    expect(i18n.global.te('dashboard.queue.title', 'uz')).toBe(true);
  });

  it('are not loaded for customer pages', async () => {
    const i18n = createAppI18n('UZ');
    const router = createAppRouter(
      createCurrentUserStore(createFakeAuthApi({ initialIdentityId: 'owner' })),
      createMemoryHistory(),
      i18n,
    );
    await router.push('/cart');
    expect(i18n.global.te('dashboard.queue.title', 'uz')).toBe(false);
  });
});
