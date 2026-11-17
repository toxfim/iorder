import { Injectable, Logger } from '@nestjs/common';
import {
  MARKED_ORDER_NOTIFICATION_TYPES,
  type MarkedOrderNotification,
} from '@iorder/shared/staff-auth';
import { z } from 'zod';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { ForbiddenError } from '../../common/errors/domain-errors.js';
import { OrdersRepository } from './orders.repository.js';

const LIST_LIMIT = 30;

const typeSchema = z.enum(MARKED_ORDER_NOTIFICATION_TYPES);
// Only what the list shows is read out of the row: its payload also carries selling figures.
const payloadSchema = z.object({
  orderNumber: z.string(),
  orderLines: z.array(
    z.object({
      productCode: z.string(),
      name: z.string(),
      quantity: z.string(),
      marked: z.boolean(),
    }),
  ),
});

/**
 * The purchasing manager's in-app notifications ([C] owner 2026-10-31: "tizim va bot orqali"). They
 * read the very outbox rows the bot sends, so the two can never disagree and nothing new is
 * written. A person without a started bot still sees them here.
 */
@Injectable()
export class MarkedOrderNotificationsService {
  private readonly logger = new Logger(MarkedOrderNotificationsService.name);

  constructor(private readonly repository: OrdersRepository) {}

  async list(actor: Actor): Promise<MarkedOrderNotification[]> {
    if (!can(actor, 'VIEW_MARKED_ORDER_NOTIFICATIONS')) {
      throw new ForbiddenError('Not allowed to read these notifications');
    }
    const rows = await this.repository.findRoleNotifications('PURCHASING_MANAGER', LIST_LIMIT);
    return rows.flatMap((row) => {
      const type = typeSchema.safeParse(row.type);
      const payload = payloadSchema.safeParse(row.payload);
      if (!type.success || !payload.success || row.orderId === null) {
        this.logger.warn(`Skipped a malformed purchasing notification row ${row.id}`);
        return [];
      }
      return [
        {
          id: row.id,
          type: type.data,
          orderId: row.orderId,
          orderNumber: payload.data.orderNumber,
          createdAt: row.createdAt.toISOString(),
          lines: payload.data.orderLines
            .filter((line) => line.marked)
            .map(({ productCode, name, quantity }) => ({ productCode, name, quantity })),
        },
      ];
    });
  }
}
