import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule } from '@angular/forms';

import { contactsRepository, type ContactListItem, type WithId } from '@materia/data-access/repository';
import {
  contactDisplayName,
  formatPhone,
  DomainError,
  type CreateContactResult,
  type DuplicateMatch,
  type DuplicateReason,
  type FindDuplicatesResult,
} from '@materia/domain';
import {
  DialogService,
  injectDialogRef,
  MtButton,
  MtCheckbox,
  MtDialog,
  MtIconButton,
  MtNote,
  MtSegmentedControl,
  MtSelect,
  MtTextarea,
  MtTextField,
  formatDateOnly,
} from '@materia/ui';

import {
  ADDRESS_TYPE_OPTIONS,
  addressGroup,
  applyServerFieldErrors,
  clearedFields,
  CONTACT_ERROR_MESSAGES,
  contactFromForm,
  createContactForm,
  duplicateProbe,
  EMAIL_TYPE_OPTIONS,
  emailGroup,
  fillContactForm,
  INDUSTRY_OPTIONS,
  KIND_OPTIONS,
  PHONE_TYPE_OPTIONS,
  phoneGroup,
  STATE_OPTIONS,
  type ContactInput,
} from './contact-form';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';

export interface ContactFormDialogData {
  /** The contact to edit; absent to create one. */
  contact?: WithId<ContactListItem>;
}

/** `saved`: created or edited. `existing`: the person picked a duplicate instead of creating. */
export interface ContactFormDialogResult {
  outcome: 'saved' | 'existing';
  contactId: string;
}

const REASON_COPY: Record<DuplicateReason, string> = {
  name: 'similar name',
  dateOfBirth: 'date of birth',
  email: 'same email',
  phone: 'same phone',
  abn: 'same ABN',
};

