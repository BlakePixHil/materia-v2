import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  MEMBER_LIST_QUERY,
  membersRepository,
  safeCustodyCallables,
  type PacketItem,
  type WithId,
} from '@materia/data-access/repository';
import {
  SAFE_CUSTODY_RELEASE_ROLES,
  type SafeCustodyItem,
  type SafeCustodyItemKind,
  type SafeCustodyLocation,
} from '@materia/domain';
import {
  injectDialogRef,
  MT_TODAY,
  MtButton,
  MtDialog,
  MtIconButton,
  MtNote,
  MtSelect,
  MtTextarea,
  MtTextField,
  type MtOption,
} from '@materia/ui';

import { contactMatterOptions, SafeCustodyContactPicker, type ChosenContact } from './pickers';
import { ITEM_KIND_OPTIONS, safeCustodyErrorCopy } from './safe-custody-view';
import { AuthState } from '../../core/auth/auth-state';
import { CALLABLES } from '../../core/data/callables';
import { formatDateInput, parseDateInput } from '../contacts/contact-form';

export interface PacketDialogData {
  /** The packet to edit; absent to receive a new one. */
  packet?: WithId<PacketItem>;
  /** The testator to start with (receiving from their contact screen). */
  testator?: ChosenContact;
}

export interface PacketDialogResult {
  id: string;
  packetNo: string;
}

/** One original as the form holds it: the date as typed (DD/MM/YYYY). */
interface ItemRow {
  key: number;
  kind: SafeCustodyItemKind;
  date: string;
  description: string;
}

const NONE = '';

/**
 * Receive a will into safe custody, or change a packet (CORE-17): the testator (a person contact),
 * each original with its date, where it's kept, when it came in, the lawyer told when the testator
 * dies, and the will matter. Saves through `safeCustody-receive` or `safeCustody-update`.
 */
