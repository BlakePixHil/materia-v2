import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { JobView } from '@materia/data-access';
import {
  contactsRepository,
  ESTATE_ASSETS_QUERY,
  ESTATE_DISTRIBUTIONS_QUERY,
  ESTATE_LIABILITIES_QUERY,
  estateAssetsRepository,
  estateCallables,
  estateDistributionsRepository,
  estateLiabilitiesRepository,
  forMatter,
  MATTER_PARTIES_QUERY,
  matterDocumentRepository,
  matterDocumentsQuery,
  matterPartiesRepository,
  type QueryResource,
} from '@materia/data-access/repository';
import {
  ASSET_CLASS_LABELS,
  ASSET_STATUS_LABELS,
  assetShareCents,
  contactDisplayName,
  DISTRIBUTION_KIND_LABELS,
  DISTRIBUTION_STATUS_LABELS,
  documentDisplayName,
  estateTotals,
  INSOLVENT_ESTATE_NOTE,
  inventoryCsv,
  inventoryFileName,
  isInsolvent,
  LIABILITY_CLASS_LABELS,
  LIABILITY_STATUS_LABELS,
  OUTSIDE_ESTATE_NOTE,
  residueCalculation,
  type AssetClass,
  type EstateTotals,
  type LiabilityClass,
} from '@materia/domain';
import {
  DialogService,
  MT_TODAY,
  MtButton,
  MtEmptyState,
  MtIcon,
  MtIconButton,
  MtNote,
  MtStat,
  MtTable,
  ToastService,
  type MtTableColumn,
  type MtTableGroup,
} from '@materia/ui';

import {
  AssetDialog,
  DistributionDialog,
  LiabilityDialog,
  type AssetDialogData,
  type DistributionDialogData,
  type EstateDialogResult,
  type LiabilityDialogData,
} from './estate-dialogs';
import {
  ASSET_CLASS_OPTIONS,
  assetFlags,
  distributionGift,
  ESTATE_SAVE_FAILED,
  inventoryAssets,
  inventoryLiabilities,
  LIABILITY_CLASS_OPTIONS,
  money,
  moneyInput,
  parseMoneyInput,
  type AssetRow,
  type DistributionRow,
  type LiabilityRow,
} from './estate-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { JobProgress } from '../../core/jobs/job-progress';
import { MatterScreen } from '../matter-detail/matter-screen';

/** Loading every page of a register for an export stops here (a register is never this big). */
const MAX_EXPORT_PAGES = 50;

/**
 * A probate, administration or trust matter's Estate tab (CORE-16, behind `estate.register`): the
 * assets and liabilities with quick-entry rows (Enter adds the row, Tab moves across its cells), a
 * summary (gross excluding assets passing outside the estate, liabilities, net, outside, realised),
 * distributions to beneficiaries with the residue shown but not enforced, and the inventory as CSV
 * (made here) or PDF (`estate-exportInventory`, saved to the matter's documents). Records are
 * written directly under the rules; `estate-onWrite` keeps the matter's totals, which the summary
 * uses once a register outgrows a page.
 */
