import {
  createOrganizationResponseSchema,
  staffOrganizationListResponseSchema,
  staffOrganizationResponseSchema,
  type StaffRole,
} from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import {
  ApiConflictError,
  ApiError,
  ApiNotFoundError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { createFakeOrganizations } from './fake-organizations-backend';

const NOW = new Date('2026-10-21T05:00:00.000Z');

function make(roles: readonly StaffRole[] = ['MANAGER'], scenario: FakeScenario = 'ready') {
  return createFakeOrganizations({ roles: () => roles, scenario: () => scenario, now: () => NOW })
    .organizationsApi;
}

describe('fake organizations backend', () => {
  it('answers payloads the shared strict schemas accept', async () => {
    const api = make();
    const items = await api.list();
    expect(staffOrganizationListResponseSchema.safeParse({ items }).success).toBe(true);
    for (const item of items) {
      expect(staffOrganizationResponseSchema.safeParse(await api.get(item.id)).success).toBe(true);
    }
  });

  it('lists by name and filters by status and by name (case-insensitive)', async () => {
    const api = make();
    const names = (await api.list()).map((o) => o.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect((await api.list({ status: 'INACTIVE' })).every((o) => o.status === 'INACTIVE')).toBe(
      true,
    );
    expect((await api.list({ search: 'NAVOIY' })).map((o) => o.name)).toEqual([
      'Navoiy Elektronika',
    ]);
  });

  it('counts only active members and derives the shop owner', async () => {
    const api = make();
    const chilonzor = (await api.list()).find((o) => o.name === 'Chilonzor Gadget')!;
    const detail = await api.get(chilonzor.id);
    expect(detail.members).toHaveLength(3);
    expect(chilonzor.activeMemberCount).toBe(2);
    expect(chilonzor.shopOwner?.fullName).toBe('Dilshod Rakhimov');
  });

  it.each<StaffRole>(['ACCOUNTANT', 'WAREHOUSE_MANAGER', 'DRIVER'])(
    'refuses %s (EDIT_CUSTOMERS is manager and admin)',
    async (role) => {
      const api = make([role]);
      await expect(api.list()).rejects.toBeInstanceOf(PermissionDeniedError);
      const id = fakeUuid('org:navoiy');
      await expect(api.get(id)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(api.setStatus(id, 'ACTIVE')).rejects.toBeInstanceOf(PermissionDeniedError);
    },
  );

  it('lets the admin in', async () => {
    expect((await make(['ADMIN']).list()).length).toBeGreaterThan(0);
  });

  it('answers 404 for an unknown organization', async () => {
    const api = make();
    await expect(api.get(fakeUuid('nope'))).rejects.toBeInstanceOf(ApiNotFoundError);
    await expect(api.setStatus(fakeUuid('nope'), 'ACTIVE')).rejects.toBeInstanceOf(
      ApiNotFoundError,
    );
  });

  it('activates, and a repeat of the same status changes nothing', async () => {
    const api = make();
    const id = fakeUuid('org:navoiy');
    const activated = await api.setStatus(id, 'ACTIVE');
    expect(activated.status).toBe('ACTIVE');
    expect(activated.updatedAt).toBe(NOW.toISOString());
    const again = await api.setStatus(id, 'ACTIVE');
    expect(again.updatedAt).toBe(activated.updatedAt);
    expect((await api.get(id)).status).toBe('ACTIVE');
    expect((await api.list({ status: 'INACTIVE' })).some((o) => o.id === id)).toBe(false);
  });

  it('creates an unbound organization with a link, refuses its activation and renews the link', async () => {
    const api = make();
    const { organization, invite } = await api.create({
      type: 'GROUP',
      name: 'Demo group',
      phone: '+998901112233',
      label: 'PARTNER',
    });
    expect(createOrganizationResponseSchema.safeParse({ organization, invite }).success).toBe(true);
    expect(organization).toMatchObject({ status: 'INACTIVE', priceTier: 'WHOLESALE_PARTNER' });
    expect(invite.url).toContain('?startgroup=org_');
    await expect(api.setStatus(organization.id, 'ACTIVE')).rejects.toBeInstanceOf(ApiConflictError);
    const renewed = await api.regenerateInvite(organization.id);
    expect(renewed.url).not.toBe(invite.url);
    expect((await api.getInvite(organization.id)).url).toBe(renewed.url);
  });

  it('refuses a new link for a bound organization and invite routes to the purchasing manager', async () => {
    await expect(make().regenerateInvite(fakeUuid('org:karimov'))).rejects.toBeInstanceOf(
      ApiConflictError,
    );
    const reader = make(['PURCHASING_MANAGER']);
    expect((await reader.list()).length).toBeGreaterThan(0);
    await expect(reader.getInvite(fakeUuid('org:yusupova'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('changes the label (and with it the tier) and clears the phone', async () => {
    const api = make(['ADMIN']);
    const updated = await api.update(fakeUuid('org:karimov'), { label: 'STANDARD', phone: null });
    expect(updated).toMatchObject({ label: 'STANDARD', priceTier: 'STANDARD', phone: null });
  });

  it('refuses a manager label change after creation, like the api [C, owner 2026-11-12]', async () => {
    const api = make(['MANAGER']);
    await expect(
      api.update(fakeUuid('org:karimov'), { label: 'ALIF_FACTORING' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await api.update(fakeUuid('org:karimov'), { phone: null })).phone).toBeNull();
  });

  it('changes the type only while unbound', async () => {
    const api = make();
    const created = await api.create({
      type: 'GROUP',
      name: 'Turi',
      phone: null,
      label: 'STANDARD',
    });
    const id = created.organization.id;
    expect(created.organization.typeChangeable).toBe(true);
    expect((await api.update(id, { type: 'PERSON' })).type).toBe('PERSON');
    expect((await api.getInvite(id)).url).toContain('?start=');
    const linked = (await api.list()).find((org) => org.invite.status === 'LINKED')!;
    expect(linked.typeChangeable).toBe(false);
    await expect(
      api.update(linked.id, { type: linked.type === 'GROUP' ? 'PERSON' : 'GROUP' }),
    ).rejects.toMatchObject({ reason: 'ORGANIZATION_ALREADY_LINKED' });
  });

  it('reports typeChangeable like the api: unbound and without member history', async () => {
    const byName = new Map((await make().list()).map((org) => [org.name, org.typeChangeable]));
    // Pending and expired links, no members: still changeable.
    expect(byName.get('Dilnoza Yusupova')).toBe(true);
    expect(byName.get('Samarqand Savdo Markazi')).toBe(true);
    // A bound group, a bound person, and a bot-registered group without members.
    expect(byName.get('Chilonzor Gadget')).toBe(false);
    expect(byName.get('Alisher Karimov')).toBe(false);
    expect(byName.get('Buxoro Mobil Savdo')).toBe(false);
  });

  describe('archive ("delete") [C, owner 2026-11-13]', () => {
    const TERMIZ = fakeUuid('org:termiz');
    const CHILONZOR = fakeUuid('org:chilonzor');

    it('leaves archived ones out by default and lists only them with archived=true', async () => {
      const api = make();
      expect((await api.list()).some((o) => o.id === TERMIZ)).toBe(false);
      const archived = await api.list({ archived: true });
      expect(archived.map((o) => o.name)).toEqual(['Termiz Telefon Savdo']);
      expect(archived[0]?.archivedAt).not.toBeNull();
    });

    it('archives like the api: INACTIVE, members LEFT, chat released, invite revoked, hidden', async () => {
      const api = make(['ADMIN']);
      const archived = await api.archive(CHILONZOR);
      expect(archived).toMatchObject({
        status: 'INACTIVE',
        archivedAt: NOW.toISOString(),
        telegramChatId: null,
        invite: { status: 'EXPIRED', expiresAt: null },
        activeMemberCount: 0,
        shopOwner: null,
        typeChangeable: false,
      });
      // Former members stay as history; the one already LEFT keeps its own date.
      expect(archived.members.map((m) => [m.status, m.leftAt])).toEqual([
        ['LEFT', NOW.toISOString()],
        ['LEFT', NOW.toISOString()],
        ['LEFT', '2026-09-01T09:00:00.000Z'],
      ]);
      expect(staffOrganizationResponseSchema.safeParse(archived).success).toBe(true);
      expect((await api.list()).some((o) => o.id === CHILONZOR)).toBe(false);
      expect((await api.list({ archived: true })).some((o) => o.id === CHILONZOR)).toBe(true);
      expect((await api.archive(CHILONZOR)).archivedAt).toBe(archived.archivedAt);
    });

    it('restores INACTIVE and unlinked, type frozen by its history, rebindable with a new link', async () => {
      const api = make(['ADMIN']);
      await api.archive(CHILONZOR);
      const restored = await api.restore(CHILONZOR);
      expect(restored).toMatchObject({
        status: 'INACTIVE',
        archivedAt: null,
        telegramChatId: null,
        typeChangeable: false,
      });
      expect(restored.invite.status).not.toBe('LINKED');
      expect((await api.list()).some((o) => o.id === CHILONZOR)).toBe(true);
      // Activation by hand still needs a chat; a new invite link binds it again.
      await expect(api.setStatus(CHILONZOR, 'ACTIVE')).rejects.toMatchObject({
        reason: 'ORGANIZATION_NOT_LINKED',
      });
      const link = await api.regenerateInvite(CHILONZOR);
      expect(link).toMatchObject({ status: 'PENDING' });
      expect(link.url).toContain('?startgroup=org_');
      // A repeat restore changes nothing.
      expect((await api.restore(CHILONZOR)).archivedAt).toBeNull();
    });

    it.each<StaffRole>(['MANAGER', 'PURCHASING_MANAGER'])(
      'lets only the admin archive and restore (%s is refused)',
      async (role) => {
        const api = make([role]);
        await expect(api.archive(CHILONZOR)).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(api.restore(TERMIZ)).rejects.toBeInstanceOf(PermissionDeniedError);
      },
    );

    it('refuses every write on an archived organization with ORGANIZATION_ARCHIVED', async () => {
      const api = make(['ADMIN']);
      const archived = { reason: 'ORGANIZATION_ARCHIVED' };
      await expect(api.setStatus(TERMIZ, 'ACTIVE')).rejects.toMatchObject(archived);
      await expect(api.update(TERMIZ, { name: 'Yangi' })).rejects.toMatchObject(archived);
      await expect(api.regenerateInvite(TERMIZ)).rejects.toMatchObject(archived);
      // Reads still work: the page shows it read-only.
      expect((await api.get(TERMIZ)).name).toBe('Termiz Telefon Savdo');
    });
  });

  it('follows the dev scenarios on reads', async () => {
    expect(await make(['MANAGER'], 'empty').list()).toEqual([]);
    await expect(make(['MANAGER'], 'denied').list()).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(make(['MANAGER'], 'error').list()).rejects.toBeInstanceOf(ApiError);
  });
});
