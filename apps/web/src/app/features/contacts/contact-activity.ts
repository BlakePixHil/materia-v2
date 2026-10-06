import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { MEMBER_LIST_QUERY, membersRepository } from '@materia/data-access/repository';
import type {
  ContactActivityField,
  ContactActivityInput,
  ContactActivityLine,
  ContactActivityResult,
} from '@materia/domain';
import { formatDateOnly, MtButton } from '@materia/ui';

import { PARTY_ROLE_LABELS } from './contact-form';
import { CALLABLES } from '../../core/data/callables';
import { errorCopy } from '../../core/error-copy';
import { activityTitle } from '../notes/note-view';

/** Lines per page. */
export const CONTACT_ACTIVITY_PAGE = 20;
/**
 * When the list reloads after the contact or its matters change: the audit entry is written just
 * after the change, and a trigger starting cold can take several seconds, so it looks twice.
 */
export const CONTACT_ACTIVITY_SETTLE_MS = [2000, 8000] as const;

/** How an edit names each detail group ("updated the phone and email"). */
const FIELD_LABELS: Readonly<Record<ContactActivityField, string>> = {
  name: 'name',
  dateOfBirth: 'date of birth',
  dateOfDeath: 'date of death',
  abn: 'ABN',
  phones: 'phone',
  emails: 'email',
  addresses: 'address',
  tags: 'tags',
  referrer: 'referrer details',
  notes: 'notes',
};

/** One Activity row: what happened, the matter it happened on (a link), and when. */
export interface ContactActivityItem {
  id: string;
  text: string;
  matter?: { id: string; label: string };
  at: string;
  when: string;
}

/** "a", "a and b", "a, b and c". */
function listed(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

const roleLabel = (role: string | undefined) =>
  role ? (PARTY_ROLE_LABELS[role as keyof typeof PARTY_ROLE_LABELS] ?? role.replace(/_/g, ' ')).toLowerCase() : '';

/** The actor-less sentence for a line ("Added this contact as executor on"). */
export function contactActivitySummary(line: ContactActivityLine): string {
  const role = roleLabel(line.role);
  switch (line.kind) {
    case 'created':
      return 'Added the contact';
    case 'updated':
      return line.fields?.length
        ? `Updated the ${listed(line.fields.map((f) => FIELD_LABELS[f]))}`
        : 'Updated the contact';
    case 'deleted':
      return 'Deleted the contact';
    case 'restored':
      return 'Restored the contact';
    case 'merged_in':
      return line.other ? `Merged ${line.other.name} into this contact` : 'Merged another contact into this one';
    case 'merged_away':
      return line.other ? `Merged this contact into ${line.other.name}` : 'Merged this contact into another';
    case 'party_added':
      return `Added this contact as ${role} on`;
    case 'party_updated':
      return `Updated this contact’s details as ${role} on`;
    case 'party_role_changed':
      return `Changed this contact’s role from ${roleLabel(line.previousRole)} to ${role} on`;
    case 'party_removed':
      return `Removed this contact as ${role} from`;
  }
}

/** A line as the list shows it, with the member's name in front ("Priya Shah added the contact"). */
export function contactActivityItem(
  line: ContactActivityLine,
  memberName: (uid: string) => string,
): ContactActivityItem {
  return {
    id: line.id,
    text: activityTitle(line.actorUid, contactActivitySummary(line), memberName),
    ...(line.matter
      ? {
          matter: {
            id: line.matter.id,
            label: line.matter.number ? `${line.matter.number} ${line.matter.title}` : line.matter.title,
          },
        }
      : {}),
    at: line.at,
    when: formatDateOnly(line.at),
  };
}

/** Appends a page, never showing a line twice. */
export function appendLines(current: readonly ContactActivityLine[], page: readonly ContactActivityLine[]) {
  const seen = new Set(current.map((line) => line.id));
  return [...current, ...page.filter((line) => !seen.has(line.id))];
}

/**
 * A contact's Activity (CORE-01a): edits, merges and the matters it was added to, re-roled on or
 * removed from, from the audit log through `contacts-activity`, newest first, 20 at a time. Lines
 * about matters the reader can't see are never sent. It reloads quietly after `version` changes
 * (the contact or its matters changed), once the audit entry has been written.
 */
@Component({
  selector: 'mt-contact-activity',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MtButton],
  template: `
    @switch (state()) {
      @case ('loading') {
        <p role="status" class="mt-contact-activity-muted">Loading activity…</p>
      }
      @case ('error') {
        <p class="mt-contact-activity-muted" role="alert">
          {{ error() }}
          <button mtButton size="sm" (click)="reload()">Try again</button>
        </p>
      }
      @default {
        <ul class="mt-contact-activity" data-testid="contact-activity">
          @for (item of items(); track item.id) {
            <li>
              <span class="mt-contact-activity-text">
                {{ item.text }}
                @if (item.matter; as matter) {
                  <a [routerLink]="['/matters', matter.id]">{{ matter.label }}</a>
                }
              </span>
              <time class="caption mt-contact-activity-muted" [attr.datetime]="item.at">{{ item.when }}</time>
            </li>
          } @empty {
            <li class="mt-contact-activity-muted">No activity yet.</li>
          }
        </ul>
        @if (nextCursor()) {
          <button mtButton size="sm" variant="ghost" [loading]="loadingMore()" (click)="more()">
            Show older activity
          </button>
        }
      }
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-8);
      min-width: 0;
    }
    .mt-contact-activity {
      align-self: stretch;
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
    }
    .mt-contact-activity li {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: var(--space-6) 0;
      border-top: 1px solid var(--border-subtle);
      font: 400 13px/18px var(--font-sans);
      color: var(--text-secondary);
      overflow-wrap: anywhere;
    }
    .mt-contact-activity li:first-child {
      border-top: 0;
    }
    .mt-contact-activity a {
      color: var(--text-primary);
    }
    .mt-contact-activity-muted {
      margin: 0;
      color: var(--text-tertiary);
    }
  `,
})
export class ContactActivity {
  readonly contactId = input.required<string>();
  /** Changes when the contact or its matters change; the list then reloads. */
  readonly version = input<string>('');

