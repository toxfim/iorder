import { customerEn } from '@/features/customer-app/messages/en';
import type { MessageSchema } from './uz';

export const en: MessageSchema = {
  customer: customerEn,
  nav: {
    ariaLabel: 'Main menu',
    customer: {
      catalog: 'Prices',
      cart: 'Cart',
      orders: 'Orders',
    },
  },
};
