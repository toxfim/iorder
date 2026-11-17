import { describe, expect, it, vi } from 'vitest';
import { ConflictError } from '../common/errors/domain-errors.js';
import {
  checkSeedSafeguards,
  describeDatabase,
  parseSeedArgs,
  seedAdmin,
  type SeedAdminDeps,
} from './seed-admin.js';

const SECRET_ID = '777123456789';
const PASSWORD = 'p@ss-secret-123';
const DEV_URL = `postgresql://iorder:${PASSWORD}@127.0.0.1:5433/iorder_dev`;

function run(
  telegramId: string | undefined,
  options: Partial<SeedAdminDeps> & { result?: { userCreated: boolean; roleAdded: boolean } } = {},
) {
  const lines: string[] = [];
  const bootstrapAdmin = vi
    .fn()
    .mockResolvedValue(options.result ?? { userCreated: true, roleAdded: true });
  const done = seedAdmin({
    telegramId,
    argv: [],
    nodeEnv: 'development',
    databaseUrl: DEV_URL,
    bootstrapAdmin,
    log: (line) => lines.push(line),
    ...options,
  });
  return { done, lines, bootstrapAdmin };
}

describe('parseSeedArgs', () => {
  it('accepts no arguments and the two known flags', () => {
    expect(parseSeedArgs([])).toEqual({ ok: true, args: { allowProduction: false, yes: false } });
    expect(parseSeedArgs(['--yes', '--allow-production'])).toEqual({
      ok: true,
      args: { allowProduction: true, yes: true },
    });
  });

  it('rejects anything else instead of ignoring it', () => {
    expect(parseSeedArgs(['--yes', '--force', 'x'])).toEqual({
      ok: false,
      unknown: ['--force', 'x'],
    });
  });
});

describe('describeDatabase', () => {
  it('returns only the host and the database name', () => {
    expect(describeDatabase(DEV_URL)).toEqual({ host: '127.0.0.1', database: 'iorder_dev' });
    expect(describeDatabase('postgres://u:p@db.example.com/iorder_prod?sslmode=require')).toEqual({
      host: 'db.example.com',
      database: 'iorder_prod',
    });
  });

  it.each([undefined, '', 'not a url', 'postgresql://u:p@host', 'postgresql:///iorder_dev'])(
    'returns null for %j',
    (url) => {
      expect(describeDatabase(url)).toBeNull();
    },
  );
});

describe('checkSeedSafeguards', () => {
  const dev = { host: 'localhost', database: 'iorder_dev' };
  const prod = { host: 'db.internal', database: 'iorder' };
  const none = { allowProduction: false, yes: false };

  it('lets a development run on iorder_dev / iorder_test through', () => {
    expect(checkSeedSafeguards({ nodeEnv: 'development', args: none, target: dev })).toBeNull();
    expect(
      checkSeedSafeguards({
        nodeEnv: undefined,
        args: none,
        target: { host: 'h', database: 'iorder_test' },
      }),
    ).toBeNull();
  });

  it('refuses NODE_ENV=production without --allow-production', () => {
    expect(checkSeedSafeguards({ nodeEnv: 'production', args: none, target: dev })).toMatch(
      /--allow-production/,
    );
    expect(
      checkSeedSafeguards({
        nodeEnv: 'production',
        args: { allowProduction: true, yes: false },
        target: dev,
      }),
    ).toBeNull();
  });

  it('requires --yes for any other database name, on top of --allow-production', () => {
    expect(checkSeedSafeguards({ nodeEnv: 'development', args: none, target: prod })).toMatch(
      /--yes/,
    );
    expect(
      checkSeedSafeguards({
        nodeEnv: 'production',
        args: { allowProduction: true, yes: false },
        target: prod,
      }),
    ).toMatch(/--yes/);
    expect(
      checkSeedSafeguards({
        nodeEnv: 'production',
        args: { allowProduction: true, yes: true },
        target: prod,
      }),
    ).toBeNull();
  });
});

