// Unit identification codes scanned by the warehouse while picking an order ([C] 2026-10-25,
// modelled on the reference-distributor project). ONE validator for api and web: the web uses it for
// instant feedback, the api is the authority. Bad characters are REJECTED, never stripped: a
// scanner in a Cyrillic keyboard layout must fail loudly instead of saving a shortened serial.

import { z } from 'zod';

export const UNIT_CODE_KINDS = ['IMEI', 'SERIAL', 'MARKING'] as const;
export type UnitCodeKind = (typeof UNIT_CODE_KINDS)[number];
export const unitCodeKindSchema = z.enum(UNIT_CODE_KINDS);

/**
 * The code a product needs per unit: NONE = quantity goods. IMEI and SERIAL exclude each other;
 * a marking code (`markingRequired`) is independent of it (reference-distributor model).
 */
export const TRACKING_TYPES = ['NONE', 'IMEI', 'SERIAL'] as const;
export type TrackingType = (typeof TRACKING_TYPES)[number];
export const trackingTypeSchema = z.enum(TRACKING_TYPES);

/** IMEI2 (dual SIM) is optional; IMEI1, the serial and a required marking are mandatory. */
export const MAX_IMEI_SLOTS = 2;

export interface UnitCodeRule {
  trackingType: TrackingType;
  markingRequired: boolean;
}

/** The (kind, slot) pairs a unit MUST have before the order can be released. */
export function requiredCodeSlots(rule: UnitCodeRule): { kind: UnitCodeKind; slot: number }[] {
  const slots: { kind: UnitCodeKind; slot: number }[] = [];
  if (rule.trackingType === 'IMEI') slots.push({ kind: 'IMEI', slot: 1 });
  if (rule.trackingType === 'SERIAL') slots.push({ kind: 'SERIAL', slot: 1 });
  if (rule.markingRequired) slots.push({ kind: 'MARKING', slot: 1 });
  return slots;
}

/** Whether the rule lets a unit carry this (kind, slot) at all (required or the optional IMEI2). */
export function allowsCodeSlot(rule: UnitCodeRule, kind: UnitCodeKind, slot: number): boolean {
  if (kind === 'IMEI') return rule.trackingType === 'IMEI' && slot >= 1 && slot <= MAX_IMEI_SLOTS;
  if (kind === 'SERIAL') return rule.trackingType === 'SERIAL' && slot === 1;
  return rule.markingRequired && slot === 1;
}

export const UNIT_CODE_ERRORS = [
  'EMPTY',
  'NOT_ASCII',
  'IMEI_FORMAT',
  'IMEI_CHECKSUM',
  'REPEATED_CHARACTER',
  'SERIAL_FORMAT',
  'MARKING_LENGTH',
] as const;
export type UnitCodeError = (typeof UNIT_CODE_ERRORS)[number];

export const SERIAL_MIN_LENGTH = 5;
export const SERIAL_MAX_LENGTH = 64;
export const MARKING_MAX_LENGTH = 512;

/** GS1 group separator inside a Data Matrix marking code. Scanners may send it as-is. */
const GROUP_SEPARATOR = '\u001d';
// Only visual separators are removed: IMEI drops spaces, dots and dashes; a serial only spaces
// (dashes are part of many serials). `\s` also covers the no-break space.
const IMEI_SEPARATORS = /[\s.-]/g;
const SERIAL_SEPARATORS = /\s/g;
const SERIAL_PATTERN = /^[A-Za-z0-9\-_/]+$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
// Built from the constant: the separator is data here, not a typo in a pattern.
const MARKING_CHARACTERS = new RegExp(`^[${GROUP_SEPARATOR}\\x20-\\x7e]*$`);
const MARKING_IDENTIFIER = new RegExp(
  `^${GROUP_SEPARATOR}?01(\\d{14})21([^${GROUP_SEPARATOR}]{1,20})${GROUP_SEPARATOR}`,
);

export type UnitCodeCheck =
  { ok: true; value: string; key: string } | { ok: false; error: UnitCodeError };

/** Luhn check digit test over a string of digits (IMEI's 15th digit). */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function allSameCharacter(value: string): boolean {
  return value.length > 0 && [...value].every((char) => char === value[0]);
}

/** IMEI: exactly 15 digits after removing spaces, dots and dashes, strict Luhn, not 000.. */
export function checkImei(raw: string): UnitCodeCheck {
  const value = raw.replace(IMEI_SEPARATORS, '');
  if (value === '') return { ok: false, error: 'EMPTY' };
  if (!/^\d{15}$/.test(value)) return { ok: false, error: 'IMEI_FORMAT' };
  if (allSameCharacter(value)) return { ok: false, error: 'REPEATED_CHARACTER' };
  if (!passesLuhn(value)) return { ok: false, error: 'IMEI_CHECKSUM' };
  return { ok: true, value, key: value };
}

/** Serial: 5-64 of [A-Za-z0-9-_/] after removing spaces; compared case-insensitively. */
export function checkSerial(raw: string): UnitCodeCheck {
  const value = raw.replace(SERIAL_SEPARATORS, '');
  if (value === '') return { ok: false, error: 'EMPTY' };
  if (!PRINTABLE_ASCII.test(value)) return { ok: false, error: 'NOT_ASCII' };
  if (
    value.length < SERIAL_MIN_LENGTH ||
    value.length > SERIAL_MAX_LENGTH ||
    !SERIAL_PATTERN.test(value)
  ) {
    return { ok: false, error: 'SERIAL_FORMAT' };
  }
  if (allSameCharacter(value)) return { ok: false, error: 'REPEATED_CHARACTER' };
  return { ok: true, value, key: value.toUpperCase() };
}

/**
 * Marking (Asl belgisi / Data Matrix): the full code is kept as scanned (the crypto tail is
 * needed for state reporting). The uniqueness key is the GS1 identification part
 * 01<GTIN-14>21<serial> when the code has that shape with its group separator, otherwise the
 * whole code without separators.
 */
export function checkMarking(raw: string): UnitCodeCheck {
  const value = raw.trim();
  if (value === '') return { ok: false, error: 'EMPTY' };
  if (value.length > MARKING_MAX_LENGTH) return { ok: false, error: 'MARKING_LENGTH' };
  if (!MARKING_CHARACTERS.test(value)) return { ok: false, error: 'NOT_ASCII' };
  return { ok: true, value, key: markingKey(value) };
}

function markingKey(value: string): string {
  // The serial (AI 21) ends at the group separator. Without one (a scanner that drops it) the
  // serial's end cannot be known safely, so the whole code is the key.
  const match = MARKING_IDENTIFIER.exec(value);
  if (match === null) return value.split(GROUP_SEPARATOR).join('');
  return `01${match[1]}21${match[2]}`;
}

export function checkUnitCode(kind: UnitCodeKind, raw: string): UnitCodeCheck {
  switch (kind) {
    case 'IMEI':
      return checkImei(raw);
    case 'SERIAL':
      return checkSerial(raw);
    case 'MARKING':
      return checkMarking(raw);
  }
}