@Component({
  selector: 'mt-sc-packet-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MtButton,
    MtDialog,
    MtIconButton,
    MtNote,
    MtSelect,
    MtTextarea,
    MtTextField,
    SafeCustodyContactPicker,
  ],
  template: `
    <mt-dialog
      size="lg"
      [title]="packet ? 'Edit ' + packet.packetNo : 'Receive a will'"
      [description]="packet ? packet.testatorName : 'Record the originals the firm now holds.'"
      [closeOnOutsideClick]="false"
    >
      <form
        id="mt-sc-packet-form"
        class="mt-col"
        style="gap: var(--space-16)"
        (submit)="$event.preventDefault(); save()"
      >
        @if (!packet) {
          <mt-sc-contact-picker
            label="Testator"
            [chosen]="testator()"
            [error]="errors()['testator'] ?? null"
            (picked)="testator.set($event); matterId.set(none)"
          />
        }

        <fieldset class="mt-sc-fieldset">
          <legend class="label">Originals</legend>
          @for (item of items(); track item.key; let i = $index) {
            <div class="mt-sc-item" role="group" [attr.aria-label]="'Original ' + (i + 1)">
              <mt-select
                [name]="'kind-' + item.key"
                label="Document"
                [native]="true"
                [options]="kinds"
                [ngModel]="item.kind"
                (ngModelChange)="patchItem(item.key, { kind: $event })"
              />
              <mt-text-field
                [name]="'date-' + item.key"
                label="Dated"
                placeholder="DD/MM/YYYY"
                [optional]="true"
                [error]="errors()['item-' + item.key]"
                [ngModel]="item.date"
                (ngModelChange)="patchItem(item.key, { date: $event ?? '' })"
              />
              <mt-text-field
                [name]="'description-' + item.key"
                label="Description"
                [optional]="true"
                [ngModel]="item.description"
                (ngModelChange)="patchItem(item.key, { description: $event ?? '' })"
              />
              @if (items().length > 1) {
                <button
                  mtIconButton
                  type="button"
                  icon="trash"
                  [label]="'Remove original ' + (i + 1)"
                  (click)="removeItem(item.key)"
                ></button>
              }
            </div>
          }
          <button mtButton variant="ghost" size="sm" type="button" iconStart="plus" (click)="addItem()">
            Add another original
          </button>
        </fieldset>

        <fieldset class="mt-sc-fieldset mt-sc-location">
          <legend class="label">Kept at</legend>
          <mt-text-field
            name="site"
            label="Site"
            placeholder="Geelong office"
            [error]="errors()['site']"
            [ngModel]="site()"
            (ngModelChange)="site.set($event ?? '')"
          />
          <mt-text-field
            name="cabinet"
            label="Safe or cabinet"
            [optional]="true"
            [ngModel]="cabinet()"
            (ngModelChange)="cabinet.set($event ?? '')"
          />
          <mt-text-field
            name="slot"
            label="Slot or envelope"
            [optional]="true"
            [ngModel]="slot()"
            (ngModelChange)="slot.set($event ?? '')"
          />
        </fieldset>

        <div class="mt-sc-pair">
          @if (!packet) {
            <mt-text-field
              name="receivedOn"
              label="Received on"
              placeholder="DD/MM/YYYY"
              [error]="errors()['receivedOn']"
              [ngModel]="receivedOn()"
              (ngModelChange)="receivedOn.set($event ?? '')"
            />
          }
          <mt-select
            name="responsible"
            label="Responsible lawyer"
            description="Told when the testator dies."
            [native]="true"
            [options]="lawyers()"
            [ngModel]="responsibleUid()"
            (ngModelChange)="responsibleUid.set($event ?? '')"
          />
        </div>

        @if (matterOptions().length) {
          <mt-select
            name="matter"
            label="Will matter"
            [optional]="true"
            [native]="true"
            [options]="matterOptions()"
            [ngModel]="matterId()"
            (ngModelChange)="matterId.set($event ?? none)"
          />
        }

        <mt-textarea
          name="notes"
          label="Notes"
          [optional]="true"
          [rows]="2"
          [ngModel]="notes()"
          (ngModelChange)="notes.set($event ?? '')"
        />

        @if (error(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button mtButton variant="primary" type="submit" form="mt-sc-packet-form" [loading]="saving()">
          {{ packet ? 'Save' : 'Receive' }}
        </button>
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .mt-sc-fieldset {
      display: flex;
      flex-direction: column;
      gap: var(--space-8);
      margin: 0;
      padding: 0;
      border: 0;
      min-width: 0;
    }
    .mt-sc-fieldset legend {
      padding: 0 0 var(--space-4);
    }
    .mt-sc-item {
      display: grid;
      grid-template-columns: minmax(150px, 1fr) 130px minmax(140px, 2fr) auto;
      gap: var(--space-8);
      align-items: end;
    }
    .mt-sc-location,
    .mt-sc-pair {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: var(--space-8);
    }
    .mt-sc-location legend {
      grid-column: 1 / -1;
    }
    @media (max-width: 640px) {
      .mt-sc-item {
        grid-template-columns: 1fr 1fr;
      }
    }
  `,
})
export class PacketDialog {
  protected readonly ref = injectDialogRef<PacketDialogData, PacketDialogResult | undefined>();
  protected readonly packet = this.ref.data.packet;
  protected readonly none = NONE;
  protected readonly kinds = ITEM_KIND_OPTIONS;
  private readonly api = safeCustodyCallables(inject(CALLABLES));
  private readonly auth = inject(AuthState);
  private readonly today = inject(MT_TODAY);
  private nextKey = 0;

