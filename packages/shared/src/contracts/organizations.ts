import { z } from 'zod';
import { isoInstantSchema } from './common.js';
import {
  organizationRoleSchema,
  phoneSchema,
  telegramChatIdSchema,
  telegramUserIdSchema,
  typedPhoneSchema,
} from './identity.js';

export const ORGANIZATION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export const organizationStatusSchema = z.enum(ORGANIZATION_STATUSES);

export const MEMBER_STATUSES = ['ACTIVE', 'LEFT'] as const;
export const memberStatusSchema = z.enum(MEMBER_STATUSES);

/**
 * What an organization is [C, owner 2026-11-11]: `GROUP` = a Telegram group (every organization
 * before that date), `PERSON` = one individual who talks to the bot in a private chat.
 */
export const ORGANIZATION_TYPES = ['GROUP', 'PERSON'] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];
export const organizationTypeSchema = z.enum(ORGANIZATION_TYPES);

/**
 * The organization's label [C, owner 2026-11-11]: RU «Стандартный» / «Оптовик» / «Партнер», and
 * since 2026-11-12 [C, owner] «Alif factoring». STANDARD is the default. The label decides the price
 * tier (PRICE_TIER_OF_LABEL).
 */
export const ORGANIZATION_LABELS = ['STANDARD', 'WHOLESALE', 'PARTNER', 'ALIF_FACTORING'] as const;
export type OrganizationLabel = (typeof ORGANIZATION_LABELS)[number];
export const organizationLabelSchema = z.enum(ORGANIZATION_LABELS);
export const DEFAULT_ORGANIZATION_LABEL = 'STANDARD' satisfies OrganizationLabel;

/**
 * The price tiers of the price list [C, owner 2026-11-11]: «Стандартный» and «Оптовик/Партнер»,
 * and since 2026-11-12 [C, owner] «Alif factoring». Every price list item has its STANDARD prices;
 * the WHOLESALE_PARTNER and ALIF_FACTORING prices are optional per item. A WHOLESALE_PARTNER item
 * without its own price falls back to STANDARD [P]; an ALIF_FACTORING one is NOT offered to that
 * tier at all [C, owner 2026-11-12].
 */
export const PRICE_TIERS = ['STANDARD', 'WHOLESALE_PARTNER', 'ALIF_FACTORING'] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];
export const priceTierSchema = z.enum(PRICE_TIERS);

/**
 * THE one place that maps a label to its price tier [C, owner 2026-11-11]: wholesale customers and
 * partners share one tier "for now". Change only here when the owner splits them.
 */
export const PRICE_TIER_OF_LABEL: Readonly<Record<OrganizationLabel, PriceTier>> = Object.freeze({
  STANDARD: 'STANDARD',
  WHOLESALE: 'WHOLESALE_PARTNER',
  PARTNER: 'WHOLESALE_PARTNER',
  ALIF_FACTORING: 'ALIF_FACTORING',
});

export function priceTierOfLabel(label: OrganizationLabel): PriceTier {
  return PRICE_TIER_OF_LABEL[label];
}

/**
 * The bot invite of an organization [P]: PENDING (a link works), EXPIRED (the last link ran out, or
 * none was made; staff regenerate one), LINKED (bound to a chat; no link any more). A GROUP the bot
 * registered by itself is LINKED from the start.
 */
export const ORGANIZATION_INVITE_STATUSES = ['PENDING', 'EXPIRED', 'LINKED'] as const;
export type OrganizationInviteStatus = (typeof ORGANIZATION_INVITE_STATUSES)[number];
export const organizationInviteStatusSchema = z.enum(ORGANIZATION_INVITE_STATUSES);

/** How long an organization invite link works when the server sets nothing else [P]: 7 days. */
export const DEFAULT_ORGANIZATION_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * The `start` / `startgroup` payload of an organization invite: `org_` + 43 characters (Telegram
 * allows 1-64 of A-Z a-z 0-9 _ -). The prefix keeps it apart from the staff connect payload.
 */
export const ORGANIZATION_INVITE_START_PREFIX = 'org_';
export const organizationInviteStartPayloadSchema = z
  .string()
  .regex(/^org_[A-Za-z0-9_-]{43}$/, 'not an organization invite payload');

export const staffOrganizationListQuerySchema = z.strictObject({
  /** Case-insensitive match over the organization name. */
  search: z.string().trim().min(1).max(100).optional(),
  status: organizationStatusSchema.optional(),
  type: organizationTypeSchema.optional(),
  label: organizationLabelSchema.optional(),
  /**
   * [C, owner 2026-11-13] archived organizations are left out by default; `true` lists only them.
   */
  archived: z.enum(['true', 'false']).default('false'),
});
export type StaffOrganizationListQuery = z.output<typeof staffOrganizationListQuerySchema>;

const organizationName = z.string().trim().min(1).max(200);

/**
 * POST /staff/organizations (manager, admin) [C, owner 2026-11-11]. `type` is required; `label`
 * defaults to STANDARD. Staff never type a Telegram id: the answer carries a one-time bot link
 * (PERSON: `t.me/<bot>?start=`, GROUP: `t.me/<bot>?startgroup=`) and whoever uses it binds the
 * chat. Until then the organization is INACTIVE and gets nothing.
 */
export const createOrganizationRequestSchema = z.strictObject({
  type: organizationTypeSchema,
  name: organizationName,
  /** The contact phone staff call (typed form, normalized to +digits); null/omitted = none. */
  phone: typedPhoneSchema.nullable().default(null),
  label: organizationLabelSchema.default(DEFAULT_ORGANIZATION_LABEL),
});
export type CreateOrganizationRequest = z.output<typeof createOrganizationRequestSchema>;

