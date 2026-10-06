import { ChangeDetectionStrategy, Component, computed, inject, signal, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import { costsCallables } from '@materia/data-access/repository';
import {
  DISCLOSURE_REQUIREMENT_LABELS,
  DISCLOSURE_STATUS_LABELS,
  DISCLOSURE_UPDATE_REASON_LABELS,
  DISCLOSURE_WAIVER_REASON_LABELS,
  disclosureNeedText,
  disclosureRulesFor,
  joinNames,
  type CostsDisclosure,
  type CostsDisclosureStatus,
  type DisclosureEvent,
  type DisclosureResult,
  type DisclosureSentMethod,
} from '@materia/domain';
import {
  DialogService,
  formatAud,
  formatDateOnly,
  MtBadge,
  MtButton,
  MtNote,
  ToastService,
  type MtBadgeTone,
  type MtDateInput,
} from '@materia/ui';

import type { DisclosureSentData, DisclosureWaiverData } from './disclosure-dialogs';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { missingText } from '../document-templates/document-templates-view';
import { MatterScreen } from '../matter-detail/matter-screen';

const TONES: Record<CostsDisclosureStatus, MtBadgeTone> = {
  required: 'warning',
  update_required: 'warning',
  sent: 'success',
  updated: 'success',
  not_required: 'neutral',
  waived: 'neutral',
};

// How it was given, after "by": "by email", "by post", "by hand".
const SENT_BY: Record<DisclosureSentMethod, string> = { email: 'email', post: 'post', hand: 'hand' };

const EVENT_LABELS: Record<DisclosureEvent['action'], string> = {
  assessed: 'Assessed at intake',
  reassessed: 'Assessed again',
  update_required: 'Update required',
  generated: 'Disclosure generated',
  sent: 'Recorded as sent',
  waived: 'Recorded as not needed',
  waiver_removed: '“Not needed” removed',
  reminded: 'Reminder sent',
};

/**
 * The costs disclosure panel on a matter's Overview (BILL-06, flag `billing.costsDisclosure`;
 * `billing.view` roles): the status, what the estimate needs under the jurisdiction's rules (with
 * the rules' "illustrative" note until a practitioner signs them off), why an update is needed,
 * the last one sent, a lawyer's "not needed" and the history. Generate merges the band's template
 * into the matter's documents; Record as sent stops the reminders. Lawyers and above record that no
 * disclosure is needed, or remove that.
 */
@Component({
  selector: 'mt-matter-disclosure-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [RouterLink, MtBadge, MtButton, MtNote],
  host: { class: 'mt-matter-disclosure-panel' },
  template: `
    @let m = screen.value();
    <section class="mt-card" data-pad aria-labelledby="mt-ov-disclosure" data-testid="disclosure-panel">
      <div class="mt-card-h">
        <h2 class="mt-card-title" id="mt-ov-disclosure">Costs disclosure</h2>
        @if (m) {
          <mt-badge class="mt-ml" [tone]="tone()" data-testid="disclosure-status">{{ statusLabel() }}</mt-badge>
        }
      </div>
      @if (m) {
        @let d = disclosure();
        <p class="need" data-testid="disclosure-need">{{ needText() }}</p>
        @if (illustrative()) {
          <p class="caption t-3">
            The {{ m.jurisdiction }} disclosure rules are illustrative until a practitioner reviews them.
          </p>
        }
        @if (d.status === 'update_required') {
          <mt-note tone="warning" data-testid="disclosure-update">
            The estimate changed significantly{{ updateReasons() ? ': ' + updateReasons() : '' }}. Send the client an
            updated disclosure.
          </mt-note>
        } @else if (d.status === 'required' && d.requiredSince) {
          <p class="caption t-2" data-testid="disclosure-due">Due since {{ date(d.requiredSince) }}.</p>
        }
        @if (d.waiver; as waiver) {
          <p class="caption t-2" data-testid="disclosure-waiver">
            {{ waiverReason(waiver.reason) }}{{ waiver.note ? ': ' + waiver.note : '' }}. Recorded by
            {{ screen.memberName(waiver.by) }} on {{ date(waiver.at) }}.
          </p>
        }
        @if (d.sentOn) {
          <p class="caption t-2" data-testid="disclosure-sent">
            Last given {{ date(d.sentOn) }}{{ d.sentMethod ? ' by ' + sentMethod(d.sentMethod) : ''
            }}{{ d.sentEstimateCents !== undefined ? ', on an estimate of ' + money(d.sentEstimateCents) : '' }}.
          </p>
        }
        @if (d.documentId) {
          <a class="caption" [routerLink]="['/matters', m.id, 'documents', d.documentId]"
            >Open the latest generated disclosure</a
          >
        }
        @if (screen.editable() && (canGenerate() || canRecord() || canWaive() || canUnwaive())) {
          <div class="mt-row actions">
            @if (canGenerate()) {
              <button mtButton size="sm" type="button" [loading]="generating()" (click)="generate()">
                {{ updated() ? 'Generate updated disclosure' : 'Generate disclosure' }}
              </button>
            }
            @if (canRecord()) {
              <button mtButton size="sm" variant="ghost" type="button" (click)="recordSent()">Record as sent</button>
            }
            @if (canWaive()) {
              <button mtButton size="sm" variant="ghost" type="button" (click)="waive()">No disclosure needed</button>
            }
            @if (canUnwaive()) {
              <button mtButton size="sm" variant="ghost" type="button" (click)="removeWaiver()">
                A disclosure is needed after all
              </button>
            }
          </div>
        }
        @if (history().length) {
          <details class="history">
            <summary class="caption">Disclosure history ({{ history().length }})</summary>
            <ol>
              @for (event of history(); track $index) {
                <li>
                  <p class="caption t-3">{{ when(event.at) }} · {{ who(event.by) }}</p>
                  <p class="caption t-2">{{ eventLine(event) }}</p>
                </li>
              }
            </ol>
          </details>
        }
      }
    </section>
  `,
  styles: `
    .mt-matter-disclosure-panel {
      display: block;
    }
    .mt-matter-disclosure-panel h2,
    .mt-matter-disclosure-panel p {
      margin: 0;
    }
    .mt-matter-disclosure-panel .mt-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-matter-disclosure-panel .need {
      font: 500 14px/20px var(--font-sans);
    }
    .mt-matter-disclosure-panel .actions {
      flex-wrap: wrap;
      gap: var(--space-8);
      margin-top: var(--space-4);
    }
    .mt-matter-disclosure-panel .history summary {
      cursor: pointer;
    }
    .mt-matter-disclosure-panel .history ol {
      list-style: none;
      margin: var(--space-8) 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
  `,
})
export class MatterDisclosurePanel {
  protected readonly screen = inject(MatterScreen);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly api = costsCallables(inject(CALLABLES));
  private readonly canFee = can('matter.fee');

  protected readonly disclosure = computed(
    (): CostsDisclosure => this.screen.value()?.costsDisclosure ?? { status: 'required', history: [] },
  );
  protected readonly statusLabel = computed(() => DISCLOSURE_STATUS_LABELS[this.disclosure().status]);
  protected readonly tone = computed(() => TONES[this.disclosure().status]);
  protected readonly needText = computed(() => {
    const d = this.disclosure();
    return disclosureNeedText({
      ...d,
      basisEstimateCents: d.basisEstimateCents ?? d.estimateCents,
      jurisdiction: this.screen.value()?.jurisdiction ?? '',
    });
  });
  protected readonly illustrative = computed(
    () => !!disclosureRulesFor(this.screen.value()?.jurisdiction ?? '')?.illustrative,
  );
  protected readonly updateReasons = computed(() =>
    joinNames((this.disclosure().updateReasons ?? []).map((reason) => DISCLOSURE_UPDATE_REASON_LABELS[reason])),
  );
  /** One was given before, so the next is an updated disclosure. */
  protected readonly updated = computed(() => !!this.disclosure().sentOn);
  protected readonly generating = signal(false);

  private readonly status = computed(() => this.disclosure().status);
  protected readonly canGenerate = computed(() => this.status() !== 'waived' && this.status() !== 'not_required');
  protected readonly canRecord = computed(() => this.status() === 'required' || this.status() === 'update_required');
  protected readonly canWaive = computed(
    () => this.canFee() && (this.status() === 'required' || this.status() === 'update_required'),
  );
  protected readonly canUnwaive = computed(() => this.canFee() && this.status() === 'waived');
  /** Newest first. */
  protected readonly history = computed(() => [...(this.disclosure().history ?? [])].reverse());

  protected money(cents: number): string {
    return formatAud(cents);
  }

  protected date(value: unknown): string {
    return formatDateOnly(value as MtDateInput);
  }

  protected when(value: unknown): string {
    return formatDateOnly(value as MtDateInput);
  }

  protected who(uid: string): string {
    return uid === 'system' ? 'Materia' : this.screen.memberName(uid);
  }

  protected waiverReason(reason: keyof typeof DISCLOSURE_WAIVER_REASON_LABELS): string {
    return DISCLOSURE_WAIVER_REASON_LABELS[reason];
  }

  protected sentMethod(method: DisclosureSentMethod): string {
    return SENT_BY[method];
  }

  protected eventLine(event: DisclosureEvent): string {
    const parts = [EVENT_LABELS[event.action]];
    if (
      event.requirement &&
      (event.action === 'assessed' || event.action === 'reassessed' || event.action === 'generated')
    ) {
      parts.push(DISCLOSURE_REQUIREMENT_LABELS[event.requirement].toLowerCase());
    }
    if (event.estimateCents !== undefined && event.action !== 'reminded') {
      parts.push(`estimate ${formatAud(event.estimateCents)}`);
    }
    if (event.note && event.action === 'waived') parts.push(event.note);
    return parts.join(' · ');
  }

  protected async generate(): Promise<void> {
    const matter = this.screen.value();
    if (!matter || this.generating()) return;
    this.generating.set(true);
    try {
      const result = await this.api.generateDisclosure({ matterId: matter.id });
      this.toasts.show({
        title: `${result.name} added to Documents`,
        description: missingText(result.missing) ?? 'A PDF preview follows shortly.',
        tone: result.missing.length ? 'neutral' : 'success',
        duration: result.missing.length ? 0 : 5000,
      });
    } catch (error) {
      this.toasts.show({ title: 'The disclosure wasn’t generated', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.generating.set(false);
    }
  }

  protected async recordSent(): Promise<void> {
    const matter = this.screen.value();
    if (!matter) return;
    const { DisclosureSentDialog } = await import('./disclosure-dialogs');
    const result = await this.dialogs.open<DisclosureSentData, DisclosureResult | undefined>(DisclosureSentDialog, {
      data: {
        matterId: matter.id,
        number: matter.number,
        documentId: this.disclosure().documentId,
        updated: this.updated(),
      },
    }).result;
    if (result) this.toasts.show({ title: 'Costs disclosure recorded as sent', tone: 'success' });
  }

  protected async waive(): Promise<void> {
    const matter = this.screen.value();
    if (!matter) return;
    const { DisclosureWaiverDialog } = await import('./disclosure-dialogs');
    const result = await this.dialogs.open<DisclosureWaiverData, DisclosureResult | undefined>(DisclosureWaiverDialog, {
      data: { matterId: matter.id, number: matter.number },
    }).result;
    if (result) this.toasts.show({ title: 'Recorded that no costs disclosure is needed', tone: 'success' });
  }

  protected async removeWaiver(): Promise<void> {
    const matter = this.screen.value();
    if (!matter) return;
    const confirmed = await this.dialogs.confirm({
      title: 'A costs disclosure is needed after all?',
      body: 'The estimate is assessed again, and the reminders start if a disclosure is due.',
      confirmLabel: 'Remove “not needed”',
    });
    if (!confirmed) return;
    try {
      await this.api.setDisclosureWaiver({ matterId: matter.id, waiver: null });
      this.toasts.show({ title: '“Not needed” removed', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'Nothing changed', description: errorCopy(error), tone: 'danger' });
    }
  }
}
