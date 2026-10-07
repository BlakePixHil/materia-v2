import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormControl, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';

import type { PendingInvite, TeamMember } from '@materia/data-access';
import { MEMBER_LIST_QUERY, membersRepository } from '@materia/data-access/repository';
import {
  ACTIONS,
  fyLabel,
  fyStartYear,
  PERMISSIONS,
  ROLES,
  SENSITIVE_REAUTH_MINUTES,
  today,
  withRateChange,
  type Action,
  type MemberSecurity,
  type Role,
} from '@materia/domain';
import {
  DialogService,
  formatAud,
  MT_ORG_TIMEZONE,
  MtAvatar,
  MtButton,
  MtNote,
  type MtOption,
  MtSelect,
  MtSettingsRow,
  MtSettingsSection,
  MtSkeleton,
  MtTable,
  type MtTableColumn,
  MtTextField,
  ToastService,
} from '@materia/ui';

import {
  MemberSettingsDialog,
  type MemberSettingsDialogData,
  type MemberSettingsDialogResult,
} from './member-settings-dialog';
import { AuthState } from '../../core/auth/auth-state';
import { injectRecentLogin } from '../../core/auth/reauth-dialog';
import { errorCopy } from '../../core/error-copy';
import { OrgService } from '../../core/orgs/org-service';
import { MtNeedsConnection } from '../../core/pwa/needs-connection';
import { MtPageOfflineNote } from '../../core/pwa/offline-banner';
import { SettingsApi } from '../../features/settings/settings-api';

/** One row of the role explainer: an action and whether each role may do it. */
type MatrixRow = { action: Action } & Partial<Record<Role, string>>;

/** "matter.renumber" → "Matter: renumber"; "export.includePrivileged" → "Export: include privileged". */
function actionLabel(action: Action): string {
  const [noun = '', verb = ''] = action.split('.');
  const words = verb.replace(/([A-Z])/g, ' $1').toLowerCase();
  return `${noun[0]?.toUpperCase() ?? ''}${noun.slice(1)}: ${words}`;
}

/** "3 Oct" or "today", from an ISO instant. */
function lastActive(iso: string | null, timeZone: string): string {
  if (!iso) return 'Never signed in';
  const date = new Date(iso);
  const day = (d: Date) => d.toLocaleDateString('en-AU', { timeZone, day: 'numeric', month: 'short', year: 'numeric' });
  return day(date) === day(new Date()) ? 'Active today' : `Last active ${day(date)}`;
}

const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  lawyer: 'Lawyer',
  paralegal: 'Paralegal',
  readonly: 'Read-only',
};

/**
 * Settings → Team and roles (`/settings/team`, FND-17, CORE-21): members and pending invites.
 * Everyone sees who is in the practice. Owners and admins also see each member's MFA status and last
 * activity (from Auth, `orgs-memberSecurity`), rate and this year's budget; they invite, change
 * roles, set rates, budgets and supervisors, suspend, reinstate and remove people. Only owners grant
 * the owner role or transfer ownership (FND-17); suspending, reinstating and transferring ask the
 * person to confirm it's them when their sign-in is more than a few minutes old.
 * The role explainer is generated from the permission matrix in `libs/domain`.
 *
 * The members list is the data layer's worked example (FND-19): a live, paged query resource from
 * the members repository, with loading, empty, error and offline states.
 */
