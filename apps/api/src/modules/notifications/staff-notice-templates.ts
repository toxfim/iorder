import type { Locale } from '@iorder/shared';
import {
  membershipConflictPayloadSchema,
  organizationLinkedPayloadSchema,
  organizationPendingPayloadSchema,
  type StaffNoticeType,
} from '../../common/outbox/staff-notices.js';

// Texts of the staff notices (not about one order). PURE: payload JSON in, plain text out. The
// payload is read through the allow-list schemas of `staff-notices.ts`; Telegram-supplied names
// are printed as plain text (the sender uses no parse mode, so no markup is interpreted).

interface Wording {
  pending: (name: string, chatId: string, by: string | null) => string;
  pendingHint: string;
  conflict: (person: string, telegramUserId: string, organization: string) => string;
  linked: (organization: string) => string;
}

const WORDING: Record<Locale, Wording> = {
  UZ: {
    pending: (name, chatId, by) =>
      `Yangi mijoz guruhi faollashtirishni kutmoqda: ${name} (chat ${chatId}).${by === null ? '' : `\nBotni qo'shgan: ${by}.`}`,
    pendingHint:
      "Tashkilot faol bo'lgunga qadar guruh a'zolari buyurtma bera olmaydi. Faollashtirgandan keyin a'zolar tizimda o'zlarining keyingi xabari yoki guruhga qo'shilishi bilan paydo bo'ladi.",
    conflict: (person, id, organization) =>
      `${person} (Telegram ${id}) allaqachon boshqa tashkilot a'zosi, shuning uchun "${organization}" guruhiga qo'shilmadi. Kerak bo'lsa, avval uni eski tashkilotdan chiqaring.`,
    linked: (organization) =>
      `"${organization}" tashkiloti botga ulandi va faollashdi: narx ro'yxati va buyurtma xabarlari endi u yerga boradi.`,
  },
  RU: {
    pending: (name, chatId, by) =>
      `Новая группа клиента ожидает активации: ${name} (чат ${chatId}).${by === null ? '' : `\nБота добавил: ${by}.`}`,
    pendingHint:
      'Пока организация не активна, участники группы не могут делать заказы. После активации участники появятся в системе при своём следующем сообщении или при вступлении в группу.',
    conflict: (person, id, organization) =>
      `${person} (Telegram ${id}) уже состоит в другой организации, поэтому не добавлен в группу «${organization}». При необходимости сначала удалите его из прежней организации.`,
    linked: (organization) =>
      `Организация «${organization}» подключилась к боту и активна: прайс-лист и сообщения о заказах теперь идут туда.`,
  },
  EN: {
    pending: (name, chatId, by) =>
      `A new customer group is waiting for activation: ${name} (chat ${chatId}).${by === null ? '' : `\nThe bot was added by: ${by}.`}`,
    pendingHint:
      'Until the organization is active, the group members cannot place orders. After activation, members appear in the system on their next message or when they join the group.',
    conflict: (person, id, organization) =>
      `${person} (Telegram ${id}) is already a member of another organization, so they were not added to "${organization}". If needed, remove them from the old organization first.`,
    linked: (organization) =>
      `The organization "${organization}" connected to the bot and is active: the price list and order messages now go there.`,
  },
};

export interface StaffNoticeInput {
  type: StaffNoticeType;
  locale: Locale;
  payload: unknown;
}

/** The text for one staff notice, or null when the payload does not match its allow-list. */
export function renderStaffNotice(input: StaffNoticeInput): string | null {
  const wording = WORDING[input.locale];
  switch (input.type) {
    case 'ORGANIZATION_PENDING': {
      const parsed = organizationPendingPayloadSchema.safeParse(input.payload);
      if (!parsed.success) return null;
      const { organizationName, chatId, addedByName, addedByTelegramUserId } = parsed.data;
      const by =
        addedByName === undefined
          ? null
          : `${addedByName}${addedByTelegramUserId === undefined ? '' : ` (Telegram ${addedByTelegramUserId})`}`;
      return `${wording.pending(organizationName, chatId, by)}\n${wording.pendingHint}`;
    }
    case 'MEMBERSHIP_CONFLICT': {
      const parsed = membershipConflictPayloadSchema.safeParse(input.payload);
      if (!parsed.success) return null;
      const { personName, telegramUserId, organizationName } = parsed.data;
      return wording.conflict(personName, telegramUserId, organizationName);
    }
    case 'ORGANIZATION_LINKED': {
      const parsed = organizationLinkedPayloadSchema.safeParse(input.payload);
      return parsed.success ? wording.linked(parsed.data.organizationName) : null;
    }
  }
}
