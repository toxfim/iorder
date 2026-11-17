<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { useServices } from '@/app/services';
import {
  canArchiveOrganizations,
  canChangeOrganizationLabel,
  canManageOrganizations,
} from '@/features/staff-shell/organizations-access';
import AppBackLink from '@core/components/ui/AppBackLink.vue';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { showToast } from '@core/composables/use-toast';
import { useDocumentTitleDetail } from '@core/composables/use-document-title';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import BlockUserDialog from '@/features/staff-users/components/BlockUserDialog.vue';
import PersonAvatar from '@/features/directory/components/PersonAvatar.vue';
import { useFormat } from '@core/i18n/use-format';
import { ApiNotFoundError } from '@core/lib/api-errors';
import { formatPhone, telHref } from '@core/lib/phone';
import {
  ORGANIZATION_LABELS,
  ORGANIZATION_TYPES,
  type OrganizationLabel,
  type OrganizationType,
  type StaffOrganizationInviteResponse,
  type StaffOrganizationResponse,
} from '@iorder/shared';
import AppDropdown from '@/components/ui/AppDropdown.vue';
import type { OrganizationStatus } from '../api/organizations-api';
import { LABEL_TONE, STATUS_TONE, TYPE_TONE } from '../domain/organization-badges';
import {
  describeOrganizationError,
  displayStatusOf,
  inviteTimeLeft,
  isArchived,
  isLinked,
} from '../domain/organization-model';
import {
  forgetOrganizationsList,
  markOrganizationsListReturn,
  organizationsListLocation,
} from '../composables/organizations-list-memory';
import EditOrganizationDialog from './EditOrganizationDialog.vue';
import InviteLinkCard from './InviteLinkCard.vue';
import OrganizationBalanceSection from './OrganizationBalanceSection.vue';
import PersonName from '@/features/people/components/PersonName.vue';

const { t } = useI18n();
const route = useRoute();

// The back link returns to the list as it was left (its filters; the list restores its scroll).
// Leaving for anywhere else ends that: the list starts fresh next time.
// Only the back link and the browser's back count as a return (a sidebar or dashboard click to
// the list opens it at the top): the back link marks it, and so does a history step (pop).
const backTo = organizationsListLocation();
const router = useRouter();
const stopHistoryWatch = router.options.history.listen((_to, _from, info) => {
  if (info.type === 'pop') markOrganizationsListReturn();
});
onBeforeUnmount(stopHistoryWatch);
onBeforeRouteLeave((to) => {
  if (to.name !== 'staff-organizations') forgetOrganizationsList();
});
const { organizationsApi, waitingOrganizationsStore, directoryStore, currentUser, clock } =
  useServices();
const roles = computed(() => currentUser.user.value?.staffRoles ?? []);
const { formatDateTime } = useFormat();

const organizationId = computed(() => String(route.params.organizationId ?? ''));
const view = useAsyncView(() => organizationsApi.get(organizationId.value), {
  isEmpty: () => false,
});
watch(organizationId, () => void view.reload());

const org = computed(() => view.data.value);
// Archived ("deleted") [C, owner 2026-11-13]: read-only for everyone until the admin restores it
// (the server answers 409 ORGANIZATION_ARCHIVED to every write anyway). Payments stay open there
// (debt collection) [P], so the balance section is not locked.
const archived = computed(() => (org.value ? isArchived(org.value) : false));
// The purchasing manager reads this page; the server refuses every change anyway.
const canEdit = computed(() => canManageOrganizations(roles.value) && !archived.value);
// The label of an existing organization is the admin's to change [C, owner 2026-11-12].
const canEditLabel = computed(() => canChangeOrganizationLabel(roles.value) && !archived.value);
const canArchive = computed(() => canArchiveOrganizations(roles.value));
useDocumentTitleDetail(() => org.value?.name);

// A missing organization is an answer, not a failure: it gets its own wording and no retry.
const pageState = computed(() =>
  view.state.value === 'error' && view.error.value instanceof ApiNotFoundError
    ? 'empty'
    : view.state.value,
);

