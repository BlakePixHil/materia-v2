import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can, OrgContext } from '@materia/data-access';
import {
  matterDetailRepository,
  matterTimeRepository,
  recentMattersQuery,
  recentMattersRepository,
  type MatterDetail,
  type WithId,
} from '@materia/data-access/repository';
import { defaultBillable, formatUnits, isFixedFee, type DateOnly, type TimeEntryValues } from '@materia/domain';
import { injectDialogRef, MT_TODAY, MtButton, MtDialog, MtSearchField, ToastService } from '@materia/ui';

import { TimeEntryForm, type TimeEntryFormValue } from './time-entry-form';
import { dayTime, timePricing } from './time-pricing';
import { dayHeading } from './time-view';
import { errorCopy } from '../../core/error-copy';
import { matterSearch } from '../notes/matter-search';
import { MATTER_QUERY_MIN } from '../notes/note-view';

export interface TimeQuickEntryData {
  /** The matter open behind the dialog, picked to start with. */
  matterId?: string | null | undefined;
  /**
   * Only choose a matter (the timer's switch, BILL-02): picking one closes the dialog with it
   * instead of showing the time form. The title and description replace "Log time".
   */
  pick?: { title: string; description: string } | undefined;
}

/** What the dialog closes with: the matter the time went on, or `undefined` when cancelled. */
export interface TimeQuickEntryResult {
  matterId: string;
  number: string;
}

type PickedMatter = WithId<MatterDetail>;
interface MatterChoice {
  id: string;
  number: string;
  title: string;
}

const choiceOf = (matter: PickedMatter): MatterChoice => ({
  id: matter.id,
  number: matter.number,
  title: matter.title,
});

/**
 * Quick time entry from anywhere (BILL-01): `t` or ⌘K "Log time". Pick the matter (the open one,
 * else my recent matters first, or search by number or title), then the duration and narrative.
 * Enter saves; Esc closes. Loaded on first use, outside the initial bundle.
 */
