import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';

import { type MtIconName, MtEmptyState } from '@materia/ui';

/** Route data for a placeholder page. */
export interface PlaceholderData {
  /** The page heading. */
  heading: string;
  /** The ticket that builds this page ("CORE-14"). */
  ticket: string;
  icon?: MtIconName;
  description?: string;
}

/** A page that isn't built yet: its heading and "Coming in <ticket>" (FND-12). */
@Component({
  selector: 'mt-placeholder-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtEmptyState],
  host: { class: 'mt-col', style: 'gap: 20px; flex: 1' },
  template: `
    @if (!embedded()) {
      <h1 class="title-l" style="margin: 0">{{ data().heading }}</h1>
    }
    <mt-empty-state
      [title]="'Coming in ' + data().ticket"
      [description]="data().description ?? 'This page is part of the plan but not built yet.'"
      [icon]="data().icon"
      [headingLevel]="2"
    />
  `,
})
export class PlaceholderPage {
  private readonly routeData = toSignal(inject(ActivatedRoute).data, { initialValue: {} as Record<string, unknown> });
  protected readonly data = computed(() => this.routeData()['placeholder'] as PlaceholderData);
  /** Inside a layout that already shows the heading (a matter tab). */
  protected readonly embedded = computed(() => this.routeData()['embedded'] === true);
}
