import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { MtButton, MtCheckbox, MtIcon, MtRadioGroup, MtTextField, type MtOption } from '@materia/ui';

import { IntakeContactPicker, type PickedContact } from './contact-picker';
import { IntakeContacts } from './intake-contacts';
import { DISPUTE_ROLE_OPTIONS, DISPUTE_TYPES, ESTATE_TYPES, hasDeceased } from './intake-state';
import { IntakeStore } from './intake-store';
import { formatDob } from '../conflicts/conflict-view';

type YesNo = 'yes' | 'no';
const WILL_OPTIONS: MtOption<YesNo>[] = [
  { value: 'yes', label: 'Yes, there is a will' },
  { value: 'no', label: 'No will (intestacy)' },
];

/**
 * Step 3: what this type of matter needs. A will: the testator. A power of attorney: the
 * principal. Probate, letters of administration and estate administration: the deceased, the
 * date of death (or Unknown), domicile and the will. Family provision and will disputes: the
 * deceased, who we act for and the other side. A testamentary trust: its name and trustees.
 */
@Component({
  selector: 'mt-intake-details-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    NgTemplateOutlet,
    IntakeContactPicker,
    IntakeContacts,
    MtButton,
    MtCheckbox,
    MtIcon,
    MtRadioGroup,
    MtTextField,
  ],
  template: `
    @let s = store.state();
    @let d = s.details;
    @switch (kind()) {
      @case ('person') {
        <section class="mt-col block" aria-labelledby="intake-person-h">
          <h2 id="intake-person-h" class="heading">{{ s.type === 'will' ? 'Testator' : 'Principal' }}</h2>
          <p class="caption t-2">
            {{ s.type === 'will' ? 'The person making the will.' : 'The person giving the power of attorney.' }}
          </p>
          @if (d.personContactId; as id) {
            <mt-intake-contacts
              [label]="s.type === 'will' ? 'Testator' : 'Principal'"
              [people]="[{ id: id, name: store.name(id) }]"
              (removed)="store.details({ personContactId: null })"
            />
          } @else {
            <ng-container *ngTemplateOutlet="useClient; context: { $implicit: 'personContactId' }" />
            <mt-intake-contact-picker
              [label]="s.type === 'will' ? 'Find the testator' : 'Find the principal'"
              (picked)="pickPerson('personContactId', $event)"
            />
          }
          <ng-container *ngTemplateOutlet="fieldError; context: { $implicit: 'personContactId' }" />
        </section>
      }
      @case ('deceased') {
        <section class="mt-col block" aria-labelledby="intake-deceased-h">
          <h2 id="intake-deceased-h" class="heading">The deceased</h2>
          @if (d.deceasedContactId; as id) {
            <mt-intake-contacts
              label="Deceased"
              [people]="[{ id: id, name: store.name(id), note: born() }]"
              (removed)="store.details({ deceasedContactId: null })"
            />
          } @else {
            <mt-intake-contact-picker
              label="Find the deceased"
              createLabel="New contact for the deceased…"
              (picked)="pickPerson('deceasedContactId', $event)"
            />
          }
          <ng-container *ngTemplateOutlet="fieldError; context: { $implicit: 'deceasedContactId' }" />
          <div class="grid">
            <mt-text-field
              label="Date of death"
              placeholder="DD/MM/YYYY"
              inputmode="numeric"
              autocomplete="off"
              [disabled]="d.dateOfDeathUnknown"
              [error]="store.error('dateOfDeath') ?? store.error('deceasedDateOfBirth')"
              [ngModel]="d.dateOfDeath"
              (ngModelChange)="store.details({ dateOfDeath: $event ?? '' })"
            />
            <div class="unknown">
              <mt-checkbox
                label="Unknown"
                description="A task to get the death certificate is added."
                [ngModel]="d.dateOfDeathUnknown"
                (ngModelChange)="store.details({ dateOfDeathUnknown: !!$event })"
              />
            </div>
            <mt-text-field
              label="Domicile"
              description="A state, or the country for a reseal."
              autocomplete="off"
              [optional]="dispute()"
              [error]="store.error('domicile')"
              [ngModel]="d.domicile"
              (ngModelChange)="store.details({ domicile: $event ?? '' })"
            />
            <mt-text-field
              label="Last address"
              autocomplete="off"
              [optional]="true"
              [ngModel]="d.lastAddress"
              (ngModelChange)="store.details({ lastAddress: $event ?? '' })"
            />
          </div>
          @if (estate()) {
            <mt-radio-group
              label="Is there a will?"
              orientation="horizontal"
              [options]="willOptions"
              [ngModel]="d.willExists === null ? null : d.willExists ? 'yes' : 'no'"
              (ngModelChange)="store.details({ willExists: $event === 'yes' })"
            />
            <ng-container *ngTemplateOutlet="fieldError; context: { $implicit: 'willExists' }" />
            @if (d.willExists) {
              <div class="grid">
                <mt-text-field
                  label="Date of the will"
                  placeholder="DD/MM/YYYY"
                  inputmode="numeric"
                  autocomplete="off"
                  [optional]="true"
                  [error]="store.error('willDate')"
                  [ngModel]="d.willDate"
                  (ngModelChange)="store.details({ willDate: $event ?? '' })"
                />
              </div>
            }
          }
        </section>
        @if (dispute()) {
          <section class="mt-col block" aria-labelledby="intake-side-h">
            <h2 id="intake-side-h" class="heading">The dispute</h2>
            <mt-radio-group
              label="Who do we act for?"
              [options]="roleOptions"
              [ngModel]="d.ourRole"
              (ngModelChange)="store.details({ ourRole: $event })"
            />
            <ng-container *ngTemplateOutlet="fieldError; context: { $implicit: 'ourRole' }" />
            <h3 class="label">The other side</h3>
            <mt-intake-contacts
              label="The other side"
              empty="No one on the other side yet."
              [people]="otherSide()"
              (removed)="removeFrom('otherSideContactIds', $event)"
            />
            <ng-container *ngTemplateOutlet="fieldError; context: { $implicit: 'otherSideContactIds' }" />
            <mt-intake-contact-picker
              label="Find someone on the other side"
              createLabel="New contact on the other side…"
              [exclude]="d.otherSideContactIds"
              (picked)="addTo('otherSideContactIds', $event)"
            />
          </section>
        }
      }
      @case ('trust') {
        <section class="mt-col block" aria-labelledby="intake-trust-h">
          <h2 id="intake-trust-h" class="heading">The trust</h2>
          <mt-text-field
            label="Trust name"
            autocomplete="off"
            [error]="store.error('trustName')"
            [ngModel]="d.trustName"
            (ngModelChange)="store.details({ trustName: $event ?? '' })"
          />
          <h3 class="label">Trustees</h3>
          <mt-intake-contacts
            label="Trustees"
            empty="No trustees yet."
            [people]="trustees()"
            (removed)="removeFrom('trusteeContactIds', $event)"
          />
          @if (clientsNotTrustees().length) {
            <div class="mt-row mt-wrap" style="gap: var(--space-8)">
              @for (client of clientsNotTrustees(); track client.id) {
                <button
                  mtButton
                  variant="ghost"
                  size="sm"
                  iconStart="plus"
                  type="button"
                  (click)="addId('trusteeContactIds', client.id)"
                >
                  Add {{ client.name }} as a trustee
                </button>
              }
            </div>
          }
          <ng-container *ngTemplateOutlet="fieldError; context: { $implicit: 'trusteeContactIds' }" />
          <mt-intake-contact-picker
            label="Find a trustee"
            createLabel="New trustee…"
            [exclude]="d.trusteeContactIds"
            (picked)="addTo('trusteeContactIds', $event)"
          />
        </section>
      }
      @default {
        <p class="caption t-2">Choose a matter type first.</p>
      }
    }

    <ng-template #fieldError let-field>
      @if (store.error(field); as message) {
        <p class="mt-error" role="alert"><mt-icon name="alert" [size]="14" />{{ message }}</p>
      }
    </ng-template>
    <ng-template #useClient let-field>
      @if (clients().length) {
        <div class="mt-row mt-wrap" style="gap: var(--space-8)">
          @for (client of clients(); track client.id) {
            <button mtButton variant="secondary" size="sm" type="button" (click)="setId(field, client.id)">
              Use {{ client.name }}
            </button>
          }
        </div>
      }
    </ng-template>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-24);
    }
    .block {
      gap: var(--space-12);
    }
    .block h2,
    .block h3,
    .block p {
      margin: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: var(--space-12);
      align-items: start;
    }
    .unknown {
      padding-top: 26px;
    }
  `,
})
export class IntakeDetailsStep {
  protected readonly store = inject(IntakeStore);
  protected readonly roleOptions = DISPUTE_ROLE_OPTIONS;
  protected readonly willOptions = WILL_OPTIONS;

