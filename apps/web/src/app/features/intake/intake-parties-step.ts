import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { PartyRole } from '@materia/domain';
import { MtIcon, MtIconButton, MtSelect, MtTextField } from '@materia/ui';

import { IntakeContactPicker, type PickedContact } from './contact-picker';
import { derivedParties, INTAKE_STEP_TITLES } from './intake-state';
import { IntakeStore } from './intake-store';
import { roleName, SUBJECT_ROLE_OPTIONS } from '../conflicts/conflict-view';

/** Roles a party added here can have (the matter's own roles come from earlier steps). */
const ROLE_OPTIONS = SUBJECT_ROLE_OPTIONS.filter((option) => option.value !== 'client' && option.value !== 'deceased');

/**
 * Step 4: everyone else on the matter (executors, beneficiaries, attorneys…) with their role and,
 * for beneficiaries, their share. The clients, the deceased, the testator, the other side and the
 * trustees are listed from earlier steps; a grant's clients start as its executors or administrators.
 */
@Component({
  selector: 'mt-intake-parties-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, IntakeContactPicker, MtIcon, MtIconButton, MtSelect, MtTextField],
  template: `
    <section class="mt-col block" aria-labelledby="intake-known-h">
      <h2 id="intake-known-h" class="heading">From earlier steps</h2>
      <ul class="rows" aria-label="Parties from earlier steps">
        @for (row of known(); track row.role + row.contactId) {
          <li>
            <span class="label mt-grow">{{ row.name }}</span>
            <span class="caption t-2">{{ row.roleLabel }}</span>
            <span class="caption t-3">from {{ row.from }}</span>
          </li>
        } @empty {
          <li class="caption t-3">No one yet.</li>
        }
      </ul>
    </section>
    <section class="mt-col block" aria-labelledby="intake-parties-h">
      <h2 id="intake-parties-h" class="heading">Other parties</h2>
      @if (store.state().parties.length) {
        <ul class="rows" aria-label="Other parties">
          @for (party of store.state().parties; track $index; let i = $index) {
            <li class="party" [attr.data-party]="party.role + '|' + party.contactId">
              <span class="label name">{{ store.name(party.contactId) }}</span>
              <mt-select
                class="role"
                [label]="'Role of ' + store.name(party.contactId)"
                [native]="true"
                [options]="roles"
                [ngModel]="party.role"
                (ngModelChange)="set(i, { role: $event })"
              />
              @if (party.role === 'beneficiary') {
                <mt-text-field
                  class="share"
                  [label]="'Share of ' + store.name(party.contactId)"
                  placeholder="One half, residue…"
                  autocomplete="off"
                  [optional]="true"
                  [error]="store.error('parties.' + i + '.share')"
                  [ngModel]="party.share"
                  (ngModelChange)="set(i, { share: $event ?? '' })"
                />
              }
              <button
                mtIconButton
                class="remove"
                icon="trash"
                size="sm"
                type="button"
                [label]="'Remove ' + store.name(party.contactId)"
                (click)="remove(i)"
              ></button>
              @if (store.error('parties.' + i); as message) {
                <p class="mt-error row-error" role="alert"><mt-icon name="alert" [size]="14" />{{ message }}</p>
              }
            </li>
          }
        </ul>
      } @else {
        <p class="caption t-3">No other parties. Add executors, beneficiaries and others below, or skip this step.</p>
      }
      <mt-intake-contact-picker label="Find a party to add" createLabel="New party…" (picked)="add($event)" />
    </section>
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
    .block p {
      margin: 0;
    }
    .rows {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
    }
    .rows li {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-12);
      padding: var(--space-8) var(--space-12);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
    }
    .rows li.party {
      align-items: flex-end;
    }
    .party .name {
      flex: 1 1 160px;
      align-self: center;
    }
    .party .role {
      flex: 0 1 200px;
    }
    .party .share {
      flex: 1 1 180px;
    }
    .row-error {
      flex-basis: 100%;
      margin: 0;
    }
  `,
})
export class IntakePartiesStep {
  protected readonly store = inject(IntakeStore);
  protected readonly roles = ROLE_OPTIONS;

  protected readonly known = computed(() => {
    const state = this.store.state();
    return derivedParties(state).map((row) => ({
      ...row,
      name: this.store.name(row.contactId),
      roleLabel: roleName(row.role),
      from: INTAKE_STEP_TITLES[row.from].toLowerCase(),
    }));
  });

  protected add(picked: PickedContact): void {
    this.store.remember(picked.id, picked.contact);
    this.store.update((s) => ({
      ...s,
      parties: [...s.parties, { contactId: picked.id, role: 'beneficiary' as PartyRole, share: '' }],
    }));
  }

  protected set(index: number, patch: { role?: PartyRole; share?: string }): void {
    this.store.update((s) => ({ ...s, parties: s.parties.map((p, i) => (i === index ? { ...p, ...patch } : p)) }));
  }

  protected remove(index: number): void {
    this.store.update((s) => ({ ...s, parties: s.parties.filter((_, i) => i !== index) }));
  }
}
