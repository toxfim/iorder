import { paymentCurrencySchema, type PaymentCurrency } from '@iorder/shared/staff-orders';
import { Injectable } from '@nestjs/common';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { runInTransaction } from '../../common/database/transaction.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { ReceivedOrderForAllocation } from './payment-allocation.js';

export interface OrganizationPaymentRecord {
  id: string;
  organizationId: string;
  amount: Prisma.Decimal;
  currency: PaymentCurrency;
  /** Null on a USD payment. */
  rate: Prisma.Decimal | null;
  amountUsd: Prisma.Decimal;
  /** YYYY-MM-DD, Asia/Tashkent. */
  paidOn: string;
  comment: string | null;
  recordedByName: string;
  recordedByUserId: string;
  recordedAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
  updatedAt: Date;
}

/** The stored facts of what a payment is worth; they always change together. */
export interface PaymentValue {
  amount: Prisma.Decimal;
  currency: PaymentCurrency;
  rate: Prisma.Decimal | null;
  amountUsd: Prisma.Decimal;
}

const WITH_RECORDER = { recorder: { select: { fullName: true } } } as const;

/** A DATE column comes back as UTC midnight of that calendar day. */
function dayOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

@Injectable()
export class OrganizationPaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  /**
   * Serializes every change of one organization's debt (a payment, a correction, an order
   * becoming RECEIVED) for the rest of the transaction. An advisory lock, so the orders module does
   * not lock the organizations module's table.
   */
  async lockOrganizationLedger(tx: Tx, organizationId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`organization-payments:${organizationId}`}, 0))`;
  }

  async insertPayment(
    tx: Tx,
    data: {
      organizationId: string;
      value: PaymentValue;
      paidOn: string;
      comment: string | null;
      recordedBy: string;
      now: Date;
    },
  ): Promise<string> {
    const row = await tx.organizationPayment.create({
      data: {
        organizationId: data.organizationId,
        ...data.value,
        paidOn: dateOf(data.paidOn),
        comment: data.comment,
        recordedBy: data.recordedBy,
        recordedAt: data.now,
        updatedAt: data.now,
      },
      select: { id: true },
    });
    return row.id;
  }

  async findPayment(
    id: string,
    db: DbClient = this.prisma,
  ): Promise<OrganizationPaymentRecord | null> {
    const row = await db.organizationPayment.findUnique({ where: { id }, include: WITH_RECORDER });
    return row === null ? null : toRecord(row);
  }

  async correctPayment(
    tx: Tx,
    id: string,
    data: { value: PaymentValue; paidOn: string; comment: string | null; now: Date },
  ): Promise<void> {
    await tx.organizationPayment.update({
      where: { id },
      data: {
        ...data.value,
        paidOn: dateOf(data.paidOn),
        comment: data.comment,
        updatedAt: data.now,
      },
    });
  }

  async voidPayment(
    tx: Tx,
    id: string,
    data: { voidedBy: string; reason: string; now: Date },
  ): Promise<void> {
    await tx.organizationPayment.update({
      where: { id },
      data: {
        voidedAt: data.now,
        voidedBy: data.voidedBy,
        voidReason: data.reason,
        updatedAt: data.now,
      },
    });
  }

  /** Newest first, voided ones included. */
  async listPayments(
    organizationId: string,
    db: DbClient = this.prisma,
  ): Promise<OrganizationPaymentRecord[]> {
    const rows = await db.organizationPayment.findMany({
      where: { organizationId },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      include: WITH_RECORDER,
    });
    return rows.map(toRecord);
  }

  async paidTotal(organizationId: string, db: DbClient = this.prisma): Promise<Prisma.Decimal> {
    const result = await db.organizationPayment.aggregate({
      where: { organizationId, voidedAt: null },
      _sum: { amountUsd: true },
    });
    return result._sum.amountUsd ?? new Prisma.Decimal(0);
  }

  async receivedTotal(organizationId: string, db: DbClient = this.prisma): Promise<Prisma.Decimal> {
    const result = await db.order.aggregate({
      where: { organizationId, status: 'RECEIVED' },
      _sum: { totalUsd: true },
    });
    return result._sum.totalUsd ?? new Prisma.Decimal(0);
  }

  /** The organization's RECEIVED orders, oldest received first (order number breaks a tie). */
  async receivedOrdersOldestFirst(
    tx: Tx,
    organizationId: string,
  ): Promise<ReceivedOrderForAllocation[]> {
    return tx.order.findMany({
      where: { organizationId, status: 'RECEIVED' },
      orderBy: [{ receivedAt: 'asc' }, { orderNumber: 'asc' }],
      select: { id: true, totalUsd: true, paymentStatus: true },
    });
  }
}

function toRecord(row: {
  id: string;
  organizationId: string;
  amount: Prisma.Decimal;
  currency: string;
  rate: Prisma.Decimal | null;
  amountUsd: Prisma.Decimal;
  paidOn: Date;
  comment: string | null;
  recordedBy: string;
  recordedAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
  updatedAt: Date;
  recorder: { fullName: string };
}): OrganizationPaymentRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    amount: row.amount,
    // The column has a CHECK; a value outside it is a broken database, not a user error.
    currency: paymentCurrencySchema.parse(row.currency),
    rate: row.rate,
    amountUsd: row.amountUsd,
    paidOn: dayOf(row.paidOn),
    comment: row.comment,
    recordedByName: row.recorder.fullName,
    recordedByUserId: row.recordedBy,
    recordedAt: row.recordedAt,
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    updatedAt: row.updatedAt,
  };
}
