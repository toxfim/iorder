import { describe, expect, it } from 'vitest';
import { staffCostMessages } from '../messages';
import { REJECT_REASON_CODES, rejectReasonCode } from './reject-reason';

describe('rejected row reasons', () => {
  it('maps the machine codes and the api validation messages', () => {
    expect(rejectReasonCode('NOT_A_NUMBER')).toBe('NOT_A_NUMBER');
    expect(rejectReasonCode('MISSING_PRODUCT_CODE')).toBe('MISSING_PRODUCT_CODE');
    expect(rejectReasonCode('Not a valid non-negative number')).toBe('NOT_A_NUMBER');
    expect(rejectReasonCode('Not a valid product code')).toBe('INVALID_PRODUCT_CODE');
    expect(rejectReasonCode('Expected a date written DD.MM.YYYY')).toBe('INVALID_DATE');
    expect(rejectReasonCode('Date is outside the plausible delivery window')).toBe(
      'DATE_OUT_OF_WINDOW',
    );
    expect(rejectReasonCode('Expected text of 1-200 characters')).toBe('INVALID_TEXT_LENGTH');
  });

  it('falls back to a neutral label for anything unknown', () => {
    expect(rejectReasonCode('SOMETHING_NEW')).toBe('UNKNOWN');
    expect(rejectReasonCode('')).toBe('UNKNOWN');
  });

  it('has a label in every language for every code and the fallback', () => {
    for (const messages of Object.values(staffCostMessages)) {
      for (const code of [...REJECT_REASON_CODES, 'UNKNOWN'] as const) {
        expect(messages.sync.rejectReason[code]).toMatch(/\S/);
      }
    }
  });
});
