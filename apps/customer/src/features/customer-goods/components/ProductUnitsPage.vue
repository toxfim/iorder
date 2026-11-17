<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import type { CustomerGoodsGroup } from '@iorder/shared';
import AppBackLink from '@core/components/ui/AppBackLink.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useInfiniteScroll } from '@core/composables/use-infinite-scroll';
import { useFormat } from '@core/i18n/use-format';
import { ApiNotFoundError } from '@core/lib/api-errors';
import { useCustomerServices } from '@/features/customer-app/services';
import { useGoodsList } from '../composables/use-goods-list';
import GoodsSearch from './GoodsSearch.vue';
import GoodsCodes from './GoodsCodes.vue';
import '../goods.css';
const { t } = useI18n();
const route = useRoute();
const { goodsApi } = useCustomerServices();
const { formatDate } = useFormat();
const productId = computed(() => String(route.params.productId));
const product = shallowRef<CustomerGoodsGroup | null>(null);
const list = useGoodsList(
  async (query) => {
    const answer = await goodsApi.product(productId.value, query);
    product.value = answer.product;
    return { items: answer.units, nextCursor: answer.nextCursor };
  },
  typeof route.query.search === 'string' ? route.query.search : '',
);
const notFound = computed(() => list.view.error.value instanceof ApiNotFoundError);
// The next page loads on its own as the end of the list nears; the button stays as a fallback.
const listEnd = ref<HTMLElement | null>(null);
useInfiniteScroll(listEnd, () => list.more());
</script>
<template>
  <section class="goods-page">
    <AppBackLink :to="{ name: 'customer-goods' }">{{ t('customer.goods.backGoods') }}</AppBackLink>
    <header class="goods-heading">
      <h1>{{ product?.name ?? t('customer.goods.title') }}</h1>
      <p v-if="product">
        {{ t('customer.goods.unitCount', { count: product.unitCount }) }} ·
        {{ product.codeKinds.map((kind) => t(`customer.goods.kinds.${kind}`)).join(' / ') }}
      </p>
    </header>
    <GoodsSearch v-model="list.search.value" :placeholder="t('customer.goods.unitSearch')" />
    <StateView
      :state="
        notFound ? 'empty' : list.view.state.value === 'empty' ? 'ready' : list.view.state.value
      "
      :title="notFound ? t('customer.goods.notFound') : undefined"
      :description="notFound ? t('customer.goods.notFoundHint') : undefined"
      @retry="list.view.reload()"
      ><div v-if="list.view.state.value === 'empty'" class="goods-empty">
        <h2>{{ t('customer.goods.notFound') }}</h2>
        <p>{{ t('customer.goods.notFoundHint') }}</p>
        <AppButton v-if="list.search.value" @click="list.search.value = ''">{{
          t('customer.goods.clear')
        }}</AppButton>
      </div>
      <template v-else
        ><div class="goods-unit-head">
          <span>{{ t('customer.goods.unit') }}</span
          ><span>{{ t('customer.goods.codes') }}</span
          ><span>{{ t('customer.goods.order') }}</span
          ><span>{{ t('customer.goods.delivered') }}</span>
        </div>
        <div class="goods-units">
          <article v-for="unit in list.view.data.value?.items" :key="unit.id" class="goods-unit">
            <header>
              <RouterLink
                :to="{ name: 'customer-goods-unit', params: { productId, unitId: unit.id } }"
                >{{ t('customer.goods.unitNumber', { number: unit.unitNumber }) }}</RouterLink
              >
            </header>
            <GoodsCodes :codes="unit.codes" /><RouterLink
              class="goods-order-link"
              :to="{ name: 'customer-order', params: { id: unit.orderId } }"
              >{{ unit.orderNumber }}</RouterLink
            >
            <p class="goods-muted goods-unit-date">
              {{
                unit.receivedAt
                  ? formatDate(unit.receivedAt)
                  : unit.milestones.deliveredAt
                    ? formatDate(unit.milestones.deliveredAt)
                    : t('customer.goods.pending.deliveredAt')
              }}
            </p>
            <RouterLink
              class="goods-unit-history"
              :to="{ name: 'customer-goods-unit', params: { productId, unitId: unit.id } }"
              >{{ t('customer.goods.unitHistory') }}</RouterLink
            >
          </article>
        </div>
        <p v-if="list.moreError.value" role="alert">{{ t('customer.goods.moreFailed') }}</p>
        <div v-if="list.view.data.value?.nextCursor" ref="listEnd">
          <AppButton :loading="list.moreBusy.value" @click="list.more()">{{
            t('customer.goods.more')
          }}</AppButton>
        </div></template
      ></StateView
    >
    <p class="goods-muted">{{ t('customer.goods.historyHint') }}</p>
  </section>
</template>
