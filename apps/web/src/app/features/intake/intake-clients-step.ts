import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { REFERRAL_SOURCE_LABELS, ReferralSourceSchema, type ReferralSource } from '@materia/domain';
import { MtIcon, MtSelect, type MtOption } from '@materia/ui';

import { IntakeContactPicker, type PickedContact } from './contact-picker';
import { IntakeContacts } from './intake-contacts';
import { IntakeStore } from './intake-store';

/** No referral recorded, or one of the sources (CORE-18). */
const SOURCE_OPTIONS: MtOption<ReferralSource | ''>[] = [
  { value: '', label: 'Not recorded' },
  ...ReferralSourceSchema.options.map((source) => ({ value: source, label: REFERRAL_SOURCE_LABELS[source] })),
];

/**
 * Step 2: the client or clients, found among the contacts or created (with the duplicate check),
 * and how the matter came in (CORE-18): the referrer who sent it (referrers listed first), or a
 * source when no contact did. Optional.
 */
@Component({
  selector: 'mt-intake-clients-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, IntakeContactPicker, IntakeContacts, MtIcon, MtSelect],
  template: `
    <section class="mt-col" style="gap: var(--space-12)" aria-labelledby="intake-clients-h">
      <h2 id="intake-clients-h" class="heading">Who are we acting for?</h2>
      <mt-intake-contacts
        label="Clients"
        empty="No clients yet. Find one below, or create a new contact."
        [people]="clients()"
        (removed)="remove($event)"
      />
      @if (store.error('clientContactIds'); as message) {
        <p class="mt-error" role="alert"><mt-icon name="alert" [size]="14" />{{ message }}</p>
      }
      <mt-intake-contact-picker
        label="Find a client"
        createLabel="New client…"
        [exclude]="store.state().clientContactIds"
        (picked)="add($event)"
      />
    </section>

    <section class="mt-col" style="gap: var(--space-12)" aria-labelledby="intake-referral-h">
      <h3 id="intake-referral-h" class="label">How did they find us?</h3>
      @if (referrer(); as chosen) {
        <mt-intake-contacts label="Referred by" [people]="[chosen]" (removed)="clearReferrer()" />
      } @else {
        <mt-intake-contact-picker
          label="Referred by"
          createLabel="New referrer…"
          [referrersFirst]="true"
          [exclude]="store.state().clientContactIds"
          (picked)="refer($event)"
        />
        <mt-select
          label="Or the source"
          [native]="true"
          [options]="sources"
          [ngModel]="store.state().referral.source ?? ''"
          (ngModelChange)="setSource($event)"
        />
      }
    </section>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-24);
    }
  `,
})
export class IntakeClientsStep {
  protected readonly store = inject(IntakeStore);
  protected readonly sources = SOURCE_OPTIONS;
  protected readonly clients = computed(() =>
    this.store.state().clientContactIds.map((id) => ({ id, name: this.store.name(id) })),
  );
  protected readonly referrer = computed(() => {
    const id = this.store.state().referral.referrerContactId;
    return id ? { id, name: this.store.name(id), note: 'Referrer' } : null;
  });

  protected add(picked: PickedContact): void {
    this.store.remember(picked.id, picked.contact);
    this.store.update((s) =>
      s.clientContactIds.includes(picked.id) ? s : { ...s, clientContactIds: [...s.clientContactIds, picked.id] },
    );
  }

  protected remove(id: string): void {
    this.store.update((s) => ({ ...s, clientContactIds: s.clientContactIds.filter((c) => c !== id) }));
  }

  /** A referrer replaces any source: a matter records one or the other. */
  protected refer(picked: PickedContact): void {
    this.store.remember(picked.id, picked.contact);
    this.store.update((s) => ({ ...s, referral: { referrerContactId: picked.id, source: null } }));
  }

  protected clearReferrer(): void {
    this.store.update((s) => ({ ...s, referral: { ...s.referral, referrerContactId: null } }));
  }

  protected setSource(value: string | null): void {
    const parsed = ReferralSourceSchema.safeParse(value);
    this.store.update((s) => ({
      ...s,
      referral: { referrerContactId: null, source: parsed.success ? parsed.data : null },
    }));
  }
}
