import { computed, inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';

import { DataLifecycle } from '@materia/data-access';
import { DialogService, ThemeService, ToastService } from '@materia/ui';

import { waitingScans } from '../../features/scan/scan-db';
import { AuthState } from '../auth/auth-state';
import { errorCopy } from '../error-copy';
import { OfflineError, OrgService } from '../orgs/org-service';
import { UserPrefsService } from '../profile/user-prefs';

/**
 * What the person can do with their account: from the desktop user menu and the phone's More tab
 * (MOB-02), so both behave the same.
 */
@Injectable({ providedIn: 'root' })
export class AccountActions {
  private readonly auth = inject(AuthState);
  private readonly data = inject(DataLifecycle);
  private readonly dialogs = inject(DialogService);
  private readonly orgs = inject(OrgService);
  private readonly prefs = inject(UserPrefsService);
  private readonly router = inject(Router);
  private readonly theme = inject(ThemeService);
  private readonly toasts = inject(ToastService);

  readonly themeLabel = computed(() => (this.theme.resolved() === 'dark' ? 'Use light theme' : 'Use dark theme'));

  /**
   * Signs out, after a warning when changes made offline haven't synced (FND-19) or scans saved on
   * this phone haven't uploaded (MOB-05): sign-out deletes them.
   */
  async signOut(): Promise<void> {
    const uid = this.auth.session()?.uid;
    const scans = uid ? await waitingScans(uid) : 0;
    if (scans) {
      const discard = await this.dialogs.confirm({
        title: scans === 1 ? 'A scan hasn’t uploaded' : `${scans} scans haven’t uploaded`,
        body: `${scans === 1 ? 'A scan' : 'Scans'} saved on this device without a connection ${scans === 1 ? 'hasn’t' : 'haven’t'} reached Materia yet. Signing out deletes ${scans === 1 ? 'it' : 'them'}.`,
        confirmLabel: 'Sign out anyway',
        cancelLabel: 'Keep signed in',
        tone: 'danger',
      });
      if (!discard) return;
    }
    if (await this.data.hasUnsyncedChanges()) {
      const discard = await this.dialogs.confirm({
        title: 'You have unsynced changes',
        body: 'Some changes you made offline haven’t reached Materia yet. If you sign out now, they’re lost.',
        confirmLabel: 'Sign out anyway',
        cancelLabel: 'Wait for them to sync',
        tone: 'danger',
      });
      if (!discard) {
        void this.data
          .waitForSync()
          .then(() => this.toasts.show({ title: 'Your changes are synced', tone: 'success' }));
        return;
      }
    }
    await this.auth.signOut();
    await this.router.navigateByUrl('/auth/sign-in');
  }

  /** Switches the active org; the page then reloads on Today (FND-17). Blocked while offline. */
  async switchOrg(orgId: string, active: boolean): Promise<void> {
    if (active) return;
    try {
      await this.orgs.switchOrg(orgId);
    } catch (error) {
      this.toasts.show({
        title: error instanceof OfflineError ? error.message : errorCopy(error),
        tone: 'danger',
      });
    }
  }

  toggleTheme(): void {
    // Saved to the profile too, so it follows the person to other tabs and devices (CORE-20).
    void this.prefs.save({ theme: this.theme.resolved() === 'dark' ? 'light' : 'dark' }).catch(() => undefined);
  }
}
