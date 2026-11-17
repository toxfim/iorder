import { LOCALES } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_PAYLOAD_KEYS, NOTIFICATION_TYPES } from '../orders/index.js';
import {
  CUSTOMER_MESSAGE_FIELDS,
  formatMoney,
  renderNotification,
  STAFF_MESSAGE_FIELDS,
  type Audience,
} from './message-templates.js';

const base = { orderNumber: 'IO-10001', totalAmount: '1234567.00' };
const payloadFor = (type: string): Record<string, unknown> => ({
  ...base,
  ...(type === 'ORDER_REJECTED' || type === 'ORDER_CANCELLED' ? { reason: 'Out of stock' } : {}),
  ...(type === 'ORDER_ITEMS_EDITED'
    ? { oldTotalAmount: '1000000.00', newTotalAmount: '950000.50', totalAmount: '950000.50' }
    : {}),
});

describe('every notification type renders in every language for both readers', () => {
  const audiences: Audience[] = ['CUSTOMER', 'STAFF'];
  for (const type of NOTIFICATION_TYPES) {
    for (const locale of LOCALES) {
      for (const audience of audiences) {
        it(`${type} / ${locale} / ${audience}`, () => {
          const text = renderNotification({
            type,
            audience,
            locale,
            payload: payloadFor(type),
          });
          expect(text).not.toBeNull();
          expect(text).toContain('IO-10001');
          // The buttons under the message open the order; the text never carries a link.
          expect(text).not.toMatch(/https?:|t\.me/);
          expect(text).not.toMatch(/undefined|null|\[object/);
          expect(text?.length ?? 0).toBeLessThan(1000);
        });
      }
    }
  }
});

describe('wording', () => {
  const render = (
    type: (typeof NOTIFICATION_TYPES)[number],
    locale: 'UZ' | 'RU' | 'EN',
    audience: Audience,
    payload: Record<string, unknown>,
  ) => renderNotification({ type, audience, locale, payload });

  it('writes the reason of a rejection or cancellation exactly as the staff member wrote it', () => {
    const payload = { ...base, reason: '  Tovar yo‘q (omborda tugagan)  ' };
    expect(render('ORDER_REJECTED', 'UZ', 'CUSTOMER', payload)).toContain(
      'Sabab: Tovar yo‘q (omborda tugagan)',
    );
    expect(render('ORDER_CANCELLED', 'RU', 'CUSTOMER', payload)).toContain('Причина:');
    expect(render('ORDER_CANCELLED', 'EN', 'STAFF', payload)).toContain('Reason:');
  });

  it('skips the reason line when there is none', () => {
    expect(render('ORDER_REJECTED', 'EN', 'CUSTOMER', base)).not.toContain('Reason');
    expect(render('ORDER_REJECTED', 'EN', 'CUSTOMER', { ...base, reason: '   ' })).not.toContain(
      'Reason',
    );
  });

  it('shows the old and the new total of an edit, formatted', () => {
    const plan = render('ORDER_PAYMENT_PLAN_CHANGED', 'UZ', 'CUSTOMER', {
      ...payloadFor('ORDER_PAYMENT_PLAN_CHANGED'),
      oldPaymentPlan: 'FULL',
      newPaymentPlan: 'DEFERRED',
      oldTotalAmount: '100.00',
      newTotalAmount: '120.00',
    });
    expect(plan).toContain("Bittada to'lash → Bo'lib to'lash");
    expect(plan).toContain("Yangi summa: 120 so'm");
    // Staff get this message only when the customer changed the plan.
    expect(
      render('ORDER_PAYMENT_PLAN_CHANGED', 'UZ', 'STAFF', {
        ...payloadFor('ORDER_PAYMENT_PLAN_CHANGED'),
        oldPaymentPlan: 'FULL',
        newPaymentPlan: 'DEFERRED',
      }),
    ).toContain('Mijoz buyurtma');

    const text = render('ORDER_ITEMS_EDITED', 'UZ', 'CUSTOMER', payloadFor('ORDER_ITEMS_EDITED'));
    expect(text).toContain("Avvalgi summa: 1 000 000 so'm");
    expect(text).toContain("Yangi summa: 950 000,50 so'm");
    // The edit text names the totals itself; no extra "total" line.
    expect(text).not.toContain('Summa: 950');
  });

  it('adds the total line to the other types, in the reader language', () => {
    expect(render('ORDER_MANAGER_APPROVED', 'UZ', 'CUSTOMER', base)).toContain(
      "Summa: 1 234 567 so'm",
    );
    expect(render('ORDER_MANAGER_APPROVED', 'RU', 'CUSTOMER', base)).toContain(
      'Сумма: 1 234 567 сум',
    );
    expect(render('ORDER_MANAGER_APPROVED', 'EN', 'CUSTOMER', base)).toContain(
      "Total: 1 234 567 so'm",
    );
  });

  it('tells accountants whether the manager skipped accounting (staff only)', () => {
    const skipped = { ...base, accountingSkipped: true };
    expect(render('ORDER_MANAGER_APPROVED', 'EN', 'STAFF', skipped)).toContain(
      'skipped the accounting',
    );
    expect(render('ORDER_MANAGER_APPROVED', 'EN', 'STAFF', base)).toContain(
      'Accounting review needed',
    );
    // A customer never learns about it, even if the field somehow reached the payload.
    expect(render('ORDER_MANAGER_APPROVED', 'EN', 'CUSTOMER', skipped)).not.toMatch(
      /accounting check|skipped/i,
    );
  });

  it('has no link line: a status message is its headline and the total', () => {
    const text = render('ORDER_RELEASED', 'EN', 'STAFF', base);
    expect(text).not.toContain('http');
    expect(text?.split('\n')).toHaveLength(2);
  });

  it('gives the driver and the customer different texts for a release', () => {
    expect(render('ORDER_RELEASED', 'EN', 'STAFF', base)).toContain('assigned to you');
    expect(render('ORDER_RELEASED', 'EN', 'CUSTOMER', base)).toContain('handed to the driver');
  });

  it('asks the customer to confirm receipt after delivery', () => {
    expect(render('ORDER_DELIVERED', 'EN', 'CUSTOMER', base)).toContain('confirm');
    expect(render('ORDER_DELIVERED', 'RU', 'CUSTOMER', base)).toContain('подтвердите');
    expect(render('ORDER_DELIVERED', 'UZ', 'CUSTOMER', base)).toContain('tasdiqlang');
  });

  it('truncates an over-long reason', () => {
    const text = render('ORDER_CANCELLED', 'EN', 'CUSTOMER', { ...base, reason: 'x'.repeat(5000) });
    expect(text?.length).toBeLessThan(700);
  });
});

describe('invalid payloads are not sent', () => {
  const invalid: unknown[] = [
    null,
    'text',
    42,
    [],
    {},
    { orderNumber: 'ORD-1' },
    { orderNumber: 'IO-1; DROP' },
    { orderNumber: 'IO-1', totalAmount: '12.345' },
    { orderNumber: 'IO-1', totalAmount: '-5' },
    { orderNumber: 'IO-1', totalAmount: 100 },
    { orderNumber: 'IO-1', reason: { nested: true } },
  ];
  it.each(invalid.map((p) => [JSON.stringify(p), p]))('%s -> null', (_name, payload) => {
    expect(
      renderNotification({
        type: 'ORDER_REJECTED',
        audience: 'CUSTOMER',
        locale: 'UZ',
        payload,
      }),
    ).toBeNull();
  });
});

describe('no field outside the allow-list can reach a message (hard rule 7)', () => {
  const COST_FIELDS = {
    costPrice: '987654.32',
    purchasePrice: '876543.21',
    cost: '765432.10',
    usdRate: '12345.67',
    margin: '24680.13',
    supplier: 'ACME-SUPPLIER-SECRET',
    supplierName: 'ACME-SUPPLIER-SECRET',
    note: 'INTERNAL-NOTE',
    driverUserId: 'driver-uuid-secret',
    actorRole: 'ADMIN-ROLE-SECRET',
    items: [{ name: 'ITEM-NAME-SECRET', unitCost: '555.55' }],
  };
  const SECRETS = [
    '987654',
    '876543',
    '765432',
    '12345.67',
    '24680',
    'ACME',
    'INTERNAL',
    'driver-uuid',
    'ADMIN-ROLE',
    'ITEM-NAME',
    '555.55',
  ];

  for (const type of NOTIFICATION_TYPES) {
    for (const locale of LOCALES) {
      for (const audience of ['CUSTOMER', 'STAFF'] as const) {
        it(`${type} / ${locale} / ${audience} ignores cost-like and internal fields`, () => {
          const text = renderNotification({
            type,
            audience,
            locale,
            payload: { ...payloadFor(type), ...COST_FIELDS },
          });
          expect(text).not.toBeNull();
          for (const secret of SECRETS) expect(text).not.toContain(secret);
        });
      }
    }
  }

  it('reads exactly the fields the orders module allows for customers (plus the order number)', () => {
    // The orders module cuts every customer payload to CUSTOMER_PAYLOAD_KEYS; the templates must
    // not read anything that list does not contain.
    for (const field of CUSTOMER_MESSAGE_FIELDS) expect(CUSTOMER_PAYLOAD_KEYS).toContain(field);
    expect([...CUSTOMER_MESSAGE_FIELDS].sort()).toEqual([
      'newPaymentPlan',
      'newTotalAmount',
      'oldPaymentPlan',
      'oldTotalAmount',
      'orderNumber',
      'reason',
      'totalAmount',
    ]);
  });

  it("lets staff read the customer fields, accountingSkipped and the accountant's sale details, and nothing else", () => {
    expect([...STAFF_MESSAGE_FIELDS].sort()).toEqual(
      [
        ...CUSTOMER_MESSAGE_FIELDS,
        'accountingSkipped',
        'paymentMethod',
        'paymentPlan',
        'orderLines',
        'orderLineCount',
      ].sort(),
    );
  });
});

describe("the accountant's approval message", () => {
  const honor = {
    productCode: 'HN14A',
    name: 'Honor 14A',
    quantity: '4.000',
    unitPrice: '1000000.00',
    lineTotal: '4000000.00',
    supplies: [
      { supplyRef: '77343', partyNumber: 'P-7', quantity: '3.000' },
      { supplyRef: '34343', partyNumber: null, quantity: '1.000' },
    ],
  };
  const payload = {
    ...base,
    paymentMethod: 'OFFICIAL',
    paymentPlan: 'DEFERRED',
    orderLines: [honor],
    orderLineCount: 1,
  };
  const render = (
    over: Record<string, unknown>,
    locale: (typeof LOCALES)[number] = 'UZ',
    audience: Audience = 'STAFF',
    type: (typeof NOTIFICATION_TYPES)[number] = 'ORDER_MANAGER_APPROVED',
  ): string => {
    const text = renderNotification({
      type,
      audience,
      locale,
      payload: { ...payload, ...over },
    });
    if (text === null) throw new Error('not rendered');
    return text;
  };

  it('Official: both names, the plan, every supply with its pieces and party, no warning', () => {
    const text = render({});
    expect(text).toContain('Savdo turi: Official');
    expect(text).toContain("To'lov turi: Bo'lib to'lash");
    expect(text).toContain('1. HN14A Honor 14A');
    expect(text).toContain("4 x 1 000 000 so'm = 4 000 000 so'm");
    expect(text).toContain('Supply 77343, partiya P-7: 3');
    expect(text).toContain('Supply 34343, partiyasiz: 1');
    expect(text).not.toContain('DIQQAT');
    expect(text).not.toContain('Счёт');
  });

  it.each(LOCALES)(
    'Naqd (%s): a warning right under the headline that says no invoice',
    (locale) => {
      const lines = render({ paymentMethod: 'CASH' }, locale).split('\n');
      expect(lines[1]).toMatch(/счёт-фактур/i);
      expect(lines.join('\n')).toContain(
        locale === 'RU' ? 'Наличные' : locale === 'UZ' ? 'Naqd' : 'Cash',
      );
    },
  );

  it.each(LOCALES)('a big order stays under the limit and points at the button (%s)', (locale) => {
    const orderLines = Array.from({ length: 30 }, () => ({
      ...honor,
      name: 'N'.repeat(500),
      supplies: Array.from({ length: 2 }, () => honor.supplies[0]),
    }));
    const text = render({ orderLines, orderLineCount: 45 }, locale);
    expect(text.length).toBeLessThan(4096);
    const kept = text.match(/^\d+\. /gm)?.length ?? 0;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(30);
    expect(text).toContain(String(45 - kept));
  });

  it('points at the button even when the row itself was already cut', () => {
    expect(render({ orderLineCount: 31 })).toContain('Yana 30 ta tovar');
  });

  it('drops a cost field inside a line and inside a supply', () => {
    const text = render({
      orderLines: [
        {
          ...honor,
          unitCost: '987654.32',
          supplier: 'ACME',
          supplies: [{ supplyRef: '1', partyNumber: null, quantity: '1', purchasePrice: '876543' }],
        },
      ],
    });
    for (const secret of ['987654', 'ACME', '876543']) expect(text).not.toContain(secret);
  });

  it('the customer side never reads the details, whatever the row holds', () => {
    const text = render({ paymentMethod: 'CASH' }, 'UZ', 'CUSTOMER');
    for (const secret of ['Savdo turi', "To'lov turi", 'Supply', 'HN14A', 'Счёт']) {
      expect(text).not.toContain(secret);
    }
  });

  it('other staff messages do not print them either', () => {
    const text = render({ paymentMethod: 'CASH' }, 'UZ', 'STAFF', 'ORDER_READY_TO_PREPARE');
    for (const secret of ['Savdo turi', 'Supply', 'HN14A', 'Счёт']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('formatMoney', () => {
  it.each([
    ['0', 'UZ', "0 so'm"],
    ['999', 'UZ', "999 so'm"],
    ['1000', 'UZ', "1 000 so'm"],
    ['1234567.00', 'UZ', "1 234 567 so'm"],
    ['1234567.5', 'UZ', "1 234 567,50 so'm"],
    ['1234567.05', 'EN', "1 234 567,05 so'm"],
    ['950000.50', 'RU', '950 000,50 сум'],
    ['100000000000', 'UZ', "100 000 000 000 so'm"],
  ] as const)('%s (%s) -> %s', (amount, locale, expected) => {
    expect(formatMoney(amount, locale)).toBe(expected);
  });

  it('uses a plain space, not a no-break space', () => {
    expect(formatMoney('1234567', 'UZ')).not.toMatch(new RegExp('[\u00a0\u202f]'));
  });
});

describe("the purchasing manager's message", () => {
  const orderLine = (code: string, marked: boolean) => ({
    productCode: code,
    name: `${code} name`,
    quantity: '2.000',
    unitPrice: '10.00',
    lineTotal: '20.00',
    marked,
    supplies: [],
  });

  it('names the order and groups the marked and the other goods', () => {
    const text = renderNotification({
      type: 'ORDER_SUBMITTED',
      audience: 'STAFF',
      locale: 'UZ',
      payload: {
        orderNumber: 'IO-1',
        totalAmount: '40.00',
        orderLines: [orderLine('A', true), orderLine('B', false)],
        orderLineCount: 2,
      },
    });
    expect(text).toContain('IO-1');
    const parts = ['Markirovkali tovarlar:', '1. A A name', 'Boshqa tovarlar:', '2. B B name'];
    const positions = parts.map((part) => text?.indexOf(part) ?? -1);
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('an order line with a cost field: the field is dropped', () => {
    const text = renderNotification({
      type: 'ORDER_CANCELLED',
      audience: 'STAFF',
      locale: 'EN',
      payload: {
        orderNumber: 'IO-1',
        reason: 'no',
        orderLines: [{ ...orderLine('A', true), costUsd: '999.99' }],
        orderLineCount: 1,
      },
    });
    expect(text).toContain('Marked goods:');
    expect(text).not.toContain('999.99');
  });
});
