import { Injectable } from '@nestjs/common';
import type { Tx } from '../../common/database/db-client.js';
import { PrismaService } from '../../common/database/prisma.service.js';

export interface LinkTokenRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface BotChatState {
  telegramUserId: bigint | null;
  botStartedAt: Date | null;
  botBlockedAt: Date | null;
}

/** Data access for the bot connect links and the "can the bot reach this person" facts. */
@Injectable()
export class StaffBotLinkRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insertToken(
    tx: Tx,
    row: { userId: string; tokenHash: string; createdAt: Date; expiresAt: Date },
  ): Promise<void> {
    await tx.telegramLinkToken.create({ data: row });
  }

  /** Locks the token row, so two Start presses with one link cannot both use it. */
  async lockTokenByHash(tx: Tx, tokenHash: string): Promise<LinkTokenRecord | null> {
    const rows = await tx.$queryRaw<
      { id: string; user_id: string; expires_at: Date; used_at: Date | null }[]
    >`SELECT id, user_id, expires_at, used_at FROM telegram_link_tokens
      WHERE token_hash = ${tokenHash} FOR UPDATE`;
    const row = rows[0];
    return row
      ? { id: row.id, userId: row.user_id, expiresAt: row.expires_at, usedAt: row.used_at }
      : null;
  }

  async markTokenUsed(tx: Tx, id: string, usedAt: Date): Promise<void> {
    await tx.telegramLinkToken.update({ where: { id }, data: { usedAt } });
  }

  async findChatState(userId: string): Promise<BotChatState | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramUserId: true, botStartedAt: true, botBlockedAt: true },
    });
  }

  /** Sets the Telegram id (only while none is set) and the bot start, in the caller's transaction. */
  async connect(
    tx: Tx,
    userId: string,
    data: { telegramUserId: bigint; startedAt: Date },
  ): Promise<void> {
    await tx.user.update({
      where: { id: userId },
      data: {
        telegramUserId: data.telegramUserId,
        botStartedAt: data.startedAt,
        updatedAt: data.startedAt,
      },
    });
  }

  /** A plain /start of a known person in a private chat. False when nobody has that id. */
  async markStartedByTelegramId(telegramUserId: bigint, at: Date): Promise<boolean> {
    const result = await this.prisma.user.updateMany({
      where: { telegramUserId },
      data: { botStartedAt: at },
    });
    return result.count === 1;
  }

  /** Telegram refused a private message to this chat (blocked or never started). */
  async markBlockedByTelegramId(telegramUserId: bigint, at: Date): Promise<void> {
    await this.prisma.user.updateMany({ where: { telegramUserId }, data: { botBlockedAt: at } });
  }
}