const currentMembers = computed(
  () => org.value?.members.filter((m) => m.status === 'ACTIVE') ?? [],
);
const formerMembers = computed(() => org.value?.members.filter((m) => m.status === 'LEFT') ?? []);

const pending = ref<OrganizationStatus | null>(null);
const busy = ref(false);
const dialogError = ref<string | null>(null);
const dialogOpen = computed({
  get: () => pending.value !== null,
  set: (open: boolean) => {
    if (!open && !busy.value) pending.value = null;
  },
});

function ask(next: OrganizationStatus): void {
  dialogError.value = null;
  pending.value = next;
}

async function confirm(): Promise<void> {
  const target = pending.value;
  const current = org.value;
  if (target === null || current === null || busy.value) return;
  busy.value = true;
  dialogError.value = null;
  try {
    const updated = await organizationsApi.setStatus(current.id, target);
    view.data.value = updated;
    void waitingOrganizationsStore.refresh();
    showToast({
      message: t(
        target === 'ACTIVE'
          ? 'organizations.actions.activated'
          : 'organizations.actions.deactivated',
        { name: updated.name },
      ),
    });
    pending.value = null;
  } catch (caught) {
    const described = describeOrganizationError(caught);
    dialogError.value = t(described.key);
    if (caught instanceof ApiNotFoundError) {
      // Gone: leave the dialog and show the not-found state.
      pending.value = null;
      void view.reload();
    } else if (described.reload) {
      await refreshQuietly(current.id);
      // The other person already made the change we asked for: nothing left to confirm.
      if (view.data.value?.status === target) pending.value = null;
    }
  } finally {
    busy.value = false;
  }
}

// Blocking a member asks whether to also remove them from this Telegram group. When the dialog
// closes the page re-reads the group, because a removal may have changed the member list.
// The target stays set after closing so the dialog can play its exit animation.
const blockTarget = ref<{ userId: string; name: string } | null>(null);
const blockShown = ref(false);
const blockOpen = computed({
  get: () => blockShown.value,
  set: (open: boolean) => {
    blockShown.value = open;
    if (!open && org.value) void refreshQuietly(org.value.id);
  },
});

function askBlock(member: { userId: string; fullName: string }): void {
  blockTarget.value = { userId: member.userId, name: member.fullName };
  blockShown.value = true;
}

// --- type, label, invite [C, owner 2026-11-11] ------------------------------------------------

const linked = computed(() => (org.value ? isLinked(org.value) : true));
const displayStatus = computed(() => (org.value ? displayStatusOf(org.value) : 'ACTIVE'));
const isPerson = computed(() => org.value?.type === 'PERSON');
// The bound person's phone is on their membership (the summary carries none).
const boundMember = computed(() =>
  org.value?.boundPerson
    ? (org.value.members.find((m) => m.userId === org.value?.boundPerson?.userId) ?? null)
    : null,
);

const labelOptions = computed(() =>
  ORGANIZATION_LABELS.map((value) => ({ value, label: t(`organizations.labels.${value}`) })),
);
const labelBusy = ref(false);

async function changeLabel(next: OrganizationLabel): Promise<void> {
  const current = org.value;
  if (!current || labelBusy.value || next === current.label) return;
  labelBusy.value = true;
  try {
    view.data.value = await organizationsApi.update(current.id, { label: next });
    showToast({
      message: t('organizations.detail.labelSaved', { label: t(`organizations.labels.${next}`) }),
    });
  } catch (caught) {
    showToast({ message: t(describeOrganizationError(caught).key) });
    await refreshQuietly(current.id);
  } finally {
    labelBusy.value = false;
  }
}

