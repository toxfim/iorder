// The test needs a host and a child page in one file.
/* eslint-disable vue/one-component-per-file */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { createI18nFor } from '@core/i18n';
import { useDocumentTitle, useDocumentTitleDetail } from './use-document-title';

// A page title of the app's own catalog, as an app passes it.
const titles = {
  uz: { page: { cart: 'Savat' } },
  ru: { page: { cart: 'Корзина' } },
  en: { page: { cart: 'Cart' } },
};

describe('useDocumentTitle', () => {
  it('follows the route title and the language', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/a', component: { render: () => null }, meta: { titleKey: 'page.cart' } },
        { path: '/b', component: { render: () => null } },
      ],
    });
    const i18n = createI18nFor(titles, 'UZ');
    mount(
      defineComponent({
        setup() {
          useDocumentTitle();
          return () => h('div');
        },
      }),
      { global: { plugins: [router, i18n] } },
    );

    await router.push('/a');
    await nextTick();
    expect(document.title).toBe('Savat · iOrder.uz');

    i18n.global.locale.value = 'en';
    await nextTick();
    expect(document.title).toBe('Cart · iOrder.uz');

    await router.push('/b');
    await nextTick();
    expect(document.title).toBe('iOrder.uz');
  });

  it('puts the name of the open page (an order number) in front, and takes it away again', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/a', component: { render: () => null }, meta: { titleKey: 'page.cart' } }],
    });
    const name = ref<string | null>(null);
    const Page = defineComponent({
      setup() {
        useDocumentTitleDetail(() => name.value);
        return () => h('div');
      },
    });
    const shown = ref(true);
    mount(
      defineComponent({
        setup() {
          useDocumentTitle();
          return () => (shown.value ? h(Page) : h('div'));
        },
      }),
      { global: { plugins: [router, createI18nFor(titles, 'UZ')] } },
    );
    await router.push('/a');
    await nextTick();
    expect(document.title).toBe('Savat · iOrder.uz');
    name.value = 'IO-10491';
    await nextTick();
    expect(document.title).toBe('IO-10491 · Savat · iOrder.uz');
    shown.value = false;
    await nextTick();
    await nextTick();
    expect(document.title).toBe('Savat · iOrder.uz');
  });
});
