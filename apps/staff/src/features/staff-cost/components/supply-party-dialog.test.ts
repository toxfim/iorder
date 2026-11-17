import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { SetSupplyPartyResponse, SupplySummary } from '@iorder/shared/staff-cost';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { servicesKey, type Services } from '@/app/services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import { ApiConflictError, PermissionDeniedError } from '@core/lib/api-errors';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { createTestServices } from '@/test-utils/create-test-services';
import SupplyPartyDialog from './SupplyPartyDialog.vue';

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  dismissToast();
  vi.restoreAllMocks();
});

const row = (deliveryRef: string, partyNumber: string | null = null): SupplySummary => ({
  deliveryRef,
  productCount: 12,
  products: [{ productCode: '10482', names: [{ lang: 'UZ', name: 'Honor 14A' }] }],
  totalQuantity: '30.000',
  deliveredAt: '2026-10-16T05:00:00.000Z',
  partyNumber,
});
const SUPPLIES = [row('77343'), row('34343', '5'), row('20413')];

const done = (partyNumber: string, deliveryRefs: string[]): SetSupplyPartyResponse => ({
  outcome: 'CHANGED',
  partyNumber,
  changed: deliveryRefs.map((deliveryRef) => ({ deliveryRef, from: null, to: partyNumber })),
  alreadySet: [],
  removedFromParty: [],
});

async function open(
  options: {
    scenario?: FakeScenario;
    identity?: string;
    prepare?: (services: Services) => void;
  } = {},
) {
  const test = createTestServices({
    scenario: options.scenario ?? 'ready',
    identityId: options.identity ?? 'manager',
  });
  await test.services.currentUser.ensureLoaded();
  options.prepare?.(test.services);
  const shown = ref(true);
  const wrapper = mount(
    defineComponent({
      render: () =>
        h(SupplyPartyDialog, {
          modelValue: shown.value,
          'onUpdate:modelValue': (value: boolean) => {
            shown.value = value;
          },
        }),
    }),
    { attachTo: document.body, global: { provide: { [servicesKey as symbol]: test.services } } },
  );
  wrappers.push(wrapper);
  await flushPromises();
  return { ...test, shown };
}

function withSupplies(services: Services, supplies: readonly SupplySummary[] = SUPPLIES) {
  vi.spyOn(services.stockApi, 'listSupplies').mockImplementation(async (query = {}) => {
    const items = supplies.filter((s) => s.deliveryRef.includes(query.search ?? ''));
    return { items, total: items.length };
  });
}

const input = (): HTMLInputElement => {
  const el = document.body.querySelector<HTMLInputElement>('input[role="combobox"]');
  if (!el) throw new Error('no combobox');
  return el;
};
const key = async (name: string): Promise<void> => {
  input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  await flushPromises();
};
const options = (): string[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).map(
    (el) => el.dataset.ref ?? '',
  );
const activeOption = (): string | undefined =>
  document.body.querySelector<HTMLElement>('.option--active')?.dataset.ref;
const chosen = (): string[] =>
  Array.from(document.body.querySelectorAll('.row .option__ref')).map((el) => el.textContent ?? '');
const save = async (): Promise<void> => {
  document.body.querySelector<HTMLButtonElement>('[data-testid="party-save"]')?.click();
  await flushPromises();
};
const setParty = async (value: string): Promise<void> => {
  const field = Array.from(document.body.querySelectorAll<HTMLInputElement>('input')).find(
    (el) => el.getAttribute('role') !== 'combobox',
  );
  if (!field) throw new Error('no party field');
  field.value = value;
  field.dispatchEvent(new Event('input'));
  await flushPromises();
};
const conflict = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-testid="party-conflict"]');
const confirmButton = (): HTMLButtonElement => {
  const buttons = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('.modal__footer button'),
  );
  const last = buttons.at(-1);
  if (!last) throw new Error('no confirm button');
  return last;
};
const refused = (reason: string, details: unknown): ApiConflictError =>
  new ApiConflictError('x', 'CONFLICT', details, reason as never);

