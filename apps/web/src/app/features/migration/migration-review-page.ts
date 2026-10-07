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
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import {
  contactsRepository,
  latestMigrationRuns,
  matterDetailRepository,
  migrationCallables,
  migrationRunsRepository,
} from '@materia/data-access/repository';
import {
  isMigrationReviewCode,
  MIGRATION_RESOLVE_MAX,
  MIGRATION_REVIEW_CODES,
  type MigrationReviewCode,
  type MigrationReviewItem,
  type MigrationReviewResult,
} from '@materia/domain';
import {
  DialogService,
  MtBadge,
  MtButton,
  MtCheckbox,
  MtEmptyState,
  MtNote,
  MtProgress,
  MtSelect,
  MtTextField,
  ToastService,
  type MtOption,
} from '@materia/ui';

import { fixLink, plural, progressText } from './migration-view';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';

/** One line of a row: a code open on the record, how to fix it, and its own "Looks right". */
interface Line {
  code: MigrationReviewCode;
  label: string;
  help: string;
  fix: (typeof MIGRATION_REVIEW_CODES)[MigrationReviewCode]['fix'];
  link: ReturnType<typeof fixLink>;
}

interface Row {
  item: MigrationReviewItem;
  lines: Line[];
}

const key = (path: string, code: string) => `${path}|${code}`;

/**
 * The migration review queue (`/settings/migration/review`, MIG-08; owners and admins): every
 * record the legacy migration flagged, filterable by why (`?code=`). Each line puts its code right
 * in place (a matter's title, a referrer's name), opens the page that does (the matter's parties,
 * stage, fee or closing; the document; Practice; Team), or marks it reviewed as it stands. Rows can
 * be selected and marked together, or every record with a code at once. A rollback of the import
 * while the queue is open empties it and says so.
 */
