import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  ViewEncapsulation,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { ArrowLeftRight, Pause, Play, Square, Volume2 } from 'lucide';

import { describeTimerElapsed, formatTimerElapsed } from '@materia/domain';
import { MtIconButton } from '@materia/ui';

import { TimerStore } from './timer-store';

/** Spoken updates, when the person asks for them, come this often. */
export const TIMER_ANNOUNCE_EVERY_MS = 15 * 60_000;

/**
 * The shell's timer (BILL-02), in the top bar on every page: the elapsed time (mm:ss, then h:mm),
 * the matter number (a link to its Time tab) and pause or resume, stop and switch. The ticking text
 * is `aria-live="off"`; "Announce the time" reads it out once and then every 15 minutes until it's
 * pressed again. With no timer it is a single "Start timer" button (the open matter, else a picker).
 */
@Component({
  selector: 'mt-timer-widget',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Unencapsulated: the rules hang off the host's own `mt-timer` class, which emulated encapsulation
  // never matched (the readout ran into the matter number and the buttons wrapped below it).
  encapsulation: ViewEncapsulation.None,
  imports: [MtIconButton, RouterLink],
  host: { class: 'mt-timer', '[attr.data-running]': 'store.running() ? "" : null' },
  styles: `
    .mt-timer {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      flex-wrap: nowrap;
      white-space: nowrap;
    }
    .mt-timer .readout {
      display: inline-flex;
      align-items: baseline;
      gap: 8px;
      padding: 0 10px;
      margin-right: 2px;
      border-radius: var(--radius-md);
      background: var(--bg-subtle);
      height: 28px;
      line-height: 28px;
    }
    .mt-timer .elapsed {
      font-variant-numeric: tabular-nums;
      font-weight: 600;
      min-width: 5ch;
      text-align: right;
    }
    .mt-timer .matter {
      color: var(--text-secondary);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      text-decoration: none;
      white-space: nowrap;
    }
    .mt-timer .matter:hover {
      text-decoration: underline;
    }
    .mt-timer .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--icon-default);
      align-self: center;
    }
    .mt-timer[data-running] .dot {
      background: var(--text-success, #2f9e5b);
    }
  `,
  template: `
    @if (store.timer(); as timer) {
      <div class="readout" role="group" [attr.aria-label]="groupLabel()">
        <span class="dot" aria-hidden="true"></span>
        <span class="elapsed" aria-live="off" data-testid="timer-elapsed">{{ elapsed() }}</span>
        <a class="matter" [routerLink]="['/matters', timer.matterId, 'time']" data-testid="timer-matter">{{
          timer.matterNumber
        }}</a>
      </div>
      @if (timer.running) {
        <button
          mtIconButton
          size="sm"
          [icon]="icons.pause"
          label="Pause timer"
          tooltipKbd="shift+t"
          (click)="store.pause()"
        ></button>
      } @else {
        <button
          mtIconButton
          size="sm"
          [icon]="icons.play"
          label="Resume timer"
          tooltipKbd="shift+t"
          (click)="store.resume()"
        ></button>
      }
      <button mtIconButton size="sm" [icon]="icons.stop" label="Stop timer" (click)="store.stop()"></button>
      @if (!compact()) {
        <button
          mtIconButton
          size="sm"
          [icon]="icons.switch"
          label="Switch matter"
          (click)="store.switchMatter()"
        ></button>
        <button
          mtIconButton
          size="sm"
          [icon]="icons.announce"
          [label]="announcing() ? 'Stop announcing the time' : 'Announce the time'"
          [attr.aria-pressed]="announcing()"
          (click)="toggleAnnounce()"
        ></button>
      }
      <span class="mt-sr" aria-live="polite" data-testid="timer-announcement">{{ announcement() }}</span>
    } @else if (store.canRecord()) {
      <button mtIconButton size="sm" icon="timer" label="Start timer" tooltipKbd="shift+t" (click)="start()"></button>
    }
  `,
})
export class MtTimerWidget {
  protected readonly store = inject(TimerStore);
  /** Phones: pause and stop only. */
  readonly compact = input(false);
  /** The matter open behind the shell, for "Start timer". */
  readonly currentMatter = input<{ matterId: string; matterNumber: string } | null>(null);

  protected readonly icons = { pause: Pause, play: Play, stop: Square, switch: ArrowLeftRight, announce: Volume2 };
  protected readonly elapsed = computed(() => formatTimerElapsed(this.store.elapsedMs()));
  protected readonly groupLabel = computed(() => {
    const timer = this.store.timer();
    return timer ? `Timer on ${timer.matterNumber}, ${timer.running ? 'running' : 'paused'}` : 'Timer';
  });
  protected readonly announcing = signal(false);
  protected readonly announcement = signal('');

  constructor() {
    effect((onCleanup) => {
      if (!this.announcing()) return;
      const every = setInterval(() => this.announce(), TIMER_ANNOUNCE_EVERY_MS);
      onCleanup(() => clearInterval(every));
    });
    // A stopped timer stops the announcements.
    effect(() => {
      if (!this.store.timer()) this.announcing.set(false);
    });
    inject(DestroyRef).onDestroy(() => this.announcing.set(false));
  }

  protected toggleAnnounce(): void {
    const next = !this.announcing();
    this.announcing.set(next);
    if (next) this.announce();
    else this.announcement.set('');
  }

  protected start(): void {
    const matter = this.currentMatter();
    if (matter) void this.store.start(matter);
    else void this.store.switchMatter('Start timer');
  }

  private announce(): void {
    const timer = this.store.timer();
    if (!timer) return;
    this.announcement.set(
      `Timer on ${timer.matterNumber}: ${describeTimerElapsed(this.store.elapsedMs())}${timer.running ? '' : ', paused'}.`,
    );
  }
}
