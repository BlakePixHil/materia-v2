import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { can } from '@materia/data-access';
import { safeCustodyCallables, type PacketItem, type WithId } from '@materia/data-access/repository';
import {
  needsAuthority,
  SAFE_CUSTODY_REAUTH_MINUTES,
  type RecordableMovement,
  type RecordMovementInput,
  type RecordMovementResult,
} from '@materia/domain';
import { injectDialogRef, MtButton, MtDialog, MtNote, MtSelect, MtTextarea, MtTextField } from '@materia/ui';

import { contactMatterOptions, matterDocumentOptions, SafeCustodyContactPicker, type ChosenContact } from './pickers';
import { safeCustodyErrorCopy } from './safe-custody-view';
import { injectRecentLogin } from '../../core/auth/reauth-dialog';
import { CALLABLES } from '../../core/data/callables';

export interface MovementDialogData {
  packet: WithId<PacketItem>;
  kind: RecordableMovement;
}

const COPY: Record<RecordableMovement, { title: string; action: string; reason: string; hint: string }> = {
  out: {
    title: 'Take out',
    action: 'Record taken out',
    reason: 'Why it’s out',
    hint: 'For example “Signing a codicil” or “Copy for the client”.',
  },
  returned: {
    title: 'Return to the safe',
    action: 'Record returned',
    reason: 'Note',
    hint: 'Anything to note about its return.',
  },
  released: {
    title: 'Release the original',
    action: 'Release',
    reason: 'Why it’s released',
    hint: 'For example “Executor’s request after death” or “Testator uplifted it”.',
  },
  destroyed: {
    title: 'Destroy the original',
    action: 'Ask for confirmation',
    reason: 'Why it’s destroyed',
    hint: 'A second lawyer confirms before it’s recorded as destroyed.',
  },
};

/**
 * Records a packet movement (CORE-17): out (to whom), returned (optionally to a new place),
 * released (to whom, on which authority document) or destroyed (on which authority, confirmed by a
 * second lawyer). Releases and destructions ask the person to sign in again when their sign-in is
 * older than five minutes. Closes with the callable's result.
 */
@Component({
  selector: 'mt-sc-movement-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MtButton, MtDialog, MtNote, MtSelect, MtTextarea, MtTextField, SafeCustodyContactPicker],
  template: `
    <mt-dialog
      [title]="copy.title + ' ' + packet.packetNo"
      [description]="packet.testatorName"
      [role]="kind === 'destroyed' ? 'alertdialog' : 'dialog'"
      [closeOnOutsideClick]="false"
    >
      <form id="mt-sc-move-form" class="mt-col" style="gap: var(--space-16)" (submit)="$event.preventDefault(); save()">
        @if (kind === 'out') {
          <mt-text-field
            name="to"
            label="Who has it"
            placeholder="Jordan Price, for signing"
            [error]="errors()['to']"
            [ngModel]="to()"
            (ngModelChange)="to.set($event ?? '')"
          />
        }
        @if (kind === 'released') {
          <mt-sc-contact-picker label="Released to" [chosen]="recipient()" (picked)="recipient.set($event)" />
          @if (!recipient()) {
            <mt-text-field
              name="to"
              label="Or name them"
              description="When they aren’t a contact: “Harbour Legal, the executor’s solicitors”."
              [optional]="true"
              [error]="errors()['to']"
              [ngModel]="to()"
              (ngModelChange)="to.set($event ?? '')"
            />
          }
        }
        @if (authorityNeeded) {
          <fieldset class="mt-sc-fieldset">
            <legend class="label">Authority</legend>
            <p class="caption t-3">
              The signed authority, death certificate with the executor’s ID, or court order. Upload it to the
              testator’s matter first.
            </p>
            @if (matterOptions().length) {
              <mt-select
                name="authorityMatter"
                label="Matter"
                [native]="true"
                [options]="matterOptions()"
                [ngModel]="authorityMatter()"
                (ngModelChange)="authorityMatter.set($event ?? ''); authorityDocument.set('')"
              />
              @if (authorityMatter()) {
                @if (documents.loading()) {
                  <p class="caption t-3" role="status">Loading documents…</p>
                } @else if (documentOptions().length > 1) {
                  <mt-select
                    name="authorityDocument"
                    label="Document"
                    [native]="true"
                    [options]="documentOptions()"
                    [error]="errors()['authority']"
                    [ngModel]="authorityDocument()"
                    (ngModelChange)="authorityDocument.set($event ?? '')"
                  />
                } @else {
                  <mt-note tone="warning"
                    >That matter has no scanned documents yet. Upload the authority to it first.</mt-note
                  >
                }
              } @else if (errors()['authority']; as message) {
                <p class="caption" style="color: var(--text-danger)">{{ message }}</p>
              }
            } @else {
              <mt-note tone="warning">
                The testator isn’t on any matter you can open. Open a matter for them and upload the authority there.
              </mt-note>
            }
          </fieldset>
        }
        @if (kind === 'returned') {
          <fieldset class="mt-sc-fieldset mt-sc-location">
            <legend class="label">Put back at</legend>
            <mt-text-field name="site" label="Site" [ngModel]="site()" (ngModelChange)="site.set($event ?? '')" />
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
        }
        <mt-textarea
          name="reason"
          [label]="copy.reason"
          [description]="copy.hint"
          [rows]="2"
          [error]="errors()['reason']"
          [ngModel]="reason()"
          (ngModelChange)="reason.set($event ?? '')"
        />
        @if (authorityNeeded && !mayRelease()) {
          <mt-note tone="warning"
            >Only a lawyer, admin or owner can {{ kind === 'released' ? 'release' : 'destroy' }} an original.</mt-note
          >
        }
        @if (error(); as message) {
          <mt-note tone="danger">{{ message }}</mt-note>
        }
      </form>
      <ng-container mtDialogFooter>
        <button mtButton variant="ghost" (click)="ref.close()">Cancel</button>
        <button
          mtButton
          [variant]="kind === 'destroyed' ? 'danger' : 'primary'"
          type="submit"
          form="mt-sc-move-form"
          [disabled]="authorityNeeded && !mayRelease()"
          [loading]="saving()"
        >
          {{ copy.action }}
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
    .mt-sc-fieldset p {
      margin: 0;
    }
    .mt-sc-location {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    }
    .mt-sc-location legend {
      grid-column: 1 / -1;
    }
  `,
})
export class MovementDialog {
  protected readonly ref = injectDialogRef<MovementDialogData, RecordMovementResult | undefined>();
  protected readonly packet = this.ref.data.packet;
  protected readonly kind = this.ref.data.kind;
  protected readonly copy = COPY[this.kind];
  protected readonly authorityNeeded = needsAuthority(this.kind);
  protected readonly mayRelease = can('safeCustody.release');
  private readonly api = safeCustodyCallables(inject(CALLABLES));
  private readonly recentLogin = injectRecentLogin(SAFE_CUSTODY_REAUTH_MINUTES);

