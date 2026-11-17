import type { PaymentPlan } from '@iorder/shared';
import type { PaymentMethod, StaffOrderSummary } from '@iorder/shared/staff-orders';
import { useI18n } from 'vue-i18n';
import { useServices } from '@/app/services';
import { showToast } from '@core/composables/use-toast';
import { ApiConflictError } from '@core/lib/api-errors';
import type { PlanChoice } from '../domain/allocation-plan';
import { describeOrderError } from '../domain/order-errors';

/** Which actions the signed-in person may offer (the server still decides every one). */
export interface OrderPermissions {
  /**
   * Approve, reject, skip accounting, edit quantities, choose and change the payment method and
   * the payment plan: the manager only (lifecycle §5; payment method [C] 2026-10-24).
   */
  readonly canDecide: boolean;
  /** The administrator: configures, performs no workflow step (the actions panel says so). */
  readonly isAdmin: boolean;
  /** Reads every order and acts on none. */
  readonly isPurchasing: boolean;
  /** Cancel an order: the manager only (owner rule 2026-10-22; admin cannot). */
  readonly canCancel: boolean;
  /** Accounting step: approve or reject an order the manager approved. */
  readonly canAccount: boolean;
  /** Release goods and assign the driver. */
  readonly canRelease: boolean;
  /** Mark delivered (the server checks it is the assigned driver). */
  readonly canDeliver: boolean;
  /** Sees prices, totals and payment (manager, accountant, admin). */
  readonly seesMoney: boolean;
  /** Sees phone numbers: not the accountant. A hint only, the api sends no phone to the accountant. */
  readonly seesPhones: boolean;
  /** Reads the per-unit codes (IMEI, SN, marking): everyone but the driver. */
  readonly seesCodes: boolean;
}

/** The part of an order the actions need: id and the version the person saw, plus a toast label. */
export type ActionOrder = Pick<StaffOrderSummary, 'id' | 'orderNumber' | 'rowVersion'>;

export interface OrderActionOptions {
  /** After EVERY successful change. */
  onChanged?: () => void;
  /** The order moved on or vanished (409 ORDER_CHANGED and friends, 404): re-read it. */
  onStale?: () => void;
  /** The release was refused because unit codes are missing (409 UNIT_CODES_INCOMPLETE). */
  onCodesIncomplete?: () => void;
  /**
   * The approval was refused over stock (409 ALLOCATION_CHANGED, STOCK_INSUFFICIENT). The plan on
   * screen takes the fresh one and says so itself: no toast, no reload, one click to confirm.
   */
  onAllocationConflict?: (caught: unknown) => boolean;
}

/**
 * Order actions with their toasts, shared by the home page, the list, the role queues and the
 * order page. No undo: a status transition cannot move backwards (lifecycle §3, "moving
 * backwards: not allowed"). PAID / UNPAID is derived by the server from the organization's
 * payments ([C] 2026-10-26), so there is no payment action here. A stale row version (409 ORDER_CHANGED) says so in a toast, re-reads the order
 * list and calls `onStale` so an open order page reloads what the server has now.
 */
