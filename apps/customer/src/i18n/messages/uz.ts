import { customerUz } from '@/features/customer-app/messages/uz';

// Uzbek is the default and the source of truth for the shape of the customer catalog. The shared
// sections (common, state, apiErrors) come from web-core.
export const uz = {
  customer: customerUz,
  nav: {
    ariaLabel: 'Asosiy menyu',
    customer: {
      catalog: 'Narxlar',
      cart: 'Savat',
      orders: 'Buyurtmalar',
    },
  },
} as const;

type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };
export type MessageSchema = Widen<typeof uz>;
