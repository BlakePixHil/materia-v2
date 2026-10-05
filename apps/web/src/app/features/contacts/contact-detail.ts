import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import {
  contactPartiesQuery,
  contactPartiesRepository,
  contactsRepository,
  matterSummariesRepository,
  referredMattersQuery,
  referredMattersRepository,
  type ContactListItem,
  type MatterSummary,
  type WithId,
} from '@materia/data-access/repository';
import {
  contactDisplayName,
  formatPhone,
  MATTER_STATUS_LABELS,
  referralTotals,
  REFERRER_INDUSTRY_LABELS,
} from '@materia/domain';
import {
  formatDateOnly,
  MATTER_TYPE_LABELS,
  MtBadge,
  MtButton,
  MtEmptyState,
  MtKeyFacts,
  MtNote,
  MtPersonHeader,
  type KeyFactVm,
  type PersonRoleVm,
} from '@materia/ui';

import { partyRoleLabel } from './contact-form';
import { errorCopy } from '../../core/error-copy';
import { ContactPackets } from '../safe-custody/contact-packets';

/** One matter the contact is on, with their role(s) there. */
export interface ContactMatterVm {
  matterId: string;
  number: string | null;
  title: string;
  roles: string;
}

/** A matter as the Matters list shows it: loaded, or not readable (privileged, deleted). */
type MatterLookup = (MatterSummary & { id: string }) | 'missing';

/**
 * The contact detail pane (CORE-01): PersonHeader with roles across matters, the deceased banner,
 * details, the "Matters" list (a collection-group query on `parties`), the original wills held in
 * safe custody (CORE-17) and activity. Edit, merge and delete are offered by permission; the page
 * opens the dialogs.
 */