  protected readonly kind = computed(() => {
    const type = this.store.state().type;
    if (type === 'will' || type === 'poa') return 'person';
    if (type === 'trust') return 'trust';
    return hasDeceased(type) ? 'deceased' : null;
  });
  protected readonly estate = computed(() => ESTATE_TYPES.includes(this.store.state().type ?? 'will'));
  protected readonly dispute = computed(() => DISPUTE_TYPES.includes(this.store.state().type ?? 'will'));
  protected readonly clients = computed(() =>
    this.store.state().clientContactIds.map((id) => ({ id, name: this.store.name(id) })),
  );
  protected readonly otherSide = computed(() =>
    this.store.state().details.otherSideContactIds.map((id) => ({ id, name: this.store.name(id) })),
  );
  protected readonly trustees = computed(() =>
    this.store.state().details.trusteeContactIds.map((id) => ({ id, name: this.store.name(id) })),
  );
  protected readonly clientsNotTrustees = computed(() => {
    const trustees = new Set(this.store.state().details.trusteeContactIds);
    return this.clients().filter((client) => !trustees.has(client.id));
  });
  protected readonly born = computed(() => {
    const s = this.store.state();
    const dob = s.details.deceasedContactId ? s.contacts[s.details.deceasedContactId]?.dateOfBirth : undefined;
    return dob ? `Born ${formatDob(dob)}` : undefined;
  });

  protected pickPerson(field: 'personContactId' | 'deceasedContactId', picked: PickedContact): void {
    this.store.remember(picked.id, picked.contact);
    this.store.details({ [field]: picked.id });
    // A deceased contact with a recorded date of death fills it in.
    const died = picked.contact.dateOfDeath;
    if (field === 'deceasedContactId' && died && !this.store.state().details.dateOfDeath.trim()) {
      this.store.details({ dateOfDeath: formatDob(died), dateOfDeathUnknown: false });
    }
  }

  protected setId(field: 'personContactId', id: string): void {
    this.store.details({ [field]: id });
  }

  protected addTo(field: 'otherSideContactIds' | 'trusteeContactIds', picked: PickedContact): void {
    this.store.remember(picked.id, picked.contact);
    this.addId(field, picked.id);
  }

  protected addId(field: 'otherSideContactIds' | 'trusteeContactIds', id: string): void {
    const current = this.store.state().details[field];
    if (!current.includes(id)) this.store.details({ [field]: [...current, id] });
  }

  protected removeFrom(field: 'otherSideContactIds' | 'trusteeContactIds', id: string): void {
    this.store.details({ [field]: this.store.state().details[field].filter((c) => c !== id) });
  }
}