export function useOrderActions(options: OrderActionOptions = {}) {
  const { t } = useI18n();
  const { ordersStore, currentUser } = useServices();

  const roles = (): readonly string[] => currentUser.user.value?.staffRoles ?? [];
  const has = (...wanted: string[]): boolean => wanted.some((role) => roles().includes(role));
  const permissions = (): OrderPermissions => ({
    canDecide: has('MANAGER'),
    isAdmin: has('ADMIN'),
    isPurchasing: has('PURCHASING_MANAGER'),
    canCancel: has('MANAGER'),
    canAccount: has('ACCOUNTANT'),
    canRelease: has('WAREHOUSE_MANAGER'),
    canDeliver: has('DRIVER'),
    seesMoney: has('MANAGER', 'ADMIN', 'ACCOUNTANT', 'PURCHASING_MANAGER'),
    seesPhones: has('MANAGER', 'ADMIN', 'WAREHOUSE_MANAGER', 'DRIVER', 'PURCHASING_MANAGER'),
    seesCodes: has('MANAGER', 'ADMIN', 'ACCOUNTANT', 'WAREHOUSE_MANAGER', 'PURCHASING_MANAGER'),
  });

  /** Runs one action; a failure becomes a toast and `null`. */
  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    try {
      const result = await action();
      options.onChanged?.();
      return result;
    } catch (caught) {
      if (options.onAllocationConflict?.(caught) === true) return null;
      const described = describeOrderError(caught);
      showToast({ message: t(described.key, described.params ?? {}) });
      if (caught instanceof ApiConflictError && caught.reason === 'UNIT_CODES_INCOMPLETE') {
        options.onCodesIncomplete?.();
      }
      if (described.reload) {
        options.onStale?.();
        void ordersStore.load({ silent: true });
      }
      return null;
    }
  }

  async function done(
    action: () => Promise<unknown>,
    toast: { key: string; order: ActionOrder },
  ): Promise<boolean> {
    const result = await run(action);
    if (result) showToast({ message: t(toast.key, { id: toast.order.orderNumber }) });
    return result !== null;
  }

  /** The payment method is required: every approved order has one ([C] 2026-10-24). */
  const approve = (
    order: ActionOrder,
    paymentMethod: PaymentMethod,
    plan: PlanChoice,
    skipAccounting = false,
    comment?: string,
  ): Promise<boolean> =>
    done(
      () =>
        ordersStore.approve(
          order,
          comment === undefined
            ? { skipAccounting, paymentMethod, plan }
            : { skipAccounting, paymentMethod, plan, comment },
        ),
      { key: 'orders.toast.approved', order },
    );

  /** Manager only, after the approval. Its own track, never the workflow: no row version. */
  async function setPaymentMethod(order: ActionOrder, method: PaymentMethod): Promise<boolean> {
    const result = await run(() => ordersStore.setPaymentMethod(order.id, method));
    if (!result) return false;
    showToast({
      message: t('orders.toast.paymentMethod', {
        id: order.orderNumber,
        method: t(`orders.paymentMethod.${method}`),
      }),
    });
    return true;
  }

  /** Manager only, while SUBMITTED. Moves the total, so it carries the row version. */
  async function setPaymentPlan(order: ActionOrder, plan: PaymentPlan): Promise<boolean> {
    const result = await run(() => ordersStore.setPaymentPlan(order, plan));
    if (!result) return false;
    showToast({
      message: t('orders.toast.paymentPlan', {
        id: order.orderNumber,
        plan: t(`orders.paymentPlan.${plan}`),
      }),
    });
    return true;
  }

  const reject = (order: ActionOrder, reason: string): Promise<boolean> =>
    done(() => ordersStore.reject(order, reason), { key: 'orders.toast.rejected', order });

  const cancel = (order: ActionOrder, reason: string): Promise<boolean> =>
    done(() => ordersStore.cancel(order, reason), { key: 'orders.toast.cancelled', order });

  /** Saves a whole item draft as one change (one history event, one customer notification). */
  const editItems = (
    order: ActionOrder,
    changes: readonly { itemId: string; quantity: string | null }[],
  ): Promise<boolean> =>
    done(() => ordersStore.editItems(order, changes), { key: 'orders.toast.itemsSaved', order });

  const accountingApprove = (order: ActionOrder, comment?: string): Promise<boolean> =>
    done(() => ordersStore.accountingApprove(order, comment), {
      key: 'orders.toast.accountingApproved',
      order,
    });

  const accountingReject = (order: ActionOrder, reason: string): Promise<boolean> =>
    done(() => ordersStore.accountingReject(order, reason), {
      key: 'orders.toast.rejected',
      order,
    });

  const release = (order: ActionOrder, driverUserId: string, comment?: string): Promise<boolean> =>
    done(() => ordersStore.release(order, driverUserId, comment), {
      key: 'orders.toast.released',
      order,
    });

  const deliver = (order: ActionOrder, comment?: string): Promise<boolean> =>
    done(() => ordersStore.deliver(order, comment), { key: 'orders.toast.delivered', order });

  const markGoodsReturned = (order: ActionOrder): Promise<boolean> =>
    done(() => ordersStore.markGoodsReturned(order), { key: 'orders.toast.goodsReturned', order });

  return {
    permissions,
    approve,
    reject,
    cancel,
    setPaymentMethod,
    setPaymentPlan,
    editItems,
    accountingApprove,
    accountingReject,
    release,
    deliver,
    markGoodsReturned,
  };
}
