/**
 * A button that refuses its action and says why (`GuardedButton`): it is `aria-disabled`, never
 * natively disabled, so it still takes focus, hover and a tap.
 */
export const isLocked = (element: Element | null | undefined): boolean =>
  element?.getAttribute('aria-disabled') === 'true';
