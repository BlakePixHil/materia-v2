import {
  afterNextRender,
  ApplicationRef,
  ChangeDetectionStrategy,
  Component,
  computed,
  createComponent,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  EnvironmentInjector,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';

import { MtButton, MtIconButton, MtKbd } from '@materia/ui';

import {
  dockFor,
  elementBox,
  findTarget,
  onScreen,
  PHONE_MAX,
  placeCard,
  spotFor,
  type Box,
  type Size,
} from './tour-geometry';
import type { Tour, TourResult, TourStep } from './tour-model';

export { TOURS, tourForPath } from './tours';

/** How long a step's feature may take to appear (a page still loading) before it's left out. */
export const TARGET_WAIT_MS = 1500;
/** How long the spotlight follows a scrolling page after a step changes (smooth scroll). */
const FOLLOW_MS = 600;
/** The leaving fade (`motion-base`). */
const LEAVE_MS = 150;

function reducedMotion(document: Document): boolean {
  return !document.defaultView?.matchMedia?.('(prefers-reduced-motion: no-preference)').matches;
}

/**
 * The steps that can show now: those without a feature, and those whose feature is on screen.
 * Waits up to `wait` ms for features still loading, and gives up early once all are there.
 */
export async function availableSteps(tour: Tour, document: Document, wait = TARGET_WAIT_MS): Promise<TourStep[]> {
  const started = Date.now();
  const missing = () => tour.steps.filter((step) => step.target && !findTarget(document, step.target));
  while (missing().length && Date.now() - started < wait) await new Promise((resolve) => setTimeout(resolve, 100));
  const gone = new Set(missing());
  const steps = tour.steps.filter((step) => !gone.has(step));
  // A page tour whose features are all missing (the page isn't what the tour expects) shows nothing.
  return steps.some((step) => step.target) || tour.intro ? steps : [];
}

/**
 * The theatre (CORE-24): the page dims, a spotlight sits on one feature, and a card beside it
 * explains it. The card is a modal dialog: focus stays in it (the rest of the page is inert),
 * Escape ends the tour, ← and → step, and each step is announced. Loaded only when a tour starts.
 */
@Component({
  selector: 'mt-tour-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: ['../../../../../../libs/ui/src/generated/components/tour.css'],
  imports: [MtButton, MtIconButton, MtKbd],
  host: { class: 'mt-tour', '[attr.data-leaving]': "leaving() ? '' : null" },
  template: `
    <div class="mt-tour-catch" aria-hidden="true" (click)="refocus()"></div>
    <div
      class="mt-tour-spot"
      aria-hidden="true"
      [attr.data-target]="spot() ? '' : null"
      [style.top.px]="spot()?.top"
      [style.left.px]="spot()?.left"
      [style.width.px]="spot()?.width"
      [style.height.px]="spot()?.height"
    ></div>
    <section
      #card
      class="mt-tour-card"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      aria-labelledby="mt-tour-title"
      aria-describedby="mt-tour-body"
      [attr.data-intro]="isIntro() ? '' : null"
      [attr.data-placed]="cardPos() ? '' : null"
      [attr.data-dock]="dock()"
      [style.top.px]="cardPos()?.top"
      [style.left.px]="cardPos()?.left"
      (keydown)="onKeydown($event)"
    >
      <button
        mtIconButton
        class="mt-tour-close"
        icon="x"
        size="sm"
        label="End tour"
        data-tour-close
        (click)="end(false)"
      ></button>
      @for (s of current(); track s.key) {
        <div class="mt-tour-step">
          <span class="eyebrow">{{ eyebrow() }}</span>
          <h2 id="mt-tour-title">{{ s.step.title }}</h2>
          <p id="mt-tour-body">
            {{ s.step.body }}
            @if (s.step.kbd; as keys) {
              <mt-kbd [keys]="keys" />
            }
          </p>
        </div>
      }
      <div class="mt-tour-foot">
        @if (steps().length > 1 && !isIntro()) {
          <span class="mt-tour-dots" aria-hidden="true">
            @for (dot of dots(); track $index) {
              <i [attr.data-on]="dot ? '' : null"></i>
            }
          </span>
        }
        @if (isIntro()) {
          <span class="mt-grow"></span>
          <button mtButton variant="ghost" size="sm" data-tour-skip (click)="end(false)">Skip</button>
          <button mtButton variant="primary" size="sm" data-tour-next (click)="next()">Show me around</button>
        } @else {
          @if (index() > 0) {
            <button mtButton variant="ghost" size="sm" data-tour-back (click)="back()">Back</button>
          }
          <button mtButton variant="primary" size="sm" data-tour-next (click)="next()">
            {{ last() ? 'Done' : 'Next' }}
          </button>
        }
      </div>
      <p class="mt-sr" aria-live="polite" data-tour-announce>{{ announcement() }}</p>
    </section>
  `,
})
export class TourOverlay {
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly cardRef = viewChild.required<ElementRef<HTMLElement>>('card');

  readonly tour = input.required<Tour>();
  /** The tour's steps that can show on this screen (see `availableSteps`). */
  readonly steps = input.required<readonly TourStep[]>();
  readonly closed = output<TourResult>();

  protected readonly index = signal(0);
  protected readonly leaving = signal(false);
  protected readonly spot = signal<Box | null>(null);
  protected readonly cardPos = signal<{ top: number; left: number } | null>(null);
  protected readonly dock = signal<'top' | 'bottom' | null>(null);

  protected readonly step = computed(() => this.steps()[this.index()]);
  /** The step as a one-item list keyed by its index, so its words re-render (and rise in) on each step. */
  protected readonly current = computed(() => {
    const step = this.step();
    return step ? [{ key: this.index(), step }] : [];
  });
  protected readonly last = computed(() => this.index() === this.steps().length - 1);
  protected readonly isIntro = computed(() => !!this.tour().intro && this.index() === 0);
  protected readonly eyebrow = computed(() => {
    const tour = this.tour();
    if (this.isIntro()) return 'Welcome to Materia';
    const total = this.steps().length - (tour.intro ? 1 : 0);
    const at = this.index() + (tour.intro ? 0 : 1);
    return total > 1 ? `${tour.title} · ${at} of ${total}` : tour.title;
  });
  /** One dot per step after the welcome card, the current one on. */
  protected readonly dots = computed(() => {
    const offset = this.tour().intro ? 1 : 0;
    return this.steps()
      .slice(offset)
      .map((_, i) => i + offset === this.index());
  });
  protected readonly announcement = computed(() => {
    const step = this.step();
    return step ? `${this.eyebrow()}. ${step.title}. ${step.body}` : '';
  });

  private target: Element | null = null;
  private followUntil = 0;
  private frame = 0;
  private done = false;
  private readonly opener: Element | null;
  private readonly inerted: Element[] = [];

  constructor() {
    this.opener = this.document.activeElement;
    const view = this.document.defaultView;
    const schedule = () => this.schedule();
    view?.addEventListener('resize', schedule);
    this.document.addEventListener('scroll', schedule, { capture: true, passive: true });
    inject(DestroyRef).onDestroy(() => {
      view?.removeEventListener('resize', schedule);
      this.document.removeEventListener('scroll', schedule, { capture: true });
      if (this.frame) view?.cancelAnimationFrame(this.frame);
      this.release();
    });
    afterNextRender(() => {
      this.makeRestInert();
      this.show(0);
    });
  }

  protected next(): void {
    if (this.last()) this.end(true);
    else this.show(this.index() + 1);
  }

  protected back(): void {
    if (this.index() > 0) this.show(this.index() - 1);
  }

  /** Ends the tour: fades out, then reports how it ended. */
  end(finished: boolean): void {
    if (this.done) return;
    this.done = true;
    this.leaving.set(true);
    const report = () => this.closed.emit({ tourId: this.tour().id, finished, step: this.index() });
    if (reducedMotion(this.document)) report();
    else setTimeout(report, LEAVE_MS);
  }

  protected refocus(): void {
    this.primaryButton()?.focus();
  }

  protected onKeydown(event: KeyboardEvent): void {
    // Keys stay with the tour: the page's own shortcuts (`t`, `g m`…) don't fire behind it.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.end(false);
    } else if (event.key === 'ArrowRight' && !this.isIntro()) {
      event.preventDefault();
      this.next();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.back();
    } else if (event.key === 'Tab') {
      this.trapTab(event);
    }
  }

  private show(index: number): void {
    this.index.set(index);
    const step = this.steps()[index];
    this.target = step ? findTarget(this.document, step.target) : null;
    const viewport = this.viewport();
    const box = this.target ? elementBox(this.target) : null;
    if (this.target && box && !onScreen(box, viewport)) {
      this.target.scrollIntoView?.({
        block: box.height > viewport.height * 0.6 ? 'start' : 'center',
        inline: 'nearest',
        behavior: reducedMotion(this.document) ? 'auto' : 'smooth',
      });
    }
    this.followUntil = Date.now() + FOLLOW_MS;
    this.schedule();
    // Focus the card's main button once the step has rendered (the intro's buttons are replaced).
    afterNextRender(() => this.refocus(), { injector: this.injector });
  }

  private schedule(): void {
    if (this.frame) return;
    const view = this.document.defaultView;
    if (!view) return this.measure();
    this.frame = view.requestAnimationFrame(() => {
      this.frame = 0;
      this.measure();
      if (Date.now() < this.followUntil) this.schedule();
    });
  }

  private measure(): void {
    const viewport = this.viewport();
    const box = this.target ? elementBox(this.target) : null;
    const spot = box ? spotFor(box, viewport) : null;
    this.spot.set(spot);
    if (viewport.width <= PHONE_MAX) {
      this.cardPos.set(null);
      this.dock.set(dockFor(spot, viewport));
      return;
    }
    this.dock.set(null);
    const card = this.cardRef().nativeElement;
    const size: Size = { width: card.offsetWidth, height: card.offsetHeight };
    if (!spot) return this.cardPos.set(null);
    const { top, left } = placeCard(spot, size, viewport);
    this.cardPos.set({ top: Math.round(top), left: Math.round(left) });
  }

  private viewport(): Size {
    const view = this.document.defaultView;
    return {
      width: view?.innerWidth ?? this.document.documentElement.clientWidth,
      height: view?.innerHeight ?? this.document.documentElement.clientHeight,
    };
  }

  private primaryButton(): HTMLElement | null {
    return this.cardRef().nativeElement.querySelector<HTMLElement>('[data-tour-next]');
  }

  private trapTab(event: KeyboardEvent): void {
    const focusable = [
      ...this.cardRef().nativeElement.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex="0"]'),
    ];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    const active = this.document.activeElement;
    if (event.shiftKey && (active === first || !focusable.includes(active as HTMLElement))) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && (active === last || !focusable.includes(active as HTMLElement))) {
      event.preventDefault();
      first?.focus();
    }
  }

  /** Makes everything but the tour inert: no clicks, focus or screen reader on the page behind it. */
  private makeRestInert(): void {
    const host = this.cardRef().nativeElement.closest('mt-tour-overlay');
    for (const element of this.document.body.children) {
      if (element === host || element.hasAttribute('inert') || element.tagName === 'SCRIPT') continue;
      element.setAttribute('inert', '');
      this.inerted.push(element);
    }
  }

  private release(): void {
    for (const element of this.inerted.splice(0)) element.removeAttribute('inert');
    if (this.opener instanceof HTMLElement && this.opener.isConnected) this.opener.focus();
  }
}

/** Shows a tour over the page; resolves when it ends, after the overlay has gone. */
export function openTour(tour: Tour, steps: readonly TourStep[], injector: EnvironmentInjector): Promise<TourResult> {
  const document = injector.get(DOCUMENT);
  const appRef = injector.get(ApplicationRef);
  const host = document.createElement('mt-tour-overlay');
  document.body.appendChild(host);
  const ref = createComponent(TourOverlay, { environmentInjector: injector, hostElement: host });
  ref.setInput('tour', tour);
  ref.setInput('steps', steps);
  appRef.attachView(ref.hostView);
  return new Promise((resolve) => {
    ref.instance.closed.subscribe((result) => {
      appRef.detachView(ref.hostView);
      ref.destroy();
      host.remove();
      resolve(result);
    });
  });
}
