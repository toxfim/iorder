import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Black-box test of scripts/check-bundle.mjs against small fixture builds: the customer app gets
// the shared rules without the staff-chunk exception.

// Every case spawns the real script; a loaded machine can exceed the suite-wide limit.
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
  const dist = mkdtempSync(join(tmpdir(), 'iorder-customer-dist-'));
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

describe('customer check-bundle', () => {
  it('passes a clean build', () => {
    expect(run({ 'CatalogPage-2.js': 'x' }).ok).toBe(true);
  });

  it('allows the Login Widget URL only in the website-auth chunk', () => {
    expect(run({ 'website-auth-3.js': `const s="${WIDGET}";` }).ok).toBe(true);
    expect(run({ 'CustomerLogin-3.js': `const s="${WIDGET}";` }).ok).toBe(false);
  });

  it('refuses staff vocabulary in every chunk, even one named staff', () => {
    for (const name of ['CatalogPage-4.js', 'staff-orders-4.js']) {
      const result = run({ [name]: 'const k="accountingMode";' });
      expect(result.ok).toBe(false);
      expect(result.output).toContain('accountingMode');
    }
  });

  it('refuses a staff chunk by its name alone', () => {
    const result = run({ 'staff-finance-5.js': 'x' });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('in the customer app');
  });

  it('refuses fake-adapter data', () => {
    expect(run({ 'index-6.js': 'const m="iorder-fake-customer-backend";' }).ok).toBe(false);
  });
});
