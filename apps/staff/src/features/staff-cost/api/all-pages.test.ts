import { describe, expect, it, vi } from 'vitest';
import { allPages } from './stock-api';

describe('allPages', () => {
  it('follows nextCursor and returns every row of every page as one answer', async () => {
    const fetchPage = vi.fn(async (cursor: string | undefined) =>
      cursor === undefined
        ? { items: [1, 2], nextCursor: 'b', total: 5 }
        : cursor === 'b'
          ? { items: [3, 4], nextCursor: 'c', total: 5 }
          : { items: [5], nextCursor: null, total: 5 },
    );
    expect(await allPages(fetchPage)).toEqual({
      items: [1, 2, 3, 4, 5],
      nextCursor: null,
      total: 5,
    });
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'b', 'c']);
  });
});
