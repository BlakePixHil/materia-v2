import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { can, type JobView } from '@materia/data-access';
import {
  contactsRepository,
  MEMBER_LIST_QUERY,
  membersRepository,
  safeCustodyCallables,
  safeCustodyRepository,
  type PacketItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  allowedMovements,
  currentItemIndex,
  locationLabel,
  SAFE_CUSTODY_ITEM_LABELS,
  SAFE_CUSTODY_MOVEMENT_LABELS,
  SAFE_CUSTODY_REAUTH_MINUTES,
  SAFE_CUSTODY_STATUS_LABELS,
  type RecordableMovement,
  type RecordMovementResult,
  type SafeCustodyMovement,
} from '@materia/domain';
import {
  DialogService,
  formatDateOnly,
  MT_ORG_TIMEZONE,
  MtBadge,
  MtButton,
  MtEmptyState,
  MtKeyFacts,
  MtNote,
  ToastService,
  type KeyFactVm,
} from '@materia/ui';

import { MovementDialog, type MovementDialogData } from './movement-dialog';
import { PacketDialog, type PacketDialogData, type PacketDialogResult } from './packet-dialog';
import { contactMatterOptions } from './pickers';
import { EXPORT_NAVIGATOR, safeCustodyErrorCopy, STATUS_TONES } from './safe-custody-view';
import { AuthState } from '../../core/auth/auth-state';
import { injectRecentLogin } from '../../core/auth/reauth-dialog';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { JobProgress } from '../../core/jobs/job-progress';
import { MtPageActions } from '../../shell/page-header';

/** A movement as the history lists it. */
interface MovementVm {
  key: string;
  label: string;
  when: string;
  who: string;
  to: string | null;
  toContactId: string | null;
  reason: string;
  authority: { matterId: string; documentId: string } | null;
  approvedBy: string | null;
  location: string | null;
}

const ACTION_LABELS: Record<RecordableMovement, string> = {
  out: 'Take out',
  returned: 'Return to the safe',
  released: 'Release',
  destroyed: 'Destroy',
};

/**
 * One packet (`/safe-custody/:id`, CORE-17): what it holds (the current will flagged), where it is,
 * and its chain of custody, with the movements its status allows. A pending destruction asks a
 * second lawyer to confirm. When the testator has died it offers to open the probate matter. The
 * receipt PDF is an export job.
 */
