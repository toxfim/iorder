import { describe, expect, it } from 'vitest';
import source from './QuantityStepper.vue?raw';

// jsdom has no layout, so this reads the source. The stepper sits in a grid cell that is wider than
// the control on a phone; with `align-items: stretch` the bordered box grew to the cell and showed an
// empty bordered area (reported by the owner with a screenshot).
describe('quantity stepper layout', () => {
  it('lets the bordered box hug its buttons and input instead of stretching to the cell', () => {
    const block = /\.stepper \{([^}]*)\}/.exec(source)?.[1] ?? '';
    expect(block).toMatch(/flex-direction:\s*column/);
    expect(block).toMatch(/align-items:\s*flex-start/);
  });
});
