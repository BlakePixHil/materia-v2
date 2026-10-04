import { ChangeDetectionStrategy, Component, ViewEncapsulation } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** The layout for sign-in and onboarding: no shell, a centred card on the canvas. */
@Component({
  selector: 'mt-minimal-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The auth pages share these rules, so they are global (all prefixed `mt-auth-` or `mt-minimal`).
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../../../../libs/ui/src/generated/components/strength.css',
    '../../../../../libs/ui/src/generated/components/shimmer.css',
  ],
  imports: [RouterOutlet],
  template: `
    <main id="main" class="mt-minimal">
      <p class="mt-minimal-brand">Materia</p>
      <div class="mt-minimal-card"><router-outlet /></div>
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
    .mt-minimal-brand {
      margin: 0;
      font: 600 16px/24px var(--font-sans);
      letter-spacing: -0.01em;
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
    .mt-minimal-card h1 {
      margin: 0;
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
export class MinimalLayout {}
