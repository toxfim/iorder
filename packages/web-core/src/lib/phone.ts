/** A `tel:` link that keeps only the digits and the leading plus: spaces and any markup-like text in a stored phone never reach the href. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^+\d]/g, '')}`;
}

/** Most digits a phone may have (E.164), also the limit of the phone field. */
export const PHONE_MAX_DIGITS = 15;

const UZ_CODE = '998';

/**
 * The digits of a phone grouped for reading, without the leading plus: Uzbek numbers as
 * `998 93 555 0147` (code, operator, 3 + 4), anything else in groups of three. Works on partial
 * input too, so the field can format while the person types.
 */
export function formatPhoneDigits(digits: string): string {
  const only = digits.replace(/\D+/g, '').slice(0, PHONE_MAX_DIGITS);
  const sizes = only.startsWith(UZ_CODE) ? [3, 2, 3, 4] : null;
  const parts: string[] = [];
  let at = 0;
  if (sizes) {
    for (const size of sizes) {
      if (at >= only.length) break;
      parts.push(only.slice(at, at + size));
      at += size;
    }
    if (at < only.length) parts.push(only.slice(at));
  } else {
    while (at < only.length) {
      parts.push(only.slice(at, at + 3));
      at += 3;
    }
  }
  return parts.join(' ');
}

/** A stored phone (`+998935550147`) as shown to people: `+998 93 555 0147`. */
export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D+/g, '');
  return digits === '' ? phone : `+${formatPhoneDigits(digits)}`;
}

/** Only the digits of a phone or of a typed search, so `+998 93 555 0147` and `998935550147` compare equal. */
export function phoneDigits(value: string): string {
  return value.replace(/\D+/g, '');
}

/**
 * Whether a typed search finds a stored phone. Only a search made of digits and phone punctuation
 * counts (a name never matches by its digits); both sides are compared as plain digits.
 */
export function phoneMatches(phone: string, search: string): boolean {
  if (/[^\d\s+()-]/.test(search)) return false;
  const needle = phoneDigits(search);
  return needle !== '' && phoneDigits(phone).includes(needle);
}