@Component({
  selector: 'mt-safe-custody-packet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, JobProgress, MtBadge, MtButton, MtEmptyState, MtKeyFacts, MtNote, MtPageActions],
  host: { class: 'mt-col mt-sc-packet' },
  template: `
    @switch (state()) {
      @case ('loading') {
        <p role="status" class="mt-sc-muted">Loading the packet…</p>
      }
      @case ('error') {
        <mt-note tone="danger">{{ errorText() }}</mt-note>
      }
      @case ('missing') {
        <mt-empty-state
          title="This packet isn’t in the register"
          description="It may have been removed. The register lists every packet the firm holds."
          icon="archive"
          [headingLevel]="1"
        >
          <a mtButton size="sm" routerLink="/safe-custody">Open the register</a>
        </mt-empty-state>
      }
      @default {
        @if (packet(); as p) {
          <ng-template mtPageActions>
            @if (canEdit()) {
              <button
                mtButton
                size="sm"
                variant="secondary"
                iconStart="document"
                [loading]="startingReceipt()"
                (click)="receipt(p)"
              >
                Receipt PDF
              </button>
            }
          </ng-template>
          <header class="mt-sc-head">
            <div class="mt-col" style="gap: 2px; min-width: 0">
              <span class="mono-s mt-sc-muted">{{ p.packetNo }}</span>
              <h1 class="mt-sc-title">
                Original will of
                <a [routerLink]="['/contacts']" [queryParams]="{ contact: p.testatorContactId }">{{
                  p.testatorName
                }}</a>
              </h1>
            </div>
            <mt-badge [tone]="tones[p.status]" data-testid="packet-status">{{ statusLabels[p.status] }}</mt-badge>
          </header>

          @if (testator()?.dateOfDeath; as died) {
            <mt-note tone="warning" data-testid="testator-deceased">
              {{ p.testatorName }} died on {{ date(died) }}.
              @if (canOpenMatter() && open(p)) {
                <a [routerLink]="['/matters/new']" [queryParams]="{ type: 'probate', deceased: p.testatorContactId }">
                  Open a probate matter
                </a>
              }
            </mt-note>
          }

          @if (p.pendingDestruction; as pending) {
            <mt-note tone="danger" role="alert" data-testid="pending-destruction">
              {{ memberName(pending.requestedBy) }} asked to destroy this original on {{ date(pending.requestedAt) }}:
              “{{ pending.reason }}”. A second lawyer must confirm.
              <span class="mt-row" style="gap: var(--space-8); margin-top: var(--space-8)">
                @if (mayRelease() && pending.requestedBy !== me()) {
                  <button mtButton size="sm" variant="danger" [loading]="deciding()" (click)="decide(p, true)">
                    Confirm destruction
                  </button>
                }
                @if (mayRelease()) {
                  <button mtButton size="sm" variant="secondary" [loading]="deciding()" (click)="decide(p, false)">
                    {{ pending.requestedBy === me() ? 'Withdraw' : 'Decline' }}
                  </button>
                }
                <a [routerLink]="['/matters', pending.authority.matterId, 'documents', pending.authority.documentId]">
                  Open the authority
                </a>
              </span>
            </mt-note>
          }

          @if (jobId(); as id) {
            <mt-job-progress [jobId]="id" label="Safe custody receipt" (finished)="downloadReceipt(id, $event)" />
          }

          @if (canEdit() && open(p)) {
            <div class="mt-row mt-sc-actions" role="group" aria-label="Packet actions">
              @for (kind of movements(); track kind) {
                <button
                  mtButton
                  size="sm"
                  [variant]="kind === 'destroyed' ? 'ghost' : 'secondary'"
                  [disabled]="!!p.pendingDestruction"
                  (click)="move(p, kind)"
                >
                  {{ actionLabels[kind] }}
                </button>
              }
              <button mtButton size="sm" variant="ghost" iconStart="compose" (click)="edit(p)">Edit</button>
            </div>
          }

          <div class="mt-sc-cards">
            <section class="mt-sc-card" aria-labelledby="sc-held-h">
              <h2 id="sc-held-h">Originals</h2>
              <ul class="mt-sc-list">
                @for (item of p.items; track $index) {
                  <li>
                    <span class="label">{{ itemLabels[item.kind] }}</span>
                    @if (item.date) {
                      <span class="mt-sc-muted">dated {{ date(item.date) }}</span>
                    }
                    @if ($index === current()) {
                      <mt-badge tone="brand">Current</mt-badge>
                    }
                    @if (item.description) {
                      <span class="caption mt-sc-muted mt-sc-wide">{{ item.description }}</span>
                    }
                  </li>
                }
              </ul>
            </section>
            <section class="mt-sc-card" aria-labelledby="sc-details-h">
              <h2 id="sc-details-h">Details</h2>
              <mt-key-facts [facts]="facts()" />
              @if (matters().length) {
                <h3 class="caption mt-sc-muted" id="sc-matters-h">The testator’s matters</h3>
                <ul class="mt-sc-list" aria-labelledby="sc-matters-h" data-testid="testator-matters">
                  @for (matter of matters(); track matter.value) {
                    <li>
                      <a [routerLink]="['/matters', matter.value]">{{ matter.label }}</a>
                    </li>
                  }
                </ul>
              }
            </section>
          </div>

          <section class="mt-sc-card" aria-labelledby="sc-history-h">
            <h2 id="sc-history-h">Chain of custody</h2>
            <ol class="mt-sc-history">
              @for (m of history(); track m.key) {
                <li>
                  <span class="label">{{ m.label }}</span>
                  <span class="mt-sc-muted">{{ m.when }} · {{ m.who }}</span>
                  @if (m.to) {
                    <span>
                      To
                      @if (m.toContactId) {
                        <a [routerLink]="['/contacts']" [queryParams]="{ contact: m.toContactId }">{{ m.to }}</a>
                      } @else {
                        {{ m.to }}
                      }
                    </span>
                  }
                  @if (m.location) {
                    <span>At {{ m.location }}</span>
                  }
                  @if (m.reason) {
                    <span class="mt-sc-wide">{{ m.reason }}</span>
                  }
                  @if (m.authority; as a) {
                    <a [routerLink]="['/matters', a.matterId, 'documents', a.documentId]">Authority</a>
                  }
                  @if (m.approvedBy) {
                    <span class="mt-sc-muted">Confirmed by {{ m.approvedBy }}</span>
                  }
                </li>
              }
            </ol>
          </section>
        }
      }
    }
  `,
  styles: `
    :host {
      gap: var(--space-16);
      min-width: 0;
      max-width: 960px;
    }
    .mt-sc-muted {
      color: var(--text-tertiary);
    }
    p.mt-sc-muted {
      margin: 0;
    }
    .mt-sc-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-12);
    }
    .mt-sc-title {
      margin: 0;
      font: 600 20px/28px var(--font-sans);
      color: var(--text-primary);
    }
    .mt-sc-title a {
      color: inherit;
    }
    .mt-sc-actions {
      flex-wrap: wrap;
      gap: var(--space-8);
    }
    .mt-sc-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: var(--space-16);
      align-items: start;
    }
    .mt-sc-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
      padding: var(--space-16);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg, 10px);
      background: var(--bg-surface);
      min-width: 0;
    }
    .mt-sc-card h2 {
      margin: 0;
      font: 600 13px/18px var(--font-sans);
      color: var(--text-primary);
    }
    .mt-sc-list,
    .mt-sc-history {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
    }
    .mt-sc-list li,
    .mt-sc-history li {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-4) var(--space-8);
      padding: var(--space-8) 0;
      border-top: 1px solid var(--border-subtle);
      font: 400 13px/18px var(--font-sans);
      color: var(--text-secondary);
    }
    .mt-sc-list li:first-child,
    .mt-sc-history li:first-child {
      border-top: 0;
    }
    .mt-sc-card h3 {
      margin: 0;
    }
    .mt-sc-wide {
      flex-basis: 100%;
    }
  `,
})
export class SafeCustodyPacketPage {
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly auth = inject(AuthState);
  private readonly navigate = inject(EXPORT_NAVIGATOR);
  private readonly timeZone = inject(MT_ORG_TIMEZONE);
  private readonly api = safeCustodyCallables(inject(CALLABLES));
  private readonly recentLogin = injectRecentLogin(SAFE_CUSTODY_REAUTH_MINUTES);

