import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { RouterView, createMemoryHistory } from 'vue-router';
import { servicesKey } from '@/app/services';
import { createAppRouter } from '@/router';
import { TEST_NOW, createTestServices } from '@/test-utils/create-test-services';
import { preloadRouteComponents } from '@/test-utils/preload-routes';
import { dismissToast } from '@core/composables/use-toast';
import { ApiConflictError } from '@core/lib/api-errors';
import { waitFor } from '@core/test-utils/wait';
import { useNewOrderDraft } from './composables/new-order-draft';

// The manager's new order on a customer's behalf [C, owner 2026-11-20], through the real router
// and the fake staff api: the entry on the list, step 1 in a dialog, steps 2-4 on their page.
const wrappers: VueWrapper[] = [];

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: true }) as MediaQueryList,
  });
  useNewOrderDraft().reset();
});
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
  dismissToast();
});

const Shell = defineComponent({ render: () => h(RouterView) });

async function mountAt(identity: string, path: string, scenario?: 'error' | 'denied') {
  await preloadRouteComponents();
  const { services } = createTestServices({
    identityId: identity,
    scenario,
    clock: { now: () => TEST_NOW },
  });
  await services.currentUser.ensureLoaded();
  const router = createAppRouter(services.currentUser, createMemoryHistory());
  await router.push(path);
  const wrapper = mount(Shell, {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return { services, router };
}

const $ = (selector: string): HTMLElement | null => document.body.querySelector(selector);
const $$ = (selector: string): HTMLElement[] =>
  Array.from(document.body.querySelectorAll(selector));
const squash = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();
const testId = (id: string): string => `[data-testid="${id}"]`;

async function click(selector: string, index = 0): Promise<void> {
  await waitFor(() => expect($$(selector)[index]).toBeDefined());
  $$(selector)[index]?.click();
  await flushPromises();
}

/** Step 1: a group, its second member (Orion Mobile: Dilnoza Rahimova). */
async function chooseGroupMember(): Promise<void> {
  await click(testId('new-order-open'));
  await click(testId('type-GROUP'));
  await waitFor(() => expect($$(testId('customer-option')).length).toBeGreaterThan(2));
  const ideal = $$(testId('customer-option')).findIndex((el) =>
    squash(el.textContent).includes('Orion Mobile'),
  );
  await click(testId('customer-option'), ideal);
  await click(testId('member-option'), 1);
  expect(squash($(testId('chosen-customer'))?.textContent)).toContain('Dilnoza Rahimova');
  await click(testId('new-order-customer-next'));
}

describe("the manager's new order", () => {
  it('only the manager gets «+ Yangi buyurtma»', async () => {
    await mountAt('manager', '/staff/orders');
    await waitFor(() => expect($(testId('new-order-open'))).not.toBeNull());
    for (const w of wrappers.splice(0)) w.unmount();
    await mountAt('admin', '/staff/orders');
    await waitFor(() => expect($('.head__title')).not.toBeNull());
    expect($(testId('new-order-open'))).toBeNull();
  });

  it('step 1: nothing goes on before a member is chosen; a group asks for its member', async () => {
    await mountAt('manager', '/staff/orders');
    await click(testId('new-order-open'));
    const next = $(testId('new-order-customer-next')) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await click(testId('type-GROUP'));
    await waitFor(() => expect($$(testId('customer-option')).length).toBeGreaterThan(0));
    await click(testId('customer-option'));
    expect((($(testId('new-order-customer-next')) as HTMLButtonElement) ?? next).disabled).toBe(
      true,
    );
    await click(testId('member-option'));
    expect(($(testId('new-order-customer-next')) as HTMLButtonElement).disabled).toBe(false);
  });

  it('step 1: the quick search finds an individual by name and goes straight to the products', async () => {
    const { router } = await mountAt('manager', '/staff/orders');
    await click(testId('new-order-open'));
    const input = $(testId('new-order-quick-search')) as HTMLInputElement;
    input.value = 'Madina';
    input.dispatchEvent(new Event('input'));
    await waitFor(() => expect($$(testId('quick-result')).length).toBe(1));
    expect(squash($(testId('quick-result'))?.textContent)).toContain('Yakka shaxs');
    await click(testId('quick-result'));
    await waitFor(() => expect(router.currentRoute.value.name).toBe('staff-new-order'));
    expect(useNewOrderDraft().customer.value?.name).toBe('Madina Ergasheva');
  });

  it('goes through the four steps and creates a SUBMITTED order for the member', async () => {
    const { router, services } = await mountAt('manager', '/staff/orders');
    await chooseGroupMember();
    await waitFor(() => expect($(testId('new-order-page'))).not.toBeNull());
    await waitFor(() => expect($$(testId('new-order-product')).length).toBeGreaterThan(3));
    // Partner prices (Orion Mobile is a partner in the fake) and the tier named on the page.
    expect(squash($(testId('new-order-catalog-summary'))?.textContent)).toContain(
      'Ulgurji / Hamkor',
    );
    const next = (): HTMLButtonElement => $(testId('new-order-items-next')) as HTMLButtonElement;
    expect(next().disabled).toBe(true);
    await click(testId('new-order-add'));
    await click(testId('new-order-add'));
    expect($$(testId('cart-line'))).toHaveLength(2);
    await click(testId('new-order-items-next'));

    // Step 3: no plan yet, «Keyingi» stays and says why.
    await waitFor(() => expect($(testId('new-order-plan'))).not.toBeNull());
    await click(testId('new-order-details-next'));
    expect(squash($(testId('new-order-plan'))?.textContent)).toContain(
      "Davom etish uchun to'lov turini tanlang",
    );
    expect($(testId('new-order-confirm-plan'))).toBeNull();
    await click(testId('plan-FULL'));
    const comment = $(testId('new-order-comment')) as HTMLInputElement;
    comment.value = 'Ertaga ertalab';
    comment.dispatchEvent(new Event('input'));
    await click(testId('new-order-details-next'));

    // Step 4: read only, then create.
    expect(squash($(testId('new-order-confirm-plan'))?.textContent)).toBe("Bittada to'lash");
    expect($$(testId('confirm-line'))).toHaveLength(2);
    await click(testId('new-order-create'));
    await waitFor(() => expect(router.currentRoute.value.name).toBe('staff-orders'));
    expect(router.currentRoute.value.query).toEqual({ stage: 'SUBMITTED' });
    const list = await services.ordersApi.listOrders({ status: 'SUBMITTED' });
    const created = list.orders[0];
    if (!created || created.detail !== 'FULL') throw new Error('expected the new order first');
    expect(created).toMatchObject({
      organizationName: 'Orion Mobile',
      paymentPlan: 'FULL',
      customerComment: 'Ertaga ertalab',
      placedBy: { fullName: 'Dilnoza Rahimova' },
    });
    // The draft starts over.
    expect(useNewOrderDraft().customer.value).toBeNull();
  });

  it('warns above the free stock and still lets the manager go on [P]', async () => {
    await mountAt('manager', '/staff/orders');
    await chooseGroupMember();
    await waitFor(() => expect($$(testId('new-order-product')).length).toBeGreaterThan(3));
    const low = $$(testId('new-order-product')).findIndex((el) =>
      squash(el.querySelector(testId('new-order-stock'))?.textContent).startsWith('7 '),
    );
    expect(low).toBeGreaterThanOrEqual(0);
    $$(testId('new-order-product'))
      [low]?.querySelector<HTMLElement>(testId('new-order-add'))
      ?.click();
    await flushPromises();
    for (let i = 0; i < 8; i++) {
      $$(testId('new-order-product'))[low]?.querySelector<HTMLElement>(testId('qty-more'))?.click();
      await flushPromises();
    }
    expect(squash($(testId('new-order-cart'))?.textContent)).toContain('Omborda atigi 7 dona');
    expect(($(testId('new-order-items-next')) as HTMLButtonElement).disabled).toBe(false);
  });

  it('"O\'zgartirish" goes back to step 1 and keeps the cart; «Bekor qilish» drops everything', async () => {
    const { router } = await mountAt('manager', '/staff/orders');
    await chooseGroupMember();
    await waitFor(() => expect($$(testId('new-order-add')).length).toBeGreaterThan(0));
    await click(testId('new-order-add'));
    await click(testId('new-order-change-customer'));
    await waitFor(() => expect($(testId('new-order-customer-dialog'))).not.toBeNull());
    expect(useNewOrderDraft().lines.value).toHaveLength(1);
    await click(testId('new-order-customer-next'));
    await waitFor(() => expect(router.currentRoute.value.name).toBe('staff-new-order'));
    await click(testId('new-order-cancel'));
    await waitFor(() => expect(router.currentRoute.value.name).toBe('staff-orders'));
    expect(useNewOrderDraft().lines.value).toHaveLength(0);
  });

  it('the page without a chosen customer opens step 1 instead', async () => {
    const { router } = await mountAt('manager', '/staff/orders/new');
    await waitFor(() => expect(router.currentRoute.value.name).toBe('staff-orders'));
    await waitFor(() => expect($(testId('new-order-customer-dialog'))).not.toBeNull());
  });

  it.each(['denied', 'error'] as const)('shows the %s state of the catalog', async (scenario) => {
    const person = { userId: 'u', fullName: 'X', phone: null };
    useNewOrderDraft().choose(
      { organizationId: 'x', name: 'X', type: 'PERSON', label: 'STANDARD', members: [person] },
      person,
    );
    const { router } = await mountAt('manager', '/staff/orders/new', scenario);
    expect(router.currentRoute.value.name).toBe('staff-new-order');
    await waitFor(() => expect($(`[data-state="${scenario}"]`)).not.toBeNull());
  });
});

describe('the new order after review (2026-11-20)', () => {
  /** Steps 1-3 with one product and the plan FULL, up to step 4. */
  async function toConfirm(): Promise<void> {
    await chooseGroupMember();
    await waitFor(() => expect($$(testId('new-order-add')).length).toBeGreaterThan(0));
    await click(testId('new-order-add'));
    await click(testId('new-order-items-next'));
    await click(testId('plan-FULL'));
    await click(testId('new-order-details-next'));
    await waitFor(() => expect($(testId('new-order-create'))).not.toBeNull());
  }

  it('step 1 heads the two types with «Mijoz turi» in the accent colour', async () => {
    await mountAt('manager', '/staff/orders');
    await click(testId('new-order-open'));
    expect($(testId('new-order-type-heading'))?.classList.contains('crumb--title')).toBe(true);
  });

  it('says under «Izoh» that the customer sees it too', async () => {
    await mountAt('manager', '/staff/orders');
    await chooseGroupMember();
    await waitFor(() => expect($$(testId('new-order-add')).length).toBeGreaterThan(0));
    await click(testId('new-order-add'));
    await click(testId('new-order-items-next'));
    const comment = $(testId('new-order-comment'));
    const hint = $(testId('new-order-comment-hint'));
    expect(squash(hint?.textContent)).toBe("Mijoz ham ko'radi");
    expect(comment?.getAttribute('aria-describedby')).toBe(hint?.id);
  });

  it('step 2 leaves out a product with no free stock; one without a figure stays', async () => {
    const { services } = await mountAt('manager', '/staff/orders');
    const real = services.ordersApi.getNewOrderCatalog;
    services.ordersApi.getNewOrderCatalog = async (organizationId) => {
      const answer = await real(organizationId);
      const [first, second] = answer.items;
      if (!first || !second) throw new Error('expected products');
      return {
        ...answer,
        items: [
          { ...first, name: 'Held entirely', stock: 0 },
          { ...second, name: 'Brought on order', stock: null },
        ],
      };
    };
    await chooseGroupMember();
    await waitFor(() => expect($$(testId('new-order-product')).length).toBe(1));
    expect(squash($(testId('new-order-product'))?.textContent)).toContain('Brought on order');
  });

  it('a refused customer sends the manager back to step 1 with the reason; the cart stays', async () => {
    const { services, router } = await mountAt('manager', '/staff/orders');
    services.ordersApi.createOrder = () =>
      Promise.reject(new ApiConflictError('refused', 'CONFLICT', undefined, 'PLACER_NOT_MEMBER'));
    await toConfirm();
    await click(testId('new-order-create'));
    await waitFor(() => expect(router.currentRoute.value.name).toBe('staff-orders'));
    await waitFor(() => expect($(testId('new-order-notice'))).not.toBeNull());
    expect(squash($(testId('new-order-notice'))?.textContent)).toContain("a'zosi emas");
    expect(useNewOrderDraft().customer.value).toBeNull();
    expect(useNewOrderDraft().lines.value).toHaveLength(1);
  });

  it('a moved total reads the catalog again and stays on step 4 with the reason', async () => {
    const { services } = await mountAt('manager', '/staff/orders');
    let reads = 0;
    const real = services.ordersApi.getNewOrderCatalog;
    services.ordersApi.getNewOrderCatalog = (organizationId) => {
      reads += 1;
      return real(organizationId);
    };
    services.ordersApi.createOrder = () =>
      Promise.reject(new ApiConflictError('moved', 'CONFLICT', undefined, 'CART_TOTAL_CHANGED'));
    await toConfirm();
    const before = reads;
    const key = useNewOrderDraft().idempotencyKey.value;
    await click(testId('new-order-create'));
    await waitFor(() => expect(reads).toBe(before + 1));
    await waitFor(() => expect($(testId('new-order-create'))).not.toBeNull());
    expect(squash($('.confirm .err')?.textContent)).not.toBe('');
    // Nothing in the order changed: a retry is the same order and keeps its key.
    expect(useNewOrderDraft().idempotencyKey.value).toBe(key);
  });

  it('a plan that a reload made impossible goes back to step 3 with the plan error', async () => {
    const { services } = await mountAt('manager', '/staff/orders');
    let refused = false;
    const real = services.ordersApi.getNewOrderCatalog;
    services.ordersApi.getNewOrderCatalog = async (organizationId) => {
      const answer = await real(organizationId);
      return refused
        ? { ...answer, items: answer.items.map((i) => ({ ...i, deferredUnitPrice: null })) }
        : answer;
    };
    services.ordersApi.createOrder = () => {
      refused = true;
      return Promise.reject(
        new ApiConflictError('gone', 'CONFLICT', undefined, 'DEFERRED_PRICE_UNAVAILABLE'),
      );
    };
    await chooseGroupMember();
    await waitFor(() => expect($$(testId('new-order-add')).length).toBeGreaterThan(0));
    await click(testId('new-order-add'));
    await click(testId('new-order-items-next'));
    await click(testId('plan-DEFERRED'));
    await click(testId('new-order-details-next'));
    await click(testId('new-order-create'));
    await waitFor(() => expect($(testId('new-order-plan'))).not.toBeNull());
    expect(squash($(testId('new-order-plan'))?.textContent)).toContain(
      "Davom etish uchun to'lov turini tanlang",
    );
  });

  it('a refused customer-independent error (no answer) keeps step 4 and the key for a retry', async () => {
    const { services } = await mountAt('manager', '/staff/orders');
    let reads = 0;
    const real = services.ordersApi.getNewOrderCatalog;
    services.ordersApi.getNewOrderCatalog = (organizationId) => {
      reads += 1;
      return real(organizationId);
    };
    services.ordersApi.createOrder = () => Promise.reject(new Error('lost'));
    await toConfirm();
    const before = reads;
    const key = useNewOrderDraft().idempotencyKey.value;
    await click(testId('new-order-create'));
    await waitFor(() => expect($('.confirm .err')).not.toBeNull());
    expect(reads).toBe(before);
    expect(useNewOrderDraft().idempotencyKey.value).toBe(key);
  });
});
