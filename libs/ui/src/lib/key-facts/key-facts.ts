import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  contentChild,
  DestroyRef,
  Directive,
  inject,
  input,
  output,
  signal,
  TemplateRef,
  ViewEncapsulation,
} from '@angular/core';

import { MtIcon } from '../icon/icon';
import { MtIconButton } from '../icon-button/icon-button';
import { MtTooltip } from '../tooltip/tooltip';

/** One fact in KeyFacts. */
export interface KeyFactVm {
  /** Stable key, such as `dateOfDeath`. */
  id: string;
  label: string;
  value: string;
  /** Show a copy button (default true when there is a value). */
  copyable?: boolean | undefined;
  /** Where Clerk found the value; rendered by the `mtFactCitation` template ("Will p3"). */
  citation?: { label: string; href?: string | undefined } | undefined;
  /** Show an Edit button that emits `edit` (inline editing through the `mtFactEditor` template). */
  editable?: boolean | undefined;
  /**
   * Why the fact can't be edited yet ("Add the deceased first"): shows the Edit button as
   * unavailable, with this as its tooltip and accessible name.
   */
  editBlockedReason?: string | undefined;
}

/** Context for the `mtFactCitation` template. */
export interface MtFactCitationContext {
  $implicit: KeyFactVm;
}

/**
 * The citation marker for Clerk-sourced facts: `<ng-template mtFactCitation let-fact>…</ng-template>`.
 * Without it, KeyFacts shows the citation label as a plain chip.
 */
@Directive({ selector: 'ng-template[mtFactCitation]' })
export class MtFactCitation {
  readonly template = inject<TemplateRef<MtFactCitationContext>>(TemplateRef);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the parameter only names the type guard
  static ngTemplateContextGuard(_dir: MtFactCitation, _ctx: unknown): _ctx is MtFactCitationContext {
    return true;
  }
}

/** Context for the `mtFactEditor` template. */
export interface MtFactEditorContext {
  $implicit: KeyFactVm;
}

/**
 * The inline editor for the fact being edited (`editing`): `<ng-template mtFactEditor let-fact>…</ng-template>`.
 * It replaces the value; the feature saves or cancels and clears `editing`.
 */
@Directive({ selector: 'ng-template[mtFactEditor]' })
export class MtFactEditor {
  readonly template = inject<TemplateRef<MtFactEditorContext>>(TemplateRef);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the parameter only names the type guard
  static ngTemplateContextGuard(_dir: MtFactEditor, _ctx: unknown): _ctx is MtFactEditorContext {
    return true;
  }
}

/** How long the copy button shows its tick. */
export const MT_COPIED_MS = 1500;

/**
 * KeyFacts (`mt-key-facts`): a matter's facts as a definition list, each with a copy button. Clerk-sourced
 * values carry a citation marker (FND-11's Citation, through the `mtFactCitation` template). Editable
 * facts get an Edit button; the fact in `editing` renders the `mtFactEditor` template (CORE-06).
 */
@Component({
  selector: 'mt-key-facts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    '../../generated/components/facts.css',
    '../../generated/components/cite.css',
    '../../generated/components/ibtn.css',
  ],
  styles: `
    .mt-facts-blocked {
      color: var(--text-disabled);
      cursor: not-allowed;
    }
  `,
  imports: [MtIcon, MtIconButton, MtTooltip, NgTemplateOutlet],
  host: { style: 'display: block' },
  template: `
    <dl class="mt-facts">
      @for (fact of facts(); track fact.id) {
        <dt>{{ fact.label }}</dt>
        <dd>
          @if (editing() === fact.id && editorTemplate(); as editor) {
            <ng-container *ngTemplateOutlet="editor.template; context: { $implicit: fact }" />
          } @else {
            <span class="mt-facts-value">{{ fact.value || empty }}</span>
            @if (fact.citation; as citation) {
              @if (citationTemplate(); as custom) {
                <ng-container *ngTemplateOutlet="custom.template; context: { $implicit: fact }" />
              } @else {
                <span class="mt-cite"><span class="mt-sr">Source: </span>{{ citation.label }}</span>
              }
            }
            @if (fact.value && fact.copyable !== false) {
              <button
                mtIconButton
                class="mt-facts-copy"
                size="sm"
                [icon]="copiedId() === fact.id ? 'check' : 'copy'"
                [label]="'Copy ' + fact.label"
                (click)="copy(fact)"
              ></button>
            }
            @if (fact.editable) {
              <button
                mtIconButton
                class="mt-facts-copy"
                size="sm"
                icon="compose"
                [label]="'Edit ' + fact.label"
                (click)="edit.emit(fact)"
              ></button>
            } @else if (fact.editBlockedReason; as reason) {
              <!-- Not a button: nothing happens yet, but the reason is reachable by hover and focus. -->
              <span
                class="mt-ibtn mt-facts-copy mt-facts-blocked"
                data-size="sm"
                role="img"
                tabindex="0"
                [attr.aria-label]="reason"
                [mtTooltip]="reason"
                ><mt-icon name="compose"
              /></span>
            }
          }
        </dd>
      }
    </dl>
    <span class="mt-sr" aria-live="polite">{{ announcement() }}</span>
  `,
})
export class MtKeyFacts {
  readonly facts = input.required<readonly KeyFactVm[]>();
  /** The id of the fact shown in the `mtFactEditor` template instead of its value. */
  readonly editing = input<string | null>(null);
  /** A value was copied to the clipboard. */
  readonly copied = output<KeyFactVm>();
  /** The Edit button of an editable fact was pressed. */
  readonly edit = output<KeyFactVm>();

  protected readonly empty = '—';
  protected readonly citationTemplate = contentChild(MtFactCitation);
  protected readonly editorTemplate = contentChild(MtFactEditor);
  protected readonly copiedId = signal<string | null>(null);
  protected readonly announcement = signal('');
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  protected async copy(fact: KeyFactVm): Promise<void> {
    try {
      await navigator.clipboard.writeText(fact.value);
    } catch {
      this.announcement.set(`Couldn't copy ${fact.label}`);
      return;
    }
    this.copiedId.set(fact.id);
    this.announcement.set(`${fact.label} copied`);
    this.copied.emit(fact);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.copiedId.set(null);
      this.announcement.set('');
    }, MT_COPIED_MS);
  }
}