// The type changes only on an organization that was never bound [C, owner 2026-11-12; P]; the
// server says whether that is still so (`typeChangeable`). A link already sent was made for the
// old type and no longer binds, hence the confirmation.
const typeEditable = computed(() => canEdit.value && org.value?.typeChangeable === true);
const typeOptions = computed(() =>
  ORGANIZATION_TYPES.map((value) => ({ value, label: t(`organizations.types.${value}`) })),
);
const pendingType = ref<OrganizationType | null>(null);
const typeBusy = ref(false);
const typeError = ref<string | null>(null);
const typeDialogOpen = computed({
  get: () => pendingType.value !== null,
  set: (open: boolean) => {
    if (!open && !typeBusy.value) pendingType.value = null;
  },
});
function askType(next: OrganizationType): void {
  if (!org.value || next === org.value.type) return;
  typeError.value = null;
  pendingType.value = next;
}
async function changeType(): Promise<void> {
  const current = org.value;
  const next = pendingType.value;
  if (!current || !next || typeBusy.value) return;
  typeBusy.value = true;
  typeError.value = null;
  try {
    view.data.value = await organizationsApi.update(current.id, { type: next });
    pendingType.value = null;
    showToast({
      message: t('organizations.detail.typeSaved', { type: t(`organizations.types.${next}`) }),
    });
  } catch (caught) {
    const described = describeOrganizationError(caught);
    if (described.reload) {
      // The re-read shows the type as it now stands; a repeat would only be refused again.
      pendingType.value = null;
      showToast({ message: t(described.key) });
      await refreshQuietly(current.id);
    } else {
      typeError.value = t(described.key);
    }
  } finally {
    typeBusy.value = false;
  }
}

const editOpen = ref(false);
function onEdited(updated: StaffOrganizationResponse): void {
  view.data.value = updated;
}

// The link itself is a one-time secret only manager and admin read (the purchasing manager sees
// the invite status and its end from the organization).
const invite = ref<StaffOrganizationInviteResponse | null>(null);
const inviteFailed = ref(false);
let inviteRun = 0;
async function loadInvite(): Promise<void> {
  const current = org.value;
  const mine = ++inviteRun;
  invite.value = null;
  inviteFailed.value = false;
  if (!current || !canEdit.value || isLinked(current)) return;
  try {
    const answer = await organizationsApi.getInvite(current.id);
    if (mine === inviteRun) invite.value = answer;
  } catch {
    if (mine === inviteRun) inviteFailed.value = true;
  }
}
// `canEdit` follows the archive: a restore makes the link readable again (and an archive ends it).
watch(
  () => [org.value?.id, org.value?.invite.status, org.value?.type, canEdit.value] as const,
  () => void loadInvite(),
  { immediate: true },
);
const readerTimeLeft = computed(() =>
  org.value ? inviteTimeLeft(org.value.invite.expiresAt, clock.now()) : null,
);

const regenerateOpen = ref(false);
const regenerating = ref(false);
const regenerateError = ref<string | null>(null);
function askRegenerate(): void {
  regenerateError.value = null;
  regenerateOpen.value = true;
}
async function regenerate(): Promise<void> {
  const current = org.value;
  if (!current || regenerating.value) return;
  regenerating.value = true;
  regenerateError.value = null;
  try {
    invite.value = await organizationsApi.regenerateInvite(current.id);
    regenerateOpen.value = false;
    showToast({ message: t('organizations.invite.regenerated') });
    await refreshQuietly(current.id);
  } catch (caught) {
    const described = describeOrganizationError(caught);
    regenerateError.value = t(described.key);
    if (described.reload) await refreshQuietly(current.id);
  } finally {
    regenerating.value = false;
  }
}

// --- archive ("delete") and restore, admin only [C, owner 2026-11-13] ---------------------------

