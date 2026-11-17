import { flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import {
  mountCustomerApp,
  useCustomerTestLifecycle,
  bodyText,
  click,
  findButton,
  seededOrderId,
} from '@/test-utils/customer-app';
import { waitFor } from '@core/test-utils/wait';
import { customerUz } from '@/features/customer-app/messages/uz';
import { ApiNotFoundError } from '@core/lib/api-errors';
useCustomerTestLifecycle();

describe('customer My Products', () => {
  it('groups received units by product and opens a separate product page with codes', async () => {
    const { wrapper, router } = await mountCustomerApp('fake-owner', '/my-products');
    await waitFor(() => expect(wrapper.findAll('.goods-group')).toHaveLength(1));
    expect(wrapper.find('.goods-group').text()).toContain('Baseus');
    expect(wrapper.find('.goods-group').text()).toContain('5 dona');
    expect(wrapper.findAll('nav.tabs a')).toHaveLength(5);
    expect(wrapper.find('nav.tabs').text()).not.toContain(customerUz.goods.title);
    expect(wrapper.find('details').exists()).toBe(false);
    await wrapper.get('.goods-group').trigger('click');
    await waitFor(() => expect(wrapper.findAll('.goods-unit')).toHaveLength(5));
    expect(router.currentRoute.value.name).toBe('customer-goods-product');
    expect(wrapper.find('.goods-codes').text()).toContain('BASEUS-20W');
  });
  it('keeps the profile entry when empty but hides the Orders entry', async () => {
    const { wrapper, router } = await mountCustomerApp('fake-owner', '/profile', {
      seedReceivedGoods: false,
    });
    expect(wrapper.find('.goods-profile-entry').exists()).toBe(true);
    await wrapper.get('.goods-profile-entry').trigger('click');
    await waitFor(() => expect(bodyText()).toContain(customerUz.goods.empty));
    await router.push('/orders');
    await flushPromises();
    expect(wrapper.find('.goods-shortcut').exists()).toBe(false);
  });
  it('shows the Orders shortcut independently of the current order search', async () => {
    const { wrapper } = await mountCustomerApp('fake-owner', '/orders');
    await waitFor(() => expect(wrapper.find('.goods-shortcut').exists()).toBe(true));
    await wrapper.get('input[type="search"]').setValue('nothing-matches');
    await waitFor(() => expect(bodyText()).toContain(customerUz.orders.emptyFiltered.title));
    expect(wrapper.find('.goods-shortcut').exists()).toBe(true);
  });
  it('distinguishes unmatched search from an empty received-goods history', async () => {
    const { wrapper, services } = await mountCustomerApp('fake-owner', '/my-products');
    const groups = await services.goodsApi.list();
    const first = groups.products[0];
    expect(first).toBeTruthy();
    if (!first) throw new Error('Missing fixture product');
    const product = await services.goodsApi.product(first.productId);
    const code = product.units[0]?.codes[0]?.value;
    expect(code).toBeTruthy();
    await wrapper.get('input[type="search"]').setValue(code);
    await waitFor(() => expect(wrapper.findAll('.goods-group')).toHaveLength(1));
    await wrapper.get('input[type="search"]').setValue('unknown-code');
    await waitFor(() => expect(bodyText()).toContain(customerUz.goods.notFound));
    expect(bodyText()).not.toContain(customerUz.goods.empty);
    await click(findButton(customerUz.goods.clear));
    await waitFor(() => expect(wrapper.findAll('.goods-group')).toHaveLength(1));
  });
  it("never finds another organization's unit or product in the fake adapter", async () => {
    const own = await mountCustomerApp('fake-owner', '/my-products');
    const group = (await own.services.goodsApi.list()).products[0];
    if (!group) throw new Error('Missing fixture product');
    const unit = (await own.services.goodsApi.product(group.productId)).units[0];
    if (!unit) throw new Error('Missing fixture unit');
    const other = await mountCustomerApp('fake-other-org', '/my-products');
    expect((await other.services.goodsApi.list({ search: unit.codes[0]?.value })).products).toEqual(
      [],
    );
    await expect(other.services.goodsApi.unit(group.productId, unit.id)).rejects.toBeInstanceOf(
      ApiNotFoundError,
    );
  });
  it('keeps multiple code slots under one physical unit and copies the complete code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const first = await mountCustomerApp('fake-owner', '/my-products');
    const group = (await first.services.goodsApi.list()).products[0];
    if (!group) throw new Error('Missing product');
    const second = await mountCustomerApp('fake-owner', '/my-products/' + group.productId, {
      decorate: (backend) => {
        const original = backend.goodsApi.product;
        backend.goodsApi.product = async (...args) => {
          const data = await original(...args);
          const unit = data.units[0];
          if (!unit) return data;
          return {
            ...data,
            units: [
              {
                ...unit,
                codes: [
                  { kind: 'IMEI', slot: 1, value: '001234567890123' },
                  { kind: 'IMEI', slot: 2, value: '001234567890124' },
                ],
              },
            ],
          };
        };
      },
    });
    await waitFor(() => expect(second.wrapper.findAll('.goods-unit')).toHaveLength(1));
    expect(second.wrapper.findAll('.goods-code')).toHaveLength(2);
    await second.wrapper.get('.goods-code button').trigger('click');
    expect(writeText).toHaveBeenCalledWith('001234567890123');
  });
  it('introduces My Products after the first receipt and acknowledges dismissal', async () => {
    const { services } = await mountCustomerApp('fake-owner', '/orders/' + seededOrderId(10488), {
      seedReceivedGoods: false,
    });
    await waitFor(() => expect(findButton(customerUz.order.receive)).toBeTruthy());
    await click(findButton(customerUz.order.receive));
    const confirm = [...document.querySelectorAll('.modal button')].find((b) =>
      b.textContent?.includes(customerUz.order.receive),
    );
    if (!confirm) throw new Error('No confirmation');
    await click(confirm);
    await waitFor(() => expect(bodyText()).toContain(customerUz.goods.discoveryTitle));
    await click(findButton(customerUz.goods.later));
    await flushPromises();
    expect((await services.goodsApi.summary()).discoveryPending).toBe(false);
    await services.goods.refresh();
    expect(document.querySelector('.customer-sheet')).toBeNull();
  });
  it('shows API errors with retry without falling back to fixture data', async () => {
    let fail = true;
    const { wrapper } = await mountCustomerApp('fake-owner', '/my-products', {
      decorate: (backend) => {
        const original = backend.goodsApi.list;
        backend.goodsApi.list = (query) =>
          fail ? Promise.reject(new Error('unavailable')) : original(query);
      },
    });
    await waitFor(() => expect(wrapper.find('[data-state="error"]').exists()).toBe(true));
    expect(wrapper.findAll('.goods-group')).toHaveLength(0);
    fail = false;
    await click(findButton('Qayta urinish'));
    await waitFor(() => expect(wrapper.findAll('.goods-group')).toHaveLength(1));
  });
});
