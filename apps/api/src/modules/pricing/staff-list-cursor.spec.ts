import { describe, expect, it } from 'vitest';
import { InputValidationError } from '../../common/errors/domain-errors.js';
import {
  decodeStaffListCursor,
  encodeStaffListCursor,
  pageByProductCode,
} from './staff-list-cursor.js';

describe('staff list cursor codec', () => {
  it('round-trips product codes, including non-ASCII and url-unsafe characters', () => {
    for (const code of ['A-1', 'Ш/Ц?+=', 'товар 7', '日本']) {
      expect(decodeStaffListCursor(encodeStaffListCursor(code))).toBe(code);
    }
  });

  it('is base64url (no +, / or padding)', () => {
    expect(encodeStaffListCursor('???>>>')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each(['', '!!!', 'QQ==', 'A', '/+', '_w'])('rejects the invalid cursor %j', (cursor) => {
    expect(() => decodeStaffListCursor(cursor)).toThrow(InputValidationError);
  });
});

describe('pageByProductCode', () => {
  const rows = ['b', 'd', 'a', 'c', 'e'].map((code) => ({ code }));
  const codeOf = (r: { code: string }): string => r.code;

  it('pages in code order without gaps or repeats', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = pageByProductCode(rows, codeOf, 2, cursor);
      expect(page.total).toBe(5);
      seen.push(...page.items.map(codeOf));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('has no nextCursor when the rows fit exactly', () => {
    expect(pageByProductCode(rows, codeOf, 5, undefined).nextCursor).toBeNull();
  });

  it('survives the cursor row disappearing and rows being inserted', () => {
    const first = pageByProductCode(rows, codeOf, 2, undefined);
    const changed = [...rows.filter((r) => r.code !== 'b'), { code: 'bb' }, { code: 'aa' }];
    const second = pageByProductCode(changed, codeOf, 2, first.nextCursor ?? undefined);
    expect(second.items.map(codeOf)).toEqual(['bb', 'c']);
  });

  it('is empty after the last code', () => {
    const page = pageByProductCode(rows, codeOf, 2, encodeStaffListCursor('e'));
    expect(page).toEqual({ items: [], nextCursor: null, total: 5 });
  });
});
