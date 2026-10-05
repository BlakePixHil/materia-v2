import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can, OrgContext } from '@materia/data-access';
import { orgReferralSettingsRepository, withThankYouTask } from '@materia/data-access/repository';
import { MtSwitch, ToastService } from '@materia/ui';

import { errorCopy } from '../../core/error-copy';

/**
 * The org's referral setting (CORE-18), beside the Referrers filter: a "Thank referrer" task when a
 * referred matter opens. Owners and admins (`org.settings`) change it; it is off until they do.
 */
@Component({
  selector: 'mt-referral-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtSwitch],
  template: `
    @if (canChange()) {
      <mt-switch
        label="Thank-you task for referrers"
        description="When a referred matter opens, add a task to thank the referrer."
        [disabled]="saving() || org.status() !== 'ready'"
        [ngModel]="enabled()"
        (ngModelChange)="set($event)"
      />
    }
  `,
})
export class ReferralSettings {
  private readonly context = inject(OrgContext);
  private readonly toasts = inject(ToastService);
  private readonly repo = orgReferralSettingsRepository();

  protected readonly canChange = can('org.settings');
  protected readonly org = this.repo.watch(() => (this.canChange() ? this.context.orgId() : null));
  protected readonly enabled = computed(() => this.org.value()?.settings?.referrals?.thankYouTask === true);
  protected readonly saving = signal(false);

  protected async set(on: boolean): Promise<void> {
    const orgId = this.context.orgId();
    if (!orgId || on === this.enabled()) return;
    this.saving.set(true);
    try {
      await this.repo.update(orgId, { settings: withThankYouTask(this.org.value()?.settings, on) });
      this.toasts.show({
        title: on ? 'Referred matters get a thank-you task' : 'Thank-you tasks are off',
        tone: 'success',
      });
    } catch (error) {
      this.toasts.show({ title: 'The setting didn’t save', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.saving.set(false);
    }
  }
}
