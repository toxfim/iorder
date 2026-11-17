import { PAYMENT_PLANS, type Locale, type PaymentPlan } from '@iorder/shared';
import { PAYMENT_METHODS, type PaymentMethod } from '@iorder/shared/staff-orders';
import { z } from 'zod';
import type { NotificationType } from '../orders/index.js';

// Order notification texts. PURE: payload JSON in, plain text out. The order itself is opened by
// the buttons under the message (order-buttons.ts), so no text carries a link.
//
// Hard rule 7 (cost data is staff-only) is enforced by construction: the payload is read through
// the two zod schemas below. They name every field a message may use and DROP everything else,
// so a field that is not listed here can never reach a text, whatever an outbox row contains.
// Nothing here knows about purchase prices, rates, margins or suppliers.

/** Who reads the message: the customer side (organization chat, the placer) or staff. */
export type Audience = 'CUSTOMER' | 'STAFF';

const REASON_MAX_LENGTH = 500;

const orderNumber = z.string().regex(/^IO-\d{1,12}$/);
const money = z.string().regex(/^\d{1,15}(\.\d{1,2})?$/);
const reason = z
  .string()
  .transform((value) => value.trim())
  .transform((value) => value.slice(0, REASON_MAX_LENGTH))
  .optional();

/** The only fields a customer-side message can use (mirrors `CUSTOMER_PAYLOAD_KEYS` of orders). */
const customerPayloadSchema = z.object({
  orderNumber,
  totalAmount: money.optional(),
  reason,
  oldTotalAmount: money.optional(),
  newTotalAmount: money.optional(),
  oldPaymentPlan: z.enum(PAYMENT_PLANS).optional(),
  newPaymentPlan: z.enum(PAYMENT_PLANS).optional(),
});

const quantity = z.string().regex(/^\d{1,15}(\.\d{1,3})?$/);
const label = (max: number) => z.string().transform((value) => value.trim().slice(0, max));

/** One order line of a staff message with lines. Unlisted fields (any cost) are dropped. */
const orderLineSchema = z.object({
  productCode: label(64),
  name: label(120),
  quantity,
  unitPrice: money,
  lineTotal: money,
  /** Only on the purchasing manager's rows: the lines are then grouped by it. */
  marked: z.boolean().optional(),
  supplies: z.array(
    z.object({ supplyRef: label(64), partyNumber: label(32).nullable(), quantity }),
  ),
});

/**
 * Staff additionally learn that the manager skipped accounting; the accountant's approval row also
 * has the sale's details ([C] owner 2026-10-30). Nothing else is added.
 */
const staffPayloadSchema = z.object({
  orderNumber,
  totalAmount: money.optional(),
  reason,
  oldTotalAmount: money.optional(),
  newTotalAmount: money.optional(),
  oldPaymentPlan: z.enum(PAYMENT_PLANS).optional(),
  newPaymentPlan: z.enum(PAYMENT_PLANS).optional(),
  accountingSkipped: z.boolean().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  paymentPlan: z.enum(PAYMENT_PLANS).optional(),
  orderLines: z.array(orderLineSchema).optional(),
  orderLineCount: z.int().nonnegative().optional(),
});

/** The field names each audience's messages can read; tests compare them with the orders side. */
export const CUSTOMER_MESSAGE_FIELDS: readonly string[] = Object.freeze(
  Object.keys(customerPayloadSchema.shape),
);
export const STAFF_MESSAGE_FIELDS: readonly string[] = Object.freeze(
  Object.keys(staffPayloadSchema.shape),
);

export interface RenderInput {
  type: NotificationType;
  audience: Audience;
  locale: Locale;
  /** `notification_outbox.payload`: JSON from our own database, still read through the schemas. */
  payload: unknown;
}

