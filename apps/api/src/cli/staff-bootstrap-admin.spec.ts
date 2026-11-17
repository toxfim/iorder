import { describe, expect, it, vi } from 'vitest';
import { ConflictError, InputValidationError } from '../common/errors/domain-errors.js';
import {
  bootstrapStaffAdmin,
  parseBootstrapArgs,
  type BootstrapDeps,
} from './staff-bootstrap-admin.js';

const SECRET = 'Sup3r-secret-pw!';
const DEV_URL = 'postgresql://iorder:db-secret@127.0.0.1:5433/iorder_dev';

function run(options: Partial<BootstrapDeps> = {}) {
  const lines: string[] = [];
  const bootstrap = vi.fn().mockResolvedValue({ userCreated: true, passwordSet: true });
  const done = bootstrapStaffAdmin({
    login: 'Admin@iorder.uz ',
    password: SECRET,
    argv: [],
    nodeEnv: 'development',
    databaseUrl: DEV_URL,
    bootstrap,
    log: (line) => lines.push(line),
    ...options,
  });
  return { done, lines, bootstrap };
}

describe('parseBootstrapArgs', () => {
  it('accepts the known flags and reports the rest', () => {
    expect(parseBootstrapArgs(['--yes'])).toEqual({
      ok: true,
      args: { allowProduction: false, yes: true },
    });
    // The removed weak-password flag is now an unknown argument, never silently ignored.
    expect(parseBootstrapArgs(['--allow-weak-dev-password'])).toEqual({
      ok: false,
      unknown: ['--allow-weak-dev-password'],
    });
  });
});

describe('bootstrapStaffAdmin', () => {
  it('passes the normalized login and the password', async () => {
    const { done, bootstrap, lines } = run();
    expect(await done).toBe(0);
    expect(bootstrap).toHaveBeenCalledWith({ login: 'admin@iorder.uz', password: SECRET });
    expect(lines).toContain('Administrator account created.');
  });

  it('never prints the password or the database credentials', async () => {
    const { done, lines } = run();
    await done;
    const output = lines.join('\n');
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('db-secret');
  });

  it('warns and needs --yes when another login would add a second administrator', async () => {
    const refused = run({ hasOtherAdmins: async () => true });
    expect(await refused.done).toBe(1);
    expect(refused.bootstrap).not.toHaveBeenCalled();
    expect(refused.lines.join(' | ')).toMatch(/WARNING.*other administrator.*--yes/);
    expect(refused.lines.join(' | ')).not.toContain(SECRET);
    const allowed = run({ hasOtherAdmins: async () => true, argv: ['--yes'] });
    expect(await allowed.done).toBe(0);
    expect(allowed.lines.join(' | ')).toMatch(/WARNING.*other administrator/);
    const same = run({ hasOtherAdmins: async () => false });
    expect(await same.done).toBe(0);
  });

  it('keeps the seed safeguards: production and unknown databases need their own flags', async () => {
    expect(await run({ nodeEnv: 'production' }).done).toBe(1);
    expect(await run({ databaseUrl: 'postgresql://u:p@h:5432/other' }).done).toBe(1);
  });

  it('refuses an unknown argument, a bad login and a missing password without calling the service', async () => {
    for (const options of [
      { argv: ['--force'] },
      { login: 'not a login' },
      { login: undefined },
      { password: undefined },
      { password: '' },
      { password: 'x'.repeat(129) },
      { databaseUrl: undefined },
    ] satisfies Partial<BootstrapDeps>[]) {
      const { done, bootstrap } = run(options);
      expect(await done).toBe(1);
      expect(bootstrap).not.toHaveBeenCalled();
    }
  });

  it('reports a domain refusal without the password and with exit code 1', async () => {
    const lines: string[] = [];
    const code = await bootstrapStaffAdmin({
      login: 'admin@iorder.uz',
      password: SECRET,
      argv: [],
      nodeEnv: 'development',
      databaseUrl: DEV_URL,
      bootstrap: vi
        .fn()
        .mockRejectedValueOnce(
          new InputValidationError([
            { path: 'password', message: 'Password must be at least 8 characters' },
          ]),
        ),
      log: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines.at(-1)).toMatch(/^Refused:/);

    const blocked = await bootstrapStaffAdmin({
      login: 'admin@iorder.uz',
      password: SECRET,
      argv: [],
      nodeEnv: 'development',
      databaseUrl: DEV_URL,
      bootstrap: vi.fn().mockRejectedValue(new ConflictError('blocked', 'USER_BLOCKED')),
      log: () => undefined,
    });
    expect(blocked).toBe(1);
  });

  it('says so when nothing changed', async () => {
    const lines: string[] = [];
    await bootstrapStaffAdmin({
      login: 'admin@iorder.uz',
      password: SECRET,
      argv: [],
      nodeEnv: 'development',
      databaseUrl: DEV_URL,
      bootstrap: vi.fn().mockResolvedValue({ userCreated: false, passwordSet: false }),
      log: (line) => lines.push(line),
    });
    expect(lines.at(-1)).toMatch(/nothing changed/);
  });
});