/** "Similar name, date of birth". */
export function duplicateReasons(match: Pick<DuplicateMatch, 'reasons'>): string {
  const text = match.reasons.map((reason) => REASON_COPY[reason] ?? reason).join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Create or edit a contact (CORE-01). Creates check for duplicates first (`contacts-findDuplicates`)
 * and offer "Use existing" or "Create anyway", then call `contacts-create` (idempotent). Edits are
 * client-direct updates of the whitelisted fields. Recording a date of death asks first.
 */
@Component({
  selector: 'mt-contact-form-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MtButton,
    MtCheckbox,
    MtDialog,
    MtIconButton,
    MtNote,
    MtSegmentedControl,
    MtSelect,
    MtTextarea,
    MtTextField,
  ],
  template: `
    <mt-dialog [title]="title()" size="lg" [closeOnOutsideClick]="false">
      @if (duplicates(); as matches) {
        <div class="mt-col" style="gap: 12px" data-testid="duplicates">
          <mt-note tone="warning">
            {{
              matches.length === 1
                ? 'This might be someone you already have.'
                : 'These might be people you already have.'
            }}
            Use the existing contact to keep one record per person.
          </mt-note>
          <ul class="mt-contact-dupes">
            @for (match of matches; track match.contactId) {
              <li>
                <div class="mt-col mt-grow" style="gap: 2px">
                  <span class="label">{{ match.displayName }}</span>
                  <span class="caption">{{ reasons(match) }}</span>
                  @if (details(match); as text) {
                    <span class="caption">{{ text }}</span>
                  }
                </div>
                <button mtButton size="sm" (click)="useExisting(match)">Use existing</button>
              </li>
            }
          </ul>
        </div>
      } @else {
        <form id="contact-form" class="mt-col mt-contact-form" [formGroup]="form" (ngSubmit)="save()">
          @if (!editing()) {
            <mt-segmented-control label="Kind of contact" formControlName="kind" [options]="kindOptions" />
          }
          @if (kind() === 'person') {
            <div class="mt-contact-grid">
              <mt-text-field
                [errorMessages]="messages"
                label="Given names"
                formControlName="givenNames"
                autocomplete="off"
                [error]="nameError()"
              />
              <mt-text-field
                [errorMessages]="messages"
                label="Family name"
                formControlName="familyName"
                autocomplete="off"
              />
              <mt-text-field
                [errorMessages]="messages"
                label="Preferred name"
                formControlName="preferredName"
                autocomplete="off"
                optional
              />
              <span></span>
              <mt-text-field
                label="Date of birth"
                formControlName="dateOfBirth"
                placeholder="DD/MM/YYYY"
                inputmode="numeric"
                autocomplete="off"
                optional
                [errorMessages]="messages"
              />
              <mt-text-field
                label="Date of death"
                formControlName="dateOfDeath"
                placeholder="DD/MM/YYYY"
                inputmode="numeric"
                autocomplete="off"
                optional
                [errorMessages]="messages"
                [error]="dateOrderError()"
              />
            </div>
            <p class="caption mt-contact-hint">A single name is fine: fill in either the given or the family name.</p>
          } @else {
            <div class="mt-contact-grid">
              <mt-text-field
                [errorMessages]="messages"
                label="Organisation name"
                formControlName="orgName"
                autocomplete="off"
                [error]="orgNameError()"
              />
              <mt-text-field
                label="ABN"
                formControlName="abn"
                inputmode="numeric"
                autocomplete="off"
                optional
                [errorMessages]="messages"
              />
            </div>
          }

          <section class="mt-col" style="gap: 8px" aria-label="Emails">
            <h3 class="mt-contact-section">Emails</h3>
            @for (group of form.controls.emails.controls; track group; let i = $index) {
              <div class="mt-contact-row" [formGroup]="group">
                <mt-text-field
                  [errorMessages]="messages"
                  class="mt-grow"
                  label="Email"
                  type="email"
                  formControlName="address"
                />
                <mt-select label="Email type" formControlName="type" [options]="emailTypes" [native]="true" />
                <button
                  mtIconButton
                  icon="trash"
                  size="sm"
                  [label]="'Remove email ' + (i + 1)"
                  (click)="form.controls.emails.removeAt(i)"
                ></button>
              </div>
            }
            <button mtButton variant="ghost" size="sm" iconStart="plus" (click)="addEmail()">Add email</button>
          </section>

          <section class="mt-col" style="gap: 8px" aria-label="Phones">
            <h3 class="mt-contact-section">Phones</h3>
            @for (group of form.controls.phones.controls; track group; let i = $index) {
              <div class="mt-contact-row" [formGroup]="group">
                <mt-text-field
                  class="mt-grow"
                  label="Phone"
                  type="tel"
                  formControlName="number"
                  [errorMessages]="messages"
                />
                <mt-select label="Phone type" formControlName="type" [options]="phoneTypes" [native]="true" />
                <button
                  mtIconButton
                  icon="trash"
                  size="sm"
                  [label]="'Remove phone ' + (i + 1)"
                  (click)="form.controls.phones.removeAt(i)"
                ></button>
              </div>
            }
            <button mtButton variant="ghost" size="sm" iconStart="plus" (click)="addPhone()">Add phone</button>
          </section>

          <section class="mt-col" style="gap: 8px" aria-label="Addresses">
            <h3 class="mt-contact-section">Addresses</h3>
            @for (group of form.controls.addresses.controls; track group; let i = $index) {
              <div class="mt-contact-address" [formGroup]="group">
                <mt-text-field
                  [errorMessages]="messages"
                  label="Address line 1"
                  formControlName="line1"
                  autocomplete="off"
                />
                <mt-text-field
                  [errorMessages]="messages"
                  label="Address line 2"
                  formControlName="line2"
                  autocomplete="off"
                  optional
                />
                <div class="mt-contact-row">
                  <mt-text-field
                    [errorMessages]="messages"
                    class="mt-grow"
                    label="Suburb"
                    formControlName="suburb"
                    autocomplete="off"
                  />
                  <mt-select label="State" formControlName="state" [options]="states" [native]="true" />
                  <mt-text-field
                    label="Postcode"
                    formControlName="postcode"
                    inputmode="numeric"
                    autocomplete="off"
                    [errorMessages]="messages"
                  />
                </div>
                <div class="mt-contact-row">
                  <mt-select label="Address type" formControlName="type" [options]="addressTypes" [native]="true" />
                  <button mtButton variant="ghost" size="sm" iconStart="trash" (click)="removeAddress(i)">
                    Remove address {{ i + 1 }}
                  </button>
                </div>
              </div>
            }
            <button mtButton variant="ghost" size="sm" iconStart="plus" (click)="addAddress()">Add address</button>
          </section>

          <section class="mt-col" style="gap: 8px" aria-label="More">
            <h3 class="mt-contact-section">More</h3>
            <mt-text-field
              [errorMessages]="messages"
              label="Tags"
              formControlName="tags"
              description="Separate tags with commas."
              autocomplete="off"
              optional
            />
            <mt-checkbox label="Refers clients to the practice" formControlName="isReferrer" />
            @if (isReferrer()) {
              <div class="mt-contact-grid">
                <mt-text-field
                  [errorMessages]="messages"
                  label="Referrer company"
                  formControlName="referrerCompany"
                  optional
                />
                <mt-select label="Industry" formControlName="referrerIndustry" [options]="industries" [native]="true" />
              </div>
            }
            <mt-textarea label="Notes" formControlName="notes" optional />
          </section>
        </form>
      }
      @if (error(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      }
      <ng-container mtDialogFooter>
        @if (duplicates()) {
          <button mtButton variant="ghost" (click)="duplicates.set(null)">Back</button>
          <button mtButton variant="primary" [loading]="busy()" (click)="create(true)">Create anyway</button>
        } @else {
          <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
          <button mtButton variant="primary" type="submit" form="contact-form" [loading]="busy()">
            {{ editing() ? 'Save changes' : 'Create contact' }}
          </button>
        }
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .mt-contact-form {
      gap: var(--space-16);
    }
    .mt-contact-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: var(--space-12);
    }
    .mt-contact-row {
      display: flex;
      gap: var(--space-8);
      align-items: flex-end;
      flex-wrap: wrap;
    }
    .mt-contact-address {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      padding: var(--space-12);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md, 8px);
    }
    .mt-contact-section {
      margin: 0;
      font: 600 12px/16px var(--font-sans);
      color: var(--text-secondary);
    }
    .mt-contact-hint {
      margin: 0;
      color: var(--text-tertiary);
    }
    .mt-contact-dupes {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
    }
    .mt-contact-dupes li {
      display: flex;
      align-items: center;
      gap: var(--space-12);
      padding: var(--space-12);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md, 8px);
    }
    .mt-contact-dupes .caption {
      color: var(--text-secondary);
    }
  `,
})
export class ContactFormDialog {
  protected readonly ref = injectDialogRef<ContactFormDialogData, ContactFormDialogResult>();
  private readonly callables = inject(CALLABLES);
  private readonly dialogs = inject(DialogService);
  private readonly contacts = contactsRepository();
  private readonly createAction = this.callables.action<{ contact: ContactInput }, CreateContactResult>(
    'contacts-create',
  );

