import type { StaffRole } from '@iorder/shared';
import 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    /** Which route group the page belongs to; drives the guard. */
    area?: 'public' | 'staff';
    /** Staff roles allowed in. Missing means any staff role. */
    staffRoles?: readonly StaffRole[];
  }
}
