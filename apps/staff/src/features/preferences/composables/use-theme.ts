import { computed, getCurrentScope, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue';
import { readStorage, writeStorage } from '@core/lib/safe-storage';
import { syncTelegramChrome } from '../telegram-chrome';
import {
  DEFAULT_THEME_CHOICE,
  THEME_STORAGE_KEY,
  isThemeChoice,
  type EffectiveTheme,
  type ThemeChoice,
} from '../theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readChoice(): ThemeChoice {
  const stored = readStorage(THEME_STORAGE_KEY);
  return isThemeChoice(stored) ? stored : DEFAULT_THEME_CHOICE;
}

function systemQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_QUERY)
    : null;
}

// One shared state: the staff top bar, the customer header and the login page all show the
// same choice. Module scope is fine because the app has exactly one document.
const choice = ref<ThemeChoice>(readChoice());
const systemDark = ref(systemQuery()?.matches ?? false);

/** Browser chrome (address bar, Telegram header) follows the page colour of the active theme. */
function syncBrowserChrome(): void {
  const page = getComputedStyle(document.documentElement).getPropertyValue('--page').trim();
  if (!page) return;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', page);
  }
  syncTelegramChrome();
}

/** `system` removes the attribute so the CSS media query decides; the others pin the theme. */
export function applyTheme(next: ThemeChoice): void {
  const root = document.documentElement;
  if (next === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', next);
  syncBrowserChrome();
}

let listening = 0;
let query: MediaQueryList | null = null;

function onSystemChange(event: MediaQueryListEvent): void {
  systemDark.value = event.matches;
  // Only the chrome colour needs a nudge: the page itself restyles through CSS.
  syncBrowserChrome();
}

function startListening(): void {
  listening += 1;
  if (listening > 1) return;
  query = systemQuery();
  if (!query) return;
  systemDark.value = query.matches;
  // A stripped-down MediaQueryList (old webviews, test doubles) can lack the event API.
  if (typeof query.addEventListener !== 'function') {
    query = null;
    return;
  }
  query.addEventListener('change', onSystemChange);
}

function stopListening(): void {
  listening = Math.max(0, listening - 1);
  if (listening > 0 || !query) return;
  query.removeEventListener('change', onSystemChange);
  query = null;
}

export interface UseTheme {
  readonly choice: Ref<ThemeChoice>;
  readonly effective: ComputedRef<EffectiveTheme>;
  setChoice: (next: ThemeChoice) => void;
}

let applied = false;

export function useTheme(): UseTheme {
  if (!applied) {
    // theme-init.js already did this before first paint; this covers tests and dev without it.
    applied = true;
    applyTheme(choice.value);
  }
  if (getCurrentScope()) {
    startListening();
    onScopeDispose(stopListening);
  }

  const effective = computed<EffectiveTheme>(() => {
    if (choice.value === 'system') return systemDark.value ? 'dark' : 'light';
    return choice.value;
  });

  function setChoice(next: ThemeChoice): void {
    choice.value = next;
    applyTheme(next);
    writeStorage(THEME_STORAGE_KEY, next);
  }

  return { choice, effective, setChoice };
}
