import { describe, expect, it } from 'vitest';
import source from './PlacedPage.vue?raw';

// jsdom has no layout, so this reads the source. Owner request (screenshot): the confirmation block
// is centred in the page and the two buttons sit at the bottom, 20px above the menu (the shell's
// bottom padding is menu + 20px and the page fills the area).
describe('order placed page layout', () => {
  it('centres the confirmation and keeps the buttons in their own bottom block', () => {
    const content = /\.placed__content \{([^}]*)\}/.exec(source)?.[1] ?? '';
    expect(content).toMatch(/flex:\s*1/);
    expect(content).toMatch(/justify-content:\s*center/);
    expect(source).toContain('class="placed__actions"');
    const actions = /\.placed__actions \{([^}]*)\}/.exec(source)?.[1] ?? '';
    expect(actions).toMatch(/flex-direction:\s*column/);
  });

  it('puts the two buttons after the confirmation content', () => {
    expect(source.indexOf('placed__content')).toBeLessThan(source.indexOf('placed__actions'));
    expect(source.indexOf('customer.placed.viewStatus')).toBeGreaterThan(
      source.indexOf('class="placed__actions"'),
    );
  });
});