describe('the keys of the supply search', () => {
  it('moves with the arrows, picks with Enter, takes the last off with Backspace', async () => {
    const { services } = await open({ prepare: (s) => withSupplies(s) });
    input().focus();
    await flushPromises();
    expect(options()).toEqual(['77343', '34343', '20413']);
    expect(activeOption()).toBe('77343');
    await key('ArrowDown');
    expect(activeOption()).toBe('34343');
    await key('ArrowUp');
    await key('ArrowUp');
    expect(activeOption()).toBe('20413');
    await key('Enter');
    expect(chosen()).toEqual(['20413']);
    expect(options()).not.toContain('20413');
    await key('Enter');
    expect(chosen()).toEqual(['20413', '77343']);
    await key('Backspace');
    expect(chosen()).toEqual(['20413']);
    expect(services.stockApi.listSupplies).toHaveBeenCalled();
  });

  it('a row says what the supply is: count, first names, total, date, party', async () => {
    await open({ prepare: (s) => withSupplies(s) });
    input().focus();
    await flushPromises();
    const text = document.body.querySelector('[data-ref="34343"]')?.textContent ?? '';
    expect(text).toContain('12 ta tovar');
    expect(text).toContain('Honor 14A');
    expect(text).toContain('Partiya 5');
  });

  it('clears the whole choice', async () => {
    await open({ prepare: (s) => withSupplies(s) });
    input().focus();
    await flushPromises();
    await key('Enter');
    await key('Enter');
    document.body.querySelector<HTMLButtonElement>('[data-testid="party-clear"]')?.click();
    await flushPromises();
    expect(chosen()).toEqual([]);
  });

  it.each([
    ['denied', 'Partiyani faqat menejer biriktira oladi.'],
    ['empty', "Hozircha postavka yo'q: ular sheetdan keladi."],
  ] as const)('shows the %s state', async (scenario, message) => {
    await open({ scenario });
    input().focus();
    await flushPromises();
    expect(document.body.querySelector('.combo__popup')?.textContent).toContain(message);
  });

  it('shows a failed search with a retry that works', async () => {
    const listed = vi.fn().mockRejectedValueOnce(new Error('down'));
    listed.mockResolvedValue({ items: SUPPLIES, total: 3 });
    await open({
      prepare: (s) => {
        s.stockApi.listSupplies = listed;
      },
    });
    input().focus();
    await flushPromises();
    expect(document.body.querySelector('.combo__status--error')).not.toBeNull();
    document.body.querySelector<HTMLButtonElement>('.combo__status--error button')?.click();
    await flushPromises();
    expect(options()).toHaveLength(3);
  });
});

