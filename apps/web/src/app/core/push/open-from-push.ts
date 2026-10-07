import { ChangeDetectionStrategy, Component, effect, inject, Injector } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { OrgContext } from '@materia/data-access';
import { DialogService, MtSkeleton, ToastService } from '@materia/ui';

import { errorCopy } from '../error-copy';
import { OfflineError, OrgService } from '../orgs/org-service';

/**
 * A push's link (`/open?to=/matters/m1/deadlines&org=org-1`, made by `sw.js`), if it's a path in
 * this app (one leading slash); otherwise Today.
 */
export function pushTarget(value: string | null): string {
  return value && /^\/(?![/\\])/.test(value) ? value : '/today';
}

/** Resolves once `ready()` is true, or after `timeoutMs`. */
function until(injector: Injector, ready: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      watcher.destroy();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const watcher = effect(
      () => {
        if (ready()) done();
      },
      { injector, manualCleanup: true },
    );
  });
}

/**
 * `/open` (MOB-04): where a tapped push lands. A link in the active org opens straight away. A
 * link from another of the person's orgs asks before switching (switching reloads Materia), then
 * opens it there; one from an org they've left goes to Today with a note.
 */
@Component({
  selector: 'mt-open-from-push',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtSkeleton],
  template: `<mt-skeleton variant="lines" label="Opening the notification…" [count]="3" />`,
})
export class OpenFromPushPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly context = inject(OrgContext);
  private readonly orgs = inject(OrgService);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly injector = inject(Injector);

  constructor() {
    void this.open();
  }

  private async open(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;
    const to = pushTarget(params.get('to'));
    const orgId = params.get('org');
    if (!orgId || orgId === this.context.orgId()) return this.go(to);
    // The person's orgs come with users/{uid}, which may still be loading after a cold start.
    await until(this.injector, () => this.orgs.tenancy() !== null, 10_000);
    const target = this.orgs.orgs().find((org) => org.orgId === orgId);
    if (!target) {
      this.toasts.show({ title: 'That notification is from a practice you’re no longer part of' });
      return this.go('/today');
    }
    const current = this.orgs.orgs().find((org) => org.active)?.name ?? 'this practice';
    const yes = await this.dialogs.confirm({
      title: `Switch to ${target.name}?`,
      body: `This notification is from ${target.name}. You’re working in ${current}. Switching reloads Materia.`,
      confirmLabel: `Switch to ${target.name}`,
      cancelLabel: 'Stay here',
    });
    if (!yes) return this.go('/today');
    try {
      await this.orgs.switchOrg(orgId, to);
    } catch (error) {
      this.toasts.show({
        title: error instanceof OfflineError ? error.message : errorCopy(error),
        tone: 'danger',
      });
      return this.go('/today');
    }
  }

  private async go(url: string): Promise<void> {
    await this.router.navigateByUrl(url, { replaceUrl: true });
  }
}
