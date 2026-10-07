import {
  ApplicationRef,
  ChangeDetectionStrategy,
  Component,
  computed,
  createComponent,
  DestroyRef,
  DOCUMENT,
  EnvironmentInjector,
  inject,
  Injectable,
  signal,
  ViewEncapsulation,
} from '@angular/core';

import type { MtIconName } from '../../generated/icons';
import { MtButton } from '../button/button';
import { MtIcon } from '../icon/icon';
import { MtIconButton } from '../icon-button/icon-button';

export type MtToastTone = 'neutral' | 'success' | 'danger' | 'ai';

export interface MtToastOptions {
  /** Past tense: "Notice published". */
  title: string;
  description?: string;
  tone?: MtToastTone;
  /** One action, such as Undo or Review. Running it dismisses the toast. */
  action?: { label: string; run: () => void };
  /** Milliseconds before it hides; default 5000. 0 keeps it until dismissed. */
  duration?: number;
}

export interface MtToastRef {
  dismiss(): void;
}

interface ToastRecord extends Required<Pick<MtToastOptions, 'title' | 'tone' | 'duration'>> {
  id: number;
  description?: string | undefined;
  action?: MtToastOptions['action'] | undefined;
  /** Time left on its timer, so hovering pauses it. */
  remaining: number;
  startedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Dismissed and fading out. */
  leaving?: boolean;
}

/** At most this many toasts are on screen; the rest wait their turn. */
export const MT_TOAST_MAX_VISIBLE = 3;
export const MT_TOAST_DEFAULT_DURATION = 5000;
/** How long a dismissed toast takes to fade out (`--motion-base`). */
const LEAVE_MS = 150;

const TONE_ICON: Record<MtToastTone, MtIconName | null> = {
  neutral: null,
  success: 'check',
  danger: 'alert',
  ai: 'sparkle',
};

/**
 * Toasts confirm something that just happened (bottom right, 5 seconds), optionally with one action.
 * On a phone they run along the top, clear of the TabBar and a dialog's buttons.
 *
 * ```ts
 * inject(ToastService).show({ tone: 'success', title: 'Notice published', action: { label: 'Undo', run: undo } });
 * ```
 *
 * - At most three show at once; later ones queue. Hovering or focusing the stack pauses the timers.
 * - Screen readers hear each toast through a polite live region; `danger` toasts use an assertive one.
 * - Toasts never take focus. Press F6 to move focus to the newest toast's action (F6 or Escape again
 *   returns to where you were).
 * - They rise in and fade out (`mt-leave`); instantly with reduced motion.
 *
 * Built on Angular rather than ng-primitives' toast, which has no queue limit, assertive tone or F6.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly appRef = inject(ApplicationRef);
  private readonly injector = inject(EnvironmentInjector);
  private readonly document = inject(DOCUMENT);
  private readonly all = signal<ToastRecord[]>([]);
  /** Dismissed toasts still fading out. CSS rather than `animate.leave`, which adds about 2.4 kB to the first load. */
  private readonly leaving = signal<ToastRecord[]>([]);
  private nextId = 0;
  private paused = false;
  private outletAttached = false;

  /** The toasts on screen, oldest first. */
  readonly visible = computed(() => this.all().slice(0, MT_TOAST_MAX_VISIBLE));
  /** @internal What the outlet draws: the visible toasts and those fading out, oldest first. */
  readonly rendered = computed(() => [...this.visible(), ...this.leaving()].sort((a, b) => a.id - b.id));
  /** The latest announcement, per politeness level. */
  readonly politeMessage = signal('');
  readonly assertiveMessage = signal('');

  show(options: MtToastOptions): MtToastRef {
    this.attachOutlet();
    const duration = options.duration ?? MT_TOAST_DEFAULT_DURATION;
    const record: ToastRecord = {
      id: ++this.nextId,
      title: options.title,
      description: options.description,
      tone: options.tone ?? 'neutral',
      action: options.action,
      duration,
      remaining: duration,
      startedAt: null,
      timer: null,
    };
    this.all.update((list) => [...list, record]);
    this.sync();
    return { dismiss: () => this.dismiss(record.id) };
  }

  dismiss(id: number): void {
    const record = this.all().find((t) => t.id === id);
    if (!record) return;
    if (record.timer) clearTimeout(record.timer);
    const shown = this.visible().includes(record);
    this.all.update((list) => list.filter((t) => t !== record));
    if (shown && this.animates()) {
      record.leaving = true;
      this.leaving.update((list) => [...list, record]);
      setTimeout(() => this.leaving.update((list) => list.filter((t) => t !== record)), LEAVE_MS);
    }
    this.sync();
  }

  /** Pauses every timer (pointer or focus is on the stack). */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    const now = Date.now();
    for (const t of this.visible()) {
      if (t.timer) {
        clearTimeout(t.timer);
        t.timer = null;
        t.remaining -= now - (t.startedAt ?? now);
      }
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.sync();
  }

  /** @internal Runs the action, then dismisses the toast. */
  runAction(id: number): void {
    this.all()
      .find((t) => t.id === id)
      ?.action?.run();
    this.dismiss(id);
  }

  /** Starts timers for newly visible toasts and announces them. */
  private sync(): void {
    for (const t of this.visible()) {
      if (t.startedAt === null) {
        const text = t.description ? `${t.title}. ${t.description}` : t.title;
        (t.tone === 'danger' ? this.assertiveMessage : this.politeMessage).set(text);
      }
      if (!this.paused && !t.timer && t.duration > 0) {
        t.startedAt = Date.now();
        t.timer = setTimeout(() => this.dismiss(t.id), Math.max(t.remaining, 0));
      } else if (t.startedAt === null) {
        t.startedAt = Date.now();
      }
    }
  }

  /** Fade out only when the browser reports no reduced-motion preference. */
  private animates(): boolean {
    return this.document.defaultView?.matchMedia?.('(prefers-reduced-motion: no-preference)').matches ?? false;
  }

  /** @internal An outlet placed in a template registers itself, so the service doesn't add a second. */
  registerOutlet(): void {
    this.outletAttached = true;
  }

  private attachOutlet(): void {
    if (this.outletAttached || !this.document.body) return;
    this.outletAttached = true;
    const ref = createComponent(MtToastOutlet, { environmentInjector: this.injector });
    this.appRef.attachView(ref.hostView);
    this.document.body.appendChild(ref.location.nativeElement);
  }
}