describe('saving', () => {
  async function chooseTwo(services: Services): Promise<void> {
    withSupplies(services);
    input().focus();
    await flushPromises();
    await key('Enter');
    await key('Enter');
  }

  it('asks for the supply and the number before sending anything', async () => {
    const { services } = await open({ prepare: (s) => withSupplies(s) });
    const sent = vi.spyOn(services.stockApi, 'setSupplyParty');
    await save();
    expect(sent).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Kamida bitta postavkani tanlang.');
    expect(document.body.textContent).toContain('Partiya raqamini kiriting.');
  });

  it('sends the chosen supplies with what the manager saw, then closes with a message', async () => {
    const { services, shown } = await open({ prepare: (s) => withSupplies(s) });
    const sent = vi
      .spyOn(services.stockApi, 'setSupplyParty')
      .mockResolvedValue(done('7', ['77343', '34343']));
    await chooseTwo(services);
    await setParty(' 7 ');
    await save();
    expect(sent).toHaveBeenCalledWith({
      deliveryRefs: ['77343', '34343'],
      partyNumber: '7',
      seenParties: [
        { deliveryRef: '77343', partyNumber: null },
        { deliveryRef: '34343', partyNumber: '5' },
      ],
    });
    expect(shown.value).toBe(false);
    expect(useToast().toast.value?.message).toContain('7');
  });

  it('(a) another party on a supply: asks, then sends REPLACE', async () => {
    const { services } = await open({ prepare: (s) => withSupplies(s) });
    const sent = vi
      .spyOn(services.stockApi, 'setSupplyParty')
      .mockRejectedValueOnce(
        refused('SUPPLY_PARTY_CONFLICT', {
          supplyConflicts: [{ deliveryRef: '34343', partyNumber: '5' }],
          partyMembers: [],
        }),
      )
      .mockResolvedValueOnce(done('7', ['34343']));
    await chooseTwo(services);
    await setParty('7');
    await save();
    expect(conflict()?.textContent).toContain('34343');
    expect(conflict()?.querySelector('input[type="radio"]')).toBeNull();
    confirmButton().click();
    await flushPromises();
    expect(sent.mock.lastCall?.[0]).toMatchObject({ onSupplyConflict: 'REPLACE' });
    expect(sent.mock.lastCall?.[0]).not.toHaveProperty('onPartyConflict');
  });

  it.each([
    ['ADD', 0],
    ['REPLACE_MEMBERS', 1],
  ] as const)('(b) a party on other supplies: the manager picks %s', async (answer, index) => {
    const { services } = await open({ prepare: (s) => withSupplies(s) });
    const sent = vi
      .spyOn(services.stockApi, 'setSupplyParty')
      .mockRejectedValueOnce(
        refused('SUPPLY_PARTY_CONFLICT', { supplyConflicts: [], partyMembers: ['20413'] }),
      )
      .mockResolvedValueOnce(done('7', ['77343']));
    await chooseTwo(services);
    await setParty('7');
    await save();
    const radios = conflict()?.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios).toHaveLength(2);
    radios?.[index]?.click();
    await flushPromises();
    confirmButton().click();
    await flushPromises();
    expect(sent.mock.lastCall?.[0]).toMatchObject({
      onPartyConflict: answer,
      seenPartyMembers: ['20413'],
    });
  });

  it('(c) both at once: one dialog answers both', async () => {
    const { services } = await open({ prepare: (s) => withSupplies(s) });
    const sent = vi
      .spyOn(services.stockApi, 'setSupplyParty')
      .mockRejectedValueOnce(
        refused('SUPPLY_PARTY_CONFLICT', {
          supplyConflicts: [{ deliveryRef: '34343', partyNumber: '5' }],
          partyMembers: ['20413'],
        }),
      )
      .mockResolvedValueOnce(done('7', ['34343']));
    await chooseTwo(services);
    await setParty('7');
    await save();
    confirmButton().click();
    await flushPromises();
    expect(sent.mock.lastCall?.[0]).toMatchObject({
      onSupplyConflict: 'REPLACE',
      onPartyConflict: 'ADD',
      seenPartyMembers: ['20413'],
    });
  });

  it('(d) the same party: says nothing changed', async () => {
    const { services, shown } = await open({ prepare: (s) => withSupplies(s) });
    vi.spyOn(services.stockApi, 'setSupplyParty').mockResolvedValue({
      outcome: 'NOTHING_TO_DO',
      partyNumber: '5',
      changed: [],
      alreadySet: ['34343'],
      removedFromParty: [],
    });
    await chooseTwo(services);
    await setParty('5');
    await save();
    expect(useToast().toast.value?.message).toContain("Hech narsa o'zgarmadi");
    expect(shown.value).toBe(false);
  });

  it('(e) a supply removed meanwhile leaves the choice and is named', async () => {
    const { services, shown } = await open({ prepare: (s) => withSupplies(s) });
    vi.spyOn(services.stockApi, 'setSupplyParty').mockRejectedValue(
      refused('SUPPLY_NOT_AVAILABLE', { deliveryRefs: ['77343'] }),
    );
    await chooseTwo(services);
    await setParty('7');
    await save();
    expect(chosen()).toEqual(['34343']);
    expect(document.body.querySelector('[data-testid="party-notice"]')?.textContent).toContain(
      '77343',
    );
    expect(shown.value).toBe(true);
  });

  it('(f) changed by another manager: shows it now, and the next save sends what it shows', async () => {
    const { services } = await open({ prepare: (s) => withSupplies(s) });
    const sent = vi.spyOn(services.stockApi, 'setSupplyParty').mockRejectedValueOnce(
      refused('SUPPLY_PARTY_CHANGED', {
        parties: [
          { deliveryRef: '77343', partyNumber: '9' },
          { deliveryRef: '34343', partyNumber: '5' },
        ],
        partyMembers: [],
      }),
    );
    sent.mockResolvedValueOnce(done('7', ['77343']));
    await chooseTwo(services);
    await setParty('7');
    await save();
    expect(document.body.querySelector('[data-testid="party-notice"]')).not.toBeNull();
    expect(document.body.querySelector('.chosen')?.textContent).toContain('Partiya 9');
    await save();
    expect(sent.mock.lastCall?.[0].seenParties).toContainEqual({
      deliveryRef: '77343',
      partyNumber: '9',
    });
  });

  it('a refused save says who may do it and keeps the choice', async () => {
    const { services, shown } = await open({ prepare: (s) => withSupplies(s) });
    vi.spyOn(services.stockApi, 'setSupplyParty').mockRejectedValue(new PermissionDeniedError());
    await chooseTwo(services);
    await setParty('7');
    await save();
    expect(document.body.querySelector('.party__failure')?.textContent).toContain('faqat menejer');
    expect(chosen()).toHaveLength(2);
    expect(shown.value).toBe(true);
  });
});
