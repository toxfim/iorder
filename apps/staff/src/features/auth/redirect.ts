/** Longer values are not a page of this app; the cap keeps a crafted link from filling the URL bar. */
const MAX_LENGTH = 512;

// C0/C1 controls, DEL, and the Unicode line/paragraph separators (they break out of some
// parsers and logs). Tab/newline are also stripped by browsers, turning "/\t/evil" into "//evil".
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = new RegExp('[\u0000-\u001f\u007f-\u009f\u2028\u2029]');

/** True when `path` (already decoded) points off the app or can normalise out of its area. */
function escapesSite(path: string): boolean {
  // NFKC turns look-alike slashes (full-width, fraction slash...) into the real ones.
  const normal = path.normalize('NFKC');
  if (!normal.startsWith('/')) return true;
  if (normal.startsWith('//') || normal.startsWith('/\\')) return true;
  const pathOnly = normal.split(/[?#]/, 1)[0] ?? '';
  return pathOnly.split(/[/\\]/).some((segment) => segment === '.' || segment === '..');
}

/**
 * The `redirect` query parameter is attacker-controllable (a crafted login link). Only a
 * same-origin absolute path is accepted; anything else (`//evil.test`, `https://...`,
 * `/\evil`, `javascript:`, encoded or dot-segment tricks) is dropped so the login screen can
 * never bounce a user off-site or out of the area they asked for.
 */
export function safeRedirect(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > MAX_LENGTH) return null;
  if (!value.startsWith('/')) return null;

  // The value is checked as written and after every decoding layer (a few at most): a
  // double-encoded "/%252f/evil" becomes "//evil" one layer down.
  let current = value;
  for (let layer = 0; layer < 4; layer += 1) {
    if (FORBIDDEN_CHARS.test(current) || escapesSite(current)) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      // A stray "%" is not a path the router produces (it encodes them).
      return null;
    }
    if (decoded === current) return value;
    current = decoded;
  }
  return null;
}
