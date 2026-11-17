import { customerCredentialsRequestSchema } from '@iorder/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CustomerLogin from './components/CustomerLogin.vue';
import CustomerCredentials from './components/CustomerCredentials.vue';
import { customerServicesKey } from './services';
import { customerUz } from './messages/uz';
import { createCustomerAuthApi } from '@/features/customer-session/api/customer-auth-api';
import { readCustomerToken, setCustomerToken } from '@/features/customer-session/website-session';
import { readInitData, forgetInitData } from '@core/telegram/launch';
import { createHttpClient } from '@core/lib/http-client';

function services() {
  return {
    auth: {
      password: vi.fn().mockResolvedValue(undefined),
      telegram: vi.fn(),
      credentials: vi.fn().mockResolvedValue({ login: 'my.shop', canEdit: true }),
      setCredentials: vi.fn().mockResolvedValue({ login: 'my.shop' }),
      logout: vi.fn(),
    },
    session: { load: vi.fn(), signedOut: vi.fn() },
    cart: { clear: vi.fn() },
  };
}
afterEach(() => {
  setCustomerToken(null);
  forgetInitData();
  document.body.innerHTML = '';
});
describe('customer browser sign-in', () => {
  it('submits once, clears the password and loads the verified customer session', async () => {
    const deps = services();
    const wrapper = mount(CustomerLogin, {
      global: { provide: { [customerServicesKey as symbol]: deps } },
    });
    await wrapper.get('input[autocomplete="username"]').setValue('my.shop');
    await wrapper.get('input[type="password"]').setValue('secret');
    await wrapper.get('form').trigger('submit');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(deps.auth.password).toHaveBeenCalledTimes(1);
    expect(deps.auth.password).toHaveBeenCalledWith('my.shop', 'secret');
    expect(deps.session.load).toHaveBeenCalledOnce();
    expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe('');
    wrapper.unmount();
  });
  it('shows a generic refusal and keeps the form available for another attempt', async () => {
    const deps = services();
    deps.auth.password.mockRejectedValue(new Error('private internal detail'));
    const wrapper = mount(CustomerLogin, {
      global: { provide: { [customerServicesKey as symbol]: deps } },
    });
    await wrapper.get('input[name="username"]').setValue('my.shop');
    await wrapper.get('input[name="password"]').setValue('wrong');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe(customerUz.auth.failed);
    expect(wrapper.text()).not.toContain('private internal detail');
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });
  it('sends signed Telegram fields unchanged to the customer route and validates the returned token', async () => {
    const payload = { id: 12345, first_name: 'Aziza', auth_date: 1790000000, hash: 'a'.repeat(64) };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ token: 'b'.repeat(43) }), { status: 200 }));
    const http = createHttpClient({ baseUrl: '/api', fetchImpl });
    await createCustomerAuthApi(http, http).telegram(payload);
    const [url, options] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/customer/auth/telegram-widget');
    expect(JSON.parse(options?.body as string)).toEqual(payload);
    expect(readCustomerToken()).toBe('b'.repeat(43));
  });
  it('offers Telegram reauthentication instead of credential editing to password sessions', async () => {
    const deps = services();
    deps.auth.credentials.mockResolvedValue({ login: 'my.shop', canEdit: false });
    const wrapper = mount(CustomerCredentials, {
      global: { provide: { [customerServicesKey as symbol]: deps } },
    });
    await wrapper.get('[data-testid="credentials-toggle"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain(customerUz.auth.telegramRequired);
    expect(wrapper.find('form').exists()).toBe(false);
    wrapper.unmount();
  });
  it('stays closed and reads nothing until it is opened, and closing forgets the passwords', async () => {
    const deps = services();
    const wrapper = mount(CustomerCredentials, {
      global: { provide: { [customerServicesKey as symbol]: deps } },
    });
    await flushPromises();
    const toggle = wrapper.get('[data-testid="credentials-toggle"]');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('input').exists()).toBe(false);
    expect(deps.auth.credentials).not.toHaveBeenCalled();

    await toggle.trigger('click');
    await flushPromises();
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(wrapper.findAll('input')).toHaveLength(3);
    await wrapper.findAll('input[type="password"]')[0]?.setValue('customer secret password');

    await toggle.trigger('click');
    expect(wrapper.find('input').exists()).toBe(false);
    await toggle.trigger('click');
    await flushPromises();
    expect(deps.auth.credentials).toHaveBeenCalledTimes(1);
    expect((wrapper.findAll('input[type="password"]')[0]?.element as HTMLInputElement).value).toBe(
      '',
    );
    wrapper.unmount();
  });
  it('asks the browser for the same password minimum as the contract', async () => {
    const deps = services();
    const wrapper = mount(CustomerCredentials, {
      global: { provide: { [customerServicesKey as symbol]: deps } },
    });
    await wrapper.get('[data-testid="credentials-toggle"]').trigger('click');
    await flushPromises();
    const inputs = wrapper.findAll('input[type="password"]');
    const minimum = Number(inputs[0]?.attributes('minlength'));
    const accepts = (length: number): boolean =>
      customerCredentialsRequestSchema.safeParse({ login: 'my.shop', password: 'x'.repeat(length) })
        .success;
    expect(accepts(minimum)).toBe(true);
    expect(accepts(minimum - 1)).toBe(false);
    expect(inputs[1]?.attributes('minlength')).toBe(String(minimum));
    wrapper.unmount();
  });
  it('validates repeated passwords and clears both secrets after saving', async () => {
    const deps = services();
    const wrapper = mount(CustomerCredentials, {
      global: { provide: { [customerServicesKey as symbol]: deps } },
    });
    await wrapper.get('[data-testid="credentials-toggle"]').trigger('click');
    await flushPromises();
    const inputs = wrapper.findAll('input[type="password"]');
    await inputs[0]?.setValue('customer secret password');
    await inputs[1]?.setValue('different secret');
    await wrapper.get('form').trigger('submit');
    expect(deps.auth.setCredentials).not.toHaveBeenCalled();
    await inputs[1]?.setValue('customer secret password');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(deps.auth.setCredentials).toHaveBeenCalledWith({
      login: 'my.shop',
      password: 'customer secret password',
    });
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    expect(wrapper.text()).toContain(customerUz.auth.saved);
    wrapper.unmount();
  });
  // [C] 2026-11-09: the token survives a closed browser (localStorage); logout removes it.
  it('keeps a verified server token for the next visit and clears it on logout', async () => {
    const token = 'a'.repeat(43);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const http = createHttpClient({ baseUrl: '/api', fetchImpl });
    const api = createCustomerAuthApi(http, http);
    await api.password('my.shop', 'secret');
    expect(readCustomerToken()).toBe(token);
    expect(readInitData()).toBeNull();
    expect(window.localStorage.getItem('iorder.customer.session')).toBe(token);
    expect(window.sessionStorage.getItem('iorder.customer.session')).toBeNull();
    await api.logout();
    expect(readCustomerToken()).toBeNull();
    expect(window.localStorage.getItem('iorder.customer.session')).toBeNull();
  });
  it('drops the revoked website token after a Telegram-authenticated credential change', async () => {
    const token = 'a'.repeat(43);
    setCustomerToken(token);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ login: 'my.shop' }), { status: 200 }));
    const http = createHttpClient({ baseUrl: '/api', fetchImpl });
    await createCustomerAuthApi(http, http).setCredentials({
      login: 'my.shop',
      password: 'customer secret password',
    });
    expect(readCustomerToken()).toBeNull();
  });
});
