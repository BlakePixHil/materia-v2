import { computed, DOCUMENT, effect, EnvironmentInjector, inject, Injectable, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';

import { markTourSeen, type TourPrefs } from '@materia/domain';
import { ToastService } from '@materia/ui';

import type { TourResult } from './tour-model';
import { CommandRegistry } from '../commands/command-registry';
import { FeatureFlagService } from '../flags/feature-flags';
import { UserPrefsService } from '../profile/user-prefs';
import { ShortcutService } from '../shortcuts/shortcut.service';

/** The hotkey for "Tour this page". */
export const TOUR_SHORTCUT = 'shift+h';
/** The first-sign-in tour. */
export const WELCOME_TOUR_ID = 'welcome';
/** How long after arriving on a page its tour waits to start (the page settles first). */
export const AUTO_START_DELAY_MS = 700;

type TourChunk = typeof import('./tour-overlay');

/**
 * Guided tours (CORE-24, behind `tours.enabled`). The welcome tour opens on first sign-in (anyone
 * who hasn't finished or skipped it); taking it turns page tours on, skipping leaves them off.
 * With page tours on, a page's tour plays the first time the page opens. ⌘K "Tour this page" and
 * ⇧H start the page's tour any time. Choices live on `users/{uid}.prefs.tours`, so they follow the
 * person to every device. The overlay and the tours' words are a lazy chunk, loaded on first use.
 */
@Injectable({ providedIn: 'root' })
export class TourService {
  private readonly flags = inject(FeatureFlagService);
  private readonly userPrefs = inject(UserPrefsService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly commands = inject(CommandRegistry);
  private readonly shortcuts = inject(ShortcutService);
  private readonly injector = inject(EnvironmentInjector);
  private readonly document = inject(DOCUMENT);

  readonly enabled = computed(() => this.flags.isOn('tours.enabled'));
  /** The person's tour choices. */
  readonly prefs = computed(() => this.userPrefs.prefs().tours);
  /** The id of the tour showing now. */
  readonly active = signal<string | null>(null);

  private chunk: Promise<TourChunk> | undefined;
  private welcomeOffered = false;
  /** Counts arrivals on pages, so a page tour waiting to start can tell the person has moved on. */
  private arrival = 0;
  /** A page whose tour shouldn't start by itself (Settings, just after turning page tours on there). */
  private quietOn: string | null = null;
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /**
   * Called by the app shell: offers the welcome tour, plays page tours on first visits, and adds
   * the command and the hotkey while tours are on. Returns the cleanup.
   */
  connect(): () => void {
    const cleanups = [
      this.commands.register({
        id: 'tours.page',
        title: 'Tour this page',
        group: 'Help',
        icon: 'help',
        keywords: ['tour', 'tutorial', 'guide', 'walkthrough', 'help', 'how', 'show me', 'theatre'],
        shortcut: TOUR_SHORTCUT,
        when: () => this.enabled(),
        run: () => void this.startForPage(),
      }),
      this.commands.register({
        id: 'tours.welcome',
        title: 'Take the welcome tour',
        group: 'Help',
        icon: 'help',
        keywords: ['tour', 'tutorial', 'guide', 'walkthrough', 'help', 'getting started', 'onboarding'],
        when: () => this.enabled(),
        run: () => void this.start(WELCOME_TOUR_ID),
      }),
    ];

    // The hotkey exists (and shows on the ? sheet) only while tours are on.
    let unregister: (() => void) | null = null;
    const hotkey = effect(() => {
      const on = this.enabled();
      untracked(() => {
        unregister?.();
        unregister = on
          ? this.shortcuts.register({
              combo: TOUR_SHORTCUT,
              description: 'Tour this page',
              group: 'General',
              when: () => !this.active(),
              handler: () => void this.startForPage(),
            })
          : null;
      });
    });

    // First sign-in: the welcome tour, once the profile has loaded and says it hasn't been answered.
    const welcome = effect(() => {
      if (!this.enabled() || !this.userPrefs.profile.value()) return;
      if (this.prefs().seen.includes(WELCOME_TOUR_ID)) return;
      untracked(() => {
        if (this.welcomeOffered || this.active()) return;
        this.welcomeOffered = true;
        void this.start(WELCOME_TOUR_ID, { auto: true });
      });
    });

    // Page tours: a page's tour the first time it opens (again after a tour ends or prefs change).
    const pages = effect(() => {
      const url = this.url();
      const prefs = this.prefs();
      if (!this.enabled() || !prefs.auto || this.active() || !prefs.seen.includes(WELCOME_TOUR_ID)) return;
      untracked(() => void this.autoStart(url));
    });

    return () => {
      cleanups.forEach((cleanup) => cleanup());
      unregister?.();
      hotkey.destroy();
      welcome.destroy();
      pages.destroy();
    };
  }

  /** Starts the current page's tour, or says the page has none. */
  async startForPage(): Promise<void> {
    if (!this.enabled() || this.active()) return;
    const { tourForPath } = await this.load();
    const tour = tourForPath(this.router.url);
    if (!tour) {
      this.toasts.show({
        title: 'This page doesn’t have a tour yet',
        description: 'Today, Matters, a matter, Time and billing and Settings do.',
      });
      return;
    }
    await this.start(tour.id);
  }

  /**
   * Starts a tour. `auto` starts (first sign-in, first visit) show nothing when the page has moved
   * on or the page's features aren't there; a tour someone asked for says so instead.
   */
  async start(id: string, options: { auto?: boolean } = {}): Promise<void> {
    if (!this.enabled() || this.active()) return;
    this.active.set(id);
    const page = this.path();
    let result: TourResult | null = null;
    try {
      const chunk = await this.load();
      const tour = chunk.TOURS.get(id);
      const steps = tour ? await chunk.availableSteps(tour, this.document) : [];
      // An automatic page tour stands down if the person has moved to another page meanwhile.
      const movedOn = options.auto && !tour?.intro && this.path() !== page;
      if (!tour || !steps.length || movedOn) {
        if (!options.auto && tour) {
          this.toasts.show({
            title: 'The tour couldn’t start',
            description: 'This page is still loading. Try again in a moment.',
          });
        }
        return;
      }
      result = await chunk.openTour(tour, steps, this.injector);
    } catch {
      if (!options.auto) this.toasts.show({ title: 'The tour didn’t load', description: 'Check your connection.' });
    } finally {
      // Record before clearing `active`, so the page-tour effect sees the tour as seen.
      if (result) this.record(result);
      this.active.set(null);
    }
  }

  /** Page tours on or off (Settings → Preferences). */
  setAuto(auto: boolean): Promise<void> {
    this.quietOn = this.path();
    return this.save({ ...this.prefs(), auto });
  }

  /**
   * Forgets which page tours were seen and turns page tours on, so each plays again as its page
   * next opens (the welcome tour's answer stays).
   */
  resetPageTours(): Promise<void> {
    this.quietOn = this.path();
    return this.save({ auto: true, seen: this.prefs().seen.filter((id) => id === WELCOME_TOUR_ID) });
  }

  private path(): string {
    return this.router.url.split(/[?#]/)[0] ?? '';
  }

  private async autoStart(url: string): Promise<void> {
    const arrival = ++this.arrival;
    if (this.path() === this.quietOn) return;
    this.quietOn = null;
    await new Promise((resolve) => setTimeout(resolve, AUTO_START_DELAY_MS));
    if (arrival !== this.arrival || this.active()) return;
    const { tourForPath } = await this.load();
    const tour = tourForPath(url);
    if (!tour || this.prefs().seen.includes(tour.id) || arrival !== this.arrival) return;
    await this.start(tour.id, { auto: true });
  }

  /** The welcome tour's answer sets page tours (on when taken, off when skipped); every tour is then seen. */
  private record(result: TourResult): void {
    let next = markTourSeen(this.prefs(), result.tourId);
    if (result.tourId === WELCOME_TOUR_ID) next = { ...next, auto: result.finished || result.step > 0 };
    void this.save(next);
  }

  private save(tours: TourPrefs): Promise<void> {
    return this.userPrefs.save({ tours }).catch(() => {
      this.toasts.show({ title: 'Your tour settings didn’t save', tone: 'danger' });
    });
  }

  private load(): Promise<TourChunk> {
    return (this.chunk ??= import('./tour-overlay').catch((error: unknown) => {
      this.chunk = undefined;
      throw error;
    }));
  }
}
