<script setup lang="ts">
// `dark` is the solid ink button used by the design for retry / confirm-in-bar actions.
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'dark';
// Heights come from specs.md section 3: 50 drawer footer CTA, 44 modal, 42 header/filter,
// 38 in-row, 32 inline; `icon` is the 34px square icon button.
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'icon';

withDefaults(
  defineProps<{
    variant?: ButtonVariant;
    size?: ButtonSize;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    loading?: boolean;
    block?: boolean;
    /**
     * Looks and is announced as disabled (`aria-disabled`) but stays focusable and clickable, so
     * the owner of the button can say WHY it is off (a natively disabled button fires no click and
     * takes no focus). The owner's click handler must refuse the action itself.
     */
    softDisabled?: boolean;
  }>(),
  {
    variant: 'primary',
    size: 'md',
    type: 'button',
    disabled: false,
    loading: false,
    block: false,
    softDisabled: false,
  },
);
</script>

<template>
  <button
    :type="type"
    :disabled="(disabled || loading) && !softDisabled"
    :aria-disabled="softDisabled || undefined"
    :aria-busy="loading || undefined"
    class="btn"
    :class="[`btn--${variant}`, `btn--${size}`, { 'btn--block': block, 'btn--loading': loading }]"
  >
    <span v-if="loading" class="btn__spinner" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid transparent;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}

.btn--block {
  width: 100%;
}

.btn:disabled,
.btn[aria-disabled='true'] {
  cursor: not-allowed;
}

/* Sizes */
.btn--xs {
  height: 32px;
  padding: 0 12px;
  border-radius: var(--r-pill);
  font-size: var(--fs-small);
}
.btn--sm {
  height: 38px;
  padding: 0 14px;
  border-radius: var(--r-btn-sm);
  font-size: var(--fs-small);
}
.btn--md {
  height: 42px;
  padding: 0 16px;
  border-radius: 11px;
  font-size: var(--fs-body);
}
.btn--lg {
  height: 44px;
  padding: 0 18px;
  border-radius: var(--r-input);
  font-size: var(--fs-body);
}
.btn--xl {
  height: 50px;
  padding: 0 20px;
  border-radius: var(--r-input);
  font-size: var(--fs-body-lg);
}
.btn--icon {
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: var(--r-btn-sm);
  font-size: 18px;
}

/* Variants */
.btn--primary {
  background: var(--acc);
  color: var(--acc-on);
}
.btn--primary:hover:not(:disabled) {
  background: var(--acc-hover);
}

.btn--secondary {
  background: var(--ef);
  color: var(--ink);
}
.btn--secondary:hover:not(:disabled) {
  background: var(--e8);
}

.btn--outline {
  background: var(--w);
  border-color: var(--ink);
  color: var(--ink);
}
.btn--outline:hover:not(:disabled) {
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
}

.btn--dark {
  background: var(--btn-ink-bg);
  color: var(--btn-ink-fg);
}
.btn--dark:hover:not(:disabled) {
  background: var(--t2);
}

.btn--ghost {
  background: transparent;
  color: var(--t2);
}
.btn--ghost:hover:not(:disabled) {
  background: var(--ef);
  color: var(--ink);
}

.btn--danger {
  background: var(--ef);
  color: var(--red);
}
.btn--danger:hover:not(:disabled) {
  background: var(--e8);
}

/* Disabled looks the same for every variant: grey, as in the design's inactive confirm buttons. */
.btn:disabled:not(.btn--loading),
.btn[aria-disabled='true']:not(.btn--loading) {
  background: var(--e8);
  border-color: transparent;
  color: var(--t3);
}

/* Touch devices: every control gets a 44px hit area (WCAG 2.5.5 / platform guidance). Mouse
   layouts keep the design's 32-50px sizes. */
@media (pointer: coarse), (hover: none) {
  .btn {
    min-height: 44px;
  }
  .btn--icon {
    min-width: 44px;
  }
}

.btn__spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
/*
 * Staff design v8 (only while the staff shell or login sets the attribute; the customer app never
 * does): flat 8px buttons with 12px/600 labels. Heights 32 (xs), 36 (sm), 40 (md, lg), 42 (xl),
 * icon 34. The secondary button is white with a hairline ring, danger is solid red.
 */
:root[data-staff-app] .btn {
  border: 0;
  font-size: var(--fs-small);
}
:root[data-staff-app] .btn--xs {
  height: 32px;
  padding: 0 14px;
  border-radius: var(--r-btn-sm);
}
:root[data-staff-app] .btn--sm {
  height: 36px;
  padding: 0 14px;
  border-radius: var(--r-btn-sm);
}
:root[data-staff-app] .btn--md,
:root[data-staff-app] .btn--lg {
  height: 40px;
  padding: 0 16px;
  border-radius: var(--r-btn-sm);
}
:root[data-staff-app] .btn--xl {
  height: 42px;
  padding: 0 18px;
  border-radius: var(--r-btn-sm);
  font-size: var(--fs-body);
}
:root[data-staff-app] .btn--icon {
  width: 34px;
  height: 34px;
  border-radius: var(--r-input);
  font-size: 16px;
}
:root[data-staff-app] .btn--secondary,
:root[data-staff-app] .btn--outline {
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
}
:root[data-staff-app] .btn--secondary:hover:not(:disabled),
:root[data-staff-app] .btn--outline:hover:not(:disabled) {
  background: var(--f5);
  color: var(--ink);
}
:root[data-staff-app] .btn--ghost:hover:not(:disabled) {
  background: var(--f5);
}
:root[data-staff-app] .btn--danger {
  background: var(--red);
  color: var(--on-red);
}
/* v8 has no hover colour for these fills; a slight darkening keeps the token pair intact. */
:root[data-staff-app] .btn--danger:hover:not(:disabled) {
  background: var(--red);
  filter: brightness(0.92);
}
:root[data-staff-app] .btn--dark:hover:not(:disabled) {
  background: var(--btn-ink-bg);
  filter: brightness(0.92);
}
:root[data-staff-app] .btn:disabled:not(.btn--loading),
:root[data-staff-app] .btn[aria-disabled='true']:not(.btn--loading) {
  background: var(--ef);
  box-shadow: none;
  color: var(--t3);
  /* The hover darkening of the solid fills must not reach a soft-disabled button. */
  filter: none;
}
</style>