/** The toast stack and its live regions; attached to `<body>` by ToastService on first use. */
@Component({
  selector: 'mt-toast-outlet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../generated/components/toast.css', '../../generated/components/toaster.css'],
  imports: [MtIcon, MtButton, MtIconButton],
  host: { style: 'display: contents' },
  template: `
    <div class="mt-sr" aria-live="polite" aria-atomic="true">{{ toasts.politeMessage() }}</div>
    <div class="mt-sr" aria-live="assertive" aria-atomic="true">{{ toasts.assertiveMessage() }}</div>
    <section
      class="mt-toaster"
      aria-label="Notifications (F6)"
      tabindex="-1"
      (mouseenter)="toasts.pause()"
      (mouseleave)="toasts.resume()"
      (focusin)="toasts.pause()"
      (focusout)="onFocusOut($event)"
      (keydown.escape)="returnFocus()"
    >
      @for (toast of toasts.rendered(); track toast.id) {
        <div
          class="mt-toast"
          [class.mt-leave]="toast.leaving"
          [attr.inert]="toast.leaving ? '' : null"
          [attr.data-tone]="toast.tone === 'neutral' ? null : toast.tone"
        >
          @if (icon(toast.tone); as name) {
            <span class="ic"><mt-icon [name]="name" /></span>
          }
          <div class="mt-grow">
            <div class="tt">{{ toast.title }}</div>
            @if (toast.description; as text) {
              <div class="ts">{{ text }}</div>
            }
          </div>
          @if (toast.action; as action) {
            <button
              mtButton
              size="sm"
              [variant]="toast.tone === 'ai' ? 'clerk' : 'ghost'"
              data-toast-action
              (click)="toasts.runAction(toast.id)"
            >
              {{ action.label }}
            </button>
          }
          <button
            mtIconButton
            icon="x"
            size="sm"
            label="Dismiss"
            [tooltip]="false"
            (click)="toasts.dismiss(toast.id)"
          ></button>
        </div>
      }
    </section>
  `,
})
export class MtToastOutlet {
  protected readonly toasts = inject(ToastService);
  private readonly document = inject(DOCUMENT);
  private returnTo: HTMLElement | null = null;

  constructor() {
    this.toasts.registerOutlet();
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== 'F6' || this.toasts.visible().length === 0) return;
      const section = this.document.querySelector<HTMLElement>('.mt-toaster');
      if (!section) return;
      event.preventDefault();
      if (section.contains(this.document.activeElement)) {
        this.returnFocus();
        return;
      }
      this.returnTo = this.document.activeElement instanceof HTMLElement ? this.document.activeElement : null;
      const actions = section.querySelectorAll<HTMLElement>(
        '.mt-toast:not(.mt-leave) [data-toast-action], .mt-toast:not(.mt-leave) button',
      );
      (actions[0] ?? section).focus();
    };
    this.document.addEventListener('keydown', onKeydown);
    inject(DestroyRef).onDestroy(() => this.document.removeEventListener('keydown', onKeydown));
  }

  protected icon(tone: MtToastTone): MtIconName | null {
    return TONE_ICON[tone];
  }

  protected onFocusOut(event: FocusEvent): void {
    const section = event.currentTarget as HTMLElement;
    if (!section.contains(event.relatedTarget as Node | null)) this.toasts.resume();
  }

  protected returnFocus(): void {
    const target = this.returnTo;
    this.returnTo = null;
    if (target?.isConnected) target.focus();
    else (this.document.activeElement as HTMLElement | null)?.blur();
  }
}
