import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can } from '@materia/data-access';
import { docTemplateCallables } from '@materia/data-access/repository';
import { DOC_BODY_MAX, type DocTemplateInput, type PreviewDocTemplateResult } from '@materia/domain';
import { injectDialogRef, MtButton, MtDialog, MtNote, MtSearchField, MtTextarea, MtTextField } from '@materia/ui';

import { docTemplateErrorCopy, downloadBase64, missingText, templateProblems } from './document-templates-view';
import { CALLABLES } from '../../core/data/callables';
import { matterSearch } from '../notes/matter-search';
import { MATTER_QUERY_MIN, type MatterOption } from '../notes/note-view';

export interface TemplateTestData {
  templateId: string;
  name: string;
  /** A version to try (the latest by default). */
  version?: number;
  inputs: readonly DocTemplateInput[];
}

const SAMPLE_BODY = [
  'Thank you for your instructions.',
  '',
  '## Next steps',
  '',
  '1. We will locate the original will.',
  '2. We will apply for the grant.',
  '',
  'Please call me if you have **any** questions.',
].join('\n');

/**
 * Test merge (INT-06): fills a template from a chosen matter without saving anything, and shows
 * the body as it merged, the fields with no value and any font warnings, with the merged .docx to
 * download and check in Word (the letterhead's header and footer are in the download).
 */
@Component({
  selector: 'mt-template-test-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtNote, MtSearchField, MtTextarea, MtTextField],
  template: `
    <mt-dialog
      size="lg"
      [title]="'Test merge: ' + data.name"
      description="Fills the template from a matter. Nothing is saved."
    >
      <form
        id="mt-template-test-form"
        class="mt-col"
        style="gap: var(--space-12, 12px)"
        aria-label="Test merge"
        (submit)="$event.preventDefault(); run()"
      >
        @if (matter(); as chosen) {
          <div class="mt-row" style="gap: var(--space-8, 8px); align-items: center">
            <span class="caption t-3">Matter</span>
            <span class="label mt-grow" data-testid="test-merge-matter">{{ chosen.number }} · {{ chosen.title }}</span>
            <button mtButton variant="ghost" size="sm" type="button" (click)="matter.set(null)">Change</button>
          </div>
        } @else {
          <div class="mt-col" style="gap: 6px">
            <mt-search-field label="Matter" placeholder="Matter number or title" (queryChange)="search($event)" />
            @if (searching()) {
              <p class="caption t-3" role="status" style="margin: 0">Searching…</p>
            } @else if (query().length >= minQuery) {
              <ul class="results" aria-label="Matters found">
                @for (row of results(); track row.id) {
                  <li>
                    <button mtButton variant="ghost" size="sm" type="button" class="result" (click)="choose(row)">
                      {{ row.number }} <span class="caption t-3">{{ row.title }}</span>
                    </button>
                  </li>
                } @empty {
                  <li class="caption t-3">No matters match “{{ query() }}”.</li>
                }
              </ul>
            }
          </div>
        }
        @if (data.inputs.includes('recipient')) {
          <div class="pair">
            <mt-text-field
              name="recipientName"
              label="To"
              optional
              autocomplete="off"
              [ngModel]="recipientName()"
              (ngModelChange)="recipientName.set($event ?? '')"
            />
            <mt-textarea
              name="recipientAddress"
              label="Their address"
              optional
              [rows]="2"
              [ngModel]="recipientAddress()"
              (ngModelChange)="recipientAddress.set($event ?? '')"
            />
          </div>
        }
        @if (data.inputs.includes('body')) {
          <mt-textarea
            name="body"
            label="Body"
            description="Formatted text for {@body}: # headings, **bold**, *italics*, - bullets and 1. numbers."
            [rows]="5"
            [maxLength]="bodyMax"
            [ngModel]="body()"
            (ngModelChange)="body.set($event ?? '')"
          />
        }
        @if (error(); as message) {
          <mt-note tone="danger" role="alert">
            {{ message }}
            @if (problems().length) {
              <ul class="problems">
                @for (problem of problems(); track $index) {
                  <li>{{ problem }}</li>
                }
              </ul>
            }
          </mt-note>
        }
      </form>

      @if (result(); as merged) {
        <section
          class="mt-col"
          style="gap: var(--space-8, 8px)"
          aria-label="Test merge result"
          data-testid="test-merge-result"
        >
          @if (missing(); as text) {
            <mt-note tone="warning" data-testid="test-merge-missing">{{ text }}</mt-note>
          } @else {
            <mt-note tone="info">Every field had a value.</mt-note>
          }
          @for (warning of merged.warnings; track warning) {
            <mt-note tone="info">{{ warning }}</mt-note>
          }
          <div class="preview" [innerHTML]="merged.html"></div>
          <p class="caption t-3" style="margin: 0">
            The preview shows the body only. Download the .docx to see the letterhead, header and footer in Word.
          </p>
        </section>
      }

      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" type="button" (click)="ref.close()">Close</button>
        @if (result(); as merged) {
          <button mtButton variant="secondary" type="button" iconStart="arrow-down" (click)="download(merged)">
            Download .docx
          </button>
        }
        <button
          mtButton
          variant="primary"
          type="submit"
          form="mt-template-test-form"
          [loading]="running()"
          [disabled]="!matter()"
        >
          {{ result() ? 'Merge again' : 'Run test merge' }}
        </button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .results {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .result {
      width: 100%;
      justify-content: flex-start;
      gap: var(--space-8, 8px);
    }
    .pair {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: var(--space-12, 12px);
      align-items: start;
    }
    .problems {
      margin: 6px 0 0;
      padding-left: 18px;
    }
    .preview {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md, 8px);
      padding: var(--space-16, 16px) var(--space-20, 20px);
      background: var(--surface-1, #fff);
      max-height: 50vh;
      overflow: auto;
      font-family: Calibri, Carlito, var(--font-sans, sans-serif);
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .preview :is(p, ul, ol, h1, h2, h3) {
      margin: 0 0 0.6em;
    }
  `,
})
export class TemplateTestDialog {
  protected readonly ref = injectDialogRef<TemplateTestData, undefined>();
  protected readonly data = this.ref.data;
  private readonly api = docTemplateCallables(inject(CALLABLES));
  private readonly find = matterSearch(can('privileged.view'));