  protected readonly stored = this.ref.data?.contact ?? null;
  protected readonly form = createContactForm();
  protected readonly kindOptions = KIND_OPTIONS;
  protected readonly emailTypes = EMAIL_TYPE_OPTIONS;
  protected readonly industries = INDUSTRY_OPTIONS;
  protected readonly phoneTypes = PHONE_TYPE_OPTIONS;
  protected readonly addressTypes = ADDRESS_TYPE_OPTIONS;
  protected readonly states = STATE_OPTIONS;
  protected readonly messages = CONTACT_ERROR_MESSAGES;

  protected readonly editing = signal(!!this.stored);
  protected readonly title = computed(() => (this.stored ? `Edit ${contactDisplayName(this.stored)}` : 'New contact'));
  protected readonly submitted = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Possible duplicates found on create; the form hides while they show. */
  protected readonly duplicates = signal<DuplicateMatch[] | null>(null);
  private pending: ContactInput | null = null;

  private readonly value = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });
  protected readonly kind = computed(() => this.value().kind ?? 'person');
  protected readonly isReferrer = computed(() => !!this.value().isReferrer);
  protected readonly nameError = computed(() => {
    this.value();
    return this.submitted() && this.form.hasError('personName')
      ? 'Enter a given name or a family name (one is enough).'
      : '';
  });
  protected readonly orgNameError = computed(() => {
    this.value();
    return this.submitted() && this.form.hasError('orgName') ? 'Enter the organisation’s name.' : '';
  });
  protected readonly dateOrderError = computed(() => {
    this.value();
    return this.submitted() && this.form.hasError('dateOrder') ? (CONTACT_ERROR_MESSAGES['dateOrder'] ?? '') : '';
  });

  constructor() {
    if (this.stored) fillContactForm(this.form, this.stored);
  }

  protected reasons(match: DuplicateMatch): string {
    return duplicateReasons(match);
  }

  protected details(match: DuplicateMatch): string {
    return [
      match.dateOfBirth ? `Born ${formatDateOnly(match.dateOfBirth)}` : null,
      match.email ?? null,
      match.phone ? formatPhone(match.phone) : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  protected addEmail(): void {
    this.form.controls.emails.push(emailGroup());
  }

  protected addPhone(): void {
    this.form.controls.phones.push(phoneGroup());
  }

  protected addAddress(): void {
    this.form.controls.addresses.push(addressGroup());
  }

  protected removeAddress(index: number): void {
    this.form.controls.addresses.removeAt(index);
  }

  /** Validates, confirms a newly recorded death, then edits or checks for duplicates and creates. */
  protected async save(): Promise<void> {
    this.submitted.set(true);
    this.form.markAllAsTouched();
    this.error.set(null);
    if (this.form.invalid) return;
    let contact: ContactInput;
    try {
      contact = contactFromForm(this.form);
    } catch (error) {
      this.error.set(errorCopy(error));
      return;
    }
    if (contact.dateOfDeath && contact.dateOfDeath !== this.stored?.dateOfDeath) {
      const confirmed = await this.dialogs.confirm({
        title: `Record ${contactDisplayName(contact)} as deceased?`,
        body: `They will show as deceased (died ${formatDateOnly(contact.dateOfDeath)}) everywhere in Materia. You can then open a deceased estate matter for them.`,
        confirmLabel: 'Record date of death',
      });
      if (!confirmed) return;
    }
    if (this.stored) {
      await this.update(this.stored, contact);
      return;
    }
    this.pending = contact;
    await this.checkDuplicates(contact);
  }

  private async update(stored: WithId<ContactListItem>, contact: ContactInput): Promise<void> {
    this.busy.set(true);
    try {
      await this.contacts.update(stored.id, contact, { remove: clearedFields(contact, stored) });
      this.ref.close({ outcome: 'saved', contactId: stored.id });
    } catch (error) {
      this.error.set(errorCopy(error));
    } finally {
      this.busy.set(false);
    }
  }

  private async checkDuplicates(contact: ContactInput): Promise<void> {
    this.busy.set(true);
    try {
      const result = await this.callables.call<object, FindDuplicatesResult>(
        'contacts-findDuplicates',
        duplicateProbe(contact),
      );
      if (result.matches.length) {
        this.duplicates.set(result.matches);
        return;
      }
    } catch (error) {
      this.error.set(errorCopy(error));
      return;
    } finally {
      this.busy.set(false);
    }
    await this.create();
  }

  /** `contacts-create`; a retry after a failure re-uses the request id (idempotent). */
  protected async create(anyway = false): Promise<void> {
    const contact = this.pending;
    if (!contact) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await this.createAction.run({ contact });
      this.ref.close({ outcome: 'saved', contactId: result.contactId });
    } catch (error) {
      const fields = error instanceof DomainError ? error.details?.fields : undefined;
      if (error instanceof DomainError && error.code === 'INVALID_ARGUMENT' && fields) {
        // Back to the form, with the refused fields marked.
        this.duplicates.set(null);
        this.createAction.reset();
        if (applyServerFieldErrors(this.form, fields)) {
          this.error.set('Some details need fixing. Check the highlighted fields.');
          return;
        }
      }
      this.error.set(errorCopy(error));
      if (!anyway) this.duplicates.set(null);
    } finally {
      this.busy.set(false);
    }
  }

  protected useExisting(match: DuplicateMatch): void {
    this.ref.close({ outcome: 'existing', contactId: match.contactId });
  }
}
