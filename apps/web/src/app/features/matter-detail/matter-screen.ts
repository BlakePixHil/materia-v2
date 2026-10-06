import { computed, DestroyRef, effect, inject, Injectable, signal, untracked } from '@angular/core';

import { can, OrgContext } from '@materia/data-access';
import {
  MEMBER_LIST_QUERY,
  matterCallables,
  matterDetailRepository,
  matterTemplateLoader,
  matterTemplatesRepository,
  membersRepository,
  type MatterTemplateOutline,
} from '@materia/data-access/repository';
import { isSystemTemplateId, matterStages, type KeyFactId } from '@materia/domain';

import { recentUpdateText, type MatterRecord } from './matter-view';
import { CALLABLES } from '../../core/data/callables';
import { FeatureFlagService } from '../../core/flags/feature-flags';
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
  private readonly flags = inject(FeatureFlagService);

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
  /** Every member with their status and role, for task assignees (CORE-08: former members). */
  readonly memberList = computed(() =>
    this.members
      .value()
      .map((member) => ({ uid: member.id, name: member.displayName, status: member.status, role: member.role })),
  );
  readonly me = this.context.uid;

  // Permissions (hiding controls is a courtesy; the rules and callables enforce the same matrix).
  readonly canEdit = can('matter.edit');
  readonly canStatus = can('matter.status');
  readonly canDelete = can('matter.delete');
  /** Owners and admins bring a deleted matter back (CORE-03), within MATTER_RESTORE_WINDOW_DAYS. */
  readonly canRestore = can('matter.restore');
  readonly canPrivileged = can('privileged.view');
  readonly canRunConflicts = can('conflict.run');
  readonly canRenumber = can('matter.renumber');

  readonly canClose = can('matter.close');
  readonly canLegalHold = can('matter.legalHold');

  readonly deleted = computed(() => !!this.matter.value()?.deletedAt);
  /** Closed or archived (CORE-19): read-only here, except notes; reopening brings it back. */
  readonly closed = computed(() => ['closed', 'archived'].includes(this.matter.value()?.status ?? ''));
  /** Archived (CORE-19): the rules refuse edits; only lawyers and above add notes. */
  readonly archived = computed(() => this.matter.value()?.status === 'archived');
  /** Nothing on the matter is edited here: it's deleted, closed or archived. */
  readonly readOnly = computed(() => this.deleted() || this.closed());
  /** Edits are allowed: the role may edit and the matter is live and open. */
  readonly editable = computed(() => this.canEdit() && !this.readOnly());

  /** The key fact being edited inline (Overview), set by its Edit button or a stage requirement. */
  readonly editingFact = signal<KeyFactId | null>(null);
  /** Bumped to ask the Parties tab to open "Add party" (the `p` shortcut). */
  readonly addPartyRequest = signal(0);

  /** Matter templates are on (CORE-07): stage entry requirements, moving back with a reason, upgrades. */
  readonly templatesOn = computed(() => this.flags.isOn('templates.system'));

  // The template version's stages and task names (CORE-07), read once per template version; the
  // type's default stages otherwise.
  private readonly loadTemplate = matterTemplateLoader();
  private readonly template = signal<MatterTemplateOutline | null>(null);
  readonly stages = computed(() => {
    const matter = this.matter.value();
    return matter ? matterStages(matter.type, this.template()?.stages) : [];
  });
  /** A template task's title by its key ("Take will instructions"); the key when unknown. */
  taskTitle(key: string): string {
    return this.template()?.tasks.find((task) => task.key === key)?.title ?? key.replace(/_/g, ' ');
  }

  // The org template the matter is on (system templates have one version), watched for newer versions.
  private readonly orgTemplate = matterTemplatesRepository().watch(() => {
    const templateId = this.templatesOn() ? this.matter.value()?.templateId : null;
    return templateId && !isSystemTemplateId(templateId) ? templateId : null;
  });
  /** The newer published version of the matter's template it can upgrade to, or null. */
  readonly upgradeVersion = computed(() => {
    const latest = this.orgTemplate.value()?.version ?? 0;
    const current = this.matter.value()?.templateVersion ?? 0;
    return this.templatesOn() && current >= 1 && latest > current ? latest : null;
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
      const version = this.matter.value()?.templateVersion ?? null;
      const key = templateId ? `${templateId}@${version ?? ''}` : null;
      if (key === loadedFor) return;
      loadedFor = key;
      untracked(() => {
        this.template.set(null);
        if (templateId) void this.readTemplate(templateId, version);
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

  private async readTemplate(templateId: string, version: number | null): Promise<void> {
    try {
      const template = await this.loadTemplate(templateId, version);
      const current = untracked(() => this.matter.value());
      if (template && current?.templateId === templateId && (current.templateVersion ?? null) === version) {
        this.template.set(template);
      }
    } catch {
      // No template (deleted, or not readable): the type's default stages stand.
    }
  }
}