/** Formats "1234567.5" as "1 234 567,50 so'm": plain-space thousands, decimals only when present. */
export function formatMoney(amount: string, locale: Locale): string {
  const [whole = '0', fraction] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const decimals =
    fraction !== undefined && /[1-9]/.test(fraction) ? `,${fraction.padEnd(2, '0')}` : '';
  return `${grouped}${decimals} ${locale === 'RU' ? 'сум' : "so'm"}`;
}

interface Facts {
  n: string;
  total: string | null;
  reason: string | null;
  oldPlan: string | null;
  newPlan: string | null;
  oldTotal: string | null;
  newTotal: string | null;
  skipped: boolean;
}

interface Wording {
  reason: (text: string) => string;
  total: (amount: string) => string;
  cashWarning: string;
  markedGoods: string;
  otherGoods: string;
  saleType: (name: string) => string;
  paymentPlan: (name: string) => string;
  supply: (ref: string, party: string | null, pieces: string) => string;
  more: (count: number) => string;
  customer: Record<NotificationType, (facts: Facts) => string>;
  staff: Record<NotificationType, (facts: Facts) => string>;
}

const WORDING: Record<Locale, Wording> = {
  UZ: {
    reason: (text) => `Sabab: ${text}`,
    total: (amount) => `Summa: ${amount}`,
    cashWarning: "DIQQAT: naqd savdo. Счёт-фактура yo'q.",
    markedGoods: 'Markirovkali tovarlar:',
    otherGoods: 'Boshqa tovarlar:',
    saleType: (name) => `Savdo turi: ${name}`,
    paymentPlan: (name) => `To'lov turi: ${name}`,
    supply: (ref, party, pieces) =>
      `Supply ${ref}, ${party === null ? 'partiyasiz' : `partiya ${party}`}: ${pieces}`,
    more: (count) => `Yana ${count} ta tovar: to'liq ro'yxat uchun pastdagi tugmani bosing.`,
    customer: {
      ORDER_SUBMITTED: (f) => `Buyurtma ${f.n} qabul qilindi va menejer tasdig'ini kutmoqda.`,
      ORDER_MANAGER_APPROVED: (f) => `Buyurtma ${f.n} menejer tomonidan tasdiqlandi.`,
      ORDER_READY_TO_PREPARE: (f) => `Buyurtma ${f.n} menejer tomonidan tasdiqlandi.`,
      ORDER_ACCOUNTING_CLEARED: (f) => `Buyurtma ${f.n} buxgalteriya tomonidan tasdiqlandi.`,
      ORDER_REJECTED: (f) => `Buyurtma ${f.n} rad etildi.`,
      ORDER_CANCELLED: (f) => `Buyurtma ${f.n} bekor qilindi.`,
      ORDER_RELEASED: (f) => `Buyurtma ${f.n} ombordan chiqarildi va haydovchiga topshirildi.`,
      ORDER_DELIVERED: (f) =>
        `Buyurtma ${f.n} yetkazildi. Iltimos, qabul qilganingizni tasdiqlang.`,
      ORDER_RECEIVED: (f) => `Buyurtma ${f.n} qabul qilingan deb belgilandi.`,
      ORDER_ITEMS_EDITED: (f) =>
        `Buyurtma ${f.n} tarkibi menejer tomonidan o'zgartirildi.${f.oldTotal && f.newTotal ? `\nAvvalgi summa: ${f.oldTotal}\nYangi summa: ${f.newTotal}` : ''}`,
      ORDER_PAYMENT_PLAN_CHANGED: (f) =>
        `Buyurtma ${f.n} to'lov turi o'zgartirildi${f.oldPlan && f.newPlan ? `: ${f.oldPlan} → ${f.newPlan}` : ''}.${f.oldTotal && f.newTotal ? `\nAvvalgi summa: ${f.oldTotal}\nYangi summa: ${f.newTotal}` : ''}`,
    },
    staff: {
      ORDER_SUBMITTED: (f) => `Yangi buyurtma ${f.n}. Menejer tasdig'i kutilmoqda.`,
      ORDER_MANAGER_APPROVED: (f) =>
        `Buyurtma ${f.n} menejer tomonidan tasdiqlandi.${f.skipped ? " Menejer buxgalteriya tekshiruvini o'tkazib yubordi." : ' Buxgalteriya tekshiruvi kerak.'}`,
      ORDER_READY_TO_PREPARE: (f) =>
        `Buyurtma ${f.n} tasdiqlandi: tayyorlang va skanerlang. Buxgalteriya tasdig'idan keyin chiqariladi.`,
      ORDER_ACCOUNTING_CLEARED: (f) => `Buyurtma ${f.n} ombor uchun tayyor.`,
      ORDER_REJECTED: (f) => `Buyurtma ${f.n} rad etildi.`,
      ORDER_CANCELLED: (f) => `Buyurtma ${f.n} bekor qilindi.`,
      ORDER_RELEASED: (f) => `Sizga buyurtma ${f.n} biriktirildi: yetkazib berish kerak.`,
      ORDER_DELIVERED: (f) => `Buyurtma ${f.n} yetkazildi.`,
      ORDER_RECEIVED: (f) => `Mijoz buyurtma ${f.n} qabul qilinganini tasdiqladi.`,
      ORDER_ITEMS_EDITED: (f) =>
        `Buyurtma ${f.n} tarkibi o'zgartirildi.${f.oldTotal && f.newTotal ? `\nAvvalgi summa: ${f.oldTotal}\nYangi summa: ${f.newTotal}` : ''}`,
      ORDER_PAYMENT_PLAN_CHANGED: (f) =>
        `Mijoz buyurtma ${f.n} to'lov turini o'zgartirdi${f.oldPlan && f.newPlan ? `: ${f.oldPlan} → ${f.newPlan}` : ''}.${f.oldTotal && f.newTotal ? `\nAvvalgi summa: ${f.oldTotal}\nYangi summa: ${f.newTotal}` : ''}`,
    },
  },
  RU: {
    reason: (text) => `Причина: ${text}`,
    total: (amount) => `Сумма: ${amount}`,
    cashWarning: 'ВНИМАНИЕ: продажа за наличные. Счёт-фактуры нет.',
    markedGoods: 'Маркируемые товары:',
    otherGoods: 'Другие товары:',
    saleType: (name) => `Способ оплаты: ${name}`,
    paymentPlan: (name) => `Способ расчёта: ${name}`,
    supply: (ref, party, pieces) =>
      `Поставка ${ref}, ${party === null ? 'без партии' : `партия ${party}`}: ${pieces}`,
    more: (count) => `Ещё позиций: ${count}. Полный список откроется кнопкой ниже.`,
    customer: {
      ORDER_SUBMITTED: (f) => `Заказ ${f.n} принят и ожидает подтверждения менеджера.`,
      ORDER_MANAGER_APPROVED: (f) => `Заказ ${f.n} подтверждён менеджером.`,
      ORDER_READY_TO_PREPARE: (f) => `Заказ ${f.n} подтверждён менеджером.`,
      ORDER_ACCOUNTING_CLEARED: (f) => `Заказ ${f.n} подтверждён бухгалтерией.`,
      ORDER_REJECTED: (f) => `Заказ ${f.n} отклонён.`,
      ORDER_CANCELLED: (f) => `Заказ ${f.n} отменён.`,
      ORDER_RELEASED: (f) => `Заказ ${f.n} отпущен со склада и передан водителю.`,
      ORDER_DELIVERED: (f) => `Заказ ${f.n} доставлен. Пожалуйста, подтвердите получение.`,
      ORDER_RECEIVED: (f) => `Заказ ${f.n} отмечен как полученный.`,
      ORDER_ITEMS_EDITED: (f) =>
        `Состав заказа ${f.n} изменён менеджером.${f.oldTotal && f.newTotal ? `\nПрежняя сумма: ${f.oldTotal}\nНовая сумма: ${f.newTotal}` : ''}`,
      ORDER_PAYMENT_PLAN_CHANGED: (f) =>
        `Условия оплаты заказа ${f.n} изменены${f.oldPlan && f.newPlan ? `: ${f.oldPlan} → ${f.newPlan}` : ''}.${f.oldTotal && f.newTotal ? `\nПрежняя сумма: ${f.oldTotal}\nНовая сумма: ${f.newTotal}` : ''}`,
    },
    staff: {
      ORDER_SUBMITTED: (f) => `Новый заказ ${f.n}. Ожидает подтверждения менеджера.`,
      ORDER_MANAGER_APPROVED: (f) =>
        `Заказ ${f.n} подтверждён менеджером.${f.skipped ? ' Менеджер пропустил проверку бухгалтерии.' : ' Нужна проверка бухгалтерии.'}`,
      ORDER_READY_TO_PREPARE: (f) =>
        `Заказ ${f.n} подтверждён: подготовьте и отсканируйте. Отпуск после подтверждения бухгалтерии.`,
      ORDER_ACCOUNTING_CLEARED: (f) => `Заказ ${f.n} готов для склада.`,
      ORDER_REJECTED: (f) => `Заказ ${f.n} отклонён.`,
      ORDER_CANCELLED: (f) => `Заказ ${f.n} отменён.`,
      ORDER_RELEASED: (f) => `Вам назначен заказ ${f.n}: нужно доставить.`,
      ORDER_DELIVERED: (f) => `Заказ ${f.n} доставлен.`,
      ORDER_RECEIVED: (f) => `Клиент подтвердил получение заказа ${f.n}.`,
      ORDER_ITEMS_EDITED: (f) =>
        `Состав заказа ${f.n} изменён.${f.oldTotal && f.newTotal ? `\nПрежняя сумма: ${f.oldTotal}\nНовая сумма: ${f.newTotal}` : ''}`,
      ORDER_PAYMENT_PLAN_CHANGED: (f) =>
        `Клиент изменил условия оплаты заказа ${f.n}${f.oldPlan && f.newPlan ? `: ${f.oldPlan} → ${f.newPlan}` : ''}.${f.oldTotal && f.newTotal ? `\nПрежняя сумма: ${f.oldTotal}\nНовая сумма: ${f.newTotal}` : ''}`,
    },
  },
  EN: {
    reason: (text) => `Reason: ${text}`,
    total: (amount) => `Total: ${amount}`,
    cashWarning: 'WARNING: cash sale. No invoice (счёт-фактура).',
    markedGoods: 'Marked goods:',
    otherGoods: 'Other goods:',
    saleType: (name) => `Payment method: ${name}`,
    paymentPlan: (name) => `Payment plan: ${name}`,
    supply: (ref, party, pieces) =>
      `Supply ${ref}, ${party === null ? 'no party' : `party ${party}`}: ${pieces}`,
    more: (count) => `${count} more: the button below opens the full list.`,
    customer: {
      ORDER_SUBMITTED: (f) => `Order ${f.n} was received and is waiting for manager approval.`,
      ORDER_MANAGER_APPROVED: (f) => `Order ${f.n} was approved by the manager.`,
      ORDER_READY_TO_PREPARE: (f) => `Order ${f.n} was approved by the manager.`,
      ORDER_ACCOUNTING_CLEARED: (f) => `Order ${f.n} was approved by accounting.`,
      ORDER_REJECTED: (f) => `Order ${f.n} was rejected.`,
      ORDER_CANCELLED: (f) => `Order ${f.n} was cancelled.`,
      ORDER_RELEASED: (f) =>
        `Order ${f.n} was released from the warehouse and handed to the driver.`,
      ORDER_DELIVERED: (f) => `Order ${f.n} was delivered. Please confirm that you received it.`,
      ORDER_RECEIVED: (f) => `Order ${f.n} is marked as received.`,
      ORDER_ITEMS_EDITED: (f) =>
        `The items of order ${f.n} were changed by the manager.${f.oldTotal && f.newTotal ? `\nPrevious total: ${f.oldTotal}\nNew total: ${f.newTotal}` : ''}`,
      ORDER_PAYMENT_PLAN_CHANGED: (f) =>
        `The payment plan of order ${f.n} was changed${f.oldPlan && f.newPlan ? `: ${f.oldPlan} → ${f.newPlan}` : ''}.${f.oldTotal && f.newTotal ? `\nPrevious total: ${f.oldTotal}\nNew total: ${f.newTotal}` : ''}`,
    },
    staff: {
      ORDER_SUBMITTED: (f) => `New order ${f.n}. Waiting for manager approval.`,
      ORDER_MANAGER_APPROVED: (f) =>
        `Order ${f.n} was approved by the manager.${f.skipped ? ' The manager skipped the accounting check.' : ' Accounting review needed.'}`,
      ORDER_READY_TO_PREPARE: (f) =>
        `Order ${f.n} was approved: prepare and scan it. It can be released after accounting approves.`,
      ORDER_ACCOUNTING_CLEARED: (f) => `Order ${f.n} is ready for the warehouse.`,
      ORDER_REJECTED: (f) => `Order ${f.n} was rejected.`,
      ORDER_CANCELLED: (f) => `Order ${f.n} was cancelled.`,
      ORDER_RELEASED: (f) => `Order ${f.n} is assigned to you: please deliver it.`,
      ORDER_DELIVERED: (f) => `Order ${f.n} was delivered.`,
      ORDER_RECEIVED: (f) => `The customer confirmed receipt of order ${f.n}.`,
      ORDER_ITEMS_EDITED: (f) =>
        `The items of order ${f.n} were changed.${f.oldTotal && f.newTotal ? `\nPrevious total: ${f.oldTotal}\nNew total: ${f.newTotal}` : ''}`,
      ORDER_PAYMENT_PLAN_CHANGED: (f) =>
        `The customer changed the payment plan of order ${f.n}${f.oldPlan && f.newPlan ? `: ${f.oldPlan} → ${f.newPlan}` : ''}.${f.oldTotal && f.newTotal ? `\nPrevious total: ${f.oldTotal}\nNew total: ${f.newTotal}` : ''}`,
    },
  },
};

