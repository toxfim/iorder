import { customerRu } from '@/features/customer-app/messages/ru';
import type { MessageSchema } from './uz';

export const ru: MessageSchema = {
  customer: customerRu,
  nav: {
    ariaLabel: 'Главное меню',
    customer: {
      catalog: 'Цены',
      cart: 'Корзина',
      orders: 'Заказы',
    },
  },
};
