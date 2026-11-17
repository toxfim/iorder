<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import {
  ORGANIZATION_LABELS,
  ORGANIZATION_TYPES,
  type OrganizationLabel,
  type OrganizationType,
  type StaffOrganizationResponse,
  type StaffOrganizationSummary,
} from '@iorder/shared';
import { dismissToast, showToast, useToast } from '@core/composables/use-toast';
import { ApiNotFoundError } from '@core/lib/api-errors';
import { useServices } from '@/app/services';
import AppBadge from '@core/components/ui/AppBadge.vue';
import AppButton from '@core/components/ui/AppButton.vue';
import AppConfirmDialog from '@core/components/ui/AppConfirmDialog.vue';
import AppSegmented from '@/components/ui/AppSegmented.vue';
import type { RowMenuItem } from '@/components/ui/RowContextMenu.vue';
import StaffIcon from '@/components/ui/StaffIcon.vue';
import { initialsOf } from '@/features/directory/domain/directory-model';
import AppDropdown from '@/components/ui/AppDropdown.vue';
import DataTable from '@/components/ui/DataTable.vue';
import type { DataTableColumn } from '@/components/ui/data-table';
import FilterField from '@/components/ui/FilterField.vue';
import FilterPanel from '@/components/ui/FilterPanel.vue';
import { useMediaQuery } from '@/composables/use-media-query';
import SearchField from '@core/components/ui/SearchField.vue';
import StateView from '@core/components/ui/StateView.vue';
import { useAsyncView } from '@core/composables/use-async-view';
import { useFormat } from '@core/i18n/use-format';
import { LABEL_TONE, STATUS_TONE, TYPE_TONE } from '../domain/organization-badges';
import {
  countWaiting,
  describeOrganizationError,
  displayStatusOf,
  filterOrganizations,
  isArchived,
  isLinked,
  sortInactiveFirst,
  type OrganizationLabelFilter,
  type OrganizationStatusFilter,
  type OrganizationTypeFilter,
} from '../domain/organization-model';
import {
  filtersFromQuery,
  forgetOrganizationsList,
  queryOfFilters,
  rememberOrganizationsList,
  takeOrganizationsListScroll,
  type OrganizationsListScroll,
} from '../composables/organizations-list-memory';
import PersonName from '@/features/people/components/PersonName.vue';
import {
  canArchiveOrganizations,
  canChangeOrganizationLabel,
  canManageOrganizations,
} from '@/features/staff-shell/organizations-access';
import type { OrganizationStatus } from '../api/organizations-api';
import ChangeTypeDialog from './ChangeTypeDialog.vue';
import CreateOrganizationDialog from './CreateOrganizationDialog.vue';
import EditOrganizationDialog from './EditOrganizationDialog.vue';
import InlineBadgeSelect from './InlineBadgeSelect.vue';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { organizationsApi, waitingOrganizationsStore, directoryStore, currentUser } = useServices();
// UI convenience: the api already sends a reader null for the chat id and refuses their writes.
const canManage = computed(() => canManageOrganizations(currentUser.user.value?.staffRoles ?? []));
// The label of an existing organization is the admin's to change [C, owner 2026-11-12].
const canEditLabel = computed(() =>
  canChangeOrganizationLabel(currentUser.user.value?.staffRoles ?? []),
);
// "Delete" = archive, and its restore: the admin alone [C, owner 2026-11-13].
const canArchive = computed(() =>
  canArchiveOrganizations(currentUser.user.value?.staffRoles ?? []),
);
const showsChatId = canManage;
// On a phone the filter grid cell sets the dropdown width (see the 640px rule in the styles).
const phone = useMediaQuery('(max-width: 640px)', false);
const filterMinWidth = (desktop: string): string => (phone.value ? '0' : desktop);
const { formatDateTime } = useFormat();

// The search and filters live in the URL query (replace, not push: typing is not history), so the
// way back from an organization, a reload and a shared link show the same list.
const initial = filtersFromQuery(route.query);
const query = ref(initial.search);
const status = ref<OrganizationStatusFilter>(initial.status);
const type = ref<OrganizationTypeFilter>(initial.type);
const label = ref<OrganizationLabelFilter>(initial.label);
// The archive is a separate server list (`archived=true`), not a filter over the loaded rows.
const archivedView = ref(initial.archived);

const view = useAsyncView(async () => {
  if (archivedView.value) return organizationsApi.list({ archived: true });
  const items = await organizationsApi.list();
  // The page just read the whole list, so the nav badge needs no second request.
  waitingOrganizationsStore.set(countWaiting(items));
  return items;
});
watch(archivedView, () => void view.reload());

// Both directions only while this page is the current route: on the way out `route` already
// describes the next page, and its (empty) query must not reset the filters or the URL.
const onThisPage = (): boolean => route.name === 'staff-organizations';
watch(
  [query, status, type, label, archivedView],
  ([search, nextStatus, nextType, nextLabel, archived]) => {
    if (!onThisPage()) return;
    void router.replace({
      query: queryOfFilters({
        search,
        status: nextStatus,
        type: nextType,
        label: nextLabel,
        archived,
      }),
    });
  },
);
// The other way round: a navigation to this same page (the sidebar link without a query, a
// shared link) changes only the query, the page stays mounted, so the filters follow the URL.
watch(
  () => route.query,
  (next) => {
    if (!onThisPage()) return;
    const filters = filtersFromQuery(next);
    query.value = filters.search;
    status.value = filters.status;
    type.value = filters.type;
    label.value = filters.label;
    archivedView.value = filters.archived;
  },
);

