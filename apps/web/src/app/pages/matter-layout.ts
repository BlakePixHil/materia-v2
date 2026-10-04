import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink, RouterOutlet } from '@angular/router';
import { map } from 'rxjs';

import { matterConflictsRepository } from '@materia/data-access/repository';
import { MtBadge, MtButton, MtNote, MtTabLink, MtTabNav } from '@materia/ui';

import { MATTER_TABS } from './matter-tabs';
import { CONFLICT_STATUS_TONES, conflictBadgeText } from '../features/conflicts/conflict-view';

/**
 * Matter detail frame: the matter number heading and router-linked tabs (CORE-06 builds the header).
 * Shows the conflict check's status (CORE-02), a link to the check for leads, and an alert when a
 * party added later matched someone on another matter.
 */
@Component({
  selector: 'mt-matter-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtBadge, MtButton, MtNote, MtTabNav, MtTabLink, RouterLink, RouterOutlet],
  host: { class: 'mt-col', style: 'gap: 16px; flex: 1' },
  template: `
    <div class="mt-row mt-wrap" style="gap: var(--space-12)">
      <h1 class="title-l" style="margin: 0">
        Matter <span style="font-family: var(--font-mono); font-size: 0.75em">{{ id() }}</span>
      </h1>
      @if (matter.value(); as m) {
        <mt-badge [tone]="conflictTone()">{{ conflictText() }}</mt-badge>
        @if (m.status === 'lead') {
          <a
            mtButton
            class="mt-ml"
            style="text-decoration: none"
            variant="secondary"
            size="sm"
            iconStart="search"
            routerLink="conflicts"
            >Conflict check</a
          >
        }
      }
    </div>
    @if (matter.value()?.conflictAlert; as alert) {
      <mt-note [tone]="alert.adverse ? 'danger' : 'warning'">
        {{ alertText() }}
        <a routerLink="conflicts">Review the conflict check</a>
      </mt-note>
    }
    <nav mtTabNav aria-label="Matter sections">
      @for (tab of tabs; track tab.path) {
        <a mtTabLink [routerLink]="tab.path">{{ tab.label }}</a>
      }
    </nav>
    <router-outlet />
  `,
})
export class MatterLayout {
  protected readonly tabs = MATTER_TABS;
  protected readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map((p) => p.get('id') ?? '')), {
    initialValue: '',
  });
  protected readonly matter = matterConflictsRepository().watch(() => this.id() || null);
  protected readonly conflictText = computed(() => conflictBadgeText(this.matter.value()?.conflictCheck?.status));
  protected readonly alertText = computed(() => {
    const adverse = this.matter.value()?.conflictAlert?.adverse;
    const label = typeof adverse === 'string' ? ` (adverse: ${adverse})` : adverse ? ' in an adverse role' : '';
    return `A party added since the conflict check matches someone on another matter${label}.`;
  });
  protected readonly conflictTone = computed(
    () => CONFLICT_STATUS_TONES[this.matter.value()?.conflictCheck?.status ?? 'pending'],
  );
}
