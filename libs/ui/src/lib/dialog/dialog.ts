import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  Directive,
  inject,
  Injectable,
  input,
  signal,
  type Type,
  ViewEncapsulation,
} from '@angular/core';
import {
  injectDialogRef,
  NgpDialog,
  NgpDialogDescription,
  NgpDialogManager,
  type NgpDialogRef,
  NgpDialogOverlay,
  NgpDialogTitle,
  NgpDialogTrigger,
} from 'ng-primitives/dialog';
import { firstValueFrom } from 'rxjs';

import { MtButton } from '../button/button';
import { MtIconButton } from '../icon-button/icon-button';
import { MtTextField } from '../text-field/text-field';

export type MtDialogSize = 'sm' | 'md' | 'lg';

/**
 * The dialog frame (`mt-dialog`): scrim, panel, title, description, body and footer. Use it as the
 * root of a dialog component opened with `DialogService`, or inside an `<ng-template>` opened with
 * `[mtDialogTrigger]`. Focus is trapped inside and returns to the opener on close; Escape closes the
 * topmost layer only (a menu open inside the dialog closes first). Page scroll is locked while open.
 *
 * ```html
 * <mt-dialog title="Publish the notice?" description="It goes to the Supreme Court portal.">
 *   …
 *   <ng-container mtDialogFooter>
 *     <button mtButton variant="ghost" (click)="dialog.close()">Cancel</button>
 *     <button mtButton variant="primary" (click)="dialog.close(true)">Publish notice</button>
 *   </ng-container>
 * </mt-dialog>
 * ```
 */
@Component({
  selector: 'mt-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/overlay.css',
    '../../generated/components/modal.css',
    '../../generated/components/dialog.css',
  ],
  // A tall dialog (a long form on a laptop screen) fits the viewport and scrolls its body, keeping
  // the title and footer in view; centring an overflowing panel would cut off its top.
  // On a phone narrower than the dialog, it fits the screen: the overlay's single grid column would
  // otherwise grow to the dialog's 480px, so `max-width: 100%` capped nothing and it ran off the side.
  styles: `
    .mt-modal-root:has(> .mt-dialog) {
      grid-template-columns: minmax(0, 1fr);
    }
    .mt-modal-root > .mt-dialog {
      max-height: calc(100dvh - 2 * var(--space-16));
    }
    .mt-dialog > .mt-dialog-b {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
    }
    .mt-dialog > .mt-dialog-h,
    .mt-dialog > .mt-dialog-f {
      flex: none;
    }
  `,
  imports: [NgpDialogOverlay, NgpDialog, NgpDialogTitle, NgpDialogDescription, MtIconButton],
  host: { style: 'display: contents' },
  template: `
    <div ngpDialogOverlay class="mt-overlay mt-modal-root" [ngpDialogOverlayCloseOnClick]="closeOnOutsideClick()">
      <div ngpDialog class="mt-dialog" [ngpDialogRole]="role()" [attr.data-size]="size() === 'md' ? null : size()">
        <div class="mt-dialog-h">
          <h2 ngpDialogTitle>{{ title() }}</h2>
          @if (closable()) {
            <button mtIconButton icon="x" size="sm" label="Close" [tooltip]="false" (click)="ref?.close()"></button>
          }
        </div>
        <div class="mt-dialog-b">
          @if (description(); as text) {
            <p ngpDialogDescription>{{ text }}</p>
          }
          <ng-content />
        </div>
        <div class="mt-dialog-f"><ng-content select="[mtDialogFooter]" /></div>
      </div>
    </div>
  `,
})
export class MtDialog {
  /** The question or task ("Delete this matter?"). The primary button repeats its verb. */
  readonly title = input.required<string>();
  readonly description = input<string>();
  readonly size = input<MtDialogSize>('md');
  /** `alertdialog` for destructive confirmations. */
  readonly role = input<'dialog' | 'alertdialog'>('dialog');
  /** Show the close button (default). */
  readonly closable = input(true, { transform: booleanAttribute });
  readonly closeOnOutsideClick = input(true, { transform: booleanAttribute });

  protected readonly ref = injectDialogRef({ optional: true });
}

/** Opens an `<ng-template>` holding an `<mt-dialog>` from a button. */
@Directive({
  selector: '[mtDialogTrigger]',
  hostDirectives: [
    {
      directive: NgpDialogTrigger,
      inputs: ['ngpDialogTrigger: mtDialogTrigger'],
      outputs: ['ngpDialogTriggerClosed: mtDialogClosed'],
    },
  ],
})
export class MtDialogTrigger {}

