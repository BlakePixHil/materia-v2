import { computed, inject, Injectable, signal } from '@angular/core';

import { can, OrgContext } from '@materia/data-access';
import {
  DRAFT_TIME_QUERY,
  matterDetailRepository,
  MEMBER_LIST_QUERY,
  membersRepository,
  orgSettingsReadRepository,
  personTimeQuery,
  timeCallables,
  timeGroupRepository,
  type MemberListItem,
  type OrgSettings,
  type TimeEntryItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  awaitingApproval,
  BILLING_UNIT_MINUTES,
  DEFAULT_DAILY_TARGET_MINUTES,
  formatUnits,
  fyWindow,
  weekDatesOf,
  weekStartOf,
  type BillingWipResult,
} from '@materia/domain';
import { MT_TODAY } from '@materia/ui';

import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';

/**
 * What every part of the Time and billing screen shares (BILL-03): who I am and what I may do, the
 * team (names, supervisors, FY budgets), the org's billing settings (unit, daily target, FY start)
 * and the callables. Provided by the page, so it lives as long as the screen. Settings and members
 * are read once (no listeners).
 */
@Injectable()
export class BillingScreen {
  private readonly context = inject(OrgContext);
  readonly today = inject(MT_TODAY);
  readonly api = timeCallables(inject(CALLABLES));

  readonly me = computed(() => this.context.uid() ?? '');
  readonly canRecord = can('time.record');
  readonly canApprove = can('time.approve');
  readonly canViewBilling = can('billing.view');

  readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 }, { live: false });
  private readonly settings = signal<OrgSettings | null>(null);

  readonly unitMinutes = computed(() => this.settings()?.billing?.unitMinutes ?? BILLING_UNIT_MINUTES);
  readonly dailyTargetMinutes = computed(
    () => this.settings()?.billing?.dailyTargetMinutes ?? DEFAULT_DAILY_TARGET_MINUTES,
  );
  readonly fyStartMonth = computed(() => this.settings()?.fy?.startMonth ?? 7);

  private readonly byUid = computed(
    () => new Map(this.members.value().map((member) => [member.id, member] as [string, WithId<MemberListItem>])),
  );
  readonly myMember = computed(() => this.byUid().get(this.me()) ?? null);

  /** Active members I supervise (`supervisorUid`), by name. */
  readonly supervisees = computed(() =>
    this.members.value().filter((member) => member.supervisorUid === this.me() && member.status === 'active'),
  );

  /** My entries over the FY budget card's year read at most (a bounded query until INS-01's rollups). */
  static readonly FY_ENTRY_LIMIT = 3000;

  private readonly time = timeGroupRepository();

  /** The Monday of the week My time shows. */
  readonly weekOf = signal(weekStartOf(this.today()));
  readonly weekDates = computed(() => weekDatesOf(this.weekOf()));
  readonly fy = computed(() => fyWindow(this.today(), this.fyStartMonth()));

  /** My entries in the shown week, live. */
  readonly weekEntries = this.time.watchQuery(() => {
    const me = this.me();
    const dates = this.weekDates();
    return me ? personTimeQuery(me, dates[0] as string, dates[6] as string) : null;
  });
  /** My entries this FY, live (the FY budget card). */
  readonly fyEntries = this.time.watchQuery(() => {
    const me = this.me();
    const fy = this.fy();
    return me ? personTimeQuery(me, fy.start, fy.end, BillingScreen.FY_ENTRY_LIMIT) : null;
  });
  /** Drafts across the org, for approvers only (the Approvals tab and its count). */
  readonly drafts = this.time.watchQuery(() => (this.canApprove() ? DRAFT_TIME_QUERY : null));

  /** Drafts waiting for me: my supervisees', or (owners and admins) anyone else's. */
  readonly approvalScope = signal<'team' | 'everyone'>('team');
  readonly isFirmApprover = computed(() => {
    const role = this.myMember()?.role;
    return role === 'owner' || role === 'admin';
  });
  readonly awaiting = computed((): WithId<TimeEntryItem>[] => {
    const me = this.me();
    const team = new Set(this.supervisees().map((member) => member.id));
    const everyone = this.isFirmApprover() && (this.approvalScope() === 'everyone' || team.size === 0);
    return this.drafts
      .value()
      .filter((entry) => entry.uid !== me && awaitingApproval(entry) && (everyone || team.has(entry.uid)));
  });

  /** Unbilled WIP by matter (`billing-wip`, billing.view): read on demand, not live. */
  readonly wip = signal<BillingWipResult | null>(null);
  readonly wipLoading = signal(false);
  readonly wipError = signal<string | null>(null);

  async loadWip(): Promise<void> {
    if (!this.canViewBilling()) return;
    this.wipLoading.set(true);
    this.wipError.set(null);
    try {
      this.wip.set(await this.api.wip());
    } catch (error) {
      this.wipError.set(errorCopy(error));
    } finally {
      this.wipLoading.set(false);
    }
  }

  private readonly matters = matterDetailRepository();
  private readonly matterLabels = signal<ReadonlyMap<string, { number: string; title: string }>>(new Map());
  private readonly asked = new Set<string>();

  constructor() {
    const orgId = this.context.orgId();
    if (orgId) {
      orgSettingsReadRepository()
        .get(orgId)
        .then((org) => this.settings.set(org ?? null))
        .catch(() => undefined);
    }
  }

  /** A matter's number and title, read once on first ask ("…" until then; "Matter" if unreadable). */
  matter(id: string): { number: string; title: string } {
    const known = this.matterLabels().get(id);
    if (known) return known;
    if (!this.asked.has(id)) {
      this.asked.add(id);
      this.matters
        .get(id)
        .then((matter) => this.setMatter(id, matter ? { number: matter.number, title: matter.title } : null))
        .catch(() => this.setMatter(id, null));
    }
    return { number: '…', title: '' };
  }

  private setMatter(id: string, label: { number: string; title: string } | null): void {
    this.matterLabels.update((labels) => new Map(labels).set(id, label ?? { number: 'Matter', title: '' }));
  }

  memberName(uid: string): string {
    return this.byUid().get(uid)?.displayName ?? (uid === this.me() ? 'You' : 'Former member');
  }

  member(uid: string): WithId<MemberListItem> | null {
    return this.byUid().get(uid) ?? null;
  }

  unitsText(units: number): string {
    return `${formatUnits(units, this.unitMinutes())} h`;
  }
}