const archiveOpen = ref(false);
const archiveBusy = ref(false);
const archiveError = ref<string | null>(null);
function askArchive(): void {
  archiveError.value = null;
  archiveOpen.value = true;
}
async function archive(): Promise<void> {
  const current = org.value;
  if (!current || archiveBusy.value) return;
  archiveBusy.value = true;
  archiveError.value = null;
  try {
    view.data.value = await organizationsApi.archive(current.id);
    archiveOpen.value = false;
    void waitingOrganizationsStore.refresh();
    // Its people left with it: Mijozlar and the command palette read the directory again.
    void directoryStore.load();
    // The undo restores THIS organization, even after the page moved on to another one.
    const archivedId = current.id;
    showToast({
      message: t('organizations.archive.done', { name: current.name }),
      undoLabel: t('common.undo'),
      onUndo: () => void restore(archivedId, current.name),
    });
  } catch (caught) {
    const described = describeOrganizationError(caught);
    archiveError.value = t(described.key);
    if (described.reload) await refreshQuietly(current.id);
  } finally {
    archiveBusy.value = false;
  }
}

const restoring = ref(false);
async function restore(id: string, name: string): Promise<void> {
  if (restoring.value) return;
  restoring.value = true;
  try {
    const restored = await organizationsApi.restore(id);
    // Only the organization on screen takes the answer (the undo may come from another page).
    if (org.value?.id === id) view.data.value = restored;
    void waitingOrganizationsStore.refresh();
    void directoryStore.load();
    showToast({ message: t('organizations.archive.restored', { name }) });
  } catch (caught) {
    const described = describeOrganizationError(caught);
    showToast({ message: t(described.key) });
    if (described.reload && org.value?.id === id) await refreshQuietly(id);
  } finally {
    restoring.value = false;
  }
}

// After a conflict the page shows what the server has now, without flashing the loading state.
async function refreshQuietly(id: string): Promise<void> {
  try {
    view.data.value = await organizationsApi.get(id);
  } catch {
    // The next navigation or retry reports it; the message above already told the person.
  }
}
</script>

