import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { servicesKey } from '@/app/services';
import { createTestServices } from '@/test-utils/create-test-services';
import VersionsPage from './VersionsPage.vue';

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
});

async function mountPage() {
  const { services } = createTestServices({ identityId: 'manager' });
  await services.currentUser.ensureLoaded();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/versions', component: VersionsPage },
      { path: '/prices', name: 'staff-prices', component: { render: () => h('p') } },
      { path: '/versions/:id', name: 'staff-price-version', component: { render: () => h('p') } },
    ],
  });
  await router.push('/versions');
  const wrapper = mount(defineComponent({ render: () => h(RouterView) }), {
    attachTo: document.body,
    global: { plugins: [router], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return { services };
}

describe('price versions list', () => {
  it('shows one linked row per version with number, status, date and item count', async () => {
    const { services } = await mountPage();
    const versions = (await services.pricingApi.listVersions()).items;
    const rows = Array.from(document.body.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(versions.length);
    expect(versions.length).toBeGreaterThan(0);
    const first = rows[0] as HTMLElement;
    expect(first.querySelectorAll('td')).toHaveLength(5);
    expect(first.querySelector('a.dt__link')?.getAttribute('href')).toMatch(/^\/versions\//);
    expect(first.textContent).toMatch(/v\d+/);
  });

  it('sorts by the version number when its header is pressed', async () => {
    await mountPage();
    const header = document.body.querySelector('thead th button') as HTMLButtonElement;
    header.click();
    await flushPromises();
    const numbers = Array.from(document.body.querySelectorAll('tbody tr td:first-child')).map((c) =>
      Number(c.textContent?.replace(/\D/g, '')),
    );
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });
});