  protected readonly testator = signal<ChosenContact | null>(this.ref.data.testator ?? null);
  protected readonly items = signal<ItemRow[]>(
    this.packet?.items.length
      ? this.packet.items.map((item) => this.row(item))
      : [this.row({ kind: 'will', description: '' })],
  );
  protected readonly site = signal(this.packet?.location.site ?? '');
  protected readonly cabinet = signal(this.packet?.location.cabinet ?? '');
  protected readonly slot = signal(this.packet?.location.slot ?? '');
  protected readonly receivedOn = signal(formatDateInput(this.today()));
  protected readonly responsibleUid = signal(this.packet?.responsibleUid ?? '');
  protected readonly matterId = signal(this.packet?.matterId ?? NONE);
  protected readonly notes = signal(this.packet?.notes ?? '');
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly errors = signal<Record<string, string>>({});

  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 }, { live: false });
  /** Active owners, admins and lawyers, me first; the current choice stays listed. */
  protected readonly lawyers = computed<MtOption<string>[]>(() => {
    const current = this.responsibleUid();
    const me = this.auth.user()?.uid;
    return this.members
      .value()
      .filter(
        (member) =>
          member.id === current ||
          (member.status === 'active' && (SAFE_CUSTODY_RELEASE_ROLES as readonly string[]).includes(member.role)),
      )
      .sort((a, b) => Number(b.id === me) - Number(a.id === me))
      .map((member) => ({ value: member.id, label: member.displayName }));
  });
  private readonly testatorMatters = contactMatterOptions(
    computed(() => this.packet?.testatorContactId ?? this.testator()?.id ?? null),
    computed(() => this.packet?.matterId),
  );
  protected readonly matterOptions = computed<MtOption<string>[]>(() => {
    const options = this.testatorMatters();
    return options.length ? [{ value: NONE, label: 'None' }, ...options] : [];
  });

  private row(item: Partial<SafeCustodyItem> & Pick<SafeCustodyItem, 'kind'>): ItemRow {
    return {
      key: this.nextKey++,
      kind: item.kind,
      date: formatDateInput(item.date),
      description: item.description ?? '',
    };
  }

  protected patchItem(key: number, patch: Partial<ItemRow>): void {
    this.items.update((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  protected addItem(): void {
    this.items.update((rows) => [...rows, this.row({ kind: 'codicil', description: '' })]);
  }

  protected removeItem(key: number): void {
    this.items.update((rows) => rows.filter((row) => row.key !== key));
  }

  /** The form as callable input, or null with the field errors set. */
  private read(): { items: SafeCustodyItem[]; location: SafeCustodyLocation; receivedOn: string | null } | null {
    const errors: Record<string, string> = {};
    if (!this.packet) {
      const testator = this.testator();
      if (!testator) errors['testator'] = 'Choose the testator, or create them as a contact.';
      else if (!testator.person) errors['testator'] = 'A testator is a person, not an organisation.';
    }
    const items = this.items().map((row) => {
      const date = parseDateInput(row.date);
      if (row.date.trim() && !date) errors[`item-${row.key}`] = 'Enter a date like 14/02/2019.';
      return {
        kind: row.kind,
        description: row.description.trim(),
        ...(date ? { date } : {}),
      } as SafeCustodyItem;
    });
    if (!this.site().trim()) errors['site'] = 'Say which office or site holds it.';
    const receivedOn = this.packet ? null : parseDateInput(this.receivedOn());
    if (!this.packet && !receivedOn) errors['receivedOn'] = 'Enter the date it came in, like 05/10/2026.';
    this.errors.set(errors);
    if (Object.keys(errors).length) return null;
    return {
      items,
      location: { site: this.site().trim(), cabinet: this.cabinet().trim(), slot: this.slot().trim() },
      receivedOn,
    };
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    const form = this.read();
    if (!form) return;
    this.saving.set(true);
    this.error.set(null);
    const notes = this.notes().trim();
    const responsibleUid = this.responsibleUid() || this.lawyers()[0]?.value;
    try {
      if (this.packet) {
        await this.api.update({
          id: this.packet.id,
          items: form.items,
          location: form.location,
          ...(responsibleUid ? { responsibleUid } : {}),
          matterId: this.matterId() || null,
          notes,
        });
        void this.ref.close({ id: this.packet.id, packetNo: this.packet.packetNo });
      } else {
        const result = await this.api.receive({
          testatorContactId: this.testator()?.id ?? '',
          items: form.items,
          location: form.location,
          receivedOn: form.receivedOn ?? '',
          ...(responsibleUid ? { responsibleUid } : {}),
          ...(this.matterId() ? { matterId: this.matterId() } : {}),
          ...(notes ? { notes } : {}),
        });
        void this.ref.close(result);
      }
    } catch (error) {
      this.error.set(safeCustodyErrorCopy(error));
    } finally {
      this.saving.set(false);
    }
  }
}