<template>
  <div class="page">
    <AppBackLink :to="backTo" @back="markOrganizationsListReturn">{{
      t('organizations.detail.back')
    }}</AppBackLink>
    <StateView
      :state="pageState"
      :title="pageState === 'empty' ? t('organizations.detail.notFound') : undefined"
      :description="pageState === 'empty' ? t('organizations.detail.notFoundHint') : undefined"
      @retry="view.reload()"
    >
      <template v-if="org">
        <!-- v8 company card: mark, name with status pill, the action, then the fact strip. -->
        <section class="card summary">
          <header class="head">
            <span class="head__mark" aria-hidden="true">
              <StaffIcon :name="isPerson ? 'user' : 'building'" :size="24" />
            </span>
            <div class="head__main">
              <div class="head__title-row">
                <h1 class="head__title">{{ org.name }}</h1>
                <AppBadge :tone="TYPE_TONE[org.type]">{{
                  t(`organizations.types.${org.type}`)
                }}</AppBadge>
                <AppBadge :tone="LABEL_TONE[org.label]" data-testid="head-label">{{
                  t(`organizations.labels.${org.label}`)
                }}</AppBadge>
                <AppBadge v-if="archived" tone="muted" data-testid="head-archived">{{
                  t('organizations.archive.badge')
                }}</AppBadge>
                <AppBadge v-else :tone="STATUS_TONE[displayStatus]" dot data-testid="head-status">
                  {{ t(`organizations.status.${displayStatus}`) }}
                </AppBadge>
              </div>
            </div>
            <AppButton
              v-if="canEdit"
              variant="secondary"
              size="sm"
              data-testid="edit-organization"
              @click="editOpen = true"
            >
              <StaffIcon name="pencil" :size="14" />{{ t('organizations.detail.edit') }}
            </AppButton>
            <!-- An organization without its chat cannot be activated by hand: its invite does it. -->
            <AppButton
              v-if="canEdit && org.status === 'INACTIVE' && linked"
              variant="primary"
              size="sm"
              :disabled="busy"
              data-testid="activate"
              @click="ask('ACTIVE')"
            >
              {{ t('organizations.actions.activate') }}
            </AppButton>
            <AppButton
              v-else-if="canEdit && org.status === 'ACTIVE'"
              variant="secondary"
              size="sm"
              :disabled="busy"
              data-testid="deactivate"
              @click="ask('INACTIVE')"
            >
              {{ t('organizations.actions.deactivate') }}
            </AppButton>
            <AppButton
              v-if="canArchive && archived"
              variant="primary"
              size="sm"
              :loading="restoring"
              data-testid="restore"
              @click="restore(org.id, org.name)"
            >
              <StaffIcon name="refresh" :size="14" />{{ t('organizations.archive.restore') }}
            </AppButton>
            <AppButton
              v-else-if="canArchive"
              variant="danger"
              size="sm"
              data-testid="archive"
              @click="askArchive"
            >
              <StaffIcon name="trash" :size="14" />{{ t('organizations.archive.action') }}
            </AppButton>
          </header>

          <p v-if="archived" class="head__note" role="status" data-testid="archived-banner">
            <StaffIcon name="archive" :size="16" class="head__note-icon" />
            {{
              canArchive
                ? t('organizations.archive.bannerAdmin')
                : t('organizations.archive.banner')
            }}
          </p>
          <p
            v-else-if="org.status === 'INACTIVE' && !linked"
            class="head__note"
            role="status"
            data-testid="unlinked-note"
          >
            <StaffIcon name="lock" :size="16" class="head__note-icon" />
            {{ t('organizations.detail.unlinkedNote') }}
          </p>
          <p v-else-if="org.status === 'INACTIVE'" class="head__note" role="status">
            <StaffIcon name="alert" :size="16" class="head__note-icon" />
            {{ t('organizations.detail.waitingNote') }}
          </p>

          <dl class="facts">
            <div class="fact">
              <dt>{{ t('organizations.detail.type') }}</dt>
              <dd>
                <AppDropdown
                  v-if="typeEditable"
                  :model-value="org.type"
                  :options="typeOptions"
                  :label="t('organizations.detail.type')"
                  min-width="150px"
                  data-testid="type-dropdown"
                  @update:model-value="askType($event as OrganizationType)"
                />
                <template v-else>{{ t(`organizations.types.${org.type}`) }}</template>
              </dd>
            </div>
            <div class="fact">
              <dt>{{ t('organizations.detail.label') }}</dt>
              <dd>
                <AppDropdown
                  v-if="canEditLabel"
                  :model-value="org.label"
                  :options="labelOptions"
                  :label="t('organizations.detail.label')"
                  min-width="150px"
                  data-testid="label-dropdown"
                  @update:model-value="changeLabel($event as OrganizationLabel)"
                />
                <template v-else>{{ t(`organizations.labels.${org.label}`) }}</template>
              </dd>
              <dd class="fact__sub">{{ t(`organizations.tiers.${org.priceTier}`) }}</dd>
            </div>
            <div class="fact">
              <dt>{{ t('organizations.detail.phone') }}</dt>
              <dd>
                <a v-if="org.phone" :href="telHref(org.phone)" class="mono">{{
                  formatPhone(org.phone)
                }}</a>
                <span v-else>—</span>
              </dd>
            </div>
            <div v-if="org.telegramChatId !== null" class="fact">
              <dt>
                {{
                  isPerson
                    ? t('organizations.detail.telegramPerson')
                    : t('organizations.detail.chatId')
                }}
              </dt>
              <dd class="mono">{{ org.telegramChatId }}</dd>
            </div>
            <div v-else-if="!linked" class="fact">
              <dt>{{ t('organizations.detail.telegram') }}</dt>
              <dd class="fact__muted">{{ t('organizations.detail.notLinked') }}</dd>
            </div>
            <div class="fact">
              <dt>
                {{
                  org.addedBy
                    ? t('organizations.detail.addedBy')
                    : t('organizations.detail.addedByStaff')
                }}
              </dt>
              <dd>
                <PersonName
                  v-if="org.addedBy"
                  :name="org.addedBy.name"
                  :telegram-user-id="org.addedBy.telegramUserId"
                />
                <template v-else>—</template>
              </dd>
            </div>
            <div class="fact">
              <dt>{{ t('organizations.detail.addedAt') }}</dt>
              <dd>{{ formatDateTime(org.createdAt) }}</dd>
            </div>
            <div class="fact">
              <dt>{{ t('organizations.detail.updatedAt') }}</dt>
              <dd>{{ formatDateTime(org.updatedAt) }}</dd>
            </div>
            <div v-if="!isPerson" class="fact">
              <dt>{{ t('organizations.detail.owner') }}</dt>
              <dd>
                <PersonName
                  v-if="org.shopOwner"
                  :name="org.shopOwner.fullName"
                  :user-id="org.shopOwner.userId"
                />
                <template v-else>{{ t('organizations.detail.noOwner') }}</template>
              </dd>
            </div>
            <div class="fact">
              <dt>
                {{
                  isPerson
                    ? t('organizations.detail.pricePostingPerson')
                    : t('organizations.detail.pricePosting')
                }}
              </dt>
              <dd>
                {{
                  org.pricePostingEnabled
                    ? t('organizations.detail.on')
                    : t('organizations.detail.off')
                }}
              </dd>
            </div>
          </dl>
        </section>

        <!-- Design 3A: the one-time link while nothing is bound. -->
        <section
          v-if="!linked && !archived"
          class="card block"
          aria-labelledby="invite-title"
          data-testid="invite-section"
        >
          <h2 id="invite-title" class="block__title">{{ t('organizations.invite.title') }}</h2>
          <InviteLinkCard
            v-if="invite"
            :invite="invite"
            :type="org.type"
            :can-regenerate="canEdit"
            :regenerating="regenerating"
            @regenerate="askRegenerate"
          />
          <p v-else-if="inviteFailed" class="block__note" role="alert">
            {{ t('organizations.invite.loadFailed') }}
            <AppButton variant="secondary" size="xs" @click="loadInvite">
              {{ t('state.retry') }}
            </AppButton>
          </p>
          <!-- A reader (purchasing manager) sees the state and its end, never the link. -->
          <p v-else-if="!canEdit" class="block__note" data-testid="invite-reader">
            <AppBadge v-if="readerTimeLeft" tone="warning">{{
              t('organizations.invite.timeLeft', readerTimeLeft)
            }}</AppBadge>
            <AppBadge v-else tone="danger">{{ t('organizations.invite.expired') }}</AppBadge>
          </p>
          <p v-else class="block__note" role="status">{{ t('state.loading') }}</p>
        </section>

        <OrganizationBalanceSection :organization-id="org.id" />

        <!-- Design 3A/3B: a PERSON has one customer, bound through the invite. -->
        <section
          v-if="isPerson"
          class="card members"
          aria-labelledby="customer-title"
          data-testid="customer-section"
        >
          <header class="members__head">
            <h2 id="customer-title" class="members__title">
              {{ t('organizations.detail.customer') }}
            </h2>
            <span class="members__count">{{
              org.boundPerson
                ? t('organizations.detail.customerLinked')
                : t('organizations.detail.customerPending')
            }}</span>
          </header>
          <div v-if="org.boundPerson" class="person person--single">
            <span class="person__who">
              <PersonAvatar :name="org.boundPerson.fullName" />
              <span class="person__main">
                <span class="person__name"
                  ><PersonName :name="org.boundPerson.fullName" :user-id="org.boundPerson.userId"
                /></span>
                <span v-if="org.boundPerson.telegramUserId" class="person__meta mono">
                  {{ t('organizations.detail.telegramPerson') }}:
                  {{ org.boundPerson.telegramUserId }}
                </span>
              </span>
            </span>
            <span class="person__phone">
              <a v-if="boundMember?.phone" :href="telHref(boundMember.phone)" class="mono">{{
                formatPhone(boundMember.phone)
              }}</a>
              <span v-else class="person__none">{{ t('organizations.detail.noPhone') }}</span>
            </span>
            <span class="person__role">
              <AppBadge tone="accent">{{ t('roles.organization.SHOP_OWNER') }}</AppBadge>
            </span>
            <span class="person__action" />
          </div>
          <p v-else class="empty" role="status">
            {{ t('organizations.detail.customerPendingHint') }}
          </p>
        </section>

        <section v-else class="card members" aria-labelledby="members-title">
          <header class="members__head">
            <h2 id="members-title" class="members__title">
              {{ t('organizations.detail.members') }}
            </h2>
            <span class="members__count">
              {{
                t(
                  'organizations.detail.memberCount',
                  { count: currentMembers.length },
                  currentMembers.length,
                )
              }}
            </span>
          </header>
          <ul class="people" :aria-label="t('organizations.detail.membersList')">
            <li
              v-for="m in [...currentMembers, ...formerMembers]"
              :key="m.userId"
              class="person"
              :class="{ 'person--former': m.status === 'LEFT' }"
            >
              <span class="person__who">
                <PersonAvatar :name="m.fullName" />
                <span class="person__main">
                  <span class="person__name"
                    ><PersonName :name="m.fullName" :user-id="m.userId"
                  /></span>
                  <span class="person__meta">
                    {{
                      m.status === 'LEFT' && m.leftAt
                        ? t('organizations.detail.left', { date: formatDateTime(m.leftAt) })
                        : t('organizations.detail.joined', { date: formatDateTime(m.joinedAt) })
                    }}
                  </span>
                </span>
              </span>
              <span class="person__phone">
                <a v-if="m.phone" :href="telHref(m.phone)" class="mono">{{
                  formatPhone(m.phone)
                }}</a>
                <span v-else class="person__none">{{ t('organizations.detail.noPhone') }}</span>
              </span>
              <span class="person__role">
                <AppBadge v-if="m.status === 'LEFT'" tone="muted">
                  {{ t('organizations.detail.former') }}
                </AppBadge>
                <AppBadge v-else :tone="m.role === 'SHOP_OWNER' ? 'accent' : 'neutral'">
                  {{ t(`roles.organization.${m.role}`) }}
                </AppBadge>
              </span>
              <span class="person__action">
                <AppButton
                  v-if="canEdit && m.status === 'ACTIVE'"
                  size="xs"
                  variant="secondary"
                  :aria-label="t('staffUsers.block.title', { name: m.fullName })"
                  data-testid="member-block"
                  @click="askBlock(m)"
                >
                  {{ t('staffUsers.block.confirm') }}
                </AppButton>
              </span>
            </li>
            <li v-if="org.members.length === 0" class="empty" role="status">
              {{ t('organizations.detail.noMembers') }}
            </li>
          </ul>
        </section>

        <AppConfirmDialog
          v-model="dialogOpen"
          :title="
            pending === 'ACTIVE'
              ? t('organizations.actions.activateTitle')
              : t('organizations.actions.deactivateTitle')
          "
          :description="
            pending === 'ACTIVE'
              ? t('organizations.actions.activateBody', { name: org.name })
              : t('organizations.actions.deactivateBody', { name: org.name })
          "
          :confirm-label="
            pending === 'ACTIVE'
              ? t('organizations.actions.confirmActivate')
              : t('organizations.actions.confirmDeactivate')
          "
          :tone="pending === 'ACTIVE' ? 'primary' : 'danger'"
          :loading="busy"
          :error="dialogError"
          @confirm="confirm"
        />
        <AppConfirmDialog
          v-if="canEdit"
          v-model="regenerateOpen"
          :title="t('organizations.invite.regenerateTitle')"
          :description="t('organizations.invite.regenerateBody')"
          :confirm-label="t('organizations.invite.regenerateConfirm')"
          tone="danger"
          :loading="regenerating"
          :error="regenerateError"
          @confirm="regenerate"
        />
        <AppConfirmDialog
          v-if="canEdit"
          v-model="typeDialogOpen"
          :title="t('organizations.detail.typeChangeTitle')"
          :description="
            t('organizations.detail.typeChangeBody', {
              name: org.name,
              type: pendingType ? t(`organizations.types.${pendingType}`) : '',
            })
          "
          :confirm-label="t('organizations.detail.typeChangeConfirm')"
          :loading="typeBusy"
          :error="typeError"
          @confirm="changeType"
        />
        <EditOrganizationDialog
          v-if="canEdit"
          v-model="editOpen"
          :organization="org"
          @saved="onEdited"
        />
        <AppConfirmDialog
          v-if="canArchive"
          v-model="archiveOpen"
          :title="t('organizations.archive.title')"
          :description="t('organizations.archive.body', { name: org.name })"
          :confirm-label="t('organizations.archive.confirm')"
          tone="danger"
          :loading="archiveBusy"
          :error="archiveError"
          @confirm="archive"
        />
        <BlockUserDialog
          v-if="blockTarget"
          v-model="blockOpen"
          :user-id="blockTarget.userId"
          :name="blockTarget.name"
          :groups="[org.name]"
        />
      </template>
    </StateView>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  animation: viewIn 0.35s var(--ease) both;
}

