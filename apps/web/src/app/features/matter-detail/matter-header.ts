import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import { contactsRepository } from '@materia/data-access/repository';
import {
  conflictAllowsOpening,
  contactDisplayName,
  isMatterLink,
  MATTER_LINK_MAX_LENGTH,
  MATTER_NUMBER_MAX_LENGTH,
  matterNumberProblem,
  normaliseMatterLink,
  REFERRAL_SOURCE_LABELS,
  referralPatch,
  referralText,
  type MatterStatus,
} from '@materia/domain';
import {
  DialogService,
  MT_MENU,
  MtAvatar,
  MtAvatarGroup,
  MtBadge,
  MtButton,
  MtIcon,
  MtIconButton,
  MtMatterTag,
  MtSwitch,
  MtTextField,
  MtTooltip,
  formatAud,
  ToastService,
} from '@materia/ui';

import { CloseMatterDialog, type CloseMatterDialogData } from './close-matter-dialog';
import { MatterScreen } from './matter-screen';
import { LONG_TITLE, matterErrorCopy, statusChoices, statusLabel, type StatusChoice } from './matter-view';
import type { ReferralChoice, ReferralDialogData } from './referral-dialog';
import { errorCodeOf, errorCopy } from '../../core/error-copy';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { PinnedMatters } from '../../core/pins/pinned-matters';
import { TimerStore } from '../../core/timer/timer-store';
import { CONFLICT_STATUS_TONES, conflictBadgeText } from '../conflicts/conflict-view';
import { MatterNameDialog, type MatterNameDialogData } from '../matters/matter-name-dialog';
import { changeStatusErrorCopy } from '../matters/matters-view';

/**
 * The matter screen's header (CORE-06): number, type, conflict status (CORE-02), the title (edited
 * inline), status, the amount its invoices still owe (BILL-08), responsible lawyer, team, labels,
 * the privileged flag and the "…" menu (which also pins the matter to the sidebar, CORE-23). Edit controls show only to roles that may use them, and
 * never on a deleted matter.
 */
