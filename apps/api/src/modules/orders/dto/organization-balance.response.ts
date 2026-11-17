import type { CustomerBalanceResponse } from '@iorder/shared';
import type { OrganizationBalanceResponse } from '@iorder/shared/staff-orders';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { OrganizationBalanceView } from '../organization-payments.service.js';

// Explicit allow-listed fields only (never a Prisma entity).

export function toOrganizationBalanceResponse(
  view: OrganizationBalanceView,
): OrganizationBalanceResponse {
  return {
    organizationId: view.organizationId,
    currency: 'USD',
    receivedTotal: view.receivedTotal.toFixed(2),
    paidTotal: view.paidTotal.toFixed(2),
    amountDue: view.amountDue.toFixed(2),
    overpaid: view.overpaid.toFixed(2),
    usdRate: view.usdRate?.toFixed(4) ?? null,
    uzsEquivalent:
      view.uzsEquivalent === null
        ? null
        : {
            receivedTotal: view.uzsEquivalent.receivedTotal.toFixed(2),
            paidTotal: view.uzsEquivalent.paidTotal.toFixed(2),
            amountDue: view.uzsEquivalent.amountDue.toFixed(2),
            overpaid: view.uzsEquivalent.overpaid.toFixed(2),
          },
    payments: view.payments.map((p) => ({
      id: p.id,
      organizationId: p.organizationId,
      amount: p.amount.toFixed(2),
      currency: p.currency,
      rate: p.rate?.toFixed(4) ?? null,
      amountUsd: p.amountUsd.toFixed(2),
      amountUzs: p.amountUzs?.toFixed(2) ?? null,
      paidOn: p.paidOn,
      comment: p.comment,
      recordedByName: p.recordedByName,
      recordedByUserId: p.recordedByUserId,
      recordedAt: p.recordedAt.toISOString(),
      voidedAt: p.voidedAt?.toISOString() ?? null,
      voidReason: p.voidReason,
      updatedAt: p.updatedAt.toISOString(),
    })),
  };
}

export function toCustomerBalanceResponse(amountDue: Prisma.Decimal): CustomerBalanceResponse {
  return { amountDue: amountDue.toFixed(2), currency: 'UZS' };
}
