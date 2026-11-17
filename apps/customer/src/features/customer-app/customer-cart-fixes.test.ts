import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NetworkError } from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import {
  bodyText,
  confirmCartSubmission,
  click,
  findButton,
  mountCustomerApp,
  useCustomerTestLifecycle,
  type MountOptions,
} from '@/test-utils/customer-app';
import { waitFor } from '@core/test-utils/wait';
import { customerUz } from './messages/uz';

useCustomerTestLifecycle();

const productId = (code: string): string => fakeUuid(`customer-product:${code}`);
const query = <T extends Element>(selector: string): T | null =>
  document.body.querySelector<T>(selector);

type Backend = Parameters<NonNullable<MountOptions['decorate']>>[0];

/** A setItem that waits until the test lets it through. */
function holdSetItem() {
  const gate = { hold: false, release: (): void => undefined, started: false };
  const decorate = (backend: Backend): void => {
    const original = backend.cartApi.setItem;
    backend.cartApi.setItem = (...args) =>
      gate.hold
        ? new Promise((resolve, reject) => {
            gate.started = true;
            gate.release = () => original(...args).then(resolve, reject);
          })
        : original(...args);
  };
  return { gate, decorate };
}

async function cartWithTwo(decorate?: (backend: Backend) => void) {
  const mounted = await mountCustomerApp('fake-owner', '/cart', { decorate });
  await mounted.services.cart.setQuantity(productId('BASEUS-20W'), '2');
  await mounted.services.cart.setQuantity(productId('BOROFONE-BW05'), '1');
  await waitFor(() => expect(document.body.querySelectorAll('.line').length).toBe(2));
  return mounted;
}

describe('a line that disappears while its change is unsaved', () => {
  it('does not leave the order button disabled, and undo does not break it again', async () => {
    const { gate, decorate } = holdSetItem();
    const { services, backend } = await cartWithTwo(decorate);
    gate.hold = true;
    await click(query('.line button[aria-label^="Ko\'paytirish"]') as Element);
    await waitFor(() => expect(gate.started).toBe(true));
    expect(findButton(customerUz.cart.submit).disabled).toBe(true);

    // The server dropped the line (a refresh) while the request is still in flight.
    gate.hold = false;
    await backend.cartApi.removeItem(productId('BASEUS-20W'));
    await services.cart.load();
    await waitFor(() => expect(document.body.querySelectorAll('.line').length).toBe(1));
    await waitFor(() => expect(findButton(customerUz.cart.submit).disabled).toBe(false));
    expect(query('.summary__total--stale')).toBeNull();

    // The late answer puts the line back: a new control, no stale mark from the old one.
    gate.release();
    await waitFor(() => expect(document.body.querySelectorAll('.line').length).toBe(2));
    expect(findButton(customerUz.cart.submit).disabled).toBe(false);
  });
});

describe('removal while the product is busy', () => {
  it('is not announced or offered for undo when the store dropped it', async () => {
    const { gate, decorate } = holdSetItem();
    const { services } = await cartWithTwo(decorate);
    gate.hold = true;
    // Another path (not the stepper) has a change in flight for the product.
    void services.cart.setQuantity(productId('BOROFONE-BW05'), '3');
    await waitFor(() => expect(gate.started).toBe(true));
    // The second line (Borofone, quantity 1): minus asks for removal.
    const minus = document.body.querySelectorAll('.line')[1]?.querySelector('button');
    await click(minus as Element);
    expect(document.body.querySelectorAll('.line').length).toBe(2);
    expect(query('[role="status"]')?.textContent).not.toContain('olib tashlandi');
    expect(bodyText()).not.toContain(customerUz.cart.undo);
    gate.release();
  });
});

describe('while the order is being submitted', () => {
  it('steppers and Remove buttons are locked so the submit key cannot be forgotten mid-submit', async () => {
    let finish: () => void = () => undefined;
    await cartWithTwo((b) => {
      const original = b.ordersApi.submit;
      b.ordersApi.submit = (key, request) =>
        new Promise((resolve, reject) => {
          finish = () => original(key, request).then(resolve, reject);
        });
    });
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    const locked = [...document.body.querySelectorAll('.line button, .line input')];
    expect(locked.length).toBeGreaterThan(0);
    expect(locked.every((el) => (el as HTMLButtonElement | HTMLInputElement).disabled)).toBe(true);
    finish();
  });
});

