import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';

import type { PendingInvite, TeamMember } from '@materia/data-access';
import { ROLES, type Role } from '@materia/domain';
import {
  MtAvatar,
  MtButton,
  MtNote,
  MtSelect,
  MtSettingsRow,
  MtSettingsSection,
  MtTextField,
  ToastService,
  type MtOption,
} from '@materia/ui';

import { AuthState } from '../../core/auth/auth-state';
import { errorCopy } from '../../core/error-copy';
import { OrgService } from '../../core/orgs/org-service';

const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  lawyer: 'Lawyer',
  paralegal: 'Paralegal',
  readonly: 'Read-only',
};

/**
 * The team (`/settings/team`, FND-17): members and pending invites. Owners and admins invite,
 * change roles and remove people; only owners grant the owner role. CORE-21 builds full team
 * settings on this.
 */
@Component({
  selector: 'mt-team-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ReactiveFormsModule,
    MtAvatar,
    MtButton,
    MtNote,
    MtSelect,
    MtSettingsRow,
    MtSettingsSection,
    MtTextField,
  ],
  host: { class: 'mt-col', style: 'gap: 24px; max-width: 760px' },
  template: `
    <h1 class="title-l" style="margin: 0">Team</h1>

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
          <button mtButton variant="primary" type="submit" [loading]="inviting()">Send invite</button>
        </form>
      </mt-settings-section>
    }

    @if (error(); as message) {
      <mt-note tone="danger">{{ message }}</mt-note>
    }

    <mt-settings-section title="Members" [headingLevel]="2">
      @for (member of members(); track member.uid) {
        <mt-settings-row
          [title]="member.displayName + (member.uid === me() ? ' (you)' : '')"
          [description]="describe(member)"
          [attr.data-member]="member.email ?? member.uid"
        >
          <div class="mt-row" style="gap: 8px; align-items: center">
            <mt-avatar [name]="member.displayName" [colorKey]="member.uid" size="sm" />
            @if (canEdit(member)) {
              <mt-select
                [label]="'Role for ' + member.displayName"
                [options]="grantable()"
                [native]="true"
                [ngModel]="member.role"
                (ngModelChange)="changeRole(member, $event)"
              />
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
      } @empty {
        <p style="margin: 0; color: var(--text-tertiary)">{{ loading() ? 'Loading…' : 'No members yet.' }}</p>
      }
    </mt-settings-section>

    @if (manage() && invites().length) {
      <mt-settings-section title="Pending invites" [headingLevel]="2">
        @for (invite of invites(); track invite.id) {
          <mt-settings-row [title]="invite.email" [description]="describeInvite(invite)">
            <div class="mt-row" style="gap: 8px">
              <button mtButton size="sm" (click)="resend(invite)">Resend</button>
              <button mtButton size="sm" (click)="revoke(invite)">Revoke</button>
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

  protected readonly members = signal<TeamMember[]>([]);
  protected readonly invites = signal<PendingInvite[]>([]);
  protected readonly loading = signal(true);
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
  }

  protected roleLabel(role: Role): string {
    return ROLE_LABELS[role];
  }

  /** Email first, so two people with the same name can be told apart. */
  protected describe(member: TeamMember): string {
    const parts = [member.email, ROLE_LABELS[member.role], member.status === 'suspended' ? 'Suspended' : null];
    return parts.filter(Boolean).join(' · ');
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

  async reload(): Promise<void> {
    try {
      const [members, invites] = await Promise.all([
        this.orgs.members(),
        this.manage() ? this.orgs.invites() : Promise.resolve([]),
      ]);
      this.members.set(members);
      this.invites.set(invites);
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.loading.set(false);
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

  protected resend(invite: PendingInvite): void {
    void this.run(() => this.orgs.resendInvite(invite.id), `Invite resent to ${invite.email}`);
  }

  protected revoke(invite: PendingInvite): void {
    void this.run(() => this.orgs.revokeInvite(invite.id), 'Invite revoked');
  }
}
