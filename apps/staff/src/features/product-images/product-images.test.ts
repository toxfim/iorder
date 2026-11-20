import {
  PRODUCT_IMAGE_MAX_BYTES,
  productImageProductSchema,
  productImageUploadResponseSchema,
} from '@iorder/shared';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { servicesKey } from '@/app/services';
import { EXIT_MS } from '@core/components/ui/motion';
import { dismissToast } from '@core/composables/use-toast';
import {
  ApiConflictError,
  ApiResponseError,
  ApiValidationError,
  NetworkError,
  PermissionDeniedError,
  RequestTimeoutError,
} from '@core/lib/api-errors';
import { createHttpClient } from '@core/lib/http-client';
import PriceEditDialog from '@/features/pricing/components/PriceEditDialog.vue';
import PricesPage from '@/features/pricing/components/PricesPage.vue';
import StockPage from '@/features/staff-cost/components/StockPage.vue';
import { canManagePhotos } from '@/features/staff-shell/price-access';
import { createTestServices } from '@/test-utils/create-test-services';
import { createFakeProductImages } from './api/fake-product-images';
import { createHttpProductImagesApi } from './api/product-images-api';
import ProductPhotoManager from './components/ProductPhotoManager.vue';
import ProductThumb from './components/ProductThumb.vue';
import { checkPhotoFile, describePhotoError, newUploadKey } from './domain/photo-upload';

const wrappers: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  dismissToast();
  vi.restoreAllMocks();
});

const body = (): HTMLElement => document.body;
const text = (el: Element | null | undefined): string =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const IMAGE_ID = '0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b';

