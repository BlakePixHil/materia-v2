import { computed, DestroyRef, DOCUMENT, inject, Injectable, signal } from '@angular/core';

import { DialogService, ToastService } from '@materia/ui';

/** Chrome and Edge's install prompt, held until the person asks for it. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** What `install()` did. */
export type InstallOutcome = 'accepted' | 'dismissed' | 'instructions' | 'unavailable';

export const INSTALL_COPY = {
  menuItem: 'Install Materia',
  installed: 'Materia is installed',
  installedDescription: 'Open it from your home screen, dock or Start menu.',
} as const;

/** iPhone and iPad, including iPads that report themselves as a Mac. */
export function isIos(navigator: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> & { platform?: string }): boolean {
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/** Running as the installed app rather than in a browser tab. */
export function isStandalone(view: Window | null): boolean {
  if (!view) return false;
  return (
    view.matchMedia?.('(display-mode: standalone)').matches === true ||
    (view.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * "Install Materia" (MOB-01): offered in the user menu and ⌘K, never as a banner. Chrome and Edge
 * fire `beforeinstallprompt` when the app can be installed; it's held (which also stops their own
 * install banner) and shown when the person asks. iOS has no prompt, so there it opens the
 * Add to Home Screen instructions. Nothing is offered once Materia runs as the installed app.
 */
@Injectable({ providedIn: 'root' })
export class InstallPrompt {
  private readonly view = inject(DOCUMENT).defaultView;
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly deferred = signal<BeforeInstallPromptEvent | null>(null);
  private readonly installed = signal(isStandalone(this.view));

  /** iOS: install means Share → Add to Home Screen. */
  readonly ios = !!this.view && isIos(this.view.navigator);
  /** Whether to offer "Install Materia". */
  readonly available = computed(() => !this.installed() && (this.deferred() !== null || this.ios));

  constructor() {
    const view = this.view;
    if (!view) return;
    const onPrompt = (event: Event) => {
      event.preventDefault();
      this.deferred.set(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      this.installed.set(true);
      this.deferred.set(null);
      this.toasts.show({
        title: INSTALL_COPY.installed,
        description: INSTALL_COPY.installedDescription,
        tone: 'success',
      });
    };
    view.addEventListener('beforeinstallprompt', onPrompt);
    view.addEventListener('appinstalled', onInstalled);
    const standalone = view.matchMedia?.('(display-mode: standalone)');
    const onDisplayMode = (event: MediaQueryListEvent) => this.installed.set(event.matches);
    standalone?.addEventListener?.('change', onDisplayMode);
    inject(DestroyRef).onDestroy(() => {
      view.removeEventListener('beforeinstallprompt', onPrompt);
      view.removeEventListener('appinstalled', onInstalled);
      standalone?.removeEventListener?.('change', onDisplayMode);
    });
  }

  /** Shows the browser's install prompt, or on iOS the Add to Home Screen instructions. */
  async install(): Promise<InstallOutcome> {
    const event = this.deferred();
    if (event) {
      // A prompt can be shown once; Chrome fires a new event if it's dismissed.
      this.deferred.set(null);
      await event.prompt();
      return (await event.userChoice).outcome;
    }
    if (this.ios) {
      const { InstallInstructions } = await import('./install-instructions');
      const phone = this.view?.matchMedia?.('(max-width: 767px)').matches ?? false;
      await this.dialogs.open(InstallInstructions, { data: { sheet: phone } }).result;
      return 'instructions';
    }
    return 'unavailable';
  }
}