  protected readonly canEdit = can('safeCustody.edit');
  protected readonly mayRelease = can('safeCustody.release');
  protected readonly canOpenMatter = can('matter.create');
  protected readonly tones = STATUS_TONES;
  protected readonly statusLabels = SAFE_CUSTODY_STATUS_LABELS;
  protected readonly itemLabels = SAFE_CUSTODY_ITEM_LABELS;
  protected readonly actionLabels = ACTION_LABELS;
  protected readonly me = computed(() => this.auth.user()?.uid ?? null);

  private readonly params = toSignal(inject(ActivatedRoute).paramMap);
  private readonly id = computed(() => this.params()?.get('id') ?? null);
  private readonly doc = safeCustodyRepository().watch(() => this.id());
  protected readonly packet = this.doc.value;
  private readonly testatorDoc = contactsRepository().watch(() => this.packet()?.testatorContactId ?? null);
  protected readonly testator = this.testatorDoc.value;
  /** The will matter and any matter the testator is on, such as the probate matter opened after their death. */
  protected readonly matters = contactMatterOptions(
    computed(() => this.packet()?.testatorContactId ?? null),
    computed(() => this.packet()?.matterId),
  );
  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 }, { live: false });

  protected readonly jobId = signal<string | null>(null);
  protected readonly startingReceipt = signal(false);
  protected readonly deciding = signal(false);

  protected readonly state = computed(() => {
    if (this.doc.status() === 'error') return 'error';
    if (!this.doc.exists() || this.packet()?.deletedAt) return 'missing';
    return this.packet() ? 'ready' : 'loading';
  });
  protected readonly errorText = computed(() => errorCopy(this.doc.error()));
  protected readonly current = computed(() => currentItemIndex(this.packet()?.items ?? []));
  protected readonly movements = computed(() => {
    const packet = this.packet();
    return packet ? allowedMovements(packet.status) : [];
  });

  protected readonly facts = computed<KeyFactVm[]>(() => {
    const p = this.packet();
    if (!p) return [];
    const facts: KeyFactVm[] = [
      { id: 'location', label: 'Kept at', value: locationLabel(p.location), copyable: false },
      { id: 'received', label: 'Received', value: this.date(p.receivedOn), copyable: false },
      { id: 'responsible', label: 'Responsible lawyer', value: this.memberName(p.responsibleUid), copyable: false },
    ];
    if (p.lastVerified) {
      facts.push({
        id: 'verified',
        label: 'Last stocktake',
        value: `${this.date(p.lastVerified.on)} · ${this.memberName(p.lastVerified.by)}`,
        copyable: false,
      });
    }
    if (p.notes) facts.push({ id: 'notes', label: 'Notes', value: p.notes, copyable: false });
    return facts;
  });

  /** Newest first. */
  protected readonly history = computed<MovementVm[]>(() =>
    (this.packet()?.movements ?? []).map((m, index) => this.movementVm(m, index)).reverse(),
  );

  private readonly memberNames = computed(
    () => new Map(this.members.value().map((member) => [member.id, member.displayName] as const)),
  );

  protected memberName(uid: string): string {
    if (uid === this.me()) return 'You';
    return this.memberNames().get(uid) ?? 'A former member';
  }

  protected date(value: string | Date): string {
    return formatDateOnly(value, this.timeZone);
  }

  private when(at: Date): string {
    const time = new Intl.DateTimeFormat('en-AU', { timeZone: this.timeZone, hour: 'numeric', minute: '2-digit' });
    return `${this.date(at)}, ${time.format(at)}`;
  }

  private movementVm(m: SafeCustodyMovement, index: number): MovementVm {
    return {
      key: `${index}`,
      label: SAFE_CUSTODY_MOVEMENT_LABELS[m.kind],
      when: this.when(m.at),
      who: this.memberName(m.by),
      to: m.to ?? null,
      toContactId: m.toContactId ?? null,
      reason: m.reason,
      authority: m.authority ?? null,
      approvedBy: m.approvedBy ? this.memberName(m.approvedBy) : null,
      location: m.location ? locationLabel(m.location) : null,
    };
  }

  /** Still in the firm's custody (held or out). */
  protected open(packet: PacketItem): boolean {
    return packet.status === 'held' || packet.status === 'out';
  }

  protected async move(packet: WithId<PacketItem>, kind: RecordableMovement): Promise<void> {
    const result = await this.dialogs.open<MovementDialogData, RecordMovementResult>(MovementDialog, {
      data: { packet, kind },
    }).result;
    if (!result) return;
    this.toasts.show(
      result.pendingConfirmation
        ? {
            title: 'Destruction needs a second lawyer',
            description: 'The other lawyers have been asked to confirm it.',
            tone: 'neutral',
          }
        : {
            title: `${packet.packetNo} is ${SAFE_CUSTODY_STATUS_LABELS[result.status].toLowerCase()}`,
            tone: 'success',
          },
    );
  }

  protected async edit(packet: WithId<PacketItem>): Promise<void> {
    const result = await this.dialogs.open<PacketDialogData, PacketDialogResult>(PacketDialog, { data: { packet } })
      .result;
    if (result) this.toasts.show({ title: 'Changes saved', tone: 'success' });
  }

  protected async decide(packet: WithId<PacketItem>, approve: boolean): Promise<void> {
    if (this.deciding()) return;
    if (
      approve &&
      !(await this.dialogs.confirm({
        title: `Destroy ${packet.packetNo}?`,
        body: `Confirm that the original documents of ${packet.testatorName} are to be destroyed. This can’t be undone.`,
        confirmLabel: 'Confirm destruction',
        tone: 'danger',
        typedConfirmation: packet.packetNo,
      }))
    ) {
      return;
    }
    this.deciding.set(true);
    try {
      const result = await this.recentLogin('Confirming a destruction needs a fresh sign-in.', () =>
        this.api.confirmDestruction({ id: packet.id, approve }),
      );
      if (result) {
        this.toasts.show({
          title: approve ? `${packet.packetNo} recorded as destroyed` : 'Destruction declined',
          tone: approve ? 'success' : 'neutral',
        });
      }
    } catch (error) {
      this.toasts.show({ title: 'That didn’t work', description: safeCustodyErrorCopy(error), tone: 'danger' });
    } finally {
      this.deciding.set(false);
    }
  }

  protected async receipt(packet: WithId<PacketItem>): Promise<void> {
    if (this.startingReceipt()) return;
    this.startingReceipt.set(true);
    try {
      const { jobId } = await this.api.receipt({ id: packet.id });
      this.jobId.set(jobId);
    } catch (error) {
      this.toasts.show({ title: 'The receipt didn’t start', description: safeCustodyErrorCopy(error), tone: 'danger' });
    } finally {
      this.startingReceipt.set(false);
    }
  }

  protected async downloadReceipt(jobId: string, job: JobView): Promise<void> {
    if (job.status !== 'succeeded') return;
    try {
      const { url } = await this.api.exportUrl(jobId);
      this.navigate(url);
    } catch (error) {
      this.toasts.show({
        title: 'The receipt didn’t download',
        description: safeCustodyErrorCopy(error),
        tone: 'danger',
      });
    }
  }
}
