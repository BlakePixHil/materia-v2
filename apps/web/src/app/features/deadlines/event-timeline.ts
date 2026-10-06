import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, ViewEncapsulation } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { DeadlineItem, MatterEventItem, WithId } from '@materia/data-access/repository';
import { formatDateOnly, MT_TODAY, MtDeadlineChip, MtIconButton } from '@materia/ui';

import { DEADLINE_STATUS_LABELS, deadlineKindLabel } from './deadline-view';
import { dayMonth, eventAxis, linkedTimeline, type EventsView } from './event-timeline-view';
import { eventKindLabel } from '../matter-detail/matter-view';

type Event = WithId<MatterEventItem>;
type Deadline = WithId<DeadlineItem>;

/**
 * A matter's events as a timeline (Deadlines tab). `linked`: one line through the events (each with
 * the deadlines computed from it), today and the upcoming deadlines. `scale`: the events on an axis
 * drawn to scale, above the plain list. Either way each event row has `data-event`, its time and a
 * link to its source document when it has them (the document named in `sources`, which holds only
 * those the reader may open), and its Edit and Delete buttons.
 */
@Component({
  selector: 'mt-event-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [MtDeadlineChip, MtIconButton, NgTemplateOutlet, RouterLink],
  host: { class: 'mt-event-timeline' },
  template: `
    <ng-template #eventActions let-event>
      @if (canEdit()) {
        <span class="acts">
          <button
            mtIconButton
            icon="compose"
            size="sm"
            [label]="'Edit ' + eventLabel(event.kind)"
            [disabled]="isBusy()(event.id)"
            (click)="edit.emit(event)"
          ></button>
          <button
            mtIconButton
            icon="trash"
            size="sm"
            [label]="'Delete ' + eventLabel(event.kind)"
            [disabled]="isBusy()(event.id)"
            (click)="remove.emit(event)"
          ></button>
        </span>
      }
    </ng-template>

    <ng-template #eventDetails let-event>
      @if (event.time || sourceName(event)) {
        <span class="details caption t-2" data-event-details>
          @if (event.time) {
            <span>At {{ event.time }}</span>
          }
          @if (sourceName(event); as name) {
            <span>
              Source:
              <a
                class="source"
                data-source-document
                [routerLink]="['/matters', matterId(), 'documents', event.sourceDocumentId]"
              >
                {{ name }}
              </a>
            </span>
          }
        </span>
      }
    </ng-template>

    @if (view() === 'scale') {
      @if (axis(); as axis) {
        <div class="axis-wrap">
          <div class="axis" role="img" [attr.aria-label]="axisLabel()">
            <span class="line"></span>
            @for (tick of axis.ticks; track tick.at) {
              <span class="tick" [style.left.%]="tick.at"
                ><span>{{ tick.label }}</span></span
              >
            }
            <span class="now" [style.left.%]="axis.today"><span>Today</span></span>
            @for (pin of axis.pins; track pin.event.id) {
              <span class="pin" [attr.data-side]="pin.side" [attr.data-align]="pin.align" [style.left.%]="pin.at">
                <span class="dot"></span>
                <span class="stem"></span>
                <span class="lab">
                  <span class="t">{{ eventLabel(pin.event.kind) }}</span>
                  <span class="d">{{ date(pin.event.date) }}</span>
                </span>
              </span>
            }
          </div>
        </div>
      }
      <ol class="flat">
        @for (event of sorted(); track event.id) {
          <li [attr.data-event]="event.kind">
            <span class="sw"></span>
            <span class="date caption t-2">{{ date(event.date) }}</span>
            <span class="mt-grow">
              {{ eventLabel(event.kind) }}
              @if (event.label && event.label !== eventLabel(event.kind)) {
                <span class="caption t-3">· {{ event.label }}</span>
              }
              <ng-container *ngTemplateOutlet="eventDetails; context: { $implicit: event }" />
            </span>
            <ng-container *ngTemplateOutlet="eventActions; context: { $implicit: event }" />
          </li>
        }
      </ol>
    } @else {
      <ol class="rail">
        @for (entry of entries(); track entry.key) {
          @if (entry.type === 'event') {
            <li class="ev" [attr.data-event]="entry.event.kind" [attr.data-future]="entry.future ? '' : null">
              <span class="when"
                >{{ dayMonth(entry.date) }}<span class="year">{{ entry.date.slice(0, 4) }}</span></span
              >
              <span class="node"><span class="dot"></span></span>
              <div class="body">
                <span class="title">{{ eventLabel(entry.event.kind) }}</span>
                @if (entry.event.label && entry.event.label !== eventLabel(entry.event.kind)) {
                  <span class="caption t-2">{{ entry.event.label }}</span>
                }
                <ng-container *ngTemplateOutlet="eventDetails; context: { $implicit: entry.event }" />
                @if (entry.linked.length) {
                  <ul class="kids" [attr.aria-label]="'Deadlines from ' + eventLabel(entry.event.kind)">
                    @for (deadline of entry.linked; track deadline.id) {
                      <li [attr.data-linked]="deadline.id">
                        <span class="mt-grow">{{ deadline.title }}</span>
                        @if (deadline.status === 'upcoming' || deadline.status === 'blocked') {
                          <mt-deadline-chip [due]="deadline.dueDate ?? ''" [critical]="deadline.critical" />
                        } @else {
                          <span class="caption t-3">{{ date(deadline.dueDate ?? '') }}</span>
                          <span class="state" [attr.data-status]="deadline.status">{{
                            statusLabel(deadline.status)
                          }}</span>
                        }
                      </li>
                    }
                  </ul>
                }
              </div>
              <ng-container *ngTemplateOutlet="eventActions; context: { $implicit: entry.event }" />
            </li>
          } @else if (entry.type === 'today') {
            <li class="today" aria-current="date">
              <span class="when"
                >{{ dayMonth(entry.date) }}<span class="year">{{ entry.date.slice(0, 4) }}</span></span
              >
              <span class="node"><span class="dot"></span></span>
              <div class="body"><span class="title">Today</span></div>
            </li>
          } @else {
            <li
              class="dl"
              [attr.data-upcoming]="entry.deadline.id"
              [attr.data-critical]="entry.deadline.critical ? '' : null"
            >
              <span class="when"
                >{{ dayMonth(entry.date) }}<span class="year">{{ entry.date.slice(0, 4) }}</span></span
              >
              <span class="node"><span class="dot"></span></span>
              <div class="body">
                <span class="title">{{ entry.deadline.title }}</span>
                <span class="caption t-2">{{
                  entry.anchor ? 'From ' + eventLabel(entry.anchor.kind) : kindLabel(entry.deadline.kind)
                }}</span>
              </div>
              <mt-deadline-chip [due]="entry.date" [critical]="entry.deadline.critical" />
            </li>
          }
        }
      </ol>
    }
  `,
  styles: `
    .mt-event-timeline {
      display: block;
      min-width: 0;
    }
    /* linked: one line */
    .mt-event-timeline .rail {
      list-style: none;
      margin: 0;
      padding: var(--space-12) var(--space-12) var(--space-4);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
    .mt-event-timeline .rail > li {
      display: grid;
      grid-template-columns: 4.5em 20px minmax(0, 1fr) auto;
      column-gap: var(--space-12);
      align-items: start;
      font: 400 13px/18px var(--font-sans);
    }
    .mt-event-timeline .when {
      padding-top: 2px;
      text-align: right;
      color: var(--text-secondary);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .mt-event-timeline .when .year {
      display: block;
      font-size: 11px;
      line-height: 14px;
      color: var(--text-tertiary);
    }
    .mt-event-timeline .node {
      position: relative;
      align-self: stretch;
      display: flex;
      justify-content: center;
    }
    .mt-event-timeline .node::before {
      content: '';
      position: absolute;
      inset: 0 auto 0 50%;
      width: 2px;
      margin-left: -1px;
      background: var(--border-strong);
    }
    .mt-event-timeline .rail > li:first-child .node::before {
      top: 10px;
    }
    .mt-event-timeline .rail > li:last-child .node::before {
      bottom: auto;
      height: 10px;
    }
    .mt-event-timeline .rail > li.today ~ li .node::before {
      background: repeating-linear-gradient(to bottom, var(--border-strong) 0 4px, transparent 4px 8px);
    }
    .mt-event-timeline .dot {
      position: relative;
      margin-top: 4px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 2px solid var(--bg-brand);
      background: var(--bg-brand);
    }
    .mt-event-timeline li[data-future] .dot {
      background: var(--bg-surface);
    }
    .mt-event-timeline .today .dot {
      margin-top: 5px;
      width: 10px;
      height: 10px;
      border: 0;
      background: var(--text-warning);
      box-shadow: 0 0 0 4px var(--bg-warning-subtle);
    }
    .mt-event-timeline .dl .dot {
      margin-top: 5px;
      width: 10px;
      height: 10px;
      border-radius: 2px;
      transform: rotate(45deg);
      border-color: var(--border-control);
      background: var(--bg-surface);
    }
    .mt-event-timeline .dl[data-critical] .dot {
      border-color: var(--border-danger);
    }
    .mt-event-timeline .rail .body {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      padding-bottom: var(--space-16);
    }
    .mt-event-timeline .rail .title {
      font-weight: 500;
      color: var(--text-primary);
    }
    .mt-event-timeline .rail .today .title {
      color: var(--text-warning);
    }
    .mt-event-timeline .acts {
      display: inline-flex;
      gap: 2px;
      margin-top: -4px;
    }
    .mt-event-timeline .dl mt-deadline-chip {
      margin-top: -1px;
    }
    .mt-event-timeline .kids {
      list-style: none;
      margin: var(--space-4) 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .mt-event-timeline .kids > li {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-8);
      padding: 2px var(--space-8);
      font-size: 12px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      background: var(--bg-canvas);
    }
    .mt-event-timeline .details {
      display: inline-flex;
      flex-wrap: wrap;
      column-gap: var(--space-8);
    }
    .mt-event-timeline .flat .details {
      margin-left: var(--space-8);
    }
    .mt-event-timeline .details .source {
      color: var(--text-brand);
    }
    .mt-event-timeline .state {
      font-size: 12px;
      color: var(--text-secondary);
    }
    .mt-event-timeline .state[data-status='done'] {
      color: var(--text-success);
    }
    .mt-event-timeline .state[data-status='missed'] {
      color: var(--text-danger);
    }
    /* scale: an axis above the plain list */
    .mt-event-timeline .axis-wrap {
      overflow-x: auto;
      overflow-y: hidden;
      border: 1px solid var(--border-default);
      border-bottom: 0;
      border-radius: var(--radius-md) var(--radius-md) 0 0;
      background: var(--bg-surface);
    }
    .mt-event-timeline .axis {
      position: relative;
      height: 176px;
      min-width: 520px;
      margin: 0 var(--space-24);
    }
    .mt-event-timeline .axis .line {
      position: absolute;
      inset: 91px 0 auto;
      height: 2px;
      background: var(--border-strong);
    }
    .mt-event-timeline .axis .tick {
      position: absolute;
      top: 86px;
      width: 1px;
      height: 12px;
      background: var(--border-strong);
    }
    .mt-event-timeline .axis .tick span,
    .mt-event-timeline .axis .now span {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      white-space: nowrap;
      font: 400 11px/14px var(--font-sans);
      font-variant-numeric: tabular-nums;
      color: var(--text-tertiary);
    }
    .mt-event-timeline .axis .tick span {
      top: 15px;
    }
    .mt-event-timeline .axis .now {
      position: absolute;
      top: 72px;
      width: 2px;
      height: 40px;
      margin-left: -1px;
      border-radius: 2px;
      background: var(--text-warning);
    }
    .mt-event-timeline .axis .now span {
      top: -14px;
      font-weight: 500;
      color: var(--text-warning);
    }
    .mt-event-timeline .pin {
      position: absolute;
      top: 85px;
      width: 0;
    }
    .mt-event-timeline .pin .dot {
      position: absolute;
      left: -7px;
      margin: 0;
      width: 14px;
      height: 14px;
      border: 3px solid var(--bg-surface);
      box-shadow: 0 0 0 1px var(--bg-brand);
    }
    .mt-event-timeline .pin .stem {
      position: absolute;
      left: 0;
      width: 1px;
      background: var(--border-strong);
    }
    .mt-event-timeline .pin[data-side='above'] .stem {
      bottom: 0;
      height: 28px;
    }
    .mt-event-timeline .pin[data-side='below'] .stem {
      top: 14px;
      height: 26px;
    }
    .mt-event-timeline .pin .lab {
      position: absolute;
      display: flex;
      flex-direction: column;
      align-items: center;
      white-space: nowrap;
      transform: translateX(-50%);
    }
    .mt-event-timeline .pin[data-side='above'] .lab {
      bottom: 30px;
    }
    .mt-event-timeline .pin[data-side='below'] .lab {
      top: 42px;
    }
    .mt-event-timeline .pin[data-align='start'] .lab {
      left: -8px;
      align-items: flex-start;
      transform: none;
    }
    .mt-event-timeline .pin[data-align='end'] .lab {
      right: -8px;
      align-items: flex-end;
      transform: none;
    }
    .mt-event-timeline .pin .t {
      font: 500 13px/17px var(--font-sans);
      color: var(--text-primary);
    }
    .mt-event-timeline .pin .d {
      font: 400 12px/16px var(--font-sans);
      font-variant-numeric: tabular-nums;
      color: var(--text-tertiary);
    }
    .mt-event-timeline .flat {
      list-style: none;
      margin: 0;
      padding: 0;
      border: 1px solid var(--border-default);
      border-radius: 0 0 var(--radius-md) var(--radius-md);
      background: var(--bg-surface);
    }
    .mt-event-timeline .flat:first-child {
      border-radius: var(--radius-md);
    }
    .mt-event-timeline .flat > li {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      padding: var(--space-8) var(--space-12);
      font: 400 13px/18px var(--font-sans);
    }
    .mt-event-timeline .flat > li + li {
      border-top: 1px solid var(--border-subtle);
    }
    .mt-event-timeline .flat .sw {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--bg-brand);
    }
    .mt-event-timeline .flat .date {
      flex: none;
      min-width: 7.5em;
    }
    @media (max-width: 560px) {
      .mt-event-timeline .rail > li {
        grid-template-columns: 4em 16px minmax(0, 1fr) auto;
        column-gap: var(--space-8);
      }
    }
  `,
})
export class EventTimeline {
  readonly events = input.required<readonly Event[]>();
  readonly deadlines = input.required<readonly Deadline[]>();
  readonly view = input.required<EventsView>();
  readonly canEdit = input(false);
  readonly isBusy = input<(id: string) => boolean>(() => false);
  /** The matter, for links to source documents. */
  readonly matterId = input('');
  /** Source documents' names by id: those the reader may open (live, and privileged ones only for privileged.view). */
  readonly sources = input<ReadonlyMap<string, string>>(new Map());
  readonly edit = output<Event>();
  readonly remove = output<Event>();

  private readonly today = inject(MT_TODAY);

  protected readonly sorted = computed(() => [...this.events()].sort((a, b) => a.date.localeCompare(b.date)));
  protected readonly entries = computed(() => linkedTimeline(this.sorted(), this.deadlines(), this.today()));
  protected readonly axis = computed(() => eventAxis(this.events(), this.today()));
  protected readonly axisLabel = computed(() => {
    const first = this.sorted()[0];
    return first
      ? `The events on a line drawn to scale, from ${formatDateOnly(first.date)} to today. Each event is listed below.`
      : '';
  });

  protected readonly eventLabel = eventKindLabel;
  protected readonly kindLabel = deadlineKindLabel;
  protected readonly dayMonth = dayMonth;

  protected date(value: string): string {
    return formatDateOnly(value);
  }

  protected sourceName(event: Event): string | undefined {
    return event.sourceDocumentId && this.matterId() ? this.sources().get(event.sourceDocumentId) : undefined;
  }

  protected statusLabel(status: Deadline['status']): string {
    return DEADLINE_STATUS_LABELS[status];
  }
}