/** Types whose text states a reason; the reason line is added when the payload has one. */
const SHOWS_REASON: ReadonlySet<NotificationType> = new Set(['ORDER_REJECTED', 'ORDER_CANCELLED']);
/** Types whose text already names the totals themselves (an edit) and so skip the "Total" line. */
const NAMES_TOTALS: ReadonlySet<NotificationType> = new Set([
  'ORDER_ITEMS_EDITED',
  'ORDER_PAYMENT_PLAN_CHANGED',
]);

const PAYMENT_PLAN_NAMES: Record<Locale, Record<PaymentPlan, string>> = {
  UZ: { FULL: "Bittada to'lash", DEFERRED: "Bo'lib to'lash" },
  RU: { FULL: 'Оплата сразу', DEFERRED: 'Отсрочка' },
  EN: { FULL: 'Pay in full', DEFERRED: 'Pay in parts' },
};

const PAYMENT_METHOD_NAMES: Record<Locale, Record<PaymentMethod, string>> = {
  UZ: { CASH: 'Naqd', OFFICIAL: 'Official' },
  RU: { CASH: 'Наличные', OFFICIAL: 'Официально' },
  EN: { CASH: 'Cash', OFFICIAL: 'Official' },
};

/** Below Telegram's 4096 characters, leaving room for the "more" line. */
const MESSAGE_BUDGET = 3800;