@Component({
  selector: 'mt-matter-estate',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/card.css',
    '../../../../../../libs/ui/src/generated/components/input.css',
    '../../../../../../libs/ui/src/generated/components/select.css',
  ],
  imports: [FormsModule, JobProgress, MtButton, MtEmptyState, MtIcon, MtIconButton, MtNote, MtStat, MtTable],
  host: { class: 'mt-matter-estate' },
  template: `
    @if (on()) {
      <div class="mt-row head">
        <h2 class="title-m">Estate</h2>
        <div class="mt-row mt-ml actions">
          <button mtButton size="sm" iconStart="list" [disabled]="empty()" (click)="downloadCsv()">Download CSV</button>
          @if (canExport()) {
            <button
              mtButton
              size="sm"
              iconStart="document"
              [disabled]="empty() || !!exportJob()"
              [loading]="exporting()"
              (click)="exportPdf()"
            >
              Export PDF
            </button>
          }
        </div>
      </div>
      @if (exportJob(); as jobId) {
        <mt-job-progress [jobId]="jobId" label="Inventory PDF" (finished)="exported($event)" />
      }
      @if (loadError(); as message) {
        <mt-note tone="danger">
          {{ message }}
          <button mtButton size="sm" (click)="retry()">Try again</button>
        </mt-note>
      }

      <section class="summary" aria-labelledby="mt-estate-summary">
        <h3 class="mt-card-title" id="mt-estate-summary">Summary</h3>
        <div class="stats">
          <mt-stat label="Gross estate" [value]="money(totals().grossCents)" />
          <mt-stat label="Liabilities" [value]="money(totals().liabilitiesCents)" />
          <mt-stat label="Net estate" [value]="money(totals().netCents)" />
          <mt-stat label="Passing outside the estate" [value]="money(totals().outsideCents)" />
          <mt-stat label="Realised so far" [value]="money(totals().realisedCents)" />
        </div>
        @if (insolvent()) {
          <mt-note tone="danger">{{ insolventNote }}</mt-note>
        }
        @if (totals().outsideCents > 0) {
          <p class="caption t-2 note">{{ outsideNote }}</p>
        }
      </section>

      <section class="mt-card" data-pad aria-labelledby="mt-estate-assets">
        <div class="mt-row section-head">
          <h3 class="mt-card-title" id="mt-estate-assets">
            Assets <span class="caption t-3">{{ totals().assetCount }}</span>
          </h3>
          @if (screen.editable()) {
            <button mtButton class="mt-ml" size="sm" iconStart="plus" (click)="editAsset()">Add asset…</button>
          }
        </div>
        @if (assets.value().length) {
          <mt-table
            label="Assets"
            density="compact"
            maxHeight="none"
            [rows]="assets.value()"
            [columns]="assetColumns"
            [rowKey]="rowKey"
            [rowLabel]="assetLabel"
            [groupBy]="assetGroup"
            [virtualThreshold]="noVirtual"
            (open)="editAsset($event)"
          />
        } @else if (assets.status() === 'loading') {
          <p class="caption t-3" role="status">Loading assets…</p>
        } @else {
          <mt-empty-state
            icon="scale"
            title="No assets yet"
            description="Add the house, bank accounts, shares, super and anything else the deceased owned."
          />
        }
        @if (assets.hasMore()) {
          <button mtButton size="sm" variant="ghost" [loading]="assets.loadingMore()" (click)="assets.loadMore()">
            Show more assets
          </button>
        }
        @if (screen.editable()) {
          <form class="quick" aria-label="Add an asset" (submit)="$event.preventDefault(); quickAsset()">
            <span class="mt-input mt-select" data-size="sm">
              <select aria-label="New asset class" name="assetClass" [(ngModel)]="newAssetClass">
                @for (option of assetClasses; track option.value) {
                  <option [value]="option.value">{{ option.label }}</option>
                }
              </select>
              <mt-icon name="updown" />
            </span>
            <span class="mt-input grow" data-size="sm">
              <input
                #assetDescription
                aria-label="New asset description"
                name="assetDescription"
                placeholder="Description"
                autocomplete="off"
                [(ngModel)]="newAssetDescription"
              />
            </span>
            <span class="mt-input amount" data-size="sm" [attr.data-invalid]="assetError() ? '' : null">
              <input
                aria-label="New asset value at date of death"
                name="assetValue"
                placeholder="Value"
                inputmode="decimal"
                autocomplete="off"
                [(ngModel)]="newAssetValue"
              />
            </span>
            <button mtButton size="sm" type="submit" iconStart="plus" [loading]="addingAsset()">Add</button>
          </form>
          @if (assetError(); as message) {
            <p class="caption danger" role="alert">{{ message }}</p>
          }
        }
      </section>

      <section class="mt-card" data-pad aria-labelledby="mt-estate-liabilities">
        <div class="mt-row section-head">
          <h3 class="mt-card-title" id="mt-estate-liabilities">
            Liabilities <span class="caption t-3">{{ totals().liabilityCount }}</span>
          </h3>
          @if (screen.editable()) {
            <button mtButton class="mt-ml" size="sm" iconStart="plus" (click)="editLiability()">Add liability…</button>
          }
        </div>
        @if (liabilities.value().length) {
          <mt-table
            label="Liabilities"
            density="compact"
            maxHeight="none"
            [rows]="liabilities.value()"
            [columns]="liabilityColumns"
            [rowKey]="rowKey"
            [rowLabel]="liabilityLabel"
            [groupBy]="liabilityGroup"
            [virtualThreshold]="noVirtual"
            (open)="editLiability($event)"
          />
        } @else if (liabilities.status() === 'loading') {
          <p class="caption t-3" role="status">Loading liabilities…</p>
        } @else {
          <p class="caption t-3">No liabilities recorded.</p>
        }
        @if (liabilities.hasMore()) {
          <button
            mtButton
            size="sm"
            variant="ghost"
            [loading]="liabilities.loadingMore()"
            (click)="liabilities.loadMore()"
          >
            Show more liabilities
          </button>
        }
        @if (screen.editable()) {
          <form class="quick" aria-label="Add a liability" (submit)="$event.preventDefault(); quickLiability()">
            <span class="mt-input mt-select" data-size="sm">
              <select aria-label="New liability class" name="liabilityClass" [(ngModel)]="newLiabilityClass">
                @for (option of liabilityClasses; track option.value) {
                  <option [value]="option.value">{{ option.label }}</option>
                }
              </select>
              <mt-icon name="updown" />
            </span>
            <span class="mt-input grow" data-size="sm">
              <input
                #liabilityCreditor
                aria-label="New liability creditor"
                name="liabilityCreditor"
                placeholder="Creditor"
                autocomplete="off"
                [(ngModel)]="newLiabilityCreditor"
              />
            </span>
            <span class="mt-input amount" data-size="sm" [attr.data-invalid]="liabilityError() ? '' : null">
              <input
                aria-label="New liability amount"
                name="liabilityAmount"
                placeholder="Amount"
                inputmode="decimal"
                autocomplete="off"
                [(ngModel)]="newLiabilityAmount"
              />
            </span>
            <button mtButton size="sm" type="submit" iconStart="plus" [loading]="addingLiability()">Add</button>
          </form>
          @if (liabilityError(); as message) {
            <p class="caption danger" role="alert">{{ message }}</p>
          }
        }
      </section>

      <section class="mt-card" data-pad aria-labelledby="mt-estate-distributions">
        <div class="mt-row section-head">
          <h3 class="mt-card-title" id="mt-estate-distributions">Distributions</h3>
          @if (screen.editable()) {
            <button
              mtButton
              class="mt-ml"
              size="sm"
              iconStart="plus"
              [disabled]="insolvent() || !beneficiaries().length"
              (click)="editDistribution()"
            >
              Record distribution…
            </button>
          }
        </div>
        @if (insolvent()) {
          <mt-note tone="warning">Distributions are disabled while the estate is insolvent.</mt-note>
        } @else if (!beneficiaries().length && screen.editable()) {
          <p class="caption t-3">Add the beneficiaries on the Parties tab to record distributions.</p>
        }
        @if (distributions.value().length) {
          <ul class="distributions" aria-label="Distributions">
            @for (row of distributions.value(); track row.id) {
              <li [attr.data-review]="row.needsValueReview ? '' : null">
                <span class="mt-grow">
                  <span class="label">{{ beneficiaryName(row.beneficiaryPartyId) }}</span>
                  <span class="caption t-2"
                    >{{ kindLabel(row) }} · {{ gift(row) }} · {{ statusLabel(row)
                    }}{{ row.paymentReference ? ' · Ref ' + row.paymentReference : '' }}</span
                  >
                  @if (row.needsValueReview) {
                    <span class="caption review">
                      <mt-icon name="alert" [size]="14" /> Needs review: an asset’s value changed after this was
                      recorded.
                    </span>
                  }
                </span>
                @if (screen.editable()) {
                  @if (row.needsValueReview) {
                    <button mtButton size="sm" (click)="markReviewed(row)">Mark reviewed</button>
                  }
                  <button
                    mtIconButton
                    icon="compose"
                    size="sm"
                    [disabled]="insolvent()"
                    [label]="'Edit distribution to ' + beneficiaryName(row.beneficiaryPartyId)"
                    (click)="editDistribution(row)"
                  ></button>
                }
              </li>
            }
          </ul>
        }
        @if (distributions.hasMore()) {
          <button
            mtButton
            size="sm"
            variant="ghost"
            [loading]="distributions.loadingMore()"
            (click)="distributions.loadMore()"
          >
            Show more distributions
          </button>
        }
        <section aria-label="Residue calculation">
          <dl class="residue">
            <div>
              <dt>Net estate</dt>
              <dd>{{ money(residue().netCents) }}</dd>
            </div>
            <div>
              <dt>Less specific gifts</dt>
              <dd>{{ money(residue().specificCents) }}</dd>
            </div>
            <div>
              <dt>Less pecuniary gifts</dt>
              <dd>{{ money(residue().pecuniaryCents) }}</dd>
            </div>
            <div>
              <dt>
                Less held in reserve
                @if (screen.editable() && !editingReserve()) {
                  <button mtButton size="sm" variant="ghost" (click)="startReserve()">Change</button>
                }
              </dt>
              <dd>
                @if (editingReserve()) {
                  <form class="reserve" aria-label="Held in reserve" (submit)="$event.preventDefault(); saveReserve()">
                    <span class="mt-input amount" data-size="sm" [attr.data-invalid]="reserveError() ? '' : null">
                      <input
                        #reserveInput
                        aria-label="Amount held in reserve"
                        name="reserve"
                        inputmode="decimal"
                        autocomplete="off"
                        [(ngModel)]="reserveText"
                      />
                    </span>
                    <button mtButton size="sm" type="submit">Save</button>
                    <button mtButton size="sm" variant="ghost" type="button" (click)="editingReserve.set(false)">
                      Cancel
                    </button>
                  </form>
                  @if (reserveError(); as message) {
                    <p class="caption danger" role="alert">{{ message }}</p>
                  }
                } @else {
                  {{ money(residue().reservedCents) }}
                }
              </dd>
            </div>
            <div class="total">
              <dt>Residue</dt>
              <dd>{{ money(residue().residueCents) }}</dd>
            </div>
            <div>
              <dt>Paid so far</dt>
              <dd>{{ money(residue().paidCents) }}</dd>
            </div>
          </dl>
        </section>
        @if (residue().residueCents < 0) {
          <p class="caption t-2">
            The specific and pecuniary gifts and the reserve are more than the net estate, so the gifts may abate. This
            is shown, not enforced.
          </p>
        } @else {
          <p class="caption t-3">A guide only: the residue is shown, not enforced.</p>
        }
      </section>
    } @else {
      <mt-empty-state
        icon="scale"
        title="The estate register isn’t on yet"
        description="It is waiting on a practitioner’s review of its asset classes and wording."
      />
    }
  `,
  styles: `
    .mt-matter-estate {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      max-width: 1080px;
    }
    .mt-matter-estate h2,
    .mt-matter-estate h3 {
      margin: 0;
    }
    .mt-matter-estate .head,
    .mt-matter-estate .section-head {
      align-items: center;
      gap: var(--space-8);
    }
    .mt-matter-estate .actions {
      gap: var(--space-8);
    }
    .mt-matter-estate .mt-card:not(.mt-stat),
    .mt-matter-estate .summary {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    .mt-matter-estate .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: var(--space-12);
    }
    /* Cents-exact figures are long ($1,116,250.00): five fit across a 13-inch screen at this size. */
    .mt-matter-estate .stats .mt-stat .v {
      font-size: 20px;
      line-height: 28px;
    }
    /* Long descriptions and notes wrap rather than push the table wider than the card. */
    .mt-matter-estate .mt-table td.wrap {
      white-space: normal;
      padding-block: var(--space-6);
    }
    .mt-matter-estate .note {
      margin: 0;
    }
    .mt-matter-estate .quick,
    .mt-matter-estate .reserve {
      display: flex;
      gap: var(--space-8);
      align-items: center;
      flex-wrap: wrap;
    }
    .mt-matter-estate .quick .grow {
      flex: 1 1 200px;
    }
    .mt-matter-estate .quick .amount,
    .mt-matter-estate .reserve .amount {
      flex: 0 1 140px;
    }
    .mt-matter-estate .quick .mt-select {
      flex: 0 1 200px;
    }
    .mt-matter-estate .danger {
      color: var(--text-danger);
      margin: 0;
    }
    .mt-matter-estate .distributions {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-matter-estate .distributions li {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      min-height: 40px;
    }
    .mt-matter-estate .distributions li > .mt-grow {
      display: flex;
      flex-direction: column;
    }
    .mt-matter-estate .review {
      color: var(--text-warning, var(--text-danger));
      display: inline-flex;
      align-items: center;
      gap: var(--space-4);
    }
    .mt-matter-estate .residue {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
      max-width: 480px;
      font: 400 13px/20px var(--font-sans);
    }
    .mt-matter-estate .residue > div {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-12);
    }
    .mt-matter-estate .residue dt {
      display: flex;
      align-items: center;
      gap: var(--space-4);
    }
    .mt-matter-estate .residue dd {
      margin: 0;
      font-variant-numeric: tabular-nums;
    }
    .mt-matter-estate .residue .total {
      font-weight: 600;
      border-top: 1px solid var(--border-subtle);
      padding-top: var(--space-4);
    }
  `,
})
export class MatterEstate {
  protected readonly screen = inject(MatterScreen);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly today = inject(MT_TODAY);
  private readonly flags = inject(FeatureFlagService);
  private readonly api = estateCallables(inject(CALLABLES));
  private readonly contacts = contactsRepository();
  /** The register is on for this org (`estate.register`); off, the tab reads nothing. */
  protected readonly on = computed(() => this.flags.isOn('estate.register'));
  private readonly id = computed(() => (this.on() ? this.screen.id() : null));

