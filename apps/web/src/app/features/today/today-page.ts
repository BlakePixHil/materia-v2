import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  untracked,
  ViewEncapsulation,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { can } from '@materia/data-access';
import type { OnboardingStep } from '@materia/domain';
import { MT_TODAY, MtBadge, MtButton, MtEmptyState, MtIcon, MtNote } from '@materia/ui';

import { TodayData } from './today-data';
import { TodayAttention, TodayDue, TodayRecent, TodayTasks } from './today-sections';
import { timeZoneHintText, TODAY_COPY } from './today-view';
import { FeatureFlagService } from '../../core/flags/feature-flags';
import { ShortcutService } from '../../core/shortcuts/shortcut.service';
import { MtPageActions } from '../../shell/page-header';
import { DeadlineActions } from '../deadlines/deadline-actions';
import { TaskActions } from '../tasks/task-actions';

/** How long focus waits for a completed task to leave the list. */
const REFOCUS_MS = 5000;

const ONBOARDING_LINKS: Partial<Record<OnboardingStep['id'], { link: string; action: string }>> = {
  matter: { link: '/matters/new', action: 'Create a matter' },
  team: { link: '/settings/team', action: 'Invite people' },
};

/**
 * Today (`/today`, CORE-14): the signed-in person's day in the org's time zone. A greeting with the
 * date; Clerk's brief (behind `clerk.features.brief`); a checklist while the practice has no
 * matters; Needs attention (live); My tasks; my numbers; Due today and this week; and the matters
 * I opened lately. The data is `TodayData`'s.
 *
 * Keyboard: j/k move through every row on the page, Enter opens the focused row, Space completes
 * the focused task, `a` acknowledges the focused escalation.
 */
