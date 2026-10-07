import { ChangeDetectionStrategy, Component, inject, ViewEncapsulation } from '@angular/core';
import { ActivatedRoute, RouterLink, RouterOutlet } from '@angular/router';

import { MtBrandMark } from '@materia/ui';

/**
 * The layout for sign-in, onboarding and the legal pages: no shell, a centred card on the canvas,
 * and links to the privacy policy and terms (SEC-01). A route with `data: { width: 'wide' }` gets a
 * wider card, for reading (the legal documents).
 */
@Component({
  selector: 'mt-minimal-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The auth pages share these rules, so they are global (all prefixed `mt-auth-` or `mt-minimal`).
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../../../../libs/ui/src/generated/components/strength.css',
    '../../../../../libs/ui/src/generated/components/shimmer.css',
  ],
  imports: [RouterLink, RouterOutlet, MtBrandMark],
  template: `
    <main id="main" class="mt-minimal">
      <mt-brand-mark [size]="32" wordmark />
      <div class="mt-minimal-card" [attr.data-width]="wide ? 'wide' : null"><router-outlet /></div>
      <nav class="mt-minimal-legal" aria-label="Legal">
        <a routerLink="/legal/privacy">Privacy policy</a>
        <a routerLink="/legal/terms">Terms of service</a>
        <a routerLink="/legal/collection-notice">Collection notice</a>
      </nav>
    </main>
  `,
  styles: `
    .mt-minimal {
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 24px;
      padding: 24px 16px;
      background: var(--bg-canvas);
    }
    .mt-minimal-card {
      width: min(100%, 440px);
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 32px;
      border-radius: var(--radius-xl);
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      box-shadow: var(--shadow-card);
    }
    .mt-minimal-card[data-width='wide'] {
      width: min(100%, 760px);
    }
    @media (max-width: 600px) {
      .mt-minimal-card[data-width='wide'] {
        padding: 24px 16px;
      }
    }
    .mt-minimal-card h1 {
      margin: 0;
    }
    .mt-minimal-legal {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 4px 20px;
      font: 400 13px/18px var(--font-sans);
    }
    .mt-minimal-legal a {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      color: var(--text-secondary);
      text-underline-offset: 2px;
    }
    .mt-minimal-legal a:hover {
      color: var(--text-primary);
    }
    /* The routed page is the card's content: spaced as a column; the outlet itself takes no room. */
    .mt-minimal-card > router-outlet {
      display: none;
    }
    .mt-minimal-card > router-outlet + * {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .mt-auth-head {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .mt-auth-head p {
      margin: 0;
      color: var(--text-secondary);
      font: 400 14px/20px var(--font-sans);
    }
    .mt-auth-form {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .mt-auth-wide {
      width: 100%;
      justify-content: center;
    }
    .mt-auth-or {
      display: flex;
      align-items: center;
      gap: 12px;
      color: var(--text-tertiary);
      font: 400 12px/16px var(--font-sans);
    }
    .mt-auth-or::before,
    .mt-auth-or::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border-default);
    }
    .mt-auth-email {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 8px 12px;
      border-radius: var(--radius-sm);
      background: var(--bg-sunken);
      font: 500 14px/20px var(--font-sans);
    }
    .mt-auth-email span {
      flex: 1;
    }
    .mt-auth-link {
      border: 0;
      background: none;
      padding: 0;
      color: var(--text-brand);
      font: inherit;
      cursor: pointer;
      text-decoration: underline;
    }
    .mt-auth-foot {
      margin: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      color: var(--text-secondary);
      font: 400 13px/18px var(--font-sans);
      text-align: center;
    }
    .mt-auth-foot a {
      color: var(--text-brand);
    }
    .mt-auth-foot a,
    .mt-auth-foot .mt-auth-link {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
    }
    .mt-auth-qr {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 16px;
    }
    .mt-auth-secret {
      font: 500 14px/20px var(--font-mono);
      letter-spacing: 0.04em;
      word-break: break-all;
    }
    .mt-auth-codes {
      margin: 0;
      padding: 12px 16px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 16px;
      border-radius: var(--radius-md);
      background: var(--bg-sunken);
      list-style: none;
    }
    .mt-auth-codes code {
      font: 500 14px/20px var(--font-mono);
    }
  `,
})
export class MinimalLayout {
  /** A wider card for reading (`data: { width: 'wide' }` on the route). */
  protected readonly wide = inject(ActivatedRoute).snapshot.data['width'] === 'wide';
}