  private readonly assetsRepo = estateAssetsRepository(this.id);
  private readonly liabilitiesRepo = estateLiabilitiesRepository(this.id);
  private readonly distributionsRepo = estateDistributionsRepository(this.id);
  protected readonly assets = this.assetsRepo.watchQuery(forMatter(this.id, ESTATE_ASSETS_QUERY));
  protected readonly liabilities = this.liabilitiesRepo.watchQuery(forMatter(this.id, ESTATE_LIABILITIES_QUERY));
  protected readonly distributions = this.distributionsRepo.watchQuery(forMatter(this.id, ESTATE_DISTRIBUTIONS_QUERY));
  private readonly parties = matterPartiesRepository(this.id).watchQuery(forMatter(this.id, MATTER_PARTIES_QUERY));
  private readonly documents = matterDocumentRepository(this.id);

  protected readonly money = money;
  protected readonly insolventNote = INSOLVENT_ESTATE_NOTE;
  protected readonly outsideNote = OUTSIDE_ESTATE_NOTE;
  protected readonly assetClasses = ASSET_CLASS_OPTIONS;
  protected readonly liabilityClasses = LIABILITY_CLASS_OPTIONS;
  protected readonly canExport = computed(() => this.screen.editable());

  protected readonly loadError = computed(() => {
    const error = this.assets.error() ?? this.liabilities.error() ?? this.distributions.error();
    return error ? errorCopy(error) : null;
  });

