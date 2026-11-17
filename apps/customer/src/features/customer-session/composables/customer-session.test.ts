import type { MeResponse } from '@iorder/shared';
import { describe, expect, it, vi } from 'vitest';
import { NetworkError, PermissionDeniedError, UnauthenticatedError } from '@core/lib/api-errors';
import type { MeApi } from '../api/me-api';
import { createCustomerSession } from './customer-session';

const ME: MeResponse = {
  userId: '11111111-1111-4111-8111-111111111111',
  fullName: 'Anvar Soliyev',
  locale: 'RU',
  staffRoles: [],
  membership: { organizationId: '22222222-2222-4222-8222-222222222222', role: 'SELLER' },
  contact: { fullName: 'Anvar Soliyev', phone: '+998901112233' },
  needsContact: false,
};

function sessionWith(
  getMe: MeApi['getMe'],
  initData: string | null = 'init',
  onMe?: (me: MeResponse) => void,
  setContact: MeApi['setContact'] = () => Promise.resolve(ME),
) {
  const meApi: MeApi = { getMe: vi.fn(getMe), setContact: vi.fn(setContact) };
  return { meApi, session: createCustomerSession({ meApi, readInitData: () => initData, onMe }) };
}

describe('customer contact', () => {
  const NEW_CUSTOMER: MeResponse = { ...ME, contact: null, needsContact: true };

  it('needsContact follows /me and clears once the contact is saved', async () => {
    const { session, meApi } = sessionWith(
      () => Promise.resolve(NEW_CUSTOMER),
      'init',
      undefined,
      () => Promise.resolve(ME),
    );
    await session.load();
    expect(session.needsContact.value).toBe(true);
    await session.setContact({ fullName: 'Anvar Soliyev', phone: '+998901112233' });
    expect(meApi.setContact).toHaveBeenCalledOnce();
    expect(session.needsContact.value).toBe(false);
    expect(session.me.value?.contact?.phone).toBe('+998901112233');
  });

  it('a failed save keeps the state and rethrows; refreshMe is quiet when it fails', async () => {
    const { session } = sessionWith(
      () => Promise.resolve(NEW_CUSTOMER),
      'init',
      undefined,
      () => Promise.reject(new NetworkError()),
    );
    await session.load();
    await expect(
      session.setContact({ fullName: 'A', phone: '+998901112233' }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(session.needsContact.value).toBe(true);
    expect(session.state.value).toBe('ready');
  });
});

describe('customer session', () => {
  it('opened outside Telegram: no-telegram, and nothing is requested', async () => {
    const { session, meApi } = sessionWith(() => Promise.resolve(ME), null);
    await session.load();
    expect(session.state.value).toBe('no-telegram');
    expect(meApi.getMe).not.toHaveBeenCalled();
  });

  it('a member is ready, exposes the role and hands the profile to onMe', async () => {
    const onMe = vi.fn();
    const { session } = sessionWith(() => Promise.resolve(ME), 'init', onMe);
    await session.load();
    expect(session.state.value).toBe('ready');
    expect(session.organizationRole.value).toBe('SELLER');
    expect(onMe).toHaveBeenCalledWith(ME);
  });

  it.each([
    ['401 (unknown, blocked or inactive group)', () => Promise.reject(new UnauthenticatedError())],
    ['403', () => Promise.reject(new PermissionDeniedError())],
    ['no membership', () => Promise.resolve({ ...ME, membership: null })],
    ['a staff member', () => Promise.resolve({ ...ME, staffRoles: ['MANAGER' as const] })],
  ])('%s shows the same denied state', async (_name, answer) => {
    const { session } = sessionWith(answer);
    await session.load();
    expect(session.state.value).toBe('denied');
    expect(session.me.value).toBeNull();
  });

  it('a network failure is an error that can be retried, not a denial', async () => {
    let fail = true;
    const { session } = sessionWith(() =>
      fail ? Promise.reject(new NetworkError()) : Promise.resolve(ME),
    );
    await session.load();
    expect(session.state.value).toBe('error');
    fail = false;
    await session.load();
    expect(session.state.value).toBe('ready');
  });

  it('a later 401 turns a ready session into denied', async () => {
    const { session } = sessionWith(() => Promise.resolve(ME));
    await session.load();
    session.markDenied();
    expect(session.state.value).toBe('denied');
    expect(session.me.value).toBeNull();
  });
});

describe('a company employee as a viewer ([C] 2026-11-09)', () => {
  const VIEWER: MeResponse = {
    ...ME,
    // The Mini App answer still carries the roles; the viewer block alone decides.
    staffRoles: ['MANAGER'],
    membership: null,
    contact: null,
    staffViewer: { canOrder: false, organizationName: null },
  };

  it('is let in when the server names them a viewer, whatever roles the answer carries', async () => {
    const { session } = sessionWith(() => Promise.resolve(VIEWER));
    await session.load();
    expect(session.state.value).toBe('ready');
    expect(session.staffViewer.value).toEqual({ canOrder: false, organizationName: null });
    expect(session.organizationRole.value).toBeNull();
    expect(session.organizationName.value).toBeNull();
    expect(session.needsContact.value).toBe(false);
  });

  it('knows the organization an order goes to when ordering is on', async () => {
    const { session } = sessionWith(() =>
      Promise.resolve({
        ...VIEWER,
        staffRoles: [],
        staffViewer: { canOrder: true, organizationName: 'Test shop' },
      }),
    );
    await session.load();
    expect(session.state.value).toBe('ready');
    expect(session.staffViewer.value?.canOrder).toBe(true);
    expect(session.organizationName.value).toBe('Test shop');
  });

  it.each([null, undefined])(
    'an employee the server does not name a viewer (staffViewer %s) is denied, as before',
    async (staffViewer) => {
      const answer: MeResponse = {
        ...ME,
        staffRoles: ['MANAGER'],
        membership: null,
        contact: null,
        ...(staffViewer === null ? { staffViewer } : {}),
      };
      const { session } = sessionWith(() => Promise.resolve(answer));
      await session.load();
      expect(session.state.value).toBe('denied');
      expect(session.staffViewer.value).toBeNull();
    },
  );

  it('a customer is not a viewer', async () => {
    const { session } = sessionWith(() => Promise.resolve({ ...ME, staffViewer: null }));
    await session.load();
    expect(session.state.value).toBe('ready');
    expect(session.staffViewer.value).toBeNull();
  });
});
