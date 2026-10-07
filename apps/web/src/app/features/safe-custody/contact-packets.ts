import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import { contactPacketsQuery, safeCustodyRepository } from '@materia/data-access/repository';
import { locationLabel, SAFE_CUSTODY_STATUS_LABELS } from '@materia/domain';
import { DialogService, MtBadge, MtButton } from '@materia/ui';

import type { PacketDialogData, PacketDialogResult } from './packet-dialog';
import { STATUS_TONES } from './safe-custody-view';

/**
 * A testator's packets on their contact screen (CORE-17): each original will packet the firm holds
 * for them, with its status and place, and "Receive a will" to start one.
 */
@Component({
  selector: 'mt-contact-packets',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MtBadge, MtButton],
  template: `
    <h3 id="contact-packets-h">
      Safe custody
      <span class="mt-contact-count">{{ rows().length }}</span>
    </h3>
    @if (packets.status() === 'loading') {
      <p role="status" class="mt-contact-muted">Loading packets…</p>
    } @else {
      <ul class="mt-contact-packets">
        @for (packet of rows(); track packet.id) {
          <li>
            <span class="mono-s mt-contact-muted">{{ packet.packetNo }}</span>
            <div class="mt-col mt-grow" style="gap: 2px; min-width: 0">
              <a class="label" [routerLink]="['/safe-custody', packet.id]">{{ where(packet) }}</a>
            </div>
            <mt-badge [tone]="tones[packet.status]">{{ labels[packet.status] }}</mt-badge>
          </li>
        } @empty {
          <li class="mt-contact-muted">No originals held for them.</li>
        }
      </ul>
    }
    @if (canEdit() && person()) {
      <button mtButton size="sm" variant="ghost" iconStart="plus" (click)="receive()">Receive a will</button>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
    }
    h3 {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      margin: 0;
      font: 600 13px/18px var(--font-sans);
      color: var(--text-primary);
    }
    .mt-contact-count {
      font: 400 12px/16px var(--font-mono);
      color: var(--text-tertiary);
    }
    .mt-contact-muted {
      margin: 0;
      color: var(--text-tertiary);
    }
    .mt-contact-packets {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
    }
    .mt-contact-packets li {
      display: flex;
      gap: var(--space-12);
      align-items: baseline;
      padding: var(--space-8) 0;
      border-top: 1px solid var(--border-subtle);
    }
    .mt-contact-packets li:first-child {
      border-top: 0;
    }
    .mt-contact-packets a {
      color: var(--text-primary);
    }
  `,
})
export class ContactPackets {
  readonly contactId = input.required<string>();
  readonly name = input.required<string>();
  /** Only people make wills. */
  readonly person = input(true);

  private readonly dialogs = inject(DialogService);
  private readonly router = inject(Router);
  protected readonly canEdit = can('safeCustody.edit');
  protected readonly tones = STATUS_TONES;
  protected readonly labels = SAFE_CUSTODY_STATUS_LABELS;
  protected readonly packets = safeCustodyRepository().watchQuery(() => contactPacketsQuery(this.contactId()));
  protected readonly rows = computed(() =>
    this.packets
      .value()
      .filter((row) => !row.deletedAt)
      .sort((a, b) => b.packetNo.localeCompare(a.packetNo)),
  );

  protected where(packet: { location: { site: string; cabinet: string; slot: string }; status: string }): string {
    return packet.status === 'held' || packet.status === 'out' ? locationLabel(packet.location) : 'No longer held';
  }

  protected async receive(): Promise<void> {
    const { PacketDialog } = await import('./packet-dialog');
    const result = await this.dialogs.open<PacketDialogData, PacketDialogResult>(PacketDialog, {
      data: { testator: { id: this.contactId(), name: this.name(), person: this.person() } },
    }).result;
    if (result) void this.router.navigate(['/safe-custody', result.id]);
  }
}