  /**
   * The totals: from the rows while every row is loaded (so a new row shows at once), else the
   * matter's trigger-kept `estateRegister`.
   */
  protected readonly totals = computed<EstateTotals>(() => {
    const local = estateTotals(this.assets.value(), this.liabilities.value());
    const complete = !this.assets.hasMore() && !this.liabilities.hasMore();
    const stored = this.screen.value()?.estateRegister;
    return complete || !stored ? local : stored;
  });
  protected readonly insolvent = computed(() => isInsolvent(this.totals()));
  protected readonly empty = computed(() => this.totals().assetCount + this.totals().liabilityCount === 0);

  private readonly assetMap = computed(() => new Map(this.assets.value().map((row) => [row.id, row] as const)));
  protected readonly residue = computed(() =>
    residueCalculation(
      this.totals().netCents,
      this.distributions.value(),
      this.assetMap(),
      this.screen.value()?.estate?.reservedCents ?? 0,
    ),
  );

  // Beneficiaries (parties with the beneficiary role) and their names, read once per contact.
  private readonly names = signal<ReadonlyMap<string, string>>(new Map());
  private readonly requested = new Set<string>();
  protected readonly beneficiaries = computed(() =>
    this.parties
      .value()
      .filter((party) => party.role === 'beneficiary')
      .map((party) => ({ value: party.id, label: this.names().get(party.contactId) ?? '…' })),
  );
  private readonly partyContacts = computed(
    () => new Map(this.parties.value().map((party) => [party.id, party.contactId] as const)),
  );

