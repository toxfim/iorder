import { describe, expect, it } from 'vitest';
import { RateLimitedError } from '../../common/errors/domain-errors.js';
import { DerivationGate, PasswordHasher, SCRYPT_PARAMS_V1 } from './password-hasher.js';

// Cheap parameters keep the unit run fast; the production parameters are pinned separately.
const fast = new PasswordHasher({ N: 1024, r: 8, p: 1 });

describe('DerivationGate', () => {
  function deferred() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  it('runs at most two at once, queues the next ones, and refuses beyond the queue', async () => {
    const gate = new DerivationGate(2, 3);
    let running = 0;
    let peak = 0;
    const blockers = Array.from({ length: 5 }, deferred);
    const tasks = blockers.map((blocker) =>
      gate.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await blocker.promise;
        running -= 1;
      }),
    );
    // 2 running + 3 waiting = 5 accepted; the 6th is turned away at once.
    await expect(gate.run(() => Promise.resolve())).rejects.toBeInstanceOf(RateLimitedError);
    expect(running).toBe(2);
    for (const blocker of blockers) blocker.release();
    await Promise.all(tasks);
    expect(peak).toBe(2);
    // Everything drained: the gate accepts work again.
    await expect(gate.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('releases the slot when the work throws', async () => {
    const gate = new DerivationGate(1, 0);
    await expect(gate.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(gate.run(() => Promise.resolve(1))).resolves.toBe(1);
  });
});

describe('PasswordHasher', () => {
  it('writes a versioned string with the parameters, a random salt and the key', async () => {
    const stored = await fast.hash('correct horse battery staple');
    expect(stored).toMatch(/^scrypt\$v1\$N=1024,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(stored).not.toContain('correct horse');
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await fast.hash('correct horse battery staple');
    expect(await fast.verify('correct horse battery staple', stored)).toBe(true);
    expect(await fast.verify('correct horse battery stapl', stored)).toBe(false);
    expect(await fast.verify('', stored)).toBe(false);
  });

  it('uses a different salt (so a different string) for the same password', async () => {
    const a = await fast.hash('same password 123');
    const b = await fast.hash('same password 123');
    expect(a).not.toBe(b);
    expect(await fast.verify('same password 123', b)).toBe(true);
  });

  it('treats equivalent Unicode forms of a password as the same password (NFKC)', async () => {
    const stored = await fast.hash('café-password-1');
    expect(await fast.verify('café-password-1', stored)).toBe(true);
  });

  it('verifies a hash made with other parameters by reading them from the string', async () => {
    const other = await new PasswordHasher({ N: 2048, r: 8, p: 1 }).hash('another long password');
    expect(await fast.verify('another long password', other)).toBe(true);
  });

  it('returns false (never throws) for malformed, truncated or out-of-range stored values', async () => {
    for (const stored of [
      '',
      'plaintext',
      'scrypt$v1$N=1024,r=8,p=1$$',
      'scrypt$v2$N=1024,r=8,p=1$AAAA$AAAA',
      'scrypt$v1$N=1000,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'scrypt$v1$N=1073741824,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'scrypt$v1$N=1024,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAA',
    ]) {
      expect(await fast.verify('whatever password', stored), stored).toBe(false);
    }
  });

  it('has a dummy check that always answers false', async () => {
    expect(await fast.verifyAgainstDummy('anything at all')).toBe(false);
  });

  it('pins the production parameters (N=2^15, r=8, p=3) and refuses invalid ones', () => {
    expect(SCRYPT_PARAMS_V1).toEqual({ N: 32_768, r: 8, p: 3 });
    expect(() => new PasswordHasher({ N: 1000, r: 8, p: 1 })).toThrow();
    expect(() => new PasswordHasher({ N: 1024, r: 0, p: 1 })).toThrow();
  });

  it('works with the production parameters', async () => {
    const hasher = new PasswordHasher();
    const stored = await hasher.hash('production parameters ok');
    expect(stored.startsWith('scrypt$v1$N=32768,r=8,p=3$')).toBe(true);
    expect(await hasher.verify('production parameters ok', stored)).toBe(true);
  });
});
