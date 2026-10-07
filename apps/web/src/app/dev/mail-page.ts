import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';

import { environment } from '../../environments/environment';

/** The emulator's `dev-mail` function, which renders what the fake mail and push ports captured. */
export function devMailUrl(env: { useEmulators: boolean; firebase: { projectId: string } } = environment) {
  return env.useEmulators ? `http://127.0.0.1:5001/${env.firebase.projectId}/australia-southeast1/dev-mail` : null;
}

/**
 * `/__dev/mail` (dev builds against the emulators only, FND-20): every email and push the
 * emulator captured instead of sending, rendered as Resend would send it. Production builds drop
 * this page, and the function behind it only exists in the emulator.
 */
@Component({
  selector: 'mt-mail-dev-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mt-col', style: 'gap: 12px; padding: 24px; height: 100%; box-sizing: border-box' },
  template: `
    <h1 class="title-l" style="margin: 0">Dev mail</h1>
    @if (url; as src) {
      <p style="margin: 0; color: var(--text-secondary)">
        Email and push captured by the emulators. Nothing here was sent.
        <a [href]="raw" target="_blank" rel="noopener">Open in a new tab</a>
      </p>
      <iframe
        title="Captured email and push"
        [src]="src"
        style="flex: 1; min-height: 480px; border: 1px solid var(--border-default); border-radius: 8px; background: #fff"
      ></iframe>
    } @else {
      <p style="margin: 0">Dev mail needs the Firebase emulators (<code>pnpm dev</code>).</p>
    }
  `,
})
export class MailDevPage {
  protected readonly raw = devMailUrl();
  protected readonly url: SafeResourceUrl | null = this.raw
    ? inject(DomSanitizer).bypassSecurityTrustResourceUrl(this.raw)
    : null;
}