@Component({
  selector: 'mt-today-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  providers: [
    TaskActions,
    DeadlineActions,
    TodayData,
    // The day, deadline chips and dialogs on this page follow the org's time zone.
    {
      provide: MT_TODAY,
      useFactory: () => {
        const data = inject(TodayData);
        return () => data.today();
      },
    },
  ],
  styleUrls: [
    '../../../../../../libs/ui/src/generated/components/card.css',
    '../../../../../../libs/ui/src/generated/components/count.css',
    '../../../../../../libs/ui/src/generated/components/stat.css',
    '../../../../../../libs/ui/src/generated/components/timeline.css',
    '../../../../../../libs/ui/src/generated/components/tl.css',
  ],
  imports: [
    MtBadge,
    MtButton,
    MtEmptyState,
    MtIcon,
    MtNote,
    MtPageActions,
    RouterLink,
    TodayAttention,
    TodayDue,
    TodayRecent,
    TodayTasks,
  ],
  host: { class: 'mt-today' },
  template: `
    <ng-template mtPageActions>
      @if (canCreateMatter()) {
        <a mtButton variant="primary" size="sm" iconStart="plus" routerLink="/matters/new">New matter</a>
      }
    </ng-template>

    <header class="head">
      <span class="eyebrow t-3" data-today-date>{{ data.dateLabel() }}</span>
      <h1 class="display">{{ data.greeting() }}</h1>
      @if (data.zoneHint(); as hint) {
        <p class="caption t-3 zone" data-zone-hint><mt-icon name="clock" [size]="14" />{{ hintText(hint) }}</p>
      }
    </header>
    @if (!data.online()) {
      <mt-note tone="warning" data-offline>{{ copy.offline }}</mt-note>
    }
    <p class="mt-sr" aria-live="polite">{{ deadlineActions.announcement() }}</p>

    <!-- Drawn once every section has its first answer, so nothing moves as each one lands. -->
    @if (!data.settled()) {
      <p class="caption t-3" role="status" data-today-loading>{{ copy.loading }}</p>
    } @else {
      <div class="grid">
        <div class="col">
          @if (briefOn()) {
            <section class="mt-card" data-pad data-section="brief" aria-labelledby="mt-today-brief">
              <div class="mt-card-h">
                <h2 class="mt-card-title" id="mt-today-brief">Morning brief</h2>
              </div>
              <mt-empty-state icon="sparkle" [title]="copy.brief.title" [description]="copy.brief.description" />
            </section>
          }
          @if (onboarding(); as steps) {
            <section class="mt-card" data-pad data-section="onboarding" aria-labelledby="mt-today-start">
              <div class="mt-card-h">
                <h2 class="mt-card-title" id="mt-today-start">Set up your practice</h2>
              </div>
              <p class="caption t-2 intro">A few steps and your day fills in here.</p>
              <ol class="steps">
                @for (step of steps; track step.id) {
                  <li [attr.data-step]="step.id" [attr.data-done]="step.done ? '' : null">
                    <mt-icon [name]="step.done ? 'check-circle' : 'arrow-right'" />
                    <div class="text">
                      <span class="label"
                        >{{ step.label }}
                        @if (step.done) {
                          <span class="mt-sr">(done)</span>
                        }
                      </span>
                      <span class="caption t-3">{{ step.description }}</span>
                    </div>
                    @if (step.comingSoon) {
                      <mt-badge>Coming soon</mt-badge>
                      <button mtButton size="sm" disabled>Connect<span class="mt-sr"> a calendar</span></button>
                    } @else if (step.next) {
                      <a mtButton size="sm" [routerLink]="step.next.link">{{ step.next.action }}</a>
                    }
                  </li>
                }
              </ol>
            </section>
          }
          <mt-today-attention />
          <mt-today-tasks />
        </div>
        <div class="col side">
          <!--
            The design system's Stat (stat.css), drawn here rather than with MtStat: the first use of a
            @materia/ui component from a lazy page puts it in the initial bundle.
          -->
          <div class="stats" data-section="stats">
            <div class="mt-card mt-stat" data-stat="open-matters">
              <div class="k"><mt-icon name="matters" />Open matters</div>
              <div class="v">{{ count(data.counts().openMatters) }}</div>
              <div class="f">You’re responsible for</div>
            </div>
            <div class="mt-card mt-stat" data-stat="deadlines">
              <div class="k"><mt-icon name="calendar" />Deadlines this week</div>
              <div class="v">{{ count(data.counts().deadlinesThisWeek) }}</div>
              <div class="f">
                @if (overdueCount()) {
                  <span class="t-danger">{{ overdueCount() }} overdue</span>
                } @else {
                  Assigned to you
                }
              </div>
            </div>
          </div>
          <mt-today-due />
          <mt-today-recent />
        </div>
      </div>
    }
  `,
  styles: `
    .mt-today {
      display: flex;
      flex-direction: column;
      gap: var(--space-20);
      flex: 1;
      min-width: 0;
      max-width: 1180px;
    }
    .mt-today .head {
      display: flex;
      flex-direction: column;
      gap: var(--space-6);
    }
    .mt-today .head h1 {
      margin: 0;
    }
    .mt-today .zone {
      display: inline-flex;
      align-items: center;
      gap: var(--space-6);
      margin: 0;
    }
    .mt-today .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 400px;
      gap: var(--space-20);
      align-items: start;
    }
    .mt-today .col {
      display: flex;
      flex-direction: column;
      gap: var(--space-16);
      min-width: 0;
    }
    .mt-today .side {
      gap: var(--space-12);
    }
    .mt-today .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-12);
    }
    .mt-today h2,
    .mt-today h3 {
      margin: 0;
    }
    .mt-today .mt-card-h {
      gap: var(--space-8);
    }
    .mt-today .mt-tl > .body {
      min-width: 0;
    }
    .mt-today .mt-tl .tt {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-6);
      overflow-wrap: anywhere;
    }
    .mt-today .mt-tl .side {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-6);
    }
    .mt-today [data-today-focus] {
      color: inherit;
      text-decoration: none;
      border-radius: var(--radius-sm);
    }
    .mt-today a[data-today-focus]:hover {
      text-decoration: underline;
    }
    .mt-today [data-today-focus]:focus-visible,
    .mt-today .recent a:focus-visible {
      box-shadow: var(--focus-ring);
      outline: none;
    }
    .mt-today .mt-card-h a,
    .mt-today .more a {
      color: var(--text-brand);
    }
    .mt-today .more {
      margin: var(--space-12) 0 0;
    }
    .mt-today .urgent {
      display: flex;
      gap: var(--space-8);
      align-items: flex-start;
      margin-bottom: var(--space-12);
      padding: var(--space-12) var(--space-16);
      border-radius: var(--radius-md);
      background: var(--bg-danger-subtle);
      border: 1px solid var(--border-danger);
      color: var(--text-danger);
      font: 400 13px/18px var(--font-sans);
    }
    .mt-today .urgent p {
      margin: 0;
    }
    .mt-today .urgent mt-icon {
      flex: none;
      width: 16px;
      height: 16px;
      margin-top: 1px;
    }
    .mt-today .tasks,
    .mt-today .recent,
    .mt-today .steps {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
    }
    .mt-today .tasks {
      gap: 2px;
      margin: 0 calc(-1 * var(--space-8));
    }
    .mt-today .recent li {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      padding: var(--space-6) 0;
      min-width: 0;
    }
    .mt-today .recent li + li {
      border-top: 1px solid var(--border-subtle);
    }
    .mt-today .recent a {
      flex: 1;
      min-width: 0;
      display: flex;
      gap: var(--space-8);
      align-items: baseline;
    }
    .mt-today .recent .num {
      flex: none;
      font: 500 12px/16px var(--font-mono);
      color: var(--text-tertiary);
    }
    .mt-today .recent .name {
      font: 500 13px/18px var(--font-sans);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mt-today .intro {
      margin: 0 0 var(--space-12);
    }
    .mt-today .steps {
      gap: var(--space-12);
    }
    .mt-today .steps li {
      display: flex;
      align-items: center;
      gap: var(--space-12);
      flex-wrap: wrap;
    }
    .mt-today .steps li > mt-icon {
      flex: none;
      color: var(--icon-muted);
    }
    .mt-today .steps li[data-done] > mt-icon {
      color: var(--status-success);
    }
    .mt-today .steps .text {
      flex: 1 1 220px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .mt-today .steps .label {
      font: 500 14px/20px var(--font-sans);
    }
    .mt-today .steps li[data-done] .label {
      color: var(--text-secondary);
      text-decoration: line-through;
    }
    @media (max-width: 1100px) {
      .mt-today .grid {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    @media (max-width: 480px) {
      .mt-today .mt-tl {
        grid-template-columns: 20px minmax(0, 1fr);
      }
      .mt-today .mt-tl .side {
        grid-column: 2;
        justify-content: flex-start;
        margin-top: var(--space-6);
      }
    }
  `,
})
export class TodayPage {
  protected readonly data = inject(TodayData);
  protected readonly deadlineActions = inject(DeadlineActions);
  private readonly taskActions = inject(TaskActions);
  private readonly flags = inject(FeatureFlagService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  protected readonly copy = TODAY_COPY;
  /** The checklist, each open step with where it's done. */
  protected readonly onboarding = computed(() =>
    this.data
      .onboarding()
      ?.map((step) => ({ ...step, next: step.done || step.comingSoon ? null : (ONBOARDING_LINKS[step.id] ?? null) })),
  );
  protected readonly canCreateMatter = can('matter.create');
  protected readonly briefOn = computed(() => this.flags.isOn('clerk.features.brief'));
  protected readonly overdueCount = computed(
    () => this.data.attention().items.filter((item) => item.kind === 'overdue').length,
  );
  /** Every row's key, in page order: focus follows a completed task's place in it. */
  private readonly keys = computed(() => [
    ...this.data.attention().items.map((item) => item.key),
    ...this.data.myTasks().map((item) => item.key),
    ...this.data.due().items.map((item) => item.key),
    ...this.data.recentMatters().map((matter) => `matter:${matter.id}`),
  ]);
  private refocus: { key: string; index: number; until: number } | null = null;

  constructor() {
    effect(() => {
      this.keys();
      untracked(() => afterNextRender(() => this.keepFocus(), { injector: this.injector }));
    });
    const shortcuts = inject(ShortcutService);
    const kindOfFocus = () => this.focusedItem()?.dataset['kind'];
    const cleanups = [
      shortcuts.register({
        combo: 'j',
        description: 'Next item',
        group: 'Today',
        scope: 'route',
        handler: () => this.move(1),
      }),
      shortcuts.register({
        combo: 'k',
        description: 'Previous item',
        group: 'Today',
        scope: 'route',
        handler: () => this.move(-1),
      }),
      shortcuts.register({
        combo: 'space',
        description: 'Complete the focused task',
        group: 'Today',
        scope: 'route',
        when: () => kindOfFocus() === 'task',
        handler: () => void this.completeFocused(),
      }),
      shortcuts.register({
        combo: 'a',
        description: 'Acknowledge the focused escalation',
        group: 'Today',
        scope: 'route',
        when: () => kindOfFocus() === 'escalation',
        // Escalations (CORE-11) aren't raised yet, so there is never one to acknowledge.
        handler: () => undefined,
      }),
    ];
    inject(DestroyRef).onDestroy(() => cleanups.forEach((cleanup) => cleanup()));
  }

  protected hintText(hint: { org: string; device: string }): string {
    return timeZoneHintText(hint);
  }

  protected count(value: number | null): string {
    return value === null ? '—' : String(value);
  }

  private items(): HTMLElement[] {
    return [...this.host.nativeElement.querySelectorAll<HTMLElement>('[data-today-item]')];
  }

  private focusedItem(): HTMLElement | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.host.nativeElement.contains(active)) return null;
    return active.closest<HTMLElement>('[data-today-item]');
  }

  private focusAt(index: number): void {
    const item = this.items()[index];
    item?.querySelector<HTMLElement>('[data-today-focus], .mt-task-title')?.focus();
  }

  /** j/k: the next or previous row; from outside the rows, the first or last. */
  private move(delta: 1 | -1): void {
    const items = this.items();
    if (!items.length) return;
    const current = this.focusedItem();
    const at = current ? items.indexOf(current) : -1;
    const next = at < 0 ? (delta > 0 ? 0 : items.length - 1) : Math.min(Math.max(at + delta, 0), items.length - 1);
    this.focusAt(next);
  }

  private async completeFocused(): Promise<void> {
    const item = this.focusedItem();
    const key = item?.dataset['key'];
    const entry = key ? this.data.taskEntries().get(key) : undefined;
    if (!item || !key || !entry) return;
    const index = this.items().indexOf(item);
    if (await this.taskActions.complete([entry])) this.refocus = { key, index, until: Date.now() + REFOCUS_MS };
  }

  /** A completed task left the list: focus moves to the row now in its place. */
  private keepFocus(): void {
    const refocus = this.refocus;
    if (!refocus) return;
    if (Date.now() > refocus.until) {
      this.refocus = null;
      return;
    }
    const items = this.items();
    if (items.some((item) => item.dataset['key'] === refocus.key)) return;
    this.refocus = null;
    if (this.focusedItem() || !items.length) return;
    this.focusAt(Math.min(refocus.index, items.length - 1));
  }
}