describe('undo after a removal', () => {
  it('is withdrawn when the product is back in the cart with another quantity', async () => {
    const { services } = await cartWithTwo();
    await click(document.body.querySelector('.line .line__remove') as Element);
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.undo));
    await services.cart.setQuantity(productId('BASEUS-20W'), '5');
    await waitFor(() => expect(bodyText()).not.toContain(customerUz.cart.undo));
    expect(services.cart.quantityOf(productId('BASEUS-20W'))).toBe('5');
  });

  it('shows why a restore failed right in the undo bar, and keeps it for another try', async () => {
    let fail = false;
    await cartWithTwo((backend) => {
      const original = backend.cartApi.setItem;
      backend.cartApi.setItem = (...args) =>
        fail ? Promise.reject(new NetworkError()) : original(...args);
    });
    await click(document.body.querySelector('.line .line__remove') as Element);
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.undo));
    fail = true;
    await click(findButton(customerUz.cart.undo));
    await waitFor(() => expect(query('.undo [role="alert"]')).not.toBeNull());
    expect(query('.undo [role="alert"]')?.textContent?.length).toBeGreaterThan(0);
    expect(bodyText()).toContain(customerUz.cart.undo);
  });
});

describe('the recommended retail price (RRP) of a cart line', () => {
  const rrpOf = (code: string): Element | null => {
    const line = Array.from(document.body.querySelectorAll('.line')).find((el) =>
      el.textContent?.includes(code),
    );
    if (!line) throw new Error(`no cart line ${code}`);
    return line.querySelector('[data-testid="line-rrp"]');
  };
  const spaced = (el: Element | null | undefined): string =>
    (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

  it('is shown per piece with its label on a line that has one, and not at all on a line without', async () => {
    // Two pieces of the charger: the RRP stays the price of ONE piece.
    await cartWithTwo();
    const rrp = rrpOf('BASEUS-20W');
    expect(spaced(rrp?.querySelector('.line__rrp-full'))).toBe(
      "Tavsiya etilgan narx (RRP): 109 000 so'm / dona",
    );
    // The short form is for the eye only: a screen reader gets the full label once.
    const short = rrp?.querySelector('.line__rrp-short');
    expect(spaced(short)).toBe("RRP: 109 000 so'm / dona");
    expect(short?.getAttribute('aria-hidden')).toBe('true');
    expect(rrpOf('BOROFONE-BW05')).toBeNull();
  });

  it('is not part of the total: the summary is the sale prices alone', async () => {
    const mounted = await cartWithTwo();
    // 2 x 89 000 + 1 x 112 000; the 109 000 RRP is in no sum.
    expect(mounted.services.cart.cart.value?.totalAmount).toBe('290000.00');
    expect(mounted.services.cart.cart.value?.lines.map((line) => line.rrp)).toEqual([
      '109000.00',
      null,
    ]);
  });

  it('a line that cannot be ordered shows no RRP', async () => {
    await mountCustomerApp('fake-seller', '/cart', { seedProblemCart: true });
    await waitFor(() => expect(document.body.querySelector('.line--problem')).not.toBeNull());
    for (const line of document.body.querySelectorAll('.line--problem')) {
      expect(line.querySelector('[data-testid="line-rrp"]')).toBeNull();
    }
  });
});

describe('narrow phones (jsdom has no layout, so the source is checked)', () => {
  const cart = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../customer-cart/components/CartPage.vue'),
    'utf8',
  );

  it('at 360px and below the stepper and the line total stack instead of sharing a row', () => {
    expect(cart).toMatch(
      /@media \(max-width: 360px\) \{[\s\S]*grid-template-areas:\s*'info remove'\s*'stepper stepper'\s*'total total'/,
    );
  });

  it('the RRP is quieter than the paid price and uses its short label on a phone', () => {
    // Muted and regular weight: never the bold of the line total.
    expect(cart).toMatch(/\.line__rrp \{[^}]*color: var\(--t3\)/);
    expect(cart).not.toMatch(/\.line__rrp[^{]*\{[^}]*font-weight/);
    expect(cart).toMatch(/\.line__rrp \{[^}]*overflow-wrap: anywhere/);
    expect(cart).toMatch(
      /@media \(max-width: 479px\) \{[\s\S]*\.line__rrp-full \{[^}]*clip: rect\(0, 0, 0, 0\)[\s\S]*\.line__rrp-short \{\s*display: inline/,
    );
  });

  it('a long line total can wrap and the tablet total column is not a fixed 140px', () => {
    expect(cart).toMatch(/\.line__total \{[^}]*overflow-wrap: anywhere/);
    expect(cart).not.toMatch(/\.line__total \{[^}]*white-space: nowrap/);
    expect(cart).not.toContain('140px');
  });
});

describe('the sticky summary keeps its secondary messages to one expandable line', () => {
  it('a blocked cart shows ONE note element with a toggle, collapsed by default', async () => {
    await mountCustomerApp('fake-seller', '/cart', { seedProblemCart: true });
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.problem.INACTIVE));
    expect(document.body.querySelectorAll('.summary [role="alert"]').length).toBe(1);
    const note = query<HTMLElement>('.summary__notes-text') as HTMLElement;
    expect(note.textContent).toBe(customerUz.cart.blocked);
    const toggle = query<HTMLButtonElement>('.summary__more') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(note.id);
    expect(toggle.textContent).toContain(customerUz.cart.notesMore);
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(query('.summary__notes--open')).not.toBeNull();
    expect(toggle.textContent).toContain(customerUz.cart.notesLess);
  });

  it('a failed submit joins the same single line', async () => {
    await cartWithTwo((b) => {
      b.ordersApi.submit = () => Promise.reject(new NetworkError());
    });
    await click(findButton(customerUz.cart.submit));
    await confirmCartSubmission();
    await waitFor(() => expect(query('.summary__notes-text')).not.toBeNull());
    expect(document.body.querySelectorAll('.summary [role="alert"]').length).toBe(1);
  });

  it('is clamped to one line on phones and tablets only', () => {
    const cart = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../customer-cart/components/CartPage.vue'),
      'utf8',
    );
    expect(cart).toMatch(
      /@media \(max-width: 959px\) \{[\s\S]*\.summary__notes-text \{[^}]*text-overflow: ellipsis/,
    );
  });
});

describe('accessibility of the cart and the price list', () => {
  const live = (): HTMLElement => query('[role="status"][aria-live="polite"]') as HTMLElement;

  it('the live region says only what changed, in a node that is new each time', async () => {
    await cartWithTwo();
    expect(live().textContent?.trim()).toBe('');
    const plus = (): Element =>
      document.body.querySelectorAll('.line')[0]?.querySelectorAll('button')[1] as Element;
    await click(plus());
    await waitFor(() => expect(live().textContent).toContain('Baseus 20W'));
    // No running total in the announcement: it changes with every tap and would be read each time.
    expect(live().textContent).not.toMatch(/so'm/);
    const first = live().firstElementChild;
    await waitFor(() => expect(query('.line__total--stale')).toBeNull());
    await click(plus());
    await waitFor(() => expect(live().firstElementChild).not.toBe(first));
  });

  it('a rollback is announced in the live region too', async () => {
    let fail = false;
    await cartWithTwo((backend) => {
      const original = backend.cartApi.setItem;
      backend.cartApi.setItem = (...args) =>
        fail ? Promise.reject(new NetworkError()) : original(...args);
    });
    fail = true;
    await click(
      document.body.querySelectorAll('.line')[0]?.querySelectorAll('button')[1] as Element,
    );
    await waitFor(() => expect(live().textContent).toContain('Baseus 20W'));
    expect(live().textContent).toContain(customerUz.cart.updateFailed.replace('{name}: ', ''));
  });

  it('a restored line is announced', async () => {
    await cartWithTwo();
    await click(document.body.querySelector('.line .line__remove') as Element);
    await waitFor(() => expect(bodyText()).toContain(customerUz.cart.undo));
    await click(findButton(customerUz.cart.undo));
    await waitFor(() =>
      expect(live().textContent).toContain(
        customerUz.cart.restored.replace('{name}', 'Baseus 20W zaryadlovchi'),
      ),
    );
  });

  it('provisional totals carry a visible text cue, not only a faded colour', async () => {
    const { gate, decorate } = holdSetItem();
    await cartWithTwo(decorate);
    gate.hold = true;
    await click(
      document.body.querySelectorAll('.line')[0]?.querySelectorAll('button')[1] as Element,
    );
    expect(query('.line__total .line__updating')?.textContent).toBe(customerUz.cart.updating);
    expect(query('.summary__total .summary__updating')?.textContent).toBe(customerUz.cart.updating);
    await waitFor(() => expect(gate.started).toBe(true));
    gate.release();
    await waitFor(() => expect(query('.line__updating')).toBeNull());
  });

  it('lists keep their list semantics although CSS turns them into grids', async () => {
    await cartWithTwo();
    const list = query('ul.list') as HTMLElement;
    expect(list.getAttribute('role')).toBe('list');
    expect([...list.children].every((li) => li.getAttribute('role') === 'listitem')).toBe(true);
  });
});

describe('price list: reading order equals the visual order of a card', () => {
  it('a card reads photo, name, code and unit, price, action; the grid keeps list semantics', async () => {
    await mountCustomerApp('fake-owner', '/prices');
    await waitFor(() => expect(bodyText()).toContain('Baseus 20W'));
    const list = query('ul.grid') as HTMLElement;
    expect(list.getAttribute('role')).toBe('list');
    const card = query('.card') as HTMLElement;
    expect(card.getAttribute('role')).toBe('listitem');
    const order = [...card.children].map((child) =>
      [...child.classList].find((c) => /^card__(photo|name|meta|price|action)$/.test(c)),
    );
    expect(order).toEqual([
      'card__photo',
      'card__name',
      'card__meta',
      'card__price',
      'card__action',
    ]);
  });
});
