import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import AppBackLink from '@core/components/ui/AppBackLink.vue';
import { startMiniApp } from './mini-app-bridge';
import { disableTelegramBackButton, enableTelegramBackButton } from './use-back-button';

type ProxyWindow = { TelegramWebviewProxy?: { postEvent: (a: string, b: string) => void } };
type ReceiverWindow = {
  Telegram?: { WebView?: { receiveEvent?: (type: string, data: string) => void } };
};

const pressBack = (): void =>
  (window as unknown as ReceiverWindow).Telegram?.WebView?.receiveEvent?.(
    'back_button_pressed',
    '',
  );

async function routerAt(path: string): Promise<Router> {
  const page = { render: () => null };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/orders', name: 'orders', component: page },
      { path: '/orders/:id', name: 'order', component: page },
    ],
  });
  await router.push(path);
  await router.isReady();
  return router;
}

describe('Telegram back button of a page with a back link', () => {
  let postEvent: Mock<(eventType: string, eventData: string) => void>;

  beforeEach(() => {
    postEvent = vi.fn<(eventType: string, eventData: string) => void>();
    (window as unknown as ProxyWindow).TelegramWebviewProxy = { postEvent };
    startMiniApp('8.0');
    postEvent.mockClear();
  });
  afterEach(() => {
    disableTelegramBackButton();
    delete (window as unknown as ProxyWindow).TelegramWebviewProxy;
  });

  const backButtonCalls = (): string[] =>
    postEvent.mock.calls
      .filter((call) => call[0] === 'web_app_setup_back_button')
      .map((call) => String(call[1]));

  it('is shown while the link is on screen, goes where the link goes, and is hidden after', async () => {
    enableTelegramBackButton();
    const router = await routerAt('/orders/7');
    const wrapper = mount(AppBackLink, {
      props: { to: { name: 'orders' } },
      slots: { default: 'Orders' },
      global: { plugins: [router] },
    });
    expect(backButtonCalls()).toEqual(['{"is_visible":true}']);

    pressBack();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('orders'));

    wrapper.unmount();
    expect(backButtonCalls()).toEqual(['{"is_visible":true}', '{"is_visible":false}']);
    // A press after the page left does nothing.
    await router.push('/orders/8');
    pressBack();
    expect(router.currentRoute.value.path).toBe('/orders/8');
  });

  it('tells the page it was used ("back"), from Telegram\'s button and from the link alike', async () => {
    enableTelegramBackButton();
    const router = await routerAt('/orders/7');
    const wrapper = mount(AppBackLink, {
      props: { to: { name: 'orders' } },
      slots: { default: 'Orders' },
      global: { plugins: [router] },
    });
    pressBack();
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('orders'));
    expect(wrapper.emitted('back')).toHaveLength(1);
    await router.push('/orders/7');
    await wrapper.get('a').trigger('click');
    expect(wrapper.emitted('back')).toHaveLength(2);
    wrapper.unmount();
  });

  it('does nothing in an app that did not opt in (outside Telegram, the customer app)', async () => {
    const router = await routerAt('/orders/7');
    mount(AppBackLink, {
      props: { to: { name: 'orders' } },
      slots: { default: 'Orders' },
      global: { plugins: [router] },
    });
    expect(backButtonCalls()).toEqual([]);
    pressBack();
    expect(router.currentRoute.value.path).toBe('/orders/7');
  });
});
