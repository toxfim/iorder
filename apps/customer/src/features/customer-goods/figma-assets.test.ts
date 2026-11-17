import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const asset = (path: string): string =>
  fileURLToPath(new URL('../../../public/' + path, import.meta.url));
describe('local Figma assets', () => {
  it('ships the original non-empty SVG slots at their natural dimensions', () => {
    for (const [name, size] of Object.entries({
      phone: 24,
      'phone-accent': 24,
      'check-neutral': 18,
      headphones: 24,
      tv: 24,
      right: 20,
      back: 18,
      search: 20,
      copy: 18,
      close: 18,
      check: 20,
      pending: 18,
      'box-empty': 36,
      'box-discovery': 32,
      'box-status': 22,
    })) {
      const path = fileURLToPath(new URL('./assets/goods-icons/' + name + '.svg', import.meta.url));
      expect(statSync(path).size).toBeGreaterThan(100);
      const root = readFileSync(path, 'utf8').match(/<svg[^>]+>/)?.[0];
      expect(root).toContain('width="' + size + '"');
      expect(root).toContain('height="' + size + '"');
    }
  });
  it('ships the design font with its license instead of a runtime font-provider dependency', () => {
    expect(readFileSync(asset('fonts/inter-variable.woff2')).subarray(0, 4).toString()).toBe(
      'wOF2',
    );
    expect(readFileSync(asset('fonts/Inter-LICENSE.txt'), 'utf8')).toContain(
      'SIL OPEN FONT LICENSE',
    );
  });
});
