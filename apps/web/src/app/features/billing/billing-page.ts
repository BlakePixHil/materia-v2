import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { billableShare, fyBudgetSummary, timeTotals } from '@materia/domain';
import { formatAud, MtButton, MtMeter, MtProgress, MtStat, MtTab, MtTabList, MtTabPanel, MtTabset } from '@materia/ui';

import { ApprovalsTab } from './approvals-tab';
import { BillingScreen } from './billing-screen';
import { hoursText, monthLabel } from './billing-view';
import { MyTime } from './my-time';
import { WipTab } from './wip-tab';
import { CommandRegistry } from '../../core/commands/command-registry';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { MtPageActions } from '../../shell/page-header';

type Tab = 'mine' | 'wip' | 'approvals';
const TABS: readonly Tab[] = ['mine', 'wip', 'approvals'];

/**
 * Time and billing (`/billing`, BILL-03): the stats row (work in progress, recorded this week,
 * billable share), my FY budget card, then My time, WIP (billing.view) and Approvals
 * (time.approve). `?tab=wip` or `?tab=approvals` opens a tab. Record time opens quick entry (`t`);
 * Invoices opens the invoices list (BILL-07).
 */
@Component({
  selector: 'mt-billing-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [
    ApprovalsTab,
    MtButton,
    MtMeter,
    MtPageActions,
    MtProgress,
    MtStat,
    MtTab,
    MtTabList,
    MtTabPanel,
    MtTabset,
    MyTime,
    RouterLink,
    WipTab,
  ],
  providers: [BillingScreen],
  host: { class: 'mt-col mt-billing' },
  template: `
    <ng-template mtPageActions>
      @if (invoicesOn()) {
        <a mtButton variant="secondary" size="sm" iconStart="billing" routerLink="/billing/invoices">Invoices</a>
      }
      @if (screen.canRecord()) {
        <button mtButton variant="primary" size="sm" iconStart="timer" kbd="t" (click)="record()">Record time</button>
      }
    </ng-template>
    <div class="mt-row head">
      <h1 class="title-l">Time and billing</h1>
      <span class="body-s t-3" data-testid="billing-subtitle">{{ subtitle() }}</span>
    </div>

    <div class="stats" [attr.data-count]="screen.canViewBilling() ? 4 : 3">
      @if (screen.canViewBilling()) {
        <mt-stat label="Work in progress" [value]="wipValue()" data-testid="stat-wip">
          <span class="caption t-3">{{ wipCaption() }}</span>
        </mt-stat>
      }
      <mt-stat label="Recorded this week" [value]="weekHours()" unit="h" data-testid="stat-week">
        <mt-progress [value]="weekMinutes()" [max]="weekTarget() || 1" label="Against this week’s target" />
        <span class="mono-s">of {{ weekTargetHours() }} h</span>
      </mt-stat>
      <mt-stat
        label="Billable"
        [value]="billablePct()"
        [unit]="billablePct() === '—' ? undefined : '%'"
        data-testid="stat-billable"
      >
        <span class="caption t-3">of hours recorded this week</span>
      </mt-stat>
      <section class="mt-card fy-card" aria-labelledby="fy-budget-title" data-testid="fy-budget">
        <div class="mt-row fy-head">
          <h2 id="fy-budget-title">{{ fy().window.label }} budget</h2>
          @if (fy().status === 'behind') {
            <span class="caption t-danger mt-ml">Behind</span>
          } @else if (fy().status === 'on_track') {
            <span class="caption t-3 mt-ml">On track</span>
          }
        </div>
        @if (fy().budgetCents; as budget) {
          <div class="fy-value">
            <span class="amount">{{ amount(fy().recordedCents) }}</span>
            <span class="caption t-3">recorded of {{ amount(budget) }}</span>
          </div>
          <mt-meter
            [value]="fy().recordedCents"
            [max]="budget"
            [target]="fy().expectedCents ?? undefined"
            [tone]="fy().status === 'behind' ? 'warning' : 'brand'"
            [label]="fy().window.label + ' budget recorded'"
          />
          <span class="caption t-3" data-testid="fy-caption">
            {{ fy().recordedPct }}% recorded · {{ amount(fy().billedCents) }} billed ({{ fy().billedPct }}%) ·
            {{ fy().elapsedPct }}% of the year gone
          </span>
        } @else {
          <div class="fy-value">
            <span class="amount">{{ amount(fy().recordedCents) }}</span>
            <span class="caption t-3">recorded this year</span>
          </div>
          <span class="caption t-3">No budget set for this year. Owners set it in Settings → Team.</span>
        }
        @if (screen.fyEntries.hasMore()) {
          <span class="caption t-3">Counts your first {{ fyLimit }} entries this year.</span>
        }
      </section>
    </div>

    <div mtTabset [mtTabsetValue]="shown()" (mtTabsetValueChange)="tab.set($any($event))">
      <div mtTabList aria-label="Time and billing views">
        <button mtTab value="mine" icon="timer">My time</button>
        @if (screen.canViewBilling()) {
          <button mtTab value="wip" icon="billing">WIP</button>
        }
        @if (screen.canApprove()) {
          <button mtTab value="approvals" icon="check-circle" [count]="screen.awaiting().length">Approvals</button>
        }
      </div>
      <div mtTabPanel value="mine">
        @if (shown() === 'mine') {
          <mt-my-time />
        }
      </div>
      @if (screen.canViewBilling()) {
        <div mtTabPanel value="wip">
          @if (shown() === 'wip') {
            <mt-wip-tab />
          }
        </div>
      }
      @if (screen.canApprove()) {
        <div mtTabPanel value="approvals">
          @if (shown() === 'approvals') {
            <mt-approvals-tab />
          }
        </div>
      }
    </div>
  `,
  styles: `
    .mt-billing {
      gap: var(--space-16);
      min-width: 0;
    }
    .mt-billing h1,
    .mt-billing h2 {
      margin: 0;
    }
    .mt-billing .head {
      align-items: baseline;
      gap: var(--space-8);
      flex-wrap: wrap;
    }
    .mt-billing .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr)) minmax(0, 1.4fr);
      gap: var(--space-12);
    }
    .mt-billing .stats[data-count='3'] {
      grid-template-columns: repeat(2, minmax(0, 1fr)) minmax(0, 1.4fr);
    }
    .mt-billing .fy-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
      padding: var(--space-12) var(--space-16);
    }
    .mt-billing .fy-card h2 {
      font: 500 12px/16px var(--font-sans);
      color: var(--text-tertiary);
    }
    .mt-billing .fy-card .amount {
      font: 600 28px/32px var(--font-sans);
      letter-spacing: -0.02em;
      color: var(--text-primary);
    }
    .mt-billing .fy-head {
      align-items: baseline;
    }
    .mt-billing .fy-value {
      display: flex;
      align-items: baseline;
      gap: var(--space-6);
      flex-wrap: wrap;
    }
    .mt-billing [mtTabPanel] {
      padding-top: var(--space-16);
    }
    @media (max-width: 960px) {
      .mt-billing .stats,
      .mt-billing .stats[data-count='3'] {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 560px) {
      .mt-billing .stats,
      .mt-billing .stats[data-count='3'] {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `,
})
export class BillingPage {
  protected readonly screen = inject(BillingScreen);
  private readonly commands = inject(CommandRegistry);
  private readonly flags = inject(FeatureFlagService);
  protected readonly fyLimit = BillingScreen.FY_ENTRY_LIMIT;
  /** Invoices (BILL-07) for billing.view roles while `billing.invoicing` is on. */
  protected readonly invoicesOn = computed(() => this.flags.isOn('billing.invoicing') && this.screen.canViewBilling());

