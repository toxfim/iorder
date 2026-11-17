// A supplier name from the sheet can carry characters nobody can see (zero-width space, no-break
// space, BOM, bidi marks). The sync report keeps them on purpose; the screen must show them, or
// the warning "this name looks like a selected supplier" would point at two identical-looking
// strings. Unicode categories instead of a code point list: format (Cf), separators (Zs, Zl, Zp)
// and control (Cc) characters, except the plain space.
const INVISIBLE = /(?! )[\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{Cc}]/gu;

/** `alpha trade import<U+200B>`: every invisible character becomes a visible `<U+XXXX>` marker. */
export function makeInvisibleVisible(text: string): string {
  return text.replace(INVISIBLE, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
  });
}