/** Options for `DialogService.open`. */
export interface MtDialogOptions<D> {
  data?: D;
  closeOnEscape?: boolean;
  closeOnOutsideClick?: boolean;
  /**
   * Where focus goes after closing when the element that opened the dialog has since been removed
   * (for example a table row that re-rendered). Defaults to the opener's closest focusable container.
   */
  returnFocusTo?: HTMLElement;
}

/** A dialog opened from code. `result` resolves when it closes (undefined when dismissed). */
export interface MtDialogHandle<R> {
  readonly ref: NgpDialogRef<unknown, R>;
  readonly result: Promise<R | undefined>;
  close(result?: R): Promise<void>;
}

/** What `DialogService.confirm` asks. */
export interface MtConfirmOptions {
  title: string;
  body?: string;
  /** The primary button's label; repeat the verb ("Delete matter"). */
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` for destructive actions (red button, `alertdialog`). */
  tone?: 'danger' | 'primary';
  /** Require typing this text, such as the matter number, before confirming. */
  typedConfirmation?: string;
}

/**
 * Opens dialogs from code, with typed data and results.
 *
 * ```ts
 * const dialogs = inject(DialogService);
 * const handle = dialogs.open<EditDeadlineData, Deadline>(EditDeadlineDialog, { data: { deadline } });
 * const updated = await handle.result; // undefined when cancelled
 *
 * if (await dialogs.confirm({ title: 'Delete WE-142?', confirmLabel: 'Delete matter', tone: 'danger',
 *   typedConfirmation: 'WE-142' })) { … }
 * ```
 *
 * Inside the dialog component, `injectDialogRef<Data, Result>()` gives `data` and `close(result)`.
 */
@Injectable({ providedIn: 'root' })
export class DialogService {
  private readonly manager = inject(NgpDialogManager);

  open<D = unknown, R = unknown>(component: Type<unknown>, options: MtDialogOptions<D> = {}): MtDialogHandle<R> {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fallback = options.returnFocusTo ?? focusableContainer(opener);
    const ref = this.manager.open(component, {
      data: options.data as D,
      closeOnEscape: options.closeOnEscape ?? true,
      closeOnOutsideClick: options.closeOnOutsideClick ?? true,
    }) as unknown as NgpDialogRef<unknown, R>;
    const result = firstValueFrom(ref.afterClosed, { defaultValue: undefined }).then((value) => {
      // The opener may have been re-rendered while the dialog was open: focus a stable container.
      queueMicrotask(() => {
        if (opener && !opener.isConnected && fallback?.isConnected) fallback.focus();
      });
      return value;
    });
    return { ref, result, close: (value?: R) => ref.close(value) };
  }

  /** Asks for confirmation; resolves true only when the user confirms. */
  async confirm(options: MtConfirmOptions): Promise<boolean> {
    const handle = this.open<MtConfirmOptions, boolean>(MtConfirmDialog, { data: options });
    return (await handle.result) === true;
  }
}

/** The nearest ancestor that can take focus, made focusable if needed. */
function focusableContainer(element: HTMLElement | null): HTMLElement | null {
  let node = element?.parentElement ?? null;
  while (node && node !== document.body) {
    if (node.tabIndex >= 0 || node.hasAttribute('tabindex') || node.matches('main, [role="region"], section')) {
      if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** The confirmation dialog behind `DialogService.confirm`, including the typed-confirmation variant. */
@Component({
  selector: 'mt-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtDialog, MtButton, MtTextField],
  template: `
    <mt-dialog
      size="sm"
      [title]="options.title"
      [description]="options.body"
      [role]="options.tone === 'danger' ? 'alertdialog' : 'dialog'"
    >
      @if (options.typedConfirmation; as expected) {
        <mt-text-field
          [label]="'Type ' + expected + ' to confirm'"
          autocomplete="off"
          (input)="typed.set($any($event.target).value)"
        />
      }
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close(false)">{{ options.cancelLabel ?? 'Cancel' }}</button>
        <button
          mtButton
          [variant]="options.tone === 'danger' ? 'danger' : 'primary'"
          [disabled]="!canConfirm()"
          (click)="ref.close(true)"
        >
          {{ options.confirmLabel }}
        </button>
      </ng-container>
    </mt-dialog>
  `,
})
export class MtConfirmDialog {
  protected readonly ref = injectDialogRef<MtConfirmOptions, boolean>();
  protected readonly options = this.ref.data;
  protected readonly typed = signal('');
  protected readonly canConfirm = computed(() => {
    const expected = this.options.typedConfirmation;
    return !expected || this.typed().trim() === expected;
  });
}

export { injectDialogRef };