  private readonly callables = inject(CALLABLES);
  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 }, { live: false });
  private readonly memberNames = computed(
    () => new Map(this.members.value().map((member) => [member.id, member.displayName] as const)),
  );

  private readonly lines = signal<ContactActivityLine[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loadingMore = signal(false);
  private readonly loading = signal(true);
  private readonly failure = signal<unknown>(null);
  /** Bumped by each first-page load, so a slow reply for another contact is dropped. */
  private generation = 0;

  protected readonly state = computed(() => {
    if (this.failure()) return 'error';
    return this.loading() ? 'loading' : 'ready';
  });
  protected readonly error = computed(() => errorCopy(this.failure()));
  protected readonly items = computed(() =>
    this.lines().map((line) => contactActivityItem(line, (uid) => this.memberNames().get(uid) ?? 'Former member')),
  );

  constructor() {
    let timers: ReturnType<typeof setTimeout>[] = [];
    const clear = () => timers.forEach((timer) => clearTimeout(timer));
    let loadedFor: string | null = null;
    effect(() => {
      const id = this.contactId();
      this.version();
      untracked(() => {
        clear();
        if (id !== loadedFor) {
          loadedFor = id;
          timers = [];
          void this.reload();
        } else {
          timers = CONTACT_ACTIVITY_SETTLE_MS.map((ms) => setTimeout(() => void this.reload(true), ms));
        }
      });
    });
    inject(DestroyRef).onDestroy(clear);
  }

  /** Reads the first page again (`quiet` keeps the current lines on screen while it loads). */
  async reload(quiet = false): Promise<void> {
    const generation = ++this.generation;
    const contactId = this.contactId();
    if (!quiet) {
      this.loading.set(true);
      this.lines.set([]);
      this.nextCursor.set(null);
    }
    this.failure.set(null);
    try {
      const page = await this.fetch(contactId);
      if (generation !== this.generation) return;
      this.lines.set(page?.lines ?? []);
      this.nextCursor.set(page?.nextCursor ?? null);
    } catch (error) {
      if (generation === this.generation) this.failure.set(error);
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  protected async more(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore()) return;
    const generation = this.generation;
    this.loadingMore.set(true);
    try {
      const page = await this.fetch(this.contactId(), cursor);
      if (generation !== this.generation) return;
      this.lines.update((lines) => appendLines(lines, page?.lines ?? []));
      this.nextCursor.set(page?.nextCursor ?? null);
    } catch (error) {
      if (generation === this.generation) this.failure.set(error);
    } finally {
      this.loadingMore.set(false);
    }
  }

  private fetch(contactId: string, cursor?: string): Promise<ContactActivityResult> {
    return this.callables.call<ContactActivityInput, ContactActivityResult>('contacts-activity', {
      contactId,
      limit: CONTACT_ACTIVITY_PAGE,
      ...(cursor ? { cursor } : {}),
    });
  }
}