describe('seedAdmin', () => {
  it.each([undefined, ''])('refuses to run without an id (%j)', async (id) => {
    const { done, bootstrapAdmin, lines } = run(id);
    expect(await done).toBe(1);
    expect(bootstrapAdmin).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/refusing/);
  });

  it.each(['abc', '-5', '0', '1.5', '99999999999999999999'])(
    'refuses an invalid id %j without echoing it',
    async (id) => {
      const { done, bootstrapAdmin, lines } = run(id);
      expect(await done).toBe(1);
      expect(bootstrapAdmin).not.toHaveBeenCalled();
      // The first line is the database line; the refusal itself must not echo the id.
      expect(lines.slice(1).join('\n')).not.toContain(id);
    },
  );

  it('passes the id as a bigint, prints the database host and name, and never the id or password', async () => {
    const { done, bootstrapAdmin, lines } = run(SECRET_ID);
    expect(await done).toBe(0);
    expect(bootstrapAdmin).toHaveBeenCalledWith(777123456789n);
    expect(lines).toEqual([
      'Database: host=127.0.0.1 name=iorder_dev',
      'Administrator ensured: user created, ADMIN role added.',
    ]);
    expect(lines.join('\n')).not.toContain(SECRET_ID);
    expect(lines.join('\n')).not.toContain(PASSWORD);
  });

  it('reports "nothing changed" on a repeat run', async () => {
    const { done, lines } = run(SECRET_ID, { result: { userCreated: false, roleAdded: false } });
    expect(await done).toBe(0);
    expect(lines.at(-1)).toBe('Administrator already in place; nothing changed.');
  });

  it('refuses in production without --allow-production, before touching the database', async () => {
    const { done, bootstrapAdmin, lines } = run(SECRET_ID, { nodeEnv: 'production' });
    expect(await done).toBe(1);
    expect(bootstrapAdmin).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/--allow-production/);
  });

  it('requires --yes for a database that is not iorder_dev / iorder_test', async () => {
    const url = `postgresql://iorder:${PASSWORD}@db.internal:5432/iorder`;
    const refused = run(SECRET_ID, { databaseUrl: url });
    expect(await refused.done).toBe(1);
    expect(refused.bootstrapAdmin).not.toHaveBeenCalled();
    expect(refused.lines.join('\n')).toContain('host=db.internal name=iorder');
    expect(refused.lines.join('\n')).not.toContain(PASSWORD);

    const confirmed = run(SECRET_ID, { databaseUrl: url, argv: ['--yes'] });
    expect(await confirmed.done).toBe(0);
  });

  it('refuses an unknown argument and a missing or invalid DATABASE_URL', async () => {
    const unknown = run(SECRET_ID, { argv: ['--force'] });
    expect(await unknown.done).toBe(1);
    expect(unknown.bootstrapAdmin).not.toHaveBeenCalled();

    const noUrl = run(SECRET_ID, { databaseUrl: undefined });
    expect(await noUrl.done).toBe(1);
    expect(noUrl.bootstrapAdmin).not.toHaveBeenCalled();
  });

  it('exits non-zero with a clear message, without ids, for a BLOCKED user', async () => {
    const lines: string[] = [];
    const code = await seedAdmin({
      telegramId: SECRET_ID,
      argv: [],
      nodeEnv: 'development',
      databaseUrl: DEV_URL,
      bootstrapAdmin: () =>
        Promise.reject(
          new ConflictError('The user is blocked; unblock them first', 'USER_BLOCKED'),
        ),
      log: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/BLOCKED/);
    expect(lines.join('\n')).not.toContain(SECRET_ID);
  });

  it('lets other errors reach the entry point', async () => {
    await expect(
      seedAdmin({
        telegramId: SECRET_ID,
        argv: [],
        nodeEnv: 'development',
        databaseUrl: DEV_URL,
        bootstrapAdmin: () => Promise.reject(new Error('db down')),
        log: () => undefined,
      }),
    ).rejects.toThrow('db down');
  });
});