/** "3.000" reads as "3", "1.500" as "1.5". */
const pieces = (value: string): string =>
  value.includes('.') ? value.replace(/\.?0+$/, '') : value;

function orderLineBlock(
  line: z.infer<typeof orderLineSchema>,
  index: number,
  locale: Locale,
): string {
  const wording = WORDING[locale];
  return [
    `${index + 1}. ${line.productCode} ${line.name}`,
    `${pieces(line.quantity)} x ${formatMoney(line.unitPrice, locale)} = ${formatMoney(line.lineTotal, locale)}`,
    ...line.supplies.map((supply) =>
      wording.supply(supply.supplyRef, supply.partyNumber, pieces(supply.quantity)),
    ),
  ].join('\n');
}

/** The lines that fit, then how many did not. `used`: what the rest of the message already takes. */
function fittedOrderLines(
  data: z.infer<typeof staffPayloadSchema>,
  locale: Locale,
  used: number,
): string[] {
  const lines = data.orderLines ?? [];
  const kept: string[] = [];
  let length = used;
  for (const [index, line] of lines.entries()) {
    const previous = lines[index - 1];
    const heading =
      line.marked === undefined || line.marked === previous?.marked
        ? null
        : WORDING[locale][line.marked ? 'markedGoods' : 'otherGoods'];
    const block = [
      ...(heading === null ? [] : [heading]),
      orderLineBlock(line, index, locale),
    ].join('\n');
    if (length + block.length + 1 > MESSAGE_BUDGET) break;
    kept.push(block);
    length += block.length + 1;
  }
  const omitted = Math.max(data.orderLineCount ?? lines.length, lines.length) - kept.length;
  return omitted > 0 ? [...kept, WORDING[locale].more(omitted)] : kept;
}

