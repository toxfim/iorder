import { describe, expect, it } from 'vitest';
import cartSource from './CartPage.vue?raw';

// jsdom has no layout, so this reads the source: on a phone the order summary card sticks 20px above
// the bottom menu (owner request), measured from the menu's real height.
describe('cart order summary on a phone', () => {
  it('sticks 20px above the bottom menu', () => {
    const phone =
      /@media \(max-width: 959px\) \{[\s\S]*?\n {2}\.summary \{([^}]*)\}/.exec(cartSource)?.[1] ??
      '';
    expect(phone).toMatch(/position:\s*sticky/);
    // A short cart still ends at the bottom: the summary is pushed down, not left under the last line.
    expect(phone).toMatch(/margin-top:\s*auto/);
    expect(phone).toMatch(/bottom:\s*calc\(var\(--customer-bottom-h, 0px\) \+ 20px\)/);
  });
});
