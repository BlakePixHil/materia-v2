import { ChangeDetectionStrategy, Component, computed, inject, InjectionToken, input, signal } from '@angular/core';

import { can, OrgContext } from '@materia/data-access';
import {
  canExport,
  CREATE_EXPORT_CALLABLE,
  EXPORT_KIND_LABELS,
  type CreateExportInput,
  type CreateExportResult,
  type ExportKind,
} from '@materia/domain';
import { MT_MENU, MtButton, ToastService } from '@materia/ui';

import { CALLABLES } from '../data/callables';
import { errorCopy } from '../error-copy';

/**
 * Starts a download: the browser goes to the signed URL, served as an attachment, so the page
 * stays where it is. Tests replace it.
 */
export const EXPORT_DOWNLOAD = new InjectionToken<(url: string) => void>('EXPORT_DOWNLOAD', {
  providedIn: 'root',
  factory: () => (url: string) => window.location.assign(url),
});

/** Drops filters that aren't set, so the export carries what the list shows and nothing else. */
export function exportFilters(filters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(filters).filter(
      ([, value]) =>
        value !== undefined &&
        value !== null &&
        value !== false &&
        value !== '' &&
        !(Array.isArray(value) && value.length === 0),
    ),
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-AU')} ${n === 1 ? one : many}`;

/**
 * "Export" on a list (INS-03): a CSV of the rows the list's filters match, through
 * `exports-create`. A small export downloads at once; a large one runs in the background and
 * `export_ready` says when it can be downloaded. Lawyers and above choose whether privileged
 * matters go in (they never do by default). Hidden from roles that can't export the list.
 *
 * ```html
 * <mt-export-button kind="contacts" [filters]="{ kind: 'person' }" />
 * ```
 */
@Component({
  selector: 'mt-export-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MT_MENU, MtButton],
  template: `
    @if (allowed()) {
      @if (askPrivileged()) {
        <button
          mtButton
          size="sm"
          variant="ghost"
          iconStart="arrow-down"
          aria-haspopup="menu"
          [loading]="busy()"
          [mtMenuTrigger]="menu"
          data-testid="export"
        >
          Export
        </button>
        <ng-template #menu>
          <mt-menu aria-label="Export">
            <button mtMenuItem (click)="run(false)">CSV without privileged matters</button>
            <button mtMenuItem icon="lock" (click)="run(true)">CSV including privileged matters</button>
          </mt-menu>
        </ng-template>
      } @else {
        <button
          mtButton
          size="sm"
          variant="ghost"
          iconStart="arrow-down"
          [loading]="busy()"
          (click)="run(false)"
          data-testid="export"
        >
          Export
        </button>
      }
    }
  `,
})
export class MtExportButton {
  readonly kind = input.required<ExportKind>();
  /** The list's filters as it shows them (unset ones are dropped). */
  readonly filters = input<Record<string, unknown>>({});

  private readonly context = inject(OrgContext);
  private readonly api = inject(CALLABLES);
  private readonly toasts = inject(ToastService);
  private readonly download = inject(EXPORT_DOWNLOAD);
  private readonly privilegedVisible = can('privileged.view');

  protected readonly busy = signal(false);
  protected readonly allowed = computed(() => canExport(this.context.role(), this.kind()));
  /** Contacts aren't on matters, so there is nothing privileged to choose. */
  protected readonly askPrivileged = computed(() => this.privilegedVisible() && this.kind() !== 'contacts');

  protected async run(includePrivileged: boolean): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    const label = EXPORT_KIND_LABELS[this.kind()];
    try {
      const result = await this.api.call<Omit<CreateExportInput, 'requestId'>, CreateExportResult>(
        CREATE_EXPORT_CALLABLE,
        {
          kind: this.kind(),
          filters: exportFilters(this.filters()),
          ...(includePrivileged ? { includePrivileged: true } : {}),
        } as Omit<CreateExportInput, 'requestId'>,
        { idempotent: true },
      );
      if (result.status === 'succeeded') {
        this.download(result.url);
        this.toasts.show({ tone: 'success', title: `${label} exported`, description: plural(result.rows, 'row') });
      } else {
        this.toasts.show({
          title: `Preparing your ${label.toLowerCase()} export`,
          description: 'It’s a large one, so it runs in the background. We’ll notify you when it’s ready to download.',
        });
      }
    } catch (error) {
      this.toasts.show({ tone: 'danger', title: 'The export didn’t download', description: errorCopy(error) });
    } finally {
      this.busy.set(false);
    }
  }
}
