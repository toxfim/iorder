<script setup lang="ts">
import { PAYMENT_PLANS, type PaymentPlan } from '@iorder/shared';
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFormat } from '@core/i18n/use-format';

// The payment plan as a visible choice: two cards, each with a radio circle, the plan and what the
// order costs under it. The radio is a native one (keyboard and screen readers work as usual) and
// the whole card is its target. Used by the cart (before submitting, where a choice is required)
// and by the order page (the short time after, where one is already made).
const props = defineProps<{
  totals: Readonly<Record<PaymentPlan, string | null>>;
  /** Null: nothing chosen yet, no card is on. */
  modelValue: PaymentPlan | null;
  warning: string;
  /** Why an option is off, when that can be named. */
  reason?: string | null;
  disabled?: boolean;
  /** The cart: the title asks for a choice and carries a "required" mark. */
  required?: boolean;
  /**
   * How many times the person was sent here to choose (0: never). While it is above zero the
   * choice keeps a ring, and every new count replays a short emphasis.
   */
  attention?: number;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: PaymentPlan] }>();

const { t } = useI18n();
const { formatMoneyWithCurrency } = useFormat();
const name = useId();
const root = ref<HTMLFieldSetElement | null>(null);

const options = computed(() =>
  PAYMENT_PLANS.map((plan) => {
    const total = props.totals[plan];
    return { plan, total, available: total !== null };
  }),
);

const attentionCount = computed(() => props.attention ?? 0);

/** Brings the choice into view and puts the keyboard on its first option that can be chosen. */
function focusChoice(): void {
  const fieldset = root.value;
  if (fieldset === null) return;
  // The base stylesheet switches off CSS scrolling for reduced motion, but a scripted smooth
  // scroll ignores that and has to ask by itself.
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  // "center": clear of the page header above and of the sticky summary below.
  fieldset.scrollIntoView?.({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
  // preventScroll: the focus must not jump there at once and cut the smooth scroll short.
  fieldset
    .querySelector<HTMLInputElement>('input[type="radio"]:not(:disabled)')
    ?.focus({ preventScroll: true });
}

defineExpose({ focusChoice });
</script>

<template>
  <fieldset
    ref="root"
    class="plan"
    :class="{
      'plan--attention': attentionCount > 0,
      // Two names for one animation: switching between them replays it on every new count.
      'plan--nudge-a': attentionCount > 0 && attentionCount % 2 === 1,
      'plan--nudge-b': attentionCount > 0 && attentionCount % 2 === 0,
    }"
    data-testid="payment-plan"
  >
    <legend class="plan__legend">
      <!-- A legend is laid out by its own rules in some browsers, so the row is this span. -->
      <span class="plan__heading">
        <span class="plan__title">{{
          required ? t('customer.cart.plan.choose') : t('customer.cart.plan.title')
        }}</span>
        <!-- A word, not a colour or a bare asterisk: it reads the same for everyone. -->
        <span v-if="required" class="plan__required" data-testid="payment-plan-required">{{
          t('customer.cart.plan.required')
        }}</span>
      </span>
    </legend>
    <p class="plan__warning" data-testid="payment-plan-warning">
      {{ warning }}
    </p>
    <div class="plan__options">
      <label
        v-for="option in options"
        :key="option.plan"
        class="plan__option"
        :class="{
          'plan__option--on': modelValue === option.plan,
          'plan__option--off': !option.available || disabled,
        }"
      >
        <input
          type="radio"
          class="plan__input"
          :name="name"
          :value="option.plan"
          :checked="modelValue === option.plan"
          :disabled="!option.available || disabled"
          :required="required"
          :data-testid="`payment-plan-${option.plan}`"
          @change="emit('update:modelValue', option.plan)"
        />
        <span class="plan__circle" aria-hidden="true" />
        <span class="plan__name">{{ t(`customer.plan.${option.plan}`) }}</span>
        <strong v-if="option.total !== null" class="plan__total">{{
          formatMoneyWithCurrency(option.total)
        }}</strong>
        <span v-else class="plan__total plan__total--none">{{
          t('customer.cart.plan.unavailable')
        }}</span>
      </label>
    </div>
    <p v-if="reason" class="plan__reason" data-testid="payment-plan-reason">{{ reason }}</p>
  </fieldset>
