import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ORG_TEMPLATES_QUERY, orgTemplatesRepository, type OrgTemplate } from '@materia/data-access/repository';
import type { MatterType } from '@materia/domain';
import { MATTER_TYPE_LABELS, MtChoiceCards, MtIcon } from '@materia/ui';

import { MATTER_TYPE_OPTIONS } from './intake-state';
import { IntakeStore } from './intake-store';
import { FeatureFlagService } from '../../core/flags/feature-flags';

/**
 * Step 1: the matter type, as ChoiceCards. The type picks the template the matter starts on (with
 * `templates.system` on): the org's most recently published one for the type, else the standard one.
 */
@Component({
  selector: 'mt-intake-type-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtChoiceCards, MtIcon],
  template: `
    <div class="types">
      <mt-choice-cards
        label="What kind of matter is it?"
        [options]="options"
        [ngModel]="store.state().type"
        (ngModelChange)="choose($event)"
      />
    </div>
    @if (store.error('type'); as message) {
      <p class="mt-error" role="alert"><mt-icon name="alert" [size]="14" />{{ message }}</p>
    }
    @if (template(); as text) {
      <p class="caption t-2 template" data-testid="intake-template">{{ text }}</p>
    }
  `,
  styles: `
    .types ::ng-deep [ngpRadioGroup] {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: var(--space-8);
    }
    .types ::ng-deep [ngpRadioGroup] > .mt-label {
      grid-column: 1 / -1;
    }
    .template {
      margin: var(--space-12) 0 0;
    }
  `,
})
export class IntakeTypeStep {
  protected readonly store = inject(IntakeStore);
  protected readonly options = MATTER_TYPE_OPTIONS;
  private readonly flags = inject(FeatureFlagService);
  private readonly templates = signal<OrgTemplate[]>([]);

  protected readonly template = computed(() => {
    const type = this.store.state().type;
    if (!type || !this.flags.isOn('templates.system')) return null;
    const published = this.templates()
      .filter((t) => t.matterType === type && t.published && t.publishedAt)
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))[0];
    return published
      ? `Starts on your “${published.name}” template (v${published.version}): its first stage and tasks are added.`
      : `Starts on the standard ${MATTER_TYPE_LABELS[type]} template: its first stage and tasks are added.`;
  });

  constructor() {
    if (this.flags.isOn('templates.system')) {
      orgTemplatesRepository()
        .query(ORG_TEMPLATES_QUERY)
        .then((rows) => this.templates.set(rows))
        .catch(() => undefined);
    }
  }

  protected choose(type: MatterType | null): void {
    if (type) this.store.update((s) => ({ ...s, type }));
  }
}