@Component({
  selector: 'mt-matter-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/chip.css'],
  imports: [
    FormsModule,
    RouterLink,
    MT_MENU,
    MtAvatar,
    MtAvatarGroup,
    MtBadge,
    MtButton,
    MtIcon,
    MtIconButton,
    MtMatterTag,
    MtSwitch,
    MtTextField,
    MtTooltip,
  ],
  host: { class: 'mt-matter-head' },
  template: `
    @if (screen.value(); as m) {
      <div class="mt-row mt-wrap meta">
        @if (link(); as url) {
          <a
            class="num linked"
            [href]="url"
            target="_blank"
            rel="noopener noreferrer"
            [mtTooltip]="url"
            [attr.aria-label]="m.number + '. Open the linked matter in a new tab'"
            >{{ m.number }}<mt-icon name="link" [size]="14"
          /></a>
        } @else {
          <span class="num">{{ m.number }}</span>
        }
        <mt-matter-tag [type]="m.type" />
        <mt-badge [tone]="conflictTone()">{{ conflictText() }}</mt-badge>
        @if (m.privileged) {
          <mt-badge tone="warning"><mt-icon name="shield" />Privileged</mt-badge>
        }
        @if (outstanding(); as owing) {
          <a
            class="mt-chip outstanding"
            routerLink="time"
            data-testid="matter-outstanding"
            mtTooltip="Unpaid on the matter’s issued invoices"
            >Outstanding {{ owing }}</a
          >
        }
        @if (m.status === 'lead' && screen.canRunConflicts()) {
          <a mtButton variant="secondary" size="sm" iconStart="search" routerLink="conflicts">Conflict check</a>
        }
        <span class="mt-ml mt-row actions">
          @if (canTime()) {
            <!-- The global timer (BILL-02): Shift+T anywhere on the matter. -->
            <button mtButton variant="secondary" size="sm" iconStart="timer" kbd="shift+t" (click)="toggleTimer(m)">
              {{ timerLabel() }}
            </button>
          }
          @if (statusEditable()) {
            <button
              mtButton
              variant="secondary"
              size="sm"
              class="status"
              iconEnd="chevron-down"
              [mtMenuTrigger]="statusMenu"
              [loading]="busy()"
              [attr.aria-label]="'Status: ' + statusLabel(m.status) + '. Change status'"
            >
              {{ statusLabel(m.status) }}
            </button>
          } @else {
            <mt-badge class="status">{{ statusLabel(m.status) }}</mt-badge>
          }
          <button mtIconButton icon="more" size="sm" label="More matter actions" [mtMenuTrigger]="moreMenu"></button>
        </span>
      </div>

      @if (editingTitle()) {
        <form
          class="mt-row title-form"
          (submit)="$event.preventDefault(); saveTitle()"
          (keydown.escape)="cancelTitle()"
        >
          <mt-text-field
            class="mt-grow"
            name="title"
            label="Matter title"
            [error]="titleError() ?? undefined"
            [ngModel]="titleDraft()"
            (ngModelChange)="titleDraft.set($event ?? ''); titleError.set(null)"
          />
          <button mtButton variant="primary" size="sm" type="submit" [loading]="busy()">Save</button>
          <button mtButton variant="ghost" size="sm" type="button" (click)="cancelTitle()">Cancel</button>
        </form>
      } @else {
        <div class="mt-row title-row">
          <h1 class="title-l title" [mtTooltip]="m.title" [mtTooltipDisabled]="m.title.length <= longTitle">
            {{ m.title }}
          </h1>
          @if (screen.editable()) {
            <button
              mtIconButton
              icon="compose"
              size="sm"
              label="Edit title"
              tooltipKbd="e"
              (click)="editTitle()"
            ></button>
          }
        </div>
      }
      @if (screen.recentUpdate(); as text) {
        <p class="caption t-3 updated" role="status">{{ text }}</p>
      }

      <div class="mt-row mt-wrap people">
        <span class="field">
          <span class="caption t-3">Responsible</span>
          @if (screen.editable()) {
            <button
              type="button"
              class="mt-chip"
              [mtMenuTrigger]="responsibleMenu"
              aria-label="Change responsible lawyer"
            >
              <mt-avatar [name]="responsibleName()" [colorKey]="m.responsibleUid" size="xs" />{{ responsibleName()
              }}<mt-icon name="chevron-down" />
            </button>
          } @else {
            <span class="mt-row person"
              ><mt-avatar [name]="responsibleName()" [colorKey]="m.responsibleUid" size="xs" />{{
                responsibleName()
              }}</span
            >
          }
        </span>
        <span class="field">
          <span class="caption t-3">Team</span>
          @if (team().length) {
            <mt-avatar-group [people]="team()" size="xs" [max]="4" />
          } @else {
            <span class="caption t-3">No one yet</span>
          }
          @if (screen.editable()) {
            <button mtIconButton icon="user-plus" size="sm" label="Change team" [mtMenuTrigger]="teamMenu"></button>
          }
        </span>
        <span class="field labels" role="group" aria-label="Labels">
          <span class="caption t-3">Labels</span>
          @for (label of m.labels; track label) {
            <span class="mt-chip label"
              >{{ label }}
              @if (screen.editable()) {
                <button
                  mtIconButton
                  icon="x"
                  size="sm"
                  [label]="'Remove label ' + label"
                  [tooltip]="false"
                  (click)="removeLabel(label)"
                ></button>
              }
            </span>
          } @empty {
            @if (!screen.editable()) {
              <span class="caption t-3">None</span>
            }
          }
          @if (screen.editable()) {
            <button mtButton variant="ghost" size="sm" iconStart="plus" (click)="addLabel()">Label</button>
          }
        </span>
        <span class="field" data-testid="matter-referral">
          <span class="caption t-3">Referred by</span>
          @if (m.referrerContactId) {
            <a class="mt-chip" [routerLink]="['/contacts']" [queryParams]="{ contact: m.referrerContactId }">{{
              referral()
            }}</a>
          } @else {
            <span [class]="referral() ? 'person' : 'caption t-3'">{{ referral() ?? 'Not recorded' }}</span>
          }
          @if (screen.editable()) {
            <button mtIconButton icon="compose" size="sm" label="Change referral" (click)="editReferral()"></button>
          }
        </span>
        @if (screen.canPrivileged()) {
          <span class="field">
            <mt-switch
              label="Privileged"
              [disabled]="!screen.editable() || busy()"
              [ngModel]="m.privileged"
              (ngModelChange)="setPrivileged($event)"
            />
          </span>
        }
      </div>

      <ng-template #statusMenu>
        <mt-menu aria-label="Change status to">
          @for (choice of choices(); track choice.to) {
            <button mtMenuItem [disabled]="!!choice.blocked" (click)="changeStatus(choice)">
              {{ choice.label }}
              @if (choice.blocked; as why) {
                <span class="mt-sr">. {{ why }}</span>
              }
            </button>
          }
        </mt-menu>
      </ng-template>
      <ng-template #responsibleMenu>
        <mt-menu aria-label="Responsible lawyer">
          @for (person of screen.assignees(); track person.uid) {
            <button
              mtMenuItem
              [icon]="person.uid === m.responsibleUid ? 'check' : undefined"
              (click)="setResponsible(person.uid)"
            >
              {{ person.name }}
            </button>
          }
        </mt-menu>
      </ng-template>
      <ng-template #teamMenu>
        <mt-menu aria-label="Team">
          @for (person of screen.assignees(); track person.uid) {
            <button
              mtMenuItemCheckbox
              [checked]="m.teamUids.includes(person.uid)"
              (checkedChange)="toggleTeam(person.uid, $event)"
            >
              {{ person.name }}
            </button>
          }
        </mt-menu>
      </ng-template>
      <ng-template #moreMenu>
        <mt-menu aria-label="Matter actions">
          <button mtMenuItem icon="copy" kbd="y" (click)="copyNumber()">Copy matter number</button>
          <button mtMenuItem icon="external" (click)="openInNewTab()">Open in new tab</button>
          @if (!screen.deleted()) {
            <button mtMenuItem [icon]="pinned() ? 'pin-off' : 'pin'" (click)="togglePin()">
              {{ pinned() ? 'Unpin matter' : 'Pin matter' }}
            </button>
          }
          @if (canRenumber()) {
            <button mtMenuItem icon="compose" (click)="renumber()">Change matter number…</button>
          }
          @if (screen.editable()) {
            <button mtMenuItem icon="link" (click)="editLink()">{{ link() ? 'Edit link…' : 'Add link…' }}</button>
            @if (m.externalUrl) {
              <button mtMenuItem icon="x" (click)="removeLink()">Remove link</button>
            }
          }
          @if (canDraft()) {
            <button mtMenuItem icon="draft" (click)="draftLetter()">Draft a letter with Clerk…</button>
          }
          @if (upgradeTo(); as version) {
            <button mtMenuItem icon="arrow-up-right" (click)="upgradeTemplate(version)">
              Upgrade matter to v{{ version }}…
            </button>
          }
          @if (canClose()) {
            <button mtMenuItem icon="archive" (click)="closeMatter()">Close matter…</button>
          }
          @if (canHold()) {
            <button mtMenuItem icon="flag" (click)="setLegalHold(!m.legalHold?.on)">
              {{ m.legalHold?.on ? 'Release legal hold…' : 'Place legal hold…' }}
            </button>
          }
          @if (screen.canDelete() && !screen.deleted()) {
            <mt-menu-separator />
            <button mtMenuItem icon="trash" tone="danger" (click)="deleteMatter()">Delete matter…</button>
          }
        </mt-menu>
      </ng-template>
    }
  `,
  styles: `
    .mt-matter-head {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      min-width: 0;
    }
    .mt-matter-head .meta,
    .mt-matter-head .people,
    .mt-matter-head .actions,
    .mt-matter-head .field {
      gap: var(--space-8);
      align-items: center;
    }
    .mt-matter-head .people {
      gap: var(--space-16);
    }
    .mt-matter-head .field {
      display: inline-flex;
      flex-wrap: wrap;
    }
    .mt-matter-head .num {
      font: 500 12px/16px var(--font-mono);
      color: var(--text-secondary);
    }
    .mt-matter-head .title-row {
      gap: var(--space-4);
      align-items: flex-start;
      min-width: 0;
    }
    .mt-matter-head .title {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      overflow: hidden;
    }
    .mt-matter-head .title-form {
      gap: var(--space-8);
      align-items: flex-end;
    }
    .mt-matter-head .updated {
      margin: 0;
    }
    .mt-matter-head .person {
      gap: var(--space-6);
      font: 500 12px/16px var(--font-sans);
    }
    .mt-matter-head a.num.linked {
      display: inline-flex;
      align-items: center;
      gap: var(--space-4);
      color: var(--text-primary);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .mt-matter-head a.num.linked:hover {
      color: var(--text-brand);
    }
    .mt-matter-head .mt-chip.label {
      cursor: default;
      padding-inline-end: 3px;
    }
  `,
})
export class MatterHeader {
  protected readonly screen = inject(MatterScreen);
  private readonly timer = inject(TimerStore);
  /** The timer (BILL-02) can start here: a live matter and a role that records time. */
  protected readonly canTime = computed(() => this.timer.canRecord() && !this.screen.deleted());
  private readonly flags = inject(FeatureFlagService);
  private readonly pins = inject(PinnedMatters);
  /** Whether I've pinned this matter to the sidebar (CORE-23). */
  readonly pinned = computed(() => {
    const id = this.screen.value()?.id;
    return !!id && this.pins.isPinned(id);
  });
  private readonly canBilling = can('billing.view');
  private readonly canClerk = can('clerk.use');
  /** Clerk drafting (AI-10): on, for a role that uses Clerk, on a matter that can still change. */
  protected readonly canDraft = computed(
    () =>
      this.canClerk() &&
      this.flags.isOn('clerk.enabled') &&
      this.flags.isOn('clerk.features.drafting') &&
      !this.screen.deleted() &&
      !this.screen.archived(),
  );
  /** What the matter's invoices still owe (BILL-08), for billing roles while invoicing is on; hidden at zero. */
  protected readonly outstanding = computed(() => {
    const cents = this.screen.value()?.outstandingCents ?? 0;
    return cents > 0 && this.canBilling() && this.flags.isOn('billing.invoicing') ? formatAud(cents) : null;
  });
  protected readonly timerLabel = computed(() => {
    if (this.timer.timer()?.matterId !== this.screen.value()?.id) return 'Start timer';
    return this.timer.running() ? 'Pause timer' : 'Resume timer';
  });
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly longTitle = LONG_TITLE;
  protected readonly statusLabel = statusLabel;
  protected readonly busy = signal(false);
  protected readonly editingTitle = signal(false);
  protected readonly titleDraft = signal('');
  protected readonly titleError = signal<string | null>(null);

