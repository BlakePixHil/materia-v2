import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import {
  canApproveEnrichment,
  ENRICHMENT_ALLOWANCE_MAX_CENTS,
  ENRICHMENT_ALLOWANCE_MIN_CENTS,
  enrichmentEstimateText,
  enrichmentProgress,
  formatUsdCents,
  microsToCents,
  type MigrationEnrichment,
  type MigrationEnrichmentPause,
} from '@materia/domain';
import { MtButton, MtMeter, MtNote, MtTextField, ToastService } from '@materia/ui';

import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { dollarsText, parseDollars } from '../settings/money';

const PAUSED: Record<MigrationEnrichmentPause, string> = {
  allowance: 'It used the allowance you approved. Raise it to carry on.',
  budget: 'The practice’s monthly Clerk budget is nearly used, so it stopped to leave the rest for people.',
  clerk_off: 'Clerk, or its suggestions, are switched off for the practice. Turn them on, then resume.',
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString('en-AU')} ${count === 1 ? one : many}`;

/**
 * One migration run's Clerk reading (MIG-09, D-21) on Settings → Clerk and AI, for owners and
 * admins: what counting the pages found and what it would cost, the allowance to approve (or "Not
 * now"), progress while it reads, why it paused (with Resume), and what is waiting once it's done.
 * Nothing that costs money runs before an approval; `migration-decideEnrichment` records it.
 */
@Component({
  selector: 'mt-migration-enrichment-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtMeter, MtNote, MtTextField, RouterLink],
  host: { 'data-migration-enrichment': '' },
  template: `
    @let e = enrichment();
    <div class="mt-col" style="gap: 12px">
      @switch (e.status) {
        @case ('estimating') {
          <p class="body" style="margin: 0" data-state="estimating">
            Counting the pages of the files migration run {{ e.runId }} loaded. Nothing is spent while it counts.
          </p>
        }
        @case ('running') {
          <p class="body" style="margin: 0" data-state="running">
            Clerk is reading the migrated files, one at a time beside the practice’s own work.
          </p>
          <mt-meter
            [label]="documentsLabel()"
            [value]="progress().documentsDone"
            [max]="progress().documents || 1"
            data-documents-meter
          />
          @if (progress().matters) {
            <mt-meter
              [label]="mattersLabel()"
              [value]="progress().mattersDone"
              [max]="progress().matters || 1"
              data-matters-meter
            />
          }
          <span class="caption t-3" data-spent>{{ spentText() }}</span>
        }
        @case ('done') {
          <p class="body" style="margin: 0" data-state="done">{{ doneText() }}</p>
          @if (e.suggestionsWaiting) {
            <div><a mtButton variant="secondary" routerLink="/inbox">Review the suggestions</a></div>
          }
        }
        @default {
          @if (e.status === 'paused' && e.pausedFor) {
            <mt-note tone="warning" data-state="paused">Clerk stopped reading. {{ pausedText(e.pausedFor) }}</mt-note>
          } @else if (e.status === 'declined') {
            <p class="body" style="margin: 0" data-state="declined">
              You chose not to, for now. Approve it whenever you’re ready.
            </p>
          }
          @if (e.estimate; as estimate) {
            <p class="body" style="margin: 0" data-estimate>
              Clerk can read {{ estimateText() }}, at your model’s list price.
            </p>
            <p class="caption t-3" style="margin: 0">
              It reads every migrated document so Clerk can search and cite it, reading scans by OCR, then each open
              estate matter’s notes and documents for its key dates, which it suggests for review. Nothing changes until
              a person accepts a suggestion. The practice’s monthly limit still applies.
            </p>
          }
          @if (canApprove()) {
            <form class="mt-row" style="gap: 12px; align-items: end; flex-wrap: wrap" (ngSubmit)="approve()">
              <mt-text-field
                name="enrichment-allowance"
                label="Allowance"
                description="The most it may spend, in US dollars."
                inputmode="decimal"
                suffix="USD"
                [error]="allowanceProblem() ?? undefined"
                [ngModel]="allowanceText()"
                (ngModelChange)="editAllowance($event ?? '')"
              />
              <button
                mtButton
                variant="primary"
                type="submit"
                [loading]="saving() === 'approve'"
                [disabled]="!!allowanceProblem()"
              >
                {{ e.status === 'paused' ? 'Resume' : 'Approve' }}
              </button>
              @if (e.status === 'awaiting_approval') {
                <button mtButton variant="ghost" type="button" [loading]="saving() === 'decline'" (click)="decline()">
                  Not now
                </button>
              }
            </form>
          }
        }
      }
    </div>
  `,
})
export class MigrationEnrichmentCard {
  private readonly callables = inject(CALLABLES);
  private readonly toasts = inject(ToastService);

  readonly enrichment = input.required<MigrationEnrichment>();

  protected readonly saving = signal<'approve' | 'decline' | null>(null);
  protected readonly progress = computed(() => enrichmentProgress(this.enrichment()));
  protected readonly canApprove = computed(() => canApproveEnrichment(this.enrichment()));
  protected readonly estimateText = computed(() => {
    const estimate = this.enrichment().estimate;
    return estimate ? enrichmentEstimateText(estimate) : '';
  });
  private readonly edited = signal<string | null>(null);
  /** The allowance typed, else the one offered (the estimate with headroom, or above what it spent). */
  protected readonly allowanceText = computed(() => this.edited() ?? dollarsText(this.offered()));
  protected editAllowance(value: string): void {
    this.edited.set(value);
  }
  private readonly offered = computed(() => {
    const e = this.enrichment();
    const spent = microsToCents(e.spentMicros);
    const base = e.status === 'paused' && e.allowanceCents ? e.allowanceCents * 2 : (e.suggestedAllowanceCents ?? 500);
    return Math.min(ENRICHMENT_ALLOWANCE_MAX_CENTS, Math.max(base, spent + 100));
  });
  private readonly allowanceCents = computed(() => parseDollars(this.allowanceText()));
  protected readonly allowanceProblem = computed(() => {
    const cents = this.allowanceCents();
    if (cents === undefined || cents === null) return 'Enter an amount in dollars, such as 25.';
    if (cents < ENRICHMENT_ALLOWANCE_MIN_CENTS || cents > ENRICHMENT_ALLOWANCE_MAX_CENTS)
      return `Enter from ${formatUsdCents(ENRICHMENT_ALLOWANCE_MIN_CENTS)} to ${formatUsdCents(ENRICHMENT_ALLOWANCE_MAX_CENTS)}.`;
    if (cents * 10_000 <= this.enrichment().spentMicros)
      return `It has already spent ${formatUsdCents(microsToCents(this.enrichment().spentMicros))}: enter more than that.`;
    return null;
  });

  protected readonly documentsLabel = computed(() => {
    const { documentsDone, documents } = this.progress();
    return `${documentsDone.toLocaleString('en-AU')} of ${plural(documents, 'document')} read`;
  });
  protected readonly mattersLabel = computed(() => {
    const { mattersDone, matters } = this.progress();
    return `${mattersDone.toLocaleString('en-AU')} of ${plural(matters, 'estate matter')} read for key dates`;
  });
  protected readonly spentText = computed(() => {
    const e = this.enrichment();
    const spent = formatUsdCents(microsToCents(e.spentMicros));
    return e.allowanceCents ? `About ${spent} of the ${formatUsdCents(e.allowanceCents)} allowance spent.` : '';
  });
  protected readonly doneText = computed(() => {
    const e = this.enrichment();
    const { read, events } = e.progress;
    const waiting = e.suggestionsWaiting ?? 0;
    const unreadable = e.unreadable ?? 0;
    return [
      `Clerk read ${plural(read, 'document')} and found ${plural(events, 'key date')}.`,
      waiting
        ? `${plural(waiting, 'suggestion is', 'suggestions are')} waiting for review.`
        : 'Nothing is waiting for review.',
      unreadable
        ? `${plural(unreadable, 'document')} couldn’t be read and ${unreadable === 1 ? 'is' : 'are'} listed for migration review.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  });

  protected pausedText(reason: MigrationEnrichmentPause): string {
    return PAUSED[reason];
  }

  protected async approve(): Promise<void> {
    const allowanceCents = this.allowanceCents();
    if (this.allowanceProblem() || typeof allowanceCents !== 'number') return;
    const resuming = this.enrichment().status === 'paused';
    if (await this.decide({ decision: 'approve', allowanceCents }, 'approve')) {
      this.edited.set(null);
      this.toasts.show({
        title: resuming ? 'Clerk is reading again' : 'Clerk will read the migrated files',
        tone: 'success',
      });
    }
  }

  protected async decline(): Promise<void> {
    if (await this.decide({ decision: 'decline' }, 'decline'))
      this.toasts.show({ title: 'Left for now. You can approve it later here.', tone: 'success' });
  }

  private async decide(
    input: { decision: 'approve'; allowanceCents: number } | { decision: 'decline' },
    what: 'approve' | 'decline',
  ): Promise<boolean> {
    this.saving.set(what);
    try {
      await this.callables.call(
        'migration-decideEnrichment',
        { runId: this.enrichment().runId, ...input },
        { idempotent: true },
      );
      return true;
    } catch (error) {
      this.toasts.show({ title: 'That didn’t save', description: errorCopy(error), tone: 'danger' });
      return false;
    } finally {
      this.saving.set(null);
    }
  }
}
