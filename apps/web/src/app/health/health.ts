import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Placeholder page proving the app boots and routes. Used by the e2e smoke test. */
@Component({
  selector: 'mt-health',
  template: `
    <main>
      <h1>Materia</h1>
      <p data-testid="health-status" role="status">OK</p>
    </main>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HealthPage {}