  protected readonly conflictText = computed(() => conflictBadgeText(this.screen.value()?.conflictCheck?.status));
  protected readonly conflictTone = computed(
    () => CONFLICT_STATUS_TONES[this.screen.value()?.conflictCheck?.status ?? 'pending'],
  );
  protected readonly responsibleName = computed(() => {
    const uid = this.screen.value()?.responsibleUid;
    return uid ? this.screen.memberName(uid) : '';
  });
  protected readonly team = computed(() =>
    (this.screen.value()?.teamUids ?? []).map((uid) => ({ id: uid, name: this.screen.memberName(uid) })),
  );
  protected readonly statusEditable = computed(() => this.screen.canStatus() && !this.screen.deleted());
  protected readonly choices = computed(() => {
    const matter = this.screen.value();
    return matter ? statusChoices(matter.status, conflictAllowsOpening(matter.conflictCheck?.status)) : [];
  });
  /** A newer published version of the matter's template (CORE-07), for those who may edit the matter. */
  protected readonly upgradeTo = computed(() => (this.screen.editable() ? this.screen.upgradeVersion() : null));
  /** Lawyers and above can change the number (CORE-21a), never on a deleted matter. */
  protected readonly canRenumber = computed(() => this.screen.canRenumber() && !this.screen.readOnly());
  /** Owners and admins place or release a legal hold (CORE-19), which keeps a matter from destruction. */
  protected readonly canHold = computed(() => this.screen.canLegalHold() && !this.screen.deleted());
  /** The matter's link (CORE-21a: the same matter in 3E, say), when it is a safe http(s) URL. */
  protected readonly link = computed(() => {
    const url = this.screen.value()?.externalUrl;
    return isMatterLink(url) ? url : null;
  });
  readonly canClose = computed(
    () => this.statusEditable() && this.screen.canClose() && this.choices().some((choice) => choice.to === 'closed'),
  );
  /** The referrer contact (CORE-18), read for its name. */
  private readonly referrer = contactsRepository().watch(() => this.screen.value()?.referrerContactId ?? null);
  /** "Lighthouse Financial Advisers", "Walk-in", or null when nothing is recorded. */
  protected readonly referral = computed(() => {
    const matter = this.screen.value();
    const contact = this.referrer.value();
    return matter ? referralText(matter, contact ? contactDisplayName(contact) : null) : null;
  });