@Component({
  selector: 'mt-migration-review-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [
    FormsModule,
    RouterLink,
    MtBadge,
    MtButton,
    MtCheckbox,
    MtEmptyState,
    MtNote,
    MtProgress,
    MtSelect,
    MtTextField,
  ],
  host: { class: 'mt-migration-review mt-col' },
  template: `
    <header class="mt-col head">
      <a class="caption t-3 back" routerLink="/settings/migration">‹ Import from materia</a>
      <h1 class="title-l">Review imported records</h1>
      <p class="body t-2">
        These came across from the old materia with something to check. Put each one right, or mark it reviewed if it
        looks right as it is.
      </p>
    </header>

    @if (rolledBack()) {
      <mt-note tone="warning" data-rolled-back>
        This import was rolled back, so its records are gone and there’s nothing to review. Once it’s loaded again, the
        records to check appear here.
      </mt-note>
    } @else if (loadError(); as message) {
      <mt-note tone="danger">{{ message }}</mt-note>
    }

    @if (result(); as review) {
      @if (!rolledBack()) {
        <section class="mt-card progress" data-pad aria-label="Progress" data-section="progress">
          <mt-progress
            [value]="review.percent"
            label="Reviewed"
            [tone]="review.open ? 'brand' : 'success'"
            size="md"
            [valueLabel]="review.percent + '%'"
          />
          <p class="label" data-progress>{{ progressText(review) }}</p>
        </section>

        <div class="mt-row toolbar">
          <mt-select
            class="filter"
            name="code"
            label="Show"
            [native]="true"
            [options]="filterOptions()"
            [ngModel]="code()"
            (ngModelChange)="setCode($event)"
          />
          @if (selectedLines().length) {
            <button mtButton size="sm" [loading]="busy() === 'selected'" (click)="markSelected()" data-mark-selected>
              Mark {{ plural(selectedLines().length, 'item') }} reviewed
            </button>
          }
          @if (code(); as current) {
            @if (openFor(current); as open) {
              <button mtButton size="sm" variant="secondary" [loading]="busy() === 'all'" (click)="markAll(current)">
                Mark all {{ open }} reviewed
              </button>
            }
          }
        </div>
        @if (code(); as current) {
          <p class="caption t-2 code-help" data-code-help>{{ help(current) }}</p>
        }

        @if (rows().length) {
          <ul class="queue" aria-label="Records to review">
            @for (row of rows(); track row.item.path) {
              <li class="mt-card" data-pad [attr.data-record]="row.item.path">
                <div class="mt-row top">
                  <mt-checkbox
                    [name]="'select-' + row.item.path"
                    [label]="'Select ' + row.item.title"
                    class="pick"
                    [ngModel]="isSelected(row)"
                    (ngModelChange)="toggle(row, !!$event)"
                  />
                  <div class="mt-col who">
                    <span class="label">{{ row.item.title }}</span>
                    <span class="caption t-3"
                      >{{ entityLabel(row.item) }}
                      @if (row.item.detail) {
                        · {{ row.item.detail }}
                      }
                    </span>
                  </div>
                </div>
                @for (line of row.lines; track line.code) {
                  <div class="line" [attr.data-code]="line.code">
                    <div class="mt-col why">
                      <mt-badge tone="warning">{{ line.label }}</mt-badge>
                      <span class="caption t-2">{{ line.help }}</span>
                    </div>
                    @if (!row.item.readOnly && line.fix === 'rename-matter') {
                      <form class="mt-row rename" (submit)="$event.preventDefault(); renameMatter(row.item)">
                        <mt-text-field
                          size="sm"
                          [name]="'title-' + row.item.id"
                          label="Matter title"
                          [ngModel]="drafts()[row.item.path] ?? ''"
                          (ngModelChange)="draft(row.item.path, $event)"
                        />
                        <button mtButton size="sm" type="submit" [loading]="busy() === row.item.path">
                          Save title
                        </button>
                      </form>
                    } @else if (line.fix === 'rename-contact') {
                      <form class="mt-row rename" (submit)="$event.preventDefault(); renameContact(row.item)">
                        <mt-text-field
                          size="sm"
                          [name]="'name-' + row.item.id"
                          label="Referrer’s name"
                          [ngModel]="drafts()[row.item.path] ?? ''"
                          (ngModelChange)="draft(row.item.path, $event)"
                        />
                        <button mtButton size="sm" type="submit" [loading]="busy() === row.item.path">Save name</button>
                      </form>
                    }
                    <div class="mt-row actions">
                      @if (line.link; as fix) {
                        <a mtButton size="sm" variant="ghost" [routerLink]="fix.link">{{ fix.label }}</a>
                      }
                      <button
                        mtButton
                        size="sm"
                        variant="secondary"
                        [loading]="busy() === key(row.item.path, line.code)"
                        (click)="looksRight(row.item, line.code)"
                      >
                        Looks right
                      </button>
                    </div>
                  </div>
                }
                @if (row.item.readOnly) {
                  <p class="caption t-3">Archived, so it can’t be changed: mark it reviewed, or reopen it first.</p>
                }
              </li>
            }
          </ul>
          @if (review.more) {
            <p class="caption t-3" data-more>
              Showing the first {{ rows().length }}. As you put these right or mark them reviewed, the rest come in.
            </p>
          }
        } @else if (!rolledBack()) {
          <mt-empty-state
            icon="check-circle"
            [title]="review.open ? 'Nothing to check here' : 'Everything’s reviewed'"
            [description]="
              review.open
                ? 'Choose another reason to see what’s left.'
                : 'Every record that came across with something to check has been looked at.'
            "
          >
            <a mtButton size="sm" routerLink="/matters">Open my matters</a>
          </mt-empty-state>
        }
      }
    } @else if (!loadError() && !rolledBack()) {
      <p role="status" class="caption t-3">Loading the records to review…</p>
    }
  `,
  styles: `
    .mt-migration-review {
      gap: var(--space-16);
      max-width: 860px;
    }
    .mt-migration-review .head {
      gap: var(--space-6);
    }
    .mt-migration-review .head h1,
    .mt-migration-review .head p {
      margin: 0;
    }
    .mt-migration-review .back {
      text-decoration: none;
    }
    .mt-migration-review .progress {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-migration-review .progress p {
      margin: 0;
    }
    .mt-migration-review .toolbar {
      gap: var(--space-8);
      align-items: flex-end;
      flex-wrap: wrap;
    }
    .mt-migration-review .toolbar .filter {
      flex: 1 1 260px;
      max-width: 360px;
    }
    .mt-migration-review .code-help {
      margin: 0;
    }
    .mt-migration-review .queue {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-migration-review .queue > li {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    .mt-migration-review .top {
      gap: var(--space-8);
      align-items: flex-start;
    }
    .mt-migration-review .pick .mt-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }
    .mt-migration-review .who {
      gap: 2px;
      min-width: 0;
    }
    .mt-migration-review .line {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-8) var(--space-16);
      align-items: flex-end;
      padding-top: var(--space-12);
      border-top: 1px solid var(--border-subtle);
    }
    .mt-migration-review .why {
      gap: var(--space-4);
      flex: 1 1 280px;
      min-width: 0;
      align-items: flex-start;
    }
    .mt-migration-review .rename {
      gap: var(--space-8);
      align-items: flex-end;
      flex: 1 1 280px;
    }
    .mt-migration-review .rename mt-text-field {
      flex: 1;
    }
    .mt-migration-review .actions {
      gap: var(--space-4);
      margin-left: auto;
    }
  `,
})
export class MigrationReviewPage {
  private readonly api = migrationCallables(inject(CALLABLES));
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly matters = matterDetailRepository();
  private readonly contacts = contactsRepository();
  private readonly runs = migrationRunsRepository().watchQuery({ pageSize: 50 });

