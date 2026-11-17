// Storage can throw (private windows, blocked site data, Telegram webviews) or be absent.
// Everything stored here is a per-viewer convenience, so a failed read or write must never
// break rendering: the app falls back to its defaults.

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Deliberately ignored: the preference simply is not persisted.
  }
}
