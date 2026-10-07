import { ChangeDetectionStrategy, Component, computed, inject, signal, ViewEncapsulation } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { legalDocument, TERMS_VERSION, type AcceptTermsInput, type AcceptTermsResult } from '@materia/domain';
import { MtButton, MtCheckbox, MtNote } from '@materia/ui';

import { LEGAL_CONTENT } from './legal-content.generated';
import { parseLegalMarkdown, sectionBlocks } from './legal-markdown';
import { DRAFT_NOTICE_TEXT, versionLine } from './legal-meta';
import { MtLegalProse } from './legal-prose';
import { AuthState } from '../../core/auth/auth-state';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { TermsState, termsReturnUrl } from '../../core/legal/terms';

/**
 * Accept the terms (`/accept-terms`, SEC-01): an owner whose practice hasn't accepted the current
 * terms of service and DPA reads their summary, ticks the box and accepts them for the practice
 * (`orgs-acceptTerms`), then goes on to where they were headed. `termsGuard` sends owners here;
 * nobody else is ever asked.
 */
@Component({
  selector: 'mt-accept-terms-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [ReactiveFormsModule, RouterLink, MtButton, MtCheckbox, MtNote, MtLegalProse],
  host: { class: 'mt-accept-terms' },
  template: `
    <header class="mt-auth-head">
      <h1 class="title-m">Accept the terms for {{ orgName() }}</h1>
      <p>
        Before your practice uses Materia, you accept its terms of service on the practice’s behalf, as its owner. Your
        team won’t be asked.
      </p>
    </header>
    @if (terms?.status === 'draft') {
      <mt-note tone="warning"><b>Draft — not yet reviewed.</b> {{ draftNotice }}</mt-note>
    }
    <section class="mt-accept-terms-summary" aria-labelledby="terms-summary-heading">
      <h2 id="terms-summary-heading" class="heading">The terms in brief</h2>
      @if (terms; as doc) {
        <p class="caption">{{ versionLine(doc) }}</p>
      }
      <mt-legal-prose [blocks]="summary" />
    </section>
    <p class="body">
      Read the full
      <a routerLink="/legal/terms" target="_blank">terms of service<span class="mt-sr"> (opens in a new tab)</span></a>
      and the
      <a routerLink="/legal/dpa" target="_blank"
        >data processing addendum<span class="mt-sr"> (opens in a new tab)</span></a
      >, which is part of them. The
      <a routerLink="/legal/privacy" target="_blank">privacy policy<span class="mt-sr"> (opens in a new tab)</span></a>
      explains how we handle personal information.
    </p>
    <form class="mt-auth-form" [formGroup]="form" (ngSubmit)="submit()">
      <mt-checkbox
        formControlName="accept"
        required
        label="I’ve read the terms of service and data processing addendum, and I accept them on behalf of my practice."
      />
      @if (error(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      }
      <button mtButton variant="primary" type="submit" class="mt-auth-wide" [loading]="busy()">
        Accept and continue
      </button>
    </form>
    <p class="mt-auth-foot">
      <button type="button" class="mt-auth-link" (click)="signOut()">Sign out</button>
    </p>
  `,
  styles: `
    .mt-accept-terms-summary {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 16px;
      border-radius: var(--radius-md);
      background: var(--bg-sunken);
    }
    .mt-accept-terms-summary h2,
    .mt-accept-terms-summary p.caption {
      margin: 0;
    }
    .mt-accept-terms-summary p.caption {
      color: var(--text-secondary);
    }
    .mt-accept-terms-summary .mt-legal-prose {
      font: 400 14px/22px var(--font-sans);
    }
    .mt-accept-terms > p.body {
      margin: 0;
      color: var(--text-secondary);
    }
    .mt-accept-terms > p.body a {
      color: var(--text-brand);
    }
  `,
})
export class AcceptTermsPage {
  private readonly auth = inject(AuthState);
  private readonly callables = inject(CALLABLES);
  private readonly state = inject(TermsState);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly terms = legalDocument('terms');
  protected readonly summary = sectionBlocks(parseLegalMarkdown(LEGAL_CONTENT.terms), 'Summary');
  protected readonly orgName = computed(() => this.auth.claims().orgName || 'your practice');
  protected readonly draftNotice = DRAFT_NOTICE_TEXT;
  protected readonly versionLine = versionLine;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly form = new FormGroup({
    accept: new FormControl(false, { nonNullable: true, validators: [Validators.requiredTrue] }),
  });

  protected async submit(): Promise<void> {
    this.error.set(null);
    this.form.markAllAsTouched();
    if (this.form.invalid || this.busy()) return;
    this.busy.set(true);
    try {
      const { version } = await this.callables.call<Omit<AcceptTermsInput, 'requestId'>, AcceptTermsResult>(
        'orgs-acceptTerms',
        { version: TERMS_VERSION },
        { idempotent: true },
      );
      this.state.markAccepted(version);
      await this.router.navigateByUrl(termsReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl')) ?? '/');
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected async signOut(): Promise<void> {
    await this.auth.signOut();
    await this.router.navigateByUrl('/auth/sign-in');
  }
}
