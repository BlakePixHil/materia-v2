import { ChangeDetectionStrategy, Component, computed, inject, ViewEncapsulation } from '@angular/core';

import { can, OrgContext } from '@materia/data-access';
import { orgTrustSettingsRepository, trustSnapshotRepository } from '@materia/data-access/repository';
import {
  formatCents,
  NOT_THE_TRUST_LEDGER,
  trustRecordsName,
  trustSettingsOf,
  trustSnapshotLine,
  trustSnapshotOutOfDate,
} from '@materia/domain';
import { DialogService, MT_TODAY, MtBadge, MtButton, MtIcon, ToastService } from '@materia/ui';

import type { TrustSnapshotDialogData } from './trust-snapshot-dialog';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { MatterScreen } from '../matter-detail/matter-screen';

/**
 * The matter's "Held in trust" stat (BILL-11, ADR-035): the balance copied from the firm's trust
 * records, "as at 3 Oct 2026 · from Smokeball", the words "Not the trust ledger", an amber "Out of
 * date" chip past the org's threshold, and Update. Only for `billing.view` roles, while
 * `billing.trustDisplay` and the org's "Show trust balances on matters" are on; otherwise nothing
 * renders and nothing is read. No deposit, withdraw or transfer actions, and no "available" amount.
 */
@Component({
  selector: 'mt-matter-trust',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/card.css',
    '../../../../../../libs/ui/src/generated/components/stat.css',
  ],
  imports: [MtBadge, MtButton, MtIcon],
  template: `
    @if (shown()) {
      <section class="mt-card mt-stat mt-matter-trust" aria-labelledby="mt-trust-title" data-testid="matter-trust">
        <div class="k">
          <h2 id="mt-trust-title">Held in trust</h2>
          @if (outOfDate()) {
            <mt-badge tone="warning">Out of date</mt-badge>
          }
          @if (canRecord()) {
            <button
              mtButton
              variant="ghost"
              size="sm"
              type="button"
              class="mt-ml"
              aria-label="Update trust balance"
              (click)="update()"
            >
              Update
            </button>
          }
        </div>
        @if (snapshot.status() === 'loading') {
          <p class="f" role="status">Loading…</p>
        } @else if (snapshot.value(); as held) {
          <div class="v">{{ amount() }}</div>
          <div class="f line">{{ line() }}</div>
        } @else {
          <div class="f empty">No balance recorded yet. Copy it from {{ recordsName() }}.</div>
        }
        <div class="f label"><mt-icon name="info" />{{ notLedger }}</div>
      </section>
    }
  `,
  styles: `
    .mt-matter-trust .k {
      display: flex;
      align-items: center;
      gap: var(--space-8);
    }
    .mt-matter-trust .k h2 {
      margin: 0;
      font: inherit;
      color: inherit;
    }
    .mt-matter-trust .f.line {
      flex-wrap: wrap;
    }
    .mt-matter-trust .f.label {
      gap: var(--space-4);
    }
    .mt-matter-trust p.f {
      margin: 0;
    }
  `,
})
export class MatterTrust {
  private readonly screen = inject(MatterScreen);
  private readonly context = inject(OrgContext);
  private readonly flags = inject(FeatureFlagService);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly today = inject(MT_TODAY);

  private readonly canView = can('billing.view');
  /** The feature is on and the role may see trust balances: only then are the settings read. */
  private readonly eligible = computed(() => this.flags.isOn('billing.trustDisplay') && this.canView());
  private readonly org = orgTrustSettingsRepository().watch(() => (this.eligible() ? this.context.orgId() : null));
  private readonly settings = computed(() => trustSettingsOf(this.org.value()));
  protected readonly shown = computed(() => this.eligible() && this.settings().showOnMatters && !this.screen.deleted());
  protected readonly snapshot = trustSnapshotRepository().watch(() => (this.shown() ? this.screen.id() : null));
  protected readonly canRecord = computed(() => this.shown() && this.recordAllowed());
  private readonly recordAllowed = can('trust.record');

  protected readonly notLedger = NOT_THE_TRUST_LEDGER;
  protected readonly recordsName = computed(() => trustRecordsName(this.settings()));
  protected readonly amount = computed(() => {
    const held = this.snapshot.value();
    return held ? formatCents(held.amountCents) : '';
  });
  protected readonly line = computed(() => {
    const held = this.snapshot.value();
    return held ? trustSnapshotLine(held) : '';
  });
  protected readonly outOfDate = computed(() => {
    const held = this.snapshot.value();
    return !!held && trustSnapshotOutOfDate(held.asAt, this.today(), this.settings().staleAfterDays);
  });

  protected async update(): Promise<void> {
    const matter = this.screen.matter.value();
    const id = this.screen.id();
    if (!matter || !id) return;
    const { TrustSnapshotDialog } = await import('./trust-snapshot-dialog');
    const saved = await this.dialogs.open<TrustSnapshotDialogData, boolean>(TrustSnapshotDialog, {
      data: {
        matterId: id,
        matterLabel: `${matter.number} · ${matter.title}`,
        recordsName: this.recordsName(),
        amountCents: this.snapshot.value()?.amountCents,
      },
    }).result;
    if (saved) this.toasts.show({ title: 'Trust balance saved', tone: 'success' });
  }
}