@Component({
  selector: 'mt-team-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MtPageOfflineNote,
    FormsModule,
    ReactiveFormsModule,
    MtAvatar,
    MtButton,
    MtNeedsConnection,
    MtNote,
    MtSelect,
    MtSettingsRow,
    MtSettingsSection,
    MtSkeleton,
    MtTable,
    MtTextField,
  ],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  styles: `
    .matrix summary {
      cursor: pointer;
      color: var(--text-brand, inherit);
      margin-bottom: var(--space-12, 12px);
    }
  `,
  template: `
    <h1 class="title-l" style="margin: 0">Team and roles</h1>

    @if (manage()) {
      <mt-settings-section title="Invite someone" description="They’ll get an email with a link that works for 7 days.">
        <form
          class="mt-row"
          style="gap: 8px; align-items: flex-end; flex-wrap: wrap"
          [formGroup]="inviteForm"
          (ngSubmit)="invite()"
        >
          <mt-text-field
            class="mt-grow"
            label="Email"
            type="email"
            autocomplete="off"
            formControlName="email"
            required
          />
          <mt-select label="Role" formControlName="role" [options]="grantable()" [native]="true" />
          <button mtButton mtNeedsConnection variant="primary" type="submit" [loading]="inviting()">Send invite</button>
        </form>
      </mt-settings-section>
    }

    @if (error(); as message) {
      <mt-note tone="danger">{{ message }}</mt-note>
    }

    <mt-settings-section title="Members" [headingLevel]="2">
      @switch (membersState()) {
        @case ('error') {
          <mt-note tone="danger">
            {{ membersError() }}
            <button mtButton size="sm" (click)="members.refresh()">Try again</button>
          </mt-note>
        }
        @case ('offline') {
          <mt-note tone="info" role="status" mtPageOfflineNote>
            {{
              team().length
                ? 'You’re offline. This is the team as it was when you were last connected.'
                : 'You’re offline. The team will load when you reconnect.'
            }}
          </mt-note>
        }
        @case ('loading') {
          <mt-skeleton variant="fields" framed label="Loading members…" />
        }
        @case ('empty') {
          <p style="margin: 0; color: var(--text-tertiary)">No members yet.</p>
        }
      }
      @if (members.newItems(); as count) {
        <button mtButton size="sm" (click)="members.refresh()">
          {{ count === 1 ? '1 new member' : count + ' new members' }}
        </button>
      }
      @for (member of team(); track member.uid) {
        <mt-settings-row
          [title]="member.displayName + (member.uid === me() ? ' (you)' : '')"
          [description]="describe(member)"
          [attr.data-member]="member.email ?? member.uid"
        >
          <mt-avatar mtRowLead [name]="member.displayName" [colorKey]="member.uid" />
          <div class="mt-row" style="gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end">
            @if (manage()) {
              <button
                mtButton
                size="sm"
                (click)="editRates(member)"
                [attr.aria-label]="'Rate and budget for ' + member.displayName"
              >
                Rate and budget
              </button>
            }
            @if (canEdit(member)) {
              <mt-select
                style="width: 132px"
                labelHidden
                size="sm"
                [label]="'Role for ' + member.displayName"
                [options]="grantable()"
                [native]="true"
                [ngModel]="member.role"
                (ngModelChange)="changeRole(member, $event)"
              />
              @if (member.status === 'suspended') {
                <button
                  mtButton
                  size="sm"
                  (click)="reinstate(member)"
                  [attr.aria-label]="'Reinstate ' + member.displayName"
                >
                  Reinstate
                </button>
              } @else {
                <button
                  mtButton
                  size="sm"
                  (click)="suspend(member)"
                  [attr.aria-label]="'Suspend ' + member.displayName"
                >
                  Suspend…
                </button>
              }
              @if (canTransferTo(member)) {
                <button
                  mtButton
                  size="sm"
                  (click)="transfer(member)"
                  [attr.aria-label]="'Transfer ownership to ' + member.displayName"
                >
                  Transfer ownership…
                </button>
              }
              @if (confirming() === member.uid) {
                <button mtButton variant="danger" size="sm" (click)="remove(member)">Confirm removal</button>
              } @else {
                <button mtButton size="sm" (click)="confirming.set(member.uid)">Remove</button>
              }
            } @else {
              <span>{{ roleLabel(member.role) }}</span>
            }
          </div>
        </mt-settings-row>
      }
      @if (members.hasMore()) {
        <button mtButton size="sm" [loading]="members.loadingMore()" (click)="members.loadMore()">
          Show more members
        </button>
      }
    </mt-settings-section>

    <mt-settings-section
      title="What each role can do"
      description="Roles decide what people can see and change. Owners can also delete the practice and grant the owner role."
      [headingLevel]="2"
    >
      <details class="matrix">
        <summary>Show the role permissions</summary>
        <mt-table
          label="Role permissions"
          density="compact"
          [rows]="matrix"
          [columns]="matrixColumns"
          [rowKey]="matrixKey"
        />
      </details>
    </mt-settings-section>

    @if (manage() && invites().length) {
      <mt-settings-section title="Pending invites" [headingLevel]="2">
        @for (invite of invites(); track invite.id) {
          <mt-settings-row [title]="invite.email" [description]="describeInvite(invite)">
            <div class="mt-row" style="gap: 8px">
              <button mtButton mtNeedsConnection size="sm" (click)="resend(invite)">Resend</button>
              <button mtButton mtNeedsConnection size="sm" (click)="revoke(invite)">Revoke</button>
            </div>
          </mt-settings-row>
        }
      </mt-settings-section>
    }
  `,
})
export class TeamPage {
  private readonly orgs = inject(OrgService);
  private readonly auth = inject(AuthState);
  private readonly toasts = inject(ToastService);
  private readonly dialogs = inject(DialogService);
  private readonly api = inject(SettingsApi);
  private readonly recentLogin = injectRecentLogin(SENSITIVE_REAUTH_MINUTES);
  private readonly repo = membersRepository();
  private readonly timeZone = signal(inject(MT_ORG_TIMEZONE));
  /** Every practice's financial year starts in July (`org.fy.startMonth`, not editable yet). */
  private readonly fyStartMonth = signal(7);
  /** The financial year today is in, as its start year. */
  private readonly fy = computed(() => fyStartYear(today(this.timeZone()), this.fyStartMonth()));
  /** MFA and last activity by uid (owners and admins). */
  protected readonly security = signal<Map<string, MemberSecurity>>(new Map());

