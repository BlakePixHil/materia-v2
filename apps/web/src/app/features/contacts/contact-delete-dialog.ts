import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ContactReference, DeleteContactResult } from '@materia/domain';
import { DomainError } from '@materia/domain';
import { injectDialogRef, MtButton, MtDialog, MtNote } from '@materia/ui';

import { partyRoleLabel } from './contact-form';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';

export interface ContactDeleteDialogData {
  contactId: string;
  name: string;
}

/**
 * The matters a refused delete names. The `contacts-delete` callable refuses while matters still
 * reference the contact: `FAILED_PRECONDITION` with details `{ reason: 'contact_referenced', references }`
 * (`ContactReference[]`, at most 20). A safe-custody packet has role `safe_custody`, no matterId
 * and its packet number as `matterTitle`.
 */
export function refusingReferences(error: unknown): ContactReference[] | null {
  if (!(error instanceof DomainError)) return null;
  const details = error.details as Record<string, unknown> | undefined;
  const list = details?.['references'];
  if (!Array.isArray(list)) return null;
  return list.filter(
    (item): item is ContactReference =>
      !!item && typeof item === 'object' && typeof (item as ContactReference).role === 'string',
  );
}

/** Soft-deletes a contact through `contacts-delete`, or lists the matters that stop it. */
@Component({
  selector: 'mt-contact-delete-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MtButton, MtDialog, MtNote],
  template: `
    <mt-dialog
      size="sm"
      role="alertdialog"
      [title]="'Delete ' + data.name + '?'"
      [description]="
        references() ? undefined : 'They’ll be removed from your contacts. Their history stays in the audit log.'
      "
    >
      @if (references(); as list) {
        <mt-note tone="warning">
          {{ data.name }} is still used {{ list.length === 1 ? 'in one place' : 'in ' + list.length + ' places' }}, so
          they can’t be deleted. Remove them there first, or merge them into another contact.
        </mt-note>
        <ul class="mt-contact-refs" aria-label="Where this contact is used">
          @for (ref of list; track $index) {
            <li>
              @if (ref.matterId) {
                <a [routerLink]="['/matters', ref.matterId]" (click)="close()">{{ ref.matterTitle }}</a>
              } @else if (ref.role === 'safe_custody') {
                <span>Safe custody packet {{ ref.matterTitle }}</span>
              } @else {
                <span>{{ ref.matterTitle }}</span>
              }
              <span class="caption">{{ roleLabel(ref.role) }}</span>
            </li>
          }
        </ul>
      }
      @if (error(); as message) {
        <mt-note tone="danger">{{ message }}</mt-note>
      }
      <ng-container mtDialogFooter>
        @if (references()) {
          <button mtButton variant="primary" (click)="close()">Close</button>
        } @else {
          <button mtButton variant="ghost" (click)="close()">Cancel</button>
          <button mtButton variant="danger" [loading]="remove.pending()" (click)="confirm()">Delete contact</button>
        }
      </ng-container>
    </mt-dialog>
  `,
  styles: `
    .mt-contact-refs {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--space-2, 8px);
    }
    .mt-contact-refs li {
      display: flex;
      justify-content: space-between;
      gap: var(--space-3, 12px);
    }
    .mt-contact-refs .caption {
      color: var(--text-secondary);
    }
  `,
})
export class ContactDeleteDialog {
  protected readonly ref = injectDialogRef<ContactDeleteDialogData, boolean>();
  protected readonly data = this.ref.data;
  protected readonly remove = inject(CALLABLES).action<{ contactId: string }, DeleteContactResult>('contacts-delete');
  protected readonly references = signal<ContactReference[] | null>(null);
  protected readonly error = signal<string | null>(null);

  protected roleLabel(role: string): string {
    return partyRoleLabel(role);
  }

  protected close(deleted = false): void {
    void this.ref.close(deleted);
  }

  protected async confirm(): Promise<void> {
    this.error.set(null);
    try {
      await this.remove.run({ contactId: this.data.contactId });
      this.close(true);
    } catch (error) {
      const references = refusingReferences(error);
      if (references?.length) {
        this.references.set(references);
        // A refused delete is final for this attempt; the next one is a new request.
        this.remove.reset();
      } else {
        this.error.set(errorCopy(error));
      }
    }
  }
}
