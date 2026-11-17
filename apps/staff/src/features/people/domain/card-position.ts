export interface CardPlacementInput {
  readonly pointer: { readonly x: number; readonly y: number };
  readonly card: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
}

const POINTER_GAP = 12;
const VIEWPORT_MARGIN = 8;

const clamp = (value: number, max: number): number =>
  Math.max(VIEWPORT_MARGIN, Math.min(value, max));

/**
 * Next to the pointer, below and to the right. A card that would leave the window flips to the
 * other side of the pointer, then is pushed back inside if that side has no room either.
 */
export function placeCard({ pointer, card, viewport }: CardPlacementInput): {
  left: number;
  top: number;
} {
  const fitsRight = pointer.x + POINTER_GAP + card.width + VIEWPORT_MARGIN <= viewport.width;
  const fitsBelow = pointer.y + POINTER_GAP + card.height + VIEWPORT_MARGIN <= viewport.height;
  const left = fitsRight ? pointer.x + POINTER_GAP : pointer.x - POINTER_GAP - card.width;
  const top = fitsBelow ? pointer.y + POINTER_GAP : pointer.y - POINTER_GAP - card.height;
  return {
    left: clamp(left, viewport.width - card.width - VIEWPORT_MARGIN),
    top: clamp(top, viewport.height - card.height - VIEWPORT_MARGIN),
  };
}