  protected readonly code = signal<MigrationReviewCode | ''>(this.codeFromUrl());
  protected readonly result = signal<MigrationReviewResult | null>(null);
  protected readonly loadError = signal<string | null>(null);
  /** The action running: a record's path, a line's key, `selected` or `all`. */
  protected readonly busy = signal<string | null>(null);
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  /** Names typed for a record, by path. */
  protected readonly drafts = signal<Record<string, string>>({});
  private loads = 0;

  protected readonly progressText = progressText;
  protected readonly plural = plural;
  protected readonly key = key;

  /** The latest run was rolled back (or is rolling back): its records are gone. */
  protected readonly rolledBack = computed(() => {
    const status = latestMigrationRuns(this.runs.value()).latest?.status;
    return status === 'rolled_back' || status === 'rolling_back';
  });

  protected readonly filterOptions = computed<MtOption<string>[]>(() => {
    const review = this.result();
    const current = this.code();
    const options: MtOption<string>[] = [{ value: '', label: `Everything (${review?.open ?? 0})` }];
    for (const count of review?.codes ?? []) {
      if (!count.open && count.code !== current) continue;
      options.push({ value: count.code, label: `${MIGRATION_REVIEW_CODES[count.code].label} (${count.open})` });
    }
    return options;
  });

  protected readonly rows = computed<Row[]>(() => {
    if (this.rolledBack()) return [];
    const filter = this.code();
    return (this.result()?.items ?? []).map((item) => ({
      item,
      lines: item.codes
        .filter((code) => !filter || code === filter)
        .map((code) => {
          const info = MIGRATION_REVIEW_CODES[code];
          return { code, label: info.label, help: info.help, fix: info.fix, link: fixLink(item, code) };
        }),
    }));
  });

  /** The lines of the selected rows, as the callable takes them. */
  protected readonly selectedLines = computed(() => {
    const chosen = this.selected();
    return this.rows()
      .filter((row) => chosen.has(row.item.path))
      .flatMap((row) => row.lines.map((line) => ({ path: row.item.path, code: line.code })));
  });

  constructor() {
    effect(() => {
      const code = this.code();
      untracked(() => void this.load(code));
    });
  }

  protected entityLabel(item: MigrationReviewItem): string {
    return { matter: 'Matter', contact: 'Contact', document: 'Document', member: 'Team member', org: 'Practice' }[
      item.entity
    ];
  }

  protected help(code: MigrationReviewCode): string {
    return MIGRATION_REVIEW_CODES[code].help;
  }

  protected openFor(code: MigrationReviewCode): number {
    return this.result()?.codes.find((count) => count.code === code)?.open ?? 0;
  }

