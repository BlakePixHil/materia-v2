import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { MtIcon } from '@materia/ui';

import { IntakeContactPicker, type PickedContact } from './contact-picker';
import { IntakeContacts } from './intake-contacts';
import { IntakeStore } from './intake-store';

/** Step 2: the client or clients, found among the contacts or created (with the duplicate check). */
@Component({
  selector: 'mt-intake-clients-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IntakeContactPicker, IntakeContacts, MtIcon],
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
  `,
})
export class IntakeClientsStep {
  protected readonly store = inject(IntakeStore);
  protected readonly clients = computed(() =>
    this.store.state().clientContactIds.map((id) => ({ id, name: this.store.name(id) })),
  );

  protected add(picked: PickedContact): void {
    this.store.remember(picked.id, picked.contact);
    this.store.update((s) =>
      s.clientContactIds.includes(picked.id) ? s : { ...s, clientContactIds: [...s.clientContactIds, picked.id] },
    );
  }

  protected remove(id: string): void {
    this.store.update((s) => ({ ...s, clientContactIds: s.clientContactIds.filter((c) => c !== id) }));
  }
}
