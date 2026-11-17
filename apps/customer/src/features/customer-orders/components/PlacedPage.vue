<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import AppIcon from '@core/components/ui/AppIcon.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { useCustomerServices } from '@/features/customer-app/services';
import { useDocumentTitleDetail } from '@core/composables/use-document-title';
import { useFormat } from '@core/i18n/use-format';
import { ApiNotFoundError } from '@core/lib/api-errors';

// C5: the confirmation after "Buyurtma berish". It reads the order (not router state), so a
// reload or a shared link still shows the right order.
const { t } = useI18n();
const route = useRoute();
const { ordersApi } = useCustomerServices();
const { formatMoneyWithCurrency } = useFormat();

const view = useAsyncView(() => ordersApi.get(String(route.params.id)), {
  isEmpty: () => false,
});
useDocumentTitleDetail(() => view.data.value?.orderNumber);
</script>

<template>
  <StateView
    :state="view.error.value instanceof ApiNotFoundError ? 'empty' : view.state.value"
    @retry="view.reload()"
  >
    <section v-if="view.data.value" class="placed">
      <div class="placed__content">
        <span class="placed__tile" aria-hidden="true"
          ><AppIcon name="check" :size="32" :stroke-width="3"
        /></span>
        <h1 class="placed__title">{{ t('customer.placed.title') }}</h1>
        <p class="placed__number">{{ view.data.value.orderNumber }}</p>
        <p class="placed__text">{{ t('customer.placed.description') }}</p>
        <div class="placed__sum">
          <span>{{ t('customer.placed.positions', { count: view.data.value.itemCount }) }}</span>
          <strong>{{ formatMoneyWithCurrency(view.data.value.totalAmount) }}</strong>
        </div>
      </div>
      <div class="placed__actions">
        <RouterLink
          :to="{ name: 'customer-order', params: { id: view.data.value.id } }"
          class="btn btn--primary"
        >
          {{ t('customer.placed.viewStatus') }}
        </RouterLink>
        <RouterLink :to="{ name: 'customer-catalog' }" class="btn btn--secondary">
          {{ t('customer.placed.backToCatalog') }}
        </RouterLink>
      </div>
    </section>
  </StateView>
</template>

<style scoped>
/* The page fills the area under the header (the shell gives it flex: 1 and the bottom padding of
   menu + 20px): the confirmation sits in the middle of what is left and the two buttons stay at
   the bottom, 20px above the menu. */
.placed {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 440px;
  margin: 0 auto;
  text-align: center;
}

.placed__content {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
}

.placed__actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.placed__tile {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: var(--acc);
  color: var(--acc-on);
}

.placed__title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.placed__number {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-body-lg);
}

.placed__text {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--t2);
}

.placed__sum {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 14px 16px;
  border-radius: var(--r-panel);
  background: var(--f5);
  font-size: var(--fs-body);
}

.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 52px;
  border-radius: var(--r-input);
  font-size: var(--fs-body-lg);
  font-weight: 600;
}

.btn--primary {
  background: var(--acc);
  color: var(--acc-on);
}

.btn--secondary {
  border: 1px solid var(--e8);
  background: var(--w);
  color: var(--ink);
}
</style>
