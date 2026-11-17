import type { CustomerPriceListResponse } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import {
  bodyText,
  click,
  findButton,
  mountCustomerApp,
  useCustomerTestLifecycle,
} from '@/test-utils/customer-app';
import { waitFor } from '@core/test-utils/wait';
import { fakeUuid } from '@core/lib/fake-ids';
import { customerUz } from '@/features/customer-app/messages/uz';

useCustomerTestLifecycle();

const all = (selector: string): Element[] => Array.from(document.body.querySelectorAll(selector));

// A price list longer than one batch of cards; every second product has a photo.
function longList(count: number): CustomerPriceListResponse {
  return {
    version: { number: 3, publishedAt: '2026-10-19T03:30:00.000Z' },
    items: Array.from({ length: count }, (_, i) => {
      const code = `P-${String(i + 1).padStart(3, '0')}`;
      const imageId = fakeUuid(`photo:${code}`);
      const photo = i % 2 === 0;
      return {
        productId: fakeUuid(`product:${code}`),
        productCode: code,
        unit: 'PIECE',
        name: `Product ${code}`,
        price: '1000.00',
        deferredPrice: '2222.00',
        rrp: null,
        orderableStock: null,
        currency: 'UZS' as const,
        category: 'Смартфоны',
        imageUrl: photo ? `/api/media/product-images/${imageId}/thumb` : null,
        imageLargeUrl: photo ? `/api/media/product-images/${imageId}/large` : null,
      };
    }),
  };
}

const mountWith = (count: number) =>
  mountCustomerApp('fake-owner', '/prices', {
    decorate: (backend) => {
      backend.priceApi.getCurrent = () => Promise.resolve(longList(count));
    },
  });

describe('customer price list: photo grid', () => {
  it('puts the cards on the page a batch at a time; the count and the search cover the whole list', async () => {
    await mountWith(60);
    await waitFor(() => expect(all('.card')).toHaveLength(24));
    expect(bodyText()).toContain('60 ta mahsulot');
    await click(findButton(customerUz.catalog.showMore));
    expect(all('.card')).toHaveLength(48);
    await click(findButton(customerUz.catalog.showMore));
    expect(all('.card')).toHaveLength(60);
    expect(document.body.querySelector('.more')).toBeNull();
  });

  it('a search finds products that are not on the page yet', async () => {
    await mountWith(60);
    await waitFor(() => expect(all('.card')).toHaveLength(24));
    const search = document.body.querySelector('.tools input') as HTMLInputElement;
    search.value = 'P-059';
    search.dispatchEvent(new Event('input'));
    await waitFor(() =>
      expect(all('.card__name').map((n) => n.textContent)).toEqual(['Product P-059']),
    );
  });

  it('a card shows the small photo; a tap opens the large one in a dialog', async () => {
    await mountWith(3);
    await waitFor(() => expect(all('.card')).toHaveLength(3));
    const img = document.body.querySelector('.card__img') as HTMLImageElement;
    expect(img.getAttribute('src')).toMatch(/\/thumb$/);
    expect(img.getAttribute('loading')).toBe('lazy');
    const photoButton = document.body.querySelector('button.card__photo') as HTMLButtonElement;
    expect(photoButton.getAttribute('aria-label')).toBe('Rasmni kattalashtirish: Product P-001');
    await click(photoButton);
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain('Product P-001');
    const large = dialog.querySelector('img.photo-view') as HTMLImageElement;
    expect(large.getAttribute('src')).toMatch(/\/large$/);
    expect(large.getAttribute('alt')).toBe('Product P-001');
  });

  it('a product without a photo has a placeholder that opens nothing', async () => {
    await mountWith(3);
    await waitFor(() => expect(all('.card')).toHaveLength(3));
    const second = all('.card')[1] as HTMLElement;
    expect(second.querySelector('img')).toBeNull();
    const placeholder = second.querySelector('.card__photo--none') as HTMLElement;
    expect(placeholder.tagName).toBe('DIV');
    expect(placeholder.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('catalog prices', () => {
  it('shows the sale price only: the deferred price appears in the cart', async () => {
    await mountWith(3);
    await waitFor(() => expect(document.querySelectorAll('.card__price').length).toBe(3));
    const text = document.querySelector('.card__price')?.textContent ?? '';
    expect(text).toContain('1 000');
    expect(document.body.textContent).not.toContain('2 222');
  });
});
