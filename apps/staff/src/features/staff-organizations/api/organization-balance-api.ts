import {
  ORGANIZATION_PAYMENT_ROUTES,
  organizationBalanceResponseSchema,
  type CorrectPaymentRequest,
  type OrganizationBalanceResponse,
  type RecordPaymentRequest,
  type VoidPaymentRequest,
} from '@iorder/shared/staff-orders';
import type { HttpClient } from '@core/lib/http-client';

/**
 * An organization's debt and its payments ([C] 2026-10-26). The debt is the organization's
 * RECEIVED orders minus its payments, computed by the server; the web only shows it. Reading is
 * manager, admin and accountant; recording is the manager; correcting and voiding is the admin
 * (the server answers 403 to everyone else). Every call answers the whole balance, so a screen
 * renders the answer instead of reading again.
 */
export interface OrganizationBalanceApi {
  getBalance: (organizationId: string) => Promise<OrganizationBalanceResponse>;
  /** Manager only. A day in the future (Asia/Tashkent) is 422 on `paidOn`. */
  recordPayment: (
    organizationId: string,
    request: RecordPaymentRequest,
  ) => Promise<OrganizationBalanceResponse>;
  /** Admin only, with a reason. A voided payment is 409 PAYMENT_VOIDED. */
  correctPayment: (
    paymentId: string,
    request: CorrectPaymentRequest,
  ) => Promise<OrganizationBalanceResponse>;
  /** Admin only, with a reason; final. A second void is 409 PAYMENT_VOIDED. */
  voidPayment: (
    paymentId: string,
    request: VoidPaymentRequest,
  ) => Promise<OrganizationBalanceResponse>;
}

export function createHttpOrganizationBalanceApi(http: HttpClient): OrganizationBalanceApi {
  return {
    getBalance: (organizationId) =>
      http.request(ORGANIZATION_PAYMENT_ROUTES.getBalance, organizationBalanceResponseSchema, {
        params: { id: organizationId },
      }),
    recordPayment: (organizationId, request) =>
      http.request(ORGANIZATION_PAYMENT_ROUTES.recordPayment, organizationBalanceResponseSchema, {
        params: { id: organizationId },
        body: request,
      }),
    correctPayment: (paymentId, request) =>
      http.request(ORGANIZATION_PAYMENT_ROUTES.correctPayment, organizationBalanceResponseSchema, {
        params: { id: paymentId },
        body: request,
      }),
    voidPayment: (paymentId, request) =>
      http.request(ORGANIZATION_PAYMENT_ROUTES.voidPayment, organizationBalanceResponseSchema, {
        params: { id: paymentId },
        body: request,
      }),
  };
}
