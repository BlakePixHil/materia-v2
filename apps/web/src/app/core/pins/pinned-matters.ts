import {
  computed,
  effect,
  inject,
  Injectable,
  Injector,
  runInInjectionContext,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';

import { ACCESS_REVOKED_HANDLER, OrgContext } from '@materia/data-access';
import {
  pinnedMatterRepository,
  userProfileRepository,
  type DocResource,
  type PinnedMatter,
} from '@materia/data-access/repository';
import {
  changePins,
  MAX_PINNED_MATTERS,
  pinsInOrg,
  withPins,
  type MatterStatus,
  type MatterType,
} from '@materia/domain';
import { ToastService } from '@materia/ui';

import { errorCopy } from '../error-copy';
import { UserPrefsService } from '../profile/user-prefs';

/** A pinned matter the person can still open, as the sidebar lists it. */
export interface PinnedMatterRef {
  id: string;
  number: string;
  title: string;
  type: MatterType;
  status: MatterStatus;
}

/** One live read of a pinned matter; slots are reused as pins come and go. */
interface Slot {
  id: WritableSignal<string | null>;
  doc: DocResource<PinnedMatter>;
}

/** What is known about a pinned matter: shown, gone (pruned on the next write), or not yet known. */
type PinState = { kind: 'shown'; ref: PinnedMatterRef } | { kind: 'gone' } | { kind: 'unknown' };

/**
 * The signed-in person's pinned matters in the active org (CORE-23): `users/{uid}.pinnedMatterIds`
 * from the profile listener `UserPrefsService` already keeps, plus one document listener per pinned
 * matter (no list queries). Matters they can no longer read, and deleted or destroyed ones, are
 * left out silently and pruned the next time they pin or unpin. Closed and archived matters stay.
 */
@Injectable({ providedIn: 'root' })
export class PinnedMatters {
  private readonly context = inject(OrgContext);
  private readonly prefs = inject(UserPrefsService);
  private readonly toasts = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly users = userProfileRepository();
  /**
   * A refused read here only means the pin is out of date, so this repository's listeners don't
   * send the person to "no access" the way a page's would.
   */
  private readonly matters = runInInjectionContext(
    Injector.create({
      providers: [{ provide: ACCESS_REVOKED_HANDLER, useValue: () => undefined }],
      parent: this.injector,
    }),
    () => pinnedMatterRepository(),
  );
  private readonly slots: Slot[] = [];
  /** Bumped when a slot is added, so the lists below see it. */
  private readonly slotCount = signal(0);

  /** The active org's pinned ids, in pinning order, as stored. */
  readonly ids = computed(
    () => {
      const orgId = this.context.orgId();
      return orgId ? pinsInOrg(this.prefs.profile.value()?.pinnedMatterIds, orgId) : [];
    },
    { equal: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]) },
  );
  private readonly states = computed(() => {
    this.slotCount();
    const byId = new Map(this.slots.map((slot) => [slot.id(), slot.doc] as const));
    return this.ids().map((id) => [id, stateOf(id, byId.get(id))] as const);
  });
  /** The pinned matters to show, in order. */
  readonly items = computed(() => this.states().flatMap(([, state]) => (state.kind === 'shown' ? [state.ref] : [])));
  private readonly pinnedSet = computed(() => new Set(this.ids()));

  constructor() {
    // One listener per pinned matter: a slot follows each id, and an unpinned id frees its slot.
    effect(() => {
      const ids = this.ids();
      untracked(() => {
        const wanted = new Set(ids);
        for (const slot of this.slots) {
          const id = slot.id();
          if (id && !wanted.has(id)) slot.id.set(null);
        }
        const held = new Set(this.slots.map((slot) => slot.id()));
        for (const id of ids) {
          if (held.has(id)) continue;
          const free = this.slots.find((slot) => slot.id() === null) ?? this.addSlot();
          free.id.set(id);
        }
      });
    });
  }

  /** Whether the matter is pinned (shown or not). */
  isPinned(matterId: string): boolean {
    return this.pinnedSet().has(matterId);
  }

  /** Pins or unpins the matter, with a toast saying so (or why it couldn't). */
  async toggle(matter: { id: string; number: string }): Promise<void> {
    await this.set(matter, !this.isPinned(matter.id));
  }

  /** Pins (`pin: true`) or unpins a matter; matters that are gone are pruned on the way. */
  async set(matter: { id: string; number: string }, pin: boolean): Promise<void> {
    const uid = this.context.uid();
    const orgId = this.context.orgId();
    // Until the profile has loaded, the stored pins aren't known, and a write would replace them.
    if (!uid || !orgId || !this.prefs.loaded()) return;
    const gone = new Set(this.states().flatMap(([id, state]) => (state.kind === 'gone' ? [id] : [])));
    const change = changePins(this.ids(), matter.id, pin, gone);
    if ('full' in change) {
      this.toasts.show({
        title: `You can pin up to ${MAX_PINNED_MATTERS} matters`,
        description: 'Unpin one to make room.',
        tone: 'neutral',
      });
      return;
    }
    const stored = this.prefs.profile.value()?.pinnedMatterIds;
    try {
      await this.users.update(uid, { pinnedMatterIds: withPins(stored, orgId, change.ids) });
      this.toasts.show({ title: pin ? `Pinned ${matter.number}` : `Unpinned ${matter.number}`, tone: 'success' });
    } catch (error) {
      this.toasts.show({
        title: pin ? 'Couldn’t pin the matter' : 'Couldn’t unpin the matter',
        description: errorCopy(error),
        tone: 'danger',
      });
    }
  }

  private addSlot(): Slot {
    const id = signal<string | null>(null);
    const slot = { id, doc: this.matters.watch(() => id(), { injector: this.injector }) };
    this.slots.push(slot);
    this.slotCount.update((n) => n + 1);
    return slot;
  }
}

function stateOf(id: string, doc: DocResource<PinnedMatter> | undefined): PinState {
  if (!doc) return { kind: 'unknown' };
  const error = doc.error();
  if (error)
    return error.code === 'ACCESS_REVOKED' || error.code === 'NOT_FOUND' ? { kind: 'gone' } : { kind: 'unknown' };
  const matter = doc.value();
  if (!matter) return doc.exists() ? { kind: 'unknown' } : { kind: 'gone' };
  if (matter.deletedAt || matter.destroyedAt) return { kind: 'gone' };
  const { number, title, type, status } = matter;
  return { kind: 'shown', ref: { id, number, title, type, status } };
}