/**
 * The message for one outbox row and one reader, or null when the payload does not have the
 * expected shape (the dispatcher then fails the row instead of sending a half-empty message).
 */
export function renderNotification(input: RenderInput): string | null {
  const schema = input.audience === 'CUSTOMER' ? customerPayloadSchema : staffPayloadSchema;
  const parsed = schema.safeParse(input.payload);
  if (!parsed.success) return null;
  const data = parsed.data as z.infer<typeof staffPayloadSchema>;
  const wording = WORDING[input.locale];
  const money = (amount: string | undefined): string | null =>
    amount === undefined ? null : formatMoney(amount, input.locale);
  const planName = (plan: PaymentPlan | undefined): string | null =>
    plan === undefined ? null : PAYMENT_PLAN_NAMES[input.locale][plan];
  const facts: Facts = {
    n: data.orderNumber,
    total: money(data.totalAmount),
    reason: data.reason === undefined || data.reason === '' ? null : data.reason,
    oldPlan: planName(data.oldPaymentPlan),
    newPlan: planName(data.newPaymentPlan),
    oldTotal: money(data.oldTotalAmount),
    newTotal: money(data.newTotalAmount),
    skipped: input.audience === 'STAFF' && data.accountingSkipped === true,
  };

  const lines = [wording[input.audience === 'CUSTOMER' ? 'customer' : 'staff'][input.type](facts)];
  if (SHOWS_REASON.has(input.type) && facts.reason !== null)
    lines.push(wording.reason(facts.reason));
  const forAccountant = input.audience === 'STAFF' && input.type === 'ORDER_MANAGER_APPROVED';
  if (forAccountant && data.paymentMethod !== undefined) {
    if (data.paymentMethod === 'CASH') lines.splice(1, 0, wording.cashWarning);
    lines.push(wording.saleType(PAYMENT_METHOD_NAMES[input.locale][data.paymentMethod]));
  }
  if (forAccountant && data.paymentPlan !== undefined) {
    lines.push(wording.paymentPlan(PAYMENT_PLAN_NAMES[input.locale][data.paymentPlan]));
  }
  if (facts.total !== null && !NAMES_TOTALS.has(input.type)) lines.push(wording.total(facts.total));
  const forPurchasing =
    input.audience === 'STAFF' &&
    data.orderLines?.some((line) => line.marked !== undefined) === true;
  if (forAccountant || forPurchasing) {
    lines.push(...fittedOrderLines(data, input.locale, lines.join('\n').length));
  }
  return lines.join('\n');
}