// list -> organization -> back (link or browser) returns to the same place [owner 2026-11-12].
// The shell scrolls to the top on every page change; this runs later, once the rows are shown.
// Both scroll boxes count: the document, and on wide screens the table's own 72vh box.
const root = ref<HTMLElement | null>(null);
const tableScroller = (): HTMLElement | null =>
  root.value?.querySelector<HTMLElement>('.dt__scroll') ?? null;
onBeforeRouteLeave((to, from) => {
  if (to.name === 'staff-organization') {
    rememberOrganizationsList({
      fullPath: from.fullPath,
      windowY: window.scrollY,
      tableTop: tableScroller()?.scrollTop ?? 0,
    });
  } else {
    forgetOrganizationsList();
  }
});
const pendingScroll = takeOrganizationsListScroll(route.fullPath);
if (pendingScroll) restoreWhenShown(pendingScroll);

function restoreWhenShown(scroll: OrganizationsListScroll): void {
  const stop = watch(view.state, async (state) => {
    if (state === 'loading') return;
    stop();
    if (state !== 'ready') return;
    await nextTick();
    const box = tableScroller();
    if (box) box.scrollTop = scroll.tableTop;
    window.scrollTo?.({ top: scroll.windowY, left: 0 });
  });
}

const all = computed(() => view.data.value ?? []);
// The archive waits for nobody (countWaiting skips archived rows anyway).
const waiting = computed(() => (archivedView.value ? 0 : countWaiting(all.value)));
const unlinked = computed(() => all.value.filter((o) => !isLinked(o)).length);
const rows = computed(() =>
  sortInactiveFirst(
    filterOrganizations(all.value, {
      search: query.value,
      status: status.value,
      type: type.value,
      label: label.value,
    }),
  ),
);
const countOf = (kind: StaffOrganizationSummary['type']): number =>
  all.value.filter((o) => o.type === kind).length;
const infoText = computed(
  () =>
    `${t(
      archivedView.value ? 'organizations.archive.info' : 'organizations.info',
      { count: all.value.length },
      all.value.length,
    )} · ${t('organizations.infoTypes', {
      groups: countOf('GROUP'),
      persons: countOf('PERSON'),
    })}`,
);
const viewOptions = computed(() => [
  { value: 'list' as const, label: t('organizations.archive.listView') },
  { value: 'archive' as const, label: t('organizations.archive.archiveView') },
]);

const statusOptions = computed(() => [
  { value: 'all', label: t('organizations.filters.all'), count: all.value.length },
  { value: 'INACTIVE', label: t('organizations.filters.INACTIVE'), count: waiting.value },
  { value: 'UNLINKED', label: t('organizations.filters.UNLINKED'), count: unlinked.value },
  {
    value: 'ACTIVE',
    label: t('organizations.filters.ACTIVE'),
    count: all.value.filter((o) => o.status === 'ACTIVE').length,
  },
]);
const typeOptions = computed(() => [
  { value: 'all', label: t('organizations.filters.all'), count: all.value.length },
  ...ORGANIZATION_TYPES.map((value) => ({
    value,
    label: t(`organizations.types.${value}`),
    count: countOf(value),
  })),
]);
const labelOptions = computed(() => [
  { value: 'all', label: t('organizations.filters.all'), count: all.value.length },
  ...ORGANIZATION_LABELS.map((value) => ({
    value,
    label: t(`organizations.labels.${value}`),
    count: all.value.filter((o) => o.label === value).length,
  })),
]);

type OrganizationListItem = StaffOrganizationSummary;

const ownerText = (o: OrganizationListItem): string =>
  o.shopOwner
    ? t('organizations.row.owner', { name: o.shopOwner.fullName })
    : t('organizations.row.noOwner');
const memberText = (o: OrganizationListItem): string =>
  t('organizations.row.members', { count: o.activeMemberCount }, o.activeMemberCount);
const addedText = (o: OrganizationListItem): string =>
  o.addedBy
    ? `${t('organizations.row.addedBy')}: ${o.addedBy.name} · ${formatDateTime(o.createdAt)}`
    : `${t('organizations.row.addedByStaff')}: ${formatDateTime(o.createdAt)}`;
const statusText = (o: OrganizationListItem): string =>
  t(`organizations.status.${displayStatusOf(o)}`);

