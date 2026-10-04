import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { injectDialogRef, MtButton, MtDialog, MtNote, MtSelect, type MtOption } from '@materia/ui';

export interface StageMappingDialogData {
  /** The template's name, for the title. */
  name: string;
  /** Removed stages that matters are in (`details.stages`), with their names where known. */
  removed: MtOption<string>[];
  /** Stages of the new version they may move to (`details.allowed`). */
  allowed: MtOption<string>[];
  /**
   * Publishes with the mapping. Returns errors by removed stage id (or under `''` for the whole
   * dialog) to keep it open; resolves without any to close it with the mapping.
   */
  submit: (mapping: Record<string, string>) => Promise<Record<string, string> | undefined>;
}

/**
 * Where matters in removed stages go (CORE-07): `templates-publish` refused with
 * TEMPLATE_STAGE_MAPPING_REQUIRED, so each removed stage that matters are in needs a stage of the
 * new version. Upgrading a matter later follows this mapping. Closes with the mapping, or
 * `undefined` when cancelled.
 */
@Component({
  selector: 'mt-stage-mapping-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtNote, MtSelect],
  template: `
    <mt-dialog
      size="sm"
      [title]="'Publish ' + data.name"
      description="Some matters on this template are in stages this version removes. Choose where each stage’s matters go when they’re upgraded."
    >
      <form id="mt-stage-mapping-form" class="mt-col" style="gap: 12px" (submit)="$event.preventDefault(); save()">
        @if (errors()['']; as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
        @for (stage of data.removed; track stage.value) {
          <mt-select
            [name]="'map-' + stage.value"
            [label]="'Matters in ' + stage.label + ' move to'"
            [options]="data.allowed"
            [native]="true"
            [required]="true"
            [error]="errors()[stage.value]"
            [ngModel]="mapping()[stage.value] ?? null"
            (ngModelChange)="pick(stage.value, $event)"
          />
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-stage-mapping-form" [loading]="busy()">
          Publish
        </button>
      </ng-container>
    </mt-dialog>
  `,
})
export class StageMappingDialog {
  protected readonly ref = injectDialogRef<StageMappingDialogData, Record<string, string> | undefined>();
  protected readonly data = this.ref.data;
  protected readonly mapping = signal<Record<string, string>>({});
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly busy = signal(false);

  protected pick(stageId: string, target: string | null): void {
    this.mapping.update((current) => {
      const rest = Object.entries(current).filter(([key]) => key !== stageId);
      return Object.fromEntries(target ? [...rest, [stageId, target]] : rest);
    });
    this.errors.update((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== stageId)));
  }

  protected close(value?: Record<string, string>): void {
    void this.ref.close(value);
  }

  protected async save(): Promise<void> {
    const mapping = this.mapping();
    const missing = this.data.removed.filter((stage) => !mapping[stage.value]);
    if (missing.length) {
      this.errors.set(Object.fromEntries(missing.map((stage) => [stage.value, 'Choose a stage'])));
      return;
    }
    this.busy.set(true);
    try {
      const errors = await this.data.submit(mapping);
      if (errors) {
        this.errors.set(errors);
        return;
      }
    } finally {
      this.busy.set(false);
    }
    this.close(mapping);
  }
}