  // ---------- title ----------

  /** Starts editing the title (the Edit button, or `e`). */
  editTitle(): void {
    const matter = this.screen.value();
    if (!matter || !this.screen.editable()) return;
    this.titleDraft.set(matter.title);
    this.titleError.set(null);
    this.editingTitle.set(true);
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLInputElement>('.title-form input')?.select(), {
      injector: this.injector,
    });
  }

  protected cancelTitle(): void {
    this.editingTitle.set(false);
  }

  protected async saveTitle(): Promise<void> {
    const matter = this.screen.value();
    const title = this.titleDraft().trim();
    if (!matter) return;
    if (!title) {
      this.titleError.set('Enter a title.');
      return;
    }
    if (title.length > 200) {
      this.titleError.set('Keep it to 200 characters or fewer.');
      return;
    }
    if (title !== matter.title && !(await this.save({ title }))) return;
    this.editingTitle.set(false);
  }

  // ---------- people, labels, privileged ----------

  /** Makes `uid` the responsible lawyer (the header's menu, or ⌘K's "Assign…", CORE-15). */
  setResponsible(uid: string): void {
    if (uid !== this.screen.value()?.responsibleUid) void this.save({ responsibleUid: uid });
  }

  protected toggleTeam(uid: string, checked: boolean): void {
    const current = this.screen.value()?.teamUids ?? [];
    const next = checked ? [...new Set([...current, uid])] : current.filter((id) => id !== uid);
    void this.save({ teamUids: next });
  }

  protected removeLabel(label: string): void {
    void this.save({ labels: (this.screen.value()?.labels ?? []).filter((l) => l !== label) });
  }

  protected async addLabel(): Promise<void> {
    const label = await this.ask({ title: 'Add a label', label: 'Label', confirm: 'Add label', maxLength: 40 });
    const labels = this.screen.value()?.labels ?? [];
    if (label && !labels.includes(label)) await this.save({ labels: [...labels, label] });
  }

  protected setPrivileged(privileged: boolean): void {
    if (privileged !== this.screen.value()?.privileged) void this.save({ privileged });
  }

  /** Records who referred the matter, or its source, or clears it (CORE-18; client-direct). */
  protected async editReferral(): Promise<void> {
    const matter = this.screen.value();
    if (!matter || !this.screen.editable()) return;
    const { ReferralDialog } = await import('./referral-dialog');
    const choice = await this.dialogs.open<ReferralDialogData, ReferralChoice | undefined>(ReferralDialog, {
      data: {
        number: matter.number,
        hasReferral: !!(matter.referrerContactId || matter.referralSource),
        source: matter.referralSource,
        exclude: matter.clientContactIds,
      },
    }).result;
    if (choice === undefined) return;
    const { set, remove } = referralPatch(choice && 'contactId' in choice ? { contactId: choice.contactId } : choice);
    if (await this.save(set, remove)) {
      this.toasts.show({
        title:
          choice === null
            ? 'Referral cleared'
            : 'name' in choice
              ? `Referred by ${choice.name}`
              : `Source: ${REFERRAL_SOURCE_LABELS[choice.source]}`,
        tone: 'success',
      });
    }
  }

  /** A client-direct update of the matter (last write wins); false when it was refused. */
  private async save(patch: Record<string, unknown>, remove: readonly string[] = []): Promise<boolean> {
    const matter = this.screen.value();
    if (!matter || !this.screen.editable()) return false;
    this.busy.set(true);
    try {
      await this.screen.repo.update(matter.id, patch, remove.length ? { remove } : {});
      return true;
    } catch (error) {
      this.toasts.show({ title: 'That change didn’t save', description: errorCopy(error), tone: 'danger' });
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  // ---------- status and the "…" menu ----------

  protected async changeStatus(choice: StatusChoice): Promise<void> {
    const matter = this.screen.value();
    if (!matter || choice.blocked || !this.statusEditable()) return;
    if (choice.to === 'closed') return this.openClosing();
    if (matter.status === 'closed' || matter.status === 'archived') {
      if (choice.to === 'open') return this.reopen();
    }
    let reason: string | undefined;
    if (choice.needsReason) {
      reason = await this.ask({
        title: `Reopen ${matter.number}`,
        label: 'Reason',
        confirm: 'Reopen matter',
        maxLength: 500,
      });
      if (!reason) return;
    }
    await this.moveTo(choice.to, reason);
  }

  /** Closes the matter through its closing checklist (the header's menu, or ⌘K, CORE-15). */
  closeMatter(): void {
    if (this.canClose()) void this.openClosing();
  }

  private async openClosing(): Promise<void> {
    const matter = this.screen.value();
    if (!matter) return;
    const result = await this.dialogs.open<CloseMatterDialogData, Awaited<ReturnType<typeof this.screen.api.close>>>(
      CloseMatterDialog,
      { data: { matter: { id: matter.id, number: matter.number, type: matter.type }, api: this.screen.api } },
    ).result;
    if (!result) return;
    const cancelled = result.tasksCancelled;
    this.toasts.show({
      title: `${matter.number} is closed`,
      ...(cancelled
        ? { description: cancelled === 1 ? '1 open task cancelled.' : `${cancelled} open tasks cancelled.` }
        : {}),
      tone: 'success',
    });
  }

  /** Reopens a closed or archived matter with a reason (`matters-reopen`, CORE-19). */
  private async reopen(): Promise<void> {
    const matter = this.screen.value();
    if (!matter) return;
    await this.ask({
      title: `Reopen ${matter.number}`,
      label: 'Reason',
      confirm: 'Reopen matter',
      description: 'The matter becomes editable again and leaves the retention schedule until it closes again.',
      maxLength: 500,
      submit: async (reason) => {
        try {
          await this.screen.api.reopen({ matterId: matter.id, reason });
          this.toasts.show({ title: `${matter.number} is open`, tone: 'success' });
          return undefined;
        } catch (error) {
          return changeStatusErrorCopy(error);
        }
      },
    });
  }

  /** Places or releases a legal hold (`matters-setLegalHold`, CORE-19), with a reason. */
  protected async setLegalHold(on: boolean): Promise<void> {
    const matter = this.screen.value();
    if (!matter || !this.canHold()) return;
    await this.ask({
      title: on ? `Place a legal hold on ${matter.number}` : `Release the legal hold on ${matter.number}`,
      label: 'Reason',
      confirm: on ? 'Place hold' : 'Release hold',
      description: on
        ? 'While the hold is on, the matter is never offered for destruction.'
        : 'A closed matter gets its destruction date back from its closing day.',
      maxLength: 500,
      submit: async (reason) => {
        try {
          await this.screen.api.setLegalHold({ matterId: matter.id, on, reason });
          this.toasts.show({ title: on ? 'Legal hold placed' : 'Legal hold released', tone: 'success' });
          return undefined;
        } catch (error) {
          return changeStatusErrorCopy(error);
        }
      },
    });
  }

  private async moveTo(to: MatterStatus, reason?: string): Promise<void> {
    const matter = this.screen.value();
    if (!matter) return;
    this.busy.set(true);
    try {
      await this.screen.api.changeStatus({ matterId: matter.id, to, ...(reason ? { reason } : {}) });
      this.toasts.show({ title: `${matter.number} is ${statusLabel(to).toLowerCase()}`, tone: 'success' });
    } catch (error) {
      this.toasts.show({
        title: 'Couldn’t change the status',
        description: changeStatusErrorCopy(error),
        tone: 'danger',
      });
    } finally {
      this.busy.set(false);
    }
  }

  // ---------- number and external reference (CORE-21a) ----------

  /** Gives the matter a typed number (`matters-renumber`); a number another matter has is refused in the dialog. */
  protected async renumber(): Promise<void> {
    const matter = this.screen.value();
    if (!matter || !this.canRenumber()) return;
    await this.ask({
      title: `Change ${matter.number}`,
      label: 'Matter number',
      confirm: 'Change number',
      description: 'Use your own number, or the one the firm uses elsewhere. Numbers are unique in your practice.',
      initial: matter.number,
      maxLength: MATTER_NUMBER_MAX_LENGTH,
      submit: async (number) => {
        const problem = matterNumberProblem(number);
        if (problem) return problem;
        if (number === matter.number) return undefined;
        try {
          await this.screen.api.renumber({ matterId: matter.id, number });
          this.toasts.show({ title: `Renumbered to ${number}`, tone: 'success' });
          return undefined;
        } catch (error) {
          return errorCodeOf(error) === 'ALREADY_EXISTS'
            ? `Another matter already has ${number}.`
            : matterErrorCopy(error);
        }
      },
    });
  }

  /** Links the matter to a web address (client-direct `externalUrl`); the number then opens it. */
  protected async editLink(): Promise<void> {
    const matter = this.screen.value();
    if (!matter || !this.screen.editable()) return;
    await this.ask({
      title: matter.externalUrl ? `Edit the link for ${matter.number}` : `Link ${matter.number}`,
      label: 'Web address',
      confirm: 'Save link',
      description: 'Where the matter also lives, such as the firm’s 3E. The matter number opens it.',
      initial: matter.externalUrl ?? '',
      maxLength: MATTER_LINK_MAX_LENGTH,
      submit: async (input) => {
        const url = normaliseMatterLink(input);
        if (!url) return 'Enter a web address, like https://3e.yourfirm.com.au/matter/1234.';
        if (url === matter.externalUrl) return undefined;
        try {
          await this.screen.repo.update(matter.id, { externalUrl: url });
          return undefined;
        } catch (error) {
          return errorCopy(error);
        }
      },
    });
  }

  protected async removeLink(): Promise<void> {
    const matter = this.screen.value();
    if (!matter?.externalUrl || !this.screen.editable()) return;
    this.busy.set(true);
    try {
      await this.screen.repo.update(matter.id, {}, { remove: ['externalUrl'] });
      this.toasts.show({ title: 'Link removed', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'That change didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.busy.set(false);
    }
  }

  /** Starts, pauses or resumes the timer on this matter. */
  protected toggleTimer(matter: { id: string; number: string }): void {
    this.timer.toggle({ matterId: matter.id, matterNumber: matter.number });
  }

  async copyNumber(): Promise<void> {
    const number = this.screen.value()?.number;
    if (!number) return;
    try {
      await navigator.clipboard.writeText(number);
      this.toasts.show({ title: `Copied ${number}`, tone: 'success' });
    } catch {
      this.toasts.show({ title: 'Couldn’t copy the matter number', tone: 'danger' });
    }
  }

  /**
   * Moves the matter to a newer version of its template (`matters-upgradeTemplate`): its stage
   * carries over (mapped when the version dropped it) and missing tasks are added; nothing is removed.
   */
  protected async upgradeTemplate(version: number): Promise<void> {
    const matter = this.screen.value();
    if (!matter || !this.screen.editable()) return;
    const confirmed = await this.dialogs.confirm({
      title: `Upgrade ${matter.number} to v${version}?`,
      body: `The matter moves to version ${version} of its template. Only tasks it doesn’t have yet are added; existing tasks, dates and the matter’s stage stay as they are.`,
      confirmLabel: `Upgrade to v${version}`,
    });
    if (!confirmed) return;
    this.busy.set(true);
    try {
      const result = await this.screen.api.upgradeTemplate({ matterId: matter.id, version });
      const added = result.createdTaskIds.length;
      this.toasts.show({
        title: `Upgraded to v${result.version}`,
        description: added === 0 ? 'No tasks were added.' : added === 1 ? '1 task added.' : `${added} tasks added.`,
        tone: 'success',
      });
    } catch (error) {
      this.toasts.show({ title: 'Couldn’t upgrade the matter', description: matterErrorCopy(error), tone: 'danger' });
    } finally {
      this.busy.set(false);
    }
  }

  /** Pins the matter to my sidebar, or unpins it (the "…" menu, or ⌘K; CORE-23). */
  togglePin(): void {
    const matter = this.screen.value();
    if (matter && !this.screen.deleted()) void this.pins.toggle({ id: matter.id, number: matter.number });
  }

  protected openInNewTab(): void {
    globalThis.open?.(globalThis.location?.href ?? '/', '_blank', 'noopener');
  }

  protected async deleteMatter(): Promise<void> {
    const matter = this.screen.value();
    if (!matter || !this.screen.canDelete()) return;
    const confirmed = await this.dialogs.confirm({
      title: `Delete ${matter.number}?`,
      body: 'The matter and everything on it become read-only and leave your lists. An owner or admin can restore it within 30 days.',
      confirmLabel: 'Delete matter',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await this.screen.repo.softDelete(matter.id);
      const api = this.screen.api;
      this.toasts.show({
        title: `Deleted ${matter.number}`,
        tone: 'success',
        // Owners and admins can take it back straight away (CORE-03, `matters-restore`).
        ...(this.screen.canRestore()
          ? { action: { label: 'Undo', run: () => void this.undoDelete(api, matter.id, matter.number) } }
          : {}),
      });
      await this.router.navigateByUrl('/matters');
    } catch (error) {
      this.toasts.show({ title: 'Couldn’t delete the matter', description: errorCopy(error), tone: 'danger' });
    }
  }

  private async undoDelete(api: MatterScreen['api'], matterId: string, number: string): Promise<void> {
    try {
      await api.restore({ matterId });
      this.toasts.show({ title: `Restored ${number}`, tone: 'success' });
      await this.router.navigate(['/matters', matterId]);
    } catch (error) {
      this.toasts.show({ title: 'Couldn’t restore the matter', description: errorCopy(error), tone: 'danger' });
    }
  }

  protected draftLetter(): void {
    const id = this.screen.id();
    if (id) void this.router.navigate(['/matters', id, 'drafts', 'new']);
  }

  private ask(data: MatterNameDialogData): Promise<string | undefined> {
    return this.dialogs.open<MatterNameDialogData, string | undefined>(MatterNameDialog, { data }).result;
  }
}