@Component({
  selector: 'mt-time-quick-entry',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtSearchField, TimeEntryForm],
  template: `
    <mt-dialog
      size="md"
      [title]="ref.data.pick?.title ?? 'Log time'"
      [description]="ref.data.pick?.description ?? 'Record time on a matter.'"
    >
      <div class="mt-col quick" style="gap: var(--space-16)">
        @if (matter(); as picked) {
          <div class="mt-row picked">
            <span class="label">{{ picked.number }}</span>
            <span class="mt-ell t-2">{{ picked.title }}</span>
            <button mtButton variant="ghost" size="sm" type="button" class="mt-ml" (click)="clearMatter()">
              Change<span class="mt-sr"> matter</span>
            </button>
          </div>
          <mt-time-entry-form
            #form
            layout="stack"
            submitLabel="Log time"
            formLabel="Time entry"
            formId="mt-time-quick-form"
            [actions]="false"
            [initial]="initial()"
            [preview]="preview"
            [dayMinutes]="myDayMinutes"
            [unitMinutes]="pricing.unitMinutes()"
            [fixedFee]="fixedFee()"
            [saving]="saving()"
            (saved)="save($event)"
            (cancelled)="ref.close(undefined)"
          />
        } @else {
          <mt-search-field
            #search
            label="Matter"
            placeholder="Matter number or title"
            [ngModel]="query()"
            (ngModelChange)="query.set($event ?? '')"
            (queryChange)="find($event)"
          />
          @if (searching()) {
            <p class="caption t-3" role="status">Searching…</p>
          } @else {
            <ul class="results" [attr.aria-label]="listLabel()">
              @for (row of choices(); track row.id) {
                <li>
                  <button mtButton variant="ghost" size="sm" type="button" class="result" (click)="pick(row)">
                    <span class="label">{{ row.number }}</span>
                    <span class="caption t-3">{{ row.title }}</span>
                  </button>
                </li>
              } @empty {
                <li class="caption t-3">{{ emptyText() }}</li>
              }
            </ul>
          }
        }
      </div>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close(undefined)">Cancel</button>
        @if (matter()) {
          <button mtButton variant="primary" type="submit" form="mt-time-quick-form" [loading]="saving()">
            {{ form()?.confirming() ? 'Save anyway' : 'Log time' }}
          </button>
        }
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .picked {
      align-items: center;
      gap: var(--space-8);
      padding: var(--space-8) var(--space-12);
      border-radius: var(--radius-md);
      background: var(--bg-sunken);
      min-width: 0;
    }
    .results {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .result {
      width: 100%;
      min-width: 0;
      overflow: hidden;
      justify-content: flex-start;
      gap: var(--space-8);
    }
    .result .caption {
      margin-left: var(--space-8);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
})
export class TimeQuickEntry {
  protected readonly ref = injectDialogRef<TimeQuickEntryData, TimeQuickEntryResult | undefined>();
  protected readonly pricing = timePricing();
  private readonly context = inject(OrgContext);
  private readonly toasts = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly today = inject(MT_TODAY);
  private readonly matters = matterDetailRepository();
  private readonly recentsRepo = recentMattersRepository();
  private readonly search = matterSearch(can('privileged.view'));
  private readonly dayTime = dayTime();
  protected readonly form = viewChild<TimeEntryForm>('form');
  private readonly searchField = viewChild<MtSearchField>('search');

  protected readonly matter = signal<PickedMatter | null>(null);
  private readonly repo = matterTimeRepository(() => this.matter()?.id ?? null);
  protected readonly query = signal('');
  protected readonly searching = signal(false);
  private readonly recents = signal<MatterChoice[]>([]);
  private readonly results = signal<MatterChoice[] | null>(null);
  protected readonly saving = signal(false);

  protected readonly choices = computed(() => this.results() ?? this.recents());
  protected readonly listLabel = computed(() => (this.results() ? 'Matching matters' : 'Recent matters'));
  protected readonly emptyText = computed(() =>
    this.results() ? `No matters match “${this.query().trim()}”.` : 'Type a matter number or title.',
  );
  protected readonly fixedFee = computed(() => isFixedFee(this.matter()));
  protected readonly initial = computed(() => ({ billable: defaultBillable(this.matter()) }));

  protected readonly preview = (minutes: number, date: DateOnly): TimeEntryValues | null =>
    this.pricing.preview({ minutes, date, matter: this.matter() });
  protected readonly myDayMinutes = async (date: DateOnly): Promise<number> =>
    (await this.dayTime(this.context.uid() ?? '', date)) ?? 0;

  constructor() {
    const start = this.ref.data?.pick ? null : this.ref.data?.matterId;
    if (start)
      void this.open(start).then((found) => {
        if (!found) void this.loadRecents();
      });
    else void this.loadRecents();
  }

  protected async find(query: string): Promise<void> {
    if (query.trim().length < MATTER_QUERY_MIN) {
      this.results.set(null);
      return;
    }
    this.searching.set(true);
    try {
      const rows = await this.search(query);
      if (query === this.query()) this.results.set(rows);
    } catch (error) {
      this.toasts.show({ title: 'Matters couldn’t be searched', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.searching.set(false);
    }
  }

  protected async pick(choice: MatterChoice): Promise<void> {
    if (!(await this.open(choice.id)))
      this.toasts.show({ title: 'That matter can’t take time', description: 'It may have been deleted.' });
  }

  protected clearMatter(): void {
    this.matter.set(null);
    if (!this.recents().length) void this.loadRecents();
    afterNextRender(() => this.searchField()?.focus(), { injector: this.injector });
  }

  protected save(value: TimeEntryFormValue): void {
    const matter = this.matter();
    if (!matter || this.saving()) return;
    const values = this.pricing.preview({ minutes: value.minutes, date: value.date, matter });
    // Not awaited past the local write: offline, it's saved when back online.
    this.saving.set(true);
    const write = this.repo.create({
      date: value.date,
      minutes: value.minutes,
      narrative: value.narrative,
      billable: value.billable,
      units: values.units,
      rateCents: values.rateCents,
      amountCents: values.amountCents,
    });
    write.catch((error: unknown) =>
      this.toasts.show({ title: 'The time didn’t save', description: errorCopy(error), tone: 'danger' }),
    );
    this.toasts.show({
      title: `Logged ${formatUnits(values.units, this.pricing.unitMinutes())} h on ${matter.number}`,
      description: dayHeading(value.date, this.today()),
      tone: 'success',
    });
    this.saving.set(false);
    this.ref.close({ matterId: matter.id, number: matter.number });
  }

  /** Picks a matter by id; false when it can't be read or is deleted. */
  private async open(id: string): Promise<boolean> {
    try {
      const matter = await this.matters.get(id);
      if (!matter || matter.deletedAt) return false;
      if (this.ref.data?.pick) {
        this.ref.close({ matterId: matter.id, number: matter.number });
        return true;
      }
      this.matter.set(matter);
      afterNextRender(() => this.form()?.focus(), { injector: this.injector });
      return true;
    } catch {
      return false;
    }
  }

  /** My recently opened matters, newest first (those I can still read). */
  private async loadRecents(): Promise<void> {
    const orgId = this.context.orgId();
    if (!orgId) return;
    try {
      const recent = await this.recentsRepo.query(recentMattersQuery(orgId));
      const ids = [...new Set(recent.map((row) => row.matterId).filter((id): id is string => !!id))];
      const rows = await Promise.all(ids.map((id) => this.matters.get(id).catch(() => null)));
      this.recents.set(rows.filter((row): row is PickedMatter => !!row && !row.deletedAt).map(choiceOf));
    } catch {
      // No recents (offline, say): searching still works.
    }
  }
}
