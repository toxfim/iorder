import { describe, expect, it } from 'vitest';
import { escapeLike } from './like.js';

describe('escapeLike', () => {
  it('escapes backslash, percent and underscore, and nothing else', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike('%_\\')).toBe('\\%\\_\\\\');
    expect(escapeLike('KB-15 plain')).toBe('KB-15 plain');
  });
});