  protected readonly to = signal('');
  protected readonly recipient = signal<ChosenContact | null>(null);
  protected readonly reason = signal('');
  protected readonly site = signal(this.packet.location.site);
  protected readonly cabinet = signal(this.packet.location.cabinet);
  protected readonly slot = signal(this.packet.location.slot);
  protected readonly authorityMatter = signal(this.packet.matterId ?? '');
  protected readonly authorityDocument = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly errors = signal<Record<string, string>>({});

  private readonly matters = contactMatterOptions(
    signal(this.authorityNeeded ? this.packet.testatorContactId : null),
    signal(this.packet.matterId),
  );
  protected readonly matterOptions = computed(() => {
    const options = this.matters();
    return options.length ? [{ value: '', label: 'Choose a matter' }, ...options] : [];
  });
  protected readonly documents = matterDocumentOptions(
    computed(() => this.authorityMatter() || null),
    can('privileged.view'),
  );
  protected readonly documentOptions = computed(() => [
    { value: '', label: 'Choose the authority document' },
    ...this.documents.options(),
  ]);

  /** The form as callable input, or null with the field errors set. */
  private read(): Omit<RecordMovementInput, 'requestId'> | null {
    const errors: Record<string, string> = {};
    const reason = this.reason().trim();
    const to = this.to().trim();
    if (!reason) errors['reason'] = this.kind === 'returned' ? 'Add a short note.' : 'Say why.';
    if (this.kind === 'out' && !to) errors['to'] = 'Say who has it.';
    if (this.kind === 'released' && !to && !this.recipient()) errors['to'] = 'Choose or name who receives it.';
    if (this.authorityNeeded && !this.authorityDocument()) errors['authority'] = 'Choose the authority document.';
    if (this.kind === 'returned' && !this.site().trim()) errors['reason'] ??= 'Say which site it’s back at.';
    this.errors.set(errors);
    if (Object.keys(errors).length) return null;
    const location = { site: this.site().trim(), cabinet: this.cabinet().trim(), slot: this.slot().trim() };
    const moved =
      location.site !== this.packet.location.site ||
      location.cabinet !== this.packet.location.cabinet ||
      location.slot !== this.packet.location.slot;
    const recipient = this.recipient();
    return {
      id: this.packet.id,
      kind: this.kind,
      reason,
      ...(this.kind === 'released' && recipient ? { toContactId: recipient.id, to: recipient.name } : to ? { to } : {}),
      ...(this.authorityNeeded
        ? { authority: { matterId: this.authorityMatter(), documentId: this.authorityDocument() } }
        : {}),
      ...(this.kind === 'returned' && moved ? { location } : {}),
    };
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    const input = this.read();
    if (!input) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const run = () => this.api.recordMovement(input);
      const result = this.authorityNeeded
        ? await this.recentLogin(
            `${this.kind === 'released' ? 'Releasing' : 'Destroying'} an original will needs a fresh sign-in.`,
            run,
          )
        : await run();
      if (result) void this.ref.close(result);
    } catch (error) {
      this.error.set(safeCustodyErrorCopy(error));
    } finally {
      this.saving.set(false);
    }
  }
}
