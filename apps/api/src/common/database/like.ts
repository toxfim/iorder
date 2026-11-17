/**
 * Escapes the LIKE metacharacters (`\`, `%`, `_`) so user text is matched literally. Prisma's
 * `contains` / `startsWith` pass the text into a LIKE pattern WITHOUT escaping it (verified by
 * a test: `search=%` matched every row), and PostgreSQL's default LIKE escape character is the
 * backslash.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}
