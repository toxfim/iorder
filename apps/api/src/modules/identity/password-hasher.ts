import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { RateLimitedError } from '../../common/errors/domain-errors.js';

/**
 * scrypt parameters of format v1: N = 2^15 (32 MiB of memory), r = 8, p = 3. This is one of the
 * equivalent minimum configurations in the OWASP Password Storage Cheat Sheet (N=2^17,r=8,p=1 or
 * N=2^16,r=8,p=2 or N=2^15,r=8,p=3); the smaller memory figure was picked so a burst of sign-ins
 * (already rate limited) cannot exhaust the server. The parameters are stored inside every hash,
 * so they can be raised later without invalidating old passwords.
 */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}
export const SCRYPT_PARAMS_V1: ScryptParams = Object.freeze({ N: 32_768, r: 8, p: 3 });

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const FORMAT = 'scrypt$v1';
/** Accepted range when READING a stored hash: stops a corrupted row from demanding gigabytes. */
const MAX_N = 2 ** 20;
const MAX_R = 16;
const MAX_P = 16;

// scrypt$v1$N=32768,r=8,p=3$<salt base64url>$<hash base64url>
const STORED = /^scrypt\$v1\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

function isValidParams({ N, r, p }: ScryptParams): boolean {
  return (
    Number.isInteger(N) &&
    N >= 2 &&
    N <= MAX_N &&
    (N & (N - 1)) === 0 &&
    Number.isInteger(r) &&
    r >= 1 &&
    r <= MAX_R &&
    Number.isInteger(p) &&
    p >= 1 &&
    p <= MAX_P
  );
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      // NFKC so the same password typed on different keyboards or normalization forms matches.
      password.normalize('NFKC'),
      salt,
      KEY_BYTES,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.r * (params.N + params.p + 2) },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** At most this many scrypt derivations run at once (each holds 32 MiB and a libuv thread). [P] */
export const MAX_CONCURRENT_DERIVATIONS = 2;
/** Further derivations wait in line; beyond this many waiting the caller is told to retry. [P] */
export const MAX_QUEUED_DERIVATIONS = 20;

/**
 * Bounds memory and thread-pool use when sign-ins arrive in a burst: a few run, a few wait, the
 * rest get the uniform "try again" answer at once instead of piling up work.
 */
export class DerivationGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly maxActive: number = MAX_CONCURRENT_DERIVATIONS,
    private readonly maxWaiting: number = MAX_QUEUED_DERIVATIONS,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxActive) {
      if (this.waiting.length >= this.maxWaiting) throw new RateLimitedError(1);
      // The finishing task hands its slot to us directly, so `active` stays correct.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

export class PasswordHasher {
  private readonly gate = new DerivationGate();

  /** Made at construction (in the background) so even the first unknown-login answer takes full time. */
  private readonly dummy: Promise<string>;

  constructor(private readonly params: ScryptParams = SCRYPT_PARAMS_V1) {
    if (!isValidParams(params)) throw new Error('Invalid scrypt parameters');
    this.dummy = this.hash(randomBytes(16).toString('hex'));
    // A failure here resurfaces on first use; this only keeps it from being an unhandled rejection.
    this.dummy.catch(() => undefined);
  }

  /** A fresh random salt every time; the result carries its own parameters. */
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const key = await this.gate.run(() => derive(password, salt, this.params));
    const { N, r, p } = this.params;
    return `${FORMAT}$N=${N},r=${r},p=${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }

  /**
   * Constant-time comparison. A malformed or unknown-format stored value is simply "no match"
   * (after doing the same amount of work as a real check), never an exception.
   */
  async verify(password: string, stored: string): Promise<boolean> {
    const match = STORED.exec(stored);
    if (!match) return this.verifyAgainstDummy(password);
    const params: ScryptParams = {
      N: Number(match[1]),
      r: Number(match[2]),
      p: Number(match[3]),
    };
    if (!isValidParams(params)) return this.verifyAgainstDummy(password);
    const salt = Buffer.from(match[4] ?? '', 'base64url');
    const expected = Buffer.from(match[5] ?? '', 'base64url');
    if (salt.length === 0 || expected.length !== KEY_BYTES) {
      return this.verifyAgainstDummy(password);
    }
    const actual = await this.gate.run(() => derive(password, salt, params));
    return timingSafeEqual(actual, expected);
  }

  /**
   * Burns the same time as a real check, for a login that does not exist (or an account that is
   * locked), so the answer time does not reveal which case it was. Always false.
   */
  async verifyAgainstDummy(password: string): Promise<false> {
    const stored = await this.dummy;
    const match = STORED.exec(stored);
    if (match) {
      const params: ScryptParams = {
        N: Number(match[1]),
        r: Number(match[2]),
        p: Number(match[3]),
      };
      const salt = Buffer.from(match[4] ?? '', 'base64url');
      await this.gate.run(() => derive(password, salt, params));
    }
    return false;
  }
}
