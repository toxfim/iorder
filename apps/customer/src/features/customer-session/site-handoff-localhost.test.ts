import { afterEach, describe, expect, it, vi } from 'vitest';
import { setPageLeaver } from '@core/lib/leave-page';
import { continueFromCompanySite } from './site-handoff';

// Local development: both apps run on localhost (ports 5173 and 5174), where no parent-domain
// cookie exists. The automatic trip to the other site is skipped there, whatever cookies exist.
describe('opening the customer site on localhost', () => {
  afterEach(() => {
    setPageLeaver();
    window.sessionStorage.clear();
    window.localStorage.clear();
    document.cookie = 'iorder_site_hint_localhost=; Path=/; Max-Age=0';
  });

  it('never sends the browser away, even with a hint cookie of localhost', async () => {
    expect(window.location.hostname).toBe('localhost');
    document.cookie = 'iorder_site_hint_localhost=1; Path=/';
    const leave = vi.fn();
    setPageLeaver(leave);

    const outcome = await continueFromCompanySite(
      { kind: 'none' },
      {
        exchange: vi.fn(),
        revokeSession: vi.fn(),
        handoffPage: () => Promise.resolve('http://localhost:5173/handoff'),
        hasSession: () => false,
        currentToken: () => null,
        inTelegram: () => false,
        now: () => Date.now(),
      },
    );

    expect(outcome).toBe('stay');
    expect(leave).not.toHaveBeenCalled();
  });

  it('still accepts a code that arrives in the address (the one-time exchange works anywhere)', async () => {
    const exchange = vi.fn(() => Promise.resolve());
    const outcome = await continueFromCompanySite(
      { kind: 'code', code: 'A'.repeat(43) },
      {
        exchange,
        revokeSession: vi.fn(),
        handoffPage: vi.fn(),
        hasSession: () => false,
        currentToken: () => null,
        inTelegram: () => false,
        now: () => Date.now(),
      },
    );
    expect(outcome).toBe('stay');
    expect(exchange).toHaveBeenCalledWith('A'.repeat(43));
  });
});
