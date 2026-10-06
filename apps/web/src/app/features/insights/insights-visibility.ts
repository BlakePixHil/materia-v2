import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can, OrgContext } from '@materia/data-access';
import { orgInsightsSettingsRepository, withInsightsVisibility } from '@materia/data-access/repository';
import type { MemberMetricsVisibility } from '@materia/domain';
import { MtSelect, ToastService, type MtOption } from '@materia/ui';

import { errorCopy } from '../../core/error-copy';

/** What each choice of `settings.insights.memberVisibility` means, in the firm's words. */
export const VISIBILITY_OPTIONS: MtOption<MemberMetricsVisibility>[] = [
  { value: 'lawyers', label: 'Owners, admins and lawyers' },
  { value: 'admins', label: 'Owners and admins' },
  { value: 'everyone', label: 'Everyone in the firm' },
];

/**
 * Who sees every fee earner's figures on Insights (INS-01's member visibility), beside the period
 * filters: owners and admins (`org.settings`) change it, and it saves at once. Lawyers and above
 * until they do; everyone always sees their own.
 */
@Component({
  selector: 'mt-insights-visibility',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtSelect],
  template: `
    @if (canChange()) {
      <mt-select
        name="insights-visibility"
        label="Everyone’s figures shown to"
        [native]="true"
        [options]="options"
        [disabled]="saving() || org.status() !== 'ready'"
        [ngModel]="visibility()"
        (ngModelChange)="set($event)"
      />
    }
  `,
})
export class InsightsVisibility {
  private readonly context = inject(OrgContext);
  private readonly toasts = inject(ToastService);
  private readonly repo = orgInsightsSettingsRepository();

  protected readonly options = VISIBILITY_OPTIONS;
  protected readonly canChange = can('org.settings');
  protected readonly org = this.repo.watch(() => (this.canChange() ? this.context.orgId() : null));
  protected readonly visibility = computed<MemberMetricsVisibility>(
    () => this.org.value()?.settings?.insights?.memberVisibility ?? 'lawyers',
  );
  protected readonly saving = signal(false);

  protected async set(next: MemberMetricsVisibility | null): Promise<void> {
    const orgId = this.context.orgId();
    if (!orgId || !next || next === this.visibility()) return;
    this.saving.set(true);
    try {
      await this.repo.update(orgId, { settings: withInsightsVisibility(this.org.value()?.settings, next) });
      const label = VISIBILITY_OPTIONS.find((o) => o.value === next)?.label.toLowerCase() ?? next;
      this.toasts.show({ title: `Everyone’s figures are shown to ${label}`, tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'The setting didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.saving.set(false);
    }
  }
}