/* v8 white hairline card. */
.card {
  border-radius: var(--r-card);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
}

.summary {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
}

.head__mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 10px;
  background: var(--acc-bg);
  color: var(--acc);
}

.head__main {
  display: flex;
  flex: 1 1 220px;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.head__title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.head__title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.head__note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0;
  padding: 12px 16px;
  border-radius: var(--r-row);
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: var(--fs-small);
}

.head__note-icon {
  margin-top: 1px;
}

/* v8 fact strip: hairline cells (the 1px gap shows the hairline colour behind white cells). */
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
  gap: 1px;
  margin: 0;
  overflow: hidden;
  border-radius: var(--r-btn-sm);
  background: var(--e8);
  box-shadow: 0 0 0 1px var(--e8);
}

.fact {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  background: var(--w);
}

.fact dt {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.fact dd {
  margin: 0;
  font-size: var(--fs-small);
  font-weight: 500;
  overflow-wrap: anywhere;
}

.fact .fact__sub,
.fact .fact__muted {
  font-size: var(--fs-meta);
  font-weight: 400;
  color: var(--t2);
}

.block {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
}

.block__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.block__note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--fs-small);
  color: var(--t2);
}

.person--single:hover {
  background: transparent;
}

.members {
  overflow: hidden;
}

.members__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  padding: 20px;
  border-bottom: 1px solid var(--e8);
}

