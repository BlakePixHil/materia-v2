import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { injectDialogRef, MtButton, MtDialog, MtKbd } from '@materia/ui';

import { ShortcutService } from '../core/shortcuts/shortcut.service';

/** The `?` cheat sheet: every registered shortcut, by group. */
@Component({
  selector: 'mt-shortcuts-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtDialog, MtKbd],
  template: `
    <mt-dialog title="Keyboard shortcuts" description="Press ? any time to see this list.">
      @for (group of groups(); track group.name) {
        <section class="mt-shortcuts-group" [attr.aria-label]="group.name">
          <h3>{{ group.name }}</h3>
          <dl>
            @for (shortcut of group.items; track shortcut.combo) {
              <div>
                <dt>{{ shortcut.description }}</dt>
                <dd><mt-kbd [keys]="shortcut.combo" /></dd>
              </div>
            }
          </dl>
        </section>
      }
      <ng-container mtDialogFooter>
        <button mtButton variant="primary" (click)="ref.close()">Done</button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .mt-shortcuts-group h3 {
      margin: 0 0 6px;
      font: 600 12px/16px var(--font-sans);
      color: var(--text-tertiary);
    }
    .mt-shortcuts-group dl {
      margin: 0 0 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .mt-shortcuts-group dl > div {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      font: 400 13px/18px var(--font-sans);
    }
    .mt-shortcuts-group dd {
      margin: 0;
    }
  `,
})
export class ShortcutsDialog {
  private readonly shortcuts = inject(ShortcutService);
  protected readonly ref = injectDialogRef();
  protected readonly groups = computed(() => {
    const byGroup = new Map<string, ReturnType<ShortcutService['list']>>();
    for (const s of this.shortcuts.list()) byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
    return [...byGroup].map(([name, items]) => ({ name, items }));
  });
}