function photo(name = 'p.png', type = 'image/png', size = 2048): File {
  const file = new File([new Uint8Array(4)], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

async function choose(file: File): Promise<void> {
  const input = body().querySelector<HTMLInputElement>('[data-testid="photo-input"]');
  if (!input) throw new Error('no file input');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
  await flushPromises();
}

function mountThumb(props: {
  src: string | null;
  largeSrc?: string | null;
  alt: string;
  zoomable?: boolean;
}) {
  const wrapper = mount(ProductThumb, { props, attachTo: document.body });
  wrappers.push(wrapper);
  return { wrapper };
}

describe('ProductThumb', () => {
  it('draws a lazy, sized photo named after the product and opens the large variant', async () => {
    const { wrapper } = mountThumb({
      src: '/api/media/product-images/x/thumb',
      largeSrc: '/api/media/product-images/x/large',
      alt: 'Baseus kabel',
    });
    const img = wrapper.find('img');
    expect(img.attributes()).toMatchObject({
      loading: 'lazy',
      width: '40',
      height: '40',
      alt: 'Baseus kabel',
      src: '/api/media/product-images/x/thumb',
    });
    const button = wrapper.find('button');
    expect(button.attributes('aria-label')).toBe('Baseus kabel: rasmni kattalashtirish');
    await button.trigger('click');
    await flushPromises();
    const large = body().querySelector<HTMLImageElement>('[data-testid="product-photo-large"]');
    expect(large?.getAttribute('src')).toBe('/api/media/product-images/x/large');
    // No dialog window: only the photo at its own size, named for a screen reader.
    const lightbox = body().querySelector('[data-testid="photo-lightbox"]');
    expect(lightbox?.getAttribute('aria-label')).toBe('Baseus kabel');
    expect(body().querySelector('[role="dialog"] h2')).toBeNull();
    expect(large?.hasAttribute('width')).toBe(false);
    // A click anywhere closes it.
    (lightbox as HTMLElement).click();
    await flushPromises();
    expect(body().querySelector('[data-testid="photo-lightbox"]')).toBeNull();
  });

  it('shows the neutral placeholder without a photo and after a failed load', async () => {
    const empty = mountThumb({ src: null, alt: 'A' });
    expect(empty.wrapper.find('[data-testid="product-thumb-empty"]').exists()).toBe(true);
    expect(empty.wrapper.find('img').exists()).toBe(false);

    const broken = mountThumb({ src: '/broken', alt: 'B' });
    await broken.wrapper.find('img').trigger('error');
    expect(broken.wrapper.find('[data-testid="product-thumb-empty"]').exists()).toBe(true);
    expect(broken.wrapper.find('button').exists()).toBe(false);
    // A new photo is tried again.
    await broken.wrapper.setProps({ src: '/fixed' });
    expect(broken.wrapper.find('img').attributes('src')).toBe('/fixed');
  });

  it('is only a picture inside another control', () => {
    const { wrapper } = mountThumb({ src: '/t', alt: 'C', zoomable: false });
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.find('img').attributes('alt')).toBe('C');
  });
});

describe('photo upload rules', () => {
  it('refuses a wrong type or a file over 10 MB before sending', () => {
    expect(checkPhotoFile({ type: 'image/jpeg', size: 1 })).toBeNull();
    expect(checkPhotoFile({ type: 'image/webp', size: PRODUCT_IMAGE_MAX_BYTES })).toBeNull();
    expect(checkPhotoFile({ type: 'image/gif', size: 1 })).toBe('type');
    expect(checkPhotoFile({ type: 'image/png', size: PRODUCT_IMAGE_MAX_BYTES + 1 })).toBe('size');
  });

  it('makes a fresh key the api accepts for every attempt', () => {
    const a = newUploadKey();
    expect(a).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(newUploadKey()).not.toBe(a);
  });

  it('maps the photo answers to their messages and the rest through apiErrors', () => {
    const conflict = (
      reason: 'PRODUCT_IMAGE_DUPLICATE' | 'PRIMARY_IMAGE_EXISTS' | 'IDEMPOTENCY_KEY_REUSED',
    ) => new ApiConflictError('x', 'CONFLICT', undefined, reason);
    expect(describePhotoError(conflict('PRODUCT_IMAGE_DUPLICATE')).key).toBe(
      'apiErrors.productImageDuplicate',
    );
    expect(describePhotoError(conflict('PRIMARY_IMAGE_EXISTS')).key).toBe(
      'apiErrors.primaryImageExists',
    );
    expect(describePhotoError(conflict('IDEMPOTENCY_KEY_REUSED')).key).toBe('photos.errors.retry');
    expect(describePhotoError(new ApiResponseError('x', 413, 'PAYLOAD_TOO_LARGE'))).toEqual({
      key: 'photos.errors.tooLarge',
      params: { mb: 10 },
    });
    expect(describePhotoError(new ApiValidationError('x', 'VALIDATION_FAILED', [])).key).toBe(
      'photos.errors.invalid',
    );
    expect(describePhotoError(new PermissionDeniedError()).key).toBe('apiErrors.denied');
  });
});

describe('photo api over HTTP', () => {
  it('uploads multipart with the Idempotency-Key and reads one product', async () => {
    const fetchImpl = vi.fn((url: string) => {
      const body = url.endsWith('/images')
        ? {
            imageId: IMAGE_ID,
            productCode: 'A 1',
            url: `/api/media/product-images/${IMAGE_ID}/large`,
            thumbUrl: `/api/media/product-images/${IMAGE_ID}/thumb`,
            isPrimary: true,
          }
        : { productCode: 'A 1', name: 'Tovar', images: [] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 201 }));
    });
    const api = createHttpProductImagesApi(
      createHttpClient({ baseUrl: 'https://api.test', fetchImpl: fetchImpl as typeof fetch }),
    );
    const uploaded = await api.upload('A 1', photo(), 'img-key-0001');
    expect(productImageUploadResponseSchema.safeParse(uploaded).success).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/staff/product-images/products/A%201/images');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Idempotency-Key': 'img-key-0001' });
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeInstanceOf(File);

    const product = await api.getProduct('A 1');
    expect(productImageProductSchema.safeParse(product).success).toBe(true);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://api.test/staff/product-images/products/A%201',
    );
  });
});

