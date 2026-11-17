import { staffCostMessages } from '@/features/staff-cost/messages';
import { staffCommonMessages } from '@/features/staff-common/messages';
import { staffOrdersMessages } from '@/features/staff-orders/messages';
import { staffOrganizationsMessages } from '@/features/staff-organizations/messages';
import { staffUsersMessages } from '@/features/staff-users/messages';
import type { AppI18n } from '@core/i18n';

/**
 * Unit tests mount staff screens directly, without the router that loads the staff-only labels
 * (cost and back-office orders) lazily.
 */
export function withStaffCostMessages<T extends AppI18n>(i18n: T): T {
  for (const locale of ['uz', 'ru', 'en'] as const) {
    i18n.global.mergeLocaleMessage(locale, staffCommonMessages[locale]);
    i18n.global.mergeLocaleMessage(locale, {
      staffCost: staffCostMessages[locale],
      orders: staffOrdersMessages[locale],
      organizations: staffOrganizationsMessages[locale],
      staffUsers: staffUsersMessages[locale],
    });
  }
  return i18n;
}
