import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink, RouterOutlet } from '@angular/router';
import { map } from 'rxjs';

import { MtTabLink, MtTabNav } from '@materia/ui';

import { MATTER_TABS } from './matter-tabs';

/** Matter detail frame: the matter number heading and router-linked tabs (CORE-06 builds the header). */
@Component({
  selector: 'mt-matter-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtTabNav, MtTabLink, RouterLink, RouterOutlet],
  host: { class: 'mt-col', style: 'gap: 16px; flex: 1' },
  template: `
    <h1 class="title-l" style="margin: 0">
      Matter <span style="font-family: var(--font-mono); font-size: 0.75em">{{ id() }}</span>
    </h1>
    <nav mtTabNav aria-label="Matter sections">
      @for (tab of tabs; track tab.path) {
        <a mtTabLink [routerLink]="tab.path">{{ tab.label }}</a>
      }
    </nav>
    <router-outlet />
  `,
})
export class MatterLayout {
  protected readonly tabs = MATTER_TABS;
  protected readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map((p) => p.get('id') ?? '')), {
    initialValue: '',
  });
}
