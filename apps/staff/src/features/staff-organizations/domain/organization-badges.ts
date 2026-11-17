import type { OrganizationLabel, OrganizationType } from '@iorder/shared';
import type { BadgeTone } from '@core/components/ui/AppBadge.vue';
import type { OrganizationDisplayStatus } from './organization-model';

// One tone per value, so the list, the detail and the dialogs colour them alike. Every pill also
// carries its word: colour is never the only signal.

export const TYPE_TONE: Readonly<Record<OrganizationType, BadgeTone>> = {
  GROUP: 'neutral',
  PERSON: 'info',
};

export const LABEL_TONE: Readonly<Record<OrganizationLabel, BadgeTone>> = {
  STANDARD: 'muted',
  WHOLESALE: 'sand',
  PARTNER: 'accent',
  ALIF_FACTORING: 'dark',
};

export const STATUS_TONE: Readonly<Record<OrganizationDisplayStatus, BadgeTone>> = {
  ACTIVE: 'success',
  INACTIVE: 'accent',
  PENDING: 'warning',
  EXPIRED: 'danger',
};
