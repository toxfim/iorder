<script setup lang="ts">
import type { SetOwnContactRequest } from '@iorder/shared';
import { computed, onMounted, reactive, ref, useId, watch, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { hapticSuccess } from '@core/telegram/mini-app-bridge';
import AppButton from '@core/components/ui/AppButton.vue';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import StateView, { type StateViewState } from '@core/components/ui/StateView.vue';
import { useCustomerServices } from '@/features/customer-app/services';
import { useErrorMessage } from '@/features/customer-app/composables/use-error-message';
import {
  cartFingerprint,
  currentSubmitKey,
  forgetSubmitKey,
  outcomeIsUnknown,
} from '@/features/customer-orders/composables/submit-key';
import { useFormat } from '@core/i18n/use-format';
import ContactDialog from '@/features/customer-session/components/ContactDialog.vue';
import {
  useContactFailure,
  type ContactFailure,
} from '@/features/customer-session/composables/contact-failure';
import { ApiConflictError, PermissionDeniedError } from '@core/lib/api-errors';
import { useCartActions } from '../composables/use-cart-actions';
import { linePrices, namesWithoutDeferredPrice, planTotal } from '../domain/payment-plan';
import PaymentPlanChoice from './PaymentPlanChoice.vue';
import QuantityStepper from './QuantityStepper.vue';
import RemovalUndo from './RemovalUndo.vue';

const { t } = useI18n();
const router = useRouter();
const { cart, ordersApi, session } = useCustomerServices();
const { formatMoneyWithCurrency, formatNumber, formatUnit } = useFormat();
const actions = useCartActions();
const describe = useErrorMessage();
const describeContactFailure = useContactFailure();

onMounted(() => void cart.load());

const view = computed<StateViewState>(() => {
  const current = cart.cart.value;
  if (current === null) {
    if (cart.loadState.value === 'error') {
      return cart.loadError.value instanceof PermissionDeniedError ? 'denied' : 'error';
    }
    return 'loading';
  }
  return current.lines.length === 0 ? 'empty' : 'ready';
});

const lines = computed(() => cart.cart.value?.lines ?? []);
const confirmationRevision = computed(() =>
  JSON.stringify({ cart: cart.cart.value, plan: cart.paymentPlan.value }),
);
// Two kinds of blocking line, each with its own way out: a product that cannot be ordered is
// removed, a quantity above the stock is lowered.
const hasOverStock = computed(() => lines.value.some((line) => line.problem === 'STOCK_EXCEEDED'));
const hasUnorderable = computed(() =>
  lines.value.some((line) => line.problem !== null && line.problem !== 'STOCK_EXCEEDED'),
);
type Line = (typeof lines.value)[number];
/**
 * The line can be changed: it has no problem, or only its quantity is above the stock and there is
 * still something to lower it to. Out of stock (a figure of 0) leaves one move: removing the line.
 */
const isAdjustable = (line: Line): boolean =>
  line.problem === null ||
  (line.problem === 'STOCK_EXCEEDED' && line.orderableStock !== null && line.orderableStock > 0);
const isGone = (line: Line): boolean =>
  line.problem === 'STOCK_EXCEEDED' && line.orderableStock === 0;
const stockParams = (line: Line): { count: string; unit: string } => ({
  count: formatNumber(String(line.orderableStock ?? 0)),
  unit: formatUnit(line.unit),
});
const plan = computed(() => cart.paymentPlan.value);
// Null: no plan chosen yet, or the chosen plan has no total right now. Never a figure of another plan.
const shownTotal = computed(() =>
  cart.cart.value === null ? null : planTotal(cart.cart.value, plan.value),
);
const planTotals = computed(() => ({
  FULL: cart.cart.value?.totalAmount ?? null,
  DEFERRED: cart.cart.value?.deferredTotalAmount ?? null,
}));
const planReason = computed(() => {
  const names = namesWithoutDeferredPrice(lines.value);
  return names.length > 0
    ? t('customer.cart.plan.noDeferredPrice', { names: names.join(', ') })
    : null;
});
const pricesOf = (line: (typeof lines.value)[number]) => linePrices(line, plan.value);

// Lines whose shown quantity is ahead of the saved one: their saved total is dimmed meanwhile, and
// the order cannot be placed until the cart and the screen agree.
const unsaved = reactive(new Set<string>());
const settling = computed(() => unsaved.size > 0);
// A field holding text that is not a quantity: the total on screen is not what the person sees
// typed, so the order waits until it is corrected.
const invalidLines = reactive(new Set<string>());
function markInvalid(productId: string, value: boolean): void {
  if (value) invalidLines.add(productId);
  else invalidLines.delete(productId);
}
// A line that left the cart (refresh, another tab) can no longer report "saved": forget its mark.
watch(
  lines,
  (current) => {
    const present = new Set(current.map((line) => line.productId));
    for (const id of [...unsaved]) if (!present.has(id)) unsaved.delete(id);
  },
  { flush: 'sync' },
);
function markUnsaved(productId: string, value: boolean): void {
  if (value) unsaved.add(productId);
  else unsaved.delete(productId);
}

const commitFor =
  (productId: string, name: string) =>
  (quantity: string | null): Promise<boolean> =>
    quantity === null
      ? actions.remove(productId, name)
      : actions.setQuantity(productId, name, quantity);

/** One tap on a line above the stock: the quantity becomes what can be ordered now. */
function setToStock(line: Line): void {
  if (line.orderableStock === null) return;
  void actions.setQuantity(line.productId, line.name, String(line.orderableStock));
}

const submitting = ref(false);
const submitError = ref<string | null>(null);
// Blocked cart and a failed submit share ONE line in the summary: the sticky card must stay small
// on a phone. The text is clamped by CSS, so a screen reader still reads all of it.
const notesId = useId();
const orderingOffId = useId();
const notesOpen = ref(false);
// "The price changed" is true only for the cart it was said about: any later change drops it.
const totalChanged = shallowRef<{ text: string; revision: string } | null>(null);
const notes = computed(() =>
  [
    submitError.value,
    totalChanged.value?.revision === confirmationRevision.value ? totalChanged.value.text : null,
    cart.planWasReset.value ? t('customer.cart.plan.reset') : null,
    hasUnorderable.value ? t('customer.cart.blocked') : null,
    hasOverStock.value ? t('customer.cart.stockBlocked') : null,
  ].filter((note): note is string => note !== null),
);
// A company employee viewing the app can order only where the server says so; the server refuses
// the order anyway (STAFF_ORDERING_DISABLED), this only keeps the button honest.
const orderingOff = computed(() => session.staffViewer.value?.canOrder === false);
const canSubmit = computed(
  () =>
    !orderingOff.value &&
    cart.cart.value?.canSubmit === true &&
    shownTotal.value !== null &&
    !settling.value &&
    invalidLines.size === 0,
);
// Nothing is preselected (owner rule 2026-10-30), so the first thing the order button does is
// send the person to the choice. An employee who may not order is not asked: choosing would not
// help them.
const needsPlan = computed(
  () => !orderingOff.value && cart.cart.value !== null && plan.value === null,
);
const planChoice = ref<InstanceType<typeof PaymentPlanChoice> | null>(null);
// How many times the button sent the person to the choice; the choice keeps a ring while it is
// above zero and replays a short emphasis on every new press.
const planAttention = ref(0);
watch(plan, (chosen) => {
  if (chosen !== null) planAttention.value = 0;
});

function askForPlan(): void {
  planAttention.value += 1;
  planChoice.value?.focusChoice();
}

/** The one button of the summary: first the plan, then the order. */
function onOrderButton(): void {
  if (needsPlan.value) askForPlan();
  else requestConfirmation();
}

const confirmationOpen = ref(false);
const confirmedRevision = ref('');

function requestConfirmation(): void {
  if (!canSubmit.value || submitting.value || contactBusy.value || !cart.cart.value) return;
  confirmedRevision.value = confirmationRevision.value;
  confirmationOpen.value = true;
}

async function confirmSubmission(): Promise<void> {
  if (!confirmationOpen.value || !canSubmit.value || !cart.cart.value) return;
  confirmationOpen.value = false;
  if (confirmationRevision.value !== confirmedRevision.value) return;
  await submit();
}

// Never submit a cart different from the one shown when the confirmation was opened.
watch(confirmationRevision, () => {
  confirmationOpen.value = false;
});

// The first order asks for the customer's name and phone (once; they change it later in the
// profile); the order continues by itself right after they are saved. A stale client that thinks
// the contact is set learns the truth from the server (CONTACT_REQUIRED) and opens the same dialog.
const contactOpen = ref(false);
const contactBusy = ref(false);
const contactFailure = shallowRef<ContactFailure | null>(null);

function openContact(): void {
  contactFailure.value = null;
  contactOpen.value = true;
}

async function saveContact(request: SetOwnContactRequest): Promise<void> {
  if (contactBusy.value || submitting.value) return;
  contactBusy.value = true;
  contactFailure.value = null;
  try {
    await session.setContact(request);
  } catch (caught) {
    contactFailure.value = describeContactFailure(caught);
    return;
  } finally {
    contactBusy.value = false;
  }
  contactOpen.value = false;
  if (confirmationRevision.value !== confirmedRevision.value) {
    requestConfirmation();
    return;
  }
  await placeOrder();
}

async function submit(): Promise<void> {
  if (submitting.value || contactBusy.value) return;
  if (session.needsContact.value) {
    openContact();
    return;
  }
  await placeOrder();
}

async function placeOrder(): Promise<void> {
  // One tap is one request: a second tap while the first is running does nothing.
  const paymentPlan = plan.value;
  const expectedTotalAmount = shownTotal.value;
  if (submitting.value || !canSubmit.value || cart.cart.value === null) return;
  if (paymentPlan === null || expectedTotalAmount === null) return;
  const fingerprint = cartFingerprint(cart.cart.value.lines, paymentPlan);
  submitting.value = true;
  submitError.value = null;
  totalChanged.value = null;
  try {
    const order = await ordersApi.submit(currentSubmitKey(fingerprint), {
      paymentPlan,
      expectedTotalAmount,
    });
    forgetSubmitKey();
    cart.clear();
    hapticSuccess();
    await router.push({ name: 'customer-placed', params: { id: order.id } });
  } catch (caught) {
    if (caught instanceof ApiConflictError && caught.reason === 'CONTACT_REQUIRED') {
      // A definite refusal (nothing was created): ask for the contact, keep the cart as it is.
      forgetSubmitKey();
      openContact();
      return;
    }
    if (caught instanceof ApiConflictError && caught.reason === 'CART_TOTAL_CHANGED') {
      // No order was made. Show the new totals first, then say why, tied to what is now on screen.
      forgetSubmitKey();
      await cart.load();
      totalChanged.value = { text: describe(caught), revision: confirmationRevision.value };
      return;
    }
    if (caught instanceof ApiConflictError && caught.reason === 'STOCK_LIMIT_EXCEEDED') {
      // No order was made: the stock fell after the cart was shown. The fresh cart marks the lines
      // and offers the fix; the sentence is only for when that cart could not be read.
      forgetSubmitKey();
      await cart.load();
      if (!hasOverStock.value) submitError.value = describe(caught);
      return;
    }
    // Keep the key only when the outcome is unknown: the retry then returns the same order.
    const unknown = outcomeIsUnknown(caught);
    if (!unknown) forgetSubmitKey();
    submitError.value = unknown
      ? `${describe(caught)} ${t('customer.cart.retrySafe')}`
      : describe(caught);
    // A refusal usually means the cart changed on the server: show the current one.
    if (!unknown) void cart.load();
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="cart">
    <header class="head">
      <h1 class="head__title">{{ t('nav.customer.cart') }}</h1>
      <p v-if="cart.cart.value && lines.length > 0" class="head__meta">
        {{ t('customer.cart.positionsCount', { count: lines.length }) }}
        <template v-if="cart.cart.value.priceListVersionNumber != null">
          ·
          {{
            t('customer.cart.priceListVersion', { number: cart.cart.value.priceListVersionNumber })
          }}
        </template>
      </p>
    </header>

    <RemovalUndo
      v-if="actions.removed.value"
      :line="actions.removed.value"
      :error="actions.restoreError.value"
      @restore="actions.restore()"
      @dismiss="actions.dismissUndo()"
    />

    <StateView
      :state="view"
      :title="view === 'empty' ? t('customer.cart.empty.title') : undefined"
      :description="view === 'empty' ? t('customer.cart.empty.description') : undefined"
      @retry="cart.load()"
    >
      <template v-if="view === 'empty'" #actions>
        <RouterLink :to="{ name: 'customer-catalog' }" class="action-link">
          {{ t('customer.cart.empty.action') }}
        </RouterLink>
      </template>

      <PaymentPlanChoice
        v-if="cart.cart.value"
        ref="planChoice"
        required
        :attention="planAttention"
        :totals="planTotals"
        :model-value="plan"
        :warning="t('customer.cart.plan.warning')"
        :reason="planReason"
        :disabled="submitting"
        @update:model-value="cart.choosePlan"
      />

      <div class="layout">
        <ul class="list" role="list">
          <li
            v-for="line in lines"
            :key="line.productId"
            role="listitem"
            class="line"
            :class="{ 'line--problem': line.problem !== null }"
          >
            <div class="line__info">
              <span class="line__name">{{ line.name }}</span>
              <span class="line__code">{{ line.productCode }}</span>
              <span v-if="pricesOf(line).unitPrice !== null" class="line__each">
                {{
                  t('customer.cart.each', {
                    price: formatMoneyWithCurrency(pricesOf(line).unitPrice ?? '0'),
                    quantity: formatNumber(line.quantity),
                    unit: formatUnit(line.unit),
                  })
                }}
              </span>
              <template v-if="plan === null && line.unitPrice !== null">
                <!-- No plan yet: both prices with their names, never one unnamed figure. -->
                <span class="line__each" data-testid="line-plan-price">
                  {{ t('customer.plan.FULL') }}:
                  {{ formatMoneyWithCurrency(line.unitPrice ?? '0') }}
                </span>
                <span
                  v-if="line.deferredUnitPrice !== null"
                  class="line__each"
                  data-testid="line-plan-price"
                >
                  {{ t('customer.plan.DEFERRED') }}:
                  {{ formatMoneyWithCurrency(line.deferredUnitPrice) }}
                </span>
              </template>
              <!-- The recommended retail price of ONE piece [C, 2026-11-09]: information for the
                   shop, in no total. A narrow phone shows the short label; the full one stays for
                   screen readers. -->
              <span v-if="line.rrp !== null" class="line__rrp" data-testid="line-rrp">
                <span class="line__rrp-full">{{
                  t('customer.cart.rrp', {
                    price: formatMoneyWithCurrency(line.rrp),
                    unit: formatUnit(line.unit),
                  })
                }}</span>
                <span class="line__rrp-short" aria-hidden="true">{{
                  t('customer.cart.rrpShort', {
                    price: formatMoneyWithCurrency(line.rrp),
                    unit: formatUnit(line.unit),
                  })
                }}</span>
              </span>
              <!-- How many can be ordered now; nothing at all for a product without a figure. -->
              <span
                v-if="line.problem === null && line.orderableStock !== null"
                class="line__stock"
                data-testid="line-stock"
              >
                {{ t('customer.stock.available', stockParams(line)) }}
              </span>
              <!-- The stock fell below the quantity: what happened, what to do, and one tap that
                   does it. With pieces left the line keeps its stepper, so any smaller quantity
                   works too; with none left the one move is to remove the line. -->
              <div
                v-if="line.problem === 'STOCK_EXCEEDED' && line.orderableStock !== null"
                class="line__problem line__problem--stock"
                role="alert"
                data-testid="line-over-stock"
              >
                <span class="line__problem-text">{{
                  isGone(line)
                    ? t('customer.cart.stockGone')
                    : t('customer.cart.problem.STOCK_EXCEEDED', stockParams(line))
                }}</span>
                <AppButton
                  v-if="isGone(line)"
                  class="line__fix"
                  variant="secondary"
                  size="sm"
                  :disabled="submitting || cart.isPending(line.productId)"
                  :aria-label="t('customer.cart.removeLine', { name: line.name })"
                  data-testid="line-remove-gone"
                  @click="actions.remove(line.productId, line.name)"
                >
                  {{ t('customer.cart.remove') }}
                </AppButton>
                <AppButton
                  v-else
                  class="line__fix"
                  variant="secondary"
                  size="sm"
                  :disabled="
                    submitting || cart.isPending(line.productId) || unsaved.has(line.productId)
                  "
                  :aria-label="`${line.name}: ${t('customer.cart.setToStock', stockParams(line))}`"
                  data-testid="line-set-to-stock"
                  @click="setToStock(line)"
                >
                  {{ t('customer.cart.setToStock', stockParams(line)) }}
                </AppButton>
              </div>
              <p v-else-if="line.problem" class="line__problem" role="alert">
                {{ t(`customer.cart.problem.${line.problem}`) }}
              </p>
            </div>
            <div v-if="isAdjustable(line)" class="line__stepper">
              <QuantityStepper
                :model-value="line.quantity"
                :label="t('customer.quantity.label', { name: line.name })"
                :name="line.name"
                :commit="commitFor(line.productId, line.name)"
                :max="line.orderableStock"
                :unit="line.unit"
                :disabled="submitting"
                @unsaved="markUnsaved(line.productId, $event)"
                @invalid="markInvalid(line.productId, $event)"
              />
            </div>
            <span
              v-if="pricesOf(line).lineTotal !== null"
              class="line__total"
              :class="{ 'line__total--stale': unsaved.has(line.productId) }"
              :aria-busy="unsaved.has(line.productId) || undefined"
            >
              <span class="sr-only">{{ t('customer.cart.lineTotal') }}: </span
              >{{ formatMoneyWithCurrency(pricesOf(line).lineTotal ?? '0') }}
              <span v-if="unsaved.has(line.productId)" class="line__updating">{{
                t('customer.cart.updating')
              }}</span>
            </span>
            <AppButton
              class="line__remove"
              variant="ghost"
              size="sm"
              :disabled="submitting || cart.isPending(line.productId)"
              :aria-label="t('customer.cart.removeLine', { name: line.name })"
              @click="actions.remove(line.productId, line.name)"
            >
              <span aria-hidden="true">{{ '×' }}</span
              ><span class="sr-only">{{ t('customer.cart.remove') }}</span>
            </AppButton>
          </li>
        </ul>

        <RouterLink class="continue-shopping" :to="{ name: 'customer-catalog' }"
          >+ {{ t('customer.presentation.addProducts') }}</RouterLink
        >

        <aside class="summary" :aria-label="t('customer.cart.summary')">
          <h2 class="summary__title">{{ t('customer.cart.summary') }}</h2>
          <dl class="summary__rows">
            <div class="summary__row">
              <dt>{{ t('customer.cart.positions') }}</dt>
              <dd>{{ cart.itemCount.value }}</dd>
            </div>
            <div class="summary__row summary__row--total" :aria-busy="settling || undefined">
              <dt>{{ t('customer.cart.total') }}</dt>
              <dd class="summary__total" :class="{ 'summary__total--stale': settling }">
                <span class="summary__plan" data-testid="summary-plan">{{
                  plan === null ? t('customer.cart.plan.notChosen') : t(`customer.plan.${plan}`)
                }}</span>
                {{ shownTotal === null ? '—' : formatMoneyWithCurrency(shownTotal) }}
                <span class="summary__updating" :class="{ 'summary__updating--on': settling }">{{
                  t('customer.cart.updating')
                }}</span>
              </dd>
            </div>
          </dl>
          <div
            v-if="notes.length > 0"
            class="summary__notes"
            :class="{ 'summary__notes--open': notesOpen }"
          >
            <p :id="notesId" class="summary__notes-text" role="alert">{{ notes.join(' ') }}</p>
            <button
              type="button"
              class="summary__more"
              :aria-expanded="notesOpen"
              :aria-controls="notesId"
              @click="notesOpen = !notesOpen"
            >
              {{ notesOpen ? t('customer.cart.notesLess') : t('customer.cart.notesMore') }}
            </button>
          </div>
          <p
            v-if="orderingOff"
            :id="orderingOffId"
            class="summary__hint"
            data-testid="viewer-cannot-order"
          >
            {{ t('customer.viewer.cannotOrder') }}
          </p>
          <!-- Without a plan the button stays pressable and says what to do: it takes the person
               to the choice instead of sitting there grey. It is really off only when ordering is
               blocked (an employee who may not order, a problem line, an unsaved quantity). -->
          <AppButton
            class="summary__cta"
            variant="primary"
            size="xl"
            block
            :loading="submitting || contactBusy"
            :disabled="!needsPlan && !canSubmit"
            :aria-describedby="orderingOff ? orderingOffId : undefined"
            :data-step="needsPlan ? 'choose-plan' : 'order'"
            data-testid="cart-order-button"
            @click="onOrderButton"
          >
            {{
              submitting
                ? t('customer.cart.submitting')
                : needsPlan
                  ? t('customer.cart.plan.choose')
                  : t('customer.cart.submit')
            }}
          </AppButton>
          <p class="summary__note">{{ t('customer.cart.submitNote') }}</p>
        </aside>
      </div>
    </StateView>

    <AppConfirmDialog
      v-model="confirmationOpen"
      :title="t('customer.cart.confirmTitle')"
      :description="t('customer.cart.confirmDescription')"
      :confirm-label="t('customer.cart.confirmAction')"
      @confirm="confirmSubmission"
    >
      <dl class="confirmation-summary">
        <div>
          <dt>{{ t('customer.presentation.yourShop') }}</dt>
          <dd>
            {{ session.organizationName.value ?? t('customer.presentation.yourShop') }}
          </dd>
        </div>
        <div>
          <dt>{{ t('customer.cart.positions') }}</dt>
          <dd>{{ lines.length }}</dd>
        </div>
        <div>
          <dt>{{ t('customer.cart.plan.title') }}</dt>
          <dd data-testid="confirm-plan">{{ plan === null ? '' : t(`customer.plan.${plan}`) }}</dd>
        </div>
        <div>
          <dt>{{ t('customer.cart.total') }}</dt>
          <dd>{{ formatMoneyWithCurrency(shownTotal ?? '0') }}</dd>
        </div>
      </dl>
    </AppConfirmDialog>

    <ContactDialog
      v-model="contactOpen"
      :initial-name="session.me.value?.fullName ?? ''"
      :loading="contactBusy"
      :failure="contactFailure"
      @confirm="saveContact"
    />

    <p class="sr-only" role="status" aria-live="polite">
      <span :key="actions.announcementSeq.value">{{ actions.announcement.value }}</span>
    </p>
  </section>
</template>

<style scoped>
.confirmation-summary {
  display: grid;
  gap: 12px;
  padding: 16px;
  margin: 4px 0;
  background: var(--f5);
  border-radius: var(--r-input);
}
.confirmation-summary > div {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}
.confirmation-summary dt {
  color: var(--t3);
  font-size: var(--fs-small);
}
.confirmation-summary dd {
  margin: 0;
  font-weight: 600;
  text-align: end;
  overflow-wrap: anywhere;
}
.continue-shopping {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: var(--tap-min);
  color: var(--acc-fg);
  font-size: var(--fs-body);
  font-weight: 600;
}
.cart {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.head__title {
  margin: 0;
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.head__meta {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t3);
}

.layout {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Phone: name and remove on top, then the stepper and the line total on one row. */
.line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    'info remove'
    'stepper total';
  align-items: center;
  gap: 8px 12px;
  padding: 14px 0;
  border-bottom: 1px solid var(--e8);
}

.line__info {
  grid-area: info;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.line__name {
  font-size: var(--fs-body-lg);
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.line__code {
  font-family: var(--font-mono);
  font-size: var(--fs-meta);
  color: var(--t3);
  overflow-wrap: anywhere;
}

.line__each {
  font-size: var(--fs-small);
  font-variant-numeric: tabular-nums;
  color: var(--t3);
}

/* Secondary to what the customer pays: the muted text of the unit price line, never the weight of
   the line total. `relative` keeps the visually hidden full label anchored inside the line. */
.line__rrp {
  position: relative;
  font-size: var(--fs-small);
  font-variant-numeric: tabular-nums;
  color: var(--t3);
  overflow-wrap: anywhere;
}

.line__rrp-short {
  display: none;
}

.line__stock {
  font-size: var(--fs-small);
  font-variant-numeric: tabular-nums;
  color: var(--t2);
}

.line__problem {
  margin: 4px 0 0;
  padding: 8px 10px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-small);
}

/* The sentence and its one-tap fix on one row; on a narrow phone the button wraps under the text
   and keeps its left edge on the text's, never squeezed beside it. */
.line__problem--stock {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.line__problem-text {
  flex: 1 1 180px;
  min-width: 0;
}

.line__fix {
  flex: none;
}

.line__stepper {
  grid-area: stepper;
}

.line__total {
  grid-area: total;
  justify-self: end;
  font-size: var(--fs-body-lg);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  /* A very large total wraps instead of pushing the row wider than the screen. */
  overflow-wrap: anywhere;
  text-align: right;
  transition: opacity 150ms var(--ease);
}

/* The number on screen is ahead of the saved one: the saved total is provisional. The cue is a
   word at normal text contrast, not a faded colour alone. */
.line__updating,
/* Always in the layout: appearing would resize the sticky card above the menu on every tap. */
.summary__updating {
  display: block;
  visibility: hidden;
  font-size: var(--fs-meta);
  font-weight: 500;
  font-style: italic;
  color: var(--t2);
}

.line__total--stale,
.summary__total--stale {
  color: var(--t3);
}

.line__remove {
  grid-area: remove;
  align-self: start;
  color: var(--t3);
}

.summary {
  display: flex;
  flex-direction: column;
  gap: var(--gap-card);
  padding: 14px 16px;
  border: 1px solid var(--e8);
  border-radius: var(--r-panel);
  background: var(--w);
}

.summary__title {
  display: none;
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 650;
}

.summary__rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
}

.summary__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: var(--fs-body);
  color: var(--t3);
}

.summary__row dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.summary__row--total {
  color: var(--ink);
  font-size: var(--fs-body-lg);
  font-weight: 600;
}

.summary__total {
  font-size: var(--fs-amount);
  font-weight: 700;
  white-space: nowrap;
  transition: opacity 150ms var(--ease);
}

.summary__plan {
  display: block;
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--t2);
  text-align: right;
}

.summary__hint {
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 600;
  color: var(--amber);
}

.summary__notes {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px 6px 10px;
  border-radius: var(--r-btn-sm);
  background: var(--red-bg);
  color: var(--red);
  font-size: var(--fs-small);
}

.summary__notes-text {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.summary__more {
  display: none;
  flex: none;
  min-height: var(--tap-min);
  margin: -6px 0;
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 600;
  text-decoration: underline;
  cursor: pointer;
}

.summary__more:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: -2px;
}

.summary__note {
  display: none;
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--t3);
}

.action-link {
  display: inline-flex;
  align-items: center;
  min-height: var(--tap-min);
  padding: 0 20px;
  border-radius: var(--r-btn-sm);
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
  font-size: var(--fs-body);
  font-weight: 600;
}

.action-link:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 3px;
}

/* Phone and tablet: the summary with the order button stays at the bottom, above the menu. */
@media (max-width: 959px) {
  /* A short cart still ends at the bottom: the summary is pushed down to the menu, not left floating
     under the last line. */
  .cart,
  .layout {
    flex: 1;
  }

  .summary {
    margin-top: auto;
    gap: 8px;
    padding: 10px 12px;
    position: sticky;
    /* 20px of air between the summary card and the bottom menu. */
    bottom: calc(var(--customer-bottom-h, 0px) + 20px);
    z-index: var(--z-sticky);
    box-shadow: var(--sh-dropdown);
  }

  .summary__more {
    display: inline-flex;
    align-items: center;
  }

  .summary__notes-text {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .summary__notes--open .summary__notes-text {
    overflow: visible;
    white-space: normal;
    text-overflow: clip;
  }

  .summary__rows {
    flex-direction: row;
    justify-content: space-between;
    align-items: baseline;
  }

  .summary__row {
    flex-direction: column;
    gap: 0;
  }

  .summary__row--total {
    align-items: flex-end;
  }
}

/* Phones: "RRP" alone fits on one line next to the amount; the full label is read out instead. */
@media (max-width: 479px) {
  /* The same recipe as the shared .sr-only class: out of sight, still read out. */
  .line__rrp-full {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }

  .line__rrp-short {
    display: inline;
  }
}

/* Small phones (320px): the stepper is about 150px wide, so the total goes under it. */
@media (max-width: 360px) {
  .line {
    grid-template-areas:
      'info remove'
      'stepper stepper'
      'total total';
  }
}

/* Tablet: lines in one row each. */
@media (min-width: 640px) {
  .line {
    grid-template-columns: minmax(0, 1fr) auto minmax(110px, auto) auto;
    grid-template-areas: 'info stepper total remove';
  }

  .line__remove {
    align-self: center;
  }

  .line__total {
    justify-self: end;
  }

  .summary__note {
    display: block;
  }
}

/* Desktop: lines on the left, a sticky summary card on the right. */
@media (min-width: 960px) {
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    align-items: start;
    gap: 32px;
  }

  .line {
    padding: 16px 0;
    /* A narrower left column: the remove button drops under the total. */
    grid-template-columns: minmax(0, 1fr) auto 120px;
    grid-template-areas:
      'info stepper total'
      'info remove remove';
  }

  .line__remove {
    justify-self: end;
  }

  .summary {
    position: sticky;
    top: calc(var(--customer-content-top) + 16px);
    bottom: auto;
    padding: 20px;
    box-shadow: none;
    background: var(--f5);
  }

  .summary__title {
    display: block;
  }

  .summary__rows {
    flex-direction: column;
    justify-content: flex-start;
  }

  .summary__row {
    flex-direction: row;
    gap: 12px;
  }

  .summary__row--total {
    align-items: baseline;
    padding-top: 10px;
    border-top: 1px solid var(--d9);
  }
}

@media (min-width: 1200px) {
  .line {
    grid-template-columns: minmax(0, 1fr) auto 130px auto;
    grid-template-areas: 'info stepper total remove';
  }

  .line__remove {
    justify-self: auto;
  }
}

.summary__updating--on {
  visibility: visible;
}

/* A low window (an open keyboard): a sticky card would cover the menu and the list. */
@media (max-width: 959px) and (max-height: 560px) {
  .summary {
    position: static;
  }
}
</style>
