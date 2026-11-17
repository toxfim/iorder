import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountCustomerApp, useCustomerTestLifecycle } from '@/test-utils/customer-app';
import { waitFor } from '@core/test-utils/wait';

useCustomerTestLifecycle();

interface FakeObserver {
  readonly callback: () => void;
  readonly targets: Element[];
}
const observers: FakeObserver[] = [];
const heights = { header: 56, tabs: 61 };

class FakeResizeObserver implements FakeObserver {
  readonly targets: Element[] = [];
  constructor(readonly callback: () => void) {
    observers.push(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    this.targets.length = 0;
  }
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const height = this.classList.contains('app__header')
      ? heights.header
      : this.classList.contains('tabs')
        ? heights.tabs
        : 0;
    return { height } as DOMRect;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const fire = (): void => observers.forEach((o) => o.callback());
const rootStyle = (): CSSStyleDeclaration =>
  (document.body.querySelector('.app') as HTMLElement).style;

describe('customer shell measures its own header and menu', () => {
  it('publishes the measured heights as CSS variables and follows later changes', async () => {
    heights.header = 56;
    heights.tabs = 61;
    await mountCustomerApp('fake-owner', '/prices');
    await waitFor(() => expect(document.body.querySelector('nav.tabs')).not.toBeNull());
    fire();
    expect(rootStyle().getPropertyValue('--customer-header-h')).toBe('56px');
    expect(rootStyle().getPropertyValue('--customer-tabs-h')).toBe('61px');

    // Longer labels wrap in ru/uz: the menu grows and the content must keep clear of it.
    heights.tabs = 97.4;
    heights.header = 72;
    fire();
    expect(rootStyle().getPropertyValue('--customer-header-h')).toBe('72px');
    expect(rootStyle().getPropertyValue('--customer-tabs-h')).toBe('98px');
  });

  it('observes both elements, and keeps the CSS fallback when nothing is laid out', async () => {
    heights.header = 0;
    heights.tabs = 0;
    await mountCustomerApp('fake-owner', '/prices');
    await waitFor(() => expect(document.body.querySelector('nav.tabs')).not.toBeNull());
    const observed = observers.flatMap((o) => o.targets);
    expect(observed).toContain(document.body.querySelector('.app__header'));
    expect(observed).toContain(document.body.querySelector('nav.tabs'));
    fire();
    expect(rootStyle().getPropertyValue('--customer-header-h')).toBe('');
    expect(rootStyle().getPropertyValue('--customer-tabs-h')).toBe('');
  });
});

describe('pages use the measured variables (jsdom has no layout, so the source is checked)', () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
  const cart = read('../customer-cart/components/CartPage.vue');
  const catalog = read('../customer-catalog/components/CatalogPage.vue');
  const shell = read('./components/CustomerApp.vue');
  const bar = read('../customer-cart/components/CartSummaryBar.vue');

  it('uses the content offset so a tall sidebar cannot push the search off screen', () => {
    expect(catalog).toMatch(
      /@media \(min-width: 960px\) \{[\s\S]*?\.tools \{[^}]*top: var\(--customer-content-top\)/,
    );
  });

  it('the content column widens per breakpoint and reserves a desktop sidebar', () => {
    expect(shell).toMatch(/\.app__main \{[^}]*max-width: 720px/);
    expect(shell).toMatch(/@media \(min-width: 640px\) \{\s*\.app__main \{[^}]*max-width: 960px/);
    expect(shell).toMatch(
      /@media \(min-width: 960px\) \{[\s\S]*?\.app__main \{[^}]*max-width: 1200px/,
    );
    expect(shell).toContain('padding-inline-start: var(--customer-sidebar-w)');
    expect(shell).toContain('--customer-content-top: 0px');
    expect(shell).toMatch(/\.tabs \{[^}]*position: fixed;[^}]*inset-inline-start: 0;/);
    // The price list adds no column cap of its own, so it uses the whole shell width.
    expect(catalog).not.toMatch(/\.catalog \{[^}]*max-width/);
  });

  it('the desktop cart summary uses the content offset without measured sidebar heights', () => {
    expect(cart).toMatch(/top: calc\(var\(--customer-content-top\) \+ 16px\)/);
    expect(cart).not.toMatch(/\+ 56px/);
  });

  it('room for the bottom menu comes from one variable that is 0 on desktop', () => {
    expect(shell).toMatch(/--customer-bottom-h: var\(--customer-tabs-h\)/);
    expect(shell).toMatch(/@media \(min-width: 960px\) \{[\s\S]*--customer-bottom-h: 0px/);
    expect(shell).toMatch(/padding: 16px 16px calc\(var\(--customer-bottom-h\) \+ 20px\)/);
    expect(bar).toContain('bottom: var(--customer-bottom-h');
    expect(cart).toContain('bottom: calc(var(--customer-bottom-h');
  });
  it('centres the shared state block in the area under the header', () => {
    expect(shell).toMatch(/\.app__main > \* \{\s*flex: 1;/);
    expect(shell).toMatch(/\.app__main :deep\(\.state\) \{\s*margin-block: auto;/);
  });
});
