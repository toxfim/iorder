import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../src/common/auth/actor.js';
import { CatalogModule, ProductImagesService } from '../src/modules/catalog/index.js';
import { ApiTokenService, IdentityModule } from '../src/modules/identity/index.js';
import { makeUser } from './support/identity-fixtures.js';
import { FAKE_BOT_TOKEN } from './support/init-data.js';
import { resetCatalogPricingAudit, resetIdentity } from './support/test-db.js';
import {
  ACTOR_HEADER,
  ADMIN,
  createTestApp,
  DRIVER,
  MANAGER,
  SHOP_OWNER,
  type TestApp,
} from './support/test-app.js';

const mediaDir = mkdtempSync(join(tmpdir(), 'iorder-media-'));

function picture(color: string, width = 400, height = 300): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
}

interface UploadOptions {
  bytes: Buffer;
  key?: string;
  isPrimary?: 'true' | 'false';
  sourceUrl?: string;
  auth: { actor: Actor } | { authorization: string };
}

async function upload(
  t: TestApp,
  productCode: string,
  options: UploadOptions,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { port } = t.app.getHttpServer().address() as AddressInfo;
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(options.bytes)], { type: 'image/jpeg' }), 'p.jpg');
  if (options.isPrimary) form.append('isPrimary', options.isPrimary);
  if (options.sourceUrl) form.append('sourceUrl', options.sourceUrl);
  const headers: Record<string, string> =
    'actor' in options.auth
      ? { [ACTOR_HEADER]: JSON.stringify(options.auth.actor) }
      : { authorization: options.auth.authorization };
  if (options.key) headers['idempotency-key'] = options.key;
  const response = await fetch(
    `http://127.0.0.1:${port}/staff/product-images/products/${encodeURIComponent(productCode)}/images`,
    { method: 'POST', headers, body: form },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function makeProduct(t: TestApp, productCode: string, isActive = true): Promise<string> {
  const product = await t.prisma.product.create({
    data: {
      productCode,
      isActive,
      translations: { create: [{ lang: 'UZ', name: `Tovar ${productCode}` }] },
    },
  });
  return product.id;
}

const mediaPath = (url: unknown): string => String(url).replace(/^\/api/, '');

describe('product images (real PostgreSQL, header actor)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([CatalogModule], { env: { MEDIA_DIR: mediaDir } });
    await t.prisma.$connect();
  });
  afterAll(async () => {
    await t.close();
    rmSync(mediaDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    t.clock.set(new Date('2026-10-29T08:00:00Z'));
    await resetCatalogPricingAudit(t.prisma);
  });

  it('401 without an actor; 403 for roles other than manager and admin', async () => {
    expect((await t.request('GET', '/staff/product-images/products')).status).toBe(401);
    for (const actor of [DRIVER, SHOP_OWNER]) {
      expect((await t.request('GET', '/staff/product-images/products', { actor })).status).toBe(
        403,
      );
      expect(
        (
          await upload(t, 'A-1', {
            bytes: await picture('#f00'),
            key: 'k-00000001',
            auth: { actor },
          })
        ).status,
      ).toBe(403);
    }
  });

  it('uploads, makes the first photo primary, writes files and an audit row', async () => {
    await makeProduct(t, 'Mi-14273');
    const first = await upload(t, 'mi-14273', {
      bytes: await picture('#f00', 2400, 1200),
      key: 'upload-0001',
      sourceUrl: 'https://example.com/p/14273',
      auth: { actor: MANAGER },
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ productCode: 'Mi-14273', isPrimary: true });
    const imageId = String(first.body['imageId']);
    expect(first.body['url']).toBe(`/api/media/product-images/${imageId}/large`);
    expect(
      readdirSync(join(mediaDir, 'product-images'))
        .filter((f) => f.startsWith(imageId))
        .sort(),
    ).toEqual([`${imageId}-large.webp`, `${imageId}-original.jpg`, `${imageId}-thumb.webp`]);

    const audit = await t.prisma.auditLog.findMany({ where: { entityId: imageId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'PRODUCT_IMAGE_UPLOADED',
      actorUserId: MANAGER.userId,
    });

    const second = await upload(t, 'MI-14273', {
      bytes: await picture('#0f0'),
      key: 'upload-0002',
      auth: { actor: ADMIN },
    });
    expect(second.status).toBe(201);
    expect(second.body['isPrimary']).toBe(false);

    const list = await t.request('GET', '/staff/product-images/products', { actor: MANAGER });
    expect(list.status).toBe(200);
    const item = (
      list.body as {
        items: {
          productCode: string;
          name: string;
          images: { imageId: string; width: number; sourceUrl: string | null }[];
        }[];
      }
    ).items[0];
    expect(item?.productCode).toBe('Mi-14273');
    expect(item?.name).toBe('Tovar Mi-14273');
    expect(item?.images.map((image) => image.imageId)).toEqual([imageId, second.body['imageId']]);
    expect(item?.images[0]).toMatchObject({
      width: 1200,
      sourceUrl: 'https://example.com/p/14273',
    });

    // One product (code matched ignoring case): the same shape as a list item.
    const one = await t.request('GET', '/staff/product-images/products/MI-14273', {
      actor: ADMIN,
    });
    expect(one.status).toBe(200);
    expect(one.body).toEqual(item);
    expect(
      (await t.request('GET', '/staff/product-images/products/NOPE-1', { actor: MANAGER })).status,
    ).toBe(404);
    expect(
      (await t.request('GET', '/staff/product-images/products/MI-14273', { actor: DRIVER })).status,
    ).toBe(403);

    const { port } = t.app.getHttpServer().address() as AddressInfo;
    const media = await fetch(`http://127.0.0.1:${port}${mediaPath(first.body['thumbUrl'])}`);
    expect(media.status).toBe(200);
    expect(media.headers.get('content-type')).toBe('image/webp');
    expect(media.headers.get('cache-control')).toContain('immutable');
    expect(media.headers.get('x-content-type-options')).toBe('nosniff');
    const thumb = await sharp(Buffer.from(await media.arrayBuffer())).metadata();
    expect([thumb.format, thumb.width]).toEqual(['webp', 256]);
  });

  it('replays the same Idempotency-Key, refuses it for another file, refuses a duplicate file', async () => {
    await makeProduct(t, 'P-1');
    const bytes = await picture('#00f');
    const first = await upload(t, 'P-1', { bytes, key: 'same-key-1', auth: { actor: MANAGER } });
    const again = await upload(t, 'P-1', { bytes, key: 'same-key-1', auth: { actor: MANAGER } });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body['imageId']).toBe(first.body['imageId']);
    expect(await t.prisma.productImage.count()).toBe(1);

    const reused = await upload(t, 'P-1', {
      bytes: await picture('#ff0'),
      key: 'same-key-1',
      auth: { actor: MANAGER },
    });
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ error: { reason: 'IDEMPOTENCY_KEY_REUSED' } });

    const duplicate = await upload(t, 'P-1', { bytes, key: 'other-key-1', auth: { actor: ADMIN } });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({
      error: { reason: 'PRODUCT_IMAGE_DUPLICATE', details: { imageId: first.body['imageId'] } },
    });

    const missingKey = await upload(t, 'P-1', {
      bytes: await picture('#0ff'),
      auth: { actor: MANAGER },
    });
    expect(missingKey.status).toBe(422);
    const unknown = await upload(t, 'NOPE', {
      bytes,
      key: 'other-key-2',
      auth: { actor: MANAGER },
    });
    expect(unknown.status).toBe(404);
    const notImage = await upload(t, 'P-1', {
      bytes: Buffer.from('hello'),
      key: 'other-key-3',
      auth: { actor: MANAGER },
    });
    expect(notImage.status).toBe(422);
    expect(await t.prisma.productImage.count()).toBe(1);
  });

  it('never replaces the primary silently; switching is explicit; removal does not promote', async () => {
    await makeProduct(t, 'P-2');
    const first = await upload(t, 'P-2', {
      bytes: await picture('#111'),
      key: 'prim-0001',
      auth: { actor: MANAGER },
    });
    const refused = await upload(t, 'P-2', {
      bytes: await picture('#222'),
      key: 'prim-0002',
      isPrimary: 'true',
      auth: { actor: MANAGER },
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: { reason: 'PRIMARY_IMAGE_EXISTS' } });

    const second = await upload(t, 'P-2', {
      bytes: await picture('#222'),
      key: 'prim-0003',
      auth: { actor: MANAGER },
    });
    const secondId = String(second.body['imageId']);
    const switched = await t.request('PUT', `/staff/product-images/images/${secondId}/primary`, {
      actor: ADMIN,
    });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({ imageId: secondId, isPrimary: true });
    const rows = await t.prisma.productImage.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((row) => row.isPrimary)).toEqual([false, true]);

    const removed = await t.request('DELETE', `/staff/product-images/images/${secondId}`, {
      actor: MANAGER,
    });
    expect(removed.status).toBe(204);
    expect((await t.request('GET', `/media/product-images/${secondId}/large`)).status).toBe(404);
    expect(
      (await t.request('DELETE', `/staff/product-images/images/${secondId}`, { actor: MANAGER }))
        .status,
    ).toBe(404);
    expect(
      (
        await t.request('PUT', `/staff/product-images/images/${secondId}/primary`, {
          actor: MANAGER,
        })
      ).status,
    ).toBe(404);
    const after = await t.prisma.productImage.findMany({ orderBy: { createdAt: 'asc' } });
    expect(after.map((row) => [row.isPrimary, row.removedAt !== null])).toEqual([
      [false, false],
      [false, true],
    ]);
    // The file stays on disk: removing is history, not deletion.
    expect(readdirSync(join(mediaDir, 'product-images'))).toContain(`${secondId}-large.webp`);
    const actions = (
      await t.prisma.auditLog.findMany({
        where: { entityId: secondId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => row.action);
    expect(actions.sort()).toEqual([
      'PRODUCT_IMAGE_PRIMARY_SET',
      'PRODUCT_IMAGE_REMOVED',
      'PRODUCT_IMAGE_UPLOADED',
    ]);
    expect(first.status).toBe(201);
  });

  it('gives primary thumbs as JPEG for the Excel export and skips missing ones', async () => {
    const withPhoto = await makeProduct(t, 'X-1');
    const withoutPhoto = await makeProduct(t, 'X-2');
    const fileGone = await makeProduct(t, 'X-3');
    await upload(t, 'X-1', {
      bytes: await picture('#3a6'),
      key: 'export-01',
      auth: { actor: MANAGER },
    });
    const gone = await upload(t, 'X-3', {
      bytes: await picture('#a36'),
      key: 'export-02',
      auth: { actor: MANAGER },
    });
    rmSync(join(mediaDir, 'product-images', `${String(gone.body['imageId'])}-thumb.webp`));

    const thumbs = await t.app
      .get(ProductImagesService)
      .primaryThumbnailsForExport([withPhoto, withoutPhoto, fileGone]);

    expect([...thumbs.keys()]).toEqual([withPhoto]);
    const thumb = thumbs.get(withPhoto);
    expect(thumb?.extension).toBe('jpeg');
    const metadata = await sharp(thumb?.buffer).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(256);
  });

  it('pages active products by code and filters those without photos', async () => {
    for (const code of ['C-3', 'a-1', 'B-2']) await makeProduct(t, code);
    await makeProduct(t, 'Z-OFF', false);
    await upload(t, 'B-2', {
      bytes: await picture('#333'),
      key: 'page-0001',
      auth: { actor: MANAGER },
    });

    const page1 = await t.request('GET', '/staff/product-images/products?limit=2', {
      actor: MANAGER,
    });
    const body1 = page1.body as { items: { productCode: string }[]; nextCursor: string | null };
    expect(body1.items.map((item) => item.productCode)).toEqual(['a-1', 'B-2']);
    expect(body1.nextCursor).not.toBeNull();
    const page2 = await t.request(
      'GET',
      `/staff/product-images/products?limit=2&cursor=${body1.nextCursor}`,
      { actor: MANAGER },
    );
    const body2 = page2.body as { items: { productCode: string }[]; nextCursor: string | null };
    expect(body2.items.map((item) => item.productCode)).toEqual(['C-3']);
    expect(body2.nextCursor).toBeNull();

    const without = await t.request('GET', '/staff/product-images/products?withoutImages=true', {
      actor: MANAGER,
    });
    expect(
      (without.body as { items: { productCode: string }[] }).items.map((item) => item.productCode),
    ).toEqual(['a-1', 'C-3']);
    expect(
      (await t.request('GET', '/staff/product-images/products?cursor=%%%', { actor: MANAGER }))
        .status,
    ).toBe(422);
    expect(
      (await t.request('GET', '/staff/product-images/products?limit=500', { actor: MANAGER }))
        .status,
    ).toBe(422);
  });

  it('answers 404 for unknown media and 422 for a bad variant', async () => {
    expect(
      (await t.request('GET', '/media/product-images/0195f0a0-0000-7000-8000-000000000001/large'))
        .status,
    ).toBe(404);
    expect(
      (
        await t.request(
          'GET',
          '/media/product-images/0195f0a0-0000-7000-8000-000000000001/original',
        )
      ).status,
    ).toBe(422);
  });

  it('answers concurrent uploads with the same key as one 201 and replays', async () => {
    await makeProduct(t, 'RACE-1');
    const bytes = await picture('#468');
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        upload(t, 'RACE-1', { bytes, key: 'race-key-0001', auth: { actor: MANAGER } }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(results.map((r) => r.body['imageId'])).size).toBe(1);
    expect(await t.prisma.productImage.count()).toBe(1);
  });

  it('answers concurrent removals of one photo with one 204 and one 404', async () => {
    await makeProduct(t, 'RACE-2');
    const first = await upload(t, 'RACE-2', {
      bytes: await picture('#864'),
      key: 'race-key-0002',
      auth: { actor: MANAGER },
    });
    const id = String(first.body['imageId']);
    const statuses = await Promise.all(
      [MANAGER, ADMIN].map(
        async (actor) =>
          (await t.request('DELETE', `/staff/product-images/images/${id}`, { actor })).status,
      ),
    );
    expect(statuses.sort()).toEqual([204, 404]);
    expect(
      await t.prisma.auditLog.count({ where: { entityId: id, action: 'PRODUCT_IMAGE_REMOVED' } }),
    ).toBe(1);
  });

  it('refuses a file over 10 MB with 413 before any image work', async () => {
    await makeProduct(t, 'BIG-1');
    const tooBig = await upload(t, 'BIG-1', {
      bytes: Buffer.alloc(10 * 1024 * 1024 + 1, 1),
      key: 'big-key-0001',
      auth: { actor: MANAGER },
    });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(await t.prisma.productImage.count()).toBe(0);
  });
});

