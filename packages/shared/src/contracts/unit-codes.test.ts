import { describe, expect, it } from 'vitest';
import { wholeQuantityStringSchema } from './orders.js';
import { recordUnitCodeRequestSchema } from './staff-orders.js';
import {
  allowsCodeSlot,
  checkImei,
  checkMarking,
  checkSerial,
  passesLuhn,
  requiredCodeSlots,
} from './unit-codes.js';

// A valid IMEI (Luhn): 49015420323751 + check digit 8.
const IMEI = '490154203237518';

describe('IMEI', () => {
  it('accepts 15 digits with a valid check digit and removes visual separators', () => {
    expect(checkImei(IMEI)).toEqual({ ok: true, value: IMEI, key: IMEI });
    expect(checkImei('49-015420-323751-8')).toEqual({ ok: true, value: IMEI, key: IMEI });
    expect(checkImei(' 4901 5420 3237 518 ')).toMatchObject({ ok: true, value: IMEI });
  });

  it('rejects a wrong check digit (strict Luhn), wrong length, letters and repeated digits', () => {
    expect(checkImei('490154203237519')).toEqual({ ok: false, error: 'IMEI_CHECKSUM' });
    expect(checkImei('49015420323751')).toEqual({ ok: false, error: 'IMEI_FORMAT' });
    expect(checkImei('49015420323751A')).toEqual({ ok: false, error: 'IMEI_FORMAT' });
    expect(checkImei('000000000000000')).toEqual({ ok: false, error: 'REPEATED_CHARACTER' });
    expect(checkImei('  ')).toEqual({ ok: false, error: 'EMPTY' });
  });

  it('Luhn', () => {
    expect(passesLuhn('79927398713')).toBe(true);
    expect(passesLuhn('79927398710')).toBe(false);
  });
});

describe('serial', () => {
  it('accepts 5-64 of A-Z a-z 0-9 - _ / and compares case-insensitively', () => {
    expect(checkSerial('R58T12abc3X')).toEqual({
      ok: true,
      value: 'R58T12abc3X',
      key: 'R58T12ABC3X',
    });
    expect(checkSerial('SN-12/34_5')).toMatchObject({ ok: true });
  });

  it('rejects Cyrillic (a scanner in the wrong layout) instead of stripping it', () => {
    expect(checkSerial('R58Т12АВС')).toEqual({ ok: false, error: 'NOT_ASCII' });
  });

  it('rejects too short, too long, other characters and one repeated character', () => {
    expect(checkSerial('AB12')).toEqual({ ok: false, error: 'SERIAL_FORMAT' });
    expect(checkSerial('A'.repeat(65))).toEqual({ ok: false, error: 'SERIAL_FORMAT' });
    expect(checkSerial('AB12#34')).toEqual({ ok: false, error: 'SERIAL_FORMAT' });
    expect(checkSerial('11111111')).toEqual({ ok: false, error: 'REPEATED_CHARACTER' });
  });
});

describe('marking', () => {
  const gs = '\u001d';

  it('keeps the full code and keys on the GS1 01 + 21 part when the group separator is there', () => {
    const code = `0104600000000017215abcDEF123456${gs}93AbCd`;
    expect(checkMarking(code)).toEqual({
      ok: true,
      value: code,
      key: '0104600000000017215abcDEF123456',
    });
  });

  it('uses the whole code as the key when the separator was lost', () => {
    expect(checkMarking('0104600000000017215abc93AbCd')).toEqual({
      ok: true,
      value: '0104600000000017215abc93AbCd',
      key: '0104600000000017215abc93AbCd',
    });
  });

  it('rejects empty, too long and non-ASCII codes', () => {
    expect(checkMarking(' ')).toEqual({ ok: false, error: 'EMPTY' });
    expect(checkMarking('x'.repeat(513))).toEqual({ ok: false, error: 'MARKING_LENGTH' });
    expect(checkMarking('01046Ж')).toEqual({ ok: false, error: 'NOT_ASCII' });
  });
});

describe('product code rule', () => {
  it('IMEI1 (+ marking) is required, IMEI2 is optional', () => {
    const rule = { trackingType: 'IMEI', markingRequired: true } as const;
    expect(requiredCodeSlots(rule)).toEqual([
      { kind: 'IMEI', slot: 1 },
      { kind: 'MARKING', slot: 1 },
    ]);
    expect(allowsCodeSlot(rule, 'IMEI', 2)).toBe(true);
    expect(allowsCodeSlot(rule, 'IMEI', 3)).toBe(false);
    expect(allowsCodeSlot(rule, 'SERIAL', 1)).toBe(false);
  });

  it('quantity goods need nothing and allow nothing', () => {
    const rule = { trackingType: 'NONE', markingRequired: false } as const;
    expect(requiredCodeSlots(rule)).toEqual([]);
    expect(allowsCodeSlot(rule, 'MARKING', 1)).toBe(false);
  });
});

describe('requests', () => {
  it('orders whole pieces only', () => {
    expect(wholeQuantityStringSchema.safeParse('2').success).toBe(true);
    expect(wholeQuantityStringSchema.safeParse('2.000').success).toBe(true);
    expect(wholeQuantityStringSchema.safeParse('2.5').success).toBe(false);
    expect(wholeQuantityStringSchema.safeParse('0.001').success).toBe(false);
  });

  it('a scan defaults to slot 1 and is strict', () => {
    expect(recordUnitCodeRequestSchema.parse({ kind: 'IMEI', value: IMEI })).toEqual({
      kind: 'IMEI',
      slot: 1,
      value: IMEI,
    });
    expect(
      recordUnitCodeRequestSchema.safeParse({ kind: 'IMEI', slot: 3, value: IMEI }).success,
    ).toBe(false);
    expect(recordUnitCodeRequestSchema.safeParse({ kind: 'EAN', value: '1' }).success).toBe(false);
  });
});
