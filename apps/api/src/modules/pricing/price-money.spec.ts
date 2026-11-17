import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { upsertItemsSchema } from './dto/pricing.schemas.js';
import { formatMoney, parsePrice, toUsd, toUzs, uzsToUsd } from './price-money.js';

describe('parsePrice', () => {
  it.each(['1', '0.01', '10.5', '1690000.10', '9999999999999999.99', '100'])(
    'accepts %s',
    (input) => {
      expect(parsePrice(input)).not.toBeNull();
    },
  );

  it.each([
    ['zero', '0'],
    ['zero with fraction', '0.00'],
    ['negative', '-1.00'],
    ['three fraction digits (never rounded)', '10.001'],
    ['exponent', '1e3'],
    ['thousands separator', '1,000.00'],
    ['comma decimal', '10,50'],
    ['leading zeros', '007'],
    ['leading plus', '+5'],
    ['whitespace', ' 5 '],
    ['empty', ''],
    ['trailing dot', '5.'],
    ['17 integer digits (overflow DECIMAL(18,2))', '10000000000000000'],
    ['NaN text', 'NaN'],
    ['Infinity text', 'Infinity'],
  ])('rejects %s', (_name, input) => {
    expect(parsePrice(input)).toBeNull();
  });

  it('keeps exact decimal precision (no float drift)', () => {
    const sum = parsePrice('0.10')!.plus(parsePrice('0.20')!);
    expect(formatMoney(sum)).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3); // the float behaviour we are avoiding
    expect(formatMoney(parsePrice('9999999999999999.99')!)).toBe('9999999999999999.99');
  });
});

describe('formatMoney', () => {
  it('always uses two fraction digits and no exponent', () => {
    expect(formatMoney(new Prisma.Decimal('5'))).toBe('5.00');
    expect(formatMoney(new Prisma.Decimal('1690000.1'))).toBe('1690000.10');
    expect(formatMoney(new Prisma.Decimal('1e21'))).toBe('1000000000000000000000.00');
  });
});

describe('upsertItemsSchema (shared rules + Decimal conversion)', () => {
  const productId = '019a0000-0000-7000-8000-000000000001';
  const parse = (basePrice: unknown) =>
    upsertItemsSchema.safeParse({ items: [{ productId, basePrice }] });

  it('rejects JSON numbers because they are floats', () => {
    expect(parse(1690000.1).success).toBe(false);
  });
  it('turns a valid string into a Decimal', () => {
    const parsed = upsertItemsSchema.parse({ items: [{ productId, basePrice: '1690000.10' }] });
    const price = parsed.items[0]!.basePrice;
    expect(price).toBeInstanceOf(Prisma.Decimal);
    expect(price.toFixed(2)).toBe('1690000.10');
  });
  it('reports a validation issue for an invalid string', () => {
    expect(parse('1.234').success).toBe(false);
  });
});

describe('uzsToUsd: round(amount / rate, 6), half up', () => {
  const d = (value: string) => new Prisma.Decimal(value);

  it.each([
    ['3750.50', '12000.0000', '0.312542'],
    ['6000.00', '12000.0000', '0.500000'],
    ['15000.00', '12650.0000', '1.185771'],
    ['30000.00', '12650.0000', '2.371542'],
    ['1.00', '12650.0000', '0.000079'],
    ['0.00', '12000.0000', '0.000000'],
  ])('%s at %s is %s', (amount, rate, usd) => {
    expect(uzsToUsd(d(amount), d(rate)).toFixed(6)).toBe(usd);
  });

  it('half a millionth goes up, just under stays down', () => {
    expect(uzsToUsd(d('0.01'), d('20000')).toFixed(6)).toBe('0.000001'); // 0.0000005
    expect(uzsToUsd(d('0.01'), d('20000.0001')).toFixed(6)).toBe('0.000000');
  });

  it('decides the half unit on the digits of the largest amounts, without rounding twice', () => {
    expect(uzsToUsd(d('9999999999999999.99'), d('3')).toFixed(6)).toBe('3333333333333333.330000');
    expect(uzsToUsd(d('2000000449999999.99'), d('10000000000000')).toFixed(6)).toBe('200.000045');
    expect(uzsToUsd(d('2000000450000000.00'), d('10000000000000')).toFixed(6)).toBe('200.000045');
  });
});

describe('toUzs / toUsd', () => {
  const rate = new Prisma.Decimal('11960');
  const d = (value: string) => new Prisma.Decimal(value);

  it("converts a USD price to whole so'm, half up (owner 2026-10-29)", () => {
    expect(toUzs(d('85'), 'USD', rate)?.toFixed(2)).toBe('1016600.00');
    expect(toUzs(d('183.75'), 'USD', rate)?.toFixed(2)).toBe('2197650.00');
    // 123.455 -> 123; 0.5 -> 1.
    expect(toUzs(d('0.01'), 'USD', d('12345.5'))?.toFixed(2)).toBe('123.00');
    expect(toUzs(d('0.05'), 'USD', d('10'))?.toFixed(2)).toBe('1.00');
  });

  it('keeps a UZS price and has no UZS price for USD without a rate', () => {
    expect(toUzs(d('246000'), 'UZS', null)?.toFixed(2)).toBe('246000.00');
    expect(toUzs(d('85'), 'USD', null)).toBeNull();
  });

  it('converts an older UZS price to USD cents and keeps a USD one', () => {
    expect(toUsd(d('246000'), 'UZS', rate)?.toFixed(2)).toBe('20.57');
    expect(toUsd(d('85.5'), 'USD', null)?.toFixed(2)).toBe('85.50');
    expect(toUsd(d('246000'), 'UZS', null)).toBeNull();
  });

  it('rejects an unknown currency instead of guessing', () => {
    expect(() => toUzs(d('1'), 'EUR', rate)).toThrow();
    expect(() => toUsd(d('1'), 'EUR', rate)).toThrow();
  });
});