// The Telegram chat id is the chat's identity and is never edited here.
export const updateOrganizationRequestSchema = z
  .strictObject({
    name: organizationName.optional(),
    /**
     * [C, owner 2026-11-12]: manager/admin change it, but only while no Telegram chat is bound [P]
     * (409 ORGANIZATION_ALREADY_LINKED otherwise). The open invite link follows the new type.
     */
    type: organizationTypeSchema.optional(),
    status: organizationStatusSchema.optional(),
    pricePostingEnabled: z.boolean().optional(),
    /** [C, owner 2026-11-11]: manager/admin change it; existing orders keep their tier. */
    label: organizationLabelSchema.optional(),
    /** null clears it. */
    phone: typedPhoneSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to change');
export type UpdateOrganizationRequest = z.output<typeof updateOrganizationRequestSchema>;

/** The person becomes (or is promoted to) the organization's shop owner. */
export const assignShopOwnerRequestSchema = z.strictObject({ userId: z.uuid() });
export type AssignShopOwnerRequest = z.output<typeof assignShopOwnerRequestSchema>;

export const changeMemberRoleRequestSchema = z.strictObject({ role: organizationRoleSchema });
export type ChangeMemberRoleRequest = z.output<typeof changeMemberRoleRequestSchema>;

export const staffMemberResponseSchema = z.strictObject({
  userId: z.uuid(),
  fullName: z.string(),
  phone: z.string().nullable(),
  role: organizationRoleSchema,
  status: memberStatusSchema,
  joinedAt: isoInstantSchema,
  leftAt: isoInstantSchema.nullable(),
});
export type StaffMemberResponse = z.infer<typeof staffMemberResponseSchema>;

/** Staff view of an organization's invite. The link itself: GET /staff/organizations/:id/invite. */
export const staffOrganizationInviteSummarySchema = z.strictObject({
  status: organizationInviteStatusSchema,
  /** When the current link stops working; null when LINKED or no link was ever made. */
  expiresAt: isoInstantSchema.nullable(),
});
export type StaffOrganizationInviteSummary = z.infer<typeof staffOrganizationInviteSummarySchema>;

/**
 * The invite link (staff-only, never cached) [P]. `url` is null unless the status is PENDING, and
 * also when the bot is not configured on this server.
 */
export const staffOrganizationInviteResponseSchema = z.strictObject({
  status: organizationInviteStatusSchema,
  url: z.url().startsWith('https://t.me/').nullable(),
  expiresAt: isoInstantSchema.nullable(),
});
export type StaffOrganizationInviteResponse = z.infer<typeof staffOrganizationInviteResponseSchema>;

const organizationFields = {
  id: z.uuid(),
  name: z.string(),
  type: organizationTypeSchema,
  label: organizationLabelSchema,
  /** The tier the label maps to (PRICE_TIER_OF_LABEL), so the UI never re-derives it. */
  priceTier: priceTierSchema,
  /** The organization's contact phone entered by staff; null = none. */
  phone: phoneSchema.nullable(),
  /**
   * Null for a role that may not know Telegram ids (the server decides by role), and while a
   * staff-created organization is not bound yet. For a bound PERSON it is the person's private
   * chat (= their Telegram user id).
   */
  telegramChatId: telegramChatIdSchema.nullable(),
  status: organizationStatusSchema,
  pricePostingEnabled: z.boolean(),
  activeMemberCount: z.number().int().nonnegative(),
  shopOwner: z.strictObject({ userId: z.uuid(), fullName: z.string() }).nullable(),
  /** Who added the bot, for groups the bot created; null for organizations staff created. */
  addedBy: z
    .strictObject({ telegramUserId: telegramUserIdSchema.nullable(), name: z.string() })
    .nullable(),
  invite: staffOrganizationInviteSummarySchema,
  /**
   * PERSON only: the Telegram account bound by the invite (its shop owner); null before binding
   * and for a GROUP. `telegramUserId` is null for a role that may not know Telegram ids.
   */
  boundPerson: z
    .strictObject({
      userId: z.uuid(),
      fullName: z.string(),
      telegramUserId: telegramUserIdSchema.nullable(),
    })
    .nullable(),
  /**
   * Whether `type` may still change (PATCH): the server's own rule, never bound (no chat, no member
   * history, not merged). The UI offers the change only when this is true.
   */
  typeChangeable: z.boolean(),
  /**
   * [C, owner 2026-11-13] "deleting" an organization archives it (admin only): it leaves the lists,
   * stays INACTIVE and keeps its whole history; restoring clears this. Null = not archived.
   */
  archivedAt: isoInstantSchema.nullable(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
};

export const staffOrganizationSummarySchema = z.strictObject(organizationFields);
export type StaffOrganizationSummary = z.infer<typeof staffOrganizationSummarySchema>;

export const staffOrganizationListResponseSchema = z.strictObject({
  items: z.array(staffOrganizationSummarySchema),
});
export type StaffOrganizationListResponse = z.infer<typeof staffOrganizationListResponseSchema>;

/** Detail: the summary plus every member, current and former. */
export const staffOrganizationResponseSchema = z.strictObject({
  ...organizationFields,
  members: z.array(staffMemberResponseSchema),
});
export type StaffOrganizationResponse = z.infer<typeof staffOrganizationResponseSchema>;

/** Response of POST /staff/organizations: the new organization and its first invite link. */
export const createOrganizationResponseSchema = z.strictObject({
  organization: staffOrganizationResponseSchema,
  invite: staffOrganizationInviteResponseSchema,
});
export type CreateOrganizationResponse = z.infer<typeof createOrganizationResponseSchema>;
