import { describe, expect, it, vi } from 'vitest';
import {
  ApiConflictError,
  ApiNotFoundError,
  InvalidResponseError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { createHttpClient } from '@core/lib/http-client';
import { createFakeOrganizations } from './fake-organizations-backend';
import { createHttpOrganizationsApi } from './organizations-api';

// CONTRACT test of the HTTP adapter: each method hits its route with the body the shared schema
// wants and parses the answer with the shared strict schemas. Payloads come from the fake, which
// its own test checks against the same schemas.

async function payloads() {
  const fake = createFakeOrganizations().organizationsApi;
  const list = await fake.list();
  return { list, detail: await fake.get(list[0]!.id) };
}

function setup(status: number, body?: unknown) {
  const fetchImpl = vi.fn(() =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status })),
  );
  const http = createHttpClient({ baseUrl: 'https://api.test', fetchImpl });
  return { fetchImpl, api: createHttpOrganizationsApi(http) };
}

function call(fetchImpl: ReturnType<typeof setup>['fetchImpl']): [string, RequestInit] {
  return fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
}

const errorBody = (code: string, message: string, reason?: string) => ({
  error: { code, message, ...(reason ? { reason } : {}) },
});

describe('createHttpOrganizationsApi', () => {
  it('lists with the status and search in the query string and unwraps items', async () => {
    const { list } = await payloads();
    const { api, fetchImpl } = setup(200, { items: list });
    const result = await api.list({ status: 'INACTIVE', search: 'navoiy' });
    expect(result).toHaveLength(list.length);
    const [url, init] = call(fetchImpl);
    expect(init.method).toBe('GET');
    expect(url).toBe('https://api.test/staff/organizations?search=navoiy&status=INACTIVE');
  });

  it('lists without a query string when no filter is given', async () => {
    const { list } = await payloads();
    const { api, fetchImpl } = setup(200, { items: list });
    await api.list();
    expect(call(fetchImpl)[0]).toBe('https://api.test/staff/organizations');
  });

  it('reads one organization with its members', async () => {
    const { detail } = await payloads();
    const { api, fetchImpl } = setup(200, detail);
    const result = await api.get(detail.id);
    expect(result.members.length).toBe(detail.members.length);
    expect(call(fetchImpl)[0]).toBe(`https://api.test/staff/organizations/${detail.id}`);
  });

  it('sends only the status in a PATCH (no reason, no version: the api takes none)', async () => {
    const { detail } = await payloads();
    const { api, fetchImpl } = setup(200, detail);
    await api.setStatus(detail.id, 'INACTIVE');
    const [url, init] = call(fetchImpl);
    expect(init.method).toBe('PATCH');
    expect(url).toBe(`https://api.test/staff/organizations/${detail.id}`);
    expect(JSON.parse(init.body as string)).toEqual({ status: 'INACTIVE' });
  });

  it('sends type and label filters in the query string', async () => {
    const { list } = await payloads();
    const { api, fetchImpl } = setup(200, { items: list });
    await api.list({ type: 'PERSON', label: 'PARTNER' });
    expect(call(fetchImpl)[0]).toBe(
      'https://api.test/staff/organizations?type=PERSON&label=PARTNER',
    );
  });

  it('asks for the archived list only when told to [C, owner 2026-11-13]', async () => {
    const { list } = await payloads();
    const { api, fetchImpl } = setup(200, { items: list });
    await api.list({ archived: true });
    expect(call(fetchImpl)[0]).toBe('https://api.test/staff/organizations?archived=true');
  });

  it('archives and restores on their own POST paths', async () => {
    const { detail } = await payloads();
    const archive = setup(200, { ...detail, archivedAt: '2026-11-13T05:00:00.000Z' });
    expect((await archive.api.archive(detail.id)).archivedAt).toBe('2026-11-13T05:00:00.000Z');
    expect(call(archive.fetchImpl)[1].method).toBe('POST');
    expect(call(archive.fetchImpl)[0]).toBe(
      `https://api.test/staff/organizations/${detail.id}/archive`,
    );
    const restore = setup(200, detail);
    await restore.api.restore(detail.id);
    expect(call(restore.fetchImpl)[0]).toBe(
      `https://api.test/staff/organizations/${detail.id}/restore`,
    );
  });

  it('creates an organization and parses the organization with its invite link', async () => {
    const created = await createFakeOrganizations().organizationsApi.create({
      type: 'PERSON',
      name: 'Demo',
      phone: null,
      label: 'WHOLESALE',
    });
    const { api, fetchImpl } = setup(201, created);
    const result = await api.create({
      type: 'PERSON',
      name: 'Demo',
      phone: null,
      label: 'WHOLESALE',
    });
    expect(result.invite.url).toContain('?start=org_');
    const [url, init] = call(fetchImpl);
    expect(init.method).toBe('POST');
    expect(url).toBe('https://api.test/staff/organizations');
    expect(JSON.parse(init.body as string)).toEqual({
      type: 'PERSON',
      name: 'Demo',
      phone: null,
      label: 'WHOLESALE',
    });
  });

  it('patches only the label or the phone it is given', async () => {
    const { detail } = await payloads();
    const { api, fetchImpl } = setup(200, detail);
    await api.update(detail.id, { phone: null });
    expect(JSON.parse(call(fetchImpl)[1].body as string)).toEqual({ phone: null });
  });

  it('reads and regenerates the invite on its own path', async () => {
    const invite = { status: 'EXPIRED', url: null, expiresAt: '2026-11-01T00:00:00.000Z' };
    const read = setup(200, invite);
    await read.api.getInvite('0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b');
    expect(call(read.fetchImpl)[1].method).toBe('GET');
    expect(call(read.fetchImpl)[0]).toBe(
      'https://api.test/staff/organizations/0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b/invite',
    );
    const renew = setup(200, invite);
    await renew.api.regenerateInvite('0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b');
    expect(call(renew.fetchImpl)[1].method).toBe('POST');
  });

  it('maps 403, 404 and 409 to typed errors', async () => {
    const id = (await payloads()).detail.id;
    await expect(
      setup(403, errorBody('FORBIDDEN', 'Access denied')).api.get(id),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      setup(404, errorBody('NOT_FOUND', 'Organization not found')).api.get(id),
    ).rejects.toBeInstanceOf(ApiNotFoundError);
    await expect(
      setup(409, errorBody('CONFLICT', 'conflict', 'ORGANIZATION_INACTIVE')).api.setStatus(
        id,
        'ACTIVE',
      ),
    ).rejects.toBeInstanceOf(ApiConflictError);
  });

  it('keeps the organization reasons of a 409 (shared CONFLICT_REASONS)', async () => {
    const id = (await payloads()).detail.id;
    for (const reason of [
      'ORGANIZATION_NOT_LINKED',
      'ORGANIZATION_ALREADY_LINKED',
      'PERSON_ORGANIZATION',
    ] as const) {
      const caught = await setup(409, errorBody('CONFLICT', 'conflict', reason))
        .api.regenerateInvite(id)
        .catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ApiConflictError);
      expect((caught as ApiConflictError).reason).toBe(reason);
    }
  });

  it('rejects an answer that is not the contract (an unknown field)', async () => {
    const { detail } = await payloads();
    const { api } = setup(200, { ...detail, costUsd: '1' });
    await expect(api.get(detail.id)).rejects.toBeInstanceOf(InvalidResponseError);
  });
});
