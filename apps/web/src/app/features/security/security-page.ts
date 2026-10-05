import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { OrgContext } from '@materia/data-access';
import {
  MEMBER_LIST_QUERY,
  membersRepository,
  mySignInsRepository,
  type SignInItem,
} from '@materia/data-access/repository';
import {
  can,
  formatDays,
  formatGraceHours,
  formatMinutes,
  MAX_SESSION_OPTIONS,
  MFA_GRACE_OPTIONS,
  resolveSecurity,
  SESSION_IDLE_OPTIONS,
  signInState,
  type ResolvedSecurity,
  type RevokeSessionsResult,
  type SignInState,
  type UpdateSecurityPolicyInput,
} from '@materia/domain';
import {
  DialogService,
  MtBadge,
  MtButton,
  MtNote,
  MtSelect,
  MtSettingsRow,
  MtSettingsSection,
  MtSwitch,
  ToastService,
  type MtOption,
} from '@materia/ui';

import { AuthState } from '../../core/auth/auth-state';
import { ReauthDialog, type ReauthDialogData } from '../../core/auth/reauth-dialog';
import { SessionPolicy } from '../../core/auth/session-policy';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { PAGE_LOAD } from '../../core/orgs/org-service';

type PolicyFields = Omit<UpdateSecurityPolicyInput, 'requestId'>;