const columns = computed<DataTableColumn<OrganizationListItem>[]>(() =>
  (
    [
      {
        key: 'name',
        label: t('organizations.columns.name'),
        truncate: true,
        // The name is what people scan for: it keeps room before the inline dropdowns and the
        // owner take theirs (narrower screens scroll sideways instead of cutting it short).
        minWidth: '180px',
        text: (o) => o.name,
        compare: (a, b) => a.name.localeCompare(b.name),
      },
      {
        key: 'type',
        label: t('organizations.columns.type'),
        // Room for the inline dropdown (badge + chevron) where a type may still change.
        width: hasInlineControls.value ? '120px' : '100px',
        text: (o) => t(`organizations.types.${o.type}`),
      },
      {
        key: 'label',
        label: t('organizations.columns.label'),
        width: canEditLabel.value ? '140px' : '110px',
        text: (o) => t(`organizations.labels.${o.label}`),
      },
      {
        key: 'owner',
        label: t('organizations.columns.owner'),
        truncate: true,
        hideOnCard: true,
        // A share, not a fixed width: it gives way first on a narrower screen, the name does not.
        width: '15%',
        text: ownerText,
      },
      {
        key: 'chat',
        label: t('organizations.columns.telegram'),
        width: '160px',
        text: (o) => o.telegramChatId ?? (isLinked(o) ? '' : t('organizations.row.notLinked')),
      },
      {
        key: 'members',
        label: t('organizations.columns.members'),
        align: 'end',
        width: '100px',
        text: memberText,
        compare: (a, b) => a.activeMemberCount - b.activeMemberCount,
      },
      { key: 'status', label: t('organizations.filters.status'), width: '180px' },
    ] satisfies DataTableColumn<OrganizationListItem>[] as DataTableColumn<OrganizationListItem>[]
  ).filter((column) => column.key !== 'chat' || showsChatId.value),
);

// The server returns no rows at all: nothing to filter, so the page itself is the empty state.
// An empty archive is still the page (its table says the archive is empty). Once the page was
// shown, a later read (the Ro'yxat/Arxiv switch, a reload) keeps the header and the switch and
// shows its loading in the table's place only.
const shownOnce = ref(false);
watch(
  () => view.state.value,
  (state) => {
    if (state === 'ready' || state === 'empty') shownOnce.value = true;
  },
  { immediate: true },
);
const tableLoading = computed(() => shownOnce.value && view.state.value === 'loading');
const pageState = computed(() => {
  if (tableLoading.value) return 'ready';
  return archivedView.value && view.state.value === 'empty' ? 'ready' : view.state.value;
});

const createOpen = ref(false);
function onCreated(): void {
  void view.reload();
}
function openOrganization(organizationId: string): void {
  void router.push({ name: 'staff-organization', params: { organizationId } });
}

// --- type and label right in the list [owner 2026-11-12] -------------------------------------
// A change replaces only its own row with the server's answer: no reload, so no loading state and
// no jump to the top.

const labelChoices = computed(() =>
  ORGANIZATION_LABELS.map((value) => ({ value, label: t(`organizations.labels.${value}`) })),
);
const typeChoices = computed(() =>
  ORGANIZATION_TYPES.map((value) => ({ value, label: t(`organizations.types.${value}`) })),
);
// The server says whether the type may still change (`typeChangeable`); the UI never guesses.
// Nothing on an archived organization changes until the admin restores it.
const typeEditable = (o: OrganizationListItem): boolean =>
  canManage.value && o.typeChangeable && !isArchived(o);
const labelEditable = (o: OrganizationListItem): boolean => canEditLabel.value && !isArchived(o);
const hasInlineControls = computed(() =>
  all.value.some((o) => labelEditable(o) || typeEditable(o)),
);

const saving = ref(new Set<string>());

/**
 * Puts the server's answer in place of its row. A row that is archived now while the list shows
 * the active ones (or the other way round) leaves this view instead: an archived organization
 * must never sit in the normal list, still editable.
 */
function putRow(next: StaffOrganizationResponse): void {
  const { members: _members, ...summary } = next;
  void _members;
  if (isArchived(summary) !== archivedView.value) {
    dropRow(summary.id);
    return;
  }
  view.data.value = (view.data.value ?? []).map((o) => (o.id === summary.id ? summary : o));
}

/** After a refusal the row shows what the server has now; a vanished one leaves the list. */
async function rereadRow(id: string): Promise<void> {
  try {
    putRow(await organizationsApi.get(id));
  } catch (caught) {
    if (caught instanceof ApiNotFoundError) {
      view.data.value = (view.data.value ?? []).filter((o) => o.id !== id);
    }
    // Anything else: the row shows what was there before the refusal, which may be outdated.
    else showToast({ message: t('organizations.inline.rowOutdated') });
  }
}

// The toast that offers to undo a row's label change. A newer change on that row takes the offer
// away (its own toast follows): an undo then would restore a value the person already replaced.
let undoOffer: { toastId: number; organizationId: string } | null = null;
function withdrawUndoOffer(organizationId: string): void {
  if (undoOffer?.organizationId !== organizationId) return;
  if (useToast().toast.value?.id === undoOffer.toastId) dismissToast();
  undoOffer = null;
}

async function changeLabel(id: string, next: OrganizationLabel, undoable = true): Promise<void> {
  const row = all.value.find((o) => o.id === id);
  if (!row || row.label === next || saving.value.has(id)) return;
  const previous = row.label;
  withdrawUndoOffer(id);
  saving.value.add(id);
  try {
    putRow(await organizationsApi.update(id, { label: next }));
    const label = t(`organizations.labels.${next}`);
    if (undoable) {
      const toastId = showToast({
        message: t('organizations.detail.labelSaved', { label }),
        undoLabel: t('common.undo'),
        onUndo: () => {
          undoOffer = null;
          void changeLabel(id, previous, false);
        },
      });
      undoOffer = { toastId, organizationId: id };
    } else {
      showToast({ message: t('organizations.inline.labelRestored', { label }) });
    }
  } catch (caught) {
    const described = describeOrganizationError(caught);
    showToast({ message: t(described.key) });
    if (described.reload) await rereadRow(id);
  } finally {
    saving.value.delete(id);
  }
}

