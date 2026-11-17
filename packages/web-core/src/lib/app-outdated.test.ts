import { PRICING_ROUTES, staffVersionResponseSchema } from '@iorder/shared';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StateView from '@core/components/ui/StateView.vue';
import { coreEn as en } from '@core/i18n/messages/en';
import { coreRu as ru } from '@core/i18n/messages/ru';
import { coreUz as uz } from '@core/i18n/messages/uz';
import { appOutdated, markAppOutdated, setPageReloader } from './app-outdated';
import { createHttpClient } from './http-client';

function clientAnswering(make: () => Response | Promise<Response>) {
  return createHttpClient({ baseUrl: '/api', fetchImpl: () => Promise.resolve(make()) });
}

async function listVersions(client: ReturnType<typeof clientAnswering>): Promise<void> {
  await client
    .request(PRICING_ROUTES.listVersions, staffVersionResponseSchema)
    .catch(() => undefined);
}

afterEach(() => {
  markAppOutdated(false);
  setPageReloader();
});

describe('appOutdated flag', () => {
  it('is set by a schema mismatch', async () => {
    await listVersions(clientAnswering(() => new Response('{"unexpected":1}', { status: 200 })));
    expect(appOutdated.value).toBe(true);
  });

  it('is cleared by a 5xx and by a network failure', async () => {
    markAppOutdated(true);
    await listVersions(clientAnswering(() => new Response(null, { status: 503 })));
    expect(appOutdated.value).toBe(false);

    markAppOutdated(true);
    await listVersions(
      createHttpClient({ baseUrl: '/api', fetchImpl: () => Promise.reject(new TypeError('x')) }),
    );
    expect(appOutdated.value).toBe(false);
  });
});

describe('StateView error copy', () => {
  it('keeps the connection text and the retry button for an ordinary error', () => {
    const wrapper = mount(StateView, { props: { state: 'error' } });
    expect(wrapper.text()).toContain(uz.state.error.description);
    expect(wrapper.text()).toContain(uz.state.retry);
    expect(wrapper.text()).not.toContain(uz.state.outdated.description);
  });

  it('shows the update text and a reload button after a schema mismatch', async () => {
    const reload = vi.fn();
    setPageReloader(reload);
    markAppOutdated(true);
    const wrapper = mount(StateView, { props: { state: 'error' } });
    expect(wrapper.text()).toContain(uz.state.outdated.description);
    expect(wrapper.text()).not.toContain(uz.state.error.description);
    await wrapper.get('button').trigger('click');
    expect(reload).toHaveBeenCalledOnce();
    expect(wrapper.emitted('retry')).toBeUndefined();
  });

  it('does not touch non-error states', () => {
    markAppOutdated(true);
    const wrapper = mount(StateView, { props: { state: 'empty' } });
    expect(wrapper.text()).toContain(uz.state.empty.title);
  });

  it('has the copy in every language', () => {
    expect(ru.state.outdated.description).not.toBe('');
    expect(en.state.outdated.description).not.toBe('');
  });
});