const PROVIDERS: Record<string, string> = { password: 'Password', 'google.com': 'Google' };
const STATE_LABELS: Record<Exclude<SignInState, 'active'>, { label: string; tone: 'success' | 'neutral' }> = {
  current: { label: 'This device', tone: 'success' },
  signedOut: { label: 'Signed out', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
};

const options = <T extends number>(values: readonly T[], label: (value: T) => string): MtOption<T>[] =>
  values.map((value) => ({ value, label: label(value) }));

/** The choices, plus the current value when it's not one of them (set before the options existed). */
function withCurrent<T extends number>(list: MtOption<T>[], value: T, label: (value: T) => string): MtOption<T>[] {
  return list.some((o) => o.value === value)
    ? list
    : [...list, { value, label: label(value) }].sort((a, b) => a.value - b.value);
}

/**
 * Settings → Security (`/settings/security`, SEC-04, DES-01 "Settings: Security"):
 * - Sign-in: required MFA with its grace period, the inactivity sign-out, how long a sign-in lasts.
 *   Owners and admins change them (`security-updatePolicy`, each change saves at once); everyone
 *   else sees them read-only. Re-confirmation for sensitive actions is always on.
 * - Your sessions: recent sign-ins from `users/{uid}/signIns`, and "Sign out everywhere else".
 * - Someone else's sessions (owners and admins): sign a member out of every device.
 */
@Component({
  selector: 'mt-security-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtBadge, MtButton, MtNote, MtSelect, MtSettingsRow, MtSettingsSection, MtSwitch],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <div class="mt-col" style="gap: 6px">
      <h1 class="title-l" style="margin: 0">Security</h1>
      <p style="margin: 0; color: var(--text-secondary)">
        How people sign in to {{ orgName() }} and how long they stay signed in.
      </p>
    </div>

    <mt-settings-section
      title="Sign-in"
      [description]="
        canEdit()
          ? 'These apply to everyone in the practice.'
          : 'These apply to everyone. Owners and admins change them.'
      "
      [headingLevel]="2"
    >
      <mt-settings-row
        title="Require multi-factor authentication"
        description="People without an authenticator app are asked to set one up, and can’t carry on without it once the grace period ends."
      >
        @if (canEdit()) {
          <mt-switch
            name="mfaRequired"
            label="Require multi-factor authentication"
            labelHidden
            [disabled]="saving()"
            [ngModel]="policy().mfaRequired"
            (ngModelChange)="save({ mfaRequired: $event })"
          />
        } @else {
          <span data-value="mfaRequired">{{ policy().mfaRequired ? 'Required' : 'Optional' }}</span>
        }
      </mt-settings-row>
      @if (policy().mfaRequired) {
        <mt-settings-row
          title="Grace period"
          [description]="
            policy().mfaEnforceAfter ? 'Required from ' + when(policy().mfaEnforceAfter!) + '.' : 'Required now.'
          "
        >
          @if (canEdit()) {
            <mt-select
              name="mfaGraceHours"
              label="Grace period"
              [native]="true"
              [disabled]="saving()"
              [options]="graceOptions()"
              [ngModel]="policy().mfaGraceHours"
              (ngModelChange)="save({ mfaGraceHours: $event })"
            />
          } @else {
            <span>{{ graceLabel(policy().mfaGraceHours) }}</span>
          }
        </mt-settings-row>
      }
      <mt-settings-row
        title="Sign out after inactivity"
        description="Counts from the last click or keystroke in any tab. A warning shows a minute before."
      >
        @if (canEdit()) {
          <mt-select
            name="sessionIdleMinutes"
            label="Sign out after inactivity"
            [native]="true"
            [disabled]="saving()"
            [options]="idleOptions()"
            [ngModel]="policy().sessionIdleMinutes"
            (ngModelChange)="save({ sessionIdleMinutes: $event })"
          />
        } @else {
          <span data-value="sessionIdleMinutes">{{ minutesLabel(policy().sessionIdleMinutes) }}</span>
        }
      </mt-settings-row>
      <mt-settings-row title="Sign in again after" description="The longest a sign-in lasts, however active it is.">
        @if (canEdit()) {
          <mt-select
            name="maxSessionDays"
            label="Sign in again after"
            [native]="true"
            [disabled]="saving()"
            [options]="sessionOptions()"
            [ngModel]="policy().maxSessionDays"
            (ngModelChange)="save({ maxSessionDays: $event })"
          />
        } @else {
          <span>{{ daysLabel(policy().maxSessionDays) }}</span>
        }
      </mt-settings-row>
      <mt-settings-row
        title="Confirm it’s you for sensitive actions"
        description="Asks for your password or Google sign-in again before changing roles, exporting, connecting an integration or releasing a will."
      >
        <mt-badge tone="success">Always on</mt-badge>
      </mt-settings-row>
    </mt-settings-section>

    <mt-settings-section
      title="Your sessions"
      description="Where you’ve signed in recently. Sign out anything you don’t recognise."
      [headingLevel]="2"
    >
      @switch (signIns.status()) {
        @case ('loading') {
          <p role="status" style="margin: 0; color: var(--text-tertiary)">Loading your sessions…</p>
        }
        @case ('error') {
          <mt-note tone="danger">Couldn’t load your sessions.</mt-note>
        }
        @default {
          @for (entry of signIns.value(); track entry.id) {
            <mt-settings-row [title]="entry.device + ' · ' + entry.browser" [description]="describe(entry)">
              @if (stateOf(entry); as state) {
                @if (state !== 'active') {
                  <mt-badge [tone]="stateLabels[state].tone">{{ stateLabels[state].label }}</mt-badge>
                }
              }
            </mt-settings-row>
          } @empty {
            <p style="margin: 0; color: var(--text-tertiary)">No sign-ins recorded yet.</p>
          }
        }
      }
      <div>
        <button
          mtButton
          variant="secondary"
          size="sm"
          type="button"
          [loading]="revoking()"
          (click)="signOutElsewhere()"
        >
          Sign out everywhere else
        </button>
      </div>
    </mt-settings-section>

    @if (canManage()) {
      <mt-settings-section
        title="Someone else’s sessions"
        description="Sign a person out of every device, for example when a laptop is lost. They stay a member and can sign in again."
        [headingLevel]="2"
      >
        <mt-settings-row title="Sign a person out everywhere">
          <div class="mt-row" style="gap: 8px; flex-wrap: wrap">
            <mt-select
              style="min-width: 200px"
              name="member"
              label="Person"
              placeholder="Choose person"
              [native]="true"
              [options]="memberOptions()"
              [ngModel]="target()"
              (ngModelChange)="target.set($event)"
            />
            <button
              mtButton
              variant="secondary"
              size="sm"
              type="button"
              [disabled]="!target()"
              [loading]="revokingOther()"
              (click)="signOutMember()"
            >
              Sign out
            </button>
          </div>
        </mt-settings-row>
      </mt-settings-section>
    }
  `,
})
export class SecurityPage {
  private readonly auth = inject(AuthState);
  private readonly sessionPolicy = inject(SessionPolicy);
  private readonly context = inject(OrgContext);
  private readonly callables = inject(CALLABLES);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly load = inject(PAGE_LOAD);

  protected readonly signIns = mySignInsRepository().watchQuery({ orderBy: [['at', 'desc']], pageSize: 20 });
  private readonly members = membersRepository().watchQuery(() =>
    this.canManage() ? { ...MEMBER_LIST_QUERY, pageSize: 100 } : null,
  );

  protected readonly stateLabels = STATE_LABELS;
  protected readonly saving = signal(false);
  protected readonly revoking = signal(false);
  protected readonly revokingOther = signal(false);
  protected readonly target = signal<string | null>(null);
  /** The values just saved, shown until the org document catches up. */
  private readonly pending = signal<Partial<PolicyFields> | null>(null);

  private readonly role = computed(() => this.context.role());
  protected readonly canEdit = computed(() => {
    const role = this.role();
    return !!role && can(role, 'org.settings');
  });
  protected readonly canManage = computed(() => {
    const role = this.role();
    return !!role && can(role, 'members.manage');
  });
  protected readonly orgName = computed(() => this.auth.claims().orgName ?? 'your practice');
  protected readonly policy = computed<ResolvedSecurity>(() => {
    const stored = this.sessionPolicy.policy() ?? resolveSecurity(undefined);
    return { ...stored, ...(this.pending() ?? {}) };
  });

  protected readonly idleOptions = computed(() =>
    withCurrent(options(SESSION_IDLE_OPTIONS, formatMinutes), this.policy().sessionIdleMinutes, formatMinutes),
  );
  protected readonly sessionOptions = computed(() =>
    withCurrent(options(MAX_SESSION_OPTIONS, formatDays), this.policy().maxSessionDays, formatDays),
  );
  protected readonly graceOptions = computed(() =>
    withCurrent(options(MFA_GRACE_OPTIONS, formatGraceHours), this.policy().mfaGraceHours, formatGraceHours),
  );
  protected readonly memberOptions = computed<MtOption<string>[]>(() =>
    (this.members.value() ?? [])
      .filter((m) => m.id !== this.context.uid() && m.status === 'active')
      .filter((m) => m.role !== 'owner' || this.role() === 'owner')
      .map((m) => ({ value: m.id, label: m.displayName })),
  );

  protected readonly minutesLabel = formatMinutes;
  protected readonly daysLabel = formatDays;
  protected readonly graceLabel = formatGraceHours;

  protected when(at: Date): string {
    return at.toLocaleString('en-AU', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  protected stateOf(entry: SignInItem): SignInState {
    return signInState(entry, {
      currentAuthTimeMs: this.auth.session()?.authTime ?? null,
      validAfter: this.sessionPolicy.security()?.validAfter ?? null,
      policy: this.policy(),
      nowMs: Date.now(),
    });
  }

  protected describe(entry: SignInItem): string {
    const at = entry.at instanceof Date ? this.when(entry.at) : 'unknown';
    const how = PROVIDERS[entry.provider] ?? entry.provider;
    return `Signed in ${at} · ${how}${entry.secondFactor ? ' with two-step sign-in' : ''}`;
  }

  protected async save(change: Partial<PolicyFields>): Promise<void> {
    const current = this.policy();
    const next: PolicyFields = {
      mfaRequired: current.mfaRequired,
      sessionIdleMinutes: current.sessionIdleMinutes,
      maxSessionDays: current.maxSessionDays,
      mfaGraceHours: current.mfaGraceHours,
      ...change,
    };
    this.saving.set(true);
    this.pending.set(next);
    try {
      await this.callables.call('security-updatePolicy', next, { idempotent: true });
      this.toasts.show({ title: 'Security settings saved', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'The change wasn’t saved', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.pending.set(null);
      this.saving.set(false);
    }
  }

  /**
   * Revokes every sign-in, this one included, then asks the person to confirm it's them so this
   * tab gets a new sign-in. Cancelling signs this tab out too. The page reloads afterwards: the
   * revocation stopped this tab's live reads.
   */
  protected async signOutElsewhere(): Promise<void> {
    const confirmed = await this.dialogs.confirm({
      title: 'Sign out everywhere else?',
      body: 'Every other browser and device you’re signed in on is signed out. You’ll confirm it’s you to stay signed in here.',
      confirmLabel: 'Sign out everywhere else',
    });
    if (!confirmed) return;
    this.revoking.set(true);
    try {
      await this.sessionPolicy.withChecksPaused(async () => {
        await this.callables.call<object, RevokeSessionsResult>('security-revokeSessions', {}, { idempotent: true });
        const stayed =
          (await this.dialogs.open<ReauthDialogData, boolean>(ReauthDialog, {
            data: { reason: 'Your other sessions are signed out. Confirm it’s you to stay signed in here.' },
            closeOnOutsideClick: false,
          }).result) === true;
        if (!stayed) throw new SignedOutHere();
      });
      this.load('/settings/security');
    } catch (error) {
      if (error instanceof SignedOutHere) await this.sessionPolicy.end('revoked');
      else
        this.toasts.show({ title: 'Your sessions weren’t signed out', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.revoking.set(false);
    }
  }

  protected async signOutMember(): Promise<void> {
    const uid = this.target();
    if (!uid) return;
    const name = this.memberOptions().find((m) => m.value === uid)?.label ?? 'This person';
    const confirmed = await this.dialogs.confirm({
      title: `Sign ${name} out everywhere?`,
      body: `${name} is signed out of every browser and device at once. They stay a member and can sign in again.`,
      confirmLabel: 'Sign out everywhere',
      tone: 'danger',
    });
    if (!confirmed) return;
    this.revokingOther.set(true);
    try {
      await this.callables.call('security-revokeSessions', { uid }, { idempotent: true });
      this.toasts.show({ title: `${name} is signed out everywhere`, tone: 'success' });
      this.target.set(null);
    } catch (error) {
      this.toasts.show({ title: `${name} wasn’t signed out`, description: errorCopy(error), tone: 'danger' });
    } finally {
      this.revokingOther.set(false);
    }
  }
}

/** The person cancelled confirming it's them after signing out everywhere else. */
class SignedOutHere extends Error {}
