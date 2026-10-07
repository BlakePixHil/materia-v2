import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';

import { ACCESS_REVOKED_HANDLER, can, OrgContext } from '@materia/data-access';
import { canRestoreMatter } from '@materia/domain';
import {
  formatDateOnly,
  MtButton,
  MtEmptyState,
  MtNote,
  MtSkeleton,
  MtTabLink,
  MtTabNav,
  ToastService,
} from '@materia/ui';

import { matterTabsFor } from './matter-tabs';
import { NotFoundPage } from './not-found';
import { ClerkPanel } from '../core/clerk/clerk-panel';
import { CommandRegistry, type Command } from '../core/commands/command-registry';
import { onIntent } from '../core/commands/intents';
import { matterCommands } from '../core/commands/matter-commands';
import { recentRecorder } from '../core/commands/recents';
import { errorCopy } from '../core/error-copy';
import { FeatureFlagService } from '../core/flags/feature-flags';
import { startTrace } from '../core/observability/perf';
import { ShortcutService } from '../core/shortcuts/shortcut.service';
import { MatterHeader } from '../features/matter-detail/matter-header';
import { MatterScreen } from '../features/matter-detail/matter-screen';
import { MatterStages } from '../features/matter-detail/matter-stages';

/** The matter commands ⌘K offers for the open matter that act on a tab (CORE-15). */
const TAB_ACTIONS = new Set(['matter.add-task', 'matter.add-deadline', 'matter.record-event', 'matter.upload']);

/** What the matter screen can show while (or instead of) the matter. */
type MatterState = 'loading' | 'ready' | 'restricted' | 'not-found' | 'offline' | 'error';

/**
 * The matter screen (`/matters/:id/:tab`, CORE-06): the header, the stage stepper, the conflict
 * alert (CORE-02) and router-linked tabs. One live listener on the matter, shared with the tabs
 * through `MatterScreen`; each tab listens to its own collections only while it's shown.
 *
 * A matter the person can't read (privileged, for a read-only role) shows "Restricted" here
 * rather than sending them away; one that doesn't exist in their org shows "not found". A matter
 * deleted while open shows a banner and becomes read-only. ⌘J asks Clerk about this matter.
 */
@Component({
  selector: 'mt-matter-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatterHeader,
    MatterStages,
    MtButton,
    MtEmptyState,
    MtNote,
    MtSkeleton,
    MtTabNav,
    MtTabLink,
    NotFoundPage,
    RouterLink,
    RouterOutlet,
  ],
  providers: [
    MatterScreen,
    // A refused read here is a privileged matter (or one whose access just changed): this screen
    // shows "Restricted" in place, so it doesn't send the person to "no access".
    { provide: ACCESS_REVOKED_HANDLER, useValue: () => undefined },
  ],
  host: { class: 'mt-col', style: 'gap: 16px; flex: 1; min-width: 0' },
  // The section tabs scroll sideways when they don't fit (a phone), rather than widening the page.
  // The divider is drawn inside the nav, so the scroll box doesn't clip the active tab's underline.
  styles: `
    nav[mttabnav] {
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
      border-bottom: 0;
      box-shadow: inset 0 -1px 0 var(--border-default);
    }
    nav[mttabnav] a {
      flex: none;
      margin-bottom: 0;
      white-space: nowrap;
    }
  `,
  template: `
    @switch (state()) {
      @case ('loading') {
        <mt-skeleton variant="cards" label="Loading the matter…" />
      }
      @case ('restricted') {
        <div class="mt-col" style="flex: 1; justify-content: center">
          <h1 class="mt-sr">Restricted</h1>
          <mt-empty-state
            icon="shield"
            title="Restricted"
            description="This matter is privileged, and your role can’t open it. Ask the responsible lawyer if you need it."
            [headingLevel]="2"
          >
            <a mtButton variant="primary" routerLink="/matters">Back to matters</a>
          </mt-empty-state>
        </div>
      }
      @case ('not-found') {
        <mt-not-found-page />
      }
      @case ('offline') {
        <mt-note role="status">You’re offline, and this matter isn’t saved on this device yet.</mt-note>
      }
      @case ('error') {
        <mt-note tone="danger">{{ loadError() }}</mt-note>
      }
      @default {
        @if (screen.value(); as m) {
          @if (m.deletedAt) {
            <mt-note tone="danger" class="deleted">
              This matter was deleted on {{ deletedOn() }}{{ deletedBy() }}. Everything here is read-only;
              @if (!restorable()) {
                it can no longer be restored.
              } @else if (screen.canRestore()) {
                you can restore it within 30 days of the delete.
                <button mtButton size="sm" [disabled]="restoring()" (click)="restore()">Restore matter</button>
              } @else {
                an owner or admin can restore it within 30 days.
              }
            </mt-note>
          } @else if (closedText(); as text) {
            <mt-note class="closed" icon="archive"
              >{{ text }}
              @if (m.closing?.safeCustody; as packet) {
                The original will is in safe custody:
                <a [routerLink]="['/safe-custody', packet.packetId]">{{ packet.packetNo }}</a
                >.
              }
            </mt-note>
          }
          <mt-matter-header #header />
          @if (m.conflictAlert; as alert) {
            <mt-note [tone]="alert.adverse ? 'danger' : 'warning'">
              {{ alertText() }}
              <a routerLink="conflicts">Review the conflict check</a>
            </mt-note>
          }
          <mt-matter-stages #stages />
          <nav mtTabNav aria-label="Matter sections">
            @for (tab of tabs(); track tab.path) {
              <a mtTabLink [routerLink]="tab.path">{{ tab.label }}</a>
            }
          </nav>
          <router-outlet />
        }
      }
    }
  `,
})
export class MatterLayout {
  protected readonly screen = inject(MatterScreen);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly clerk = inject(ClerkPanel);
  private readonly header = viewChild<MatterHeader>('header');
  private readonly stages = viewChild<MatterStages>('stages');