  // Quick entry.
  protected newAssetClass: AssetClass = 'bank';
  protected newAssetDescription = '';
  protected newAssetValue = '';
  protected newLiabilityClass: LiabilityClass = 'debt';
  protected newLiabilityCreditor = '';
  protected newLiabilityAmount = '';
  protected readonly addingAsset = signal(false);
  protected readonly addingLiability = signal(false);
  protected readonly assetError = signal<string | null>(null);
  protected readonly liabilityError = signal<string | null>(null);
  private readonly assetDescription = viewChild<ElementRef<HTMLInputElement>>('assetDescription');
  private readonly liabilityCreditor = viewChild<ElementRef<HTMLInputElement>>('liabilityCreditor');

  // The reserve.
  protected readonly editingReserve = signal(false);
  protected readonly reserveError = signal<string | null>(null);
  protected reserveText = '';
  private readonly reserveInput = viewChild<ElementRef<HTMLInputElement>>('reserveInput');

  // The PDF export.
  protected readonly exporting = signal(false);
  protected readonly exportJob = signal<string | null>(null);

  private dialogOpen = false;

  /** Rows wrap, so their heights vary: render every loaded row (a page is 200) rather than a virtual window. */
  protected readonly noVirtual = Number.MAX_SAFE_INTEGER;
  protected readonly rowKey = (row: { id: string }) => row.id;
  protected readonly assetLabel = (row: AssetRow) => row.description;
  protected readonly liabilityLabel = (row: LiabilityRow) => row.creditor;
  protected readonly assetGroup = (row: AssetRow): MtTableGroup =>
    row.passesOutsideEstate
      ? { key: 'outside', label: 'Passing outside the estate' }
      : { key: row.class, label: ASSET_CLASS_LABELS[row.class] };
  protected readonly liabilityGroup = (row: LiabilityRow): MtTableGroup => ({
    key: row.class,
    label: LIABILITY_CLASS_LABELS[row.class],
  });