</template>

<style scoped>
.plan {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--r-panel);
}

/* Sent here by the order button: a ring that stays until a plan is picked (the parent then resets
   the count). It is the whole emphasis where animations are switched off. An outline is drawn
   outside the box, so nothing moves when it appears. */
.plan--attention {
  outline: 2px solid var(--acc);
  outline-offset: 6px;
}

.plan--nudge-a {
  animation: plan-nudge-a 420ms var(--ease) 1;
}

.plan--nudge-b {
  animation: plan-nudge-b 420ms var(--ease) 1;
}

/* The ring closes in on the choice once: short and calm, no shaking. */
@keyframes plan-nudge-a {
  from {
    outline-color: transparent;
    outline-offset: 14px;
  }
}

@keyframes plan-nudge-b {
  from {
    outline-color: transparent;
    outline-offset: 14px;
  }
}

.plan__legend {
  /* A legend ignores the flex gap of its fieldset. */
  margin-bottom: 4px;
  padding: 0;
}

.plan__heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}

.plan__title {
  font-size: var(--fs-body-lg);
  font-weight: 600;
}

.plan__required {
  padding: 2px 8px;
  border-radius: var(--r-pill);
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: var(--fs-meta);
  font-weight: 600;
}

.plan__warning {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--r-btn-sm);
  background: var(--amber-bg);
  color: var(--amber);
  font-size: var(--fs-small);
}

.plan__options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

/* One card: the circle and the plan on the first row, its total under them. */
.plan__option {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-areas:
    'circle name'
    'total total';
  align-items: center;
  gap: 8px 10px;
  min-height: var(--tap-min);
  padding: 12px;
  border-radius: var(--r-input);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--d9);
  cursor: pointer;
  /* A tap answers at once: no grey flash from the browser and no text selection on a long press. */
  -webkit-tap-highlight-color: transparent;
  user-select: none;
  transition:
    background-color 120ms var(--ease),
    box-shadow 120ms var(--ease);
}

/* Hover only where there is a pointer that hovers: on a phone it would stick after a tap. */
@media (hover: hover) {
  .plan__option:not(.plan__option--off, .plan__option--on):hover {
    box-shadow: inset 0 0 0 1px var(--t3);
  }

  .plan__option:not(.plan__option--off, .plan__option--on):hover .plan__circle {
    border-color: var(--ink);
  }
}

.plan__option:not(.plan__option--off):active {
  background: var(--f5);
}

.plan__option--on {
  background: var(--acc-bg);
  box-shadow: inset 0 0 0 2px var(--acc);
}

.plan__option--on:not(.plan__option--off):active {
  background: var(--acc-bg);
}

.plan__option--off {
  background: var(--f5);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--t3);
  cursor: not-allowed;
}

/* The native radio covers the card, invisible: the card is its target and the drawn circle below
   shows its state. */
.plan__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: inherit;
}

.plan__option:has(.plan__input:focus-visible) {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}

.plan__circle {
  grid-area: circle;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 2px solid var(--t3);
  border-radius: 50%;
  background: var(--w);
  transition: border-color 120ms var(--ease);
}

/* The dot of a chosen radio: a shape, so the choice does not rest on colour. */
.plan__circle::after {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--acc);
  content: '';
  transform: scale(0);
  transition: transform 120ms var(--ease);
}

.plan__option--on .plan__circle {
  border-color: var(--acc);
}

.plan__option--on .plan__circle::after {
  transform: scale(1);
}

.plan__option--off .plan__circle {
  border-color: var(--d9);
  background: var(--f5);
}

.plan__option--off.plan__option--on .plan__circle::after {
  background: var(--t3);
}

.plan__name {
  grid-area: name;
  font-size: var(--fs-small);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.plan__total {
  grid-area: total;
  font-size: var(--fs-body-lg);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.plan__total--none {
  font-size: var(--fs-small);
}

.plan__reason {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
  overflow-wrap: anywhere;
}

/* Small phones (320px): two cards would break a long total into pieces. One card per row, the
   total at the end of the row. */
@media (max-width: 360px) {
  .plan__options {
    grid-template-columns: minmax(0, 1fr);
  }

  .plan__option {
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas: 'circle name total';
  }

  .plan__total {
    text-align: end;
  }
}
</style>
