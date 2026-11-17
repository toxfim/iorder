import type { Prisma } from '../../generated/prisma/client.js';

/**
 * A client for reads: accepts a transaction client or the PrismaService itself, so a read
 * works both inside and outside a transaction.
 */
export type DbClient = Prisma.TransactionClient;

declare const transactionBrand: unique symbol;

/**
 * A client that is PROVABLY inside a transaction. The brand exists only in the type system and
 * is added in exactly one place (`runInTransaction`). PrismaService is not assignable to it,
 * so code that must be atomic with another write (the audit log) cannot be handed the plain
 * client by mistake: that fails to compile.
 */
export type Tx = DbClient & { readonly [transactionBrand]: true };