.members__title {
  margin: 0;
  font-size: var(--fs-section);
  font-weight: 600;
}

.members__count {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.people {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* v8 table-like rows: 59px minimum, hairline between rows, hover tint. */
.person {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) 130px 96px;
  align-items: center;
  gap: 8px 16px;
  min-height: 59px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--e8);
  font-size: var(--fs-small);
  transition: background-color 0.15s ease;
}

.person:last-child {
  border-bottom: 0;
}

.person:hover {
  background: var(--hov);
}

.person--former .person__name {
  color: var(--t2);
}

.person__who {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.person__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.person__name {
  overflow-wrap: anywhere;
}

.person__meta,
.person__none {
  font-size: var(--fs-meta);
  color: var(--t2);
}

.person__phone {
  font-variant-numeric: tabular-nums;
}

.person__action {
  display: flex;
  justify-content: flex-end;
}

.empty {
  padding: 40px 20px;
  text-align: center;
  font-size: var(--fs-small);
  color: var(--t2);
}

@media (max-width: 720px) {
  .person {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .person__phone {
    grid-column: 1;
    padding-left: 42px;
  }

  .person__role {
    grid-column: 2;
    grid-row: 1;
    justify-self: end;
  }

  .person__action {
    grid-column: 2;
    grid-row: 2;
  }
}
</style>
