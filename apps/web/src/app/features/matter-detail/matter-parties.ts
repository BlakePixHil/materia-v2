import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
  ViewEncapsulation,
} from '@angular/core';

import {
  contactsRepository,
  forMatter,
  MATTER_PARTIES_QUERY,
  matterPartiesRepository,
  type MatterParty,
  type WithId,
} from '@materia/data-access/repository';
import { contactDisplayName, type PartyResult } from '@materia/domain';
import { DialogService, MtButton, MtEmptyState, MtIconButton, MtNote, ToastService } from '@materia/ui';

import { MatterScreen } from './matter-screen';
import { groupParties, partyRoleLabel } from './matter-view';
import { PartyDialog, type PartyDialogData } from './party-dialog';
import { errorCopy } from '../../core/error-copy';

type PartyRow = WithId<MatterParty>;

/**
 * A matter's Parties tab (CORE-06): everyone on the matter, grouped by role. Adding, editing (role,
 * share) and removing (soft) go through the `matters-*Party` callables; the server keeps the
 * matter's clients in step and refuses to remove the last one (`LAST_CLIENT`). Listens to the
 * matter's parties only while this tab is shown.
 */
@Component({
  selector: 'mt-matter-parties',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/card.css'],
  imports: [MtButton, MtEmptyState, MtIconButton, MtNote],
  host: { class: 'mt-matter-parties' },
  template: `
    <div class="mt-row head">
      <h2 class="title-m">Parties</h2>
      @if (screen.editable()) {
        <button mtButton class="mt-ml" variant="primary" size="sm" iconStart="plus" kbd="p" (click)="add()">
          Add party
        </button>
      }
    </div>
    @switch (parties.status()) {
      @case ('loading') {
        <p class="caption t-3" role="status">Loading parties…</p>
      }
      @case ('error') {
        <mt-note tone="danger">
          {{ loadError() }}
          <button mtButton size="sm" (click)="parties.refresh()">Try again</button>
        </mt-note>
      }
      @default {
        @for (group of groups(); track group.role) {
          <section class="mt-card" data-pad [attr.aria-labelledby]="'mt-party-' + group.role">
            <h3 class="mt-card-title" [id]="'mt-party-' + group.role">
              {{ group.label }} <span class="caption t-3">{{ group.parties.length }}</span>
            </h3>
            <ul class="rows">
              @for (party of group.parties; track party.id) {
                <li>
                  <span class="mt-grow name">{{ name(party.contactId) }}</span>
                  @if (party.share) {
                    <span class="caption t-2">Share: {{ party.share }}</span>
                  }
                  @if (screen.editable()) {
                    <button
                      mtIconButton
                      icon="compose"
                      size="sm"
                      [label]="'Edit ' + name(party.contactId) + ' (' + group.label + ')'"
                      (click)="edit(party)"
                    ></button>
                    <button
                      mtIconButton
                      icon="trash"
                      size="sm"
                      [label]="'Remove ' + name(party.contactId) + ' (' + group.label + ')'"
                      (click)="remove(party)"
                    ></button>
                  }
                </li>
              }
            </ul>
          </section>
        } @empty {
          <mt-empty-state
            icon="contacts"
            title="No parties yet"
            description="Add the clients, the deceased, executors, beneficiaries and anyone else on the matter."
          />
        }
      }
    }
  `,
  styles: `
    .mt-matter-parties {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      max-width: 880px;
    }
    .mt-matter-parties .head {
      align-items: center;
    }
    .mt-matter-parties h2,
    .mt-matter-parties h3 {
      margin: 0;
    }
    .mt-matter-parties .rows {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
    }
    .mt-matter-parties .rows li {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      min-height: 32px;
      font: 400 13px/18px var(--font-sans);
    }
  `,
})
export class MatterParties {
  protected readonly screen = inject(MatterScreen);
  private readonly dialogs = inject(DialogService);
  private readonly toasts = inject(ToastService);
  private readonly contacts = contactsRepository();
  private readonly id = this.screen.id;

  protected readonly parties = matterPartiesRepository(this.id).watchQuery(forMatter(this.id, MATTER_PARTIES_QUERY));
  protected readonly loadError = computed(() => errorCopy(this.parties.error()));
  private readonly names = signal<ReadonlyMap<string, string>>(new Map());
  private readonly requested = new Set<string>();
  protected readonly groups = computed(() => groupParties(this.parties.value(), (id) => this.name(id)));
  private dialogOpen = false;

  constructor() {
    // Contact names, read once per contact.
    effect(() => {
      const ids = [...new Set(this.parties.value().map((party) => party.contactId))].filter(
        (id) => !this.requested.has(id),
      );
      if (!ids.length) return;
      ids.forEach((id) => this.requested.add(id));
      untracked(() => void this.loadNames(ids));
    });
    // "Add party" from the `p` shortcut (registered by the matter layout).
    let seen = untracked(this.screen.addPartyRequest);
    effect(() => {
      const request = this.screen.addPartyRequest();
      if (request === seen) return;
      seen = request;
      untracked(() => void this.add());
    });
  }

  protected name(contactId: string): string {
    return this.names().get(contactId) ?? '…';
  }

  private async loadNames(ids: string[]): Promise<void> {
    const found = await Promise.all(ids.map((id) => this.contacts.get(id).catch(() => null)));
    this.names.update((map) => {
      const next = new Map(map);
      found.forEach((contact, i) =>
        next.set(ids[i] as string, contact ? contactDisplayName(contact) : 'Unknown contact'),
      );
      return next;
    });
  }

  private async open(data: Omit<PartyDialogData, 'api' | 'matterId'>): Promise<PartyResult | undefined> {
    const matterId = this.id();
    if (!matterId || !this.screen.editable() || this.dialogOpen) return undefined;
    this.dialogOpen = true;
    try {
      return await this.dialogs.open<PartyDialogData, PartyResult | undefined>(PartyDialog, {
        data: { ...data, matterId, api: this.screen.api },
      }).result;
    } finally {
      this.dialogOpen = false;
    }
  }

  async add(): Promise<void> {
    const result = await this.open({});
    if (result) this.toasts.show({ title: 'Party added', tone: 'success' });
  }

  protected async edit(party: PartyRow): Promise<void> {
    const result = await this.open({
      party: {
        id: party.id,
        contactId: party.contactId,
        role: party.role,
        share: party.share,
        name: this.name(party.contactId),
      },
    });
    if (result) this.toasts.show({ title: 'Party updated', tone: 'success' });
  }

  protected async remove(party: PartyRow): Promise<void> {
    const matterId = this.id();
    if (!matterId || !this.screen.editable()) return;
    const who = `${this.name(party.contactId)} (${partyRoleLabel(party.role)})`;
    const confirmed = await this.dialogs.confirm({
      title: `Remove ${who}?`,
      body: 'They stay in your contacts; only their role on this matter goes.',
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await this.screen.api.removeParty({ matterId, partyId: party.id });
      this.toasts.show({ title: `Removed ${who}`, tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'Couldn’t remove the party', description: errorCopy(error), tone: 'danger' });
    }
  }
}
