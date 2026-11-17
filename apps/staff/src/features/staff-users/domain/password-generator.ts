// Letters and digits without look-alikes (no 0/O, 1/l/I), plus a few symbols. 20 characters from
// 61 symbols is about 118 bits, far above the server's minimum of 8 characters.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!';
export const GENERATED_PASSWORD_LENGTH = 20;

export type RandomSource = (array: Uint32Array<ArrayBuffer>) => Uint32Array<ArrayBuffer>;

const browserRandom: RandomSource = (array) => globalThis.crypto.getRandomValues(array);

/**
 * A random password from a cryptographic source. Rejection sampling keeps every symbol equally
 * likely (a plain modulo would favour the first symbols of the alphabet).
 */
export function generateStrongPassword(
  length: number = GENERATED_PASSWORD_LENGTH,
  random: RandomSource = browserRandom,
): string {
  const limit = Math.floor(0x1_0000_0000 / ALPHABET.length) * ALPHABET.length;
  let out = '';
  while (out.length < length) {
    for (const value of random(new Uint32Array(length * 2))) {
      if (value < limit && out.length < length) out += ALPHABET.charAt(value % ALPHABET.length);
    }
  }
  return out;
}
