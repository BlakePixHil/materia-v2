import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import type { MessageAddress, MessageRendition } from '@materia/domain';
import { MT_ORG_TIMEZONE, MtButton, MtNote } from '@materia/ui';

import { formatBytes } from './documents-view';

/** "Avery Quill <avery@example.test>", or just the address. */
export function addressText(address: MessageAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

/**
 * An email document's message rendition (CORE-12): headers, the plain-text body (never HTML, so
 * nothing in the email runs or loads) and its attachments, each savable to the matter as a new
 * document when its type is allowed.
 */
@Component({
  selector: 'mt-message-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MtButton, MtNote],
  host: { class: 'mt-message-preview' },
  template: `
    <dl class="headers">
      <dt>Subject</dt>
      <dd>{{ message().subject || '(no subject)' }}</dd>
      @if (message().from; as from) {
        <dt>From</dt>
        <dd>{{ address(from) }}</dd>
      }
      @if (message().to.length) {
        <dt>To</dt>
        <dd>{{ list(message().to) }}</dd>
      }
      @if (message().cc.length) {
        <dt>Cc</dt>
        <dd>{{ list(message().cc) }}</dd>
      }
      @if (date()) {
        <dt>Date</dt>
        <dd>{{ date() }}</dd>
      }
    </dl>
    <pre class="body" tabindex="0" aria-label="Message body">{{ message().text }}</pre>
    @if (message().textTruncated) {
      <mt-note>This message is long, so only the start is shown. Download it to read the rest.</mt-note>
    }
    @if (message().attachments.length) {
      <section aria-labelledby="attachments-heading">
        <h3 id="attachments-heading" class="label">Attachments</h3>
        <ul>
          @for (attachment of message().attachments; track attachment.index) {
            <li>
              <span class="mt-ell">{{ attachment.fileName }}</span>
              <span class="caption t-3">{{ size(attachment.sizeBytes) }}</span>
              @if (canSave()) {
                @if (attachment.savable) {
                  <button
                    mtButton
                    size="sm"
                    class="mt-ml"
                    [disabled]="busy()"
                    [attr.aria-label]="'Save ' + attachment.fileName + ' to the matter'"
                    (click)="save.emit(attachment.index)"
                  >
                    Save to matter
                  </button>
                } @else {
                  <span class="caption t-3 mt-ml">This type can’t be saved</span>
                }
              }
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    .headers {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--space-4) var(--space-12);
      margin: 0;
      font: 400 13px/18px var(--font-sans);
    }
    dt {
      color: var(--text-secondary);
    }
    dd {
      margin: 0;
      overflow-wrap: anywhere;
    }
    .body {
      margin: 0;
      padding: var(--space-12);
      max-height: 60vh;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 400 13px/20px var(--font-sans);
      background: var(--bg-sunken);
      border-radius: var(--radius-md);
    }
    h3 {
      margin: 0 0 var(--space-8);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
    }
    li {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      font: 400 13px/18px var(--font-sans);
    }
  `,
})
export class MessagePreview {
  readonly message = input.required<MessageRendition>();
  /** document.upload roles may save attachments. */
  readonly canSave = input(false);
  readonly busy = input(false);
  readonly save = output<number>();
  private readonly timeZone = inject(MT_ORG_TIMEZONE);

  protected readonly date = computed(() => {
    const iso = this.message().date;
    if (!iso) return '';
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: this.timeZone });
  });

  protected address(address: MessageAddress): string {
    return addressText(address);
  }

  protected list(addresses: readonly MessageAddress[]): string {
    return addresses.map(addressText).join(', ');
  }

  protected size(bytes: number): string {
    return formatBytes(bytes);
  }
}
