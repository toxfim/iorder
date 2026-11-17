import { describe, expect, it } from 'vitest';
import { placeCard } from './card-position';

const card = { width: 260, height: 140 };
const viewport = { width: 1000, height: 700 };

describe('placeCard', () => {
  it('sits below and to the right of the pointer when there is room', () => {
    expect(placeCard({ pointer: { x: 100, y: 100 }, card, viewport })).toEqual({
      left: 112,
      top: 112,
    });
  });

  it('flips to the left at the right edge and above at the bottom edge', () => {
    expect(placeCard({ pointer: { x: 990, y: 690 }, card, viewport })).toEqual({
      left: 718,
      top: 538,
    });
  });

  it('stays inside a window narrower than the space on either side', () => {
    const small = { width: 300, height: 200 };
    const placed = placeCard({ pointer: { x: 150, y: 100 }, card, viewport: small });
    expect(placed.left).toBeGreaterThanOrEqual(8);
    expect(placed.left + card.width).toBeLessThanOrEqual(small.width);
    expect(placed.top).toBeGreaterThanOrEqual(8);
    expect(placed.top + card.height).toBeLessThanOrEqual(small.height);
  });
});
