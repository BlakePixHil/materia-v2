import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  ViewEncapsulation,
} from '@angular/core';

import type { DateOnly } from '@materia/domain';

import type { MtIconName } from '../../generated/icons';
import { MtButton } from '../button/button';
import { type DeadlineVm, MtDeadlineChip } from '../deadline-chip/deadline-chip';
import { MtIcon } from '../icon/icon';
import { formatRelativeDate, MT_ORG_TIMEZONE, MT_TODAY, type MtDateInput, toDateOnly } from '../pipes/format';

export type TimelineKind = 'note' | 'activity' | 'document' | 'email' | 'clerk' | 'deadline';
export type TimelineState = 'done' | 'next' | 'overdue' | 'upcoming';

/** One entry on a matter's timeline. Items arrive sorted (newest or oldest first); groups keep that order. */
export interface TimelineItemVm {
  id: string;
  kind: TimelineKind;
  title: string;
  /** When it happened (an instant shows its time) or falls due (a date). */
  at: MtDateInput;
  /** Secondary line ("NSW Online Registry", "Jordan Price"). */
  detail?: string | undefined;
  /** A rule or citation, shown in mono ("UCPR r 78.3"). */
  code?: string | undefined;
  /** For deadlines and steps: done, next, overdue or upcoming. */
  state?: TimelineState | undefined;
  deadline?: DeadlineVm | undefined;
}

export interface TimelineDay {
  day: DateOnly | null;
  items: TimelineItemVm[];
}

/** Consecutive items grouped by their day in the org timezone (undated items group under `null`). */
export function groupByDay(items: readonly TimelineItemVm[], timeZone: string): TimelineDay[] {
  const groups: TimelineDay[] = [];
  for (const item of items) {
    const day = toDateOnly(item.at, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

/** `10:42 am` for an instant in the org timezone; empty for a date or nothing. */
export function timeOfDay(value: MtDateInput, timeZone: string): string {
  if (value === null || value === undefined || typeof value === 'string') return '';
  const instant = value instanceof Date ? value : value.toDate();
  if (Number.isNaN(instant.getTime())) return '';
  return new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', minute: '2-digit' }).format(instant);
}

let nextId = 0;

const KIND_ICONS: Record<TimelineKind, MtIconName> = {
  note: 'compose',
  activity: 'arrow-right',
  document: 'document',
  email: 'mail',
  clerk: 'sparkle',
  deadline: 'clock',
};

const STATE_ICONS: Record<TimelineState, MtIconName> = {
  done: 'check',
  next: 'arrow-right',
  overdue: 'alert',
  upcoming: 'clock',
};

const KIND_LABELS: Record<TimelineKind, string> = {
  note: 'Note',
  activity: 'Activity',
  document: 'Document',
  email: 'Email',
  clerk: 'Clerk',
  deadline: 'Deadline',
};

/**
 * Timeline (`mt-timeline`): a matter's history or deadlines, grouped by day in the org timezone. Each
 * item shows its kind as the node's icon (notes, activity, documents, email, Clerk, deadlines), a rule
 * or citation in mono, and an optional DeadlineChip. `hasMore` shows a "Load more" button that emits
 * `loadMore`; the feature fetches the next page.
 */
@Component({
  selector: 'mt-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/timeline.css', '../../generated/components/tl.css'],
  imports: [MtIcon, MtDeadlineChip, MtButton],
  host: { style: 'display: block' },
  template: `
    @for (group of groups(); track group.day ?? 'undated') {
      <section class="mt-timeline-day" [attr.aria-labelledby]="groupId(group.day)">
        @if (grouped()) {
          <h3 class="mt-timeline-date" [id]="groupId(group.day)">{{ dayLabel(group.day) }}</h3>
        }
        <ol class="mt-timeline">
          @for (item of group.items; track item.id) {
            <li class="mt-tl" [attr.data-state]="item.state ?? null" [attr.data-kind]="item.kind">
              <span class="node" aria-hidden="true"><mt-icon [name]="iconFor(item)" /></span>
              <div>
                <div class="tt">
                  <span class="mt-sr">{{ kindLabel(item) }}: </span>{{ item.title }}
                </div>
                @if (item.code || item.detail || timeOf(item)) {
                  <div class="rule">
                    @if (item.code; as code) {
                      <code>{{ code }}</code>
                    }
                    @if (item.code && (item.detail || timeOf(item))) {
                      ·
                    }
                    {{ secondary(item) }}
                  </div>
                }
              </div>
              <div>
                @if (item.deadline; as deadline) {
                  <mt-deadline-chip
                    [due]="deadline.due"
                    [completed]="!!deadline.completed"
                    [critical]="!!deadline.critical"
                    [trace]="deadline.trace"
                  />
                }
              </div>
            </li>
          }
        </ol>
      </section>
    } @empty {
      <ng-content select="[mtTimelineEmpty]" />
    }
    @if (hasMore()) {
      <div class="mt-timeline-more">
        <button mtButton variant="ghost" size="sm" [loading]="loading()" (click)="loadMore.emit()">Load more</button>
      </div>
    }
  `,
})
export class MtTimeline {
  readonly items = input.required<readonly TimelineItemVm[]>();
  /** Show day headings (default). Turn off for a short list of deadlines. */
  readonly grouped = input(true, { transform: booleanAttribute });
  readonly hasMore = input(false, { transform: booleanAttribute });
  readonly loading = input(false, { transform: booleanAttribute });
  readonly loadMore = output();

  private readonly timeZone = inject(MT_ORG_TIMEZONE);
  private readonly today = inject(MT_TODAY);
  private readonly idPrefix = `mt-timeline-${nextId++}`;

  protected readonly groups = computed(() =>
    this.grouped() ? groupByDay(this.items(), this.timeZone) : [{ day: null, items: [...this.items()] }],
  );

  protected groupId(day: DateOnly | null): string | null {
    return this.grouped() ? `${this.idPrefix}-${day ?? 'undated'}` : null;
  }

  protected dayLabel(day: DateOnly | null): string {
    return day ? formatRelativeDate(day, this.today(), this.timeZone) : 'Undated';
  }

  protected iconFor(item: TimelineItemVm): MtIconName {
    return item.kind === 'deadline' && item.state ? STATE_ICONS[item.state] : KIND_ICONS[item.kind];
  }

  protected kindLabel(item: TimelineItemVm): string {
    return KIND_LABELS[item.kind];
  }

  protected timeOf(item: TimelineItemVm): string {
    return timeOfDay(item.at, this.timeZone);
  }

  protected secondary(item: TimelineItemVm): string {
    return [item.detail, this.timeOf(item)].filter(Boolean).join(' · ');
  }
}
