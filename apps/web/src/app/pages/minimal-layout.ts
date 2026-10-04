import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** The layout for sign-in and onboarding: no shell, a centred card on the canvas. */
@Component({
  selector: 'mt-minimal-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
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
      gap: 20px;
      padding: 32px;
      border-radius: var(--radius-xl);
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      box-shadow: var(--shadow-card);
    }
  `,
})
export class MinimalLayout {}
