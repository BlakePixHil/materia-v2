import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';

import { ACCESS_REVOKED_HANDLER, can } from '@materia/data-access';
import { formatDateOnly, MtButton, MtEmptyState, MtNote, MtTabLink, MtTabNav } from '@materia/ui';

import { matterTabsFor } from './matter-tabs';
import { NotFoundPage } from './not-found';
import { ClerkPanel } from '../core/clerk/clerk-panel';
import { errorCopy } from '../core/error-copy';
import { ShortcutService } from '../core/shortcuts/shortcut.service';
import { MatterHeader } from '../features/matter-detail/matter-header';
import { MatterScreen } from '../features/matter-detail/matter-screen';
import { MatterStages } from '../features/matter-detail/matter-stages';

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
        <p role="status" class="caption t-3">Loading the matter…</p>
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
              This matter was deleted on {{ deletedOn() }}{{ deletedBy() }}. Everything here is read-only; an owner or
              admin can restore it within 30 days.
            </mt-note>
          }
          <mt-matter-header #header />
          @if (m.conflictAlert; as alert) {
            <mt-note [tone]="alert.adverse ? 'danger' : 'warning'">
              {{ alertText() }}
              <a routerLink="conflicts">Review the conflict check</a>
            </mt-note>
          }
          <mt-matter-stages />
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

  private readonly id = toSignal(this.route.paramMap.pipe(map((p) => p.get('id') ?? '')), { initialValue: '' });
  /** The active tab's path (`overview`, `parties`…). */
  protected readonly activeTab = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.childPath()),
    ),
    { initialValue: this.childPath() },
  );
  protected readonly tabs = computed(() => matterTabsFor(this.screen.value()?.type));

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
  protected readonly deletedOn = computed(() => formatDateOnly(this.screen.value()?.deletedAt ?? null));
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

    // Litigation is for disputes only: elsewhere its URL lands on the overview. A tab's own pages
    // (a document, `documents/:docId`) belong to their tab.
    effect(() => {
      const tab = this.activeTab()?.split('/')[0];
      const matter = this.screen.value();
      if (!matter || !tab || tab === 'conflicts') return;
      if (!this.tabs().some((t) => t.path === tab)) {
        untracked(() => void this.router.navigate(['overview'], { relativeTo: this.route, replaceUrl: true }));
      }
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

    const cleanups = this.registerShortcuts();
    destroyRef.onDestroy(() => cleanups.forEach((cleanup) => cleanup()));
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
}