  protected readonly minQuery = MATTER_QUERY_MIN;
  protected readonly bodyMax = DOC_BODY_MAX;
  protected readonly query = signal('');
  protected readonly results = signal<MatterOption[]>([]);
  protected readonly searching = signal(false);
  protected readonly matter = signal<MatterOption | null>(null);
  protected readonly body = signal(this.data.inputs.includes('body') ? SAMPLE_BODY : '');
  protected readonly recipientName = signal('');
  protected readonly recipientAddress = signal('');
  protected readonly running = signal(false);
  protected readonly result = signal<PreviewDocTemplateResult | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly problems = signal<string[]>([]);
  protected readonly missing = computed(() => missingText(this.result()?.missing ?? []));
  private run_ = 0;

  protected async search(text: string): Promise<void> {
    const query = text.trim();
    this.query.set(query);
    const run = ++this.run_;
    if (query.length < MATTER_QUERY_MIN) {
      this.results.set([]);
      return;
    }
    this.searching.set(true);
    try {
      const rows = await this.find(query);
      if (run === this.run_) this.results.set(rows);
    } catch (error) {
      if (run === this.run_) this.error.set(docTemplateErrorCopy(error));
    } finally {
      if (run === this.run_) this.searching.set(false);
    }
  }

  protected choose(row: MatterOption): void {
    this.matter.set(row);
    this.result.set(null);
    this.error.set(null);
  }

  protected async run(): Promise<void> {
    const matter = this.matter();
    if (!matter || this.running()) return;
    this.running.set(true);
    this.error.set(null);
    this.problems.set([]);
    try {
      const name = this.recipientName().trim();
      const address = this.recipientAddress().trim();
      const body = this.body().trim();
      const recipient = { ...(name ? { name } : {}), ...(address ? { address } : {}) };
      this.result.set(
        await this.api.previewTemplate({
          templateId: this.data.templateId,
          ...(this.data.version !== undefined ? { version: this.data.version } : {}),
          matterId: matter.id,
          data: { ...(body ? { body } : {}), ...(name || address ? { recipient } : {}) },
        }),
      );
    } catch (error) {
      this.result.set(null);
      this.error.set(docTemplateErrorCopy(error));
      this.problems.set(templateProblems(error).map((problem) => problem.message));
    } finally {
      this.running.set(false);
    }
  }

  protected download(merged: PreviewDocTemplateResult): void {
    downloadBase64(merged.fileName, merged.contentBase64);
  }
}
