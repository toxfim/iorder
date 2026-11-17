import { effectScope } from 'vue';
import type * as UseThemeModule from './use-theme';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY } from '../theme';

type Listener = (event: MediaQueryListEvent) => void;

interface FakeMedia {
  matches: boolean;
  listeners: Set<Listener>;
  fire: (matches: boolean) => void;
}

function installMatchMedia(initial: boolean): FakeMedia {
  const media: FakeMedia = {
    matches: initial,
    listeners: new Set(),
    fire(matches) {
      media.matches = matches;
      for (const listener of media.listeners) listener({ matches } as MediaQueryListEvent);
    },
  };
  window.matchMedia = vi.fn(
    () =>
      ({
        get matches() {
          return media.matches;
        },
        addEventListener: (_type: string, listener: Listener) => media.listeners.add(listener),
        removeEventListener: (_type: string, listener: Listener) =>
          media.listeners.delete(listener),
      }) as unknown as MediaQueryList,
  );
  return media;
}

// The composable keeps module-level state (one document), so each test loads a fresh copy.
async function load(): Promise<typeof UseThemeModule> {
  vi.resetModules();
  return import('./use-theme');
}

const root = document.documentElement;

beforeEach(() => {
  window.localStorage.clear();
  root.removeAttribute('data-theme');
  root.style.removeProperty('--page');
  document.head.innerHTML =
    '<meta name="theme-color" content="#111111" media="(prefers-color-scheme: light)">' +
    '<meta name="theme-color" content="#222222" media="(prefers-color-scheme: dark)">';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useTheme', () => {
  it('defaults to system and leaves the attribute off', async () => {
    installMatchMedia(false);
    const { useTheme } = await load();
    const { choice, effective } = useTheme();
    expect(choice.value).toBe('system');
    expect(effective.value).toBe('light');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('applies and persists an explicit choice on the document element', async () => {
    installMatchMedia(false);
    const { useTheme } = await load();
    const { choice, setChoice } = useTheme();
    setChoice('dark');
    expect(choice.value).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    setChoice('light');
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('removes the attribute again when going back to system', async () => {
    installMatchMedia(false);
    const { useTheme } = await load();
    const { setChoice } = useTheme();
    setChoice('dark');
    setChoice('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  it('reads and applies the stored choice, ignoring a bad stored value', async () => {
    installMatchMedia(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    let loaded = await load();
    expect(loaded.useTheme().choice.value).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');

    root.removeAttribute('data-theme');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    loaded = await load();
    expect(loaded.useTheme().choice.value).toBe('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('keeps working when storage throws on read and on write', async () => {
    installMatchMedia(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const { useTheme } = await load();
    const { choice, setChoice } = useTheme();
    expect(choice.value).toBe('system');
    expect(() => setChoice('dark')).not.toThrow();
    expect(choice.value).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('follows OS changes in system mode and stops listening when the scope ends', async () => {
    const media = installMatchMedia(false);
    const { useTheme } = await load();
    const scope = effectScope();
    const theme = scope.run(() => useTheme());
    if (!theme) throw new Error('scope did not run');
    expect(theme.effective.value).toBe('light');
    expect(media.listeners.size).toBe(1);

    media.fire(true);
    expect(theme.effective.value).toBe('dark');
    // The page itself restyles through CSS; the attribute stays off in system mode.
    expect(root.hasAttribute('data-theme')).toBe(false);

    theme.setChoice('light');
    media.fire(false);
    media.fire(true);
    expect(theme.effective.value).toBe('light');

    scope.stop();
    expect(media.listeners.size).toBe(0);
  });

  it('shares one listener between several consumers', async () => {
    const media = installMatchMedia(false);
    const { useTheme } = await load();
    const first = effectScope();
    const second = effectScope();
    first.run(() => useTheme());
    second.run(() => useTheme());
    expect(media.listeners.size).toBe(1);
    first.stop();
    expect(media.listeners.size).toBe(1);
    second.stop();
    expect(media.listeners.size).toBe(0);
  });

  it('works without matchMedia', async () => {
    Reflect.deleteProperty(window, 'matchMedia');
    const { useTheme } = await load();
    const scope = effectScope();
    const theme = scope.run(() => useTheme());
    expect(theme?.effective.value).toBe('light');
    scope.stop();
  });

  it('paints the browser chrome with the page colour of the active theme', async () => {
    installMatchMedia(false);
    root.style.setProperty('--page', '#10141a');
    const { useTheme } = await load();
    const { setChoice } = useTheme();
    setChoice('dark');
    const colours = [...document.querySelectorAll('meta[name="theme-color"]')].map((m) =>
      m.getAttribute('content'),
    );
    expect(colours).toEqual(['#10141a', '#10141a']);
  });
});
