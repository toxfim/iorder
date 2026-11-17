import type { PriceListStatus } from '@iorder/shared';
import type { BadgeTone } from '@core/components/ui/AppBadge.vue';

/** Badge colour per version status: the live one is green, an open draft stands out in sand. */
export function versionStatusTone(status: PriceListStatus): BadgeTone {
  switch (status) {
    case 'PUBLISHED':
      return 'success';
    case 'DRAFT':
      return 'sand';
    case 'ARCHIVED':
      return 'neutral';
  }
}