  protected readonly assetColumns: MtTableColumn<AssetRow>[] = [
    { id: 'description', header: 'Description', width: '24%', cellClass: 'wrap' },
    {
      id: 'institution',
      header: 'Institution or reference',
      width: '16%',
      cellClass: 'wrap',
      value: (row) => row.institution,
    },
    {
      id: 'value',
      header: 'Value at death',
      numeric: true,
      value: (row) => money(row.valueAtDeathCents),
      sortValue: (row) => row.valueAtDeathCents,
    },
    {
      id: 'share',
      header: 'Estate share',
      numeric: true,
      value: (row) => money(assetShareCents(row)),
      sortValue: (row) => assetShareCents(row),
    },
    { id: 'status', header: 'Status', value: (row) => ASSET_STATUS_LABELS[row.status] },
    { id: 'realised', header: 'Realised', numeric: true, value: (row) => money(row.realisedCents) },
    { id: 'flags', header: 'Notes', width: '16%', cellClass: 'wrap caption', value: (row) => assetFlags(row) },
  ];

  protected readonly liabilityColumns: MtTableColumn<LiabilityRow>[] = [
    { id: 'creditor', header: 'Creditor', width: '40%', cellClass: 'wrap' },
    { id: 'reference', header: 'Reference', value: (row) => row.reference },
    { id: 'status', header: 'Status', value: (row) => LIABILITY_STATUS_LABELS[row.status] },
    {
      id: 'amount',
      header: 'Amount',
      numeric: true,
      value: (row) => money(row.amountCents),
      sortValue: (row) => row.amountCents,
    },
  ];

  constructor() {
    effect(() => {
      const ids = [...new Set(this.parties.value().map((party) => party.contactId))].filter(
        (id) => !this.requested.has(id),
      );
      if (!ids.length) return;
      ids.forEach((id) => this.requested.add(id));
      untracked(() => void this.loadNames(ids));
    });
  }

  private async loadNames(ids: string[]): Promise<void> {
    const found = await Promise.all(ids.map((id) => this.contacts.get(id).catch(() => null)));
    this.names.update((map) => {
      const next = new Map(map);
      found.forEach((contact, i) =>
        next.set(ids[i] as string, contact ? contactDisplayName(contact) : 'Unknown contact'),
      );
      return next;
    });
  }

