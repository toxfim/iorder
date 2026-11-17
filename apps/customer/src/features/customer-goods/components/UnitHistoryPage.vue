<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import AppBackLink from '@core/components/ui/AppBackLink.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { ApiNotFoundError } from '@core/lib/api-errors';
import { useCustomerServices } from '@/features/customer-app/services';
import GoodsCodes from './GoodsCodes.vue';
import GoodsIcon from './GoodsIcon.vue';
import GoodsMilestones from './GoodsMilestones.vue';
import '../goods.css';
const { t } = useI18n();
const route = useRoute();
const { goodsApi, session } = useCustomerServices();
const productId = String(route.params.productId);
const view = useAsyncView(() => goodsApi.unit(productId, String(route.params.unitId)));
const notFound = computed(() => view.error.value instanceof ApiNotFoundError);
</script>
<template>
  <section class="goods-page goods-unit-page">
    <AppBackLink :to="{ name: 'customer-goods-product', params: { productId } }">{{
      t('customer.goods.backGoods')
    }}</AppBackLink>
    <h1>{{ t('customer.goods.unitHistory') }}</h1>
    <StateView
      :state="notFound ? 'empty' : view.state.value"
      :title="notFound ? t('customer.goods.notFound') : undefined"
      :description="notFound ? t('customer.goods.notFoundHint') : undefined"
      @retry="view.reload()"
      ><template v-if="view.data.value"
        ><section class="goods-panel">
          <header class="goods-match-heading">
            <GoodsIcon
              :name="
                view.data.value.product.icon === 'phone'
                  ? 'phone-accent'
                  : view.data.value.product.icon
              "
            />
            <h2>{{ view.data.value.product.name }}</h2>
          </header>
          <GoodsCodes :codes="view.data.value.unit.codes" /><RouterLink
            class="goods-order-link"
            :to="{ name: 'customer-order', params: { id: view.data.value.unit.orderId } }"
            >{{ t('customer.goods.order') }} {{ view.data.value.unit.orderNumber }} →</RouterLink
          >
        </section>
        <section class="goods-panel">
          <h2>{{ t('customer.goods.unitHistory') }}</h2>
          <GoodsMilestones :milestones="view.data.value.unit.milestones" />
        </section>
        <aside class="goods-note">
          <strong>{{ session.me.value?.membership?.organizationName }}</strong>
          <p>{{ t('customer.goods.scopeHint') }}</p>
        </aside></template
      ></StateView
    >
  </section>
</template>