  private readonly id = toSignal(this.route.paramMap.pipe(map((p) => p.get('id') ?? '')), { initialValue: '' });
  /** The active tab's path (`overview`, `parties`…). */
  protected readonly activeTab = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.childPath()),
    ),
    { initialValue: this.childPath() },
  );
  private readonly flags = inject(FeatureFlagService);
  protected readonly tabs = computed(() => matterTabsFor(this.screen.value()?.type, (key) => this.flags.isOn(key)));

  protected readonly state = computed<MatterState>(() => {
    const matter = this.screen.matter;
    const error = matter.error();
    if (error) {
      if (error.code === 'ACCESS_REVOKED' || error.code === 'PERMISSION_DENIED') return 'restricted';
      return error.code === 'NOT_FOUND' ? 'not-found' : 'error';
    }
    if (matter.value()) return 'ready';
    const status = matter.status();
    if (status === 'offline') return 'offline';
    return status === 'ready' && !matter.exists() ? 'not-found' : 'loading';
  });
  protected readonly loadError = computed(() => errorCopy(this.screen.matter.error()));
  /** The closed or archived banner (CORE-19): when, what's still allowed, and how long it's kept. */
  protected readonly closedText = computed(() => {
    const matter = this.screen.value();
    if (!matter || (matter.status !== 'closed' && matter.status !== 'archived')) return null;
    const closedOn = matter.closedAt ? ` on ${formatDateOnly(matter.closedAt)}` : '';
    const state =
      matter.status === 'archived'
        ? `Archived${matter.archivedAt ? ` on ${formatDateOnly(matter.archivedAt)}` : ''}, after closing${closedOn}. It’s read-only; lawyers can still add notes.`
        : `Closed${closedOn}. It’s read-only apart from notes, and is archived 90 days after closing.`;
    const kept = matter.legalHold?.on
      ? 'A legal hold keeps it from destruction.'
      : matter.destroyAfter
        ? `Kept until at least ${formatDateOnly(matter.destroyAfter)}.`
        : 'It has no destruction date.';
    return `${state} ${kept}${this.screen.canStatus() ? ' Reopen it from the status menu to make changes.' : ''}`;
  });
  protected readonly deletedOn = computed(() => formatDateOnly(this.screen.value()?.deletedAt ?? null));
  /** Still inside the restore window (CORE-03); the server checks again. */
  protected readonly restorable = computed(() => {
    const deletedAt = this.screen.value()?.deletedAt;
    return !!deletedAt && canRestoreMatter(deletedAt, new Date());
  });
  protected readonly restoring = signal(false);
  private readonly toasts = inject(ToastService);
  protected readonly deletedBy = computed(() => {
    const by = this.screen.value()?.deletedBy;
    return by ? ` by ${this.screen.memberName(by)}` : '';
  });
  protected readonly alertText = computed(() => {
    const adverse = this.screen.value()?.conflictAlert?.adverse;
    const label = typeof adverse === 'string' ? ` (adverse: ${adverse})` : adverse ? ' in an adverse role' : '';
    return `A party added since the conflict check matches someone on another matter${label}.`;
  });

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.screen.id.set(id || null));
    });

    // The matter_open trace (FND-21): from the route to the matter shown (or an error state).
    let opening: (() => void) | null = null;
    effect(() => {
      if (this.id()) opening = startTrace('matter_open');
    });
    effect(() => {
      if (this.state() === 'loading' || !opening) return;
      opening();
      opening = null;
    });

    // Litigation is for disputes only: elsewhere its URL lands on the overview. A tab's own pages
    // (a document, `documents/:docId`) belong to their tab.
    effect(() => {
      const tab = this.activeTab()?.split('/')[0];
      const matter = this.screen.value();
      if (!matter || !tab || tab === 'conflicts') return;
      if (!this.tabs().some((t) => t.path === tab)) untracked(() => void this.leaveUnavailableTab(tab));
    });

    // Today's Recent matters (CORE-14) and ⌘K's Recent (CORE-15): each matter opened is recorded once.
    const record = recentRecorder();
    effect(() => {
      const matter = this.screen.value();
      if (!matter || matter.deletedAt) return;
      untracked(() => record({ kind: 'matter', matterId: matter.id }));
    });

    // ⌘J asks Clerk about this matter while it's open.
    const destroyRef = inject(DestroyRef);
    let releaseScope: (() => void) | null = null;
    effect(() => {
      const matter = this.screen.value();
      const scope = matter ? { kind: 'matter' as const, id: matter.id, label: matter.number } : null;
      untracked(() => {
        releaseScope?.();
        releaseScope = scope ? this.clerk.setScope(scope) : null;
      });
    });
    destroyRef.onDestroy(() => releaseScope?.());

    const cleanups = [...this.registerShortcuts(), ...this.registerCommands()];
    destroyRef.onDestroy(() => cleanups.forEach((cleanup) => cleanup()));

    // ⌘K's "Close matter…" on a matter result (CORE-15) lands here from any tab.
    onIntent(
      'close',
      () => this.header()?.closeMatter(),
      () => !!this.header(),
    );
  }

  /** Brings the deleted matter back (`matters-restore`, owner and admin). */
  protected async restore(): Promise<void> {
    const matter = this.screen.value();
    if (!matter || this.restoring()) return;
    this.restoring.set(true);
    try {
      await this.screen.api.restore({ matterId: matter.id });
      this.toasts.show({ title: `Restored ${matter.number}`, tone: 'success' });
    } catch (error) {
      this.toasts.show({ title: 'Couldn’t restore the matter', description: errorCopy(error), tone: 'danger' });
    } finally {
      this.restoring.set(false);
    }
  }

  private childPath(): string | null {
    return this.route.snapshot.firstChild?.routeConfig?.path ?? null;
  }

  private goTo(path: string): Promise<boolean> {
    return this.router.navigate([path], { relativeTo: this.route });
  }

  private async addParty(): Promise<void> {
    if (this.activeTab() !== 'parties' && !(await this.goTo('parties'))) return;
    this.screen.addPartyRequest.update((n) => n + 1);
  }

  /**
   * ⌘K's "This matter" commands while a matter is open (CORE-15): the actions with a tab of their
   * own go there with an intent (`?do=add-task`); stage, responsible lawyer and closing act here.
   */
  private registerCommands(): (() => void)[] {
    const commands = inject(CommandRegistry);
    const context = inject(OrgContext);
    const group = 'This matter';
    const ready = () => this.state() === 'ready' && !this.screen.readOnly();

    // The tab actions follow the matter (its id and number) and the role.
    const target = computed(
      () => {
        const matter = this.screen.value();
        return matter ? { id: matter.id, number: matter.number } : null;
      },
      { equal: (a, b) => a?.id === b?.id && a?.number === b?.number },
    );
    let releaseActions: (() => void)[] = [];
    effect(() => {
      const matter = target();
      const role = context.role();
      untracked(() => {
        releaseActions.forEach((release) => release());
        const actions = matter
          ? matterCommands(matter, role, (url) => this.router.navigateByUrl(url), group).filter((command) =>
              TAB_ACTIONS.has(command.id),
            )
          : [];
        releaseActions = actions.map((command) =>
          commands.register({ ...command, when: () => ready() && (command.when?.() ?? true) }),
        );
      });
    });

    const changeStage: Command = {
      id: 'this-matter.stage',
      title: 'Change stage…',
      group,
      icon: 'arrow-right',
      keywords: ['move', 'advance', 'stage'],
      when: () => ready() && !!this.stages()?.movable(),
      children: () => {
        const stepper = this.stages();
        if (!stepper) return [];
        return stepper.stages().map((stage) => ({
          id: `this-matter.stage.${stage.id}`,
          title: stage.title,
          group: 'Stage',
          icon: stage.id === stepper.current() ? 'check' : undefined,
          when: () => stage.id !== stepper.current() && !stage.locked,
          run: () => stepper.move(stage),
        }));
      },
      run: () => undefined,
    };
    const assign: Command = {
      id: 'this-matter.assign',
      title: 'Assign…',
      group,
      icon: 'user',
      keywords: ['responsible', 'lawyer', 'owner'],
      when: () => ready() && this.screen.editable(),
      children: () =>
        this.screen.assignees().map((person) => ({
          id: `this-matter.assign.${person.uid}`,
          title: person.name,
          group: 'Responsible lawyer',
          icon: person.uid === this.screen.value()?.responsibleUid ? 'check' : undefined,
          run: () => this.header()?.setResponsible(person.uid),
        })),
      run: () => undefined,
    };
    const close: Command = {
      id: 'this-matter.close',
      title: 'Close matter…',
      group,
      icon: 'archive',
      keywords: ['finish', 'archive', 'status'],
      when: () => ready() && !!this.header()?.canClose(),
      run: () => this.header()?.closeMatter(),
    };
    return [
      () => releaseActions.forEach((release) => release()),
      commands.register(changeStage),
      commands.register(assign),
      commands.register(close),
    ];
  }

  private registerShortcuts(): (() => void)[] {
    const shortcuts = inject(ShortcutService);
    const ready = () => this.state() === 'ready';
    const shortcut = (combo: string, description: string, handler: () => void, when = ready) =>
      shortcuts.register({ combo, description, group: 'Matter', scope: 'route', when, handler });
    const editable = () => ready() && this.screen.editable();
    const canCreate = can('matter.create');
    return [
      shortcut(
        'c',
        'New matter',
        () => void this.router.navigateByUrl('/matters/new'),
        () => canCreate(),
      ),
      shortcut(
        'mod+j',
        'Ask Clerk about this matter',
        () => this.clerk.toggle(),
        () => true,
      ),
      shortcut('e', 'Edit the matter title', () => this.header()?.editTitle(), editable),
      shortcut('y', 'Copy the matter number', () => void this.header()?.copyNumber()),
      shortcut('p', 'Add a party', () => void this.addParty(), editable),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
        shortcut(
          String(n),
          n === 1 ? 'Go to the overview (tab 1)' : `Go to tab ${n}`,
          () => {
            const tab = this.tabs()[n - 1];
            if (tab) void this.goTo(tab.path);
          },
          () => ready() && this.tabs().length >= n,
        ),
      ),
    ];
  }

  /** A tab the matter doesn't have lands on the overview, once the flags (which hide some tabs) are in. */
  private async leaveUnavailableTab(tab: string): Promise<void> {
    await this.flags.ready();
    if (this.activeTab()?.split('/')[0] !== tab || this.tabs().some((t) => t.path === tab)) return;
    await this.router.navigate(['overview'], { relativeTo: this.route, replaceUrl: true });
  }
}
