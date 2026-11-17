import { describe, expect, it, vi } from 'vitest';
import { InputValidationError } from '../common/errors/domain-errors.js';
import {
  issueApiTokenCommand,
  parseIssueArgs,
  parseRevokeArgs,
  revokeApiTokenCommand,
} from './api-token.js';

const DB = 'postgresql://user:pw-Xq9z@db.local:5432/iorder_staging';

describe('parseIssueArgs', () => {
  it('reads the flags, defaults --days to 7 and de-duplicates scopes', () => {
    expect(
      parseIssueArgs([
        '--user',
        'admin@iorder.uz',
        '--name',
        'codex-photos',
        '--scope',
        'MANAGE_PRODUCT_IMAGES',
        '--scope',
        'MANAGE_PRODUCT_IMAGES',
      ]),
    ).toEqual({
      ok: true,
      args: {
        login: 'admin@iorder.uz',
        name: 'codex-photos',
        days: 7,
        scopes: ['MANAGE_PRODUCT_IMAGES'],
      },
    });
  });

  it.each([
    [['--user', 'a@b.uz', '--name', 'x'], /--scope is required/],
    [['--name', 'x', '--scope', 'MANAGE_PRODUCT_IMAGES'], /--user/],
    [['--user', 'a@b.uz', '--scope', 'MANAGE_PRODUCT_IMAGES'], /--name/],
    [['--user', 'a@b.uz', '--name', 'x', '--scope', 'MANAGE_STAFF'], /Unknown scope/],
    [
      ['--user', 'a@b.uz', '--name', 'x', '--scope', 'MANAGE_PRODUCT_IMAGES', '--days', '31'],
      /--days/,
    ],
    [
      ['--user', 'a@b.uz', '--name', 'x', '--scope', 'MANAGE_PRODUCT_IMAGES', '--days', '0'],
      /--days/,
    ],
    [
      ['--user', 'a@b.uz', '--name', 'x', '--scope', 'MANAGE_PRODUCT_IMAGES', '--yes'],
      /Unknown argument/,
    ],
    [['--user', '--name', 'x'], /--user needs a value/],
    [
      ['--user', 'a@b.uz', '--user', 'c@d.uz', '--name', 'x', '--scope', 'MANAGE_PRODUCT_IMAGES'],
      /once/,
    ],
  ])('refuses %j', (argv, problem) => {
    const parsed = parseIssueArgs(argv);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toMatch(problem);
  });
});

describe('parseRevokeArgs', () => {
  it('needs exactly one uuid', () => {
    const id = '0195f0a0-0000-7000-8000-000000000001';
    expect(parseRevokeArgs(['--id', id])).toEqual({ ok: true, args: { id } });
    expect(parseRevokeArgs([]).ok).toBe(false);
    expect(parseRevokeArgs(['--id', 'nope']).ok).toBe(false);
    expect(parseRevokeArgs(['--id', id, '--id', id]).ok).toBe(false);
  });
});

describe('issueApiTokenCommand', () => {
  const argv = ['--user', 'admin@iorder.uz', '--name', 'codex', '--scope', 'MANAGE_PRODUCT_IMAGES'];

  it('prints the database without credentials and the token once', async () => {
    const lines: string[] = [];
    const code = await issueApiTokenCommand({
      argv,
      databaseUrl: DB,
      log: (line) => lines.push(line),
      issue: vi.fn().mockResolvedValue({
        token: 'iot_TOKEN',
        record: {
          id: 'tok-1',
          scopes: ['MANAGE_PRODUCT_IMAGES'],
          expiresAt: new Date('2026-11-05T00:00:00Z'),
        },
      }),
    });
    expect(code).toBe(0);
    expect(lines[0]).toBe('Database: host=db.local name=iorder_staging');
    expect(lines.join('\n')).not.toContain('pw-Xq9z');
    expect(lines.filter((line) => line.includes('iot_TOKEN'))).toHaveLength(1);
  });

  it('prints a domain refusal and exits 1; other errors propagate', async () => {
    const lines: string[] = [];
    const refused = await issueApiTokenCommand({
      argv,
      databaseUrl: DB,
      log: (line) => lines.push(line),
      issue: vi
        .fn()
        .mockRejectedValue(new InputValidationError([{ path: 'scopes', message: 'no' }])),
    });
    expect(refused).toBe(1);
    expect(lines.at(-1)).toBe('Refused: scopes: no');
    await expect(
      issueApiTokenCommand({
        argv,
        databaseUrl: DB,
        log: () => undefined,
        issue: vi.fn().mockRejectedValue(new Error('boom')),
      }),
    ).rejects.toThrow('boom');
  });

  it('refuses to run without a database URL', async () => {
    const issue = vi.fn();
    expect(
      await issueApiTokenCommand({ argv, databaseUrl: undefined, log: () => undefined, issue }),
    ).toBe(1);
    expect(issue).not.toHaveBeenCalled();
  });
});

describe('revokeApiTokenCommand', () => {
  it('says whether this run revoked it', async () => {
    const lines: string[] = [];
    const argv = ['--id', '0195f0a0-0000-7000-8000-000000000001'];
    await revokeApiTokenCommand({
      argv,
      databaseUrl: DB,
      log: (l) => lines.push(l),
      revoke: vi.fn().mockResolvedValue(true),
    });
    await revokeApiTokenCommand({
      argv,
      databaseUrl: DB,
      log: (l) => lines.push(l),
      revoke: vi.fn().mockResolvedValue(false),
    });
    expect(lines).toContain('Token revoked.');
    expect(lines).toContain('Token was already revoked; nothing changed.');
  });
});