@Component({
  selector: 'mt-contact-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ContactPackets, MtBadge, MtButton, MtEmptyState, MtKeyFacts, MtNote, MtPersonHeader],
  host: { class: 'mt-col mt-contact-detail' },
  template: `
    @switch (state()) {
      @case ('loading') {
        <p role="status" class="mt-contact-muted">Loading contact…</p>
      }
      @case ('error') {
        <mt-note tone="danger">{{ errorText() }}</mt-note>
      }
      @case ('missing') {
        <mt-empty-state
          title="This contact isn’t available"
          description="It may have been deleted, or merged into another contact."
          icon="contacts"
          [headingLevel]="2"
        />
      }
      @default {
        @if (contact(); as c) {
          @if (c.mergedInto; as keepId) {
            <mt-note>
              {{ name() }} was merged into another contact.
              <button mtButton size="sm" (click)="openContact.emit(keepId)">Open the contact kept</button>
            </mt-note>
          }
          <mt-person-header [name]="name()" [subtitle]="subtitle()" [colorKey]="c.id" [roles]="roles()">
            @if (c.dateOfDeath) {
              <mt-badge tone="neutral">Deceased</mt-badge>
            }
            @if (c.isReferrer) {
              <mt-badge tone="brand">Referrer</mt-badge>
            }
            @if (canEdit() && !c.mergedInto) {
              <button mtButton size="sm" variant="ghost" iconStart="compose" (click)="edit.emit(c)">Edit</button>
            }
            @if (canMerge() && !c.mergedInto) {
              <button mtButton size="sm" variant="ghost" iconStart="link" (click)="merge.emit(c)">Merge into…</button>
            }
            @if (canDelete() && !c.mergedInto) {
              <button mtButton size="sm" variant="ghost" iconStart="trash" (click)="remove.emit(c)">Delete</button>
            }
          </mt-person-header>

          @if (c.dateOfDeath; as died) {
            <mt-note tone="warning" data-testid="deceased-banner">
              {{ name() }} died on {{ date(died) }}.
              @if (canEdit()) {
                <a [routerLink]="['/matters/new']" [queryParams]="{ type: 'probate', deceased: c.id }">
                  Open a probate or administration matter
                </a>
              }
            </mt-note>
          }

          <div class="mt-contact-cards">
            <section class="mt-contact-card" aria-labelledby="contact-details-h">
              <h2 id="contact-details-h">Details</h2>
              @if (facts().length) {
                <mt-key-facts [facts]="facts()" />
              } @else {
                <p class="mt-contact-muted">No details yet.</p>
              }
            </section>

            <section class="mt-contact-card" aria-labelledby="contact-matters-h">
              <h2 id="contact-matters-h">
                Matters
                <span class="mt-contact-count">{{ matters().length }}</span>
              </h2>
              @switch (parties.status()) {
                @case ('loading') {
                  <p role="status" class="mt-contact-muted">Loading matters…</p>
                }
                @case ('error') {
                  <p class="mt-contact-muted">{{ partiesError() }}</p>
                }
                @default {
                  <ul class="mt-contact-matters">
                    @for (matter of matters(); track matter.matterId) {
                      <li>
                        @if (matter.number) {
                          <span class="mono-s mt-contact-muted">{{ matter.number }}</span>
                        }
                        <div class="mt-col mt-grow" style="gap: 2px; min-width: 0">
                          <a class="label" [routerLink]="['/matters', matter.matterId]">{{ matter.title }}</a>
                          <span class="caption mt-contact-muted">{{ matter.roles }}</span>
                        </div>
                      </li>
                    } @empty {
                      <li class="mt-contact-muted">Not on any matters yet.</li>
                    }
                  </ul>
                }
              }
            </section>

            @if (c.kind === 'person' && !c.mergedInto) {
              <section class="mt-contact-card" aria-labelledby="contact-packets-h">
                <mt-contact-packets [contactId]="c.id" [name]="name()" />
              </section>
            }

            @if (c.isReferrer || referred().length) {
              <section class="mt-contact-card" aria-labelledby="contact-referrals-h" data-testid="contact-referrals">
                <h2 id="contact-referrals-h">
                  Referrals
                  <span class="mt-contact-count">{{ totals().count }}</span>
                </h2>
                @switch (referrals.status()) {
                  @case ('loading') {
                    <p role="status" class="mt-contact-muted">Loading referrals…</p>
                  }
                  @case ('error') {
                    <p class="mt-contact-muted">{{ referralsError() }}</p>
                  }
                  @default {
                    @if (totals().count) {
                      <p class="caption mt-contact-muted" data-testid="referral-totals">{{ totalsText() }}</p>
                    }
                    <ul class="mt-contact-matters" aria-label="Matters referred">
                      @for (matter of referred(); track matter.id) {
                        <li>
                          <span class="mono-s mt-contact-muted">{{ matter.number }}</span>
                          <div class="mt-col mt-grow" style="gap: 2px; min-width: 0">
                            <a class="label" [routerLink]="['/matters', matter.id]">{{ matter.title }}</a>
                            <span class="caption mt-contact-muted">{{ matter.caption }}</span>
                          </div>
                        </li>
                      } @empty {
                        <li class="mt-contact-muted">No referred matters yet.</li>
                      }
                    </ul>
                  }
                }
              </section>
            }

            <section class="mt-contact-card" aria-labelledby="contact-activity-h">
              <h2 id="contact-activity-h">Activity</h2>
              <ul class="mt-contact-activity">
                @if (c.updatedAt && c.createdAt && c.updatedAt.getTime() !== c.createdAt.getTime()) {
                  <li>Details updated {{ date(c.updatedAt) }}</li>
                }
                @if (c.createdAt) {
                  <li>Added {{ date(c.createdAt) }}</li>
                }
              </ul>
              <p class="caption mt-contact-muted">Calls, emails and file notes will show here as they’re recorded.</p>
            </section>
          </div>
        }
      }
    }
  `,
  styles: `
    :host {
      gap: var(--space-16);
      min-width: 0;
    }
    .mt-contact-muted {
      margin: 0;
      color: var(--text-tertiary);
    }
    .mt-contact-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: var(--space-16);
      align-items: start;
    }
    .mt-contact-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-12);
      padding: var(--space-16);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg, 10px);
      background: var(--bg-surface);
      min-width: 0;
    }
    .mt-contact-card h2 {
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
    .mt-contact-matters,
    .mt-contact-activity {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
    }
    .mt-contact-matters li {
      display: flex;
      gap: var(--space-12);
      align-items: baseline;
      padding: var(--space-8) 0;
      border-top: 1px solid var(--border-subtle);
    }
    .mt-contact-matters li:first-child {
      border-top: 0;
    }
    .mt-contact-matters a {
      color: var(--text-primary);
    }
    .mt-contact-activity li {
      padding: var(--space-4) 0;
      font: 400 13px/18px var(--font-sans);
      color: var(--text-secondary);
    }
  `,
})
export class ContactDetail {
  readonly contactId = input.required<string>();
  /** Open another contact (the one kept after a merge). */
  readonly openContact = output<string>();
  readonly edit = output<WithId<ContactListItem>>();
  readonly merge = output<WithId<ContactListItem>>();
  readonly remove = output<WithId<ContactListItem>>();