const typeTarget = ref<{ organization: OrganizationListItem; type: OrganizationType } | null>(null);
const typeDialogOpen = ref(false);
function askType(row: OrganizationListItem, next: OrganizationType): void {
  if (next === row.type) return;
  typeTarget.value = { organization: row, type: next };
  typeDialogOpen.value = true;
}
function onTypeStale(id: string, message: string): void {
  showToast({ message });
  void rereadRow(id);
}

// --- the row's context menu [owner 2026-11-13] -----------------------------------------------
// Right click, long press, Shift+F10 or the touch "⋯" button: the actions of one organization,
// only those the role may take (UI convenience; the server refuses the rest). Each item reuses
// the flow the detail page or the inline controls already have.

type RowMenuId =
  | 'open'
  | 'openTab'
  | 'edit'
  | 'activate'
  | 'deactivate'
  | 'changeType'
  | 'changeLabel'
  | 'copyInvite'
  | 'copyChatId'
  | 'archive'
  | 'restore';

const otherType = (o: OrganizationListItem): OrganizationType =>
  o.type === 'GROUP' ? 'PERSON' : 'GROUP';

function rowMenuOf(o: OrganizationListItem): RowMenuItem<RowMenuId>[] {
  const items: RowMenuItem<RowMenuId>[] = [
    { id: 'open', label: t('organizations.menu.open'), icon: 'right' },
    { id: 'openTab', label: t('organizations.menu.openTab'), icon: 'external' },
  ];
  if (isArchived(o)) {
    if (canArchive.value) {
      items.push({ id: 'restore', label: t('organizations.archive.restore'), icon: 'refresh' });
    }
    return items.map((item) => ({ ...item, testId: `row-menu-${item.id}` }));
  }
  if (canManage.value) {
    items.push({ id: 'edit', label: t('organizations.menu.edit'), icon: 'pencil' });
    // An unbound organization is activated by its invite, never by hand.
    if (o.status === 'INACTIVE' && isLinked(o)) {
      items.push({ id: 'activate', label: t('organizations.actions.activate'), icon: 'check' });
    } else if (o.status === 'ACTIVE') {
      items.push({ id: 'deactivate', label: t('organizations.actions.deactivate'), icon: 'lock' });
    }
    if (typeEditable(o)) {
      items.push({
        id: 'changeType',
        label: t('organizations.menu.changeType', {
          type: t(`organizations.types.${otherType(o)}`),
        }),
        icon: 'refresh',
      });
    }
  }
  if (canEditLabel.value) {
    items.push({ id: 'changeLabel', label: t('organizations.menu.changeLabel'), icon: 'tag' });
  }
  if (canManage.value && o.invite.status === 'PENDING') {
    items.push({ id: 'copyInvite', label: t('organizations.menu.copyInvite'), icon: 'link' });
  }
  if (canManage.value && o.telegramChatId !== null) {
    items.push({ id: 'copyChatId', label: t('organizations.menu.copyChatId'), icon: 'copy' });
  }
  if (canArchive.value) {
    items.push({
      id: 'archive',
      label: t('organizations.archive.action'),
      icon: 'trash',
      tone: 'danger',
    });
  }
  return items.map((item) => ({ ...item, testId: `row-menu-${item.id}` }));
}

const rowMenuLabel = (o: OrganizationListItem): string =>
  t('organizations.menu.label', { name: o.name });

function onRowMenu(o: OrganizationListItem, id: string): void {
  switch (id as RowMenuId) {
    case 'open':
      openOrganization(o.id);
      break;
    case 'openTab':
      openInNewTab(o.id);
      break;
    case 'edit':
      editTarget.value = o;
      editOpen.value = true;
      break;
    case 'activate':
      askStatus(o, 'ACTIVE');
      break;
    case 'deactivate':
      askStatus(o, 'INACTIVE');
      break;
    case 'changeType':
      askType(o, otherType(o));
      break;
    case 'changeLabel':
      askLabel(o);
      break;
    case 'copyInvite':
      void copyInvite(o);
      break;
    case 'copyChatId':
      if (o.telegramChatId !== null) void copyText(o.telegramChatId, 'chatId');
      break;
    case 'archive':
      askArchive(o);
      break;
    case 'restore':
      void restore(o);
      break;
  }
}

function openInNewTab(organizationId: string): void {
  const { href } = router.resolve({ name: 'staff-organization', params: { organizationId } });
  window.open(href, '_blank', 'noopener');
}

// The clipboard may be unavailable (insecure context, denied permission): the toast then shows
// the value, so it can still be read off.
async function copyText(value: string, what: 'chatId' | 'invite'): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    showToast({ message: t(`organizations.menu.copied.${what}`) });
  } catch {
    showToast({ message: t('organizations.menu.copyFailed', { value }) });
  }
}

