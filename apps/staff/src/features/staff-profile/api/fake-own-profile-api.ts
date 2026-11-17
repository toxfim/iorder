import { updateOwnStaffProfileRequestSchema } from '@iorder/shared/staff-auth';
import { ApiValidationError } from '@core/lib/api-errors';
import type { OwnProfile, OwnProfileApi } from './own-profile-api';

// Dev and test only (behind the fake-API gate, never in a production bundle). One profile per
// demo person, kept in memory: the name starts as the session's, the phone is not set, and the
// input is checked with the real contract so the forms meet the server's rules.
export function createFakeOwnProfileApi(
  person: () => { readonly id: string; readonly displayName: string } | null,
  initialPhone: string | null = null,
): OwnProfileApi {
  const saved = new Map<string, OwnProfile>();
  const current = (): { id: string; profile: OwnProfile } => {
    const who = person();
    if (who === null) throw new Error('Nobody is signed in');
    return {
      id: who.id,
      profile: saved.get(who.id) ?? { fullName: who.displayName, phone: initialPhone },
    };
  };
  return {
    get: () => Promise.resolve().then(() => ({ ...current().profile })),
    update: (request) =>
      Promise.resolve().then(() => {
        const parsed = updateOwnStaffProfileRequestSchema.safeParse(request);
        if (!parsed.success) {
          throw new ApiValidationError(
            'Request validation failed',
            'VALIDATION_FAILED',
            parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join('.'),
              message: issue.message,
            })),
          );
        }
        saved.set(current().id, { ...parsed.data });
        return { ...parsed.data };
      }),
  };
}
