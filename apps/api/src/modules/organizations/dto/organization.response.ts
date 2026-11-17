import {
  priceTierOfLabel,
  type StaffOrganizationInviteResponse,
  type StaffOrganizationResponse,
  type StaffOrganizationSummary,
} from '@iorder/shared';
import type { Actor } from '../../../common/auth/actor.js';
import { can } from '../../../common/auth/can.js';
import { isTypeChangeable } from '../organization.view.js';
import type { OrganizationDetail, OrganizationInviteLink } from '../organizations.service.js';

/** Explicit allow-list mappers: staff-only DTOs (members' phones, the Telegram chat id). */
export function toStaffOrganizationSummary(
  detail: OrganizationDetail,
  actor: Actor,
): StaffOrganizationSummary {
  const { organization, members, invite, boundPerson } = detail;
  const showTelegram = can(actor, 'VIEW_TELEGRAM_IDS');
  const active = members.filter((m) => m.status === 'ACTIVE');
  const owner = active.find((m) => m.role === 'SHOP_OWNER');
  return {
    id: organization.id,
    name: organization.name,
    type: organization.type,
    label: organization.label,
    priceTier: priceTierOfLabel(organization.label),
    phone: organization.phone,
    // bigint -> decimal string: a JS number could lose precision.
    telegramChatId:
      showTelegram && organization.telegramChatId !== null
        ? organization.telegramChatId.toString()
        : null,
    status: organization.status,
    pricePostingEnabled: organization.pricePostingEnabled,
    activeMemberCount: active.length,
    shopOwner: owner ? { userId: owner.userId, fullName: owner.fullName } : null,
    addedBy: organization.addedBy
      ? {
          telegramUserId: showTelegram ? organization.addedBy.telegramUserId.toString() : null,
          name: organization.addedBy.name,
        }
      : null,
    invite: { status: invite.status, expiresAt: invite.expiresAt?.toISOString() ?? null },
    boundPerson: boundPerson
      ? {
          userId: boundPerson.userId,
          fullName: boundPerson.fullName,
          telegramUserId: showTelegram ? boundPerson.telegramUserId.toString() : null,
        }
      : null,
    typeChangeable: isTypeChangeable(detail),
    archivedAt: organization.archivedAt?.toISOString() ?? null,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}

export function toStaffOrganizationResponse(
  detail: OrganizationDetail,
  actor: Actor,
): StaffOrganizationResponse {
  return {
    ...toStaffOrganizationSummary(detail, actor),
    members: detail.members.map((m) => ({
      userId: m.userId,
      fullName: m.fullName,
      phone: m.phone,
      role: m.role,
      status: m.status,
      joinedAt: m.joinedAt.toISOString(),
      leftAt: m.leftAt ? m.leftAt.toISOString() : null,
    })),
  };
}

/**
 * The invite link: `https://t.me/<bot>?start=` for a PERSON, `?startgroup=` for a GROUP (Telegram
 * then asks which group to add the bot to). `botUsername` undefined = no bot on this server.
 */
export function toStaffOrganizationInviteResponse(
  link: OrganizationInviteLink,
  botUsername: string | undefined,
): StaffOrganizationInviteResponse {
  const parameter = link.type === 'PERSON' ? 'start' : 'startgroup';
  return {
    status: link.status,
    url:
      link.startPayload === null || botUsername === undefined
        ? null
        : `https://t.me/${botUsername}?${parameter}=${link.startPayload}`,
    expiresAt: link.expiresAt?.toISOString() ?? null,
  };
}
