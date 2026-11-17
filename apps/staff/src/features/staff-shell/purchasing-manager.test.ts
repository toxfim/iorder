import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { Component } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { servicesKey } from '@/app/services';
import ProductCategoriesPage from '@/features/catalog/components/ProductCategoriesPage.vue';
import ProductsPage from '@/features/catalog/components/ProductsPage.vue';
import BrandsPage from '@/features/staff-brands/components/BrandsPage.vue';
import { balancePermissions } from '@/features/staff-organizations/domain/organization-balance';
import { createTestServices } from '@/test-utils/create-test-services';
import { canManageOrganizations, canViewOrganizations } from './organizations-access';
import { navGroupsFor, ordersNavFor, visibleStaffPages } from './nav-config';
import { readsAllOrders, seesOrderMoney } from './orders-access';
import {
  canEditPrices,
  canManagePhotos,
  canRunSheetSync,
  canViewCost,
  canViewPriceAdmin,
} from './price-access';

const ROLE = ['PURCHASING_MANAGER'] as const;

describe('purchasing manager: what the staff app offers', () => {
  it('has every page of the sales manager, and the sales manager keeps them', () => {
    const pages = (roles: Parameters<typeof visibleStaffPages>[0]): string[] =>
      visibleStaffPages(roles).map((page) => page.key);
    expect(pages(ROLE)).toEqual(pages(['MANAGER']));
    expect(navGroupsFor(ROLE).length).toBeGreaterThan(0);
  });

  it('has the whole order list but no step of its own', () => {
    expect(ordersNavFor(ROLE).map((child) => child.key)).toEqual(['all']);
    expect(readsAllOrders(ROLE)).toBe(true);
    expect(seesOrderMoney(ROLE)).toBe(true);
  });

  it('reads, syncs, and changes nothing', () => {
    expect(canViewCost(ROLE)).toBe(true);
    expect(canViewPriceAdmin(ROLE)).toBe(true);
    expect(canViewOrganizations(ROLE)).toBe(true);
    expect(canRunSheetSync(ROLE)).toBe(true);
    expect(canEditPrices(ROLE)).toBe(false);
    expect(canManagePhotos(ROLE)).toBe(false);
    expect(canManageOrganizations(ROLE)).toBe(false);
    expect(balancePermissions(ROLE)).toEqual({ canView: true, canRecord: false, canFix: false });
  });

  describe('pages show the data without their write buttons', () => {
    let wrapper: VueWrapper | null = null;
    afterEach(() => {
      wrapper?.unmount();
      wrapper = null;
      document.body.innerHTML = '';
    });

    async function mountAs(identityId: string, component: Component): Promise<string> {
      const { services } = createTestServices({ identityId });
      await services.currentUser.ensureLoaded();
      wrapper = mount(component, {
        attachTo: document.body,
        global: {
          provide: { [servicesKey as symbol]: services },
          stubs: { RouterLink: { template: '<a><slot /></a>' } },
        },
      });
      await flushPromises();
      return document.body.textContent ?? '';
    }

    it.each([
      ['products', ProductsPage],
      ['categories', ProductCategoriesPage],
    ])('%s', async (_name, component) => {
      await mountAs('purchasing', component);
      const labels = Array.from(document.body.querySelectorAll('button')).map(
        (button) => button.getAttribute('aria-label') ?? button.textContent ?? '',
      );
      // Sorting and paging may stay; nothing that edits, archives or adds.
      expect(document.body.querySelectorAll('.actions')).toHaveLength(0);
      expect(document.body.querySelector('tbody .dt__row')).not.toBeNull();
      expect(labels.join('|')).not.toMatch(/Tahrir|qo'shish/i);
    });

    it('brands: the unbranded list without the brand picker', async () => {
      await mountAs('purchasing', BrandsPage);
      expect(document.body.querySelector('tbody .dt__row')).not.toBeNull();
      expect(document.body.querySelector('[role="combobox"]')).toBeNull();
    });
  });
});