  protected setCode(value: string | null): void {
    const code = isMigrationReviewCode(value) ? value : '';
    this.code.set(code);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { code: code || null },
      replaceUrl: true,
    });
  }

  protected isSelected(row: Row): boolean {
    return this.selected().has(row.item.path);
  }

  protected toggle(row: Row, on: boolean): void {
    const next = new Set(this.selected());
    if (on) next.add(row.item.path);
    else next.delete(row.item.path);
    this.selected.set(next);
  }

  protected draft(path: string, value: string | null): void {
    this.drafts.update((drafts) => ({ ...drafts, [path]: value ?? '' }));
  }

  protected looksRight(item: MigrationReviewItem, code: MigrationReviewCode): Promise<void> {
    return this.run(key(item.path, code), async () => {
      await this.api.resolve({ items: [{ path: item.path, code }] });
      this.toasts.show({ title: 'Marked reviewed', tone: 'success' });
    });
  }

  protected markSelected(): Promise<void> {
    const lines = this.selectedLines();
    return this.run('selected', async () => {
      for (let i = 0; i < lines.length; i += MIGRATION_RESOLVE_MAX) {
        await this.api.resolve({ items: lines.slice(i, i + MIGRATION_RESOLVE_MAX) });
      }
      this.toasts.show({ title: `${plural(lines.length, 'item')} marked reviewed`, tone: 'success' });
    });
  }

  protected async markAll(code: MigrationReviewCode): Promise<void> {
    const open = this.openFor(code);
    const label = MIGRATION_REVIEW_CODES[code].label;
    const confirmed = await this.dialogs.confirm({
      title: `Mark all ${open} “${label}” reviewed?`,
      body: 'They stay as they came across. You can still change any of them later.',
      confirmLabel: `Mark ${open} reviewed`,
    });
    if (!confirmed) return;
    await this.run('all', async () => {
      const result = await this.api.resolve({ code });
      this.toasts.show({ title: `${plural(result.resolved, 'item')} marked reviewed`, tone: 'success' });
    });
  }

  /** Renames an untitled matter, then marks its code reviewed (the matter's trigger would too). */
  protected renameMatter(item: MigrationReviewItem): Promise<void> {
    const title = (this.drafts()[item.path] ?? '').trim();
    if (!title) {
      this.toasts.show({ title: 'Type the matter’s title first' });
      return Promise.resolve();
    }
    return this.run(item.path, async () => {
      await this.matters.update(item.id, { title });
      await this.api.resolve({ items: [{ path: item.path, code: 'title_missing' }] });
      this.toasts.show({ title: 'Title saved', tone: 'success' });
    });
  }

  /** Names an unnamed referrer, then marks its code reviewed (the contact's trigger would too). */
  protected renameContact(item: MigrationReviewItem): Promise<void> {
    const name = (this.drafts()[item.path] ?? '').trim();
    if (!name) {
      this.toasts.show({ title: 'Type the referrer’s name first' });
      return Promise.resolve();
    }
    return this.run(item.path, async () => {
      await this.contacts.update(item.id, { orgName: name });
      await this.api.resolve({ items: [{ path: item.path, code: 'referrer_unnamed' }] });
      this.toasts.show({ title: 'Name saved', tone: 'success' });
    });
  }

  private async run(action: string, work: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(action);
    try {
      await work();
      this.selected.set(new Set());
      await this.load(this.code());
    } catch (error) {
      this.toasts.show({ title: 'That didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.busy.set(null);
    }
  }

  private async load(code: MigrationReviewCode | ''): Promise<void> {
    const load = ++this.loads;
    try {
      const result = await this.api.review(code ? { code } : {});
      if (load !== this.loads) return;
      this.result.set(result);
      this.loadError.set(null);
    } catch (error) {
      if (load === this.loads) this.loadError.set(errorCopy(error));
    }
  }

  private codeFromUrl(): MigrationReviewCode | '' {
    const code = this.route.snapshot.queryParamMap.get('code');
    return isMigrationReviewCode(code) ? code : '';
  }
}
