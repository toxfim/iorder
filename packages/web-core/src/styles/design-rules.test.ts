import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '@core/test-utils/frontend-sources';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const tokens = read('./tokens.css');
const v1 = (file: string): string => read(`../../../../docs/private/design/v1/${file}`);

describe('design tokens', () => {
  it('gives every colour token a light and a dark value', () => {
    expect(tokens).toContain("[data-theme='dark']");
    expect(tokens).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(tokens).toMatch(/color-scheme:\s*dark/);
    expect(tokens).toMatch(/color-scheme:\s*light/);
    // Full per-token parity lives in theme-tokens.test.ts.
  });

  // The design sources are private (repo iorder-docs, cloned at docs/private): skipped without them.
  it.skipIf(!existsSync(new URL('../../../../docs/private/design/v1', import.meta.url)))(
    'uses only approved palette values (v1 design for light, the dark-mode proposal for dark)',
    () => {
      const v1Sources = [
        v1('specs.md'),
        v1('Dashboard v5-Neutral-Sidebar.dc.html'),
        v1('iOrder Prototype v2.dc.html'),
      ]
        .join('\n')
        .toLowerCase();
      const proposal = read(
        '../../../../docs/private/design/dark-mode-proposal.html',
      ).toLowerCase();
      // Light values changed on purpose for contrast (docs/private/design/dark-mode-plan.md, appendix A).
      const lightContrastFixes = new Set(['#6b6b6b', '#8a8a8a', '#157644', '#b87d00']);
      const [staffTokens = '', customerAndLater = ''] = tokens.split(
        '/* Customer-only Figma palette',
      );
      // The staff design v8 palette follows the customer section (docs/private/design/v8).
      const [customerOnly = '', staffAndAuth = ''] = customerAndLater.split(
        ' * Staff-only palette of docs/private/design/v8',
      );
      // The authentication palette after it is the customer Figma one, checked with it.
      const [staffV8Tokens = '', authTokens = ''] = staffAndAuth.split('/* Authentication uses');
      const customerTokens = customerOnly + authTokens;
      const darkStart = staffTokens.indexOf("[data-theme='dark']");
      const lightPart = staffTokens.slice(0, darkStart);
      const darkPart = staffTokens.slice(darkStart);
      const hexes = (css: string): string[] => [
        ...new Set([...css.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toLowerCase())),
      ];
      const unknownLight = hexes(lightPart).filter(
        (hex) =>
          !v1Sources.includes(hex) && !lightContrastFixes.has(hex) && !proposal.includes(hex),
      );
      const unknownDark = hexes(darkPart).filter((hex) => !proposal.includes(hex));
      expect({ unknownLight, unknownDark }).toEqual({ unknownLight: [], unknownDark: [] });
      const customerSource = read(
        '../../../../docs/private/design/customer-figma-implementation.md',
      ).toLowerCase();
      expect(hexes(customerTokens).filter((hex) => !customerSource.includes(hex))).toEqual([]);
      const v8Source = read(
        '../../../../docs/private/design/v8/Dashboard v8 Staff.dc.html',
      ).toLowerCase();
      // Text colours darkened for WCAG AA (listed in the tokens.css comment of that section).
      const v8ContrastFixes = new Set(['#5b616b', '#6b7079', '#8a9099']);
      expect(
        hexes(staffV8Tokens).filter((hex) => !v8Source.includes(hex) && !v8ContrastFixes.has(hex)),
      ).toEqual([]);
    },
  );

  it('keeps the spec radius scale and easing', () => {
    for (const radius of ['20px', '16px', '14px', '12px', '10px', '8px', '6px']) {
      expect(tokens).toContain(`: ${radius};`);
    }
    expect(tokens).toContain('cubic-bezier(0.2, 0.8, 0.2, 1)');
  });
});

describe('touch targets', () => {
  // jsdom cannot evaluate media queries, so the documented rule is checked in the source:
  // every interactive primitive must declare a 44px minimum for coarse pointers.
  // Paths from the repository root: the primitives live in the kit and in the apps.
  const sources = {
    'AppButton.vue': 'packages/web-core/src/components/ui/AppButton.vue',
    'AppDropdown.vue': 'packages/web-core/src/components/ui/AppDropdown.vue',
    'SidebarContent.vue': 'apps/staff/src/features/staff-shell/components/SidebarContent.vue',
    // F-24: the small dashboard controls ("Hammasi →", "Ochish", period buttons).
    'DashCard.vue': 'apps/staff/src/features/dashboard/components/DashCard.vue',
    'DashboardPage.vue': 'apps/staff/src/features/dashboard/components/DashboardPage.vue',
    'AppSegmented.vue': 'apps/staff/src/components/ui/AppSegmented.vue',
  };
  const readSource = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');

  for (const [name, path] of Object.entries(sources)) {
    it(`${name} enlarges its hit area on coarse pointers`, () => {
      const css = readSource(path);
      const coarse = /@media \(pointer: coarse\)[^{]*\{[\s\S]*?min-(height|width): 44px/.exec(css);
      expect(coarse).not.toBeNull();
    });

    // Some webviews (Telegram on phones) do not report a coarse pointer; "cannot hover" counts too.
    if (name !== 'SidebarContent.vue' && name !== 'AppDropdown.vue') {
      it(`${name} also treats a no-hover webview as touch`, () => {
        expect(readSource(path)).toContain('@media (pointer: coarse), (hover: none)');
      });
    }
  }
});
