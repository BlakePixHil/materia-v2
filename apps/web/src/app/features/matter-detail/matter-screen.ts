import { computed, DestroyRef, effect, inject, Injectable, signal, untracked } from '@angular/core';

import { can, OrgContext } from '@materia/data-access';
import {
  MEMBER_LIST_QUERY,
  matterCallables,
  matterDetailRepository,
  matterTemplatesRepository,
  membersRepository,
} from '@materia/data-access/repository';
import { matterStages, type KeyFactId } from '@materia/domain';

import { recentUpdateText, type MatterRecord } from './matter-view';
import { CALLABLES } from '../../core/data/callables';
import { MatterRefs } from '../../core/title-strategy';

/** How often "Updated by … just now" is re-checked. */
const CLOCK_TICK_MS = 15_000;

/**
 * The matter screen's shared state (CORE-06), provided by the matter layout so the header and the
 * tabs share one live matter document instead of each listening to it. Tabs add listeners for their
 * own collections only, while they're shown.
 */
@Injectable()
export class MatterScreen {
  private readonly context = inject(OrgContext);

  /** The matter's id (from the route). */
  readonly id = signal<string | null>(null);
  readonly repo = matterDetailRepository();
  readonly matter = this.repo.watch(() => this.id());
  readonly api = matterCallables(inject(CALLABLES));

  // People, read once (names for pickers and the activity feed; members change rarely).
  private readonly members = membersRepository().watchQuery({ ...MEMBER_LIST_QUERY, pageSize: 200 }, { live: false });
  private readonly memberNames = computed(
    () => new Map(this.members.value().map((member) => [member.id, member.displayName] as const)),
  );
  /** Who a matter can be assigned to: active members who can edit. */
  readonly assignees = computed(() =>
    this.members
      .value()
      .filter((member) => member.status === 'active' && member.role !== 'readonly')
      .map((member) => ({ uid: member.id, name: member.displayName })),
  );
  readonly me = this.context.uid;

  // Permissions (hiding controls is a courtesy; the rules and callables enforce the same matrix).
  readonly canEdit = can('matter.edit');
  readonly canStatus = can('matter.status');
  readonly canDelete = can('matter.delete');
  readonly canPrivileged = can('privileged.view');
  readonly canRunConflicts = can('conflict.run');

  readonly deleted = computed(() => !!this.matter.value()?.deletedAt);
  /** Edits are allowed: the role may edit and the matter isn't deleted. */
  readonly editable = computed(() => this.canEdit() && !this.deleted());

  /** The key fact being edited inline (Overview), set by its Edit button or a stage requirement. */
  readonly editingFact = signal<KeyFactId | null>(null);
  /** Bumped to ask the Parties tab to open "Add party" (the `p` shortcut). */
  readonly addPartyRequest = signal(0);

  // The template's stages (CORE-07), read once per template; the type's defaults otherwise.
  private readonly templates = matterTemplatesRepository();
  private readonly templateStages = signal<{ id: string; title: string }[] | null>(null);
  readonly stages = computed(() => {
    const matter = this.matter.value();
    return matter ? matterStages(matter.type, this.templateStages() ?? undefined) : [];
  });

  /** Ticks so "just now" goes stale. */
  private readonly now = signal(Date.now());
  readonly recentUpdate = computed(() => {
    const matter = this.matter.value();
    return matter ? recentUpdateText(matter, this.me(), this.now(), (uid) => this.memberName(uid)) : null;
  });

  constructor() {
    let loadedFor: string | null = null;
    effect(() => {
      const templateId = this.matter.value()?.templateId ?? null;
      if (templateId === loadedFor) return;
      loadedFor = templateId;
      untracked(() => {
        this.templateStages.set(null);
        if (templateId) void this.loadTemplate(templateId);
      });
    });
    // Titles and breadcrumbs show the matter's number once it's known.
    const refs = inject(MatterRefs);
    effect(() => {
      const id = this.id();
      const number = this.matter.value()?.number;
      if (id && number) untracked(() => refs.set(id, number));
    });
    // A new matter (another id in the URL) starts with nothing being edited.
    effect(() => {
      this.id();
      untracked(() => this.editingFact.set(null));
    });
    const timer = setInterval(() => this.now.set(Date.now()), CLOCK_TICK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  memberName(uid: string): string {
    return this.memberNames().get(uid) ?? (uid === this.me() ? 'You' : 'Former member');
  }

  /** The current matter, or null while loading. */
  value(): MatterRecord | null {
    return this.matter.value();
  }

  private async loadTemplate(templateId: string): Promise<void> {
    try {
      const template = await this.templates.get(templateId);
      if (template && untracked(() => this.matter.value()?.templateId) === templateId) {
        this.templateStages.set(template.stages);
      }
    } catch {
      // No template (deleted, or not readable): the type's default stages stand.
    }
  }
}
