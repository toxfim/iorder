import type { StaffPersonCard, StaffRole } from '@iorder/shared';
import { ApiResponseError, PermissionDeniedError } from '@core/lib/api-errors';
import type { PeopleApi } from './people-api';

// Dev and test only (behind the fake-API gate, never in a production bundle): any id answers with
// one demo person, because the demo screens each invent their own people.
const DEMO_CARD: StaffPersonCard = {
  id: '00000000-0000-7000-8000-000000000001',
  fullName: 'Aziza Yusupova',
  phone: '+998901234567',
  status: 'ACTIVE',
  staffRoles: ['MANAGER'],
  membership: null,
};

const CARD_ROLES: readonly StaffRole[] = ['MANAGER', 'ACCOUNTANT', 'ADMIN', 'PURCHASING_MANAGER'];

export function createFakePeopleApi(roles: () => readonly StaffRole[]): PeopleApi {
  return {
    card: (person) => {
      if (!roles().some((role) => CARD_ROLES.includes(role))) {
        return Promise.reject(new PermissionDeniedError());
      }
      if (person.telegramUserId === '404')
        return Promise.reject(new ApiResponseError('Not found', 404, 'NOT_FOUND'));
      return Promise.resolve(DEMO_CARD);
    },
  };
}
