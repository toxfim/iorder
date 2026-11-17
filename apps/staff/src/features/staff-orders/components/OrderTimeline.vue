<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ORGANIZATION_ROLES, STAFF_ROLES } from '@iorder/shared';
import { useFormat } from '@core/i18n/use-format';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { eventTitleKey } from '../domain/order-presentation';
import type { TimelineEvent, TimelineNotificationRow } from '../domain/timeline-model';
import PersonName from '@/features/people/components/PersonName.vue';

const props = defineProps<{ events: readonly TimelineEvent[] }>();

const { t } = useI18n();
const { formatDateTime, formatMoney } = useFormat();

// v8 reads the history newest first ("Yangi → eski").
const newestFirst = computed(() => [...props.events].reverse());

/** Dot colour: red where the order closed, green where it moved on, grey for the rest. */
function dotOf(event: TimelineEvent): 'red' | 'green' | 'grey' {
  if (event.toStatus === 'REJECTED' || event.toStatus === 'CANCELLED') return 'red';
  if (event.toStatus) return 'green';
  return 'grey';
}

function roleLabel(role: TimelineEvent['actor']['role']): string {
  if ((STAFF_ROLES as readonly string[]).includes(role)) return t(`roles.staff.${role}`);
  if ((ORGANIZATION_ROLES as readonly string[]).includes(role)) {
    return t(`roles.organization.${role}`);
  }
  return t('orders.detail.timeline.system');
}

const stage = (status: string | null): string => (status ? t(`orders.stages.${status}`) : '');

function recipientLabel(row: TimelineNotificationRow): string {
  if (row.recipientKind === 'ROLE' && row.recipientRole)
    return t(`roles.staff.${row.recipientRole}`);
  if (row.recipientKind === 'ORGANIZATION_CHAT') {
    return row.recipientName
      ? t('orders.detail.recipients.chat', { name: row.recipientName })
      : t('orders.detail.recipients.chatAnon');
  }
  return row.recipientName ?? t('orders.detail.recipients.user');
}

/** One line per delivery state: sent, waiting in the queue, failed. */
function notificationLines(rows: readonly TimelineNotificationRow[]): {
  key: string;
  status: string;
  recipients: { key: string; label: string; userId: string | null }[];
}[] {
  return (['SENT', 'PENDING', 'FAILED'] as const)
    .map((status) => ({
      key: status,
      status,
      recipients: rows
        .filter((row) => row.status === status)
        .map((row) => ({
          key: row.id,
          label: recipientLabel(row),
          // A role or an organization chat is not a person: no card.
          userId: row.recipientKind === 'USER' ? row.recipientUserId : null,
        })),
    }))
    .filter((line) => line.recipients.length > 0);
}

const quantityText = (quantity: string): string => formatMoney(quantity);
</script>