// The link is a one-time secret: read only on demand, never kept in the list.
async function copyInvite(o: OrganizationListItem): Promise<void> {
  try {
    const invite = await organizationsApi.getInvite(o.id);
    if (invite.url !== null) await copyText(invite.url, 'invite');
    else if (invite.status === 'PENDING') {
      showToast({ message: t('organizations.invite.botMissing') });
    } else {
      showToast({ message: t('organizations.menu.inviteGone') });
      await rereadRow(o.id);
    }
  } catch (caught) {
    const described = describeOrganizationError(caught);
    showToast({ message: t(described.key) });
    if (described.reload) await rereadRow(o.id);
  }
}

const editTarget = ref<OrganizationListItem | null>(null);
const editOpen = ref(false);

// Activate / deactivate from the menu: the same confirmation the detail page asks for.
const statusTarget = ref<{
  organization: OrganizationListItem;
  status: OrganizationStatus;
} | null>(null);
const statusBusy = ref(false);
const statusError = ref<string | null>(null);
const statusOpen = computed({
  get: () => statusTarget.value !== null,
  set: (open: boolean) => {
    if (!open && !statusBusy.value) statusTarget.value = null;
  },
});
function askStatus(o: OrganizationListItem, next: OrganizationStatus): void {
  statusError.value = null;
  statusTarget.value = { organization: o, status: next };
}
async function confirmStatus(): Promise<void> {
  const target = statusTarget.value;
  if (!target || statusBusy.value) return;
  statusBusy.value = true;
  statusError.value = null;
  try {
    const updated = await organizationsApi.setStatus(target.organization.id, target.status);
    putRow(updated);
    waitingOrganizationsStore.set(countWaiting(all.value));
    statusTarget.value = null;
    showToast({
      message: t(
        target.status === 'ACTIVE'
          ? 'organizations.actions.activated'
          : 'organizations.actions.deactivated',
        { name: updated.name },
      ),
    });
  } catch (caught) {
    const described = describeOrganizationError(caught);
    if (described.reload) {
      statusTarget.value = null;
      showToast({ message: t(described.key) });
      await rereadRow(target.organization.id);
    } else {
      statusError.value = t(described.key);
    }
  } finally {
    statusBusy.value = false;
  }
}

// The label from the menu (admin): a small dialog with the same choices as the inline control.
const labelTarget = ref<OrganizationListItem | null>(null);
const labelChoice = ref<OrganizationLabel>('STANDARD');
const labelOpen = computed({
  get: () => labelTarget.value !== null,
  set: (open: boolean) => {
    if (!open) labelTarget.value = null;
  },
});
function askLabel(o: OrganizationListItem): void {
  labelChoice.value = o.label;
  labelTarget.value = o;
}
function confirmLabel(): void {
  const target = labelTarget.value;
  labelTarget.value = null;
  if (target) void changeLabel(target.id, labelChoice.value);
}

// "O'chirish" = archive [C, owner 2026-11-13]: confirmed, then the row leaves the list with an
// undo (= restore) in its toast.
const archiveTarget = ref<OrganizationListItem | null>(null);
const archiveBusy = ref(false);
const archiveError = ref<string | null>(null);
const archiveOpen = computed({
  get: () => archiveTarget.value !== null,
  set: (open: boolean) => {
    if (!open && !archiveBusy.value) archiveTarget.value = null;
  },
});
function askArchive(o: OrganizationListItem): void {
  archiveError.value = null;
  archiveTarget.value = o;
}
function dropRow(id: string): void {
  view.data.value = (view.data.value ?? []).filter((o) => o.id !== id);
}
async function confirmArchive(): Promise<void> {
  const target = archiveTarget.value;
  if (!target || archiveBusy.value) return;
  archiveBusy.value = true;
  archiveError.value = null;
  try {
    const archived = await organizationsApi.archive(target.id);
    archiveTarget.value = null;
    withdrawUndoOffer(target.id);
    dropRow(target.id);
    waitingOrganizationsStore.set(countWaiting(all.value));
    // Its people left with it: Mijozlar and the command palette read the directory again.
    void directoryStore.load();
    showToast({
      message: t('organizations.archive.done', { name: archived.name }),
      undoLabel: t('common.undo'),
      onUndo: () => void restore(archived),
    });
  } catch (caught) {
    const described = describeOrganizationError(caught);
    archiveError.value = t(described.key);
    if (caught instanceof ApiNotFoundError) {
      archiveTarget.value = null;
      dropRow(target.id);
    } else if (described.reload) {
      await rereadRow(target.id);
    }
  } finally {
    archiveBusy.value = false;
  }
}

/**
 * Back from the archive (admin). It comes back INACTIVE and unlinked (a new invite binds it), which
 * the toast says. In the archive view the row leaves it; in the list (the undo of an archive) the
 * row comes back, and when the current filters hide it the toast says that too.
 */
