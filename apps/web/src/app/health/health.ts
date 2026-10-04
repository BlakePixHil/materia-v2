import { ChangeDetectionStrategy, Component } from '@angular/core';

import { environment } from '../../environments/environment';
import { RELEASE } from '../../environments/version';

/** The health page: proves the app boots and routes, and shows which release is live (FND-05 smoke tests). */
@Component({
  selector: 'mt-health',
  template: `
    <main>
      <h1>Materia</h1>
      <p data-testid="health-status" role="status">OK</p>
      <p data-testid="health-release">
        Version <span data-testid="health-version">{{ release.version }}</span> ·
        <span data-testid="health-sha">{{ release.sha }}</span> · {{ env }}
      </p>
    </main>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HealthPage {
  protected readonly release = RELEASE;
  protected readonly env = environment.name;
}