<template>
  <ol v-if="events.length > 0" class="timeline">
    <li v-for="event in newestFirst" :key="event.id" class="event">
      <span class="event__rail" aria-hidden="true">
        <span class="event__dot" :class="`event__dot--${dotOf(event)}`" />
      </span>
      <div class="event__body">
        <b class="event__title">{{ t(`orders.detail.events.${eventTitleKey(event)}`) }}</b>
        <span class="event__meta"
          ><time :datetime="event.occurredAt">{{ formatDateTime(event.occurredAt) }}</time> ·
          <!-- The warehouse and the driver see roles only (the api sends no actor name to them). -->
          <i18n-t
            v-if="event.actor.name !== null"
            scope="global"
            keypath="orders.detail.timeline.actor"
          >
            <template #name>
              <PersonName :name="event.actor.name" :user-id="event.actor.userId" />
            </template>
            <template #role>{{ roleLabel(event.actor.role) }}</template>
          </i18n-t>
          <template v-else>{{ roleLabel(event.actor.role) }}</template></span
        >
        <p v-if="event.fromStatus && event.toStatus" class="event__line">
          {{
            t('orders.detail.timeline.transition', {
              from: stage(event.fromStatus),
              to: stage(event.toStatus),
            })
          }}
        </p>
        <p v-if="event.comment" class="event__line event__line--reason">
          {{
            t(
              event.toStatus === 'REJECTED' || event.toStatus === 'CANCELLED'
                ? 'orders.detail.timeline.reason'
                : 'orders.detail.timeline.comment',
              { comment: event.comment },
            )
          }}
        </p>
        <p v-if="event.accountingMode" class="event__line">
          {{
            t('orders.detail.timeline.accounting', {
              mode: t(`orders.detail.accountingMode.${event.accountingMode.to}`),
            })
          }}
        </p>
        <p v-if="event.driver" class="event__line">
          <i18n-t scope="global" keypath="orders.detail.timeline.driver">
            <template #name>
              <PersonName :name="event.driver.fullName" :user-id="event.driver.userId" />
            </template>
          </i18n-t>
        </p>
        <template v-if="event.itemsChange">
          <p v-for="line in event.itemsChange.lines" :key="line.productCode" class="event__line">
            <template v-if="line.newQuantity === null">
              {{
                t('orders.detail.timeline.removed', {
                  name: line.name,
                  from: quantityText(line.oldQuantity),
                })
              }}
            </template>
            <template v-else>
              {{ line.name }}: <s>{{ quantityText(line.oldQuantity) }}</s> {{ '→' }}
              <b>{{ quantityText(line.newQuantity) }}</b>
              {{ t('orders.detail.items.pieces') }}
            </template>
          </p>
          <p
            v-if="event.itemsChange.oldTotal !== null && event.itemsChange.newTotal !== null"
            class="event__line num"
          >
            {{ t('orders.detail.timeline.total') }}:
            <s>{{ formatMoney(event.itemsChange.oldTotal) }}</s> {{ '→' }}
            <b>{{ formatMoney(event.itemsChange.newTotal) }}</b>
            {{ t('common.currency') }}
          </p>
        </template>
        <p v-if="event.paymentChange" class="event__line">
          {{
            t('orders.detail.timeline.payment', {
              from: t(`orders.payment.${event.paymentChange.from}`),
              to: t(`orders.payment.${event.paymentChange.to}`),
            })
          }}
        </p>
        <p
          v-if="event.paymentMethodChange"
          class="event__line"
          data-testid="timeline-payment-method"
        >
          {{
            event.paymentMethodChange.from === null
              ? t('orders.detail.timeline.paymentMethod', {
                  to: t(`orders.paymentMethod.${event.paymentMethodChange.to}`),
                })
              : t('orders.detail.timeline.paymentMethodChange', {
                  from: t(`orders.paymentMethod.${event.paymentMethodChange.from}`),
                  to: t(`orders.paymentMethod.${event.paymentMethodChange.to}`),
                })
          }}
        </p>
        <template v-if="event.paymentPlanChange">
          <p class="event__line" data-testid="timeline-payment-plan">
            {{
              t('orders.detail.timeline.paymentPlanChange', {
                from: t(`orders.paymentPlan.${event.paymentPlanChange.from}`),
                to: t(`orders.paymentPlan.${event.paymentPlanChange.to}`),
              })
            }}
          </p>
          <p class="event__line num">
            {{ t('orders.detail.timeline.total') }}:
            <s>{{ formatMoney(event.paymentPlanChange.oldTotal) }}</s> {{ '→' }}
            <b>{{ formatMoney(event.paymentPlanChange.newTotal) }}</b>
            {{ t('common.currency') }}
          </p>
        </template>
        <p
          v-for="line in notificationLines(event.notifications)"
          :key="line.key"
          class="event__notif"
          :class="`event__notif--${line.status}`"
        >
          <StaffIcon name="send" :size="11" class="event__send" />
          <span>
            <i18n-t scope="global" :keypath="`orders.detail.timeline.notification.${line.status}`">
              <template #recipients>
                <template v-for="(recipient, index) in line.recipients" :key="recipient.key">
                  <template v-if="index > 0">, </template>
                  <PersonName :name="recipient.label" :user-id="recipient.userId" />
                </template>
              </template>
            </i18n-t>
          </span>
        </p>
      </div>
    </li>
  </ol>
  <p v-else class="empty" role="status">{{ t('orders.detail.timeline.empty') }}</p>
</template>
<style scoped>
/* v8 history: a 10px coloured dot per entry on a hairline rail, 12px/600 title, 10px meta. */
.timeline {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.event {
  display: flex;
  gap: 12px;
}

.event__rail {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: center;
  width: 10px;
}

.event__rail::after {
  content: '';
  flex: 1;
  width: 1px;
  margin: 4px 0;
  background: var(--e8);
}

.event:last-child .event__rail::after {
  display: none;
}

.event__dot {
  flex: none;
  width: 10px;
  height: 10px;
  margin-top: 4px;
  border-radius: 50%;
  background: var(--b5);
}

.event__dot--green {
  background: var(--green);
}

.event__dot--red {
  background: var(--red);
}

.event__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding-bottom: 16px;
  overflow-wrap: anywhere;
}

.event:last-child .event__body {
  padding-bottom: 0;
}

.event__title {
  font-size: var(--fs-small);
  font-weight: 600;
}

.event__meta {
  font-size: var(--fs-group);
  font-variant-numeric: tabular-nums;
  color: var(--t2);
}

.event__line {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--ink);
}

.event__line--reason {
  font-weight: 600;
  color: var(--red);
}

.event__notif {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  font-size: var(--fs-group);
  color: var(--t2);
}

.event__send {
  flex: none;
}

.event__notif--PENDING {
  color: var(--acc-fg);
}

.event__notif--FAILED {
  font-weight: 600;
  color: var(--red);
}

.empty {
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}
</style>
