// Per-device theme preference. `system` means "no attribute": the CSS prefers-color-scheme
// block decides (inside Telegram that is the webview's scheme; telegram-web-app.js is never
// loaded). public/theme-init.js applies the same stored value before the first paint and
// duplicates THEME_STORAGE_KEY and the two --page colours (a unit test keeps them in sync with
// tokens.css, so no colour literal lives in TypeScript).

export type ThemeChoice = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];
export const DEFAULT_THEME_CHOICE: ThemeChoice = 'system';
export const THEME_STORAGE_KEY = 'iorder.theme';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);
}