  protected readonly matrix: MatrixRow[] = ACTIONS.map((action) => ({
    action,
    ...Object.fromEntries(
      ROLES.map((role) => [role, (PERMISSIONS[action] as readonly Role[]).includes(role) ? 'Yes' : '—']),
    ),
  }));
  protected readonly matrixColumns: MtTableColumn<MatrixRow>[] = [
    { id: 'action', header: 'Action', value: (row) => actionLabel(row.action) },
    ...ROLES.map((role) => ({ id: role, header: ROLE_LABELS[role], value: (row: MatrixRow) => row[role] })),
  ];
  protected readonly matrixKey = (row: MatrixRow) => row.action;

  /** Live members of the active org; the listener stops with the page. */
  protected readonly members = membersRepository().watchQuery(MEMBER_LIST_QUERY);
  protected readonly team = computed<TeamMember[]>(() =>
    this.members.value().map((m) => ({
      uid: m.id,
      displayName: m.displayName,
      email: m.email ?? null,
      initials: m.initials ?? '?',
      role: m.role,
      status: m.status,
      colour: m.colour ?? '',
    })),
  );
  /** Which state the list is in; rows show under `offline` too, from this device's cache. */
  protected readonly membersState = computed(() => {
    const status = this.members.status();
    if (status !== 'ready') return status;
    return this.team().length ? 'list' : 'empty';
  });
  protected readonly membersError = computed(() => {
    const error = this.members.error();
    return error ? errorCopy(error) : '';
  });
  protected readonly invites = signal<PendingInvite[]>([]);
  protected readonly inviting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly confirming = signal<string | null>(null);
  protected readonly me = computed(() => this.auth.user()?.uid ?? null);
  protected readonly manage = this.orgs.canManageMembers;
  /** Roles the caller may hand out: owners grant any role, admins every role but owner. */
  protected readonly grantable = computed<MtOption<Role>[]>(() =>
    ROLES.filter((role) => role !== 'owner' || this.orgs.role() === 'owner').map((role) => ({
      value: role,
      label: ROLE_LABELS[role],
    })),
  );
  protected readonly inviteForm = new FormGroup({
    email: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.email] }),
    role: new FormControl<Role>('lawyer', { nonNullable: true }),
  });

  constructor() {
    void this.reload();
    // MFA and last activity come from Auth through a callable, for owners and admins only.
    effect(() => {
      const uids = this.team().map((m) => m.uid);
      if (!this.manage() || !uids.length) return;
      void this.api
        .memberSecurity(uids)
        .then((list) => this.security.set(new Map(list.map((m) => [m.uid, m]))))
        .catch(() => undefined);
    });
  }

  protected roleLabel(role: Role): string {
    return ROLE_LABELS[role];
  }

  /**
   * Email first, so two people with the same name can be told apart. Owners and admins also see MFA,
   * last activity, the rate and this year's budget.
   */
  protected describe(member: TeamMember): string {
    const parts = [member.email, ROLE_LABELS[member.role], member.status === 'suspended' ? 'Suspended' : null];
    if (this.manage()) {
      const security = this.security().get(member.uid);
      if (security)
        parts.push(security.mfaEnrolled ? 'MFA on' : 'MFA off', lastActive(security.lastActiveAt, this.timeZone()));
      const doc = this.members.value().find((m) => m.id === member.uid);
      if (doc?.defaultRateCents) parts.push(`${formatAud(doc.defaultRateCents)}/h`);
      const budget = doc?.budgets?.[String(this.fy())];
      if (budget) parts.push(`${fyLabel(this.fy(), this.fyStartMonth())} budget ${formatAud(budget)}`);
      const supervisor = doc?.supervisorUid && this.team().find((m) => m.uid === doc.supervisorUid);
      if (supervisor) parts.push(`Supervised by ${supervisor.displayName}`);
    }
    return parts.filter(Boolean).join(' · ');
  }

  /** Rate, supervisor and budgets for this and next financial year. */
  protected async editRates(member: TeamMember): Promise<void> {
    const doc = this.members.value().find((m) => m.id === member.uid);
    const fy = this.fy();
    const handle = this.dialogs.open<MemberSettingsDialogData, MemberSettingsDialogResult>(MemberSettingsDialog, {
      data: {
        displayName: member.displayName,
        defaultRateCents: doc?.defaultRateCents ?? null,
        supervisorUid: doc?.supervisorUid ?? null,
        budgets: doc?.budgets ?? {},
        supervisors: this.team()
          .filter((m) => m.uid !== member.uid && m.status === 'active')
          .map((m) => ({ value: m.uid, label: m.displayName })),
        fyStartYears: [fy, fy + 1],
        fyStartMonth: this.fyStartMonth(),
      },
    });
    const result = await handle.result;
    if (!result) return;
    const rateChanged = result.defaultRateCents !== (doc?.defaultRateCents ?? null);
    const effectiveFrom = today(this.timeZone());
    // Each rate change is kept with the day it starts, so time dated before it keeps the old rate
    // (BILL-01: the first change also records the rate it replaces).
    const rates = withRateChange(doc ?? {}, result.defaultRateCents, effectiveFrom);
    void this.run(
      () =>
        this.repo.update(
          member.uid,
          {
            defaultRateCents: result.defaultRateCents,
            budgets: result.budgets,
            ...(rateChanged ? { rates } : {}),
            ...(result.supervisorUid ? { supervisorUid: result.supervisorUid } : {}),
          },
          { remove: result.supervisorUid ? [] : ['supervisorUid'] },
        ),
      `${member.displayName}’s rate and budget saved`,
    );
  }

  protected describeInvite(invite: PendingInvite): string {
    const expired = invite.expiresAt.getTime() <= Date.now();
    const when = invite.expiresAt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    return `${ROLE_LABELS[invite.role]} · ${expired ? 'Expired' : `Expires ${when}`}`;
  }

  protected canEdit(member: TeamMember): boolean {
    if (!this.manage() || member.uid === this.me()) return false;
    return member.role !== 'owner' || this.orgs.role() === 'owner';
  }

  /** Owners hand the practice to another active member who isn't an owner already. */
  protected canTransferTo(member: TeamMember): boolean {
    return (
      this.orgs.role() === 'owner' && member.uid !== this.me() && member.status === 'active' && member.role !== 'owner'
    );
  }

  /** Re-reads the pending invites (members are live). */
  async reload(): Promise<void> {
    try {
      this.invites.set(this.manage() ? await this.orgs.invites() : []);
    } catch (error) {
      this.error.set(errorCopy(error));
    }
  }

  private async run(action: () => Promise<unknown>, success?: string): Promise<boolean> {
    this.error.set(null);
    try {
      await action();
      if (success) this.toasts.show({ title: success, tone: 'success' });
      await this.reload();
      return true;
    } catch (error) {
      this.error.set(errorCopy(error));
      return false;
    }
  }

  /**
   * A change that needs a recent sign-in (`SENSITIVE_REAUTH_MINUTES`): asks the person to confirm
   * it's them first when it's older, and shows the toast only once the change is made.
   */
  private async runSensitive(reason: string, action: () => Promise<unknown>, success: string): Promise<void> {
    let done = false;
    await this.run(async () => {
      const result = await this.recentLogin(reason, async () => {
        await action();
        return true;
      });
      done = result === true;
    });
    if (done) this.toasts.show({ title: success, tone: 'success' });
  }

  protected async invite(): Promise<void> {
    this.inviteForm.markAllAsTouched();
    if (this.inviteForm.invalid) return;
    const { email, role } = this.inviteForm.getRawValue();
    this.inviting.set(true);
    let emailed = true;
    const ok = await this.run(async () => {
      emailed = (await this.orgs.inviteMember(email, role)).emailed;
    });
    this.inviting.set(false);
    if (!ok) return;
    this.inviteForm.reset({ email: '', role });
    this.toasts.show(
      emailed
        ? { title: `Invite sent to ${email}`, tone: 'success' }
        : { title: 'Invite saved, but the email didn’t go', description: 'Use Resend to try again.', tone: 'neutral' },
    );
  }

  protected changeRole(member: TeamMember, role: Role | null): void {
    if (!role || role === member.role) return;
    void this.run(() => this.orgs.changeRole(member.uid, role), `${member.displayName} is now ${ROLE_LABELS[role]}`);
  }

  protected remove(member: TeamMember): void {
    this.confirming.set(null);
    void this.run(() => this.orgs.removeMember(member.uid), `${member.displayName} removed`);
  }

  protected async suspend(member: TeamMember): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: `Suspend ${member.displayName}?`,
      body:
        `${member.displayName} loses access to the practice straight away, and is signed out if they’re using it. ` +
        'Their matters, time and history stay as they are, and you can reinstate them at any time.',
      confirmLabel: 'Suspend member',
      tone: 'danger',
    });
    if (!confirmed) return;
    await this.runSensitive(
      'Suspending someone needs a fresh sign-in.',
      () => this.orgs.suspendMember(member.uid, true),
      `${member.displayName} suspended`,
    );
  }

  protected reinstate(member: TeamMember): Promise<void> {
    return this.runSensitive(
      'Reinstating someone needs a fresh sign-in.',
      () => this.orgs.suspendMember(member.uid, false),
      `${member.displayName} reinstated`,
    );
  }

  protected async transfer(member: TeamMember): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: `Make ${member.displayName} the owner?`,
      body:
        `${member.displayName} becomes an owner, so they can grant the owner role and delete the practice. ` +
        'You become an admin: you can still manage the team and settings, but only an owner can make you an owner again.',
      confirmLabel: 'Transfer ownership',
      tone: 'danger',
    });
    if (!confirmed) return;
    await this.runSensitive(
      'Transferring ownership needs a fresh sign-in.',
      () => this.orgs.transferOwnership(member.uid),
      `${member.displayName} is now the owner`,
    );
  }

  protected resend(invite: PendingInvite): void {
    void this.run(() => this.orgs.resendInvite(invite.id), `Invite resent to ${invite.email}`);
  }

  protected revoke(invite: PendingInvite): void {
    void this.run(() => this.orgs.revokeInvite(invite.id), 'Invite revoked');
  }
}
