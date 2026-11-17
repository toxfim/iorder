import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Black-box test of scripts/check-bundle.mjs against small fixture builds: the Telegram Login
// Widget URL is allowed in the staff-auth chunk and nowhere else.

// Every case spawns the real check script synchronously; under a loaded machine (several agents or
// a full parallel run) that exceeds the suite-wide 20 s limit although the logic is fine.
vi.setConfig({ testTimeout: 120_000 });

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'check-bundle.mjs',
);
const WIDGET = 'https://telegram.org/js/telegram-widget.js';
const dirs: string[] = [];

function run(files: Record<string, string>): { ok: boolean; output: string } {
  const dist = mkdtempSync(join(tmpdir(), 'iorder-dist-'));
  dirs.push(dist);
  mkdirSync(join(dist, 'assets'));
  writeFileSync(
    join(dist, 'index.html'),
    '<script type="module" src="/assets/index-1.js"></script>',
  );
  writeFileSync(join(dist, 'assets', 'index-1.js'), 'console.log(1)');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dist, 'assets', name), text);
  try {
    const output = execFileSync(process.execPath, [SCRIPT], {
      env: { ...process.env, CHECK_BUNDLE_DIST: dist },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true, output };
  } catch (caught) {
    const failure = caught as { stderr?: string; stdout?: string };
    return { ok: false, output: `${failure.stderr ?? ''}${failure.stdout ?? ''}` };
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('check-bundle: Telegram script rule', () => {
  it('passes when no chunk names a Telegram script', () => {
    expect(run({ 'LoginPage-2.js': 'x' }).ok).toBe(true);
  });

  it('allows the Login Widget URL in the staff-auth chunk', () => {
    expect(run({ 'staff-auth-9.js': `const s="${WIDGET}";` }).ok).toBe(true);
  });

  it('rejects the widget URL in any other chunk (the customer bundle)', () => {
    const result = run({ 'customer-app-3.js': `const s="${WIDGET}";` });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('customer-app-3.js');
  });

  it('rejects the widget URL in the entry chunk', () => {
    expect(run({ 'index-1.js': `load("${WIDGET}")` }).ok).toBe(false);
  });

  it('rejects the Mini App script or any other Telegram script, even in the staff-auth chunk', () => {
    expect(
      run({ 'staff-auth-9.js': 'load("https://telegram.org/js/telegram-web-app.js")' }).ok,
    ).toBe(false);
    expect(run({ 'staff-auth-9.js': `"${WIDGET}";"https://telegram.org/js/other.js"` }).ok).toBe(
      false,
    );
  });

  it('keeps the staff accounts and group removal vocabulary in staff chunks', () => {
    for (const needle of ['"/staff/accounts"', '"removeFromGroups"', '"hasPassword"']) {
      expect(run({ 'customer-app-3.js': needle }).ok).toBe(false);
      expect(run({ 'staff-users-4.js': needle }).ok).toBe(true);
    }
    const prose = run({ 'customer-app-3.js': '"Remove from the group too?"' });
    expect(prose.ok).toBe(false);
    expect(prose.output).toContain('staff accounts text');
    expect(run({ 'staff-users-4.js': '"Remove from the group too?"' }).ok).toBe(true);
  });

  it('rejects the fake staff users fixtures anywhere', () => {
    expect(run({ 'staff-users-4.js': '"iorder-fake-staff-users"' }).ok).toBe(false);
  });

  it('rejects the sign-in route names in a non-staff chunk', () => {
    expect(run({ 'customer-app-3.js': '"/auth/password-login"' }).ok).toBe(false);
    expect(run({ 'staff-auth-9.js': '"/auth/password-login"' }).ok).toBe(true);
  });
});

describe('check-bundle: staff-finance import cycles', () => {
  // The 2026-10-28 staging outage: staff-finance imported a page chunk that imported it back.
  it('rejects a static import cycle through staff-finance', () => {
    const result = run({
      'staff-finance-1.js': 'import{a as b}from"./ProductFormDialog-2.js";export const s={};',
      'ProductFormDialog-2.js': 'import{s as t}from"./staff-finance-1.js";export const a=1;',
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain(
      'static import cycle: staff-finance-1.js -> ProductFormDialog-2.js -> staff-finance-1.js',
    );
  });

  it('allows a one-way import and a dynamic import back', () => {
    expect(
      run({
        'staff-finance-1.js': 'const p=()=>import("./PriceEditDialog-2.js");export const s={};',
        'PriceEditDialog-2.js': 'import{s as t}from"./staff-finance-1.js";export const a=1;',
      }).ok,
    ).toBe(true);
  });
});
