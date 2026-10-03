import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Placeholder page proving the app boots and routes. Used by the e2e smoke test. */
@Component({
  selector: 'mt-health',
  template: `
    <main>
      <h1>Materia</h1>
      <p data-testid="health-status" role="status">OK</p>
      <!-- FND-04 demo (reverted): an axe violation (image-alt) -->
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="1" height="1" />
    </main>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HealthPage {}
