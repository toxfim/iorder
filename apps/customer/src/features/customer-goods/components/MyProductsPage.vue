<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import AppBackLink from '@core/components/ui/AppBackLink.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useInfiniteScroll } from '@core/composables/use-infinite-scroll';
import { useFormat } from '@core/i18n/use-format';
import { useCustomerServices } from '@/features/customer-app/services';
import { useGoodsList } from '../composables/use-goods-list';
import GoodsIcon from './GoodsIcon.vue';
import GoodsSearch from './GoodsSearch.vue';
import '../goods.css';
const { t } = useI18n();
const route = useRoute();
const { goodsApi, goods, session } = useCustomerServices();
const { formatDate } = useFormat();
const list = useGoodsList(
  async (query) => {
    const answer = await goodsApi.list(query);
    return { items: answer.products, nextCursor: answer.nextCursor };
  },
  typeof route.query.search === 'string' ? route.query.search : '',
);
const filtered = computed(() => list.search.value.trim() !== '');
const organization = computed(
  () => session.me.value?.membership?.organizationName ?? t('customer.presentation.yourShop'),
);
// The next page loads on its own as the end of the list nears; the button stays as a fallback.
const listEnd = ref<HTMLElement | null>(null);
// After a failure only the button retries: retrying on every scroll would blink the error.
useInfiniteScroll(listEnd, () => (list.moreError.value ? false : list.more()));
</script>
<template>
  <section class="goods-page">
    <AppBackLink :to="{ name: 'customer-orders' }">{{
      t('customer.goods.backOrders')
    }}</AppBackLink>
    <header class="goods-heading">
      <h1>{{ t('customer.goods.title') }}</h1>
      <p>{{ t('customer.goods.subtitle', { organization }) }}</p>
    </header>
    <GoodsSearch v-model="list.search.value" :placeholder="t('customer.goods.search')" />
    <p v-if="goods.summary.value?.hasProducts" class="goods-muted">
      {{
        t('customer.goods.count', {
          products: goods.summary.value.productCount,
          units: goods.summary.value.unitCount,
        })
      }}
    </p>
    <StateView
      :state="list.view.state.value === 'empty' ? 'ready' : list.view.state.value"
      @retry="list.view.reload()"
    >
      <div v-if="list.view.state.value === 'empty'" class="goods-empty">
        <div class="goods-empty-icon"><GoodsIcon :name="filtered ? 'search' : 'box-empty'" /></div>
        <h2>{{ t(filtered ? 'customer.goods.notFound' : 'customer.goods.empty') }}</h2>
        <p>{{ t(filtered ? 'customer.goods.notFoundHint' : 'customer.goods.emptyHint') }}</p>
        <AppButton v-if="filtered" variant="secondary" @click="list.search.value = ''">{{
          t('customer.goods.clear')
        }}</AppButton
        ><RouterLink v-else :to="{ name: 'customer-orders' }" class="goods-action">{{
          t('customer.goods.viewOrders')
        }}</RouterLink>
      </div>
      <template v-else
        ><div class="goods-table-head">
          <span>{{ t('customer.goods.product') }}</span
          ><span>{{ t('customer.goods.receivedCount') }}</span
          ><span>{{ t('customer.goods.lastReceived') }}</span
          ><span>{{ t('customer.goods.codes') }}</span>
        </div>
        <div class="goods-groups">
          <RouterLink
            v-for="product in list.view.data.value?.items"
            :key="product.productId"
            :to="{
              name: 'customer-goods-product',
              params: { productId: product.productId },
              query: filtered ? { search: list.search.value } : {},
            }"
            class="goods-group"
            ><div class="goods-group-main">
              <span class="goods-product-icon"><GoodsIcon :name="product.icon" /></span>
              <div>
                <h2>{{ product.name }}</h2>
                <p class="goods-group-meta">
                  {{ t('customer.goods.unitCount', { count: product.unitCount }) }} ·
                  {{
                    product.codeKinds.map((kind) => t(`customer.goods.kinds.${kind}`)).join(' / ')
                  }}
                </p>
              </div>
            </div>
            <span class="goods-desktop-count">{{
              t('customer.goods.unitCount', { count: product.unitCount })
            }}</span
            ><span class="goods-group-date"
              >{{ t('customer.goods.lastReceived') }}:
              {{ formatDate(product.lastDeliveredAt) }}</span
            ><span class="goods-group-codes"
              >{{ t('customer.goods.codeCount', { count: product.codeCount }) }}
              <GoodsIcon name="right" /></span
          ></RouterLink>
        </div>
        <p v-if="list.moreError.value" role="alert">{{ t('customer.goods.moreFailed') }}</p>
        <div
          v-if="list.view.data.value?.nextCursor"
          ref="listEnd"
          class="list-end"
          :class="{
            'list-end--loading': list.moreBusy.value,
            'list-end--manual': list.moreError.value,
          }"
        >
          <AppButton :loading="list.moreBusy.value" @click="list.more()">{{
            t('customer.goods.more')
          }}</AppButton>
        </div>
        <aside class="goods-note">
          <strong>{{ t('customer.goods.historyTitle') }}</strong>
          <p>{{ t('customer.goods.historyHint') }}</p>
        </aside></template
      >
    </StateView>
  </section>
</template>
