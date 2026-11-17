// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Owner request (2026-10-22): no page offers a way to force or preview a screen state. A page
// shows loading, empty, error, denied and success only when the data flow really produces them.
const SRC = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(vue|ts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

// Fakes (api/fake-*, test-utils) may take a scenario option for unit tests; pages, shells,
// router and app wiring may not read or offer one.
const isTestSupport = (path: string): boolean =>
  /[\\/]api[\\/]fake-/.test(path) ||
  /[\\/]test-utils[\\/]/.test(path) ||
  /fake-scenario\.ts$/.test(path) ||
  /\.stub\.ts$/.test(path);

const FORBIDDEN: readonly [string, RegExp][] = [
  ['`state` query parameter', /query\.state\b|get\(\s*['"]state['"]\s*\)/],
  ['`state` read through bracket access', /query\[['"]state/],
  ['URL parameter read with a computed key', /searchParams\.get\(\s*(?!['"])/],
  ['state switcher component', /StateSwitcher|ScenarioSwitcher|DemoPanel/],
  ['demo state marker', /data-demo|demo-state|demoState/i],
  ['scenario selector in app code', /DEMO_SCENARIOS|FAKE_SCENARIOS|scenarioFromLocation/],
  ['simulate-error control', /simulate(Error|Failure|Loading|Denied|Forbidden)/i],
  ['preview-state control', /previewState|forceState|stateOverride/],
];

describe('no demo state controls in the app', () => {
  const files = sources(SRC).filter((p) => !isTestSupport(p));

  it('scans a meaningful number of sources', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(FORBIDDEN)('has no %s', (_label, pattern) => {
    const hits = files.filter((p) => pattern.test(readFileSync(p, 'utf8')));
    expect(hits).toEqual([]);
  });

  // Only the Telegram launch code (web-core) reads the URL, on purpose. In this app, reading the
  // address bar is how a state switcher would come back.
  it('never reads location.search', () => {
    const readers = files.filter((p) => /location\.search/.test(readFileSync(p, 'utf8')));
    expect(readers).toEqual([]);
  });

  it('the demo sign-in list exists only in the auth contract, the fake adapter and the login page', () => {
    const users = files.filter((p) =>
      /listDemoIdentities|demo\.identities/.test(readFileSync(p, 'utf8')),
    );
    expect(
      users.every((p) =>
        /auth[\\/]api[\\/]auth-api\.ts$|auth[\\/]components[\\/]LoginPage\.vue$/.test(p),
      ),
    ).toBe(true);
  });

  it('the fake-scenario helper is only used by fakes and tests, never by a page or wiring', () => {
    const users = files.filter((p) => /fake-scenario['"]/.test(readFileSync(p, 'utf8')));
    expect(users.every((p) => /[\\/]app[\\/]fake-services\.ts$/.test(p))).toBe(true);
  });
});
