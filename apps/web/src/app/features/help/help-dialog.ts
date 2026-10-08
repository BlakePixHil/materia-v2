import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { feedbackCallables } from '@materia/data-access/repository';
import {
  FEEDBACK_KIND_LABELS,
  FEEDBACK_KINDS,
  FEEDBACK_MAX_LENGTH,
  type FeedbackKind,
  type SubmitFeedbackResult,
} from '@materia/domain';
import {
  injectDialogRef,
  MtButton,
  MtDialog,
  MtIcon,
  MtNote,
  MtRadioGroup,
  MtTextarea,
  type MtIconName,
  type MtOption,
} from '@materia/ui';

import { RELEASE } from '../../../environments/version';
import { CALLABLES } from '../../core/data/callables';
import { errorCodeOf, errorCopy } from '../../core/error-copy';
import { FeatureFlagService } from '../../core/flags/feature-flags';

export interface HelpDialogData {
  /** The page the person opened help from: a path, without a query string. */
  page: string;
}

interface HelpLink {
  label: string;
  link: string;
  icon: MtIconName;
}

/** RATE_LIMITED: past `FEEDBACK_PER_HOUR` messages in an hour. */
export const FEEDBACK_LIMIT_COPY = 'You’ve sent a lot of messages in the last hour. Try again later.';

const KINDS: MtOption<FeedbackKind>[] = FEEDBACK_KINDS.map((kind) => ({
  value: kind,
  label: FEEDBACK_KIND_LABELS[kind],
}));

/**
 * Help & feedback (SEC-08), from the account menu, More on a phone and ⌘K: where to read more, and
 * a message to the people who run Materia (`feedback-submit`), with the page it was sent from.
 * Closes with the result once sent, or `undefined` when cancelled; the opener thanks the person.
 */
@Component({
  selector: 'mt-help-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtIcon, MtNote, MtRadioGroup, MtTextarea, RouterLink],
  template: `
    <mt-dialog
      size="md"
      title="Help & feedback"
      description="Tell the people who run Materia what isn’t working, what would help, or what you’d like to know."
    >
      <nav class="mt-help-links" aria-label="Read more">
        <ul>
          @for (item of links(); track item.link) {
            <li>
              <a [routerLink]="item.link" (click)="cancel()">
                <mt-icon [name]="item.icon" [size]="16" />
                {{ item.label }}
              </a>
            </li>
          }
        </ul>
      </nav>
      <form id="mt-help-form" class="mt-col" style="gap: var(--space-16)" (submit)="$event.preventDefault(); send()">
        <mt-radio-group name="kind" label="What is it about?" [options]="kinds" [(ngModel)]="kind" />
        <mt-textarea
          name="body"
          label="Message"
          description="Leave out clients’ details. Support sees your name, email and practice, and the page you were on."
          [rows]="5"
          [maxLength]="maxLength"
          [required]="true"
          [error]="bodyError()"
          [ngModel]="body()"
          (ngModelChange)="body.set($event ?? '')"
        />
        @if (failure(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" type="button" (click)="cancel()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-help-form" [loading]="sending()">Send</button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .mt-help-links ul {
      list-style: none;
      margin: 0 0 var(--space-16);
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-8) var(--space-16);
    }
    .mt-help-links a {
      display: inline-flex;
      align-items: center;
      gap: var(--space-6);
      min-height: 32px;
      font: 500 13px/18px var(--font-sans);
      color: var(--text-brand);
    }
  `,
})
export class HelpDialog {
  private readonly ref = injectDialogRef<HelpDialogData, SubmitFeedbackResult | undefined>();
  private readonly api = feedbackCallables(inject(CALLABLES));
  private readonly flags = inject(FeatureFlagService);

  protected readonly kinds = KINDS;
  protected readonly maxLength = FEEDBACK_MAX_LENGTH;
  protected readonly kind = signal<FeedbackKind>('problem');
  protected readonly body = signal('');
  private readonly submitted = signal(false);
  protected readonly sending = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly bodyError = computed(() =>
    this.submitted() && !this.body().trim() ? 'Write a message' : undefined,
  );

  /** Where to read more. The Clerk guide only while Clerk is on. */
  protected readonly links = computed<HelpLink[]>(() => [
    ...(this.flags.isOn('clerk.enabled')
      ? [{ label: 'How Clerk works', link: '/help/clerk', icon: 'sparkle' as const }]
      : []),
    { label: 'Accessibility', link: '/legal/accessibility', icon: 'document' as const },
    { label: 'Privacy and terms', link: '/legal', icon: 'shield' as const },
  ]);

  protected cancel(): void {
    void this.ref.close(undefined);
  }

  protected async send(): Promise<void> {
    this.submitted.set(true);
    const body = this.body().trim();
    if (!body || this.sending()) return;
    this.sending.set(true);
    this.failure.set(null);
    try {
      const result = await this.api.submit({
        kind: this.kind(),
        body,
        page: this.ref.data.page.split(/[?#]/)[0]?.slice(0, 300) || '/',
        version: `${RELEASE.version}+${RELEASE.sha}`,
      });
      void this.ref.close(result);
    } catch (error) {
      this.failure.set(errorCodeOf(error) === 'RATE_LIMITED' ? FEEDBACK_LIMIT_COPY : errorCopy(error));
    } finally {
      this.sending.set(false);
    }
  }
}