  protected beneficiaryName(partyId: string): string {
    const contactId = this.partyContacts().get(partyId);
    return contactId ? (this.names().get(contactId) ?? '…') : 'Former beneficiary';
  }

  protected kindLabel(row: DistributionRow): string {
    return DISTRIBUTION_KIND_LABELS[row.kind];
  }

  protected statusLabel(row: DistributionRow): string {
    return DISTRIBUTION_STATUS_LABELS[row.status];
  }

  protected gift(row: DistributionRow): string {
    return distributionGift(row, this.assetMap());
  }

  protected retry(): void {
    this.assets.refresh();
    this.liabilities.refresh();
    this.distributions.refresh();
  }

  private async open<D, R>(component: Parameters<DialogService['open']>[0], data: D): Promise<R | undefined> {
    if (!this.id() || !this.screen.editable() || this.dialogOpen) return undefined;
    this.dialogOpen = true;
    try {
      return await this.dialogs.open<D, R | undefined>(component, { data }).result;
    } finally {
      this.dialogOpen = false;
    }
  }

  private saved(result: EstateDialogResult, what: string): void {
    if (result === 'saved') this.toasts.show({ title: `${what} saved`, tone: 'success' });
    if (result === 'removed') this.toasts.show({ title: `${what} removed`, tone: 'success' });
  }

  /** The matter's documents for an asset's valuation documents, read when the dialog opens. */
  private async documentOptions(): Promise<{ id: string; name: string }[]> {
    try {
      const rows = await this.documents.query(
        matterDocumentsQuery({ privilegedVisible: this.screen.canPrivileged(), pageSize: 50 }),
      );
      return rows.map((row) => ({ id: row.id, name: documentDisplayName(row) }));
    } catch {
      return [];
    }
  }

  protected async editAsset(asset?: AssetRow): Promise<void> {
    if (!this.screen.editable()) return;
    const documents = await this.documentOptions();
    const result = await this.open<AssetDialogData, EstateDialogResult>(AssetDialog, {
      repo: this.assetsRepo,
      documents,
      ...(asset ? { asset } : { assetClass: this.newAssetClass }),
    });
    this.saved(result, 'Asset');
  }

  protected async editLiability(liability?: LiabilityRow): Promise<void> {
    const result = await this.open<LiabilityDialogData, EstateDialogResult>(LiabilityDialog, {
      repo: this.liabilitiesRepo,
      ...(liability ? { liability } : {}),
    });
    this.saved(result, 'Liability');
  }

  protected async editDistribution(distribution?: DistributionRow): Promise<void> {
    if (this.insolvent()) return;
    const assets = this.assets
      .value()
      .filter((asset) => !asset.passesOutsideEstate)
      .map((asset) => ({ value: asset.id, label: `${asset.description} (${money(assetShareCents(asset))})` }));
    const result = await this.open<DistributionDialogData, EstateDialogResult>(DistributionDialog, {
      repo: this.distributionsRepo,
      beneficiaries: this.beneficiaries(),
      assets,
      ...(distribution ? { distribution } : {}),
    });
    this.saved(result, 'Distribution');
  }

  protected async markReviewed(row: DistributionRow): Promise<void> {
    try {
      await this.distributionsRepo.update(row.id, { needsValueReview: false });
      this.toasts.show({ title: 'Marked reviewed', tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: ESTATE_SAVE_FAILED, description: errorCopy(error), tone: 'danger' });
    }
  }

  /** Enter in any cell of the quick-entry row adds the asset, then the description is ready for the next. */
  protected async quickAsset(): Promise<void> {
    const description = this.newAssetDescription.trim();
    const value = parseMoneyInput(this.newAssetValue);
    if (!description) return this.assetError.set('Describe the asset.');
    if ('error' in value) return this.assetError.set(value.error);
    if (this.addingAsset()) return;
    this.assetError.set(null);
    this.addingAsset.set(true);
    try {
      await this.assetsRepo.create({
        class: this.newAssetClass,
        description,
        valueAtDeathCents: value.value ?? 0,
        jointlyHeld: false,
        passesOutsideEstate: false,
        status: value.value === undefined ? 'identified' : 'valued',
        documentIds: [],
      });
      this.newAssetDescription = '';
      this.newAssetValue = '';
      this.assetDescription()?.nativeElement.focus();
    } catch (error) {
      this.assetError.set(`${ESTATE_SAVE_FAILED}. ${errorCopy(error)}`);
    } finally {
      this.addingAsset.set(false);
    }
  }