describe('photo fake (dev and tests only)', () => {
  const products = () => [
    { productCode: '10482', name: 'Kabel' },
    { productCode: 'NEW-1', name: 'Yangi' },
  ];

  it('follows the api rules: first photo primary, no silent replace, duplicates, keys, removal', async () => {
    const fake = createFakeProductImages({ products, roles: () => ['MANAGER'] });
    const api = fake.productImagesApi;
    expect(fake.primaryImage('NEW-1')).toEqual({ imageUrl: null, imageLargeUrl: null });
    const first = await api.upload('new-1', photo('a.png'), 'key-a-0001');
    expect(first.isPrimary).toBe(true);
    expect(fake.primaryImage('NEW-1').imageUrl).toBe(first.thumbUrl);
    const second = await api.upload('NEW-1', photo('b.png'), 'key-b-0001');
    expect(second.isPrimary).toBe(false);
    // The same key with the same file replays; with another file it is refused.
    expect((await api.upload('NEW-1', photo('b.png'), 'key-b-0001')).imageId).toBe(second.imageId);
    await expect(api.upload('NEW-1', photo('c.png'), 'key-b-0001')).rejects.toMatchObject({
      reason: 'IDEMPOTENCY_KEY_REUSED',
    });
    await expect(api.upload('NEW-1', photo('a.png'), 'key-a-0002')).rejects.toMatchObject({
      reason: 'PRODUCT_IMAGE_DUPLICATE',
    });
    await expect(
      api.upload('NEW-1', photo('big.png', 'image/png', PRODUCT_IMAGE_MAX_BYTES + 1), 'key-big-01'),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      api.upload('NEW-1', photo('x.gif', 'image/gif'), 'key-gif-01'),
    ).rejects.toBeInstanceOf(ApiValidationError);

    await api.setPrimary(second.imageId);
    expect(fake.primaryImage('NEW-1').imageUrl).toBe(second.thumbUrl);
    await api.remove(second.imageId);
    // Removal never promotes another photo.
    expect(fake.primaryImage('NEW-1')).toEqual({ imageUrl: null, imageLargeUrl: null });
    expect((await api.getProduct('NEW-1')).images.map((i) => i.imageId)).toEqual([first.imageId]);
    await expect(api.getProduct('NOPE')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers 403 to roles other than manager and admin', async () => {
    const fake = createFakeProductImages({ products, roles: () => ['ACCOUNTANT'] });
    await expect(fake.productImagesApi.getProduct('10482')).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(canManagePhotos(['ACCOUNTANT'])).toBe(false);
    expect(canManagePhotos(['MANAGER'])).toBe(true);
    expect(canManagePhotos(['ADMIN'])).toBe(true);
  });

  it('puts the primary photo on the stock and price list rows', async () => {
    const { services } = createTestServices({ identityId: 'manager' });
    await services.currentUser.ensureLoaded();
    const stock = await services.stockApi.listStock();
    const row = stock.items.find((i) => i.productCode === '10482');
    expect(row?.imageUrl).toMatch(/^data:image\/png;base64,/);
    expect(stock.items.find((i) => i.productCode === '10484')?.imageUrl).toBeNull();
    const list = await services.pricingApi.getCurrent();
    expect(list.items.find((i) => i.productCode === '10483')?.imageLargeUrl).toMatch(/^data:/);
  });
});

describe('ProductPhotoManager', () => {
  async function mountManager(identity = 'manager') {
    // Signed in first, as the route guard does before any staff page.
    const test = createTestServices({ identityId: identity });
    await test.services.currentUser.ensureLoaded();
    const afterChange = vi.fn();
    const busyChange = vi.fn();
    const wrapper = mount(ProductPhotoManager, {
      props: { productCode: '10482', name: 'Kabel', afterChange, busyChange },
      attachTo: document.body,
      global: { provide: { [servicesKey as symbol]: test.services } },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return { ...test, wrapper, afterChange, busyChange };
  }
  const tiles = (): HTMLElement[] =>
    Array.from(body().querySelectorAll<HTMLElement>('[data-testid="photo-tile"]'));

  it('lists the photos with the main one first and uploads a new one with a fresh key', async () => {
    const { afterChange, busyChange, services } = await mountManager();
    expect(tiles()).toHaveLength(2);
    expect(text(tiles()[0])).toContain('Asosiy');
    const upload = vi.spyOn(services.productImagesApi, 'upload');
    await choose(photo('new.webp', 'image/webp'));
    expect(upload).toHaveBeenCalledTimes(1);
    const [code, file, key] = upload.mock.calls[0]!;
    expect([code, file.name]).toEqual(['10482', 'new.webp']);
    expect(key).toMatch(/^img-[0-9a-f]{32}$/);
    expect(tiles()).toHaveLength(3);
    expect(afterChange).toHaveBeenCalledTimes(1);
    expect(busyChange.mock.calls).toEqual([[true], [false]]);

    await choose(photo('other.png'));
    expect(upload.mock.calls[1]?.[2]).not.toBe(key);
  });

  it('refuses a wrong file in the browser without a request', async () => {
    const { services } = await mountManager();
    const upload = vi.spyOn(services.productImagesApi, 'upload');
    await choose(photo('doc.pdf', 'application/pdf'));
    expect(text(body().querySelector('[role="alert"]'))).toBe(
      'Faqat JPEG, PNG yoki WebP rasm yuklash mumkin.',
    );
    await choose(photo('huge.jpg', 'image/jpeg', PRODUCT_IMAGE_MAX_BYTES + 1));
    expect(text(body().querySelector('[role="alert"]'))).toBe(
      "Fayl juda katta: 10 MB gacha bo'lishi kerak.",
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it('shows the server refusals in words', async () => {
    const { services, afterChange } = await mountManager();
    const upload = vi.spyOn(services.productImagesApi, 'upload');
    upload.mockRejectedValueOnce(
      new ApiConflictError('x', 'CONFLICT', { imageId: IMAGE_ID }, 'PRODUCT_IMAGE_DUPLICATE'),
    );
    await choose(photo());
    expect(text(body().querySelector('[role="alert"]'))).toBe('Bu rasm tovarda allaqachon bor.');
    upload.mockRejectedValueOnce(new ApiResponseError('x', 413, 'PAYLOAD_TOO_LARGE'));
    await choose(photo());
    expect(text(body().querySelector('[role="alert"]'))).toBe(
      "Fayl juda katta: 10 MB gacha bo'lishi kerak.",
    );
    upload.mockRejectedValueOnce(new ApiValidationError('x', 'VALIDATION_FAILED', []));
    await choose(photo());
    expect(text(body().querySelector('[role="alert"]'))).toContain('kamida 200 px');
    expect(afterChange).not.toHaveBeenCalled();
  });

  it.each([
    ['a network failure', new NetworkError()],
    ['a timeout', new RequestTimeoutError()],
  ])('reads the photos again after %s: the server may have stored it', async (_case, error) => {
    const { services, afterChange } = await mountManager();
    const getProduct = vi.spyOn(services.productImagesApi, 'getProduct');
    vi.spyOn(services.productImagesApi, 'upload').mockImplementationOnce(
      async (code, file, key) => {
        // Stored on the server, but the answer never arrives.
        await services.productImagesApi.upload(code, file, key);
        throw error;
      },
    );
    await choose(photo('lost.png'));
    expect(afterChange).toHaveBeenCalledTimes(1);
    expect(getProduct).toHaveBeenCalledTimes(1);
    expect(tiles()).toHaveLength(3);
    expect(body().querySelector('[role="alert"]')).not.toBeNull();
  });

  it('switches the main photo and removes one after an inline confirmation', async () => {
    const { afterChange } = await mountManager();
    const makeMain = body().querySelector<HTMLButtonElement>('[data-testid="photo-primary"]');
    makeMain?.click();
    await flushPromises();
    expect(text(tiles()[0])).toContain('Asosiy');
    expect(afterChange).toHaveBeenCalledTimes(1);

    body().querySelector<HTMLButtonElement>('[data-testid="photo-remove"]')?.click();
    await flushPromises();
    expect(tiles()).toHaveLength(2);
    expect(text(body())).toContain("Rasm o'chirilsinmi?");
    body().querySelector<HTMLButtonElement>('[data-testid="photo-remove-confirm"]')?.click();
    await flushPromises();
    expect(tiles()).toHaveLength(1);
    expect(afterChange).toHaveBeenCalledTimes(2);
  });

  it('says so when the server denies the photos', async () => {
    await mountManager('accountant');
    expect(text(body())).toContain("Rasmlarni boshqarishga ruxsatingiz yo'q.");
    expect(body().querySelector('[data-testid="photo-input"]')).toBeNull();
  });
});

describe('the price dialog shows the photos to manager and admin only', () => {
  const target = {
    productId: '00000000-0000-4000-8000-000000000001',
    productCode: '10482',
    names: [{ lang: 'UZ' as const, name: 'Kabel' }],
    isActive: true,
    codeGenerated: false,
    listed: true,
    price: '2.53',
    deferredPrice: null,
    rrp: null,
    wholesalePrice: null,
    wholesaleDeferredPrice: null,
    alifPrice: null,
    alifDeferredPrice: null,
    priceUzs: '32000.00',
    latestCostUsd: null,
    imageUrl: null,
  };

  it.each([
    ['manager', true],
    ['admin', true],
    ['accountant', false],
  ])('%s: photos shown = %s', async (identity, shown) => {
    const test = createTestServices({ identityId: identity });
    await test.services.currentUser.ensureLoaded();
    const wrapper = mount(PriceEditDialog, {
      props: { modelValue: true, product: target, baseVersionNumber: 14 },
      attachTo: document.body,
      global: { provide: { [servicesKey as symbol]: test.services } },
    });
    wrappers.push(wrapper);
    await flushPromises();
    expect(body().querySelector('[data-testid="photo-upload"]') !== null).toBe(shown);
  });

  it('holds the price save during an upload and reports the change even after it closed', async () => {
    const test = createTestServices({ identityId: 'manager' });
    await test.services.currentUser.ensureLoaded();
    let finish: () => void = () => undefined;
    const real = test.services.productImagesApi.upload.bind(test.services.productImagesApi);
    vi.spyOn(test.services.productImagesApi, 'upload').mockImplementationOnce(
      (code, file, key) =>
        new Promise((resolve, reject) => {
          finish = () => void real(code, file, key).then(resolve, reject);
        }),
    );
    const wrapper = mount(PriceEditDialog, {
      props: { modelValue: true, product: target, baseVersionNumber: 14 },
      attachTo: document.body,
      global: { provide: { [servicesKey as symbol]: test.services } },
    });
    wrappers.push(wrapper);
    await flushPromises();
    const save = (): HTMLButtonElement | undefined =>
      Array.from(body().querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        text(b).startsWith('Saqlash'),
      );
    const input = body().querySelector<HTMLInputElement>(
      '[data-price-input] input, input[inputmode="numeric"]',
    );
    if (!input) throw new Error('no price input');
    input.value = '33000';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    expect(save()?.disabled).toBe(false);

    await choose(photo('slow.png'));
    expect(save()?.disabled).toBe(true);

    // Closed while the upload runs: the photo manager is unmounted before the answer.
    await wrapper.setProps({ modelValue: false });
    // The dialog unmounts its content after the exit animation.
    await new Promise((resolve) => setTimeout(resolve, EXIT_MS + 20));
    await flushPromises();
    expect(body().querySelector('[data-testid="photo-input"]')).toBeNull();
    finish();
    await flushPromises();
    expect(wrapper.emitted('photosChanged')).toHaveLength(1);
  });
});

describe('thumbnails on the Narxlar and Qoldiq rows', () => {
  async function mountPage(path: string) {
    const test = createTestServices({ identityId: 'manager' });
    await test.services.currentUser.ensureLoaded();
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/prices', component: PricesPage },
        { path: '/stock', name: 'staff-stock', component: StockPage },
        { path: '/versions', name: 'staff-price-versions', component: { render: () => h('p') } },
        { path: '/products', name: 'staff-products', component: { render: () => h('p') } },
        { path: '/newer-models', name: 'staff-newer-models', component: { render: () => h('p') } },
        { path: '/p', name: 'staff-prices', component: { render: () => h('p') } },
      ],
    });
    await router.push(path);
    const wrapper = mount(defineComponent({ render: () => h(RouterView) }), {
      attachTo: document.body,
      global: { plugins: [router], provide: { [servicesKey as symbol]: test.services } },
    });
    wrappers.push(wrapper);
    await flushPromises();
    return test;
  }
  const rowFor = (code: string): HTMLElement => {
    const row = Array.from(body().querySelectorAll<HTMLElement>('tbody tr')).find((r) =>
      r.textContent?.includes(code),
    );
    if (!row) throw new Error(`no row ${code}`);
    return row;
  };

  it('Qoldiq: the side panel shows the current photo after a reload, not a stale copy', async () => {
    const test = await mountPage('/stock');
    const row = rowFor('10482');
    row.querySelector<HTMLElement>('.st__name')?.click();
    await flushPromises();
    const panelPhoto = (): string | null | undefined =>
      body().querySelector('.panel-photo img')?.getAttribute('src');
    const before = panelPhoto();
    expect(before).toMatch(/^data:image/);
    // Another photo becomes main (as from the price dialog), then the list reloads.
    const product = await test.services.productImagesApi.getProduct('10482');
    const other = product.images.find((i) => !i.isPrimary);
    if (!other) throw new Error('no second photo');
    await test.services.productImagesApi.setPrimary(other.imageId);
    // Dismissing a removal request reloads the stock list.
    const dismiss = Array.from(body().querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Rad etish',
    );
    if (!dismiss) throw new Error('no dismiss button');
    dismiss.click();
    await flushPromises();
    expect(panelPhoto()).toBe(other.thumbUrl);
    expect(panelPhoto()).not.toBe(before);
  });

  it.each([
    ['Narxlar', '/prices'],
    ['Qoldiq', '/stock'],
  ])('%s: a photo beside the row link, a placeholder without one', async (_page, path) => {
    await mountPage(path);
    const withPhoto = rowFor('10482');
    const thumb = withPhoto.querySelector<HTMLButtonElement>(
      'td:first-child [data-testid="product-thumb"]',
    );
    expect(thumb?.tagName).toBe('BUTTON');
    // Beside the row's own button, never inside it.
    expect(thumb?.closest('.dt__link, .st__name')).toBeNull();
    expect(thumb?.querySelector('img')?.getAttribute('loading')).toBe('lazy');
    const without = rowFor('10484');
    expect(
      without.querySelector('td:first-child [data-testid="product-thumb-empty"]'),
    ).not.toBeNull();

    // The photo opens its large view; the row's own action is not triggered.
    thumb?.click();
    await flushPromises();
    expect(body().querySelector('[data-testid="product-photo-large"]')).not.toBeNull();
    expect(body().querySelector('[data-price-input]')).toBeNull();
  });
});
