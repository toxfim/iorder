import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import dialogSource from './components/CreateStaffAccountDialog.vue?raw';
import fieldSource from '@core/components/ui/TextField.vue?raw';

// jsdom has no layout, so these read the sources. The create dialog's scrolling form must leave
// room for the 2px focus outline (+2px offset) inside its scroll box, otherwise the ring is clipped
// against the modal edge (reported by the owner with a screenshot).

// Vitest runs from apps/staff; a CSS file imported with ?raw is processed to an empty string.
const baseCss = readFileSync(
  resolve(process.cwd(), '../../packages/web-core/src/styles/base.css'),
  'utf8',
);

describe('create staff dialog: focus ring room', () => {
  it('pads the scrolling form by at least the ring (width + offset) and cancels it outside', () => {
    const block = /\.form \{([^}]*)\}/.exec(dialogSource)?.[1] ?? '';
    expect(block).toMatch(/overflow-y:\s*auto/);
    const padding = Number(/padding:\s*(\d+)px/.exec(block)?.[1]);
    expect(padding).toBeGreaterThanOrEqual(5);
    expect(block).toMatch(new RegExp(`margin:\\s*-${padding}px`));
  });
});

describe('create staff dialog: fields', () => {
  it('uses the system dropdown for the language, never a native select', () => {
    expect(dialogSource).toContain('<AppDropdown');
    expect(dialogSource).not.toContain('<select');
    expect(dialogSource).not.toContain('<option');
  });

  it('makes the phone and the Telegram id integer-only', () => {
    expect(dialogSource).toMatch(/v-model="phone"[^>]*digits-only/);
    expect(dialogSource).toMatch(/v-model="telegramId"[^>]*digits-only/);
    expect(fieldSource).toContain("replace(/\\D+/g, '')");
  });
});

describe('number inputs', () => {
  it('hides the browser spinner arrows globally', () => {
    expect(baseCss).toContain("input[type='number']::-webkit-inner-spin-button");
    expect(baseCss).toMatch(/appearance:\s*textfield/);
  });
});