  protected readonly canEdit = can('contact.edit');
  protected readonly canDelete = can('contact.delete');
  protected readonly canMerge = can('contact.merge');

  private readonly doc = contactsRepository().watch(() => this.contactId());
  protected readonly parties = contactPartiesRepository().watchQuery(() => contactPartiesQuery(this.contactId()));
  private readonly matterRepo = matterSummariesRepository();
  private readonly canSeePrivileged = can('privileged.view');
  /** Matters this contact referred (CORE-18): live, and privileged ones only for privileged.view. */
  protected readonly referrals = referredMattersRepository().watchQuery(() =>
    referredMattersQuery(this.contactId(), this.canSeePrivileged()),
  );
  protected readonly referralsError = computed(() => errorCopy(this.referrals.error()));
  protected readonly totals = computed(() => referralTotals(this.referrals.value()));
  protected readonly referred = computed(() =>
    this.referrals
      .value()
      .filter((m) => !m.deletedAt)
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
      .map((m) => ({
        id: m.id,
        number: m.number,
        title: m.title,
        caption: [
          MATTER_TYPE_LABELS[m.type],
          MATTER_STATUS_LABELS[m.status],
          m.createdAt ? `Opened ${formatDateOnly(m.createdAt)}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
  );
  /** "3 matters referred · 2 active · last on 5 Oct 2026" (billed fees join with BILL-07). */
  protected readonly totalsText = computed(() => {
    const { count, active, lastReferredAt } = this.totals();
    return [
      count === 1 ? '1 matter referred' : `${count} matters referred`,
      `${active} active`,
      lastReferredAt ? `last on ${formatDateOnly(lastReferredAt)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  });
  private readonly matterCache = signal<ReadonlyMap<string, MatterLookup>>(new Map());
  private readonly requested = new Set<string>();

  protected readonly contact = this.doc.value;
  protected readonly state = computed(() => {
    const status = this.doc.status();
    if (status === 'error') return 'error';
    if (!this.doc.exists() || this.contact()?.deletedAt) return 'missing';
    return this.contact() ? 'ready' : 'loading';
  });
  protected readonly errorText = computed(() => errorCopy(this.doc.error()));
  protected readonly partiesError = computed(() => errorCopy(this.parties.error()));
  protected readonly name = computed(() => {
    const contact = this.contact();
    return contact ? contactDisplayName(contact) : '';
  });
  protected readonly subtitle = computed(() => {
    const c = this.contact();
    if (!c) return '';
    if (c.kind === 'organisation')
      return ['Organisation', c.abn ? `ABN ${formatAbn(c.abn)}` : null].filter(Boolean).join(' · ');
    const place = c.addresses[0];
    const life = c.dateOfDeath
      ? `${c.dateOfBirth ? `${formatDateOnly(c.dateOfBirth)} – ` : 'Died '}${formatDateOnly(c.dateOfDeath)}`
      : c.dateOfBirth
        ? `Born ${formatDateOnly(c.dateOfBirth)}`
        : null;
    return [place ? `${place.suburb} ${place.state}` : null, life].filter(Boolean).join(' · ');
  });

  /** One row per matter, its roles joined ("Executor, beneficiary 50%"). */
  protected readonly matters = computed<ContactMatterVm[]>(() => {
    const cache = this.matterCache();
    const byMatter = new Map<string, string[]>();
    for (const party of this.parties.value()) {
      const label = partyRoleLabel(party.role) + (party.share ? ` ${party.share}` : '');
      byMatter.set(party.matterId, [...(byMatter.get(party.matterId) ?? []), label]);
    }
    return [...byMatter.entries()].flatMap(([matterId, roles]) => {
      const matter = cache.get(matterId);
      if (matter && matter !== 'missing' && matter.deletedAt) return [];
      return [
        {
          matterId,
          number: matter && matter !== 'missing' ? matter.number : null,
          title: matter === undefined ? 'Loading…' : matter === 'missing' ? 'A matter you can’t open' : matter.title,
          roles: roles.join(', '),
        },
      ];
    });
  });
  protected readonly roles = computed<PersonRoleVm[]>(() =>
    this.matters().flatMap((matter) =>
      matter.roles.split(', ').map((label) => ({ label, ...(matter.number ? { ref: matter.number } : {}) })),
    ),
  );

  protected readonly facts = computed<KeyFactVm[]>(() => {
    const c = this.contact();
    if (!c) return [];
    const facts: KeyFactVm[] = [];
    if (c.kind === 'organisation' && c.abn) facts.push({ id: 'abn', label: 'ABN', value: formatAbn(c.abn) });
    if (c.preferredName && c.givenNames) facts.push({ id: 'legal', label: 'Legal name', value: legalName(c) });
    c.phones.forEach((phone, i) =>
      facts.push({ id: `phone-${i}`, label: capitalise(phone.type), value: formatPhone(phone.number) }),
    );
    c.emails.forEach((email, i) =>
      facts.push({ id: `email-${i}`, label: i === 0 ? 'Email' : `Email (${email.type})`, value: email.address }),
    );
    c.addresses.forEach((address, i) =>
      facts.push({
        id: `address-${i}`,
        label: c.addresses.length > 1 ? `Address (${address.type})` : 'Address',
        value: [address.line1, address.line2, `${address.suburb} ${address.state} ${address.postcode}`]
          .filter(Boolean)
          .join(', '),
      }),
    );
    if (c.dateOfBirth) facts.push({ id: 'born', label: 'Born', value: formatDateOnly(c.dateOfBirth) });
    if (c.dateOfDeath) facts.push({ id: 'died', label: 'Died', value: formatDateOnly(c.dateOfDeath) });
    if (c.isReferrer) {
      const industry = c.referrerMeta?.industry;
      const meta = [industry ? REFERRER_INDUSTRY_LABELS[industry] : null, c.referrerMeta?.company]
        .filter(Boolean)
        .join(' · ');
      facts.push({ id: 'referrer', label: 'Referrer', value: meta || 'Yes', copyable: false });
    }
    if (c.tags.length) facts.push({ id: 'tags', label: 'Tags', value: c.tags.join(', '), copyable: false });
    if (c.notes) facts.push({ id: 'notes', label: 'Notes', value: c.notes, copyable: false });
    return facts;
  });

  constructor() {
    // Matter titles: read each matter the contact is on once (matters/{matterId}).
    effect(() => {
      const ids = new Set(this.parties.value().map((party) => party.matterId));
      untracked(() => {
        for (const id of ids) {
          if (this.requested.has(id)) continue;
          this.requested.add(id);
          void this.loadMatter(id);
        }
      });
    });
  }

  private async loadMatter(id: string): Promise<void> {
    let found: MatterLookup = 'missing';
    try {
      found = (await this.matterRepo.get(id)) ?? 'missing';
    } catch {
      // Privileged or no longer readable: the row still shows, without the title.
    }
    this.matterCache.update((cache) => new Map(cache).set(id, found));
  }

  protected date(value: string | Date): string {
    return formatDateOnly(value);
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function legalName(contact: ContactListItem): string {
  return [contact.givenNames, contact.familyName].filter(Boolean).join(' ');
}

/** `12345678901` → `12 345 678 901`. */
export function formatAbn(abn: string): string {
  return abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4');
}
