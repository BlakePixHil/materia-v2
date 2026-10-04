import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { MtToastOutlet } from '@materia/ui';

@Component({
  selector: 'mt-root',
  imports: [RouterOutlet, MtToastOutlet],
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {}