async function restore(o: Pick<OrganizationListItem, 'id' | 'name'>): Promise<void> {
  try {
    const restored = await organizationsApi.restore(o.id);
    const { members: _members, ...summary } = restored;
    void _members;
    let hidden = false;
    if (archivedView.value) dropRow(o.id);
    else {
      view.data.value = [...(view.data.value ?? []).filter((r) => r.id !== o.id), summary];
      hidden =
        filterOrganizations([summary], {
          search: query.value,
          status: status.value,
          type: type.value,
          label: label.value,
        }).length === 0;
    }
    void waitingOrganizationsStore.refresh();
    void directoryStore.load();
    showToast({
      message: t(
        hidden ? 'organizations.archive.restoredHidden' : 'organizations.archive.restored',
        {
          name: restored.name,
        },
      ),
    });
  } catch (caught) {
    showToast({ message: t(describeOrganizationError(caught).key) });
  }
}
</script>

<template>
  <StateView
    :state="pageState"
    :description="pageState === 'empty' ? t('organizations.empty') : undefined"
    @retry="view.reload()"
  >
    <template #actions>
      <AppButton v-if="canManage" data-testid="add-organization-empty" @click="createOpen = true">
        <StaffIcon name="plus" :size="16" />{{ t('organizations.add') }}
      </AppButton>
      <AppButton variant="secondary" data-testid="open-archive-empty" @click="archivedView = true">
        <StaffIcon name="archive" :size="16" />{{ t('organizations.archive.archiveView') }}
      </AppButton>
    </template>
    <div ref="root" class="orgs">
      <header class="head">
        <div class="head__text">
          <h1 class="head__title">{{ t('organizations.title') }}</h1>
          <span class="head__info" data-testid="orgs-info">{{ infoText }}</span>
        </div>
        <div class="head__actions">
          <AppSegmented
            :model-value="archivedView ? 'archive' : 'list'"
            :options="viewOptions"
            :label="t('organizations.archive.viewGroup')"
            data-testid="orgs-view"
            @update:model-value="archivedView = $event === 'archive'"
          />
          <button
            v-if="canManage && !archivedView"
            type="button"
            class="chip"
            data-testid="add-organization"
            @click="createOpen = true"
          >
            <StaffIcon name="plus" :size="16" class="chip__icon" />
            {{ t('organizations.add') }}
          </button>
        </div>
      </header>

      <p v-if="archivedView" class="note" role="status" data-testid="archive-note">
        <StaffIcon name="archive" :size="16" class="banner__icon" />
        {{ t('organizations.archive.note') }}
      </p>

      <p v-if="waiting > 0" class="banner" role="status" data-testid="waiting-banner">
        <StaffIcon name="alert" :size="16" class="banner__icon" />
        {{ t('organizations.waitingBanner', { count: waiting }, waiting) }}
      </p>

      <FilterPanel class="filters" :aria-label="t('organizations.filters.group')">
        <SearchField v-model="query" class="search" :placeholder="t('organizations.search')" />
        <FilterField :label="t('organizations.filters.type')">
          <AppDropdown
            :model-value="type"
            :options="typeOptions"
            :label="t('organizations.filters.type')"
            :min-width="filterMinWidth('160px')"
            @update:model-value="type = $event as OrganizationTypeFilter"
          />
        </FilterField>
        <FilterField :label="t('organizations.filters.label')">
          <AppDropdown
            :model-value="label"
            :options="labelOptions"
            :label="t('organizations.filters.label')"
            :min-width="filterMinWidth('160px')"
            @update:model-value="label = $event as OrganizationLabelFilter"
          />
        </FilterField>
        <FilterField class="filters__wide" :label="t('organizations.filters.status')">
          <AppDropdown
            :model-value="status"
            :options="statusOptions"
            :label="t('organizations.filters.status')"
            :min-width="filterMinWidth('220px')"
            @update:model-value="status = $event as OrganizationStatusFilter"
          />
        </FilterField>
      </FilterPanel>

      <StateView v-if="tableLoading" state="loading" data-testid="orgs-table-loading" />
      <DataTable
        v-else
        :columns="columns"
        :rows="rows"
        :row-key="(o: OrganizationListItem) => o.id"
        :row-to="
          (o: OrganizationListItem) => ({
            name: 'staff-organization',
            params: { organizationId: o.id },
          })
        "
        :row-tone="(o: OrganizationListItem) => (o.status === 'INACTIVE' ? 'warning' : undefined)"
        :label="t('organizations.list')"
        :empty-text="
          archivedView && all.length === 0
            ? t('organizations.archive.empty')
            : t('organizations.emptyFiltered')
        "
        :row-menu="rowMenuOf"
        :row-menu-label="rowMenuLabel"
        @row-menu-choose="onRowMenu"
      >
        <template #cell-name="{ row }">
          <span class="org">
            <span class="org__mark" aria-hidden="true">{{ initialsOf(row.name) }}</span>
            <span class="row__name">{{ row.name }}</span>
          </span>
        </template>
        <template #cell-type="{ row }">
          <InlineBadgeSelect
            v-if="typeEditable(row)"
            :model-value="row.type"
            :options="typeChoices"
            :label="
              t('organizations.inline.typeFor', {
                name: row.name,
                value: t(`organizations.types.${row.type}`),
              })
            "
            :tone="TYPE_TONE[row.type]"
            :text="t(`organizations.types.${row.type}`)"
            data-testid="inline-type"
            @update:model-value="askType(row, $event as OrganizationType)"
          />
          <AppBadge v-else :tone="TYPE_TONE[row.type]">{{
            t(`organizations.types.${row.type}`)
          }}</AppBadge>
        </template>
        <template #cell-label="{ row }">
          <InlineBadgeSelect
            v-if="labelEditable(row)"
            :model-value="row.label"
            :options="labelChoices"
            :label="
              t('organizations.inline.labelFor', {
                name: row.name,
                value: t(`organizations.labels.${row.label}`),
              })
            "
            :tone="LABEL_TONE[row.label]"
            :text="t(`organizations.labels.${row.label}`)"
            :saving="saving.has(row.id)"
            data-testid="inline-label"
            @update:model-value="changeLabel(row.id, $event as OrganizationLabel)"
          />
          <AppBadge v-else :tone="LABEL_TONE[row.label]" data-testid="org-label">{{
            t(`organizations.labels.${row.label}`)
          }}</AppBadge>
        </template>
        <template #cell-owner="{ row }">
          <i18n-t v-if="row.shopOwner" scope="global" keypath="organizations.row.owner">
            <template #name>
              <PersonName :name="row.shopOwner.fullName" :user-id="row.shopOwner.userId" />
            </template>
          </i18n-t>
          <template v-else>{{ ownerText(row) }}</template>
        </template>
        <template #cell-chat="{ row }">
          <span v-if="row.telegramChatId !== null" class="mono">{{ row.telegramChatId }}</span>
          <span v-else-if="!isLinked(row)" class="muted">{{
            t('organizations.row.notLinked')
          }}</span>
        </template>
        <template #cell-status="{ row }">
          <AppBadge v-if="isArchived(row)" tone="muted" data-testid="archived-badge">{{
            t('organizations.archive.badge')
          }}</AppBadge>
          <AppBadge v-else :tone="STATUS_TONE[displayStatusOf(row)]" dot>{{
            statusText(row)
          }}</AppBadge>
        </template>
        <template #card="{ row }">
          <span class="card__top">
            <span class="org">
              <span class="org__mark" aria-hidden="true">{{ initialsOf(row.name) }}</span>
              <span class="row__name">{{ row.name }}</span>
            </span>
            <AppBadge v-if="isArchived(row)" tone="muted">{{
              t('organizations.archive.badge')
            }}</AppBadge>
            <AppBadge v-else :tone="STATUS_TONE[displayStatusOf(row)]" dot>{{
              statusText(row)
            }}</AppBadge>
          </span>
          <!-- With inline controls the badges move below the card's link (card-actions). -->
          <span v-if="!hasInlineControls" class="card__badges">
            <AppBadge :tone="TYPE_TONE[row.type]">{{
              t(`organizations.types.${row.type}`)
            }}</AppBadge>
            <AppBadge :tone="LABEL_TONE[row.label]">{{
              t(`organizations.labels.${row.label}`)
            }}</AppBadge>
          </span>
          <span class="card__meta">
            <i18n-t v-if="row.shopOwner" scope="global" keypath="organizations.row.owner">
              <template #name>
                <PersonName :name="row.shopOwner.fullName" :user-id="row.shopOwner.userId" />
              </template>
            </i18n-t>
            <template v-else>{{ ownerText(row) }}</template>
          </span>
          <span class="card__meta">
            <template v-if="row.telegramChatId !== null">
              <span class="mono">{{ row.telegramChatId }}</span> ·
            </template>
            <template v-else-if="!isLinked(row)"
              >{{ t('organizations.row.notLinked') }} ·
            </template>
            {{ memberText(row) }}
          </span>
          <span class="card__meta">
            <template v-if="row.addedBy"
              >{{ t('organizations.row.addedBy') }}:
              <PersonName :name="row.addedBy.name" :telegram-user-id="row.addedBy.telegramUserId" />
              · {{ formatDateTime(row.createdAt) }}</template
            >
            <template v-else>{{ addedText(row) }}</template>
          </span>
        </template>
        <template v-if="hasInlineControls" #card-actions="{ row }">
          <InlineBadgeSelect
            v-if="typeEditable(row)"
            :model-value="row.type"
            :options="typeChoices"
            :label="
              t('organizations.inline.typeFor', {
                name: row.name,
                value: t(`organizations.types.${row.type}`),
              })
            "
            :tone="TYPE_TONE[row.type]"
            :text="t(`organizations.types.${row.type}`)"
            data-testid="inline-type"
            @update:model-value="askType(row, $event as OrganizationType)"
          />
          <AppBadge v-else :tone="TYPE_TONE[row.type]">{{
            t(`organizations.types.${row.type}`)
          }}</AppBadge>
          <InlineBadgeSelect
            v-if="labelEditable(row)"
            :model-value="row.label"
            :options="labelChoices"
            :label="
              t('organizations.inline.labelFor', {
                name: row.name,
                value: t(`organizations.labels.${row.label}`),
              })
            "
            :tone="LABEL_TONE[row.label]"
            :text="t(`organizations.labels.${row.label}`)"
            :saving="saving.has(row.id)"
            data-testid="inline-label"
            @update:model-value="changeLabel(row.id, $event as OrganizationLabel)"
          />
          <AppBadge v-else :tone="LABEL_TONE[row.label]">{{
            t(`organizations.labels.${row.label}`)
          }}</AppBadge>
        </template>
      </DataTable>
    </div>
  </StateView>

  <CreateOrganizationDialog
    v-if="canManage"
    v-model="createOpen"
    @created="onCreated"
    @open="openOrganization"
  />
  <ChangeTypeDialog
    v-if="canManage"
    v-model="typeDialogOpen"
    :organization="typeTarget?.organization ?? null"
    :target="typeTarget?.type ?? null"
    @changed="putRow"
    @stale="onTypeStale"
  />
  <EditOrganizationDialog
    v-if="canManage && editTarget"
    v-model="editOpen"
    :organization="editTarget"
    @saved="putRow"
  />
  <AppConfirmDialog
    v-if="canManage"
    v-model="statusOpen"
    :title="
      statusTarget?.status === 'ACTIVE'
        ? t('organizations.actions.activateTitle')
        : t('organizations.actions.deactivateTitle')
    "
    :description="
      statusTarget
        ? t(
            statusTarget.status === 'ACTIVE'
              ? 'organizations.actions.activateBody'
              : 'organizations.actions.deactivateBody',
            { name: statusTarget.organization.name },
          )
        : undefined
    "
    :confirm-label="
      statusTarget?.status === 'ACTIVE'
        ? t('organizations.actions.confirmActivate')
        : t('organizations.actions.confirmDeactivate')
    "
    :tone="statusTarget?.status === 'ACTIVE' ? 'primary' : 'danger'"
    :loading="statusBusy"
    :error="statusError"
    @confirm="confirmStatus"
  />
  <AppConfirmDialog
    v-if="canEditLabel"
    v-model="labelOpen"
    :title="t('organizations.menu.labelTitle')"
    :description="labelTarget ? t('organizations.menu.labelBody', { name: labelTarget.name }) : ''"
    :confirm-label="t('organizations.edit.save')"
    @confirm="confirmLabel"
  >
    <AppDropdown
      :model-value="labelChoice"
      :options="labelChoices"
      :label="t('organizations.columns.label')"
      min-width="100%"
      data-testid="menu-label-dropdown"
      @update:model-value="labelChoice = $event as OrganizationLabel"
    />
  </AppConfirmDialog>
  <AppConfirmDialog
    v-if="canArchive"
    v-model="archiveOpen"
    :title="t('organizations.archive.title')"
    :description="
      archiveTarget ? t('organizations.archive.body', { name: archiveTarget.name }) : undefined
    "
    :confirm-label="t('organizations.archive.confirm')"
    tone="danger"
    :loading="archiveBusy"
    :error="archiveError"
    @confirm="confirmArchive"
  />