describe('API tokens through the production resolver (real PostgreSQL)', () => {
  let t: TestApp;
  let tokens: ApiTokenService;

  beforeAll(async () => {
    t = await createTestApp([IdentityModule, CatalogModule], {
      botToken: FAKE_BOT_TOKEN,
      env: { MEDIA_DIR: mediaDir },
    });
    await t.prisma.$connect();
    tokens = t.get(ApiTokenService);
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    t.clock.set(new Date('2026-10-29T08:00:00Z'));
    await resetIdentity(t.prisma);
    await resetCatalogPricingAudit(t.prisma);
  });

  async function staffWithLogin(
    login: string,
    roles: ('ADMIN' | 'MANAGER' | 'DRIVER')[],
  ): Promise<string> {
    const user = await makeUser(t.prisma, { staff: roles });
    await t.prisma.staffCredential.create({
      data: {
        userId: user.id,
        scope: 'STAFF',
        login,
        passwordHash: 'scrypt$v1$N=1024,r=8,p=1$c2FsdA$aGFzaA',
        passwordChangedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    return user.id;
  }

  const bearer = (token: string): { authorization: string } => ({
    authorization: `Bearer ${token}`,
  });

  it('acts as its person only within its scope, audits the issue, and records the upload as via token', async () => {
    const adminId = await staffWithLogin('admin@iorder.uz', ['ADMIN']);
    await makeProduct(t, 'T-1');
    const { token, record } = await tokens.issue({
      login: 'ADMIN@iorder.uz',
      name: 'codex-photos',
      days: 7,
      scopes: ['MANAGE_PRODUCT_IMAGES'],
    });
    expect(record.userId).toBe(adminId);
    const issued = await t.prisma.auditLog.findFirst({ where: { entityId: record.id } });
    expect(issued).toMatchObject({ action: 'CLI_API_TOKEN_ISSUED', actorUserId: null });
    expect(JSON.stringify(issued?.diff)).not.toContain(token);

    const list = await t.request('GET', '/staff/product-images/products', {
      headers: bearer(token),
    });
    expect(list.status).toBe(200);
    const created = await upload(t, 'T-1', {
      bytes: await picture('#abc'),
      key: 'token-0001',
      auth: bearer(token),
    });
    expect(created.status).toBe(201);
    const audit = await t.prisma.auditLog.findFirst({
      where: { entityId: String(created.body['imageId']) },
    });
    expect(audit?.actorUserId).toBe(adminId);
    expect(audit?.diff).toMatchObject({ viaApiToken: { from: null, to: true } });

    // The admin role grants these; the token does not.
    expect((await t.request('GET', '/staff/users', { headers: bearer(token) })).status).toBe(403);
    expect((await t.request('GET', '/me', { headers: bearer(token) })).status).toBe(403);
  });

  it('stops working when revoked, expired, or the person is blocked or loses the role', async () => {
    const userId = await staffWithLogin('manager@iorder.uz', ['MANAGER']);
    const issue = (): ReturnType<ApiTokenService['issue']> =>
      tokens.issue({
        login: 'manager@iorder.uz',
        name: 'x',
        days: 1,
        scopes: ['MANAGE_PRODUCT_IMAGES'],
      });
    const status = async (token: string): Promise<number> =>
      (await t.request('GET', '/staff/product-images/products', { headers: bearer(token) })).status;

    const revoked = await issue();
    expect(await status(revoked.token)).toBe(200);
    expect(await tokens.revoke(revoked.record.id)).toBe(true);
    expect(await tokens.revoke(revoked.record.id)).toBe(false);
    expect(await status(revoked.token)).toBe(401);

    const expiring = await issue();
    t.clock.set(new Date('2026-10-30T08:00:00Z'));
    expect(await status(expiring.token)).toBe(401);
    t.clock.set(new Date('2026-10-29T09:00:00Z'));

    const live = await issue();
    await t.prisma.userRole.deleteMany({ where: { userId } });
    await t.prisma.userRole.create({ data: { userId, role: 'DRIVER' } });
    expect(await status(live.token)).toBe(403);
    await t.prisma.user.update({ where: { id: userId }, data: { status: 'BLOCKED' } });
    expect(await status(live.token)).toBe(401);

    expect(await status(`iot_${'A'.repeat(43)}`)).toBe(401);
  });

  it('refuses to issue for an unknown login or a role without the scope', async () => {
    await staffWithLogin('driver@iorder.uz', ['DRIVER']);
    await expect(
      tokens.issue({
        login: 'nobody@iorder.uz',
        name: 'x',
        days: 1,
        scopes: ['MANAGE_PRODUCT_IMAGES'],
      }),
    ).rejects.toThrow(/No active staff account/);
    await expect(
      tokens.issue({
        login: 'driver@iorder.uz',
        name: 'x',
        days: 1,
        scopes: ['MANAGE_PRODUCT_IMAGES'],
      }),
    ).rejects.toThrow(/Request validation failed/);
    expect(await t.prisma.apiToken.count()).toBe(0);
  });
});