  protected readonly tab = signal<Tab>(initialTab(inject(ActivatedRoute).snapshot.queryParamMap.get('tab')));
  /** The chosen tab, or My time while (or if) I may not see it. */
  protected readonly shown = computed((): Tab => {
    const tab = this.tab();
    if (tab === 'wip' && !this.screen.canViewBilling()) return 'mine';
    if (tab === 'approvals' && !this.screen.canApprove()) return 'mine';
    return tab;
  });

  private readonly weekEntries = computed(() => this.screen.weekEntries.value().filter((entry) => !entry.deletedAt));
  protected readonly weekMinutes = computed(() => timeTotals(this.weekEntries()).minutes);
  protected readonly weekHours = computed(() => hoursText(this.weekMinutes()));
  /** Five weekdays at the org's daily target. */
  protected readonly weekTarget = computed(() => 5 * this.screen.dailyTargetMinutes());
  protected readonly weekTargetHours = computed(() => hoursText(this.weekTarget()));
  protected readonly billablePct = computed(() => {
    const pct = billableShare(this.weekEntries()).pct;
    return pct === null ? '—' : String(pct);
  });

  protected readonly fy = computed(() =>
    fyBudgetSummary({
      budgets: this.screen.myMember()?.budgets,
      entries: this.screen.fyEntries.value(),
      today: this.screen.today(),
      startMonth: this.screen.fyStartMonth(),
    }),
  );

  protected readonly subtitle = computed(() => {
    const fy = this.fy();
    const parts = [monthLabel(this.screen.today())];
    parts.push(fy.budgetCents ? `${fy.window.label} budget ${formatAud(fy.budgetCents)}` : fy.window.label);
    return parts.join(' · ');
  });

  protected readonly wipValue = computed(() => {
    const wip = this.screen.wip();
    return wip ? formatAud(wip.totalCents) : this.screen.wipLoading() ? '…' : '—';
  });
  protected readonly wipCaption = computed(() => {
    const wip = this.screen.wip();
    if (!wip) return this.screen.wipError() ? 'Couldn’t work it out' : 'Final time not yet billed';
    const old = wip.rows.filter((row) => row.closed).length;
    const n = wip.rows.length;
    return `${n} ${n === 1 ? 'matter' : 'matters'}${old ? ` · ${old} closed` : ''}`;
  });

  constructor() {
    // WIP once I'm known to have billing.view (the role arrives with the org claims).
    let loaded = false;
    effect(() => {
      if (loaded || !this.screen.canViewBilling()) return;
      loaded = true;
      untracked(() => void this.screen.loadWip());
    });
  }

  protected amount(cents: number): string {
    return formatAud(cents);
  }

  protected record(): void {
    const command = this.commands.get('time.log');
    if (command) this.commands.run(command);
  }
}

function initialTab(value: string | null): Tab {
  return (TABS as readonly string[]).includes(value ?? '') ? (value as Tab) : 'mine';
}