</template>

<style scoped>
.orgs {
  display: flex;
  flex-direction: column;
  gap: 24px;
  animation: viewIn 0.35s var(--ease) both;
}

/* v8 page header: 28px regular title, 12px grey line under it, the page action at the end. */
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}

.head__text {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.head__title {
  margin: 0;
  font-size: var(--fs-h1);
  font-weight: 400;
  line-height: 1.2;
}

.head__info {
  font-size: var(--fs-small);
  color: var(--t2);
}

/* The v8 page action: a 40px white button with a hairline ring (as on Narxlar). */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--r-btn-sm);
  background: var(--w);
  box-shadow: inset 0 0 0 1px var(--e8);
  color: var(--ink);
  font: inherit;
  font-size: var(--fs-small);
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.chip:hover {
  background: var(--f5);
}

.chip:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 2px;
}

.chip__icon {
  color: var(--t2);
}

/* Needs action: the accent-tinted notice of v8. */
.banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0;
  padding: 12px 16px;
  border-radius: var(--r-card);
  background: var(--acc-bg);
  color: var(--acc-fg);
  font-size: var(--fs-small);
  font-weight: 500;
}

.banner__icon {
  margin-top: 1px;
}

.head__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

/* The archive's explanation: grey, it asks for no action. */
.note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0;
  padding: 12px 16px;
  border-radius: var(--r-card);
  background: var(--page);
  color: var(--t2);
  font-size: var(--fs-small);
}

.search {
  flex: 1 1 240px;
  max-width: 340px;
}

.org {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

/* v8 company mark: a 34px rounded square with the initials. */
.org__mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--r-input);
  background: var(--page);
  color: var(--t2);
  font-size: var(--fs-meta);
  font-weight: 600;
}

.row__name {
  font-size: var(--fs-small);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.muted {
  color: var(--t2);
}

.card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.card__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.card__meta {
  font-size: var(--fs-small);
  color: var(--t2);
}

/* Phone: the filters fill the width two to a row (status, the longest, gets a row of its own)
   instead of three narrow selects stacked under each other. */
@media (max-width: 640px) {
  .filters {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 14px;
  }

  .search,
  .filters__wide {
    grid-column: 1 / -1;
    max-width: none;
  }
}

@media (max-width: 720px) {
  .chip {
    flex: 1 1 auto;
    justify-content: center;
  }
}

@media (pointer: coarse), (hover: none) {
  .chip {
    min-height: 44px;
  }
}
</style>