  protected async quickLiability(): Promise<void> {
    const creditor = this.newLiabilityCreditor.trim();
    const amount = parseMoneyInput(this.newLiabilityAmount);
    if (!creditor) return this.liabilityError.set('Name the creditor.');
    if ('error' in amount) return this.liabilityError.set(amount.error);
    if (amount.value === undefined) return this.liabilityError.set('Enter the amount owed.');
    if (this.addingLiability()) return;
    this.liabilityError.set(null);
    this.addingLiability.set(true);
    try {
      await this.liabilitiesRepo.create({
        class: this.newLiabilityClass,
        creditor,
        amountCents: amount.value,
        status: 'notified',
      });
      this.newLiabilityCreditor = '';
      this.newLiabilityAmount = '';
      this.liabilityCreditor()?.nativeElement.focus();
    } catch (error) {
      this.liabilityError.set(`${ESTATE_SAVE_FAILED}. ${errorCopy(error)}`);
    } finally {
      this.addingLiability.set(false);
    }
  }

  protected startReserve(): void {
    this.reserveText = moneyInput(this.screen.value()?.estate?.reservedCents);
    this.reserveError.set(null);
    this.editingReserve.set(true);
    setTimeout(() => this.reserveInput()?.nativeElement.focus());
  }

  /** The reserve is part of the matter's `estate` (a client-direct edit of the whitelisted map). */
  protected async saveReserve(): Promise<void> {
    const matter = this.screen.value();
    const parsed = parseMoneyInput(this.reserveText);
    if (!matter) return;
    if ('error' in parsed) return this.reserveError.set(parsed.error);
    const rest = Object.entries(matter.estate ?? {}).filter(([key]) => key !== 'reservedCents');
    const estate = Object.fromEntries(parsed.value ? [...rest, ['reservedCents', parsed.value]] : rest);
    try {
      await this.screen.repo.update(matter.id, { estate });
      this.editingReserve.set(false);
    } catch (error) {
      this.reserveError.set(errorCopy(error));
    }
  }

  /** Every page of a register, for an export. */
  private async loadAll(resource: QueryResource<unknown>): Promise<void> {
    for (let page = 0; resource.hasMore() && page < MAX_EXPORT_PAGES; page++) await resource.loadMore();
  }

  protected async downloadCsv(): Promise<void> {
    const matter = this.screen.value();
    if (!matter) return;
    try {
      await Promise.all([this.loadAll(this.assets), this.loadAll(this.liabilities)]);
      const deceasedId = matter.deceased?.contactId;
      const deceased = deceasedId ? await this.contacts.get(deceasedId).catch(() => null) : null;
      const csv = inventoryCsv({
        matterNumber: matter.number,
        matterTitle: matter.title,
        deceasedName: deceased ? contactDisplayName(deceased) : undefined,
        dateOfDeath: matter.deceased?.dateOfDeath,
        preparedOn: this.today(),
        assets: inventoryAssets(this.assets.value()),
        liabilities: inventoryLiabilities(this.liabilities.value()),
      });
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = Object.assign(document.createElement('a'), {
        href: url,
        download: inventoryFileName(matter.number, 'csv'),
      });
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      this.toasts.show({ title: 'The CSV didn’t download', description: errorCopy(error), tone: 'danger' });
    }
  }

  protected async exportPdf(): Promise<void> {
    const matterId = this.id();
    if (!matterId || this.exporting()) return;
    this.exporting.set(true);
    try {
      const { jobId } = await this.api.exportInventory({ matterId });
      this.exportJob.set(jobId);
    } catch (error) {
      this.toasts.show({ title: 'The PDF didn’t start', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.exporting.set(false);
    }
  }

  /** The job's own toast says how it went; a PDF that succeeded is in Documents, under Financial. */
  protected exported(job: JobView): void {
    if (job.status === 'succeeded' || job.status === 'failed') this.exportJob.set(null);
  }
}
